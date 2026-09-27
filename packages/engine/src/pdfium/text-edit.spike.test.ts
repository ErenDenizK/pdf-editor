/**
 * SPIKE — M4 text editing (docs/research/05-text-editing-spike.md). Evidence for the
 * implementer, not product code and not a regression suite: it pokes at EmbedPDF 2.15.1
 * internals (PdfiumNative's private page cache) and raw PDFium edit calls to answer the
 * questions in that report. Numbers it measures are printed as `[spike] …` lines. Set
 * VITE_TEXT_EDIT_SPIKE_PNG=1 to also print before/after renders as base64 PNG lines.
 * Delete or replace it once `PdfTextEditor` exists.
 */
import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFRef,
} from '@cantoo/pdf-lib';
import fontkit, { type Font } from '@cantoo/fontkit';
import { browserImageDataToBlobConverter, PdfEngine, PdfiumNative } from '@embedpdf/engines';
import type { PdfDocumentObject, PdfPageObject } from '@embedpdf/models';
import { init, type WrappedPdfiumModule } from '@embedpdf/pdfium';
import type { Rect } from '@pdf-editor/document-model';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import rotatedUrl from '../../../../test/fixtures/rotated-pages.pdf?url';
import manyPagesUrl from '../../../../test/fixtures/many-pages.pdf?url';
import simpleTextUrl from '../../../../test/fixtures/simple-text.pdf?url';
import taggedUrl from '../../../../test/fixtures/tagged.pdf?url';
import { sid, toBuffer, wasmUrl } from '../../test/helpers';
import { BUNDLED_FACES } from '../fonts/font-catalog';
import { loadBundledFont } from '../fonts/bundled-fonts';
import { pageGeometry, userToDeviceRect } from './coords';
import { PdfiumAdapter } from './pdfium-adapter';

// ---------------------------------------------------------------------------
// Hosting: raw module + EmbedPDF executor + orchestrator, all on this thread.
// ---------------------------------------------------------------------------

type Pdfium = WrappedPdfiumModule;

interface Heap {
  readonly HEAPU8: Uint8Array;
  readonly HEAPF32: Float32Array;
  readonly HEAPF64: Float64Array;
  readonly HEAPU32: Uint32Array;
}

/** What the spike relies on in EmbedPDF 2.15.1's private `PdfiumNative.cache`. */
interface PageCtx {
  readonly pagePtr: number;
  getTextPage(): number;
  release(): void;
  disposeImmediate(): void;
}
interface DocCtx {
  readonly docPtr: number;
  acquirePage(pageIndex: number): PageCtx;
}

let pdfium: Pdfium;
let native: PdfiumNative;
let engine: PdfEngine;
let adapter: PdfiumAdapter;
let interBytes: Uint8Array;
let docCounter = 0;

const FPDF_PAGEOBJ_FORM = 5;
const FPDF_FONT_TRUETYPE = 2;
const FIXTURE_BYTES = new Map<string, ArrayBuffer>();

function log(label: string, value: unknown): void {
  // eslint-disable-next-line no-console -- spike measurements are the point of this file
  console.info(`[spike] ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
}

async function fixture(url: string): Promise<ArrayBuffer> {
  let bytes = FIXTURE_BYTES.get(url);
  if (!bytes) {
    bytes = await (await fetch(url)).arrayBuffer();
    FIXTURE_BYTES.set(url, bytes);
  }
  return bytes.slice(0);
}

/** The private-access assumption, asserted: fails loudly if EmbedPDF's layout changes. */
function docContext(doc: PdfDocumentObject): DocCtx {
  const cache = (native as unknown as { cache?: { getContext?: unknown } }).cache;
  if (typeof cache?.getContext !== 'function') {
    throw new Error('EmbedPDF layout changed: PdfiumNative.cache.getContext is gone');
  }
  const ctx = (cache.getContext as (id: string) => Partial<DocCtx> | undefined).call(cache, doc.id);
  if (!ctx || typeof ctx.docPtr !== 'number' || typeof ctx.acquirePage !== 'function') {
    throw new Error('EmbedPDF layout changed: DocumentContext has no docPtr/acquirePage');
  }
  return ctx as DocCtx;
}

function heap(): Heap {
  return pdfium.pdfium as unknown as Heap;
}
function malloc(size: number): number {
  const ptr = pdfium.pdfium.wasmExports.malloc(Math.max(size, 8));
  if (!ptr) throw new Error('malloc failed');
  heap().HEAPU8.fill(0, ptr, ptr + Math.max(size, 8));
  return ptr;
}
function free(ptr: number): void {
  pdfium.pdfium.wasmExports.free(ptr);
}
function withMem<T>(size: number, fn: (ptr: number) => T): T {
  const ptr = malloc(size);
  try {
    return fn(ptr);
  } finally {
    free(ptr);
  }
}
function f32(ptr: number): number {
  return heap().HEAPF32[ptr >> 2] as number;
}
function f64(ptr: number): number {
  return heap().HEAPF64[ptr >> 3] as number;
}
/** NUL-terminated UTF-16LE (FPDF_WIDESTRING). Caller frees. */
function wideString(text: string): number {
  const ptr = malloc((text.length + 1) * 2);
  const h = heap().HEAPU8;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    h[ptr + 2 * i] = unit & 0xff;
    h[ptr + 2 * i + 1] = unit >> 8;
  }
  return ptr;
}
function readUtf16(ptr: number, bytes: number): string {
  const h = heap().HEAPU8;
  let out = '';
  for (let i = 0; i + 1 < bytes; i += 2) {
    const unit = (h[ptr + i] as number) | ((h[ptr + i + 1] as number) << 8);
    if (unit === 0) break;
    out += String.fromCharCode(unit);
  }
  return out;
}
function copyIn(bytes: Uint8Array): number {
  const ptr = malloc(bytes.length);
  heap().HEAPU8.set(bytes, ptr);
  return ptr;
}

// --- PDFium helpers (calling conventions copied from EmbedPDF's engine.js) ---

function textObjText(obj: number, textPage: number): string {
  const bytes = pdfium.FPDFTextObj_GetText(obj, textPage, 0, 0);
  if (bytes <= 2) return '';
  return withMem(bytes, (buf) => {
    pdfium.FPDFTextObj_GetText(obj, textPage, buf, bytes);
    return readUtf16(buf, bytes);
  });
}

function pageChars(textPage: number): string {
  const n = pdfium.FPDFText_CountChars(textPage);
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(pdfium.FPDFText_GetUnicode(textPage, i));
  return s;
}

interface FontFacts {
  readonly baseName: string;
  readonly embedded: boolean;
  readonly flags: number;
  readonly fontDataBytes: number;
}
function fontFacts(font: number): FontFacts {
  const len = pdfium.FPDFFont_GetBaseFontName(font, 0, 0);
  const baseName =
    len > 0
      ? withMem(len + 1, (buf) => {
          pdfium.FPDFFont_GetBaseFontName(font, buf, len + 1);
          // UTF-8, NUL-terminated (`len` includes the NUL).
          return new TextDecoder().decode(heap().HEAPU8.slice(buf, buf + len - 1));
        })
      : '';
  const fontDataBytes = withMem(8, (outLen) =>
    pdfium.FPDFFont_GetFontData(font, 0, 0, outLen) ? heap().HEAPU32[outLen >> 2]! : -1,
  );
  return {
    baseName,
    embedded: pdfium.FPDFFont_GetIsEmbedded(font) !== 0,
    flags: pdfium.FPDFFont_GetFlags(font),
    fontDataBytes,
  };
}

/** Width in text space units for `size`; `undefined` when PDFium reports failure. */
function glyphWidth(font: number, ch: string, size: number): number | undefined {
  return withMem(4, (out) =>
    pdfium.FPDFFont_GetGlyphWidth(font, ch.codePointAt(0)!, size, out) ? f32(out) : undefined,
  );
}

/** Segment count of the glyph outline PDFium would draw for `ch` (-1: no path). */
function glyphSegments(font: number, ch: string, size: number): number {
  const path = pdfium.FPDFFont_GetGlyphPath(font, ch.codePointAt(0)!, size);
  return path ? pdfium.FPDFGlyphPath_CountGlyphSegments(path) : -1;
}

function charOrigin(textPage: number, index: number): { x: number; y: number } {
  return withMem(16, (p) => {
    pdfium.FPDFText_GetCharOrigin(textPage, index, p, p + 8);
    return { x: f64(p), y: f64(p + 8) };
  });
}

function charBox(textPage: number, index: number): Rect {
  return withMem(32, (p) => {
    pdfium.FPDFText_GetCharBox(textPage, index, p, p + 8, p + 16, p + 24);
    const [left, right, bottom, top] = [f64(p), f64(p + 8), f64(p + 16), f64(p + 24)];
    return { x: left, y: bottom, width: right - left, height: top - bottom };
  });
}

type Matrix = [number, number, number, number, number, number];
function objMatrix(obj: number): Matrix {
  return withMem(24, (p) => {
    if (!pdfium.FPDFPageObj_GetMatrix(obj, p)) throw new Error('GetMatrix failed');
    return [0, 1, 2, 3, 4, 5].map((i) => f32(p + 4 * i)) as Matrix;
  });
}
function setMatrix(obj: number, m: Matrix): void {
  withMem(24, (p) => {
    heap().HEAPF32.set(m, p >> 2);
    if (!pdfium.FPDFPageObj_SetMatrix(obj, p)) throw new Error('SetMatrix failed');
  });
}
function fontSize(obj: number): number {
  return withMem(4, (p) => (pdfium.FPDFTextObj_GetFontSize(obj, p) ? f32(p) : NaN));
}
function fillColor(obj: number): [number, number, number, number] {
  return withMem(16, (p) => {
    pdfium.FPDFPageObj_GetFillColor(obj, p, p + 4, p + 8, p + 12);
    const u = heap().HEAPU32;
    return [u[p >> 2]!, u[(p >> 2) + 1]!, u[(p >> 2) + 2]!, u[(p >> 2) + 3]!];
  });
}
function setText(obj: number, text: string): boolean {
  const ptr = wideString(text);
  try {
    return pdfium.FPDFText_SetText(obj, ptr);
  } finally {
    free(ptr);
  }
}
function setCharcodes(obj: number, codes: readonly number[]): boolean {
  return withMem(codes.length * 4, (p) => {
    heap().HEAPU32.set(codes, p >> 2);
    return pdfium.FPDFText_SetCharcodes(obj, p, codes.length);
  });
}
function objIndex(pagePtr: number, obj: number): number {
  const n = pdfium.FPDFPage_CountObjects(pagePtr);
  for (let i = 0; i < n; i++) if (pdfium.FPDFPage_GetObject(pagePtr, i) === obj) return i;
  return -1;
}

// --- Engine-level helpers ---

async function openDoc(bytes: ArrayBuffer): Promise<PdfDocumentObject> {
  return engine.openDocumentBuffer({ id: `spike-${++docCounter}`, content: bytes }).toPromise();
}
async function closeDoc(doc: PdfDocumentObject): Promise<void> {
  await engine.closeDocument(doc).toPromise();
}
async function saveDoc(doc: PdfDocumentObject): Promise<ArrayBuffer> {
  return engine.saveAsCopy(doc).toPromise();
}
async function renderRgba(
  doc: PdfDocumentObject,
  page: PdfPageObject,
  scale = 2,
): Promise<{ data: Uint8ClampedArray; width: number; height: number }> {
  const raw = await engine
    .renderPageRaw(doc, page, { scaleFactor: scale, withAnnotations: false })
    .toPromise();
  return { data: new Uint8ClampedArray(raw.data), width: raw.width, height: raw.height };
}

/** Pixels that differ (any channel > 8) outside `exclude` (device px, top-left origin). */
function diffOutside(
  a: { data: Uint8ClampedArray; width: number; height: number },
  b: { data: Uint8ClampedArray; width: number; height: number },
  exclude: readonly { x0: number; y0: number; x1: number; y1: number }[],
): { outside: number; inside: number } {
  expect([a.width, a.height]).toEqual([b.width, b.height]);
  let outside = 0;
  let inside = 0;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const k = (y * a.width + x) * 4;
      const differs =
        Math.abs(a.data[k]! - b.data[k]!) > 8 ||
        Math.abs(a.data[k + 1]! - b.data[k + 1]!) > 8 ||
        Math.abs(a.data[k + 2]! - b.data[k + 2]!) > 8;
      if (!differs) continue;
      const excluded = exclude.some((r) => x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1);
      if (excluded) inside++;
      else outside++;
    }
  }
  return { outside, inside };
}

/** Device-pixel box (render at `scale`, rotation applied) around a user-space rect. */
function deviceBox(page: PdfPageObject, r: Rect, scale = 2, pad = 2) {
  const d = userToDeviceRect(pageGeometry(page), r);
  return {
    x0: Math.floor(d.origin.x * scale) - pad,
    y0: Math.floor(d.origin.y * scale) - pad,
    x1: Math.ceil((d.origin.x + d.size.width) * scale) + pad,
    y1: Math.ceil((d.origin.y + d.size.height) * scale) + pad,
  };
}

async function emitPng(
  name: string,
  img: { data: Uint8ClampedArray; width: number; height: number },
): Promise<void> {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  if (!env?.VITE_TEXT_EDIT_SPIKE_PNG) return;
  const canvas = new OffscreenCanvas(img.width, img.height);
  const context = canvas.getContext('2d')!;
  context.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  // eslint-disable-next-line no-console -- PNG evidence, extracted from the log by the spike run
  console.info(`[spike-png] ${name} ${btoa(bin)}`);
}

// --- pdf-lib helpers ---

function streamText(stream: unknown): string {
  if (!(stream instanceof PDFRawStream)) return '';
  const bytes = decodePDFRawStream(stream).decode();
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return s;
}

/** Inflated page content plus every Form XObject stream reachable from its resources. */
async function inflatedContent(
  bytes: ArrayBuffer,
  pageIndex: number,
): Promise<{ page: string; streams: number; forms: string[]; fileBytes: number }> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const page = doc.getPage(pageIndex);
  const contents = page.node.get(PDFName.of('Contents'));
  const parts: string[] = [];
  const resolved = contents instanceof PDFRef ? doc.context.lookup(contents) : contents;
  if (resolved instanceof PDFArray) {
    for (let i = 0; i < resolved.size(); i++) parts.push(streamText(resolved.lookup(i)));
  } else {
    parts.push(streamText(resolved));
  }
  const forms: string[] = [];
  const xobjects = page.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict);
  for (const [, ref] of xobjects?.entries() ?? []) {
    const obj = doc.context.lookup(ref);
    if (obj instanceof PDFRawStream && obj.dict.get(PDFName.of('Subtype')) === PDFName.of('Form')) {
      forms.push(streamText(obj));
    }
  }
  return { page: parts.join('\n'), streams: parts.length, forms, fileBytes: bytes.byteLength };
}

/** Both encodings of a WinAnsi string as they can appear in a content stream. */
function encodings(text: string): string[] {
  const hex = Array.from(text)
    .map((c) => c.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('');
  return [`(${text}`, hex.toUpperCase(), hex.toLowerCase()];
}

/** Finds `word` on the page: char indices, the text object, its font. */
function locate(textPage: number, word: string, occurrence = 0) {
  const chars = pageChars(textPage);
  let start = -1;
  for (let k = 0; k <= occurrence; k++) start = chars.indexOf(word, start + 1);
  if (start < 0) throw new Error(`"${word}" not found in "${chars}"`);
  const obj = pdfium.FPDFText_GetTextObject(textPage, start);
  const objChars: number[] = [];
  for (let i = 0; i < chars.length; i++) {
    if (pdfium.FPDFText_GetTextObject(textPage, i) === obj) objChars.push(i);
  }
  return { chars, start, end: start + word.length, obj, objChars };
}

// ---------------------------------------------------------------------------

beforeAll(async () => {
  const started = performance.now();
  const wasmBinary = await (await fetch(wasmUrl)).arrayBuffer();
  pdfium = await init({ wasmBinary });
  native = new PdfiumNative(pdfium, { fontFallback: null });
  engine = new PdfEngine(native, { imageConverter: browserImageDataToBlobConverter });
  adapter = new PdfiumAdapter({ wasmUrl, engineFactory: () => engine });
  interBytes = await loadBundledFont(BUNDLED_FACES.find((f) => f.key === 'Inter-Regular')!);
  log('host init ms (fetch wasm + init + PdfiumNative)', Math.round(performance.now() - started));
});

afterAll(async () => {
  await adapter.destroy();
});

async function interPdf(
  lines: readonly { text: string; x: number; y: number; size: number }[],
  size: [number, number] = [400, 200],
): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(interBytes, { subset: true });
  const page = doc.addPage(size);
  for (const l of lines) page.drawText(l.text, { x: l.x, y: l.y, size: l.size, font });
  return toBuffer(await doc.save());
}

interface InPlaceFacts {
  objectText: string;
  font: FontFacts;
  newChars: [string, number | undefined, number][];
  setTextOk: boolean;
  staleReadback: string;
  freshReadback: string;
  generateMs: number;
  reextracted: string;
  advances: { ch: string; measured: number; metric: number | undefined }[];
  contentBefore: string;
  contentAfter: string;
  pixelsOutside: number;
  pixelsInside: number;
  saved: ArrayBuffer;
}

/** Tier 2: SetText on the object holding `word`, GenerateContent, save, re-read. */
async function inPlaceEdit(
  bytes: ArrayBuffer,
  pageIndex: number,
  word: string,
  replacement: string,
  png?: string,
): Promise<InPlaceFacts> {
  const doc = await openDoc(bytes.slice(0));
  const page = doc.pages[pageIndex]!;
  const before = await renderRgba(doc, page);
  const pageCtx = docContext(doc).acquirePage(pageIndex);
  const tp = pageCtx.getTextPage();
  const hit = locate(tp, word);
  const objectText = textObjText(hit.obj, tp);
  const font = pdfium.FPDFTextObj_GetFont(hit.obj);
  const size = fontSize(hit.obj);
  const facts = fontFacts(font);
  const lineBox = unionOf(hit.objChars.map((i) => charBox(tp, i)));
  const newText = objectText.replace(word, replacement);
  const newChars = Array.from(new Set(replacement)).map(
    (c) =>
      [c, glyphWidth(font, c, size), glyphSegments(font, c, size)] as [
        string,
        number | undefined,
        number,
      ],
  );
  const setTextOk = setText(hit.obj, newText);
  const staleReadback = textObjText(hit.obj, tp);
  const fresh = pdfium.FPDFText_LoadPage(pageCtx.pagePtr);
  const freshObj = pdfium.FPDFText_GetTextObject(fresh, hit.objChars[0]!);
  const freshReadback = textObjText(freshObj, fresh);
  pdfium.FPDFText_ClosePage(fresh);
  const t0 = performance.now();
  expect(pdfium.FPDFPage_GenerateContent(pageCtx.pagePtr)).toBe(true);
  const generateMs = performance.now() - t0;
  pageCtx.disposeImmediate();
  const after = await renderRgba(doc, page);
  const saved = await saveDoc(doc);
  await closeDoc(doc);
  if (png) {
    await emitPng(`${png}-before`, before);
    await emitPng(`${png}-after`, after);
  }
  // SetText re-flows the whole object, so everything right of the line start may move.
  const pageRight = unrotatedWidth(page);
  const diff = diffOutside(before, after, [
    deviceBox(page, { ...lineBox, width: pageRight - lineBox.x }),
  ]);
  // Re-open the saved bytes: extraction and advances (origin deltas vs font metrics).
  const re = await openDoc(saved.slice(0));
  const rctx = docContext(re).acquirePage(pageIndex);
  const rtp = rctx.getTextPage();
  const rhit = locate(rtp, newText.slice(0, 3));
  const reextracted = textObjText(rhit.obj, rtp);
  const rfont = pdfium.FPDFTextObj_GetFont(rhit.obj);
  const advances: InPlaceFacts['advances'] = [];
  const wordAt = reextracted.indexOf(replacement);
  for (let k = 0; k < replacement.length - 1 && wordAt >= 0; k++) {
    const i = rhit.objChars[wordAt + k]!;
    advances.push({
      ch: replacement[k]!,
      measured: charOrigin(rtp, i + 1).x - charOrigin(rtp, i).x,
      metric: glyphWidth(rfont, replacement[k]!, size),
    });
  }
  rctx.release();
  await closeDoc(re);
  const b = await inflatedContent(bytes, pageIndex);
  const a = await inflatedContent(saved, pageIndex);
  return {
    objectText,
    font: facts,
    newChars,
    setTextOk,
    staleReadback,
    freshReadback,
    generateMs,
    reextracted,
    advances,
    contentBefore: b.page,
    contentAfter: a.page,
    pixelsOutside: diff.outside,
    pixelsInside: diff.inside,
    saved,
  };
}

/** Row-vector affine product: apply `a`, then `b`. */
function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from }, (_, k) => from + k);
}
function unionOf(rects: readonly Rect[]): Rect {
  const x0 = Math.min(...rects.map((r) => r.x));
  const y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.width));
  const y1 = Math.max(...rects.map((r) => r.y + r.height));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
function unrotatedWidth(page: PdfPageObject): number {
  return page.rotation % 2 === 1 ? page.size.height : page.size.width;
}

/** A one-page PDF with raw content; F1 = Helvetica (WinAnsi), T3 = a Type3 font, forms. */
async function rawPdf(options: {
  content: string;
  forms?: Record<string, string>;
  size?: [number, number];
}): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const page = doc.addPage(options.size ?? [400, 200]);
  const helvetica = ctx.register(
    ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' }),
  );
  const proc = ctx.register(ctx.stream('750 0 0 0 750 750 d1\n0 0 750 750 re f'));
  const type3 = ctx.register(
    ctx.obj({
      Type: 'Font',
      Subtype: 'Type3',
      FontBBox: [0, 0, 750, 750],
      FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
      CharProcs: { a: proc },
      Encoding: { Type: 'Encoding', Differences: [97, PDFName.of('a')] },
      FirstChar: 97,
      LastChar: 97,
      Widths: [750],
      Resources: {},
    }),
  );
  const fonts = { F1: helvetica, T3: type3 };
  const xobjects: Record<string, PDFRef> = {};
  for (const [name, content] of Object.entries(options.forms ?? {})) {
    xobjects[name] = ctx.register(
      ctx.stream(content, {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 0, 400, 200],
        Resources: { Font: fonts },
      }),
    );
  }
  page.node.set(PDFName.of('Resources'), ctx.obj({ Font: fonts, XObject: xobjects }));
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.stream(options.content)));
  return toBuffer(await doc.save());
}

function originsOf(textPage: number, indices: readonly number[]): { x: number; y: number }[] {
  return indices.map((i) => charOrigin(textPage, i));
}

/** Reads the text and char origins of every text object on page `pageIndex` of `bytes`. */
async function readBack(bytes: ArrayBuffer, pageIndex = 0) {
  const doc = await openDoc(bytes.slice(0));
  const pc = docContext(doc).acquirePage(pageIndex);
  const tp = pc.getTextPage();
  const text = pageChars(tp);
  const origins = originsOf(tp, range(0, text.length));
  const boxes = range(0, text.length).map((i) => charBox(tp, i));
  pc.release();
  await closeDoc(doc);
  return { text, origins, boxes };
}

/** Subset of `face` covering `text`, loaded with FPDFText_LoadCidType2Font. */
function loadSubsetFont(docPtr: number, face: Uint8Array, text: string) {
  const fk = fontkit.create(face) as Font;
  const subset = fk.createSubset();
  const codes = Array.from(text).map((c) => {
    const glyph = fk.glyphForCodePoint(c.codePointAt(0)!);
    if (!glyph || glyph.id === 0) throw new Error(`face lacks ${c}`);
    return subset.includeGlyph(glyph);
  });
  const data = subset.encode();
  const maxCid = Math.max(...codes);
  const map = new Uint8Array((maxCid + 1) * 2);
  for (let cid = 0; cid <= maxCid; cid++) {
    map[2 * cid] = cid >> 8;
    map[2 * cid + 1] = cid & 0xff;
  }
  const unique = new Map<number, string>();
  Array.from(text).forEach((c, k) => unique.set(codes[k]!, c));
  const toUnicode = cmapFor([...unique.keys()], [...unique.values()]);
  const dataPtr = copyIn(data);
  const mapPtr = copyIn(map);
  const font = pdfium.FPDFText_LoadCidType2Font(
    docPtr,
    dataPtr,
    data.length,
    toUnicode,
    mapPtr,
    map.length,
  );
  free(dataPtr);
  free(mapPtr);
  const advance = (c: string, size: number) =>
    (fk.glyphForCodePoint(c.codePointAt(0)!)!.advanceWidth * size) / fk.unitsPerEm;
  return { font, codes, subsetBytes: data.length, advance };
}

/**
 * Tier 1 by splitting: the object holding `word` is replaced by runs of its own chars (same
 * FPDF_FONT, re-encoded with SetText, one object per run of naturally advancing glyphs so
 * TJ kerning survives), with the replacement in a bundled-font subset in between.
 */
async function splitReplace(
  bytes: ArrayBuffer,
  pageIndex: number,
  word: string,
  replacement: string,
  png?: string,
  replacementFont: 'bundled' | 'original' = 'bundled',
) {
  const doc = await openDoc(bytes.slice(0));
  const page = doc.pages[pageIndex]!;
  const before = await renderRgba(doc, page);
  const docPtr = docContext(doc).docPtr;
  const pc = docContext(doc).acquirePage(pageIndex);
  const tp = pc.getTextPage();
  const hit = locate(tp, word);
  const obj = hit.obj;
  // Parent: the page, or a (first-level) Form XObject.
  const top = range(0, pdfium.FPDFPage_CountObjects(pc.pagePtr)).map((k) =>
    pdfium.FPDFPage_GetObject(pc.pagePtr, k),
  );
  const form = top.find(
    (o) =>
      pdfium.FPDFPageObj_GetType(o) === FPDF_PAGEOBJ_FORM &&
      range(0, pdfium.FPDFFormObj_CountObjects(o)).some(
        (k) => pdfium.FPDFFormObj_GetObject(o, k) === obj,
      ),
  );
  const font = pdfium.FPDFTextObj_GetFont(obj);
  const size = fontSize(obj);
  // Linear part in page space (object matrix, then the form's matrix).
  const m = form ? multiply(objMatrix(obj), objMatrix(form)) : objMatrix(obj);
  const color = fillColor(obj);
  const mode = pdfium.FPDFTextObj_GetTextRenderMode(obj);
  const mcid = pdfium.FPDFPageObj_GetMarkedContentID(obj);
  const lineBox = unionOf(hit.objChars.map((i) => charBox(tp, i)).filter((r) => r.width > 0));
  const wordOrigin = charOrigin(tp, hit.start);
  const wordRight = charBox(tp, hit.end - 1);
  const nextOrigin = hit.end < hit.chars.length ? charOrigin(tp, hit.end) : undefined;
  // Runs: consecutive chars whose origin follows the previous char's advance vector.
  interface Run {
    text: string;
    origin: { x: number; y: number };
  }
  const runsOf = (indices: number[]): Run[] => {
    const runs: Run[] = [];
    let prev: { x: number; y: number; w: number } | undefined;
    for (const i of indices) {
      const ch = hit.chars[i]!;
      const o = charOrigin(tp, i);
      const w = glyphWidth(font, ch, 1) ?? 0;
      const continues =
        prev !== undefined &&
        Math.hypot(prev.x + prev.w * size * m[0] - o.x, prev.y + prev.w * size * m[1] - o.y) < 0.01;
      if (continues) runs[runs.length - 1]!.text += ch;
      else runs.push({ text: ch, origin: o });
      prev = { x: o.x, y: o.y, w };
    }
    return runs;
  };
  const prefix = runsOf(hit.objChars.filter((i) => i < hit.start));
  const suffix = runsOf(hit.objChars.filter((i) => i >= hit.end));
  const place = (o: number, origin: { x: number; y: number }) => {
    setMatrix(o, [m[0], m[1], m[2], m[3], origin.x, origin.y]);
    pdfium.FPDFPageObj_SetFillColor(o, color[0], color[1], color[2], color[3]);
    pdfium.FPDFTextObj_SetTextRenderMode(o, mode);
    if (mcid >= 0) {
      const mark = pdfium.FPDFPageObj_AddMark(o, 'P');
      pdfium.FPDFPageObjMark_SetIntParam(docPtr, o, mark, 'MCID', mcid);
    }
  };
  // New objects go to page level, where the original was (or right after its form).
  let at = form ? objIndex(pc.pagePtr, form) + 1 : objIndex(pc.pagePtr, obj);
  const roundTrip: string[] = [];
  const insertRun = (run: Run) => {
    const o = pdfium.FPDFPageObj_CreateTextObj(docPtr, font, size);
    setText(o, run.text);
    place(o, run.origin);
    pdfium.FPDFPage_InsertObjectAtIndex(pc.pagePtr, o, at++);
    roundTrip.push(run.text);
  };
  prefix.forEach(insertRun);
  // Replacement: the original font (tier 2) or a bundled subset (tier 1), shrunk to fit
  // the gap up to the next glyph.
  const sub =
    replacementFont === 'bundled' ? loadSubsetFont(docPtr, interBytes, replacement) : undefined;
  const natural = Array.from(replacement).reduce(
    (w, c) => w + (sub ? sub.advance(c, size) : (glyphWidth(font, c, size) ?? 0)),
    0,
  );
  const room = (nextOrigin?.x ?? wordRight.x + wordRight.width) - wordOrigin.x;
  const newSize = natural * m[0] > room ? (size * room) / (natural * m[0]) : size;
  const repl = pdfium.FPDFPageObj_CreateTextObj(docPtr, sub ? sub.font : font, newSize);
  const charcodesOk = sub ? setCharcodes(repl, sub.codes) : setText(repl, replacement);
  place(repl, wordOrigin);
  pdfium.FPDFPage_InsertObjectAtIndex(pc.pagePtr, repl, at++);
  suffix.forEach(insertRun);
  const removed = form
    ? pdfium.FPDFFormObj_RemoveObject(form, obj)
    : pdfium.FPDFPage_RemoveObject(pc.pagePtr, obj);
  expect(removed).toBe(true);
  // Verify before committing: a fresh text page must read the intended line.
  const fresh = pdfium.FPDFText_LoadPage(pc.pagePtr);
  const freshText = pageChars(fresh);
  pdfium.FPDFText_ClosePage(fresh);
  const t0 = performance.now();
  expect(pdfium.FPDFPage_GenerateContent(pc.pagePtr)).toBe(true);
  const generateMs = performance.now() - t0;
  pc.disposeImmediate();
  pdfium.FPDFPageObj_Destroy(obj);
  if (sub) pdfium.FPDFFont_Close(sub.font);
  const after = await renderRgba(doc, page);
  const saved = await saveDoc(doc);
  await closeDoc(doc);
  if (png) {
    await emitPng(`tier1-${png}-before`, before);
    await emitPng(`tier1-${png}-after`, after);
  }
  const diff = diffOutside(before, after, [deviceBox(page, lineBox)]);
  const rb = await readBack(saved, pageIndex);
  const expectedLine = hit.objChars
    .map((i) => hit.chars[i])
    .join('')
    .replace(word, replacement);
  // Positions of surviving chars (non-space), before vs after.
  const beforeRb = await readBack(bytes, pageIndex);
  const surviving = hit.objChars.filter(
    (i) => (i < hit.start || i >= hit.end) && hit.chars[i] !== ' ',
  );
  const afterStart = rb.text.indexOf(expectedLine);
  const mapIndex = (i: number) =>
    afterStart +
    (i < hit.start
      ? i - hit.objChars[0]!
      : i - hit.objChars[0]! - word.length + replacement.length);
  const drift =
    afterStart < 0
      ? NaN
      : Math.max(
          ...surviving.map((i) => {
            const a = beforeRb.origins[i]!;
            const b = rb.origins[mapIndex(i)]!;
            return Math.hypot(a.x - b.x, a.y - b.y);
          }),
        );
  const newBoxes =
    afterStart < 0
      ? []
      : range(0, replacement.length).map(
          (k) => rb.boxes[afterStart + hit.start - hit.objChars[0]! + k]!,
        );
  const inside =
    afterStart >= 0 &&
    newBoxes.every(
      (r) =>
        r.x >= lineBox.x - 0.5 &&
        r.x + r.width <= lineBox.x + lineBox.width + 0.5 &&
        r.y >= lineBox.y - 1 &&
        r.y + r.height <= lineBox.y + lineBox.height + 1,
    );
  const content = await inflatedContent(saved, pageIndex);
  const oldEncodings = encodings(word);
  return {
    runs: { prefix: prefix.length, suffix: suffix.length },
    roundTrip,
    charcodesOk,
    subsetBytes: sub?.subsetBytes,
    inForm: form !== undefined,
    newSize,
    freshText,
    reextracted: rb.text,
    lineInOrder: afterStart >= 0,
    drift,
    newBoxesInsideLine: inside,
    oldWordInContent: oldEncodings.some((e) => content.page.includes(e)),
    pixelsOutsideLine: diff.outside,
    generateMs,
    bytes: { before: bytes.byteLength, after: saved.byteLength },
    mcidMarks: content.page.match(/MCID \d+/g),
    content: content.page,
    fonts: await fontDictSummary(saved),
    saved,
  };
}

function cmapFor(cids: readonly number[], chars: readonly string[]): string {
  const hex = (n: number, w: number) => n.toString(16).toUpperCase().padStart(w, '0');
  const lines = cids.map((cid, k) => `<${hex(cid, 4)}> <${hex(chars[k]!.charCodeAt(0), 4)}>`);
  return [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
    `${lines.length} beginbfchar`,
    ...lines,
    'endbfchar',
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
  ].join('\n');
}

async function fontDictSummary(bytes: ArrayBuffer) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const out: Record<string, unknown>[] = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict)) continue;
    if (obj.get(PDFName.of('Type')) !== PDFName.of('Font')) continue;
    const summary: Record<string, unknown> = {};
    for (const key of ['Subtype', 'BaseFont', 'Encoding', 'CIDToGIDMap', 'W', 'DW']) {
      const v = obj.get(PDFName.of(key));
      summary[key] = v === undefined ? undefined : v.toString().slice(0, 80);
    }
    const desc = obj.lookupMaybe(PDFName.of('FontDescriptor'), PDFDict);
    const file = desc?.get(PDFName.of('FontFile2'));
    if (file) {
      const stream = doc.context.lookup(file);
      if (stream instanceof PDFRawStream) {
        summary.FontFile2 = {
          raw: stream.contents.length,
          filter: stream.dict.get(PDFName.of('Filter'))?.toString(),
        };
      }
    }
    out.push(summary);
  }
  return out;
}

const KERNED =
  'BT /F1 12 Tf 20 100 Td [(The quick br) 30 (own f) -40 (ox jum) 25 (ps over.)] TJ ET';

/** Max origin drift of the non-space chars of `tail`, located in both texts. */
function tailDrift(
  before: Awaited<ReturnType<typeof readBack>>,
  after: Awaited<ReturnType<typeof readBack>>,
  tail: string,
): number {
  const b = before.text.indexOf(tail);
  const a = after.text.lastIndexOf(tail);
  expect(b).toBeGreaterThanOrEqual(0);
  expect(a).toBeGreaterThanOrEqual(0);
  let drift = 0;
  for (let k = 0; k < tail.length; k++) {
    if (tail[k] === ' ') continue;
    const p = before.origins[b + k]!;
    const q = after.origins[a + k]!;
    drift = Math.max(drift, Math.hypot(p.x - q.x, p.y - q.y));
  }
  return drift;
}

async function redact(bytes: ArrayBuffer, word: string): Promise<ArrayBuffer> {
  const before = await readBack(bytes);
  const start = before.text.indexOf(word);
  const box = unionOf(range(start, start + word.length).map((i) => before.boxes[i]!));
  // Inset so the neighbouring spaces are not touched.
  const inset = { x: box.x + 0.5, y: box.y + 0.5, width: box.width - 1, height: box.height - 1 };
  const doc = await openDoc(bytes.slice(0));
  const page = doc.pages[0]!;
  const changed = await engine
    .redactTextInRects(doc, page, [userToDeviceRect(pageGeometry(page), inset)], {
      recurseForms: true,
      drawBlackBoxes: false,
    })
    .toPromise();
  expect(changed).toBe(true);
  const saved = await saveDoc(doc);
  await closeDoc(doc);
  return saved;
}

// ---------------------------------------------------------------------------

describe('Q1 hosting', () => {
  test('the orchestrated direct engine serves the adapter; docPtr/pagePtr are reachable', async () => {
    // PdfiumNative is EmbedPDF's *executor* (IPdfiumExecutor), not a PdfEngine: it must be
    // wrapped in the PdfEngine orchestrator, exactly as createPdfiumDirectEngine does.
    const bytes = await fixture(simpleTextUrl);
    const opened = await adapter.open(sid('q1'), bytes);
    expect(opened.pageCount).toBe(3);
    const runs = await adapter.getPageText(sid('q1'), 0);
    expect(runs[0]?.text).toBe('PAGE 1 OF simple-text');
    const render = await adapter.renderPage(sid('q1'), 0, { scale: 0.5 });
    expect(render.width).toBe(306);
    const annotation = await adapter.createAnnotation(sid('q1'), {
      kind: 'highlight',
      pageIndex: 0,
      rect: runs[0]!.rect,
      quads: [runs[0]!.rect],
      color: '#FFEB3B',
    });
    expect(annotation.id).toBeTruthy();
    expect((await adapter.save(sid('q1'))).byteLength).toBeGreaterThan(1000);

    // The adapter's SourceId is EmbedPDF's document id, so the private cache resolves it.
    const ctx = docContext({ id: 'q1' } as PdfDocumentObject);
    expect(ctx.docPtr).toBeGreaterThan(0);
    const pageCtx = ctx.acquirePage(0);
    try {
      expect(pageCtx.pagePtr).toBeGreaterThan(0);
      expect(pdfium.FPDF_GetPageCount(ctx.docPtr)).toBe(3);
      expect(pageChars(pageCtx.getTextPage()).startsWith('PAGE 1 OF simple-text')).toBe(true);
    } finally {
      pageCtx.release();
    }
    await adapter.close(sid('q1'));
  });
});

describe('Q2 tier 2: in-place FPDFText_SetText', () => {
  test('Helvetica (standard 14): round-trips, advances match metrics, nothing else moves', async () => {
    const r = await inPlaceEdit(await fixture(simpleTextUrl), 0, 'fox', 'cat', 'tier2-helvetica');
    expect(r.font).toMatchObject({ baseName: 'Helvetica', embedded: false });
    expect(r.setTextOk).toBe(true);
    // A text page loaded before the edit is stale; only a fresh one sees it.
    expect(r.staleReadback).toBe('The quick brown fox jumps over the lazy dog.');
    expect(r.freshReadback).toBe('The quick brown cat jumps over the lazy dog.');
    expect(r.reextracted).toBe(r.freshReadback);
    for (const a of r.advances) expect(a.measured).toBeCloseTo(a.metric!, 2);
    expect(r.pixelsOutside).toBe(0);
    expect(r.pixelsInside).toBeGreaterThan(0);
    // GenerateContent re-serialises the whole page, not just the edited object.
    expect(r.contentBefore).toContain('/Helvetica-');
    expect(r.contentAfter).not.toContain('/Helvetica-');
    expect(r.contentAfter).toContain('/FXE1 gs');
    expect(r.contentAfter).toContain('1 0 0 1 72 700 cm BT 1 0 0 1 0 0 Tm /FXF1 24 Tf 0 Tr');
    log('tier2 helvetica', {
      generateMs: r.generateMs,
      contentBytes: [r.contentBefore.length, r.contentAfter.length],
    });
  });

  test('missing glyphs: Helvetica encodes U+03A9 as 0xFF, an Identity-H subset writes CID 0', async () => {
    const std = await inPlaceEdit(await fixture(simpleTextUrl), 0, 'fox', 'Ωox');
    // GetGlyphWidth still succeeds (bogus width); GetGlyphPath is null: the usable pre-check.
    expect(std.newChars[0]![2]).toBe(-1);
    expect(std.newChars[0]![1]).toBeGreaterThan(0);
    expect(std.freshReadback).toBe('The quick brown ÿox jumps over the lazy dog.');
    expect(std.contentAfter).toContain('20FF6F78');

    const inter = await interPdf([{ text: 'The quick brown fox jumps', x: 20, y: 120, size: 20 }]);
    const ok = await inPlaceEdit(inter, 0, 'fox', 'cow', 'tier2-subset');
    expect(ok.font.embedded).toBe(true);
    expect(ok.font.baseName).toMatch(/^Inter-Regular/);
    expect(ok.freshReadback).toBe('The quick brown cow jumps');
    expect(ok.reextracted).toBe('The quick brown cow jumps');
    for (const a of ok.advances) expect(a.measured).toBeCloseTo(a.metric!, 2);
    expect(ok.newChars.every(([, , segments]) => segments > 0)).toBe(true);

    const missing = await inPlaceEdit(inter, 0, 'fox', 'cat', 'tier2-subset-missing');
    // 'a' and 't' are not in the subset: width = DW (1000/em), no glyph path, CID 0 written.
    expect(missing.newChars.map(([c, w, seg]) => [c, w, seg > 0])).toEqual([
      ['c', expect.closeTo(11.42, 2), true],
      ['a', 20, false],
      ['t', 20, false],
    ]);
    expect(missing.freshReadback).toBe('The quick brown c jumps');
    expect(missing.contentAfter).toContain('000800000000');
    log('tier2 subset', { font: ok.font, generateMs: ok.generateMs });
  });

  test('tagged PDF: BDC/EMC, the MCID and the /Artifact survive GenerateContent', async () => {
    const r = await inPlaceEdit(await fixture(taggedUrl), 0, 'paragraph', 'sentence');
    expect(r.reextracted).toBe('Tagged sentence on page 1 of tagged.');
    expect(r.contentAfter).toContain('/P <</MCID 0>> BDC');
    expect(r.contentAfter).toContain('/Artifact <</Subtype/Footer/Type/Pagination>> BDC');
    expect(r.contentAfter.match(/EMC/g)).toHaveLength(2);
    const re = await openDoc(r.saved);
    const pc = docContext(re).acquirePage(0);
    const n = pdfium.FPDFPage_CountObjects(pc.pagePtr);
    const mcids = range(0, n).map((i) =>
      pdfium.FPDFPageObj_GetMarkedContentID(pdfium.FPDFPage_GetObject(pc.pagePtr, i)),
    );
    pc.release();
    await closeDoc(re);
    expect(mcids).toEqual([0, -1]);
  });

  test('SetText flattens TJ kerning: later glyphs move by the summed adjustments', async () => {
    const kerned = await rawPdf({ content: KERNED });
    const r = await inPlaceEdit(kerned, 0, 'fox', 'cat');
    const drift = tailDrift(await readBack(kerned), await readBack(r.saved), 'ps over.');
    expect(drift).toBeCloseTo((Math.abs(30 - 40 + 25) / 1000) * 12, 3);
    expect(r.contentAfter).toContain('> Tj');
    expect(r.contentAfter).not.toContain('TJ');
  });

  test('GenerateContent merges a two-stream /Contents into one regenerated stream', async () => {
    const two = await PDFDocument.load(
      await rawPdf({ content: 'BT /F1 12 Tf 20 150 Td (First stream) Tj ET' }),
    );
    const p0 = two.getPage(0);
    const second = two.context.register(
      two.context.stream('BT /F1 12 Tf 20 100 Td (Second stream) Tj ET'),
    );
    p0.node.set(
      PDFName.of('Contents'),
      two.context.obj([p0.node.get(PDFName.of('Contents'))!, second]),
    );
    const bytes = toBuffer(await two.save());
    expect((await inflatedContent(bytes, 0)).streams).toBe(2);
    const r = await inPlaceEdit(bytes, 0, 'Second', 'Other');
    const after = await inflatedContent(r.saved, 0);
    expect(after.streams).toBe(1);
    expect(after.page).toContain('<46697273742073747265616D> Tj'); // "First stream", rewritten
  });
});

describe('Q3 tier 1: remove and replace', () => {
  test('redactTextInRects removes only the rect glyphs and keeps every other position', async () => {
    const cases = [
      ['simple', await fixture(simpleTextUrl), 'fox', 'jumps over the lazy dog.'],
      ['kerned', await rawPdf({ content: KERNED }), 'fox', 'jumps over.'],
      [
        'subset',
        await interPdf([{ text: 'The quick brown fox jumps', x: 20, y: 120, size: 20 }]),
        'fox',
        'jumps',
      ],
    ] as const;
    for (const [name, bytes, word, tail] of cases) {
      const t0 = performance.now();
      const saved = await redact(bytes, word);
      const ms = performance.now() - t0;
      const before = await readBack(bytes);
      const after = await readBack(saved);
      expect(after.text).not.toContain(word);
      expect(tailDrift(before, after, tail)).toBeLessThan(0.01);
      const content = await inflatedContent(saved, 0);
      if (name !== 'subset')
        expect(encodings(word).some((e) => content.page.includes(e))).toBe(false);
      // The gap is a TJ displacement; kerning elsewhere in the TJ is kept.
      expect(content.page).toMatch(/> -1\d{3} </);
      log(`redact ${name}`, {
        ms,
        after: after.text.split('\r\n').pop(),
        content: content.page.length,
      });
    }
  });

  test('appending the replacement after removal breaks reading order; a full font is ~100 KB', async () => {
    const bytes = await fixture(simpleTextUrl);
    const before = await readBack(bytes);
    const origin = before.origins[before.text.indexOf('fox')]!;
    const removed = await redact(bytes, 'fox');

    // (a) pdf-lib post-pass with a fontkit subset of Inter.
    let t0 = performance.now();
    const pl = await PDFDocument.load(removed.slice(0));
    pl.registerFontkit(fontkit);
    const f = await pl.embedFont(interBytes, { subset: true });
    pl.getPage(0).drawText('wolf', { x: origin.x, y: origin.y, size: 12, font: f });
    const viaPdfLib = toBuffer(await pl.save());
    const pdfLibMs = performance.now() - t0;
    expect((await readBack(viaPdfLib)).text).toMatch(/lazy dog\. ?wolf$/);

    // (b) PDFium FPDFText_LoadFont: embeds the whole TTF (CID, Identity-H).
    t0 = performance.now();
    const doc = await openDoc(removed.slice(0));
    const ctx = docContext(doc);
    const pc = ctx.acquirePage(0);
    const dataPtr = copyIn(interBytes);
    const font = pdfium.FPDFText_LoadFont(
      ctx.docPtr,
      dataPtr,
      interBytes.length,
      FPDF_FONT_TRUETYPE,
      true,
    );
    free(dataPtr);
    expect(font).toBeGreaterThan(0);
    expect(fontFacts(font)).toMatchObject({
      baseName: 'Inter-Regular',
      fontDataBytes: interBytes.length,
    });
    const obj = pdfium.FPDFPageObj_CreateTextObj(ctx.docPtr, font, 12);
    expect(setText(obj, 'wolf')).toBe(true);
    setMatrix(obj, [1, 0, 0, 1, origin.x, origin.y]);
    pdfium.FPDFPage_InsertObject(pc.pagePtr, obj);
    expect(pdfium.FPDFPage_GenerateContent(pc.pagePtr)).toBe(true);
    pc.disposeImmediate();
    pdfium.FPDFFont_Close(font);
    const viaPdfium = await saveDoc(doc);
    await closeDoc(doc);
    const pdfiumMs = performance.now() - t0;
    expect((await readBack(viaPdfium)).text).toMatch(/lazy dog\. ?wolf$/);
    const fonts = await fontDictSummary(viaPdfium);
    log('tier1 append', {
      bytes: {
        original: bytes.byteLength,
        removed: removed.byteLength,
        pdfLib: viaPdfLib.byteLength,
        pdfiumFull: viaPdfium.byteLength,
      },
      ms: { pdfLib: pdfLibMs, pdfiumFull: pdfiumMs },
      pdfiumFullFonts: fonts,
    });
    expect(viaPdfium.byteLength - removed.byteLength).toBeGreaterThan(90_000);
    expect(viaPdfLib.byteLength - removed.byteLength).toBeLessThan(3_000);
  });

  test('split + bundled subset (LoadCidType2Font): exact, in reading order, word gone', async () => {
    const cases = [
      ['helvetica', await fixture(simpleTextUrl), 0, 'fox', 'wolf'],
      ['kerned', await rawPdf({ content: KERNED }), 0, 'fox', 'wolf'],
      [
        'subset',
        await interPdf([{ text: 'The quick brown fox jumps', x: 20, y: 120, size: 20 }]),
        0,
        'fox',
        'wolf',
      ],
      ['tagged', await fixture(taggedUrl), 0, 'paragraph', 'wolf'],
      ['rotated', await fixture(rotatedUrl), 1, 'ROTATE', 'TURNED'],
      [
        'form',
        await rawPdf({
          content: 'q 1.5 0 0 1.5 0 0 cm /Fm0 Do Q\nBT /F1 12 Tf 20 60 Td (Page level line) Tj ET',
          forms: { Fm0: 'BT /F1 12 Tf 20 100 Td [(Inside the f) -30 (orm here)] TJ ET' },
        }),
        0,
        'form',
        'box',
      ],
    ] as const;
    for (const [name, bytes, pageIndex, word, replacement] of cases) {
      const r = await splitReplace(bytes, pageIndex, word, replacement, name);
      expect(r.freshText).toBe(r.reextracted);
      expect(r.lineInOrder).toBe(true);
      expect(r.drift).toBeLessThan(0.01);
      expect(r.newBoxesInsideLine).toBe(true);
      expect(r.oldWordInContent).toBe(false);
      expect(r.pixelsOutsideLine).toBe(0);
      expect(r.charcodesOk).toBe(true);
      const cid = r.fonts.find((f) => f.Subtype === '/CIDFontType2' && f.BaseFont === '/Untitled');
      expect(cid?.W).toBeDefined();
      if (name === 'tagged') expect(r.mcidMarks).toEqual(['MCID 0', 'MCID 0', 'MCID 0']);
      if (name === 'form') {
        expect(r.inForm).toBe(true);
        expect((await inflatedContent(r.saved, 0)).forms).toEqual(['']);
      }
      log(`split ${name}`, {
        runs: r.runs,
        newSize: r.newSize,
        subsetBytes: r.subsetBytes,
        generateMs: r.generateMs,
        bytes: r.bytes,
        line: r.reextracted.split('\r\n')[0],
      });
    }
  });

  test('split with the original font is an exact tier 2; a missing glyph is caught by readback', async () => {
    const kerned = await rawPdf({ content: KERNED });
    const ok = await splitReplace(kerned, 0, 'fox', 'cat', undefined, 'original');
    expect(ok.reextracted).toBe('The quick brown cat jumps over.');
    expect(ok.drift).toBeLessThan(0.01);
    expect(ok.runs).toEqual({ prefix: 2, suffix: 2 });
    expect(ok.fonts).toHaveLength(1);
    const bad = await splitReplace(kerned, 0, 'fox', 'Ωx', undefined, 'original');
    expect(bad.freshText).toBe('The quick brown ÿx jumps over.');
  });
});

/** Indirect streams (any, reachable or not) whose decoded bytes contain `text`. */
async function streamsContaining(bytes: ArrayBuffer, text: string): Promise<number> {
  const doc = await PDFDocument.load(bytes.slice(0), { updateMetadata: false });
  let hits = 0;
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    let decoded = '';
    try {
      decoded = streamText(obj);
    } catch {
      continue;
    }
    if (encodings(text).some((e) => decoded.includes(e))) hits++;
  }
  return hits;
}

describe('Q3b whole-file residue', () => {
  test('one edit leaves no trace; a second GenerateContent in-session orphans the first stream', async () => {
    const simple = await fixture(simpleTextUrl);
    // Every page of simple-text.pdf has the fox line; only page 1 is edited.
    expect(await streamsContaining(simple, 'fox')).toBe(3);
    expect(await streamsContaining(simple, 'cat')).toBe(0);
    expect(await streamsContaining(simple, 'owl')).toBe(0);
    const once = await splitReplace(simple, 0, 'fox', 'wolf');
    expect(await streamsContaining(once.saved, 'fox')).toBe(2);
    const tier2 = await inPlaceEdit(simple, 0, 'fox', 'cat');
    expect(await streamsContaining(tier2.saved, 'fox')).toBe(2);

    // Two tier-2 edits on the same page in one session: fox -> cat -> dog.
    const doc = await openDoc(simple.slice(0));
    for (const [from, to] of [
      ['fox', 'cat'],
      ['cat', 'owl'],
    ] as const) {
      const pc = docContext(doc).acquirePage(0);
      const hit = locate(pc.getTextPage(), from);
      setText(hit.obj, 'The quick brown fox jumps over the lazy dog.'.replace('fox', to));
      expect(pdfium.FPDFPage_GenerateContent(pc.pagePtr)).toBe(true);
      pc.disposeImmediate();
    }
    const twice = await saveDoc(doc);
    await closeDoc(doc);
    expect((await readBack(twice)).text).toContain('brown owl jumps');
    const residue = {
      fox: await streamsContaining(twice, 'fox'),
      cat: await streamsContaining(twice, 'cat'),
      owl: await streamsContaining(twice, 'owl'),
    };
    // The intermediate stream (cat) is unreachable but still written.
    expect(residue).toEqual({ fox: 2, cat: 1, owl: 1 });
    // A reopen + save round trip (what replay produces) drops the orphan.
    const round = await openDoc(twice.slice(0));
    const cleaned = await saveDoc(round);
    await closeDoc(round);
    expect(await streamsContaining(cleaned, 'cat')).toBe(0);
    expect(await streamsContaining(cleaned, 'owl')).toBe(1);
  });
});

describe('Q4 undo = reopen + replay', () => {
  test('abandoning: closing the page without GenerateContent drops object edits, not loaded fonts', async () => {
    const simple = await fixture(simpleTextUrl);
    const doc = await openDoc(simple.slice(0));
    const ctx = docContext(doc);
    const pc = ctx.acquirePage(0);
    const hit = locate(pc.getTextPage(), 'fox');
    expect(setText(hit.obj, 'The quick brown cat jumps over the lazy dog.')).toBe(true);
    // LoadCidType2Font needs a non-empty CIDToGIDMap; with none it returns no font.
    const probe = copyIn(interBytes);
    expect(
      pdfium.FPDFText_LoadCidType2Font(
        ctx.docPtr,
        probe,
        interBytes.length,
        cmapFor([1], ['a']),
        0,
        0,
      ),
    ).toBe(0);
    free(probe);
    const sub = loadSubsetFont(ctx.docPtr, interBytes, 'wolf');
    expect(sub.font).toBeGreaterThan(0);
    pdfium.FPDFFont_Close(sub.font);
    pc.disposeImmediate(); // FPDF_ClosePage, no GenerateContent
    const saved = await saveDoc(doc);
    await closeDoc(doc);
    expect((await readBack(saved)).text).toContain('brown fox jumps');
    const fonts = await fontDictSummary(saved);
    log('abandoned edit', { bytes: [simple.byteLength, saved.byteLength], fonts: fonts.length });
    expect(fonts.some((f) => f.BaseFont === '/Untitled')).toBe(true);
  });

  test('edits replay byte-identically; a save without edits keeps the content stream', async () => {
    const simple = await fixture(simpleTextUrl);
    const same = (x: ArrayBuffer, y: ArrayBuffer) =>
      x.byteLength === y.byteLength &&
      new Uint8Array(x).every((v, k) => v === new Uint8Array(y)[k]);
    const a = await inPlaceEdit(simple, 0, 'fox', 'cat');
    const b = await inPlaceEdit(simple, 0, 'fox', 'cat');
    expect(same(a.saved, b.saved)).toBe(true);
    const c = await splitReplace(simple, 0, 'fox', 'wolf');
    const d = await splitReplace(simple, 0, 'fox', 'wolf');
    expect(same(c.saved, d.saved)).toBe(true);
    const doc = await openDoc(simple.slice(0));
    const plain = await saveDoc(doc);
    await closeDoc(doc);
    expect((await inflatedContent(plain, 0)).page).toBe((await inflatedContent(simple, 0)).page);
  });

  test('cost: open, edit every page, GenerateContent, save', async () => {
    const many = await fixture(manyPagesUrl);
    let t = performance.now();
    const doc = await openDoc(many.slice(0));
    const openMs = performance.now() - t;
    const gen: number[] = [];
    for (let p = 0; p < doc.pageCount; p++) {
      const pc = docContext(doc).acquirePage(p);
      const tp = pc.getTextPage();
      if (pdfium.FPDFText_CountChars(tp) > 0) {
        setText(pdfium.FPDFText_GetTextObject(tp, 0), `#${p + 1}`);
        const g = performance.now();
        expect(pdfium.FPDFPage_GenerateContent(pc.pagePtr)).toBe(true);
        gen.push(performance.now() - g);
      }
      pc.disposeImmediate();
    }
    t = performance.now();
    const saved = await saveDoc(doc);
    const saveMs = performance.now() - t;
    await closeDoc(doc);
    const plainDoc = await openDoc(many.slice(0));
    const plain = await saveDoc(plainDoc);
    await closeDoc(plainDoc);
    gen.sort((x, y) => x - y);
    log('many-pages (400 pages)', {
      openMs,
      editedPages: gen.length,
      generateMs: {
        median: gen[gen.length >> 1],
        max: gen[gen.length - 1],
        total: gen.reduce((x, y) => x + y, 0),
      },
      saveMs,
      bytes: {
        original: many.byteLength,
        savedNoEdit: plain.byteLength,
        savedAllEdited: saved.byteLength,
      },
    });

    // A dense page: 60 lines x 12 kerned words.
    const lines = range(0, 60).map(
      (l) =>
        `BT /F1 9 Tf 20 ${780 - l * 12} Td [${range(0, 12)
          .map((w) => `(w${l}x${w}) -250`)
          .join(' ')}] TJ ET`,
    );
    const dense = await rawPdf({ content: lines.join('\n'), size: [612, 792] });
    const samples: number[] = [];
    let after = '';
    for (let rep = 0; rep < 5; rep++) {
      const r = await inPlaceEdit(dense, 0, 'w30x5', 'EDITED');
      samples.push(r.generateMs);
      after = r.contentAfter;
    }
    log('dense page (720 kerned words)', {
      generateMs: samples,
      contentBytes: { before: (await inflatedContent(dense, 0)).page.length, after: after.length },
    });
  });
});

describe('Q5 blockers', () => {
  const formPdf = () =>
    rawPdf({
      content: 'q /Fm0 Do Q\nBT /F1 12 Tf 20 100 Td (Page level line) Tj ET',
      forms: { Fm0: 'BT /F1 12 Tf 20 150 Td (Inside the form) Tj ET' },
    });

  test('Form XObject: SetText inside a form is lost on save; removal rewrites the form', async () => {
    for (const mode of ['settext', 'formremove', 'pageremove'] as const) {
      const bytes = await formPdf();
      const doc = await openDoc(bytes);
      const pc = docContext(doc).acquirePage(0);
      const tp = pc.getTextPage();
      const hit = locate(tp, 'form');
      const top = range(0, pdfium.FPDFPage_CountObjects(pc.pagePtr)).map((k) =>
        pdfium.FPDFPage_GetObject(pc.pagePtr, k),
      );
      expect(top.map((o) => pdfium.FPDFPageObj_GetType(o))).toEqual([FPDF_PAGEOBJ_FORM, 1]);
      const form = top[0]!;
      // FPDFText_GetTextObject hands out the object *inside* the form.
      expect(pdfium.FPDFFormObj_GetObject(form, 0)).toBe(hit.obj);
      let ok = false;
      if (mode === 'settext') ok = setText(hit.obj, 'Inside the FORM!');
      if (mode === 'formremove') ok = pdfium.FPDFFormObj_RemoveObject(form, hit.obj);
      if (mode === 'pageremove') ok = pdfium.FPDFPage_RemoveObject(pc.pagePtr, hit.obj);
      const fresh = pdfium.FPDFText_LoadPage(pc.pagePtr);
      const freshText = pageChars(fresh);
      pdfium.FPDFText_ClosePage(fresh);
      expect(pdfium.FPDFPage_GenerateContent(pc.pagePtr)).toBe(true);
      pc.disposeImmediate();
      const saved = await saveDoc(doc);
      await closeDoc(doc);
      const after = await readBack(saved);
      const content = await inflatedContent(saved, 0);
      if (mode === 'settext') {
        expect(ok).toBe(true);
        expect(freshText).toContain('Inside the FORM!'); // in memory...
        expect(after.text).toContain('Inside the form'); // ...but not written
        expect(content.forms).toEqual(['BT /F1 12 Tf 20 150 Td (Inside the form) Tj ET']);
      }
      if (mode === 'formremove') {
        expect(ok).toBe(true);
        expect(after.text).toBe('Page level line');
        expect(content.forms).toEqual(['']);
      }
      if (mode === 'pageremove') expect(ok).toBe(false);
    }
    // EmbedPDF's redaction recurses into forms and rewrites the form stream.
    const bytes = await formPdf();
    const removed = await redact(bytes, 'form');
    expect((await readBack(removed)).text).toContain('Inside the\r\n');
    const forms = (await inflatedContent(removed, 0)).forms;
    expect(forms[0]).toContain('<496E736964652074686520> Tj');
  });

  test('text render mode 3 (invisible OCR text) is reported and kept', async () => {
    const bytes = await rawPdf({
      content: 'q BT 3 Tr /F1 12 Tf 20 100 Td (Invisible OCR layer) Tj ET Q',
    });
    const doc = await openDoc(bytes);
    const pc = docContext(doc).acquirePage(0);
    const hit = locate(pc.getTextPage(), 'OCR');
    expect(pdfium.FPDFTextObj_GetTextRenderMode(hit.obj)).toBe(3);
    setText(hit.obj, 'Invisible OCR edited');
    pdfium.FPDFPage_GenerateContent(pc.pagePtr);
    pc.disposeImmediate();
    const saved = await saveDoc(doc);
    await closeDoc(doc);
    expect((await inflatedContent(saved, 0)).page).toContain('/FXF1 12 Tf 3 Tr');
    expect((await readBack(saved)).text).toBe('Invisible OCR edited');
  });

  test('Type3: no base name, no font program, zero width, no glyph path, still extractable', async () => {
    const bytes = await rawPdf({ content: 'BT /T3 12 Tf 20 150 Td (aaa) Tj ET' });
    const doc = await openDoc(bytes);
    const pc = docContext(doc).acquirePage(0);
    const tp = pc.getTextPage();
    const hit = locate(tp, 'aaa');
    const font = pdfium.FPDFTextObj_GetFont(hit.obj);
    expect(fontFacts(font)).toEqual({ baseName: '', embedded: true, flags: 0, fontDataBytes: 0 });
    expect(glyphWidth(font, 'a', 12)).toBe(0);
    expect(glyphSegments(font, 'a', 12)).toBe(-1);
    expect(textObjText(hit.obj, tp)).toBe('aaa');
    pc.release();
    await closeDoc(doc);
  });

  test('char origins and boxes are unrotated user space for /Rotate 0, 90, 180, 270', async () => {
    const doc = await openDoc(await fixture(rotatedUrl));
    for (const pageIndex of [0, 1, 2, 3]) {
      const pc = docContext(doc).acquirePage(pageIndex);
      const tp = pc.getTextPage();
      const hit = locate(tp, 'PAGE');
      expect(doc.pages[pageIndex]!.rotation).toBe(pageIndex);
      // The marker is drawn at (72, 760) in user space on every page.
      expect(charOrigin(tp, hit.start)).toEqual({ x: 72, y: 760 });
      expect(objMatrix(hit.obj)).toEqual([1, 0, 0, 1, 72, 760]);
      pc.release();
    }
    await closeDoc(doc);
  });
});
