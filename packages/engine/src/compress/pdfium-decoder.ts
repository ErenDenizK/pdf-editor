/**
 * Decodes image XObjects through PDFium's raw module (`@embedpdf/pdfium`), so every colour
 * space and filter PDFium understands (ICC, Indexed, CMYK, Lab, LZW, JPEG with Adobe
 * transforms, 16-bit, /Decode arrays) arrives as plain RGBA.
 *
 * The EmbedPDF engine the viewer uses runs PDFium in its own blob: worker and does not
 * expose the module, so the compress worker instantiates a second, private PDFium from the
 * same self-hosted `pdfium.wasm` (loaded only when the image pass runs).
 *
 * Each image is decoded from a one-page probe PDF built by the caller (`probe.ts`): page
 * size = image pixel size, content `q w 0 0 h 0 0 cm /Im0 Do Q`.
 * - `FPDFImageObj_GetBitmap`: the image's own pixels at native size (soft mask ignored).
 * - With `composite`: the page rendered 1:1 onto white (`FPDF_RenderPageBitmap`), which
 *   applies the soft mask — the "flatten alpha onto white" path.
 */
import { init } from '@embedpdf/pdfium';

export interface DecodedImage {
  readonly width: number;
  readonly height: number;
  /** RGBA, 8 bits per channel, alpha 255. */
  readonly data: Uint8ClampedArray;
}

/** FPDFBitmap formats (fpdfview.h). */
const FORMAT = { gray: 1, bgr: 2, bgrx: 3, bgra: 4 } as const;
const FPDF_PAGEOBJ_IMAGE = 3;
const FPDF_REVERSE_BYTE_ORDER = 0x10;
const FPDF_ANNOT = 0x01;

type Pdfium = Awaited<ReturnType<typeof init>>;

interface Heap {
  readonly HEAPU8: Uint8Array;
}

export class PdfiumImageDecoder {
  private module: Promise<Pdfium> | undefined;

  constructor(private readonly wasmUrl: string) {}

  private load(): Promise<Pdfium> {
    if (this.module === undefined) {
      const base = (globalThis as { location?: { href: string } }).location?.href;
      const url = base === undefined ? this.wasmUrl : new URL(this.wasmUrl, base).href;
      const created = fetch(url)
        .then(async (response) => {
          if (!response.ok) throw new Error(`pdfium.wasm: HTTP ${response.status}`);
          return response.arrayBuffer();
        })
        .then(async (wasmBinary) => {
          const pdfium = await init({ wasmBinary });
          pdfium.PDFiumExt_Init();
          return pdfium;
        });
      created.catch(() => {
        if (this.module === created) this.module = undefined;
      });
      this.module = created;
    }
    return this.module;
  }

  /** Decodes the single image of `probe`; null when PDFium cannot. */
  async decode(
    probe: Uint8Array,
    options: { readonly composite: boolean; readonly width: number; readonly height: number },
  ): Promise<DecodedImage | null> {
    const pdfium = await this.load();
    const heap = () => (pdfium.pdfium as unknown as Heap).HEAPU8;
    const { malloc, free } = pdfium.pdfium.wasmExports;
    const filePtr = malloc(probe.length);
    heap().set(probe, filePtr);
    const doc = pdfium.FPDF_LoadMemDocument(filePtr, probe.length, '');
    if (!doc) {
      free(filePtr);
      return null;
    }
    let page = 0;
    let bitmap = 0;
    let bufferPtr = 0;
    try {
      page = pdfium.FPDF_LoadPage(doc, 0);
      if (!page) return null;
      if (options.composite) {
        const { width, height } = options;
        const stride = width * 4;
        bufferPtr = malloc(stride * height);
        if (!bufferPtr) return null;
        bitmap = pdfium.FPDFBitmap_CreateEx(width, height, FORMAT.bgra, bufferPtr, stride);
        if (!bitmap) return null;
        pdfium.FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0xffffffff);
        pdfium.FPDF_RenderPageBitmap(
          bitmap,
          page,
          0,
          0,
          width,
          height,
          0,
          FPDF_REVERSE_BYTE_ORDER | FPDF_ANNOT,
        );
        const data = new Uint8ClampedArray(heap().slice(bufferPtr, bufferPtr + stride * height));
        for (let i = 3; i < data.length; i += 4) data[i] = 255;
        return { width, height, data };
      }
      const object = pdfium.FPDFPage_GetObject(page, 0);
      if (!object || pdfium.FPDFPageObj_GetType(object) !== FPDF_PAGEOBJ_IMAGE) return null;
      bitmap = pdfium.FPDFImageObj_GetBitmap(object);
      if (!bitmap) return null;
      const width = pdfium.FPDFBitmap_GetWidth(bitmap);
      const height = pdfium.FPDFBitmap_GetHeight(bitmap);
      const stride = pdfium.FPDFBitmap_GetStride(bitmap);
      const format = pdfium.FPDFBitmap_GetFormat(bitmap);
      const ptr = pdfium.FPDFBitmap_GetBuffer(bitmap);
      if (!ptr || width <= 0 || height <= 0) return null;
      const src = heap().subarray(ptr, ptr + stride * height);
      return { width, height, data: toRgba(src, width, height, stride, format) };
    } finally {
      if (bitmap) pdfium.FPDFBitmap_Destroy(bitmap);
      if (bufferPtr) free(bufferPtr);
      if (page) pdfium.FPDF_ClosePage(page);
      pdfium.FPDF_CloseDocument(doc);
      free(filePtr);
    }
  }
}

/** PDFium bitmap (gray / BGR / BGRx / BGRA, padded rows) to tightly packed RGBA. */
export function toRgba(
  src: Uint8Array,
  width: number,
  height: number,
  stride: number,
  format: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  const bpp = format === FORMAT.gray ? 1 : format === FORMAT.bgr ? 3 : 4;
  for (let y = 0; y < height; y++) {
    let s = y * stride;
    let d = y * width * 4;
    for (let x = 0; x < width; x++, s += bpp, d += 4) {
      if (bpp === 1) {
        const v = src[s] as number;
        out[d] = v;
        out[d + 1] = v;
        out[d + 2] = v;
      } else {
        out[d] = src[s + 2] as number;
        out[d + 1] = src[s + 1] as number;
        out[d + 2] = src[s] as number;
      }
      // Alpha of the image itself (BGRA from a /Decode'd stencil) is ignored: soft masks
      // are handled by the caller, and opaque output is what the image pass writes.
      out[d + 3] = 255;
    }
  }
  return out;
}
