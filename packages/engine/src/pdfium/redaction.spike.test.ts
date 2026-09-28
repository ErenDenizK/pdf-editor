/**
 * SPIKE — M4 true redaction (docs/research/06-redaction-spike.md). Kept as evidence, not
 * product code: it pins down which "leak channels" EmbedPDF 2.15.1's PDFium redaction
 * (`redactTextInRects`, /Redact + `applyRedaction` / `applyAllRedactions`) removes, and
 * which ones the pdf-lib post-pass must handle. The assertions record the behaviour
 * observed on 2026-09-27; if an EmbedPDF upgrade changes one, re-run the spike and update
 * the report rather than "fixing" the test.
 *
 * Every case builds its own synthetic PDF with @cantoo/pdf-lib (the secret token is
 * `SECRET-7731`), redacts it through each method, saves with `saveAsCopy` (the adapter's
 * `save` path) and inspects the output through PDFium text extraction + search, a raw
 * byte grep, a grep of every inflated stream (fflate), a pdf-lib object walk, pixels of a
 * render, annotation lists and the trailer (/Prev).
 *
 * Artifacts (PNGs, JSON dump) are written only when VITE_REDACTION_SPIKE_OUT names a
 * directory under packages/engine (e.g. `.vitest/redaction-spike`, which is gitignored):
 *   VITE_REDACTION_SPIKE_OUT=.vitest/redaction-spike pnpm --filter @pdf-editor/engine \
 *     exec vitest run src/pdfium/redaction.spike.test.ts
 */

import {
  PDFArray,
  PDFDict,
  PDFDocument,
  type PDFFont,
  PDFHexString,
  PDFName,
  type PDFObject,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  StandardFonts,
  degrees,
} from '@cantoo/pdf-lib';
import {
  browserImageDataToBlobConverter,
  PdfEngine as OrchestratedEngine,
  PdfiumNative,
} from '@embedpdf/engines/pdfium';
import {
  type PdfAnnotationObject,
  PdfAnnotationSubtype,
  type PdfDocumentObject,
  type PdfPageObject,
  type PdfRedactAnnoObject,
  type Rect as DeviceRect,
} from '@embedpdf/models';
import { init, type WrappedPdfiumModule } from '@embedpdf/pdfium';
import wasmUrl from '@embedpdf/pdfium/pdfium.wasm?url';
import type { Rect, SourceId } from '@pdf-editor/document-model';
import { unzlibSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { commands } from 'vitest/browser';

import imagesUrl from '../../../../test/fixtures/images.pdf?url';
import manyPagesUrl from '../../../../test/fixtures/many-pages.pdf?url';
import { dropUnreachable } from '../pdflib/metadata';
import { deviceToUserRect, pageGeometry, userToDeviceRect } from './coords';
import { PdfiumAdapter } from './pdfium-adapter';

const TOKEN = 'SECRET-7731';
const OUT = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
  ?.VITE_REDACTION_SPIKE_OUT;

// ---------------------------------------------------------------------------------------
// Engine setup: one same-thread PdfiumNative shared by the adapter (open/getPageText/
// search/save) and the direct calls the adapter does not expose.
// ---------------------------------------------------------------------------------------

let native: PdfiumNative;
let engine: OrchestratedEngine;
let adapter: PdfiumAdapter;
let counter = 0;
const findings: Record<string, unknown> = {};

beforeAll(async () => {
  const wasmBinary = await (await fetch(wasmUrl)).arrayBuffer();
  const module = await init({ wasmBinary });
  native = new PdfiumNative(module, { fontFallback: null });
  engine = new OrchestratedEngine(native, { imageConverter: browserImageDataToBlobConverter });
  adapter = new PdfiumAdapter({ wasmUrl, engineFactory: () => engine });
});

afterAll(async () => {
  log('findings', findings);
  if (OUT) await commands.writeFile(`${OUT}/findings.json`, JSON.stringify(findings, null, 2));
  await adapter.destroy();
});

function log(label: string, value: unknown): void {
  // eslint-disable-next-line no-console -- spike output is the point of this file
  console.info(`[redaction-spike] ${label}: ${JSON.stringify(value)}`);
}

const nextId = (prefix: string) => `${prefix}-${++counter}`;

async function openDoc(bytes: ArrayBuffer): Promise<PdfDocumentObject> {
  return engine.openDocumentBuffer({ id: nextId('eng'), content: bytes.slice(0) }).toPromise();
}

function page(doc: PdfDocumentObject, index: number): PdfPageObject {
  const p = doc.pages[index];
  if (!p) throw new Error(`no page ${index}`);
  return p;
}

// ---------------------------------------------------------------------------------------
// Synthetic documents
// ---------------------------------------------------------------------------------------

interface Built {
  readonly doc: PDFDocument;
  readonly font: PDFFont;
}

async function newDoc(): Promise<Built> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  return { doc, font };
}

interface PageOpts {
  readonly size?: [number, number];
  readonly xobjects?: Record<string, PDFRef>;
  readonly rotate?: number;
}

function addPage({ doc, font }: Built, ops: string, opts: PageOpts = {}) {
  const p = doc.addPage(opts.size ?? [400, 300]);
  p.node.setFontDictionary(PDFName.of('F1'), font.ref);
  for (const [name, ref] of Object.entries(opts.xobjects ?? {})) {
    p.node.setXObject(PDFName.of(name), ref);
  }
  p.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(ops)));
  if (opts.rotate) p.setRotation(degrees(opts.rotate));
  return p;
}

const text = (x: number, y: number, s: string, size = 14, extra = '') =>
  `BT /F1 ${size} Tf ${extra} ${x} ${y} Td (${s}) Tj ET\n`;

async function save(doc: PDFDocument): Promise<ArrayBuffer> {
  return (await doc.save({ useObjectStreams: false })).slice().buffer;
}

function solidImage(doc: PDFDocument, w: number, h: number, rgb: [number, number, number]) {
  const px = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) px.set(rgb, i * 3);
  return doc.context.register(
    doc.context.flateStream(px, {
      Type: 'XObject',
      Subtype: 'Image',
      Width: w,
      Height: h,
      ColorSpace: 'DeviceRGB',
      BitsPerComponent: 8,
    }),
  );
}

// ---------------------------------------------------------------------------------------
// Redaction methods
// ---------------------------------------------------------------------------------------

type Method =
  | 'rects' // redactTextInRects, recurseForms true (default), drawBlackBoxes true
  | 'rects-noforms' // redactTextInRects, recurseForms false
  | 'annot-all' // /Redact annotation (IC black) + applyAllRedactions
  | 'annot-one' // /Redact annotation + applyRedaction(single)
  | 'adapter'; // PdfiumAdapter.createAnnotation(kind redact) + applyRedactions + save

const ALL_METHODS: readonly Method[] = ['rects', 'annot-all', 'annot-one', 'adapter'];

interface Region {
  readonly pageIndex: number;
  readonly rect: Rect; // user space
}

interface RedactResult {
  readonly bytes: ArrayBuffer;
  readonly applied: boolean;
  readonly redactAnnotsAfterApply: number;
  readonly ms: number;
}

function redactAnno(
  p: PdfPageObject,
  rects: readonly Rect[],
  extra: Partial<PdfRedactAnnoObject> = {},
): PdfRedactAnnoObject {
  const g = pageGeometry(p);
  const device = rects.map((r) => userToDeviceRect(g, r));
  const union = rects.reduce((a, r) => ({
    x: Math.min(a.x, r.x),
    y: Math.min(a.y, r.y),
    width: Math.max(a.x + a.width, r.x + r.width) - Math.min(a.x, r.x),
    height: Math.max(a.y + a.height, r.y + r.height) - Math.min(a.y, r.y),
  }));
  return {
    id: '',
    type: PdfAnnotationSubtype.REDACT,
    pageIndex: p.index,
    rect: userToDeviceRect(g, union),
    segmentRects: device,
    color: '#000000',
    strokeColor: '#E53935',
    ...extra,
  };
}

async function redactAnnotsOn(doc: PdfDocumentObject, pageIndex: number): Promise<number> {
  const annots = await engine.getPageAnnotations(doc, page(doc, pageIndex)).toPromise();
  return annots.filter((a) => a.type === PdfAnnotationSubtype.REDACT).length;
}

async function redact(
  bytes: ArrayBuffer,
  regions: readonly Region[],
  method: Method,
  annoExtra: Partial<PdfRedactAnnoObject> = {},
): Promise<RedactResult> {
  const byPage = new Map<number, Rect[]>();
  for (const r of regions) byPage.set(r.pageIndex, [...(byPage.get(r.pageIndex) ?? []), r.rect]);
  if (method === 'adapter') {
    const id = nextId('adp') as SourceId;
    await adapter.open(id, bytes.slice(0));
    for (const [pageIndex, rects] of byPage) {
      for (const rect of rects) {
        await adapter.createAnnotation(id, { kind: 'redact', pageIndex, rect, quads: [rect] });
      }
    }
    const t0 = performance.now();
    await adapter.applyRedactions(id);
    const ms = performance.now() - t0;
    const left = (await adapter.listAnnotations(id, [...byPage.keys()][0] ?? 0)).filter(
      (a) => a.kind === 'redact',
    ).length;
    const out = await adapter.save(id);
    await adapter.close(id);
    return { bytes: out, applied: true, redactAnnotsAfterApply: left, ms };
  }
  const doc = await openDoc(bytes);
  let applied = false;
  let left = 0;
  let ms = 0;
  try {
    for (const [pageIndex, rects] of byPage) {
      const p = page(doc, pageIndex);
      if (method === 'rects' || method === 'rects-noforms') {
        const g = pageGeometry(p);
        const t0 = performance.now();
        applied =
          (await engine
            .redactTextInRects(
              doc,
              p,
              rects.map((r) => userToDeviceRect(g, r)),
              { recurseForms: method === 'rects', drawBlackBoxes: true },
            )
            .toPromise()) || applied;
        ms += performance.now() - t0;
      } else {
        for (const rect of rects) {
          await engine.createPageAnnotation(doc, p, redactAnno(p, [rect], annoExtra)).toPromise();
        }
        const t0 = performance.now();
        if (method === 'annot-all') {
          applied = (await engine.applyAllRedactions(doc, p).toPromise()) || applied;
        } else {
          const annots = await engine.getPageAnnotations(doc, p).toPromise();
          for (const a of annots.filter((x) => x.type === PdfAnnotationSubtype.REDACT)) {
            applied = (await engine.applyRedaction(doc, p, a).toPromise()) || applied;
          }
        }
        ms += performance.now() - t0;
        left += await redactAnnotsOn(doc, pageIndex);
      }
    }
    const out = await engine.saveAsCopy(doc).toPromise();
    return { bytes: out, applied, redactAnnotsAfterApply: left, ms };
  } finally {
    await engine.closeDocument(doc).toPromise();
  }
}

// ---------------------------------------------------------------------------------------
// Channel inspection
// ---------------------------------------------------------------------------------------

const enc = new TextEncoder();
const latin1 = new TextDecoder('latin1');

function utf16be(s: string): Uint8Array {
  const out = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    out[i * 2] = s.charCodeAt(i) >> 8;
    out[i * 2 + 1] = s.charCodeAt(i) & 0xff;
  }
  return out;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

function indexOf(hay: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/** Encodings of a string worth grepping for in raw or inflated bytes. */
function variants(s: string): Record<string, Uint8Array> {
  return {
    ascii: enc.encode(s),
    utf16be: utf16be(s),
    hexAscii: enc.encode(hex(enc.encode(s))),
    hexAsciiUpper: enc.encode(hex(enc.encode(s)).toUpperCase()),
    hexUtf16: enc.encode(hex(utf16be(s))),
    hexUtf16Upper: enc.encode(hex(utf16be(s)).toUpperCase()),
  };
}

function grep(hay: Uint8Array, s: string): string[] {
  return Object.entries(variants(s))
    .filter(([, v]) => indexOf(hay, v) >= 0)
    .map(([k]) => k);
}

/** Every `stream ... endstream` payload in the file, inflated when it is zlib data. */
function streamsOf(raw: Uint8Array): { offset: number; data: Uint8Array; inflated: boolean }[] {
  const out: { offset: number; data: Uint8Array; inflated: boolean }[] = [];
  const s = latin1.decode(raw);
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (s.slice(m.index - 3, m.index) === 'end') continue;
    const start = m.index + m[0].length;
    const end = s.indexOf('endstream', start);
    if (end < 0) break;
    const data = raw.subarray(start, end);
    try {
      out.push({ offset: start, data: unzlibSync(data), inflated: true });
    } catch {
      out.push({ offset: start, data, inflated: false });
    }
    re.lastIndex = end;
  }
  return out;
}

function decodeString(o: PDFObject): string | undefined {
  if (o instanceof PDFString || o instanceof PDFHexString) return o.decodeText();
  return undefined;
}

/** Walks every indirect object; reports where a decoded string contains `needle`. */
function stringHits(doc: PDFDocument, needle: string): string[] {
  const hits: string[] = [];
  const visit = (o: PDFObject, path: string, depth: number) => {
    if (depth > 30) return;
    const s = decodeString(o);
    if (s !== undefined) {
      if (s.includes(needle)) hits.push(path);
      return;
    }
    if (o instanceof PDFName && o.decodeText().includes(needle)) hits.push(`${path}(name)`);
    if (o instanceof PDFStream) visit(o.dict, path, depth + 1);
    else if (o instanceof PDFDict) {
      for (const [k, v] of o.entries()) visit(v, `${path}/${k.decodeText()}`, depth + 1);
    } else if (o instanceof PDFArray) {
      for (let i = 0; i < o.size(); i++) visit(o.get(i), `${path}[${i}]`, depth + 1);
    }
  };
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    visit(obj, `${ref.objectNumber}`, 0);
  }
  return hits;
}

/** Indirect objects reachable from the trailer (/Root, /Info). */
function reachableRefs(doc: PDFDocument): Set<string> {
  const { context } = doc;
  const reachable = new Set<string>();
  const stack: PDFObject[] = [];
  const { Root, Info } = context.trailerInfo;
  if (Root) stack.push(Root);
  if (Info) stack.push(Info);
  const seen = new Set<PDFObject>();
  while (stack.length > 0) {
    const value = stack.pop()!;
    if (value instanceof PDFRef) {
      if (reachable.has(value.toString())) continue;
      reachable.add(value.toString());
      const target = context.lookup(value);
      if (target) stack.push(target);
    } else if (!seen.has(value)) {
      seen.add(value);
      if (value instanceof PDFStream) stack.push(value.dict);
      else if (value instanceof PDFDict) for (const [, v] of value.entries()) stack.push(v);
      else if (value instanceof PDFArray)
        for (let i = 0; i < value.size(); i++) stack.push(value.get(i));
    }
  }
  return reachable;
}

/** Streams whose (inflated) data contains `needle`: object, type and reachability. */
async function tokenStreams(bytes: ArrayBuffer, needle = TOKEN) {
  const doc = await PDFDocument.load(bytes.slice(0), { updateMetadata: false });
  const reachable = reachableRefs(doc);
  const out: { obj: string; kind: string; reachable: boolean; excerpt: string }[] = [];
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    let data = obj.contents;
    try {
      if ((obj.dict.get(PDFName.of('Filter'))?.toString() ?? '').includes('FlateDecode')) {
        data = unzlibSync(obj.contents);
      }
    } catch {
      /* keep raw */
    }
    if (grep(data, needle).length === 0) continue;
    const d = obj.dict;
    const kind = ['Type', 'Subtype'].map((k) => d.get(PDFName.of(k))?.toString() ?? '').join('');
    const txt = latin1.decode(data);
    const at = Math.max(0, txt.indexOf(needle) - 60);
    out.push({
      obj: ref.toString(),
      kind: kind || 'untyped',
      reachable: reachable.has(ref.toString()),
      excerpt: txt.slice(at, at + 140).replace(/\s+/g, ' '),
    });
  }
  return out;
}

/** Every image XObject in the file (reachable or not) with pixel stats. */
async function allImages(bytes: ArrayBuffer, original: [number, number, number][]) {
  const doc = await PDFDocument.load(bytes.slice(0), { updateMetadata: false });
  const reachable = reachableRefs(doc);
  const out: {
    obj: string;
    reachable: boolean;
    w: number;
    h: number;
    original?: number;
    white?: number;
  }[] = [];
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    if (obj.dict.get(PDFName.of('Subtype'))?.toString() !== '/Image') continue;
    const w = Number(obj.dict.get(PDFName.of('Width'))?.toString());
    const h = Number(obj.dict.get(PDFName.of('Height'))?.toString());
    let px: Uint8Array | undefined;
    try {
      px = unzlibSync(obj.contents);
    } catch {
      px = undefined;
    }
    let orig = 0;
    let white = 0;
    if (px && px.length >= w * h * 3) {
      for (let i = 0; i < w * h; i++) {
        const [r, g, b] = [px[i * 3]!, px[i * 3 + 1]!, px[i * 3 + 2]!];
        if (r > 225 && g > 225 && b > 225) white++;
        else if (
          original.some(([R, G, B]) => Math.abs(r - R) + Math.abs(g - G) + Math.abs(b - B) < 30)
        )
          orig++;
      }
    }
    out.push({
      obj: ref.toString(),
      reachable: reachable.has(ref.toString()),
      w,
      h,
      ...(px ? { original: round(orig / (w * h)), white: round(white / (w * h)) } : {}),
    });
  }
  return out;
}

interface ImageStat {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly filter: string;
  /** Share of pixels by class; undefined when the data could not be decoded. */
  readonly black?: number;
  readonly white?: number;
  readonly original?: number;
}

async function imageStats(
  doc: PDFDocument,
  pageIndex: number,
  original: [number, number, number][],
): Promise<ImageStat[]> {
  const p = doc.getPages()[pageIndex];
  if (!p) return [];
  const xo = p.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict);
  const stats: ImageStat[] = [];
  for (const [key, ref] of xo?.entries() ?? []) {
    const stream = doc.context.lookup(ref);
    if (!(stream instanceof PDFRawStream)) continue;
    if (stream.dict.get(PDFName.of('Subtype'))?.toString() !== '/Image') continue;
    const w = Number(stream.dict.get(PDFName.of('Width'))?.toString());
    const h = Number(stream.dict.get(PDFName.of('Height'))?.toString());
    const filter = stream.dict.get(PDFName.of('Filter'))?.toString() ?? 'none';
    let rgb: Uint8Array | undefined;
    try {
      if (filter.includes('FlateDecode')) rgb = unzlibSync(stream.contents);
      else if (filter === 'none') rgb = stream.contents;
      else if (filter.includes('DCTDecode')) {
        const blob = new Blob([stream.contents.slice()], { type: 'image/jpeg' });
        const bmp = await createImageBitmap(blob);
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const ctx = c.getContext('2d')!;
        ctx.drawImage(bmp, 0, 0);
        const rgba = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
        rgb = new Uint8Array((rgba.length / 4) * 3);
        for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
          rgb[j] = rgba[i]!;
          rgb[j + 1] = rgba[i + 1]!;
          rgb[j + 2] = rgba[i + 2]!;
        }
      }
    } catch {
      rgb = undefined;
    }
    if (!rgb || rgb.length < w * h * 3) {
      stats.push({ name: key.decodeText(), width: w, height: h, filter });
      continue;
    }
    let black = 0;
    let white = 0;
    let orig = 0;
    const n = w * h;
    for (let i = 0; i < n; i++) {
      const r = rgb[i * 3]!;
      const g = rgb[i * 3 + 1]!;
      const b = rgb[i * 3 + 2]!;
      if (r < 30 && g < 30 && b < 30) black++;
      else if (r > 225 && g > 225 && b > 225) white++;
      else if (
        original.some(([R, G, B]) => Math.abs(r - R) + Math.abs(g - G) + Math.abs(b - B) < 30)
      )
        orig++;
    }
    stats.push({
      name: key.decodeText(),
      width: w,
      height: h,
      filter,
      black: round(black / n),
      white: round(white / n),
      original: round(orig / n),
    });
  }
  return stats;
}

const round = (x: number) => Math.round(x * 1000) / 1000;

interface Channels {
  /** PDFium: token in the extracted text of any page. */
  textAnywhere: boolean;
  /** PDFium: glyph text whose box intersects a redaction region. */
  textInRegions: string;
  /** PDFium search hits for the token. */
  searchHits: number;
  /** Sentinel strings that must survive (over-redaction check). */
  sentinelsMissing: string[];
  /** Token encodings found in the raw file bytes. */
  rawBytes: string[];
  /** Streams whose inflated data contains the token (ascii / utf16be / hex). */
  inflatedStreams: number;
  /** pdf-lib: indirect objects whose decoded strings contain the token. */
  pdfLibStrings: string[];
  hasPrev: boolean;
  eofMarkers: number;
  annotations: string[][];
}

interface InspectOpts {
  readonly regions?: readonly Region[];
  readonly sentinels?: readonly string[];
  readonly needle?: string;
}

async function inspect(bytes: ArrayBuffer, opts: InspectOpts = {}): Promise<Channels> {
  const needle = opts.needle ?? TOKEN;
  const raw = new Uint8Array(bytes);
  const rawText = latin1.decode(raw);
  const inflated = streamsOf(raw).filter((s) => grep(s.data, needle).length > 0).length;
  const lib = await PDFDocument.load(raw.slice(), {
    ignoreEncryption: true,
    updateMetadata: false,
    throwOnInvalidObject: false,
  });
  const id = nextId('chk') as SourceId;
  const opened = await adapter.open(id, bytes.slice(0));
  let all = '';
  let inRegions = '';
  const annotations: string[][] = [];
  try {
    for (let i = 0; i < opened.pageCount; i++) {
      const runs = await adapter.getPageText(id, i);
      all += runs.map((r) => r.text).join('\n');
      for (const region of opts.regions ?? []) {
        if (region.pageIndex !== i) continue;
        inRegions += runs
          .flatMap((r) => r.glyphs)
          .filter((g) => g.text.trim() !== '' && intersects(g.rect, region.rect))
          .map((g) => g.text)
          .join('');
      }
      annotations.push((await adapter.listAnnotations(id, i)).map((a) => a.kind));
    }
    const hits = await adapter.search(id, needle);
    return {
      textAnywhere: all.replace(/\s+/g, '').includes(needle),
      textInRegions: inRegions,
      searchHits: hits.length,
      sentinelsMissing: (opts.sentinels ?? []).filter((s) => !all.replace(/\s+/g, '').includes(s)),
      rawBytes: grep(raw, needle),
      inflatedStreams: inflated,
      pdfLibStrings: stringHits(lib, needle),
      hasPrev: /\/Prev\s+\d+/.test(rawText),
      eofMarkers: rawText.split('%%EOF').length - 1,
      annotations,
    };
  } finally {
    await adapter.close(id);
  }
}

function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Search hits for `needle` as user-space rects (one union rect per hit, padded). */
async function hitRegions(bytes: ArrayBuffer, needle: string, pad = 1): Promise<Region[]> {
  const doc = await openDoc(bytes);
  try {
    const res = await engine.searchAllPages(doc, needle, { flags: [] }).toPromise();
    return res.results.map((hit) => {
      const g = pageGeometry(page(doc, hit.pageIndex));
      const rs = hit.rects.map((r: DeviceRect) => deviceToUserRect(g, r));
      const x0 = Math.min(...rs.map((r) => r.x)) - pad;
      const y0 = Math.min(...rs.map((r) => r.y)) - pad;
      const x1 = Math.max(...rs.map((r) => r.x + r.width)) + pad;
      const y1 = Math.max(...rs.map((r) => r.y + r.height)) + pad;
      return { pageIndex: hit.pageIndex, rect: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } };
    });
  } finally {
    await engine.closeDocument(doc).toPromise();
  }
}

/** Glyphs (text + user rect) of a page. */
async function glyphs(bytes: ArrayBuffer, pageIndex: number) {
  const id = nextId('gly') as SourceId;
  await adapter.open(id, bytes.slice(0));
  try {
    return (await adapter.getPageText(id, pageIndex)).flatMap((r) => r.glyphs);
  } finally {
    await adapter.close(id);
  }
}

// ---------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------

interface PixelStat {
  readonly dark: number;
  readonly white: number;
  readonly mean: [number, number, number];
}

async function render(
  bytes: ArrayBuffer,
  pageIndex: number,
  probes: Record<string, Rect>,
  png?: string,
): Promise<Record<string, PixelStat>> {
  const scale = 2;
  const doc = await openDoc(bytes);
  try {
    const p = page(doc, pageIndex);
    const img = await engine
      .renderPageRaw(doc, p, { scaleFactor: scale, withAnnotations: true, withForms: true })
      .toPromise();
    if (png && OUT) {
      const c = new OffscreenCanvas(img.width, img.height);
      c.getContext('2d')!.putImageData(
        new ImageData(new Uint8ClampedArray(img.data), img.width, img.height),
        0,
        0,
      );
      const blob = await c.convertToBlob({ type: 'image/png' });
      const b64 = await blobToBase64(blob);
      await commands.writeFile(`${OUT}/${png}.png`, b64, { encoding: 'base64' });
    }
    const g = pageGeometry(p);
    const out: Record<string, PixelStat> = {};
    for (const [name, rect] of Object.entries(probes)) {
      const d = userToDeviceRect(g, rect);
      const x0 = Math.ceil(d.origin.x * scale) + 2;
      const y0 = Math.ceil(d.origin.y * scale) + 2;
      const x1 = Math.floor((d.origin.x + d.size.width) * scale) - 2;
      const y1 = Math.floor((d.origin.y + d.size.height) * scale) - 2;
      let dark = 0;
      let white = 0;
      let n = 0;
      const sum: [number, number, number] = [0, 0, 0];
      for (let y = Math.max(0, y0); y < Math.min(img.height, y1); y++) {
        for (let x = Math.max(0, x0); x < Math.min(img.width, x1); x++) {
          const i = (y * img.width + x) * 4;
          const r = img.data[i]!;
          const gg = img.data[i + 1]!;
          const b = img.data[i + 2]!;
          sum[0] += r;
          sum[1] += gg;
          sum[2] += b;
          if (r < 40 && gg < 40 && b < 40) dark++;
          if (r > 230 && gg > 230 && b > 230) white++;
          n++;
        }
      }
      out[name] = {
        dark: round(dark / Math.max(n, 1)),
        white: round(white / Math.max(n, 1)),
        mean: sum.map((v) => Math.round(v / Math.max(n, 1))) as [number, number, number],
      };
    }
    return out;
  } finally {
    await engine.closeDocument(doc).toPromise();
  }
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

async function contentOps(bytes: ArrayBuffer, pageIndex: number): Promise<string> {
  const lib = await PDFDocument.load(bytes.slice(0), { updateMetadata: false });
  const p = lib.getPages()[pageIndex]!;
  const contents = p.node.get(PDFName.of('Contents'));
  const refs: PDFObject[] = [];
  const resolved = contents instanceof PDFRef ? lib.context.lookup(contents) : contents;
  if (resolved instanceof PDFArray)
    for (let i = 0; i < resolved.size(); i++) refs.push(resolved.get(i));
  else if (contents) refs.push(contents);
  let s = '';
  for (const r of refs) {
    const st = r instanceof PDFRef ? lib.context.lookup(r) : r;
    if (!(st instanceof PDFRawStream)) continue;
    const f = st.dict.get(PDFName.of('Filter'))?.toString() ?? '';
    s += latin1.decode(f.includes('FlateDecode') ? unzlibSync(st.contents) : st.contents);
  }
  return s;
}

function record(name: string, value: unknown): void {
  findings[name] = value;
  log(name, value);
}

async function allMethods(
  name: string,
  bytes: ArrayBuffer,
  regions: readonly Region[],
  opts: InspectOpts & { methods?: readonly Method[] } = {},
): Promise<Record<string, Channels & { applied: boolean; redactAnnotsLeft: number }>> {
  const out: Record<string, Channels & { applied: boolean; redactAnnotsLeft: number }> = {};
  for (const method of opts.methods ?? ALL_METHODS) {
    const r = await redact(bytes, regions, method);
    out[method] = {
      applied: r.applied,
      redactAnnotsLeft: r.redactAnnotsAfterApply,
      ...(await inspect(r.bytes, { ...opts, regions })),
    };
  }
  record(name, out);
  return out;
}

// =======================================================================================
// Cases
// =======================================================================================

describe('redaction spike (EmbedPDF 2.15.1)', () => {
  test('(a) token in one Tj; baseline channels of the input', async () => {
    const b = await newDoc();
    addPage(b, text(50, 200, TOKEN) + text(50, 100, 'KEEP-ME'));
    const bytes = await save(b.doc);
    const regions = await hitRegions(bytes, TOKEN);
    expect(regions).toHaveLength(1);
    record('a.before', await inspect(bytes, { regions, sentinels: ['KEEP-ME'] }));
    const res = await allMethods('a', bytes, regions, { sentinels: ['KEEP-ME'] });
    for (const m of ALL_METHODS) {
      expect(res[m]!.textAnywhere, m).toBe(false);
      expect(res[m]!.searchHits, m).toBe(0);
      expect(res[m]!.rawBytes, m).toEqual([]);
      expect(res[m]!.inflatedStreams, m).toBe(0);
      expect(res[m]!.sentinelsMissing, m).toEqual([]);
      expect(res[m]!.hasPrev, m).toBe(false);
    }
    const annotAll = await redact(bytes, regions, 'annot-all');
    const rects = await redact(bytes, regions, 'rects');
    const probe = { box: regions[0]!.rect };
    record('a.render', {
      before: await render(bytes, 0, probe, 'a-before'),
      rects: await render(rects.bytes, 0, probe, 'a-after-rects'),
      annotAll: await render(annotAll.bytes, 0, probe, 'a-after-annot-all'),
    });
    record('a.contentAfterRects', await contentOps(rects.bytes, 0));
    record('a.contentAfterAnnotAll', await contentOps(annotAll.bytes, 0));
  });

  test('(b) token split across text objects and TJ arrays; TJ split keeps positions', async () => {
    const b = await newDoc();
    const w = b.font.widthOfTextAtSize('SECRET-', 14);
    addPage(
      b,
      text(50, 250, 'SECRET-') +
        text(50 + w, 250, '7731') +
        'BT /F1 14 Tf 30 150 Td (HEAD-PUBLIC ) Tj [(SEC) -30 (RET-77)] TJ [(31) -300 (TAIL-PUBLIC)] TJ ET\n',
    );
    const bytes = await save(b.doc);
    const regions = await hitRegions(bytes, TOKEN);
    const before = await glyphs(bytes, 0);
    const tailX = (gs: typeof before) => {
      const i = gs
        .map((g) => g.text)
        .join('')
        .indexOf('TAIL-PUBLIC');
      return i < 0 ? undefined : round(gs[i]!.rect.x);
    };
    const res = await allMethods('b', bytes, regions, {
      sentinels: ['HEAD-PUBLIC', 'TAIL-PUBLIC'],
    });
    const after = await glyphs((await redact(bytes, regions, 'rects')).bytes, 0);
    record('b.regions', regions.length);
    record('b.tailX', { before: tailX(before), after: tailX(after) });
    record('b.content', await contentOps((await redact(bytes, regions, 'rects')).bytes, 0));
    for (const m of ALL_METHODS) {
      expect(res[m]!.textAnywhere, m).toBe(false);
      expect(res[m]!.sentinelsMissing, m).toEqual([]);
    }
  });

  test('(b/#801) one text object crossing two regions', async () => {
    const b = await newDoc();
    addPage(b, text(20, 200, `AAA ${TOKEN} BBB ${TOKEN} CCC`, 12));
    const bytes = await save(b.doc);
    const regions = await hitRegions(bytes, TOKEN);
    expect(regions).toHaveLength(2);
    const res = await allMethods('b801', bytes, regions, { sentinels: ['AAA', 'BBB', 'CCC'] });
    for (const m of ALL_METHODS) {
      expect(res[m]!.textAnywhere, m).toBe(false);
      expect(res[m]!.textInRegions, m).toBe('');
    }
    const g = await glyphs((await redact(bytes, regions, 'annot-all')).bytes, 0);
    record('b801.remaining', g.map((x) => x.text).join(''));
    // Applying one annotation at a time: the intermediate content stream written by the
    // first FPDFPage_GenerateContent becomes an unreachable object that saveAsCopy still
    // writes, and it holds the second (not yet redacted) token.
    const one = (await redact(bytes, regions, 'annot-one')).bytes;
    const orphans = await tokenStreams(one);
    record('b801.annotOneTokenStreams', orphans);
    expect(orphans).toHaveLength(1);
    expect(orphans[0]!.reachable).toBe(false);
    // Product scenario: two "Apply redactions" rounds through the adapter in one session.
    const id = nextId('two') as SourceId;
    await adapter.open(id, bytes.slice(0));
    for (const region of regions) {
      await adapter.createAnnotation(id, {
        kind: 'redact',
        pageIndex: 0,
        rect: region.rect,
        quads: [region.rect],
      });
      await adapter.applyRedactions(id);
    }
    const twoRounds = await adapter.save(id);
    await adapter.close(id);
    const twoRoundOrphans = await tokenStreams(twoRounds);
    record('b801.adapterTwoRoundsTokenStreams', twoRoundOrphans);
    // A PDFium round trip (open the saved copy, saveAsCopy again) drops unreachable objects.
    const again = await openDoc(twoRounds);
    let roundTrip: ArrayBuffer;
    try {
      roundTrip = await engine.saveAsCopy(again).toPromise();
    } finally {
      await engine.closeDocument(again).toPromise();
    }
    record('b801.afterPdfiumRoundTrip', await tokenStreams(roundTrip));
    expect(await tokenStreams(roundTrip)).toEqual([]);
  });

  test('(c) partially covered glyphs', async () => {
    const b = await newDoc();
    addPage(b, text(50, 200, 'CONFIDENTIALWORD', 20) + text(50, 120, 'TOPSLICEWORD', 20));
    const bytes = await save(b.doc);
    const [word] = await hitRegions(bytes, 'CONFIDENTIALWORD', 0);
    const [slice] = await hitRegions(bytes, 'TOPSLICEWORD', 0);
    // Left 40% of the first word; top 30% (a horizontal strip) of the second word.
    const left: Region = {
      pageIndex: 0,
      rect: { ...word!.rect, width: word!.rect.width * 0.4 },
    };
    const top: Region = {
      pageIndex: 0,
      rect: {
        x: slice!.rect.x,
        y: slice!.rect.y + slice!.rect.height * 0.7,
        width: slice!.rect.width,
        height: slice!.rect.height * 0.3,
      },
    };
    const out: Record<string, string> = {};
    for (const m of ALL_METHODS) {
      const r = await redact(bytes, [left, top], m);
      out[m] = (await glyphs(r.bytes, 0)).map((x) => x.text).join('');
      if (m === 'rects') {
        record('c.render', {
          after: await render(r.bytes, 0, { left: left.rect, strip: top.rect }, 'c-after-rects'),
        });
      }
    }
    await render(bytes, 0, {}, 'c-before');
    record('c.remainingText', out);
    record('c.rects', { left: left.rect, top: top.rect });
  });

  test('(d) text inside a Form XObject shared by two pages', async () => {
    const b = await newDoc();
    const fontDict = b.doc.context.obj({ F1: b.font.ref });
    const fx = b.doc.context.register(
      b.doc.context.flateStream(text(0, 10, TOKEN), {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 0, 200, 40],
        Resources: { Font: fontDict },
      }),
    );
    const draw = 'q 1 0 0 1 50 190 cm /Fx1 Do Q\n';
    addPage(b, draw + text(50, 100, 'KEEP-ME'), { xobjects: { Fx1: fx } });
    addPage(b, draw + text(50, 100, 'PAGE-TWO'), { xobjects: { Fx1: fx } });
    const bytes = await save(b.doc);
    const regions = (await hitRegions(bytes, TOKEN)).filter((r) => r.pageIndex === 0);
    expect(regions).toHaveLength(1);
    const res = await allMethods('d', bytes, regions, {
      sentinels: ['KEEP-ME', 'PAGE-TWO'],
      methods: ['rects', 'rects-noforms', 'annot-all', 'adapter'],
    });
    const perPage: Record<string, number[]> = {};
    for (const m of ['rects', 'rects-noforms', 'annot-all'] as const) {
      const r = await redact(bytes, regions, m);
      const doc = await openDoc(r.bytes);
      try {
        const s = await engine.searchAllPages(doc, TOKEN, { flags: [] }).toPromise();
        perPage[m] = s.results.map((x) => x.pageIndex);
      } finally {
        await engine.closeDocument(doc).toPromise();
      }
      const lib = await PDFDocument.load(r.bytes.slice(0), { updateMetadata: false });
      const xo = lib
        .getPages()
        .map((p) =>
          p.node
            .Resources()
            ?.lookupMaybe(PDFName.of('XObject'), PDFDict)
            ?.get(PDFName.of('Fx1'))
            ?.toString(),
        );
      perPage[`${m}.xobjectRefs`] = xo.map((x) => Number(x?.split(' ')[0] ?? -1));
    }
    record('d.searchPagesAfter', perPage);
    record(
      'd.page0OpsAfterRects',
      (await contentOps((await redact(bytes, regions, 'rects')).bytes, 0)).replace(/\s+/g, ' '),
    );
    record(
      'd.tokenStreamsAfterRects',
      await tokenStreams((await redact(bytes, regions, 'rects')).bytes),
    );
    expect(res.rects!.textInRegions).toBe('');
    // Copy-on-write: page 0 gets a redacted copy of the form, page 1 keeps the original.
    expect(perPage.rects).toEqual([1]);
    expect(perPage['rects-noforms']).toEqual([0, 1]);
    expect(perPage['annot-all']).toEqual([1]);
  });

  test('(e) raster images partially and fully covered', async () => {
    const b = await newDoc();
    const red = solidImage(b.doc, 60, 40, [200, 30, 30]);
    const blue = solidImage(b.doc, 60, 40, [30, 30, 200]);
    addPage(
      b,
      'q 150 0 0 100 40 150 cm /ImR Do Q q 150 0 0 100 220 150 cm /ImB Do Q\n' +
        text(50, 60, 'KEEP-ME'),
      { xobjects: { ImR: red, ImB: blue } },
    );
    const bytes = await save(b.doc);
    const partial: Region = { pageIndex: 0, rect: { x: 40, y: 150, width: 75, height: 100 } };
    const full: Region = { pageIndex: 0, rect: { x: 215, y: 145, width: 160, height: 110 } };
    const probes = {
      redCovered: partial.rect,
      redUncovered: { x: 120, y: 155, width: 65, height: 90 },
      blueCovered: { x: 222, y: 152, width: 146, height: 96 },
    };
    const orig: [number, number, number][] = [
      [200, 30, 30],
      [30, 30, 200],
    ];
    const lib0 = await PDFDocument.load(bytes.slice(0), { updateMetadata: false });
    const out: Record<string, unknown> = {
      before: {
        images: await imageStats(lib0, 0, orig),
        render: await render(bytes, 0, probes, 'e-before'),
      },
    };
    for (const m of ALL_METHODS) {
      const r = await redact(bytes, [partial, full], m);
      const lib = await PDFDocument.load(r.bytes.slice(0), { updateMetadata: false });
      out[m] = {
        applied: r.applied,
        images: await imageStats(lib, 0, orig),
        render: await render(r.bytes, 0, probes, `e-after-${m}`),
        ops: (await contentOps(r.bytes, 0)).replace(/\s+/g, ' ').slice(0, 400),
      };
    }
    record('e', out);
    const imgs = (out.rects as { images: ImageStat[] }).images;
    // Pixels under the area are overwritten with white in the image data; a fully covered
    // image stays as an all-white image (not removed).
    expect(imgs.map((i) => [i.white, i.original])).toEqual([
      [0.5, 0.5],
      [1, 0],
    ]);
    record('e.allImagesInFile', {
      before: await allImages(bytes, orig),
      rects: await allImages((await redact(bytes, [partial, full], 'rects')).bytes, orig),
      annotAll: await allImages((await redact(bytes, [partial, full], 'annot-all')).bytes, orig),
    });
  });

  test('(e/jpeg) DCT image in images.pdf page 3, quarter covered', async () => {
    const bytes = await (await fetch(imagesUrl)).arrayBuffer();
    const lib0 = await PDFDocument.load(bytes.slice(0), { updateMetadata: false });
    const before = await imageStats(lib0, 2, []);
    const [w, h] = [612, 792];
    const region: Region = { pageIndex: 2, rect: { x: 0, y: h / 2, width: w / 2, height: h / 2 } };
    const out: Record<string, unknown> = { before };
    for (const m of ['rects', 'annot-all'] as const) {
      const r = await redact(bytes, [region], m);
      const lib = await PDFDocument.load(r.bytes.slice(0), { updateMetadata: false });
      out[m] = {
        images: await imageStats(lib, 2, []),
        render: await render(r.bytes, 2, { quarter: region.rect }, `e-jpeg-after-${m}`),
        sizeBefore: bytes.byteLength,
        sizeAfter: r.bytes.byteLength,
      };
    }
    record('e.jpeg', out);
  });

  test('(f) inline image under the area', async () => {
    const b = await newDoc();
    const green = '00C800'.repeat(16);
    addPage(
      b,
      `q 150 0 0 100 50 100 cm BI /W 4 /H 4 /BPC 8 /CS /RGB /F /AHx ID ${green}> EI Q\n` +
        text(50, 50, 'KEEP-ME'),
    );
    const bytes = await save(b.doc);
    const region: Region = { pageIndex: 0, rect: { x: 50, y: 100, width: 75, height: 100 } };
    const probes = { covered: region.rect, uncovered: { x: 130, y: 105, width: 65, height: 90 } };
    const out: Record<string, unknown> = { before: await render(bytes, 0, probes, 'f-before') };
    for (const m of ALL_METHODS) {
      const r = await redact(bytes, [region], m);
      out[m] = {
        render: await render(r.bytes, 0, probes, `f-after-${m}`),
        ops: (await contentOps(r.bytes, 0)).replace(/\s+/g, ' ').slice(0, 300),
      };
    }
    record('f', out);
  });

  test('(g) vector paths under the area', async () => {
    const b = await newDoc();
    addPage(
      b,
      '0 0.6 0 rg 50 100 300 100 re f\n1 0 0 RG 4 w 50 50 m 350 250 l S\n' +
        text(50, 30, 'KEEP-ME'),
    );
    const bytes = await save(b.doc);
    const region: Region = { pageIndex: 0, rect: { x: 150, y: 120, width: 100, height: 60 } };
    const probes = {
      covered: { x: 155, y: 125, width: 20, height: 20 },
      uncovered: { x: 60, y: 110, width: 40, height: 40 },
    };
    const out: Record<string, unknown> = { before: await render(bytes, 0, probes, 'g-before') };
    for (const m of ALL_METHODS) {
      const r = await redact(bytes, [region], m);
      out[m] = {
        render: await render(r.bytes, 0, probes, `g-after-${m}`),
        ops: (await contentOps(r.bytes, 0)).replace(/\s+/g, ' ').slice(0, 300),
      };
    }
    record('g', out);
    // Paths are neither removed nor clipped: the text-only pass leaves the stream alone and
    // the annotation pass only paints its fill on top.
    expect((out.rects as { ops: string }).ops).toContain('50 100 300 100 re f');
    expect((out['annot-all'] as { ops: string }).ops).toContain('50 100 300 100 re f');
  });

  test('(h) link, note (+popup) and highlight overlapping the area', async () => {
    const b = await newDoc();
    const p = addPage(b, text(50, 200, TOKEN) + text(50, 60, 'KEEP-ME'));
    const ctx = b.doc.context;
    const pageRef = p.ref;
    const link = ctx.register(
      ctx.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [45, 195, 160, 215],
        Border: [0, 0, 0],
        A: { S: 'URI', URI: PDFString.of(`https://example.com/${TOKEN}`) },
      }),
    );
    const popup = ctx.register(
      ctx.obj({ Type: 'Annot', Subtype: 'Popup', Rect: [200, 150, 350, 250], P: pageRef }),
    );
    const note = ctx.register(
      ctx.obj({
        Type: 'Annot',
        Subtype: 'Text',
        Rect: [100, 195, 120, 215],
        Contents: PDFString.of(`note about ${TOKEN}`),
        T: PDFString.of('Reviewer'),
        Popup: popup,
        NM: PDFString.of('note-1'),
        P: pageRef,
      }),
    );
    (ctx.lookup(popup) as PDFDict).set(PDFName.of('Parent'), note);
    const hl = ctx.register(
      ctx.obj({
        Type: 'Annot',
        Subtype: 'Highlight',
        Rect: [48, 196, 140, 214],
        QuadPoints: [48, 214, 140, 214, 48, 196, 140, 196],
        C: [1, 1, 0],
        Contents: PDFString.of(`highlighted ${TOKEN}`),
        NM: PDFString.of('hl-1'),
        P: pageRef,
      }),
    );
    const square = ctx.register(
      ctx.obj({
        Type: 'Annot',
        Subtype: 'Square',
        Rect: [300, 20, 380, 60],
        C: [0, 0, 1],
        NM: PDFString.of('sq-1'),
        P: pageRef,
      }),
    );
    p.node.set(PDFName.of('Annots'), ctx.obj([link, note, popup, hl, square]));
    const bytes = await save(b.doc);
    const regions = await hitRegions(bytes, TOKEN, 2);
    record('h.before', await inspect(bytes, { regions }));
    const res = await allMethods('h', bytes, regions, { sentinels: ['KEEP-ME'] });
    for (const m of ALL_METHODS) {
      // No annotation is touched by the engine: all post-pass work.
      expect(res[m]!.annotations[0], m).toEqual(['link', 'text', 'highlight', 'square']);
      expect(res[m]!.pdfLibStrings.length, m).toBe(3);
    }
  });

  test('(i) form field widget with a value inside the area', async () => {
    const b = await newDoc();
    const p = addPage(b, text(50, 60, 'KEEP-ME'));
    const form = b.doc.getForm();
    const field = form.createTextField('ssn');
    field.setText(TOKEN);
    field.addToPage(p, { x: 50, y: 190, width: 200, height: 24, font: b.font });
    form.updateFieldAppearances(b.font);
    const bytes = await save(b.doc);
    const region: Region = { pageIndex: 0, rect: { x: 45, y: 185, width: 210, height: 34 } };
    const probes = { widget: { x: 52, y: 192, width: 196, height: 20 } };
    record('i.before', {
      ...(await inspect(bytes, { regions: [region] })),
      render: await render(bytes, 0, probes, 'i-before'),
    });
    const res = await allMethods('i', bytes, [region], { sentinels: ['KEEP-ME'] });
    const r = await redact(bytes, [region], 'annot-all');
    record('i.renderAfterAnnotAll', await render(r.bytes, 0, probes, 'i-after-annot-all'));
    const id = nextId('frm') as SourceId;
    await adapter.open(id, r.bytes.slice(0));
    const fields = await adapter.listFormFields(id);
    record('i.fieldsAfter', fields);
    expect(fields[0]?.value).toBe(TOKEN);
    await adapter.close(id);
    expect(res['annot-all']!.pdfLibStrings.length).toBeGreaterThan(0);
  });

  test('(j) document-level channels: outline, Info, XMP, dests, ActualText/Alt, attachments', async () => {
    const b = await newDoc();
    const { doc } = b;
    const ctx = doc.context;
    const p = addPage(
      b,
      `/P <</MCID 0>> BDC ${text(50, 200, TOKEN)} EMC\n` + text(50, 60, 'KEEP-ME'),
    );
    p.node.set(PDFName.of('StructParents'), ctx.obj(0));
    doc.setTitle(`Report ${TOKEN}`);
    doc.setSubject(`About ${TOKEN}`);
    doc.setKeywords([TOKEN]);
    // XMP
    const xmp = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title><rdf:Alt><rdf:li xml:lang="x-default">Report ${TOKEN}</rdf:li></rdf:Alt></dc:title></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
    doc.catalog.set(
      PDFName.of('Metadata'),
      ctx.register(ctx.stream(xmp, { Type: 'Metadata', Subtype: 'XML' })),
    );
    // Outline
    const outlines = ctx.nextRef();
    const item = ctx.register(
      ctx.obj({ Title: PDFString.of(`Chapter ${TOKEN}`), Parent: outlines, Dest: [p.ref, 'Fit'] }),
    );
    ctx.assign(outlines, ctx.obj({ Type: 'Outlines', First: item, Last: item, Count: 1 }));
    doc.catalog.set(PDFName.of('Outlines'), outlines);
    // Named destination (name tree) + FileAttachment annotation + EmbeddedFiles
    const efStream = ctx.register(
      ctx.flateStream(`attachment body ${TOKEN}`, { Type: 'EmbeddedFile' }),
    );
    const fs = ctx.register(
      ctx.obj({
        Type: 'Filespec',
        F: PDFString.of('annot.txt'),
        UF: PDFString.of('annot.txt'),
        EF: { F: efStream },
      }),
    );
    const fa = ctx.register(
      ctx.obj({
        Type: 'Annot',
        Subtype: 'FileAttachment',
        Rect: [300, 20, 320, 40],
        FS: fs,
        Contents: PDFString.of(`file ${TOKEN}`),
        NM: PDFString.of('fa-1'),
        P: p.ref,
      }),
    );
    p.node.set(PDFName.of('Annots'), ctx.obj([fa]));
    await doc.attach(enc.encode(`embedded ${TOKEN}`), 'secret.txt', {
      mimeType: 'text/plain',
      description: `desc ${TOKEN}`,
    });
    // pdf-lib builds /Names /EmbeddedFiles on save; add /Dests to the same /Names dict then.
    const destsTree = ctx.obj({ Names: [PDFString.of(TOKEN), ctx.obj([p.ref, 'Fit'])] });
    // Structure tree with /ActualText and /Alt
    const root = ctx.nextRef();
    const elem = ctx.register(
      ctx.obj({
        Type: 'StructElem',
        S: 'P',
        P: root,
        Pg: p.ref,
        K: 0,
        ActualText: PDFString.of(TOKEN),
        Alt: PDFString.of(`alt ${TOKEN}`),
      }),
    );
    ctx.assign(
      root,
      ctx.obj({
        Type: 'StructTreeRoot',
        K: [elem],
        ParentTree: ctx.obj({ Nums: [0, ctx.obj([elem])] }),
      }),
    );
    doc.catalog.set(PDFName.of('StructTreeRoot'), root);
    doc.catalog.set(PDFName.of('MarkInfo'), ctx.obj({ Marked: true }));
    const saved1 = await save(doc);
    // Add /Dests to /Names after pdf-lib wrote the attachment tree.
    const doc2 = await PDFDocument.load(saved1, { updateMetadata: false });
    const names = doc2.catalog.lookupMaybe(PDFName.of('Names'), PDFDict)!;
    names.set(PDFName.of('Dests'), doc2.context.register(destsTree.clone(doc2.context)));
    const fixDest = doc2.context.lookup(names.get(PDFName.of('Dests')), PDFDict);
    (fixDest.lookup(PDFName.of('Names'), PDFArray).get(1) as PDFArray).set(
      0,
      doc2.getPages()[0]!.ref,
    );
    const bytes = await save(doc2);
    const regions = (await hitRegions(bytes, TOKEN)).filter((r) => r.pageIndex === 0);
    const before = await inspect(bytes, { regions });
    record('j.before', before);
    const res = await allMethods('j', bytes, regions, { sentinels: ['KEEP-ME'] });
    for (const m of ALL_METHODS) {
      // Page content is clean, everything document-level is untouched.
      expect(res[m]!.textAnywhere, m).toBe(false);
      expect(res[m]!.pdfLibStrings.length, m).toBeGreaterThan(0);
      expect(res[m]!.inflatedStreams, m).toBeGreaterThan(0);
    }
    const scrubbed = await scrubPrototype(
      (await redact(bytes, regions, 'annot-all')).bytes,
      [TOKEN],
      regions,
    );
    const clean = await inspect(scrubbed, { regions, sentinels: ['KEEP-ME'] });
    record('j.afterPrototypeScrub', clean);
    record('j.afterPrototypeScrubTokenStreams', await tokenStreams(scrubbed));
    // What happened to the structure tree (ActualText/Alt no longer reported after save)?
    const engineOut = (await redact(bytes, regions, 'annot-all')).bytes;
    const libAfter = await PDFDocument.load(engineOut.slice(0), { updateMetadata: false });
    const str = libAfter.catalog.lookupMaybe(PDFName.of('StructTreeRoot'), PDFDict);
    const kids = str?.lookupMaybe(PDFName.of('K'), PDFArray);
    record('j.structTreeAfterEngine', {
      hasStructTreeRoot: str !== undefined,
      hasMarkInfo: libAfter.catalog.get(PDFName.of('MarkInfo')) !== undefined,
      firstElem: kids
        ? libAfter.context.lookup(kids.get(0))?.toString().replace(/\s+/g, ' ')
        : undefined,
      pageOps: (await contentOps(engineOut, 0)).replace(/\s+/g, ' '),
    });
    record('j.tokenStreamsAfterEngine', await tokenStreams(engineOut));
    // The engine drops /ActualText and /Alt of the element whose marked content it removed.
    expect(res['annot-all']!.pdfLibStrings.some((p) => p.endsWith('/ActualText'))).toBe(false);
    // Same file, no redaction: does saveAsCopy alone keep /ActualText?
    const plain = await openDoc(bytes);
    try {
      const saved = await engine.saveAsCopy(plain).toPromise();
      record('j.saveAsCopyWithoutRedaction', (await inspect(saved)).pdfLibStrings);
    } finally {
      await engine.closeDocument(plain).toPromise();
    }
    expect(clean.pdfLibStrings).toEqual([]);
    expect(clean.rawBytes).toEqual([]);
    expect(clean.inflatedStreams).toBe(0);
  });

  test('(k) incremental-update history containing the token', async () => {
    const b = await newDoc();
    addPage(b, text(50, 200, `OLD-REV ${TOKEN}`) + text(50, 60, 'KEEP-ME'));
    b.doc.setTitle(`Draft ${TOKEN}`);
    const rev1 = new Uint8Array(await save(b.doc));
    // Revision 2 by hand: a new page content stream (token moved), a new page object version
    // (same object number) and a new Info object; the old Info and old content stream become
    // orphans that live only in revision 1.
    const lib = await PDFDocument.load(rev1.slice(), { updateMetadata: false });
    const pageRef = lib.getPages()[0]!.ref;
    const pageDict = lib.context.lookup(pageRef, PDFDict).clone(lib.context);
    const size = lib.context.largestObjectNumber + 1;
    const contentNum = size;
    const infoNum = size + 1;
    const newContent = text(50, 200, TOKEN) + text(50, 60, 'KEEP-ME');
    pageDict.set(PDFName.of('Contents'), PDFRef.of(contentNum));
    const rootRef = lib.context.trailerInfo.Root as PDFRef;
    const prevXref = Number(/startxref\s+(\d+)/.exec(latin1.decode(rev1.slice(-64)))![1]);
    const parts: string[] = [];
    let offset = rev1.length;
    const offsets: Record<number, number> = {};
    const emit = (num: number, body: string) => {
      const s = `\n${num} 0 obj\n${body}\nendobj\n`;
      offsets[num] = offset + 1;
      parts.push(s);
      offset += s.length;
    };
    emit(pageRef.objectNumber, pageDict.toString());
    emit(contentNum, `<< /Length ${newContent.length} >>\nstream\n${newContent}\nendstream`);
    emit(infoNum, '<< /Title (Final title) /Producer (spike) >>');
    const xrefAt = offset;
    const line = (n: number) => `${String(offsets[n]).padStart(10, '0')} 00000 n\r\n`;
    parts.push(
      `xref\n0 1\n0000000000 65535 f\r\n${pageRef.objectNumber} 1\n${line(pageRef.objectNumber)}` +
        `${contentNum} 2\n${line(contentNum)}${line(infoNum)}` +
        `trailer\n<< /Size ${infoNum + 1} /Root ${rootRef.toString()} /Info ${infoNum} 0 R /Prev ${prevXref} >>\n` +
        `startxref\n${xrefAt}\n%%EOF\n`,
    );
    const tail = enc.encode(parts.join(''));
    const incr = new Uint8Array(rev1.length + tail.length);
    incr.set(rev1);
    incr.set(tail, rev1.length);
    const bytes = incr.buffer;
    const regions = await hitRegions(bytes, TOKEN);
    expect(regions).toHaveLength(1);
    const before = await inspect(bytes, { regions });
    record('k.before', { ...before, oldRev: grep(incr, 'OLD-REV'), draft: grep(incr, 'Draft') });
    const out: Record<string, unknown> = {};
    for (const m of ALL_METHODS) {
      const r = await redact(bytes, regions, m);
      const raw = new Uint8Array(r.bytes);
      const orphanStreams = streamsOf(raw).filter((s) => grep(s.data, 'OLD-REV').length > 0).length;
      out[m] = {
        ...(await inspect(r.bytes, { regions })),
        oldRevContentStreams: orphanStreams,
        oldInfoTitle: grep(raw, `Draft ${TOKEN}`),
      };
    }
    record('k', out);
    for (const m of ALL_METHODS) {
      const c = out[m] as Channels & { oldRevContentStreams: number; oldInfoTitle: string[] };
      expect(c.hasPrev, m).toBe(false);
      expect(c.eofMarkers, m).toBe(1);
      expect(c.oldRevContentStreams, m).toBe(0);
      expect(c.oldInfoTitle, m).toEqual([]);
    }
    // Prototype: pdf-lib load + dropUnreachable + full save drops the orphans.
    const r = await redact(bytes, regions, 'annot-all');
    const cleaned = await PDFDocument.load(r.bytes.slice(0), { updateMetadata: false });
    dropUnreachable(cleaned);
    const rewritten = new Uint8Array(await save(cleaned));
    record('k.afterDropUnreachable', {
      ...(await inspect(rewritten.buffer, { regions })),
      oldRevContentStreams: streamsOf(rewritten).filter((s) => grep(s.data, 'OLD-REV').length > 0)
        .length,
    });
  });

  test('(k2) unreferenced objects in a single-revision file', async () => {
    const b = await newDoc();
    addPage(b, text(50, 200, TOKEN) + text(50, 60, 'KEEP-ME'));
    const ctx = b.doc.context;
    ctx.register(ctx.obj({ Orphan: PDFString.of(`orphan dict ${TOKEN}`) }));
    ctx.register(ctx.flateStream(`orphan stream ${TOKEN}`));
    const bytes = await save(b.doc);
    const regions = await hitRegions(bytes, TOKEN);
    const plain = await openDoc(bytes);
    let unchanged: ArrayBuffer;
    try {
      unchanged = await engine.saveAsCopy(plain).toPromise();
    } finally {
      await engine.closeDocument(plain).toPromise();
    }
    record('k2', {
      before: await inspect(bytes),
      saveAsCopyOnly: await inspect(unchanged),
      afterAnnotAll: await inspect((await redact(bytes, regions, 'annot-all')).bytes, { regions }),
    });
  });

  test('(l) invisible text (render mode 3, OCR layer)', async () => {
    const b = await newDoc();
    addPage(
      b,
      '0.8 g 40 180 200 40 re f 0 g\n' +
        `BT /F1 14 Tf 3 Tr 50 200 Td (${TOKEN}) Tj ET\n` +
        `BT /F1 14 Tf 3 Tr 50 150 Td (INVISIBLE-KEEP) Tj ET\n` +
        text(50, 60, 'KEEP-ME'),
    );
    const bytes = await save(b.doc);
    const regions = await hitRegions(bytes, TOKEN);
    expect(regions).toHaveLength(1);
    const res = await allMethods('l', bytes, regions, { sentinels: ['KEEP-ME', 'INVISIBLE-KEEP'] });
    for (const m of ALL_METHODS) expect(res[m]!.textAnywhere, m).toBe(false);
  });

  test('(m) /Rotate 90 page: rects are display (device) space, converted by the engine', async () => {
    const b = await newDoc();
    addPage(b, text(50, 200, TOKEN) + text(50, 60, 'KEEP-ME'), { rotate: 90 });
    const bytes = await save(b.doc);
    const regions = await hitRegions(bytes, TOKEN);
    expect(regions).toHaveLength(1);
    const res = await allMethods('m', bytes, regions, { sentinels: ['KEEP-ME'] });
    for (const m of ALL_METHODS) expect(res[m]!.textAnywhere, m).toBe(false);
    // Passing the user-space rect unconverted (as if it were device space) misses.
    const doc = await openDoc(bytes);
    try {
      const p = page(doc, 0);
      const r = regions[0]!.rect;
      await engine
        .redactTextInRects(doc, p, [
          { origin: { x: r.x, y: r.y }, size: { width: r.width, height: r.height } },
        ])
        .toPromise();
      const out = await engine.saveAsCopy(doc).toPromise();
      record('m.unconvertedRect', await inspect(out, { regions }));
    } finally {
      await engine.closeDocument(doc).toPromise();
    }
    await render(bytes, 0, {}, 'm-before');
    await render((await redact(bytes, regions, 'annot-all')).bytes, 0, {}, 'm-after-annot-all');
  });
});

describe('redaction spike: fill, overlay, black boxes, timing', () => {
  test('annotation fill colour (/IC), overlay text and the adapter mapping', async () => {
    const b = await newDoc();
    addPage(b, text(50, 200, TOKEN) + text(50, 60, 'KEEP-ME'));
    const bytes = await save(b.doc);
    const regions = await hitRegions(bytes, TOKEN, 3);
    const probe = { box: regions[0]!.rect };
    const variantsOut: Record<string, unknown> = {};
    const cases: Record<string, Partial<PdfRedactAnnoObject>> = {
      black: { color: '#000000' },
      red: { color: '#FF0000' },
      noIC: { color: 'transparent' },
      overlay: {
        color: '#000000',
        overlayText: 'REDACTED',
        overlayColor: '#FFFFFF',
        fontSize: 10,
      },
    };
    for (const [name, extra] of Object.entries(cases)) {
      const r = await redact(bytes, regions, 'annot-all', extra);
      variantsOut[name] = {
        render: await render(r.bytes, 0, probe, `fill-${name}`),
        text: (await glyphs(r.bytes, 0)).map((g) => g.text).join(''),
        ops: (await contentOps(r.bytes, 0)).replace(/\s+/g, ' ').slice(0, 400),
      };
    }
    const adapterRun = await redact(bytes, regions, 'adapter');
    variantsOut.adapter = {
      render: await render(adapterRun.bytes, 0, probe, 'fill-adapter'),
      ops: (await contentOps(adapterRun.bytes, 0)).replace(/\s+/g, ' ').slice(0, 400),
    };
    const rects = await redact(bytes, regions, 'rects');
    variantsOut.rectsDrawBlackBoxesTrue = {
      render: await render(rects.bytes, 0, probe, 'fill-rects-drawBlackBoxes'),
      ops: (await contentOps(rects.bytes, 0)).replace(/\s+/g, ' ').slice(0, 400),
    };
    // The raw EPDFText_RedactInRect with draw_black_boxes = true (the engine wrapper
    // hard-codes false; see the report).
    variantsOut.nativeDrawBlackBoxes = await nativeRedactInRect(bytes, regions[0]!, true);
    // What a pending /Redact annotation looks like before apply (IC, OverlayText, AP?).
    const doc = await openDoc(bytes);
    try {
      const p = page(doc, 0);
      await engine
        .createPageAnnotation(doc, p, redactAnno(p, [regions[0]!.rect], cases.overlay))
        .toPromise();
      const pending = await engine.saveAsCopy(doc).toPromise();
      const lib = await PDFDocument.load(pending.slice(0), { updateMetadata: false });
      const annots = lib.getPages()[0]!.node.Annots();
      const dict = annots ? lib.context.lookup(annots.get(0), PDFDict) : undefined;
      variantsOut.pendingAnnotDict = dict?.toString().replace(/\s+/g, ' ').slice(0, 600);
      variantsOut.pendingRender = await render(pending, 0, probe, 'fill-pending-mark');
      const ro = dict?.get(PDFName.of('RO'));
      const roStream = ro instanceof PDFRef ? lib.context.lookup(ro) : undefined;
      if (roStream instanceof PDFRawStream) {
        const f = roStream.dict.get(PDFName.of('Filter'))?.toString() ?? '';
        variantsOut.pendingRO = {
          dict: roStream.dict.toString().replace(/\s+/g, ' '),
          ops: latin1.decode(
            f.includes('Flate') ? unzlibSync(roStream.contents) : roStream.contents,
          ),
        };
      }
    } finally {
      await engine.closeDocument(doc).toPromise();
    }
    record('fill', variantsOut);
    interface Fill {
      render: { box: PixelStat };
    }
    const box = (k: string) => (variantsOut[k] as Fill).render.box;
    expect(box('black').dark).toBe(1);
    expect(box('red').mean).toEqual([255, 0, 0]); // /IC honoured
    expect(box('noIC').white).toBe(1); // no /IC: content removed, nothing painted
    expect(box('overlay').white).toBe(0); // /OverlayText is not drawn
    // Found here: the adapter mapping wrote /C and /OC but never /IC, so nothing was painted.
    // Fixed in M4 (annotation-mapping.ts: /IC defaults to black).
    expect(box('adapter').dark).toBe(1);
    expect(box('rectsDrawBlackBoxesTrue').white).toBe(1); // option ignored by the wrapper
    expect((variantsOut.nativeDrawBlackBoxes as Fill).render.box.dark).toBe(1);
  });

  test('prototype: removing vector paths with raw PDFium page-object calls', async () => {
    const b = await newDoc();
    addPage(
      b,
      '0 0.6 0 rg 50 100 300 100 re f\n1 0 0 RG 4 w 50 50 m 350 250 l S\n' +
        '0 0 1 rg 170 130 40 30 re f\n0 g\n' +
        text(50, 30, 'KEEP-ME'),
    );
    const bytes = await save(b.doc);
    const region: Region = { pageIndex: 0, rect: { x: 150, y: 120, width: 100, height: 60 } };
    const out: Record<string, unknown> = {};
    for (const mode of ['covered', 'touched'] as const) {
      const r = await nativeRemovePaths(bytes, region, mode);
      out[mode] = {
        removed: r.removed,
        render: await render(
          r.bytes,
          0,
          { region: region.rect, bar: { x: 60, y: 110, width: 40, height: 40 } },
          `paths-remove-${mode}`,
        ),
        ops: (await contentOps(r.bytes, 0)).replace(/\s+/g, ' '),
      };
    }
    record('paths', out);
  });

  test('timing: many-pages fixture page and a dense synthetic page', async () => {
    const many = await (await fetch(manyPagesUrl)).arrayBuffer();
    const regionsMany = (await hitRegions(many, '200')).filter((r) => r.pageIndex === 199);
    const t: Record<string, number> = {};
    for (const m of ['rects', 'annot-all'] as const) {
      const r = await redact(many, regionsMany, m);
      t[`many-pages p200 ${m} apply ms`] = round(r.ms);
      const t0 = performance.now();
      const doc = await openDoc(many);
      const p = page(doc, 199);
      await engine.createPageAnnotation(doc, p, redactAnno(p, [regionsMany[0]!.rect])).toPromise();
      await engine.applyAllRedactions(doc, p).toPromise();
      await engine.saveAsCopy(doc).toPromise();
      await engine.closeDocument(doc).toPromise();
      t[`many-pages open+apply+save ${m} ms`] = round(performance.now() - t0);
    }
    const b = await newDoc();
    let ops = '';
    for (let i = 0; i < 3000; i++)
      ops += text(10 + (i % 5) * 110, 10 + Math.floor(i / 5) * 1.3, `W${i}X`, 6);
    addPage(b, ops + text(250, 400, TOKEN), { size: [600, 800] });
    const dense = await save(b.doc);
    const regions = await hitRegions(dense, TOKEN);
    for (const m of ['rects', 'annot-all'] as const) {
      const r = await redact(dense, regions, m);
      t[`dense 3000 text objects ${m} apply ms`] = round(r.ms);
    }
    const twenty = Array.from(
      { length: 20 },
      (_, i): Region => ({
        pageIndex: 0,
        rect: { x: 10 + (i % 5) * 110, y: 10 + i * 30, width: 60, height: 8 },
      }),
    );
    t['dense 20 annotations applyAllRedactions ms'] = round(
      (await redact(dense, twenty, 'annot-all')).ms,
    );
    record('timing', t);
  });
});

// ---------------------------------------------------------------------------------------
// Low-level probe: EPDFText_RedactInRect with draw_black_boxes = true
// ---------------------------------------------------------------------------------------

interface HeapAccess {
  setValue(ptr: number, value: number, type: 'float'): void;
  getValue(ptr: number, type: 'float'): number;
}

interface NativeInternals {
  readonly pdfiumModule: WrappedPdfiumModule;
  readonly memoryManager: { malloc(n: number): number; free(p: number): void };
  readonly cache: {
    getContext(
      id: string,
    ): { acquirePage(i: number): { pagePtr: number; disposeImmediate(): void } } | undefined;
  };
}

async function nativeRedactInRect(bytes: ArrayBuffer, region: Region, draw: boolean) {
  const doc = await openDoc(bytes);
  try {
    const n = native as unknown as NativeInternals;
    const pageCtx = n.cache.getContext(doc.id)!.acquirePage(region.pageIndex);
    const ptr = n.memoryManager.malloc(16);
    const { x, y, width, height } = region.rect;
    // FS_RECTF { left, top, right, bottom } in PDF page space.
    const heap = n.pdfiumModule.pdfium as unknown as HeapAccess;
    heap.setValue(ptr, x, 'float');
    heap.setValue(ptr + 4, y + height, 'float');
    heap.setValue(ptr + 8, x + width, 'float');
    heap.setValue(ptr + 12, y, 'float');
    const ok = n.pdfiumModule.EPDFText_RedactInRect(pageCtx.pagePtr, ptr, true, draw);
    n.memoryManager.free(ptr);
    const generated = n.pdfiumModule.FPDFPage_GenerateContent(pageCtx.pagePtr);
    pageCtx.disposeImmediate();
    const out = await engine.saveAsCopy(doc).toPromise();
    const annots = await (async () => {
      const d2 = await openDoc(out);
      try {
        return (await engine.getPageAnnotations(d2, page(d2, 0)).toPromise()).map(
          (a: PdfAnnotationObject) => PdfAnnotationSubtype[a.type],
        );
      } finally {
        await engine.closeDocument(d2).toPromise();
      }
    })();
    return {
      ok,
      generated,
      annots,
      render: await render(out, 0, { box: region.rect }, 'fill-native-drawBlackBoxes'),
      ops: (await contentOps(out, 0)).replace(/\s+/g, ' ').slice(0, 400),
      text: (await glyphs(out, 0)).map((g) => g.text).join(''),
    };
  } finally {
    await engine.closeDocument(doc).toPromise();
  }
}

/** Removes top-level path objects fully inside (`covered`) or intersecting (`touched`) a region. */
async function nativeRemovePaths(bytes: ArrayBuffer, region: Region, mode: 'covered' | 'touched') {
  const doc = await openDoc(bytes);
  try {
    const n = native as unknown as NativeInternals;
    const m = n.pdfiumModule;
    const pageCtx = n.cache.getContext(doc.id)!.acquirePage(region.pageIndex);
    const buf = n.memoryManager.malloc(16);
    const { x, y, width, height } = region.rect;
    let removed = 0;
    for (let i = m.FPDFPage_CountObjects(pageCtx.pagePtr) - 1; i >= 0; i--) {
      const obj = m.FPDFPage_GetObject(pageCtx.pagePtr, i);
      if (m.FPDFPageObj_GetType(obj) !== 2) continue; // FPDF_PAGEOBJ_PATH
      m.FPDFPageObj_GetBounds(obj, buf, buf + 4, buf + 8, buf + 12);
      const heap = m.pdfium as unknown as HeapAccess;
      const [l, bt, r, t] = [0, 4, 8, 12].map((o) => heap.getValue(buf + o, 'float'));
      const inside = l! >= x && r! <= x + width && bt! >= y && t! <= y + height;
      const touches = l! < x + width && r! > x && bt! < y + height && t! > y;
      if (mode === 'covered' ? inside : touches) {
        m.FPDFPage_RemoveObject(pageCtx.pagePtr, obj);
        m.FPDFPageObj_Destroy(obj);
        removed++;
      }
    }
    n.memoryManager.free(buf);
    m.FPDFPage_GenerateContent(pageCtx.pagePtr);
    pageCtx.disposeImmediate();
    return { removed, bytes: await engine.saveAsCopy(doc).toPromise() };
  } finally {
    await engine.closeDocument(doc).toPromise();
  }
}

// ---------------------------------------------------------------------------------------
// Post-pass prototype (pdf-lib): what the engine leaves, removed at document level
// ---------------------------------------------------------------------------------------

async function scrubPrototype(
  bytes: ArrayBuffer,
  secrets: readonly string[],
  regions: readonly Region[],
): Promise<ArrayBuffer> {
  const doc = await PDFDocument.load(bytes.slice(0), { updateMetadata: false });
  const ctx = doc.context;
  const has = (s: string) => secrets.some((t) => s.includes(t));
  const blank = (s: string) => secrets.reduce((acc, t) => acc.split(t).join('[redacted]'), s);
  // 1. Annotations overlapping a region, or carrying the secret, go (with their popups).
  doc.getPages().forEach((p, pageIndex) => {
    const annots = p.node.Annots();
    if (!annots) return;
    const keep: PDFObject[] = [];
    for (let i = 0; i < annots.size(); i++) {
      const ref = annots.get(i);
      const d = ctx.lookup(ref);
      if (!(d instanceof PDFDict)) continue;
      const r = d.lookupMaybe(PDFName.of('Rect'), PDFArray);
      const nums = r ? r.asArray().map((v) => Number(v.toString())) : [];
      const rect =
        nums.length === 4
          ? { x: nums[0]!, y: nums[1]!, width: nums[2]! - nums[0]!, height: nums[3]! - nums[1]! }
          : undefined;
      const overlaps = rect
        ? regions.some((g) => g.pageIndex === pageIndex && intersects(rect, g.rect))
        : false;
      const carries = stringHitsIn(d, has);
      if (!overlaps && !carries) keep.push(ref);
    }
    p.node.set(PDFName.of('Annots'), ctx.obj(keep));
  });
  // 2. XMP packets and attachments are dropped wholesale; Info rewritten.
  doc.catalog.delete(PDFName.of('Metadata'));
  const names = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
  names?.delete(PDFName.of('EmbeddedFiles'));
  doc.catalog.delete(PDFName.of('AF')); // pdf-lib's attach() also lists the filespec in /AF
  // 3. Every remaining string (outline titles, /ActualText, /Alt, name-tree keys, Info …)
  //    has the secret replaced. (Production: name-tree keys need re-sorting.)
  for (const [, obj] of ctx.enumerateIndirectObjects()) replaceStrings(obj, has, blank);
  replaceStrings(ctx.lookup(ctx.trailerInfo.Info) ?? PDFDict.withContext(ctx), has, blank);
  // 4. Garbage-collect and write a fresh file (no /Prev).
  dropUnreachable(doc);
  return save(doc);
}

function stringHitsIn(d: PDFDict, has: (s: string) => boolean): boolean {
  let found = false;
  const visit = (o: PDFObject, depth: number) => {
    if (found || depth > 6) return;
    const s = decodeString(o);
    if (s !== undefined) {
      found = has(s);
      return;
    }
    if (o instanceof PDFDict)
      for (const [k, v] of o.entries()) {
        if (k.decodeText() !== 'P' && k.decodeText() !== 'Parent') visit(v, depth + 1);
      }
    else if (o instanceof PDFArray) for (let i = 0; i < o.size(); i++) visit(o.get(i), depth + 1);
  };
  visit(d, 0);
  return found;
}

function replaceStrings(
  o: PDFObject,
  has: (s: string) => boolean,
  blank: (s: string) => string,
): void {
  const fix = (v: PDFObject): PDFObject | undefined => {
    const s = decodeString(v);
    return s !== undefined && has(s) ? PDFHexString.fromText(blank(s)) : undefined;
  };
  if (o instanceof PDFStream) replaceStrings(o.dict, has, blank);
  else if (o instanceof PDFDict) {
    for (const [k, v] of o.entries()) {
      const nv = fix(v);
      if (nv) o.set(k, nv);
      else replaceStrings(v, has, blank);
    }
  } else if (o instanceof PDFArray) {
    for (let i = 0; i < o.size(); i++) {
      const nv = fix(o.get(i));
      if (nv) o.set(i, nv);
      else replaceStrings(o.get(i), has, blank);
    }
  }
}
