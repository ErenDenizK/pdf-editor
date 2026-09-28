/**
 * Raw PDFium (EmbedPDF's 2.15.1 build) probe: opens bytes, reports whether PDFium had to
 * rebuild the xref, its trailer ends (revisions) and each signature's /ByteRange, /SubFilter,
 * /Contents length and /M, i.e. everything EmbedPDF exposes about signatures.
 */
import { init, type WrappedPdfiumModule } from '@embedpdf/pdfium';

export interface PdfiumSignature {
  readonly byteRange: number[];
  readonly subFilter: string;
  readonly contentsLength: number;
  readonly time: string;
  readonly docMdp: number;
}

export interface PdfiumReport {
  readonly opened: boolean;
  readonly error?: number;
  readonly pageCount?: number;
  /** False when PDFium rebuilt the cross-reference table (a repair). */
  readonly validXref?: boolean;
  readonly trailerEnds?: number[];
  readonly signatures: PdfiumSignature[];
}

export type PdfiumProbe = (bytes: Uint8Array, password?: string) => PdfiumReport;

interface Heap {
  readonly HEAPU8: Uint8Array;
  readonly HEAP32: Int32Array;
  readonly HEAPU32: Uint32Array;
}

export async function createPdfiumProbe(wasmBinary: ArrayBuffer): Promise<PdfiumProbe> {
  const m: WrappedPdfiumModule = await init({ wasmBinary });
  m.PDFiumExt_Init();
  const heap = (): Heap => m.pdfium as unknown as Heap;
  const malloc = (n: number): number => {
    const ptr = m.pdfium.wasmExports.malloc(Math.max(n, 8));
    heap().HEAPU8.fill(0, ptr, ptr + Math.max(n, 8));
    return ptr;
  };
  const free = (ptr: number): void => m.pdfium.wasmExports.free(ptr);
  const readBuffer = (fill: (ptr: number, len: number) => number): Uint8Array => {
    const len = fill(0, 0);
    if (len <= 0) return new Uint8Array(0);
    const ptr = malloc(len);
    try {
      fill(ptr, len);
      return heap().HEAPU8.slice(ptr, ptr + len);
    } finally {
      free(ptr);
    }
  };
  const asciiz = (b: Uint8Array): string => String.fromCharCode(...b.subarray(0, b.indexOf(0)));

  return (bytes, password = '') => {
    const data = malloc(bytes.length);
    heap().HEAPU8.set(bytes, data);
    const doc = m.FPDF_LoadMemDocument(data, bytes.length, password);
    try {
      if (!doc) return { opened: false, error: m.FPDF_GetLastError(), signatures: [] };
      const ends = readBuffer((ptr, len) => m.FPDF_GetTrailerEnds(doc, ptr, len / 4) * 4);
      const trailerEnds = Array.from(new Uint32Array(ends.slice().buffer));
      const signatures: PdfiumSignature[] = [];
      const count = m.FPDF_GetSignatureCount(doc);
      for (let i = 0; i < count; i++) {
        const sig = m.FPDF_GetSignatureObject(doc, i);
        const range = readBuffer(
          (ptr, len) => m.FPDFSignatureObj_GetByteRange(sig, ptr, len / 4) * 4,
        );
        signatures.push({
          byteRange: Array.from(new Int32Array(range.slice().buffer)),
          subFilter: asciiz(readBuffer((p, l) => m.FPDFSignatureObj_GetSubFilter(sig, p, l))),
          contentsLength: m.FPDFSignatureObj_GetContents(sig, 0, 0),
          time: asciiz(readBuffer((p, l) => m.FPDFSignatureObj_GetTime(sig, p, l))),
          docMdp: m.FPDFSignatureObj_GetDocMDPPermission(sig),
        });
      }
      return {
        opened: true,
        pageCount: m.FPDF_GetPageCount(doc),
        validXref: m.FPDF_DocumentHasValidCrossReferenceTable(doc),
        trailerEnds,
        signatures,
      };
    } finally {
      if (doc) m.FPDF_CloseDocument(doc);
      free(data);
    }
  };
}
