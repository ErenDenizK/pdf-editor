/**
 * Raw PDFium calls used by the text editor (ADR-0011 §2: `text-edit/` may touch the raw
 * module). Calling conventions follow the host's `PdfiumMemory`: scratch buffers are freed
 * after every call and heap views are read again after each call. Everything here is only
 * valid inside `HostedEngine.withRawAccess`.
 */
import type { WrappedPdfiumModule } from '@embedpdf/pdfium';
import type { Rect } from '@pdf-editor/document-model';

import type { PdfiumMemory } from '../pdfium/host/memory';
import type { TextMatrix } from '../types';

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** `FPDF_PAGEOBJ_*` constants. */
export const PAGEOBJ_TEXT = 1;
export const PAGEOBJ_FORM = 5;

/** `FPDF_OBJECT_*` constants (mark parameter value types). */
const OBJECT_NUMBER = 2;
const OBJECT_STRING = 3;
const OBJECT_NAME = 4;

/** Facts about an `FPDF_FONT`. */
export interface FontFacts {
  readonly baseName: string;
  readonly familyName: string;
  readonly embedded: boolean;
  readonly flags: number;
  readonly weight: number;
  readonly italicAngle: number;
  /** Bytes of the font program PDFium uses (the substitute for non-embedded fonts). */
  readonly dataBytes: number;
}

/** A marked-content mark of a page object and its simple parameters. */
export interface MarkSnapshot {
  readonly name: string;
  readonly params: readonly (
    | { readonly key: string; readonly kind: 'int'; readonly value: number }
    | { readonly key: string; readonly kind: 'float'; readonly value: number }
    | { readonly key: string; readonly kind: 'string'; readonly value: string }
  )[];
}

export type Rgba = readonly [number, number, number, number];

/** Row-vector affine product: apply `a`, then `b`. */
export function multiply(a: TextMatrix, b: TextMatrix): TextMatrix {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}

/** Raw text, font and page-object calls, bound to one module. */
export class RawText {
  constructor(
    readonly m: WrappedPdfiumModule,
    readonly mem: PdfiumMemory,
  ) {}

  // --- Text pages (always fresh: the executor's cached text page goes stale after edits) ---

  /** Runs `fn` with a freshly loaded text page, closed afterwards. */
  withTextPage<T>(pagePtr: number, fn: (textPage: number) => T): T {
    const textPage = this.m.FPDFText_LoadPage(pagePtr);
    if (!textPage) throw new Error('FPDFText_LoadPage failed');
    try {
      return fn(textPage);
    } finally {
      this.m.FPDFText_ClosePage(textPage);
    }
  }

  charCount(textPage: number): number {
    return this.m.FPDFText_CountChars(textPage);
  }

  /** The character's text (a code point may be outside the BMP). */
  charText(textPage: number, index: number): string {
    const code = this.m.FPDFText_GetUnicode(textPage, index);
    try {
      return String.fromCodePoint(code);
    } catch {
      return '�';
    }
  }

  /** The text object drawing the character; 0 for characters PDFium generated. */
  charObject(textPage: number, index: number): number {
    return this.m.FPDFText_GetTextObject(textPage, index);
  }

  charOrigin(textPage: number, index: number): Point {
    return this.mem.withMem(16, (p) => {
      this.m.FPDFText_GetCharOrigin(textPage, index, p, p + 8);
      return { x: this.mem.f64(p), y: this.mem.f64(p + 8) };
    });
  }

  /** Glyph box, unrotated user space. */
  charBox(textPage: number, index: number): Rect {
    return this.mem.withMem(32, (p) => {
      this.m.FPDFText_GetCharBox(textPage, index, p, p + 8, p + 16, p + 24);
      const left = this.mem.f64(p);
      const right = this.mem.f64(p + 8);
      const bottom = this.mem.f64(p + 16);
      const top = this.mem.f64(p + 24);
      return { x: left, y: bottom, width: right - left, height: top - bottom };
    });
  }

  // --- Page objects ---

  pageObjects(pagePtr: number): number[] {
    const count = this.m.FPDFPage_CountObjects(pagePtr);
    const out: number[] = [];
    for (let i = 0; i < count; i++) out.push(this.m.FPDFPage_GetObject(pagePtr, i));
    return out;
  }

  formObjects(form: number): number[] {
    const count = this.m.FPDFFormObj_CountObjects(form);
    const out: number[] = [];
    for (let i = 0; i < count; i++) out.push(this.m.FPDFFormObj_GetObject(form, i));
    return out;
  }

  objectType(obj: number): number {
    return this.m.FPDFPageObj_GetType(obj);
  }

  matrix(obj: number): TextMatrix {
    return this.mem.withMem(24, (p) => {
      if (!this.m.FPDFPageObj_GetMatrix(obj, p)) throw new Error('FPDFPageObj_GetMatrix failed');
      return [0, 1, 2, 3, 4, 5].map((i) => this.mem.f32(p + 4 * i)) as unknown as TextMatrix;
    });
  }

  setMatrix(obj: number, matrix: TextMatrix): void {
    this.mem.withMem(24, (p) => {
      this.mem.heap().HEAPF32.set(matrix, p >> 2);
      if (!this.m.FPDFPageObj_SetMatrix(obj, p)) throw new Error('FPDFPageObj_SetMatrix failed');
    });
  }

  fillColor(obj: number): Rgba | undefined {
    return this.color(obj, 'fill');
  }

  strokeColor(obj: number): Rgba | undefined {
    return this.color(obj, 'stroke');
  }

  private color(obj: number, which: 'fill' | 'stroke'): Rgba | undefined {
    return this.mem.withMem(16, (p) => {
      const ok =
        which === 'fill'
          ? this.m.FPDFPageObj_GetFillColor(obj, p, p + 4, p + 8, p + 12)
          : this.m.FPDFPageObj_GetStrokeColor(obj, p, p + 4, p + 8, p + 12);
      if (!ok) return undefined;
      return [this.mem.u32(p), this.mem.u32(p + 4), this.mem.u32(p + 8), this.mem.u32(p + 12)];
    });
  }

  strokeWidth(obj: number): number | undefined {
    return this.mem.withMem(4, (p) =>
      this.m.FPDFPageObj_GetStrokeWidth(obj, p) ? this.mem.f32(p) : undefined,
    );
  }

  /** Copies colours, stroke width and render mode from `from` to `to`. */
  copyStyle(from: number, to: number): void {
    const fill = this.fillColor(from);
    if (fill) this.m.FPDFPageObj_SetFillColor(to, fill[0], fill[1], fill[2], fill[3]);
    const stroke = this.strokeColor(from);
    if (stroke) this.m.FPDFPageObj_SetStrokeColor(to, stroke[0], stroke[1], stroke[2], stroke[3]);
    const width = this.strokeWidth(from);
    if (width !== undefined) this.m.FPDFPageObj_SetStrokeWidth(to, width);
    this.m.FPDFTextObj_SetTextRenderMode(to, this.m.FPDFTextObj_GetTextRenderMode(from));
  }

  // --- Marked content ---

  marks(obj: number): MarkSnapshot[] {
    const out: MarkSnapshot[] = [];
    const count = this.m.FPDFPageObj_CountMarks(obj);
    for (let k = 0; k < count; k++) {
      const mark = this.m.FPDFPageObj_GetMark(obj, k);
      if (!mark) continue;
      const name = this.utf16Out((buf, len, outLen) =>
        this.m.FPDFPageObjMark_GetName(mark, buf, len, outLen),
      );
      const params: MarkSnapshot['params'][number][] = [];
      const paramCount = this.m.FPDFPageObjMark_CountParams(mark);
      for (let i = 0; i < paramCount; i++) {
        const key = this.utf16Out((buf, len, outLen) =>
          this.m.FPDFPageObjMark_GetParamKey(mark, i, buf, len, outLen),
        );
        if (!key) continue;
        const type = this.m.FPDFPageObjMark_GetParamValueType(mark, key);
        if (type === OBJECT_NUMBER) {
          const asFloat = this.mem.withMem(4, (p) =>
            this.m.FPDFPageObjMark_GetParamFloatValue(mark, key, p) ? this.mem.f32(p) : NaN,
          );
          const asInt = this.mem.withMem(4, (p) =>
            this.m.FPDFPageObjMark_GetParamIntValue(mark, key, p) ? this.mem.i32(p) : NaN,
          );
          if (Number.isFinite(asInt) && (!Number.isFinite(asFloat) || asFloat === asInt)) {
            params.push({ key, kind: 'int', value: asInt });
          } else if (Number.isFinite(asFloat)) {
            params.push({ key, kind: 'float', value: asFloat });
          }
        } else if (type === OBJECT_STRING || type === OBJECT_NAME) {
          const value = this.utf16Out((buf, len, outLen) =>
            this.m.FPDFPageObjMark_GetParamStringValue(mark, key, buf, len, outLen),
          );
          params.push({ key, kind: 'string', value });
        }
      }
      out.push({ name, params });
    }
    return out;
  }

  /** Adds `marks` to `obj` (the new object gets the original's marked-content sequences). */
  applyMarks(docPtr: number, obj: number, marks: readonly MarkSnapshot[]): void {
    for (const snapshot of marks) {
      const mark = this.m.FPDFPageObj_AddMark(obj, snapshot.name);
      if (!mark) continue;
      for (const param of snapshot.params) {
        if (param.kind === 'int') {
          this.m.FPDFPageObjMark_SetIntParam(docPtr, obj, mark, param.key, param.value);
        } else if (param.kind === 'float') {
          this.m.FPDFPageObjMark_SetFloatParam(docPtr, obj, mark, param.key, param.value);
        } else {
          this.m.FPDFPageObjMark_SetStringParam(docPtr, obj, mark, param.key, param.value);
        }
      }
    }
  }

  /** `(buffer, length, outLength*)` calls returning UTF-16LE. */
  private utf16Out(call: (buf: number, len: number, outLen: number) => boolean): string {
    return this.mem.withMem(4, (outLen) => {
      if (!call(0, 0, outLen)) return '';
      const bytes = this.mem.u32(outLen);
      if (bytes <= 2) return '';
      return this.mem.withMem(bytes, (buf) => {
        call(buf, bytes, outLen);
        return this.mem.readUtf16(buf, bytes);
      });
    });
  }

  // --- Text objects and fonts ---

  objectText(obj: number, textPage: number): string {
    return this.mem.readUtf16Result((buf, len) =>
      this.m.FPDFTextObj_GetText(obj, textPage, buf, len),
    );
  }

  font(obj: number): number {
    return this.m.FPDFTextObj_GetFont(obj);
  }

  fontSize(obj: number): number {
    return this.mem.withMem(4, (p) =>
      this.m.FPDFTextObj_GetFontSize(obj, p) ? this.mem.f32(p) : NaN,
    );
  }

  renderMode(obj: number): number {
    return this.m.FPDFTextObj_GetTextRenderMode(obj);
  }

  markedContentId(obj: number): number {
    return this.m.FPDFPageObj_GetMarkedContentID(obj);
  }

  fontFacts(font: number): FontFacts {
    const baseName = this.mem.readUtf8Result((buf, len) =>
      this.m.FPDFFont_GetBaseFontName(font, buf, len),
    );
    const familyName = this.mem.readUtf8Result((buf, len) =>
      this.m.FPDFFont_GetFamilyName(font, buf, len),
    );
    const dataBytes = this.mem.withMem(8, (p) =>
      this.m.FPDFFont_GetFontData(font, 0, 0, p) ? this.mem.u32(p) : 0,
    );
    const italicAngle = this.mem.withMem(4, (p) =>
      this.m.FPDFFont_GetItalicAngle(font, p) ? this.mem.i32(p) : 0,
    );
    return {
      baseName,
      familyName,
      embedded: this.m.FPDFFont_GetIsEmbedded(font) !== 0,
      flags: this.m.FPDFFont_GetFlags(font),
      weight: this.m.FPDFFont_GetWeight(font),
      italicAngle,
      dataBytes,
    };
  }

  /**
   * Advance of `ch` in `font` at `size`, text space units (the font's /W or /Widths for the
   * char code PDFium maps `ch` to). PDFium answers even for missing glyphs (a bogus width),
   * so pair it with `hasGlyphPath`.
   */
  glyphWidth(font: number, ch: string, size: number): number | undefined {
    const code = ch.codePointAt(0) ?? 0;
    return this.mem.withMem(4, (p) =>
      this.m.FPDFFont_GetGlyphWidth(font, code, size, p) ? this.mem.f32(p) : undefined,
    );
  }

  /** Whether PDFium has an outline for `ch` in `font` (null for missing glyphs). */
  hasGlyphPath(font: number, ch: string): boolean {
    const path = this.m.FPDFFont_GetGlyphPath(font, ch.codePointAt(0) ?? 0, 12);
    return path !== 0 && this.m.FPDFGlyphPath_CountGlyphSegments(path) > 0;
  }

  /** A new text object in `font` with explicit char codes (the font's own codes). */
  createCharcodes(docPtr: number, font: number, size: number, codes: readonly number[]): number {
    const obj = this.m.FPDFPageObj_CreateTextObj(docPtr, font, size);
    if (!obj) throw new Error('FPDFPageObj_CreateTextObj failed');
    if (!this.setCharcodes(obj, codes)) {
      this.m.FPDFPageObj_Destroy(obj);
      throw new Error('FPDFText_SetCharcodes failed');
    }
    return obj;
  }

  /**
   * Replaces a text object's codes (`FPDFText_SetCharcodes`). The object keeps its font,
   * matrix, colours and colour spaces, text state (Tc, Tw, Tz, Ts), clip and marks; TJ
   * kerning is dropped (the glyphs advance naturally from the object's origin).
   */
  setCharcodes(obj: number, codes: readonly number[]): boolean {
    return this.mem.withMem(Math.max(codes.length, 1) * 4, (p) => {
      this.mem.heap().HEAPU32.set(codes, p >> 2);
      return this.m.FPDFText_SetCharcodes(obj, p, codes.length);
    });
  }

  /** Whether the text page made the character up (a space for a gap), not a code. */
  isGenerated(textPage: number, index: number): boolean {
    return this.m.FPDFText_IsGenerated(textPage, index) === 1;
  }

  /** Whether the character's Unicode came from its code (the font maps it to nothing). */
  unicodeMapError(textPage: number, index: number): boolean {
    return this.m.FPDFText_HasUnicodeMapError(textPage, index) === 1;
  }

  /** Removes every marked-content mark of `obj`. */
  removeMarks(obj: number): void {
    for (let k = this.m.FPDFPageObj_CountMarks(obj) - 1; k >= 0; k--) {
      const mark = this.m.FPDFPageObj_GetMark(obj, k);
      if (mark) this.m.FPDFPageObj_RemoveMark(obj, mark);
    }
  }

  /** Transforms the object's clip path (when it has one) by `matrix`. */
  transformClipPath(obj: number, matrix: TextMatrix): void {
    if (!this.m.FPDFPageObj_GetClipPath(obj)) return;
    this.m.FPDFPageObj_TransformClipPath(
      obj,
      matrix[0],
      matrix[1],
      matrix[2],
      matrix[3],
      matrix[4],
      matrix[5],
    );
  }

  /**
   * The object rendered alone at `scale` (`FPDFTextObj_GetRenderedBitmap`), as its width,
   * height and bytes; undefined when nothing is drawn (a blank glyph).
   */
  renderedText(
    docPtr: number,
    pagePtr: number,
    obj: number,
    scale: number,
  ): { width: number; height: number; bytes: Uint8Array } | undefined {
    const bitmap = this.m.FPDFTextObj_GetRenderedBitmap(docPtr, pagePtr, obj, scale);
    if (!bitmap) return undefined;
    try {
      const width = this.m.FPDFBitmap_GetWidth(bitmap);
      const height = this.m.FPDFBitmap_GetHeight(bitmap);
      const stride = this.m.FPDFBitmap_GetStride(bitmap);
      const buffer = this.m.FPDFBitmap_GetBuffer(bitmap);
      return { width, height, bytes: this.mem.readBytes(buffer, stride * height) };
    } finally {
      this.m.FPDFBitmap_Destroy(bitmap);
    }
  }

  /**
   * Loads a TrueType program as a CIDFontType2 font (Identity-H) with the given ToUnicode
   * CMap and CIDToGIDMap. PDFium writes /W from the program. Returns 0 on failure.
   */
  loadCidType2Font(
    docPtr: number,
    program: Uint8Array,
    toUnicode: string,
    cidToGid: Uint8Array,
  ): number {
    const dataPtr = this.mem.copyIn(program);
    const mapPtr = this.mem.copyIn(cidToGid);
    try {
      return this.m.FPDFText_LoadCidType2Font(
        docPtr,
        dataPtr,
        program.length,
        toUnicode,
        mapPtr,
        cidToGid.length,
      );
    } finally {
      this.mem.free(dataPtr);
      this.mem.free(mapPtr);
    }
  }

  /** The page's visible box (CropBox ∩ MediaBox), unrotated user space. */
  pageBox(pagePtr: number): Rect {
    return this.mem.withMem(16, (p) => {
      if (!this.m.FPDF_GetPageBoundingBox(pagePtr, p)) {
        return { x: 0, y: 0, width: 612, height: 792 };
      }
      // FS_RECTF: left, top, right, bottom.
      const left = this.mem.f32(p);
      const top = this.mem.f32(p + 4);
      const right = this.mem.f32(p + 8);
      const bottom = this.mem.f32(p + 12);
      return {
        x: Math.min(left, right),
        y: Math.min(top, bottom),
        width: Math.abs(right - left),
        height: Math.abs(top - bottom),
      };
    });
  }
}
