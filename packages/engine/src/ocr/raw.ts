/**
 * Raw PDFium work for OCR (ADR-0011 §2: `ocr/` joins the homes of raw access). Only valid
 * inside `HostedEngine.withRawAccess`, which holds the source's lock and the orchestrator's
 * queue slot:
 *
 * - `pageFacts`: visible and invisible text (render modes 3 and 7; this app's layer is the
 *   marked-content sequence `/PdfEditorOCR` inside its Form XObject), image count and the
 *   largest image's effective DPI.
 * - `renderGreyPage`: an 8-bit grey raster in display orientation, without annotations or
 *   widgets, rendered in bands (bounded WASM memory) with `FPDF_RenderPageBitmap`, and the
 *   exact pixel → user-space matrix from `FPDF_DeviceToPage` (so /Rotate, the extra
 *   rotation and CropBox offsets are PDFium's own maths).
 * - `removeInvisibleText`: removes render-mode-3/7 text objects (pages and Form XObjects)
 *   and regenerates the page content.
 */
import type { RawAccess } from '../pdfium/host/hosted-engine';
import { multiply, PAGEOBJ_FORM, PAGEOBJ_TEXT, RawText } from '../text-edit/raw';
import type { OcrPageFacts, TextMatrix } from '../types';

/** `FPDF_PAGEOBJ_IMAGE`. */
const PAGEOBJ_IMAGE = 3;
/** Nesting limit for Form XObjects (as the redaction pass). */
const MAX_FORM_DEPTH = 8;
/** `FPDF_REVERSE_BYTE_ORDER`: RGBA byte order. No `FPDF_ANNOT`: annotations are not drawn. */
const RENDER_FLAGS = 0x10;
/** `FPDFBitmap_BGRA`. */
const BITMAP_BGRA = 4;
/** Band buffer size in the WASM heap. */
const BAND_BYTES = 8 * 1024 * 1024;

/** Marked-content tag around this app's invisible words (layer.ts). */
export const OCR_MARK = 'PdfEditorOCR';

const isInvisibleMode = (mode: number) => mode === 3 || mode === 7;

function walk(
  raw: RawText,
  objects: readonly number[],
  toPage: TextMatrix,
  depth: number,
  visit: (obj: number, type: number, toPage: TextMatrix) => void,
): void {
  for (const obj of objects) {
    if (!obj) continue;
    const type = raw.objectType(obj);
    visit(obj, type, toPage);
    if (type === PAGEOBJ_FORM && depth < MAX_FORM_DEPTH) {
      walk(raw, raw.formObjects(obj), multiply(raw.matrix(obj), toPage), depth + 1, visit);
    }
  }
}

export function pageFacts(access: RawAccess, pageIndex: number): OcrPageFacts {
  const raw = new RawText(access.module, access.memory);
  const page = access.doc.acquirePage(pageIndex);
  try {
    const pagePtr = page.pagePtr;
    let visibleText = false;
    let ours = false;
    let foreign = false;
    raw.withTextPage(pagePtr, (textPage) => {
      const modes = new Map<number, { invisible: boolean; ours: boolean }>();
      const count = raw.charCount(textPage);
      for (let i = 0; i < count; i++) {
        if (raw.isGenerated(textPage, i)) continue;
        if (/^\s*$/u.test(raw.charText(textPage, i))) continue;
        const obj = raw.charObject(textPage, i);
        if (!obj) continue;
        let info = modes.get(obj);
        if (!info) {
          const invisible = isInvisibleMode(raw.renderMode(obj));
          info = {
            invisible,
            ours: invisible && raw.marks(obj).some((m) => m.name === OCR_MARK),
          };
          modes.set(obj, info);
        }
        if (!info.invisible) visibleText = true;
        else if (info.ours) ours = true;
        else foreign = true;
      }
    });
    let images = 0;
    let largest: { area: number; dpi: number } | undefined;
    walk(raw, raw.pageObjects(pagePtr), [1, 0, 0, 1, 0, 0], 0, (obj, type, toPage) => {
      if (type !== PAGEOBJ_IMAGE) return;
      images++;
      const m = multiply(raw.matrix(obj), toPage);
      const w = Math.hypot(m[0], m[1]);
      const h = Math.hypot(m[2], m[3]);
      const px = access.memory.withMem(8, (p) =>
        access.module.FPDFImageObj_GetImagePixelSize(obj, p, p + 4)
          ? { w: access.memory.u32(p), h: access.memory.u32(p + 4) }
          : { w: 0, h: 0 },
      );
      if (w <= 0 || h <= 0 || px.w === 0 || px.h === 0) return;
      const dpi = Math.min((px.w * 72) / w, (px.h * 72) / h);
      if (!largest || w * h > largest.area) largest = { area: w * h, dpi };
    });
    return {
      pageIndex,
      visibleText,
      invisibleText: foreign ? 'foreign' : ours ? 'ours' : 'none',
      ourLayer: ours,
      images,
      imageOnly: images > 0 && !visibleText,
      ...(largest ? { imageDpi: Math.round(largest.dpi) } : {}),
    };
  } finally {
    page.release();
  }
}

export interface GreyRaster {
  readonly grey: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly dpi: number;
  readonly requestedDpi?: number;
  readonly toUser: TextMatrix;
}

/** Renders `pageIndex` as 8-bit grey (Rec. 601 luma of PDFium's RGB render). */
export function renderGreyPage(
  access: RawAccess,
  pageIndex: number,
  options: { readonly dpi: number; readonly quarterTurns: number; readonly maxPixels: number },
): GreyRaster {
  const { module: m, memory: mem } = access;
  const page = access.doc.acquirePage(pageIndex);
  try {
    const pagePtr = page.pagePtr;
    const turns = options.quarterTurns & 3;
    // Displayed size with /Rotate, then the extra rotation.
    const pw = m.FPDF_GetPageWidthF(pagePtr);
    const ph = m.FPDF_GetPageHeightF(pagePtr);
    const dw = turns & 1 ? ph : pw;
    const dh = turns & 1 ? pw : ph;
    let dpi = options.dpi;
    const pixels = (d: number) => Math.round((dw * d) / 72) * Math.round((dh * d) / 72);
    if (pixels(dpi) > options.maxPixels) {
      dpi = Math.floor(dpi * Math.sqrt(options.maxPixels / pixels(dpi)));
      while (dpi > 1 && pixels(dpi) > options.maxPixels) dpi--;
    }
    const width = Math.max(1, Math.round((dw * dpi) / 72));
    const height = Math.max(1, Math.round((dh * dpi) / 72));
    const grey = new Uint8Array(width * height);
    const stride = width * 4;
    const band = Math.max(1, Math.min(height, Math.floor(BAND_BYTES / stride)));
    const buffer = mem.malloc(stride * band);
    const bitmap = m.FPDFBitmap_CreateEx(width, band, BITMAP_BGRA, buffer, stride);
    if (!bitmap) {
      mem.free(buffer);
      throw new RangeError('FPDFBitmap_CreateEx failed: out of memory');
    }
    try {
      for (let top = 0; top < height; top += band) {
        const rows = Math.min(band, height - top);
        m.FPDFBitmap_FillRect(bitmap, 0, 0, width, band, 0xffffffff);
        m.FPDF_RenderPageBitmap(bitmap, pagePtr, 0, -top, width, height, turns, RENDER_FLAGS);
        const heap = mem.heap().HEAPU8;
        let o = top * width;
        for (let i = buffer, end = buffer + rows * stride; i < end; i += 4) {
          grey[o++] =
            (299 * (heap[i] ?? 255) + 587 * (heap[i + 1] ?? 255) + 114 * (heap[i + 2] ?? 255)) /
            1000;
        }
      }
    } finally {
      m.FPDFBitmap_Destroy(bitmap);
      mem.free(buffer);
    }
    const toUser = mem.withMem(16, (p): TextMatrix => {
      const at = (x: number, y: number) => {
        if (!m.FPDF_DeviceToPage(pagePtr, 0, 0, width, height, turns, x, y, p, p + 8)) {
          throw new Error('FPDF_DeviceToPage failed');
        }
        return { x: mem.f64(p), y: mem.f64(p + 8) };
      };
      const o = at(0, 0);
      const px = at(width, 0);
      const py = at(0, height);
      return [
        (px.x - o.x) / width,
        (px.y - o.y) / width,
        (py.x - o.x) / height,
        (py.y - o.y) / height,
        o.x,
        o.y,
      ];
    });
    return {
      grey,
      width,
      height,
      dpi,
      ...(dpi === options.dpi ? {} : { requestedDpi: options.dpi }),
      toUser,
    };
  } finally {
    page.release();
  }
}

/**
 * Removes every render-mode-3/7 text object of the page (Form XObjects included) and
 * regenerates the content. Returns the objects removed and the invisible characters left.
 */
export function removeInvisibleText(
  access: RawAccess,
  pageIndex: number,
): { removed: number; remaining: number } {
  const { module: m } = access;
  const raw = new RawText(access.module, access.memory);
  const page = access.doc.acquirePage(pageIndex);
  let removed = 0;
  try {
    const pagePtr = page.pagePtr;
    const prune = (
      count: () => number,
      get: (i: number) => number,
      remove: (obj: number) => boolean,
      depth: number,
    ): void => {
      for (let i = count() - 1; i >= 0; i--) {
        const obj = get(i);
        if (!obj) continue;
        const type = raw.objectType(obj);
        if (type === PAGEOBJ_TEXT && isInvisibleMode(raw.renderMode(obj))) {
          if (remove(obj)) {
            m.FPDFPageObj_Destroy(obj);
            removed++;
          }
        } else if (type === PAGEOBJ_FORM && depth < MAX_FORM_DEPTH) {
          prune(
            () => m.FPDFFormObj_CountObjects(obj),
            (k) => m.FPDFFormObj_GetObject(obj, k),
            (child) => m.FPDFFormObj_RemoveObject(obj, child),
            depth + 1,
          );
        }
      }
    };
    prune(
      () => m.FPDFPage_CountObjects(pagePtr),
      (i) => m.FPDFPage_GetObject(pagePtr, i),
      (obj) => m.FPDFPage_RemoveObject(pagePtr, obj),
      0,
    );
    if (removed > 0 && !m.FPDFPage_GenerateContent(pagePtr)) {
      throw new Error('FPDFPage_GenerateContent failed');
    }
  } finally {
    access.dropPageCache(pageIndex);
  }
  // Re-read the regenerated page.
  const fresh = access.doc.acquirePage(pageIndex);
  try {
    let remaining = 0;
    raw.withTextPage(fresh.pagePtr, (textPage) => {
      const count = raw.charCount(textPage);
      for (let i = 0; i < count; i++) {
        if (raw.isGenerated(textPage, i)) continue;
        const obj = raw.charObject(textPage, i);
        if (obj && isInvisibleMode(raw.renderMode(obj))) remaining++;
      }
    });
    return { removed, remaining };
  } finally {
    fresh.release();
  }
}
