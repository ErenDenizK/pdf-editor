/**
 * Test helpers for variable-width ink (ADR-0018), browser mode: renders a page with our
 * PDFium adapter or with pdf.js and measures the drawn width across a straight stroke, as
 * spike S1 did (docs/research/09-ink-appearance-spike.md §2). Pixels along the stroke normal
 * are projected onto "white → expected colour" (coverage 0–1; pixels of another colour count
 * 0) and the coverage is integrated over the normal in points. Each renderer maps user space
 * to pixels itself, so rotated pages measure the same way.
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
import type { SourceId } from '@pdf-editor/document-model';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfjsWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { expect } from 'vitest';

import { INK_WIDTHS_KEY } from '../annotations/ink-appearance';
import type { InkPoint } from '../annotations/ink-outline';
import type { OpenedDocument, PdfRenderer } from '../types';
import { type PageGeometry, userToDevicePoint } from './coords';

/** Render scale of every measurement. */
export const SCALE = 2;
/** Where along a taper (0–1) the width is measured. */
export const TAPER_AT = [0.1, 0.3, 0.5, 0.7, 0.9] as const;
/** Allowed difference between drawn and planned width, and of the drawn centre (points). */
export const WIDTH_TOLERANCE = 0.6;

/** A straight stroke whose width grows linearly from `startWidth` to `endWidth`. */
export interface Taper {
  readonly from: InkPoint;
  readonly to: InkPoint;
  readonly startWidth: number;
  readonly endWidth: number;
}

export function taperStroke(t: Taper, points = 25): { path: InkPoint[]; widths: number[] } {
  const path: InkPoint[] = [];
  const widths: number[] = [];
  for (let i = 0; i < points; i++) {
    const k = i / (points - 1);
    path.push({ x: t.from.x + (t.to.x - t.from.x) * k, y: t.from.y + (t.to.y - t.from.y) * k });
    widths.push(t.startWidth + (t.endWidth - t.startWidth) * k);
  }
  return { path, widths };
}

export function shifted(t: Taper, dx: number, dy: number): Taper {
  return {
    ...t,
    from: { x: t.from.x + dx, y: t.from.y + dy },
    to: { x: t.to.x + dx, y: t.to.y + dy },
  };
}

export type Rgb = readonly [number, number, number];

/** `#RRGGBB` at `opacity` composited over white. */
export function rgbOf(hex: string, opacity = 1): Rgb {
  const c = (i: number) => Number.parseInt(hex.slice(i, i + 2), 16);
  return [1, 3, 5].map((i) => 255 - (255 - c(i)) * opacity) as unknown as Rgb;
}

export interface Rendered {
  readonly raster: ImageData;
  readonly toPixel: (p: InkPoint) => readonly [number, number];
}

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

export interface WidthSample {
  readonly t: number;
  readonly expected: number;
  readonly width: number;
  /** Centre of the drawn ink relative to the planned centre line (points). */
  readonly offset: number;
}

/** Drawn width across a straight stroke at each `at` (0–1), in points. */
export function widthProfile(
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

/** Every sample within tolerance of the plan, and the stroke at least 3× wider at its end. */
export function expectVariable(samples: readonly WidthSample[], what: string): void {
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

export function expectConstant(samples: readonly WidthSample[], width: number, what: string): void {
  for (const s of samples) {
    expect(Math.abs(s.width - width), `${what}: width at ${s.t}`).toBeLessThanOrEqual(
      WIDTH_TOLERANCE,
    );
  }
}

/** The pixel colour at the stroke's centre line at `t`. */
export function centreColour(rendered: Rendered, taper: Taper, t: number): Rgb {
  const [px, py] = rendered.toPixel({
    x: taper.from.x + (taper.to.x - taper.from.x) * t,
    y: taper.from.y + (taper.to.y - taper.from.y) * t,
  });
  const k = (Math.floor(py) * rendered.raster.width + Math.floor(px)) * 4;
  const d = rendered.raster.data;
  return [d[k] ?? 0, d[k + 1] ?? 0, d[k + 2] ?? 0];
}

export function expectColour(actual: Rgb, expected: Rgb, what: string): void {
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

/** Our PDFium's render of a page (the adapter's or the worker proxy's `renderPage`). */
export async function renderPdfium(
  adapter: Pick<PdfRenderer, 'renderPage'>,
  id: SourceId,
  opened: OpenedDocument,
  pageIndex: number,
): Promise<Rendered> {
  const { bitmap } = await adapter.renderPage(id, pageIndex, { scale: SCALE });
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
export interface PdfjsAnnotation {
  readonly subtype: string;
  readonly borderStyle?: { readonly width: number };
  readonly inkLists?: readonly ArrayLike<number>[];
}

/** pdf.js's canvas render of `bytes` with annotation appearances, as Firefox shows a page. */
export async function renderPdfjs(
  bytes: ArrayBuffer,
  pageIndices: readonly number[],
): Promise<{ pages: Map<number, Rendered>; annotations: Map<number, PdfjsAnnotation[]> }> {
  pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;
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

/** What a saved file holds for one ink annotation (pdf-lib). */
export interface SavedInk {
  readonly keys: readonly string[];
  readonly rect: readonly number[];
  readonly bsWidth: number | undefined;
  readonly widths: string | undefined;
  readonly apBBox: readonly number[];
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

export async function savedInk(
  bytes: ArrayBuffer,
  pageIndex: number,
  nm: string,
): Promise<SavedInk> {
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
    const bs = dict.lookupMaybe(PDFName.of('BS'), PDFDict);
    return {
      keys: dict.keys().map((k) => k.asString()),
      rect: numbersOf(doc, dict.get(PDFName.of('Rect'))),
      bsWidth: bs?.lookupMaybe(PDFName.of('W'), PDFNumber)?.asNumber(),
      widths: textOf(dict.get(PDFName.of(INK_WIDTHS_KEY))),
      apBBox: numbersOf(doc, stream?.dict.get(PDFName.of('BBox'))),
      apExtGStateCA: gs?.lookupMaybe(PDFName.of('CA'), PDFNumber)?.asNumber(),
    };
  }
  throw new Error(`No annotation ${nm} on page ${pageIndex + 1}`);
}

/** Form XObjects in a file, and how many of them nothing reaches from the catalog. */
export async function formXObjects(
  bytes: ArrayBuffer,
): Promise<{ forms: number; unreachable: number }> {
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
