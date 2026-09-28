/**
 * Memory and string helpers for raw PDFium calls (ADR-0011 §2). Calling conventions follow
 * EmbedPDF's own engine: `malloc`/`free` from `wasmExports`, strings as NUL-terminated
 * UTF-16LE (`FPDF_WIDESTRING`), and heap views looked up again after every call, because a
 * call that grows WASM memory detaches the previous `HEAP*` views.
 */
import type { WrappedPdfiumModule } from '@embedpdf/pdfium';

/** The Emscripten heap views of the module (typed loosely by `@embedpdf/pdfium`). */
export interface PdfiumHeap {
  readonly HEAPU8: Uint8Array;
  readonly HEAP32: Int32Array;
  readonly HEAPU32: Uint32Array;
  readonly HEAPF32: Float32Array;
  readonly HEAPF64: Float64Array;
}

/** A PDFium call that fills `buffer` (`length` bytes) and returns the size it needs. */
export type BufferCall = (buffer: number, length: number) => number;

export class PdfiumMemory {
  constructor(readonly module: WrappedPdfiumModule) {}

  /** The current heap views. Never keep the result across a PDFium call. */
  heap(): PdfiumHeap {
    return this.module.pdfium as unknown as PdfiumHeap;
  }

  /** Allocates at least `size` bytes (8 minimum), zero-filled. Throws when out of memory. */
  malloc(size: number): number {
    const bytes = Math.max(size, 8);
    const ptr = this.module.pdfium.wasmExports.malloc(bytes);
    if (!ptr) throw new RangeError(`PDFium malloc(${bytes}) failed: out of memory`);
    this.heap().HEAPU8.fill(0, ptr, ptr + bytes);
    return ptr;
  }

  free(ptr: number): void {
    if (ptr) this.module.pdfium.wasmExports.free(ptr);
  }

  /** Runs `fn` with a zero-filled scratch buffer that is freed afterwards. */
  withMem<T>(size: number, fn: (ptr: number) => T): T {
    const ptr = this.malloc(size);
    try {
      return fn(ptr);
    } finally {
      this.free(ptr);
    }
  }

  // --- Scalars (read after the call that wrote them) ---

  u8(ptr: number): number {
    return this.heap().HEAPU8[ptr] ?? 0;
  }
  i32(ptr: number): number {
    return this.heap().HEAP32[ptr >> 2] ?? 0;
  }
  u32(ptr: number): number {
    return this.heap().HEAPU32[ptr >> 2] ?? 0;
  }
  f32(ptr: number): number {
    return this.heap().HEAPF32[ptr >> 2] ?? Number.NaN;
  }
  f64(ptr: number): number {
    return this.heap().HEAPF64[ptr >> 3] ?? Number.NaN;
  }

  // --- Bytes ---

  /** Copies `bytes` into a new allocation. Caller frees. */
  copyIn(bytes: Uint8Array): number {
    const ptr = this.malloc(bytes.length);
    this.heap().HEAPU8.set(bytes, ptr);
    return ptr;
  }

  /** A copy (not a view) of `length` bytes at `ptr`. */
  readBytes(ptr: number, length: number): Uint8Array {
    return this.heap().HEAPU8.slice(ptr, ptr + length);
  }

  // --- Strings ---

  /** `text` as a NUL-terminated UTF-16LE string (`FPDF_WIDESTRING`). Caller frees. */
  wideString(text: string): number {
    const ptr = this.malloc((text.length + 1) * 2);
    const h = this.heap().HEAPU8;
    for (let i = 0; i < text.length; i++) {
      const unit = text.charCodeAt(i);
      h[ptr + 2 * i] = unit & 0xff;
      h[ptr + 2 * i + 1] = unit >> 8;
    }
    return ptr;
  }

  /** Runs `fn` with `text` as an `FPDF_WIDESTRING` that is freed afterwards. */
  withWideString<T>(text: string, fn: (ptr: number) => T): T {
    const ptr = this.wideString(text);
    try {
      return fn(ptr);
    } finally {
      this.free(ptr);
    }
  }

  /** UTF-16LE from `ptr`, at most `bytes` long, stopping at the first NUL unit. */
  readUtf16(ptr: number, bytes: number): string {
    const h = this.heap().HEAPU8;
    let out = '';
    for (let i = 0; i + 1 < bytes; i += 2) {
      const unit = (h[ptr + i] ?? 0) | ((h[ptr + i + 1] ?? 0) << 8);
      if (unit === 0) break;
      out += String.fromCharCode(unit);
    }
    return out;
  }

  /** UTF-8 from `ptr`, at most `bytes` long, stopping at the first NUL. */
  readUtf8(ptr: number, bytes: number): string {
    const slice = this.readBytes(ptr, bytes);
    const end = slice.indexOf(0);
    return new TextDecoder().decode(end === -1 ? slice : slice.subarray(0, end));
  }

  /**
   * The usual two-call pattern for a UTF-16 result: `call(0, 0)` returns the size in bytes
   * (NUL included), then the call fills a buffer of that size. Empty when the size is ≤ 2.
   */
  readUtf16Result(call: BufferCall): string {
    const bytes = call(0, 0);
    if (bytes <= 2) return '';
    return this.withMem(bytes, (buf) => {
      call(buf, bytes);
      return this.readUtf16(buf, bytes);
    });
  }

  /** The same pattern for a UTF-8 result (e.g. `FPDFFont_GetBaseFontName`). */
  readUtf8Result(call: BufferCall): string {
    const bytes = call(0, 0);
    if (bytes <= 1) return '';
    return this.withMem(bytes, (buf) => {
      call(buf, bytes);
      return this.readUtf8(buf, bytes);
    });
  }
}
