/**
 * Raw PDFium calls used by the image editor (ADR-0011 §2: `image-objects/` joins
 * `text-edit/` and `redaction/` as a home of raw access). Page-object walking, matrices and
 * marks come from the text editor's `RawText`; this adds image streams and bitmaps. Calling
 * conventions follow the host's `PdfiumMemory` and EmbedPDF's own engine (bitmaps from our
 * buffers: `FPDFBitmap_CreateEx(w, h, FPDFBitmap_BGRA, buffer, stride)`). Everything here is
 * only valid inside `HostedEngine.withRawAccess`.
 */
import { RawText } from '../text-edit/raw';
import type { ImageFilterKind, TextMatrix } from '../types';

/** `FPDF_PAGEOBJ_IMAGE`. */
export const PAGEOBJ_IMAGE = 3;

/** `FPDFBitmap_*` formats. */
const BITMAP_GRAY = 1;
const BITMAP_BGR = 2;
const BITMAP_BGRX = 3;
const BITMAP_BGRA = 4;

/** `FPDF_COLORSPACE_*` names, by value. */
const COLOR_SPACES = [
  'unknown',
  'DeviceGray',
  'DeviceRGB',
  'DeviceCMYK',
  'CalGray',
  'CalRGB',
  'Lab',
  'ICCBased',
  'Separation',
  'DeviceN',
  'Indexed',
  'Pattern',
] as const;

const FILTER_KINDS: Readonly<Record<string, ImageFilterKind>> = {
  DCTDecode: 'DCT',
  DCT: 'DCT',
  JPXDecode: 'JPX',
  FlateDecode: 'Flate',
  Fl: 'Flate',
  CCITTFaxDecode: 'CCITT',
  CCF: 'CCITT',
  JBIG2Decode: 'JBIG2',
  LZWDecode: 'LZW',
  LZW: 'LZW',
  RunLengthDecode: 'RunLength',
  RL: 'RunLength',
  ASCIIHexDecode: 'ASCIIHex',
  AHx: 'ASCIIHex',
  ASCII85Decode: 'ASCII85',
  A85: 'ASCII85',
};

/** A bitmap read out of PDFium as RGBA (straight alpha, top row first). */
export interface RgbaPixels {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8ClampedArray;
}

export interface ImageMetadata {
  readonly bitsPerPixel: number;
  readonly colorSpace: string;
}

/** Raw image-object calls, bound to one module (`RawText` for the generic object calls). */
export class RawImages extends RawText {
  pixelSize(obj: number): { width: number; height: number } {
    return this.mem.withMem(8, (p) =>
      this.m.FPDFImageObj_GetImagePixelSize(obj, p, p + 4)
        ? { width: this.mem.u32(p), height: this.mem.u32(p + 4) }
        : { width: 0, height: 0 },
    );
  }

  /** The stream's filter names, in order (e.g. `['FlateDecode', 'DCTDecode']`). */
  filterNames(obj: number): string[] {
    const count = this.m.FPDFImageObj_GetImageFilterCount(obj);
    const out: string[] = [];
    for (let i = 0; i < count; i++) {
      out.push(
        this.mem.readUtf8Result((buf, len) => this.m.FPDFImageObj_GetImageFilter(obj, i, buf, len)),
      );
    }
    return out;
  }

  filters(obj: number): ImageFilterKind[] {
    return this.filterNames(obj).map((name) => FILTER_KINDS[name] ?? 'other');
  }

  /** Bits per pixel and colour space (`FPDF_IMAGEOBJ_METADATA`: 7 × 4 bytes). */
  metadata(obj: number, pagePtr: number): ImageMetadata {
    return this.mem.withMem(28, (p) => {
      if (!this.m.FPDFImageObj_GetImageMetadata(obj, pagePtr, p)) {
        return { bitsPerPixel: 0, colorSpace: 'unknown' };
      }
      const space = this.mem.i32(p + 20);
      return { bitsPerPixel: this.mem.u32(p + 16), colorSpace: COLOR_SPACES[space] ?? 'unknown' };
    });
  }

  /** The stream's data as stored (filters not applied). */
  rawData(obj: number): Uint8Array {
    const size = this.m.FPDFImageObj_GetImageDataRaw(obj, 0, 0);
    if (size <= 0) return new Uint8Array(0);
    return this.mem.withMem(size, (buf) => {
      this.m.FPDFImageObj_GetImageDataRaw(obj, buf, size);
      return this.mem.readBytes(buf, size);
    });
  }

  /** Copies an `FPDF_BITMAP` out as RGBA (any of PDFium's 8/24/32-bit formats). */
  readBitmap(bitmap: number): RgbaPixels {
    const m = this.m;
    const width = m.FPDFBitmap_GetWidth(bitmap);
    const height = m.FPDFBitmap_GetHeight(bitmap);
    const stride = m.FPDFBitmap_GetStride(bitmap);
    const format = m.FPDFBitmap_GetFormat(bitmap);
    const buffer = m.FPDFBitmap_GetBuffer(bitmap);
    if (![BITMAP_GRAY, BITMAP_BGR, BITMAP_BGRX, BITMAP_BGRA].includes(format)) {
      throw new Error(`Unexpected FPDF_BITMAP format ${format}`);
    }
    const rgba = new Uint8ClampedArray(width * height * 4);
    const heap = this.mem.heap().HEAPU8;
    for (let y = 0; y < height; y++) {
      const row = buffer + y * stride;
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4;
        if (format === BITMAP_GRAY) {
          const v = heap[row + x] ?? 0;
          rgba[o] = v;
          rgba[o + 1] = v;
          rgba[o + 2] = v;
          rgba[o + 3] = 255;
        } else if (format === BITMAP_BGR) {
          const i = row + x * 3;
          rgba[o] = heap[i + 2] ?? 0;
          rgba[o + 1] = heap[i + 1] ?? 0;
          rgba[o + 2] = heap[i] ?? 0;
          rgba[o + 3] = 255;
        } else {
          const i = row + x * 4;
          rgba[o] = heap[i + 2] ?? 0;
          rgba[o + 1] = heap[i + 1] ?? 0;
          rgba[o + 2] = heap[i] ?? 0;
          rgba[o + 3] = format === BITMAP_BGRA ? (heap[i + 3] ?? 0) : 255;
        }
      }
    }
    return { width, height, rgba };
  }

  /**
   * The image rendered with its masks, decode array and colour space applied
   * (`FPDFImageObj_GetRenderedBitmap`), at `width × height` pixels: the object's matrix is
   * set to that size for the call and restored exactly afterwards (the page is not
   * regenerated, so nothing of this reaches the content).
   */
  renderedPixels(
    docPtr: number,
    pagePtr: number,
    obj: number,
    width: number,
    height: number,
  ): RgbaPixels {
    const original = this.matrix(obj);
    this.setMatrix(obj, [width, 0, 0, height, 0, 0]);
    try {
      const bitmap = this.m.FPDFImageObj_GetRenderedBitmap(docPtr, pagePtr, obj);
      if (!bitmap) throw new Error('FPDFImageObj_GetRenderedBitmap failed');
      try {
        return this.readBitmap(bitmap);
      } finally {
        this.m.FPDFBitmap_Destroy(bitmap);
      }
    } finally {
      this.setMatrix(obj, original);
    }
  }

  /** Whether the rendered image has any pixel that is not opaque (a small render). */
  hasTransparency(docPtr: number, pagePtr: number, obj: number, pixelW: number, pixelH: number) {
    const scale = Math.min(1, 24 / Math.max(pixelW, pixelH, 1));
    const w = Math.max(1, Math.round(pixelW * scale));
    const h = Math.max(1, Math.round(pixelH * scale));
    try {
      const { rgba } = this.renderedPixels(docPtr, pagePtr, obj, w, h);
      for (let i = 3; i < rgba.length; i += 4) if ((rgba[i] ?? 255) < 250) return true;
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Runs `fn` with an `FPDF_BITMAP` holding `rgba` (converted to BGRA in our own buffer, as
   * EmbedPDF's `addImageObject` does); bitmap and buffer are released afterwards.
   */
  withBgraBitmap<T>(
    rgba: Uint8Array | Uint8ClampedArray,
    width: number,
    height: number,
    fn: (bitmap: number) => T,
  ): T {
    const size = width * height * 4;
    const buffer = this.mem.malloc(size);
    try {
      const heap = this.mem.heap().HEAPU8;
      for (let i = 0; i < size; i += 4) {
        heap[buffer + i] = rgba[i + 2] ?? 0;
        heap[buffer + i + 1] = rgba[i + 1] ?? 0;
        heap[buffer + i + 2] = rgba[i] ?? 0;
        heap[buffer + i + 3] = rgba[i + 3] ?? 0;
      }
      const bitmap = this.m.FPDFBitmap_CreateEx(width, height, BITMAP_BGRA, buffer, width * 4);
      if (!bitmap) throw new Error('FPDFBitmap_CreateEx failed');
      try {
        return fn(bitmap);
      } finally {
        this.m.FPDFBitmap_Destroy(bitmap);
      }
    } finally {
      this.mem.free(buffer);
    }
  }

  /** Runs `fn` with `bytes` copied into the heap. */
  withBytes<T>(bytes: Uint8Array, fn: (ptr: number, length: number) => T): T {
    const ptr = this.mem.copyIn(bytes);
    try {
      return fn(ptr, bytes.length);
    } finally {
      this.mem.free(ptr);
    }
  }

  /** Transforms the object's clip path (when it has one) by `m`. */
  transformClip(obj: number, m: TextMatrix): void {
    if (!this.m.FPDFPageObj_GetClipPath(obj)) return;
    this.m.FPDFPageObj_TransformClipPath(obj, m[0], m[1], m[2], m[3], m[4], m[5]);
  }
}
