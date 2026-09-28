/**
 * "The signed revision's pages are pixel-compared with the current ones" (spec §3.1 step 6,
 * M5 review finding 3): defence in depth behind the object classification (revisions.ts),
 * which can only be as good as its model of what a page draws. Both files are rendered by a
 * private PDFium (the signature worker has no viewer engine; the compress worker does the same,
 * pdfium-decoder.ts) at a modest DPI with annotations, and compared with the Compare view's
 * pixel diff (analysis/pixels.ts: pixelmatch, threshold 0.1, anti-aliasing ignored).
 *
 * Only the same renderer on both sides, so identical content renders identically: an equal
 * SHA-256 of the two rasters settles most pages without pixelmatch, and the current file's
 * digests are computed once per validation however many signatures need them.
 */
import { init } from '@embedpdf/pdfium';

import { diffRgba } from '../analysis/pixels';
import { Slicer } from '../analysis/scheduler';
import { type AnalysisRgba, EngineError } from '../types';

type Pdfium = Awaited<ReturnType<typeof init>>;

interface Heap {
  readonly HEAPU8: Uint8Array;
}

/** Default resolution: enough for a changed word or a note icon, cheap on long files. */
export const VISUAL_DPI = 50;
/** pixelmatch threshold of the Compare view (spec §2.1). */
const THRESHOLD = 0.1;
const FPDF_ANNOT = 0x01;
const FPDF_REVERSE_BYTE_ORDER = 0x10;
const BITMAP_BGRA = 4;
/** Pages larger than this many pixels are rendered at a lower DPI (bounded WASM memory). */
const MAX_PIXELS = 4_000_000;

const modules = new Map<string | ArrayBuffer, Promise<Pdfium>>();

function load(wasm: string | ArrayBuffer): Promise<Pdfium> {
  let found = modules.get(wasm);
  if (!found) {
    found = (async () => {
      let wasmBinary: ArrayBuffer;
      if (typeof wasm === 'string') {
        const base = (globalThis as { location?: { href: string } }).location?.href;
        const url = base === undefined ? wasm : new URL(wasm, base).href;
        const response = await fetch(url);
        if (!response.ok) throw new EngineError('internal', `pdfium.wasm: HTTP ${response.status}`);
        wasmBinary = await response.arrayBuffer();
      } else {
        wasmBinary = wasm.slice(0);
      }
      const pdfium = await init({ wasmBinary });
      pdfium.PDFiumExt_Init();
      return pdfium;
    })();
    found.catch(() => modules.delete(wasm));
    modules.set(wasm, found);
  }
  return found;
}

/** A document opened in the private PDFium; `close` frees it. */
class Opened {
  private constructor(
    private readonly pdfium: Pdfium,
    private readonly doc: number,
    private readonly filePtr: number,
  ) {}

  static open(pdfium: Pdfium, bytes: Uint8Array, password: string | undefined): Opened {
    const { malloc, free } = pdfium.pdfium.wasmExports;
    const filePtr = malloc(bytes.length);
    (pdfium.pdfium as unknown as Heap).HEAPU8.set(bytes, filePtr);
    const doc = pdfium.FPDF_LoadMemDocument(filePtr, bytes.length, password ?? '');
    if (!doc) {
      free(filePtr);
      throw new EngineError('internal', 'PDFium cannot open this revision');
    }
    return new Opened(pdfium, doc, filePtr);
  }

  get pageCount(): number {
    return this.pdfium.FPDF_GetPageCount(this.doc);
  }

  /** Page `index` rendered on white with annotations, `dpi` pixels per inch, RGBA. */
  render(index: number, dpi: number): AnalysisRgba {
    const p = this.pdfium;
    const { malloc, free } = p.pdfium.wasmExports;
    const page = p.FPDF_LoadPage(this.doc, index);
    if (!page) throw new EngineError('internal', `PDFium cannot load page ${index + 1}`);
    let buffer = 0;
    let bitmap = 0;
    try {
      const w = p.FPDF_GetPageWidthF(page);
      const h = p.FPDF_GetPageHeightF(page);
      const scale = Math.min(dpi / 72, Math.sqrt(MAX_PIXELS / Math.max(1, w * h)));
      const width = Math.max(1, Math.round(w * scale));
      const height = Math.max(1, Math.round(h * scale));
      const stride = width * 4;
      buffer = malloc(stride * height);
      if (!buffer) throw new RangeError('out of memory for a page render');
      bitmap = p.FPDFBitmap_CreateEx(width, height, BITMAP_BGRA, buffer, stride);
      if (!bitmap) throw new RangeError('FPDFBitmap_CreateEx failed');
      p.FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0xffffffff);
      p.FPDF_RenderPageBitmap(
        bitmap,
        page,
        0,
        0,
        width,
        height,
        0,
        FPDF_ANNOT | FPDF_REVERSE_BYTE_ORDER,
      );
      const heap = (p.pdfium as unknown as Heap).HEAPU8;
      const data = new Uint8ClampedArray(heap.slice(buffer, buffer + stride * height));
      for (let i = 3; i < data.length; i += 4) data[i] = 255;
      return { width, height, data };
    } finally {
      if (bitmap) p.FPDFBitmap_Destroy(bitmap);
      if (buffer) free(buffer);
      p.FPDF_ClosePage(page);
    }
  }

  close(): void {
    this.pdfium.FPDF_CloseDocument(this.doc);
    this.pdfium.pdfium.wasmExports.free(this.filePtr);
  }
}

async function sha256(image: AnalysisRgba): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', image.data.slice().buffer));
  let s = `${image.width}x${image.height}:`;
  for (const b of d) s += b.toString(16).padStart(2, '0');
  return s;
}

/** Compares signed revisions with the whole file; one per validation (holds digests). */
export class VisualComparer {
  private current: Promise<{ count: number; digests: string[] }> | undefined;

  constructor(
    private readonly bytes: Uint8Array,
    private readonly options: {
      readonly pdfiumWasm: string | ArrayBuffer;
      readonly dpi?: number;
      readonly password?: string;
      readonly signal?: AbortSignal;
    },
  ) {}

  private get dpi(): number {
    return this.options.dpi ?? VISUAL_DPI;
  }

  private currentDigests(pdfium: Pdfium): Promise<{ count: number; digests: string[] }> {
    this.current ??= (async () => {
      const opened = Opened.open(pdfium, this.bytes, this.options.password);
      try {
        const slicer = new Slicer('signature visual comparison', this.options.signal);
        const digests: string[] = [];
        for (let i = 0; i < opened.pageCount; i++) {
          digests.push(await sha256(opened.render(i, this.dpi)));
          await slicer.tick();
        }
        slicer.done();
        return { count: opened.pageCount, digests };
      } finally {
        opened.close();
      }
    })();
    return this.current;
  }

  /**
   * 0-based indices of the pages whose rendering differs between the file cut at `signedEnd`
   * and the whole file, including pages only one of them has.
   */
  async changedPages(signedEnd: number): Promise<number[]> {
    const pdfium = await load(this.options.pdfiumWasm);
    const current = await this.currentDigests(pdfium);
    const signed = Opened.open(pdfium, this.bytes.subarray(0, signedEnd), this.options.password);
    let whole: Opened | undefined;
    const slicer = new Slicer('signature visual comparison', this.options.signal);
    try {
      const out: number[] = [];
      const common = Math.min(signed.pageCount, current.count);
      for (let i = 0; i < common; i++) {
        const before = signed.render(i, this.dpi);
        if ((await sha256(before)) !== current.digests[i]) {
          whole ??= Opened.open(pdfium, this.bytes, this.options.password);
          const after = whole.render(i, this.dpi);
          const diff = await diffRgba(before, after, THRESHOLD, slicer);
          if (diff.changedPixels > 0 || diff.sizeMismatch) out.push(i);
        }
        await slicer.tick();
      }
      for (let i = common; i < Math.max(signed.pageCount, current.count); i++) out.push(i);
      slicer.done();
      return out;
    } finally {
      signed.close();
      whole?.close();
    }
  }
}
