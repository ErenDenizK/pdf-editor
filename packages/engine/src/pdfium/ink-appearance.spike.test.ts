/**
 * SPIKE S1 — variable-width ink appearance (docs/research/09-ink-appearance-spike.md, spec
 * experience-redesign.md §6.7). Evidence for P4, not a regression suite: it answers the
 * spec's four questions with the PDFium host's raw API (ADR-0011), our adapter, pdf.js and
 * pdf-lib, and prints what it measures as `[spike] …` lines. CI keeps running it while it
 * stays under about 60 s (about 15 s here); if it grows past that, gate it behind
 * an env flag like `VITE_ANALYSIS_PERF` instead. Replace it with P4's tests once
 * `annotations/ink-appearance.ts` exists.
 *
 * The outline comes from our own generator (`annotations/ink-outline.ts`), a pure function of
 * the centre line and the per-point widths: no `perfect-freehand` dependency was added.
 *
 * Width is measured across the stroke at fixed positions along it: the renderer's pixels
 * along the stroke normal are projected onto "white → expected colour" (coverage 0–1, pixels
 * of any other colour count 0), and the coverage is integrated over the normal in points.
 * The same function measures PDFium (our adapter's `renderPage`) and pdf.js (canvas render
 * with annotation appearances), on unrotated and rotated pages alike, through each
 * renderer's own user-space → pixel mapping.
 */
import {
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  type PDFObject,
  PDFRawStream,
  PDFRef,
  PDFString,
} from '@cantoo/pdf-lib';
import { zlibSync } from 'fflate';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfjsWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import sampleUrl from '../../../../docs/qa/samples/annotations-sample.pdf?url';
import annotationsUrl from '../../../../test/fixtures/annotations.pdf?url';
import cropboxUrl from '../../../../test/fixtures/cropbox.pdf?url';
import mixedSizesUrl from '../../../../test/fixtures/mixed-sizes.pdf?url';
import rotatedUrl from '../../../../test/fixtures/rotated-pages.pdf?url';
import simpleTextUrl from '../../../../test/fixtures/simple-text.pdf?url';
import taggedUrl from '../../../../test/fixtures/tagged.pdf?url';
import { makePdf, sid, vdoc, vpage, wasmUrl } from '../../test/helpers';
import {
  decodeInkWidths,
  encodeInkWidths,
  INK_WIDTHS_KEY,
  inkAppearanceContent,
  inkOutlineBounds,
  type InkPoint,
} from '../annotations/ink-outline';
import { PdfLibAssembler } from '../pdflib/pdflib-assembler';
import type { InkAnnotation, OpenedDocument } from '../types';
import { type PageGeometry, userToDevicePoint } from './coords';
import { createHostedEngine, type HostedEngine } from './host';
import {
  annotationAppearance,
  annotationString,
  setAnnotationAppearance,
} from './host/annot-appearance';
import { PdfiumAdapter } from './pdfium-adapter';

// ---------------------------------------------------------------------------
// Set-up
// ---------------------------------------------------------------------------

let host: HostedEngine;
let adapter: PdfiumAdapter;
let counter = 0;
const SCALE = 2;
const ZERO = { x: 0, y: 0, width: 0, height: 0 };
const NOMINAL = 4;

function log(label: string, value: unknown): void {
  // eslint-disable-next-line no-console -- spike measurements are the point of this file
  console.info(`[spike] ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
}

async function fetchBytes(url: string): Promise<ArrayBuffer> {
  return (await fetch(url)).arrayBuffer();
}

beforeAll(async () => {
  host = await createHostedEngine({ wasm: wasmUrl });
  adapter = new PdfiumAdapter({ wasmUrl, engineFactory: () => host.engine });
  pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;
});

afterAll(async () => {
  await adapter.destroy();
});

async function open(bytes: ArrayBuffer): Promise<{ id: string; opened: OpenedDocument }> {
  const id = `ink-spike-${++counter}`;
  const opened = await adapter.open(sid(id), bytes.slice(0));
  return { id, opened };
}

// ---------------------------------------------------------------------------
// Strokes
// ---------------------------------------------------------------------------

interface Taper {
  readonly from: InkPoint;
  readonly to: InkPoint;
  readonly startWidth: number;
  readonly endWidth: number;
}

/**
 * A straight stroke whose width grows linearly. The matrix entries `ink-variable` and
 * `rotated-ink-variable` in tools/qa/annotation-sample-plan.ts (P4) use the same shape: 25
 * points, 1 → 9 pt, nominal 4 pt, measured at 10/30/50/70/90 % with 0.6 pt tolerance.
 */
function taperStroke(t: Taper, points = 25): { path: InkPoint[]; widths: number[] } {
  const path: InkPoint[] = [];
  const widths: number[] = [];
  for (let i = 0; i < points; i++) {
    const k = i / (points - 1);
    path.push({ x: t.from.x + (t.to.x - t.from.x) * k, y: t.from.y + (t.to.y - t.from.y) * k });
    widths.push(t.startWidth + (t.endWidth - t.startWidth) * k);
  }
  return { path, widths };
}

const TAPER_AT = [0.1, 0.3, 0.5, 0.7, 0.9] as const;
const WIDTH_TOLERANCE = 0.6;

interface InkSpec {
  readonly pageIndex: number;
  readonly paths: readonly (readonly InkPoint[])[];
  readonly widths: readonly (readonly number[])[];
  readonly color: string;
  readonly opacity: number;
}

/** Writes our appearance, the outline's /Rect and `/PdfEditorInkWidths` through raw access. */
async function applyAppearance(id: string, annotationId: string, spec: InkSpec): Promise<string> {
  const content = inkAppearanceContent(spec);
  await host.withRawAccess(id, (raw) => {
    setAnnotationAppearance(raw, spec.pageIndex, annotationId, {
      content,
      rect: inkOutlineBounds(spec.paths, spec.widths),
      strings: { [INK_WIDTHS_KEY]: encodeInkWidths(spec.widths) },
    });
  });
  return content;
}

async function createInk(id: string, spec: InkSpec): Promise<InkAnnotation> {
  return (await adapter.createAnnotation(sid(id), {
    kind: 'ink',
    pageIndex: spec.pageIndex,
    rect: ZERO,
    paths: spec.paths,
    strokeWidth: NOMINAL,
    color: spec.color,
    opacity: spec.opacity,
  })) as InkAnnotation;
}

async function rawAppearance(id: string, pageIndex: number, annotationId: string): Promise<string> {
  return host.withRawAccess(id, (raw) => annotationAppearance(raw, pageIndex, annotationId));
}

async function rawWidths(
  id: string,
  pageIndex: number,
  annotationId: string,
): Promise<string | undefined> {
  return host.withRawAccess(id, (raw) =>
    annotationString(raw, pageIndex, annotationId, INK_WIDTHS_KEY),
  );
}

// ---------------------------------------------------------------------------
// Pixels
// ---------------------------------------------------------------------------

type Rgb = readonly [number, number, number];
type ToPixel = (p: InkPoint) => readonly [number, number];

interface Rendered {
  readonly raster: ImageData;
  readonly toPixel: ToPixel;
}

function rgbOf(hex: string, opacity = 1): Rgb {
  const c = (i: number) => Number.parseInt(hex.slice(i, i + 2), 16);
  return [1, 3, 5].map((i) => 255 - (255 - c(i)) * opacity) as unknown as Rgb;
}

/** Share (0–1) of the expected colour in a pixel; 0 for pixels of another colour. */
function pixelCoverage(r: ImageData, i: number, j: number, e: Rgb): number {
  if (i < 0 || j < 0 || i >= r.width || j >= r.height) return 0;
  const k = (j * r.width + i) * 4;
  const v = [0, 1, 2].map((c) => 255 - (r.data[k + c] ?? 255));
  const d = e.map((c) => 255 - c);
  const dd = d.reduce((s, x) => s + x * x, 0);
  if (dd === 0) return 0;
  const a = v.reduce((s, x, c) => s + x * (d[c] ?? 0), 0) / dd;
  const residual = Math.hypot(...v.map((x, c) => x - a * (d[c] ?? 0)));
  if (residual > 48) return 0;
  return Math.min(Math.max(a, 0), 1);
}

/** Bilinear coverage at a continuous pixel position. */
function coverageAt(r: ImageData, x: number, y: number, e: Rgb): number {
  const fx = x - 0.5;
  const fy = y - 0.5;
  const i = Math.floor(fx);
  const j = Math.floor(fy);
  const u = fx - i;
  const v = fy - j;
  return (
    pixelCoverage(r, i, j, e) * (1 - u) * (1 - v) +
    pixelCoverage(r, i + 1, j, e) * u * (1 - v) +
    pixelCoverage(r, i, j + 1, e) * (1 - u) * v +
    pixelCoverage(r, i + 1, j + 1, e) * u * v
  );
}

interface WidthSample {
  readonly t: number;
  readonly expected: number;
  readonly width: number;
  /** Centre of the drawn ink relative to the planned centre line, along the normal (pt). */
  readonly offset: number;
}

/** Drawn width across a straight stroke at each `at` (0–1), in points. */
function widthProfile(
  rendered: Rendered,
  taper: Taper,
  colour: Rgb,
  at: readonly number[] = TAPER_AT,
): WidthSample[] {
  const dx = taper.to.x - taper.from.x;
  const dy = taper.to.y - taper.from.y;
  const len = Math.hypot(dx, dy);
  const normal = { x: -dy / len, y: dx / len };
  const step = 0.05;
  const reach = Math.max(taper.startWidth, taper.endWidth) + 4;
  return at.map((t) => {
    const c = { x: taper.from.x + dx * t, y: taper.from.y + dy * t };
    let sum = 0;
    let moment = 0;
    for (let s = -reach; s <= reach; s += step) {
      const [px, py] = rendered.toPixel({ x: c.x + normal.x * s, y: c.y + normal.y * s });
      const cov = coverageAt(rendered.raster, px, py, colour) * step;
      sum += cov;
      moment += cov * s;
    }
    return {
      t,
      expected: taper.startWidth + (taper.endWidth - taper.startWidth) * t,
      width: Math.round(sum * 100) / 100,
      offset: sum > 0 ? Math.round((moment / sum) * 100) / 100 : Number.NaN,
    };
  });
}

/** The pixel colour at the stroke's centre at `t`. */
function centreColour(rendered: Rendered, taper: Taper, t: number): Rgb {
  const [px, py] = rendered.toPixel({
    x: taper.from.x + (taper.to.x - taper.from.x) * t,
    y: taper.from.y + (taper.to.y - taper.from.y) * t,
  });
  const k = (Math.floor(py) * rendered.raster.width + Math.floor(px)) * 4;
  const d = rendered.raster.data;
  return [d[k] ?? 0, d[k + 1] ?? 0, d[k + 2] ?? 0];
}

function expectVariable(samples: readonly WidthSample[], what: string): void {
  for (const s of samples) {
    expect(Math.abs(s.width - s.expected), `${what}: width at ${s.t}`).toBeLessThanOrEqual(
      WIDTH_TOLERANCE,
    );
    expect(Math.abs(s.offset), `${what}: centre at ${s.t}`).toBeLessThanOrEqual(WIDTH_TOLERANCE);
  }
  const first = samples[0]?.width ?? 0;
  const last = samples[samples.length - 1]?.width ?? 0;
  expect(last / first, `${what}: width ratio`).toBeGreaterThanOrEqual(3);
}

function expectConstant(samples: readonly WidthSample[], width: number, what: string): void {
  for (const s of samples) {
    expect(Math.abs(s.width - width), `${what}: width at ${s.t}`).toBeLessThanOrEqual(
      WIDTH_TOLERANCE,
    );
  }
}

function expectColour(actual: Rgb, expected: Rgb, what: string): void {
  for (let c = 0; c < 3; c++) {
    expect(Math.abs((actual[c] ?? 0) - (expected[c] ?? 0)), `${what}: channel ${c}`).toBeLessThan(
      14,
    );
  }
}

function geometryOf(page: OpenedDocument['pages'][number]): PageGeometry {
  const turns = ((page.rotation / 90) & 3) as 0 | 1 | 2 | 3;
  const odd = (turns & 1) === 1;
  return {
    quarterTurns: turns,
    displayWidth: odd ? page.size.height : page.size.width,
    displayHeight: odd ? page.size.width : page.size.height,
    originX: page.cropBox?.x ?? 0,
    originY: page.cropBox?.y ?? 0,
  };
}

async function renderPdfium(
  id: string,
  opened: OpenedDocument,
  pageIndex: number,
): Promise<Rendered> {
  const { bitmap } = await adapter.renderPage(sid(id), pageIndex, { scale: SCALE });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No 2D canvas');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const g = geometryOf(opened.pages[pageIndex] as OpenedDocument['pages'][number]);
  return {
    raster: ctx.getImageData(0, 0, canvas.width, canvas.height),
    toPixel: (p) => {
      const d = userToDevicePoint(g, p);
      return [d.x * SCALE, d.y * SCALE];
    },
  };
}

/** What pdf.js reports for an annotation (the fields read here). */
interface PdfjsAnnotation {
  readonly subtype: string;
  readonly id: string;
  readonly rect: readonly number[];
  readonly borderStyle?: { readonly width: number };
  readonly inkLists?: readonly ArrayLike<number>[];
  readonly opacity?: number;
}

/** pdf.js's canvas render (annotation appearances on, as Firefox shows a page). */
async function renderPdfjs(
  bytes: ArrayBuffer,
  pageIndices: readonly number[],
): Promise<{ pages: Map<number, Rendered>; annotations: Map<number, PdfjsAnnotation[]> }> {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)), verbosity: 0 });
  const pages = new Map<number, Rendered>();
  const annotations = new Map<number, PdfjsAnnotation[]>();
  try {
    const doc = await task.promise;
    for (const pageIndex of pageIndices) {
      const page = await doc.getPage(pageIndex + 1);
      const viewport = page.getViewport({ scale: SCALE });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      await page.render({ canvas, viewport, annotationMode: pdfjs.AnnotationMode.ENABLE }).promise;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('No 2D canvas');
      pages.set(pageIndex, {
        raster: ctx.getImageData(0, 0, canvas.width, canvas.height),
        toPixel: (p) => {
          const [x = 0, y = 0] = viewport.convertToViewportPoint(p.x, p.y) as number[];
          return [x, y];
        },
      });
      annotations.set(pageIndex, (await page.getAnnotations()) as PdfjsAnnotation[]);
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }
  return { pages, annotations };
}

// ---------------------------------------------------------------------------
// File inspection (pdf-lib)
// ---------------------------------------------------------------------------

interface SavedInk {
  readonly keys: string[];
  readonly rect: number[];
  readonly bsWidth: number | undefined;
  readonly widths: string | undefined;
  readonly apFilter: string | undefined;
  readonly apBBox: number[];
  readonly apLength: number;
  readonly apExtGStateCA: number | undefined;
}

function textOf(value: PDFObject | undefined): string | undefined {
  return value instanceof PDFString || value instanceof PDFHexString
    ? value.decodeText()
    : undefined;
}

function numbersOf(doc: PDFDocument, value: PDFObject | undefined): number[] {
  const resolved = value instanceof PDFRef ? doc.context.lookup(value) : value;
  if (!resolved || !('asArray' in resolved)) return [];
  return (resolved as { asArray(): PDFObject[] })
    .asArray()
    .map((v) => (v instanceof PDFNumber ? v.asNumber() : Number.NaN));
}

async function savedInk(bytes: ArrayBuffer, pageIndex: number, nm: string): Promise<SavedInk> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const annots = doc.getPage(pageIndex).node.Annots()?.asArray() ?? [];
  for (const ref of annots) {
    const dict = doc.context.lookup(ref);
    if (!(dict instanceof PDFDict) || textOf(dict.get(PDFName.of('NM'))) !== nm) continue;
    const ap = dict.lookupMaybe(PDFName.of('AP'), PDFDict);
    const n = ap?.lookup(PDFName.of('N'));
    const stream = n instanceof PDFRawStream ? n : undefined;
    const gs = stream?.dict
      .lookupMaybe(PDFName.of('Resources'), PDFDict)
      ?.lookupMaybe(PDFName.of('ExtGState'), PDFDict)
      ?.lookupMaybe(PDFName.of('GS'), PDFDict);
    const ca = gs?.lookupMaybe(PDFName.of('CA'), PDFNumber);
    const bs = dict.lookupMaybe(PDFName.of('BS'), PDFDict);
    const w = bs?.lookupMaybe(PDFName.of('W'), PDFNumber);
    return {
      keys: dict.keys().map((k) => k.asString()),
      rect: numbersOf(doc, dict.get(PDFName.of('Rect'))),
      bsWidth: w?.asNumber(),
      widths: textOf(dict.get(PDFName.of(INK_WIDTHS_KEY))),
      apFilter: stream?.dict.get(PDFName.of('Filter'))?.toString(),
      apBBox: numbersOf(doc, stream?.dict.get(PDFName.of('BBox'))),
      apLength: stream?.contents.length ?? 0,
      apExtGStateCA: ca?.asNumber(),
    };
  }
  throw new Error(`No annotation ${nm} on page ${pageIndex + 1}`);
}

// ---------------------------------------------------------------------------
// The two-page document of Q1–Q3: page 1 upright, page 2 /Rotate 90
// ---------------------------------------------------------------------------

const BLUE = '#1E5BD8';
const RED = '#E53935';
const TAPERS: readonly { pageIndex: number; taper: Taper; color: string; opacity: number }[] = [
  {
    pageIndex: 0,
    taper: { from: { x: 120, y: 500 }, to: { x: 420, y: 500 }, startWidth: 1, endWidth: 9 },
    color: BLUE,
    opacity: 1,
  },
  {
    pageIndex: 1,
    taper: { from: { x: 120, y: 400 }, to: { x: 420, y: 400 }, startWidth: 1, endWidth: 9 },
    color: RED,
    opacity: 0.6,
  },
];

function specOf(entry: (typeof TAPERS)[number]): InkSpec {
  const { path, widths } = taperStroke(entry.taper);
  return {
    pageIndex: entry.pageIndex,
    paths: [path],
    widths: [widths],
    color: entry.color,
    opacity: entry.opacity,
  };
}

async function twoPageDoc(): Promise<ArrayBuffer> {
  return makePdf([
    { size: [612, 792], text: 'S1 page 1 (upright)', at: [72, 720] },
    { size: [612, 792], text: 'S1 page 2 (/Rotate 90)', at: [72, 720], rotation: 90 },
  ]);
}

interface Written {
  readonly id: string;
  readonly opened: OpenedDocument;
  readonly inks: { annotationId: string; content: string; spec: InkSpec }[];
}

async function writeTapers(): Promise<Written> {
  const { id, opened } = await open(await twoPageDoc());
  const inks: Written['inks'] = [];
  for (const entry of TAPERS) {
    const spec = specOf(entry);
    const created = await createInk(id, spec);
    inks.push({
      annotationId: created.id,
      content: await applyAppearance(id, created.id, spec),
      spec,
    });
  }
  return { id, opened, inks };
}

// ---------------------------------------------------------------------------
// Q1: set on create and update; our PDFium renders it as written
// ---------------------------------------------------------------------------

describe('S1 Q1: our appearance in our PDFium', () => {
  test('create: EmbedPDF draws /BS /W; after FPDFAnnot_SetAP PDFium draws ours, unchanged', async () => {
    const { id, opened } = await open(await twoPageDoc());
    for (const entry of TAPERS) {
      const spec = specOf(entry);
      const colour = rgbOf(entry.color, entry.opacity);
      const created = await createInk(id, spec);
      const generated = await rawAppearance(id, entry.pageIndex, created.id);
      const before = widthProfile(
        await renderPdfium(id, opened, entry.pageIndex),
        entry.taper,
        colour,
      );
      log(
        `Q1 page ${entry.pageIndex + 1}: EmbedPDF-generated widths`,
        before.map((s) => s.width),
      );
      log(`Q1 page ${entry.pageIndex + 1}: EmbedPDF-generated AP head`, generated.slice(0, 120));
      expectConstant(before, NOMINAL, 'generated');

      const content = await applyAppearance(id, created.id, spec);
      const after = widthProfile(
        await renderPdfium(id, opened, entry.pageIndex),
        entry.taper,
        colour,
      );
      log(`Q1 page ${entry.pageIndex + 1}: our AP widths (planned 1.8/3.4/5/6.6/8.2)`, after);
      expectVariable(after, `pdfium page ${entry.pageIndex + 1}`);
      expectColour(
        centreColour(await renderPdfium(id, opened, entry.pageIndex), entry.taper, 0.9),
        colour,
        `pdfium colour page ${entry.pageIndex + 1}`,
      );
      // Rendering, listing and re-rendering do not regenerate it: the stream is ours.
      const listed = await adapter.listAnnotations(sid(id), entry.pageIndex);
      await renderPdfium(id, opened, entry.pageIndex);
      expect(await rawAppearance(id, entry.pageIndex, created.id)).toBe(content);
      const ink = listed.find((a) => a.id === created.id) as InkAnnotation;
      expect(ink.strokeWidth).toBe(NOMINAL);
      expect(ink.paths[0]).toHaveLength(spec.paths[0]?.length ?? 0);
    }
    await adapter.close(sid(id));
  });

  test('update: the adapter (regenerateAppearance) replaces ours; widths survive; re-applying restores it', async () => {
    const { id, opened, inks } = await writeTapers();
    for (const [index, ink] of inks.entries()) {
      const entry = TAPERS[index] as (typeof TAPERS)[number];
      const listed = (await adapter.listAnnotations(sid(id), ink.spec.pageIndex)).find(
        (a) => a.id === ink.annotationId,
      ) as InkAnnotation;
      const recoloured = '#2E7D32';
      const colour = rgbOf(recoloured, entry.opacity);
      await adapter.updateAnnotation(sid(id), { ...listed, color: recoloured });
      const replaced = await rawAppearance(id, ink.spec.pageIndex, ink.annotationId);
      expect(replaced).not.toBe(ink.content);
      const regenerated = widthProfile(
        await renderPdfium(id, opened, ink.spec.pageIndex),
        entry.taper,
        colour,
      );
      log(
        `Q1 update page ${ink.spec.pageIndex + 1}: widths after a colour change`,
        regenerated.map((s) => s.width),
      );
      expectConstant(regenerated, NOMINAL, 'regenerated after update');

      // The private key is untouched by EmbedPDF's update; it still matches /InkList.
      const stored = await rawWidths(id, ink.spec.pageIndex, ink.annotationId);
      expect(stored).toBe(encodeInkWidths(ink.spec.widths));
      const after = (await adapter.listAnnotations(sid(id), ink.spec.pageIndex)).find(
        (a) => a.id === ink.annotationId,
      ) as InkAnnotation;
      const widths = decodeInkWidths(stored, after.paths);
      expect(widths).toBeDefined();
      await applyAppearance(id, ink.annotationId, {
        ...ink.spec,
        paths: after.paths,
        widths: widths ?? [],
        color: recoloured,
      });
      const restored = widthProfile(
        await renderPdfium(id, opened, ink.spec.pageIndex),
        entry.taper,
        colour,
      );
      expectVariable(restored, `re-applied page ${ink.spec.pageIndex + 1}`);
    }
    await adapter.close(sid(id));
  });
});

// ---------------------------------------------------------------------------
// Q2 and Q3: pdf.js, save, reopen, flatten, export
// ---------------------------------------------------------------------------

describe('S1 Q2/Q3: other renderers and the save paths', () => {
  test('save → pdf.js renders our appearance (colour, opacity, placement, /Rotate 90)', async () => {
    const { id, inks } = await writeTapers();
    const saved = await adapter.save(sid(id));
    const { pages, annotations } = await renderPdfjs(saved, [0, 1]);
    for (const [index, entry] of TAPERS.entries()) {
      const rendered = pages.get(entry.pageIndex) as Rendered;
      const colour = rgbOf(entry.color, entry.opacity);
      const samples = widthProfile(rendered, entry.taper, colour);
      log(`Q2 pdf.js page ${entry.pageIndex + 1}`, samples);
      expectVariable(samples, `pdf.js page ${entry.pageIndex + 1}`);
      expectColour(centreColour(rendered, entry.taper, 0.9), colour, `pdf.js colour ${index}`);
      const ink = annotations.get(entry.pageIndex)?.find((a) => a.subtype === 'Ink');
      expect(ink?.borderStyle?.width).toBe(NOMINAL);
      expect(ink?.inkLists?.[0]?.length).toBe(2 * (inks[index]?.spec.paths[0]?.length ?? 0));
    }
    await adapter.close(sid(id));
  });

  test('save → reopen keeps our stream and the widths; a later session regenerates from them', async () => {
    const { id, inks } = await writeTapers();
    const saved = await adapter.save(sid(id));
    for (const ink of inks) {
      const file = await savedInk(saved, ink.spec.pageIndex, ink.annotationId);
      log(`Q3 saved annotation page ${ink.spec.pageIndex + 1}`, file);
      expect(file.bsWidth).toBe(NOMINAL);
      expect(file.widths).toBe(encodeInkWidths(ink.spec.widths));
      expect(file.apBBox).toEqual(file.rect);
      if (ink.spec.opacity < 1) expect(file.apExtGStateCA).toBeCloseTo(ink.spec.opacity, 2);
    }
    await adapter.close(sid(id));

    // A later session: open the saved file, read the widths back, edit, regenerate.
    const reopened = await open(saved);
    for (const [index, ink] of inks.entries()) {
      const entry = TAPERS[index] as (typeof TAPERS)[number];
      const { pageIndex } = ink.spec;
      expect(await rawAppearance(reopened.id, pageIndex, ink.annotationId)).toBe(ink.content);
      expectVariable(
        widthProfile(
          await renderPdfium(reopened.id, reopened.opened, pageIndex),
          entry.taper,
          rgbOf(entry.color, entry.opacity),
        ),
        `reopened page ${pageIndex + 1}`,
      );
      const listed = (await adapter.listAnnotations(sid(reopened.id), pageIndex)).find(
        (a) => a.id === ink.annotationId,
      ) as InkAnnotation;
      const widths = decodeInkWidths(
        await rawWidths(reopened.id, pageIndex, ink.annotationId),
        listed.paths,
      );
      expect(widths).toBeDefined();
      // Widths that no longer match /InkList (edited elsewhere) are dropped.
      expect(
        decodeInkWidths(encodeInkWidths(ink.spec.widths), [listed.paths[0]?.slice(1) ?? []]),
      ).toBeUndefined();
      const moved = listed.paths.map((p) => p.map((q) => ({ x: q.x, y: q.y - 20 })));
      await adapter.updateAnnotation(sid(reopened.id), { ...listed, paths: moved });
      await applyAppearance(reopened.id, ink.annotationId, {
        ...ink.spec,
        paths: moved,
        widths: widths ?? [],
      });
      const shifted: Taper = {
        ...entry.taper,
        from: { x: entry.taper.from.x, y: entry.taper.from.y - 20 },
        to: { x: entry.taper.to.x, y: entry.taper.to.y - 20 },
      };
      expectVariable(
        widthProfile(
          await renderPdfium(reopened.id, reopened.opened, pageIndex),
          shifted,
          rgbOf(entry.color, entry.opacity),
        ),
        `regenerated after a move, page ${pageIndex + 1}`,
      );
    }
    await adapter.close(sid(reopened.id));
  });

  test('flatten bakes our outline into the page; export + verification pass', async () => {
    const { id, opened, inks } = await writeTapers();
    const size = { width: 612, height: 792 };

    // Flatten (save option, as Export → "Flatten annotations").
    const flat = await adapter.save(sid(id), { flattenAnnotations: true });
    expect(
      await adapter.verify(flat.slice(0), {
        pageCount: 2,
        pageSizes: [size, size],
        rotations: [0, 90],
        annotationCounts: { 0: 0, 1: 0 },
      }),
    ).toEqual({ ok: true, problems: [] });
    const flatDoc = await open(flat);
    const flatPdfjs = await renderPdfjs(flat, [0, 1]);
    for (const entry of TAPERS) {
      const colour = rgbOf(entry.color, entry.opacity);
      const pdfium = widthProfile(
        await renderPdfium(flatDoc.id, flatDoc.opened, entry.pageIndex),
        entry.taper,
        colour,
      );
      const js = widthProfile(
        flatPdfjs.pages.get(entry.pageIndex) as Rendered,
        entry.taper,
        colour,
      );
      log(`Q3 flattened page ${entry.pageIndex + 1}`, { pdfium, pdfjs: js });
      expectVariable(pdfium, `flattened pdfium ${entry.pageIndex + 1}`);
      expectVariable(js, `flattened pdf.js ${entry.pageIndex + 1}`);
    }
    await adapter.close(sid(flatDoc.id));

    // Export: save → assemble (pdf-lib) → verify with the annotation conformance checks.
    const saved = await adapter.save(sid(id));
    const source = sid('s1-source');
    const assembled = await new PdfLibAssembler().assemble({
      document: vdoc([
        vpage({ kind: 'source', source, index: 0 }),
        vpage({ kind: 'source', source, index: 1 }),
      ]),
      sources: new Map([[source, saved]]),
      blobs: new Map(),
    });
    const verification = await adapter.verify(assembled.bytes.slice(0), {
      pageCount: 2,
      pageSizes: [size, size],
      rotations: [0, 90],
      annotationCounts: { 0: 1, 1: 1 },
      checkAnnotations: true,
      annotationIds: inks.map((i) => i.annotationId),
    });
    log('Q3 export verification', verification);
    expect(verification).toEqual({ ok: true, problems: [] });
    const exported = await open(assembled.bytes);
    for (const entry of TAPERS) {
      expectVariable(
        widthProfile(
          await renderPdfium(exported.id, exported.opened, entry.pageIndex),
          entry.taper,
          rgbOf(entry.color, entry.opacity),
        ),
        `exported page ${entry.pageIndex + 1}`,
      );
    }
    for (const ink of inks) {
      expect(await rawAppearance(exported.id, ink.spec.pageIndex, ink.annotationId)).toBe(
        ink.content,
      );
    }
    await adapter.close(sid(exported.id));
    await adapter.close(sid(id));
    expect(opened.pageCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Q3: cost of a 64-path annotation (a full burst, spec §6.4)
// ---------------------------------------------------------------------------

/** 64 handwriting-like strokes of 40 points, 0.5–2 pt (nominal 1.5 pt), on a 8 × 8 grid. */
function burst(): { paths: InkPoint[][]; widths: number[][] } {
  const paths: InkPoint[][] = [];
  const widths: number[][] = [];
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const x0 = 60 + col * 62;
      const y0 = 700 - row * 80;
      const path: InkPoint[] = [];
      const ws: number[] = [];
      for (let i = 0; i < 40; i++) {
        const t = i / 39;
        path.push({
          x: x0 + 48 * t + 4 * Math.sin(5 * Math.PI * t),
          y: y0 + 14 * Math.sin(3 * Math.PI * t) + 5 * Math.cos(7 * Math.PI * t),
        });
        ws.push(1.5 * (0.35 + 0.95 * Math.sin(Math.PI * t)));
      }
      paths.push(path);
      widths.push(ws);
    }
  }
  return { paths, widths };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

const ms = (v: number) => Math.round(v * 10) / 10;

/** Form XObjects in the file, and how many of them no page or annotation reaches. */
async function formXObjects(bytes: ArrayBuffer): Promise<{ forms: number; unreachable: number }> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const reachable = new Set<string>();
  const visit = (value: PDFObject | undefined): void => {
    if (value instanceof PDFRef) {
      if (reachable.has(value.toString())) return;
      reachable.add(value.toString());
      visit(doc.context.lookup(value));
    } else if (value instanceof PDFDict) {
      for (const v of value.values()) visit(v);
    } else if (value instanceof PDFRawStream) {
      visit(value.dict);
    } else if (value && 'asArray' in value) {
      for (const v of (value as { asArray(): PDFObject[] }).asArray()) visit(v);
    }
  };
  visit(doc.context.trailerInfo.Root);
  let forms = 0;
  let unreachable = 0;
  for (const [ref, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    if (object.dict.get(PDFName.of('Subtype'))?.toString() !== '/Form') continue;
    forms++;
    if (!reachable.has(ref.toString())) unreachable++;
  }
  return { forms, unreachable };
}

describe('S1 Q3: a 64-path annotation', () => {
  test('bytes and update time', async () => {
    const { id, opened } = await open(await makePdf([{ size: [612, 792] }]));
    const { paths, widths } = burst();
    const spec: InkSpec = { pageIndex: 0, paths, widths, color: BLUE, opacity: 1 };
    const blank = (await adapter.save(sid(id))).byteLength;

    let t = performance.now();
    const created = (await adapter.createAnnotation(sid(id), {
      kind: 'ink',
      pageIndex: 0,
      rect: ZERO,
      paths,
      strokeWidth: 1.5,
      color: BLUE,
    })) as InkAnnotation;
    const createMs = performance.now() - t;
    const generated = await rawAppearance(id, 0, created.id);
    const constantSave = await adapter.save(sid(id));
    const constantRenderMs: number[] = [];
    for (let i = 0; i < 3; i++) {
      t = performance.now();
      await renderPdfium(id, opened, 0);
      constantRenderMs.push(performance.now() - t);
    }

    t = performance.now();
    const content = inkAppearanceContent(spec);
    const outlineMs = performance.now() - t;
    t = performance.now();
    await host.withRawAccess(id, (raw) => {
      setAnnotationAppearance(raw, 0, created.id, {
        content,
        rect: inkOutlineBounds(paths, widths),
        strings: { [INK_WIDTHS_KEY]: encodeInkWidths(widths) },
      });
    });
    const setMs = performance.now() - t;
    const variableSave = await adapter.save(sid(id));
    const file = await savedInk(variableSave, 0, created.id);
    const encoded = new TextEncoder().encode(content);

    // Update path (a recolour, or a burst appending a stroke: both rewrite every path):
    // the adapter's update, then our appearance again.
    const updateMs: number[] = [];
    const reapplyMs: number[] = [];
    for (let round = 0; round < 5; round++) {
      const color = round % 2 === 0 ? RED : BLUE;
      const current = (await adapter.listAnnotations(sid(id), 0))[0] as InkAnnotation;
      t = performance.now();
      await adapter.updateAnnotation(sid(id), { ...current, color });
      updateMs.push(performance.now() - t);
      t = performance.now();
      await applyAppearance(id, created.id, { ...spec, color });
      reapplyMs.push(performance.now() - t);
    }
    const renderMs: number[] = [];
    for (let i = 0; i < 3; i++) {
      t = performance.now();
      await renderPdfium(id, opened, 0);
      renderMs.push(performance.now() - t);
    }
    const points = paths.reduce((s, p) => s + p.length, 0);
    // In-session orphans: each regenerate and each SetAP leaves the previous stream behind.
    const afterRounds = await adapter.save(sid(id));
    const exported = await new PdfLibAssembler().assemble({
      document: vdoc([vpage({ kind: 'source', source: sid('s1-burst'), index: 0 })]),
      sources: new Map([[sid('s1-burst'), afterRounds.slice(0)]]),
      blobs: new Map(),
    });
    const measurements = {
      paths: paths.length,
      points,
      appearanceBytes: encoded.length,
      appearanceDeflated: zlibSync(encoded, { level: 6 }).length,
      generatedAppearanceBytes: generated.length,
      widthsBytes: encodeInkWidths(widths).length,
      widthsBytesOneDecimal: [
        '1',
        ...widths.map((ws) => ws.map((w) => w.toFixed(1)).join(' ')),
      ].join(';').length,
      savedApFilter: file.apFilter ?? 'none',
      fileBlank: blank,
      fileConstant: constantSave.byteLength,
      fileVariable: variableSave.byteLength,
      fileDelta: variableSave.byteLength - constantSave.byteLength,
      formsConstant: await formXObjects(constantSave),
      formsVariable: await formXObjects(variableSave),
      fileAfter5Updates: afterRounds.byteLength,
      formsAfter5Updates: await formXObjects(afterRounds),
      exportAfter5Updates: exported.bytes.byteLength,
      formsExportAfter5Updates: await formXObjects(exported.bytes),
      createMs: ms(createMs),
      outlineMs: ms(outlineMs),
      setApMs: ms(setMs),
      updateMedianMs: ms(median(updateMs)),
      reapplyMedianMs: ms(median(reapplyMs)),
      renderScale2MedianMs: ms(median(renderMs)),
      renderScale2ConstantMedianMs: ms(median(constantRenderMs)),
    };
    log('Q3 64-path annotation', measurements);
    expect(file.widths).toBe(encodeInkWidths(widths));
    expect(measurements.reapplyMedianMs).toBeLessThan(250);
    await adapter.close(sid(id));
  });
});

// ---------------------------------------------------------------------------
// Q4: the two proposed matrix rows, on the committed matrix sample (in memory)
// ---------------------------------------------------------------------------

/**
 * The S1 proposal, now the `ink-variable` entries of tools/qa/annotation-sample-plan.ts (the
 * committed sample holds them since P4, so these strokes are drawn over the same ones).
 */
const PROPOSED: readonly {
  key: string;
  pageIndex: number;
  taper: Taper;
  color: string;
  opacity: number;
}[] = [
  {
    key: 'ink-variable',
    pageIndex: 0,
    taper: { from: { x: 300, y: 105 }, to: { x: 540, y: 105 }, startWidth: 1, endWidth: 9 },
    color: '#1E5BD8',
    opacity: 1,
  },
  {
    key: 'rotated-ink-variable',
    pageIndex: 1,
    taper: { from: { x: 72, y: 450 }, to: { x: 312, y: 450 }, startWidth: 1, endWidth: 9 },
    color: '#E53935',
    opacity: 0.6,
  },
];

describe('S1 Q4: proposed matrix rows on the matrix sample', () => {
  test('"Ink, variable width (appearance)" and "Ink /BS /W equals the nominal width"', async () => {
    const { id } = await open(await fetchBytes(sampleUrl));
    const before = (await adapter.listAnnotations(sid(id), 0)).length;
    const written: { key: string; annotationId: string }[] = [];
    for (const p of PROPOSED) {
      const { path, widths } = taperStroke(p.taper);
      const spec: InkSpec = {
        pageIndex: p.pageIndex,
        paths: [path],
        widths: [widths],
        color: p.color,
        opacity: p.opacity,
      };
      const created = await createInk(id, spec);
      await applyAppearance(id, created.id, spec);
      written.push({ key: p.key, annotationId: created.id });
    }
    const saved = await adapter.save(sid(id));
    await adapter.close(sid(id));
    const reopened = await open(saved);
    expect((await adapter.listAnnotations(sid(reopened.id), 0)).length).toBe(before + 1);
    const js = await renderPdfjs(saved, [0, 1]);
    const results: Record<string, string> = {};
    for (const [index, p] of PROPOSED.entries()) {
      const annotationId = written[index]?.annotationId ?? '';
      const colour = rgbOf(p.color, p.opacity);
      const pdfium = widthProfile(
        await renderPdfium(reopened.id, reopened.opened, p.pageIndex),
        p.taper,
        colour,
      );
      const pdfjsSamples = widthProfile(js.pages.get(p.pageIndex) as Rendered, p.taper, colour);
      expectVariable(pdfium, `matrix pdfium ${p.key}`);
      expectVariable(pdfjsSamples, `matrix pdf.js ${p.key}`);
      const listed = (await adapter.listAnnotations(sid(reopened.id), p.pageIndex)).find(
        (a) => a.id === annotationId,
      ) as InkAnnotation;
      const jsInk = js.annotations
        .get(p.pageIndex)
        ?.find((a) => a.subtype === 'Ink' && a.borderStyle?.width === NOMINAL);
      expect(listed.strokeWidth).toBe(NOMINAL);
      expect(jsInk).toBeDefined();
      const fmt = (s: readonly WidthSample[]) => s.map((x) => `${x.width}`).join('/');
      results[`${p.key} width pdfium`] = `ok (${fmt(pdfium)} pt)`;
      results[`${p.key} width pdf.js`] = `ok (${fmt(pdfjsSamples)} pt)`;
      results[`${p.key} /BS /W`] =
        `pdfium ${listed.strokeWidth}, pdf.js ${jsInk?.borderStyle?.width}`;
    }
    log('Q4 proposed matrix rows', results);
    await adapter.close(sid(reopened.id));
  });
});

// ---------------------------------------------------------------------------
// Corpus: every page of six fixtures (rotations 0/90/180/270, crop boxes, mixed sizes,
// existing annotations, tagged content)
// ---------------------------------------------------------------------------

const CORPUS: readonly [string, string][] = [
  ['simple-text.pdf', simpleTextUrl],
  ['rotated-pages.pdf', rotatedUrl],
  ['cropbox.pdf', cropboxUrl],
  ['mixed-sizes.pdf', mixedSizesUrl],
  ['annotations.pdf', annotationsUrl],
  ['tagged.pdf', taggedUrl],
];

describe('S1 corpus', () => {
  test('every page: written, saved, reopened, verified, drawn by both renderers', async () => {
    const summary: Record<string, string> = {};
    for (const [name, url] of CORPUS) {
      const { id, opened } = await open(await fetchBytes(url));
      const inks: { pageIndex: number; annotationId: string; content: string; taper: Taper }[] = [];
      for (let pageIndex = 0; pageIndex < opened.pageCount; pageIndex++) {
        const page = opened.pages[pageIndex] as OpenedDocument['pages'][number];
        const box = page.cropBox ?? { x: 0, y: 0, ...page.size };
        const half = Math.min(110, box.width * 0.35);
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height * 0.42;
        const taper: Taper = {
          from: { x: cx - half, y: cy },
          to: { x: cx + half, y: cy },
          startWidth: 1,
          endWidth: 9,
        };
        const { path, widths } = taperStroke(taper);
        const spec: InkSpec = {
          pageIndex,
          paths: [path],
          widths: [widths],
          color: BLUE,
          opacity: 1,
        };
        const created = await createInk(id, spec);
        inks.push({
          pageIndex,
          annotationId: created.id,
          content: await applyAppearance(id, created.id, spec),
          taper,
        });
      }
      const saved = await adapter.save(sid(id));
      await adapter.close(sid(id));
      const verification = await adapter.verify(saved.slice(0), {
        pageCount: opened.pageCount,
        pageSizes: opened.pages.map((p) => p.size),
        checkAnnotations: true,
        annotationIds: inks.map((i) => i.annotationId),
      });
      expect(verification, name).toEqual({ ok: true, problems: [] });
      const reopened = await open(saved);
      const js = await renderPdfjs(
        saved,
        inks.map((i) => i.pageIndex),
      );
      const colour = rgbOf(BLUE);
      const widths: string[] = [];
      for (const ink of inks) {
        expect(await rawAppearance(reopened.id, ink.pageIndex, ink.annotationId)).toBe(ink.content);
        const pdfium = widthProfile(
          await renderPdfium(reopened.id, reopened.opened, ink.pageIndex),
          ink.taper,
          colour,
        );
        const pdfjsSamples = widthProfile(
          js.pages.get(ink.pageIndex) as Rendered,
          ink.taper,
          colour,
        );
        expectVariable(pdfium, `${name} p${ink.pageIndex + 1} pdfium`);
        expectVariable(pdfjsSamples, `${name} p${ink.pageIndex + 1} pdf.js`);
        widths.push(
          `p${ink.pageIndex + 1}@${reopened.opened.pages[ink.pageIndex]?.rotation ?? 0}: ` +
            `${pdfium[0]?.width}→${pdfium[4]?.width} / ${pdfjsSamples[0]?.width}→${pdfjsSamples[4]?.width}`,
        );
      }
      summary[name] = widths.join(', ');
      await adapter.close(sid(reopened.id));
    }
    log('corpus (pdfium / pdf.js width at 10% → 90%)', summary);
  });
});
