/**
 * Automated cross-viewer matrix for docs/qa/samples/annotations-sample.pdf. Renders every
 * page of the committed sample at 2× with two independent renderers and checks each entry
 * of the sample plan (annotation-sample-plan.ts) against the pixels and the annotation data:
 *
 * - PDFium: the app's own PdfiumAdapter (`renderPage`, `listAnnotations`), i.e. what
 *   Chrome-class viewers draw and what our comment UI reads.
 * - pdf.js: pdfjs-dist, as Firefox shows a page: the canvas render with annotation
 *   appearances (`AnnotationMode.ENABLE_FORMS`) plus pdf.js's own annotation layer (notes
 *   are drawn on their own canvas there, upright, and popups are HTML), screenshotted;
 *   `getAnnotations()` and the layer's DOM stand in for Firefox's comment UI.
 *
 *   pnpm --filter @pdf-editor/qa-tool matrix         # the committed sample
 *   pnpm --filter @pdf-editor/qa-tool matrix:fresh   # regenerate it first
 *
 * Writes the results table into docs/qa/annotations-matrix.md (between the
 * `matrix:auto` markers) and a contact sheet per renderer to docs/qa/samples, then fails
 * when any cell is `fail`. Everything loads offline: the pdf.js worker, its standard font
 * data and its viewer stylesheet come from node_modules through Vite.
 */

import wasmUrl from '@embedpdf/pdfium/pdfium.wasm?url';
import { type Annotation, PdfiumAdapter, PdfLibAssembler } from '@pdf-editor/engine';
import type { SourceId } from '@pdf-editor/document-model';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfjsWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import standardFontUrl from 'pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf?url';
import 'pdfjs-dist/legacy/web/pdf_viewer.css';
import { expect, test } from 'vitest';
import { commands, page } from 'vitest/browser';

import {
  displayRegion,
  LINK_URI,
  PAGE_ROTATIONS,
  PLAN,
  type PdfSubtype,
  type MatrixRow,
  type PlanEntry,
  planEntry,
  plannedWidth,
  pointToDisplay,
  type Rect,
  ROWS,
  SAMPLE_PATH,
  userToDisplay,
} from './annotation-sample-plan';

const MATRIX_MD = '../../docs/qa/annotations-matrix.md';
const SHEET_PATH = (renderer: RendererId) =>
  `../../docs/qa/samples/annotations-matrix-${renderer}.png`;
const START = '<!-- matrix:auto:start -->';
const END = '<!-- matrix:auto:end -->';
/** Render scale for the checks (the contact sheets are drawn at 1×). */
const SCALE = 2;
/** Where crops of non-ok regions go (QA_MATRIX_EVIDENCE_DIR, see vitest.config.ts); '' = none. */
const EVIDENCE_DIR = __MATRIX_EVIDENCE_DIR__;

type RendererId = 'pdfium' | 'pdfjs';
const RENDERERS: readonly RendererId[] = ['pdfium', 'pdfjs'];

// ---------------------------------------------------------------------------------------
// What each renderer yields
// ---------------------------------------------------------------------------------------

interface Raster {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

/** An annotation as a renderer reports it (user space). */
interface ReportedAnnotation {
  readonly subtype: string;
  readonly rect: Rect;
  readonly quads?: readonly Rect[];
  readonly contents?: string;
  readonly open?: boolean;
  readonly uri?: string;
  /** Ink: the stroke width the renderer reports (/BS /W). */
  readonly strokeWidth?: number;
  /** pdf.js: the annotation id its layer uses (`data-annotation-id`). */
  readonly layerId?: string;
}

/** What pdf.js's annotation layer showed for a note or link. */
interface LayerFacts {
  /** Popup text visible right after rendering (open popups), by annotation layer id. */
  readonly openPopups: ReadonlyMap<string, string>;
  /** Popup text visible after clicking the annotation, by annotation layer id. */
  readonly clickedPopups: ReadonlyMap<string, string>;
  /** Link targets with their boxes in display space (points). */
  readonly links: readonly { readonly href: string; readonly box: Rect }[];
}

interface RenderedPage {
  readonly raster: Raster;
  readonly annotations: readonly ReportedAnnotation[];
  readonly layer?: LayerFacts;
}

interface RendererRun {
  readonly id: RendererId;
  readonly title: string;
  readonly pages: readonly RenderedPage[];
}

// ---------------------------------------------------------------------------------------
// PDFium (the app's adapter)
// ---------------------------------------------------------------------------------------

const SUBTYPE_OF_KIND: Record<Annotation['kind'], PdfSubtype | 'Redact'> = {
  highlight: 'Highlight',
  underline: 'Underline',
  strikeout: 'StrikeOut',
  squiggly: 'Squiggly',
  redact: 'Redact',
  ink: 'Ink',
  square: 'Square',
  circle: 'Circle',
  line: 'Line',
  polygon: 'Polygon',
  polyline: 'PolyLine',
  'free-text': 'FreeText',
  text: 'Text',
  stamp: 'Stamp',
  link: 'Link',
};

function fromEngine(a: Annotation): ReportedAnnotation {
  return {
    subtype: SUBTYPE_OF_KIND[a.kind],
    rect: a.rect,
    ...('quads' in a ? { quads: a.quads } : {}),
    ...(a.contents === undefined ? {} : { contents: a.contents }),
    ...(a.kind === 'text' && a.open !== undefined ? { open: a.open } : {}),
    ...(a.kind === 'link' && a.uri !== undefined ? { uri: a.uri } : {}),
    ...(a.kind === 'ink' ? { strokeWidth: a.strokeWidth } : {}),
  };
}

function bitmapRaster(bitmap: ImageBitmap): Raster {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No 2D canvas');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

async function renderWithPdfium(bytes: ArrayBuffer): Promise<RendererRun> {
  const adapter = new PdfiumAdapter({ wasmUrl, inspector: new PdfLibAssembler() });
  const id = 'qa-matrix' as SourceId;
  try {
    await adapter.open(id, bytes.slice(0));
    const pages: RenderedPage[] = [];
    for (let pageIndex = 0; pageIndex < PAGE_ROTATIONS.length; pageIndex++) {
      const { bitmap } = await adapter.renderPage(id, pageIndex, { scale: SCALE });
      const annotations = await adapter.listAnnotations(id, pageIndex);
      pages.push({ raster: bitmapRaster(bitmap), annotations: annotations.map(fromEngine) });
    }
    return {
      id: 'pdfium',
      title: `PDFium (ours / Chrome-class), @embedpdf/pdfium ${__PDFIUM_PACKAGE_VERSION__}`,
      pages,
    };
  } finally {
    await adapter.destroy();
  }
}

// ---------------------------------------------------------------------------------------
// pdf.js (Firefox)
// ---------------------------------------------------------------------------------------

/** The fields of `PDFPageProxy.getAnnotations()` entries this checker reads. */
interface PdfjsAnnotationData {
  readonly id: string;
  readonly subtype: string;
  readonly rect: readonly number[];
  readonly quadPoints?: ArrayLike<number> | null;
  readonly contentsObj?: { readonly str: string } | null;
  readonly url?: string;
  readonly open?: boolean;
  readonly popupRef?: string | null;
  readonly borderStyle?: { readonly width: number } | null;
}

function rectOf(r: readonly number[]): Rect {
  const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = r;
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

function quadsOf(points: ArrayLike<number>): Rect[] {
  const quads: Rect[] = [];
  for (let i = 0; i + 8 <= points.length; i += 8) {
    const xs = [0, 2, 4, 6].map((k) => points[i + k] ?? 0);
    const ys = [1, 3, 5, 7].map((k) => points[i + k] ?? 0);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    quads.push({ x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y });
  }
  return quads;
}

function fromPdfjs(all: readonly PdfjsAnnotationData[]): ReportedAnnotation[] {
  const popups = new Map(all.filter((a) => a.subtype === 'Popup').map((a) => [a.id, a]));
  return all
    .filter((a) => a.subtype !== 'Popup')
    .map((a) => {
      const popup = a.popupRef ? popups.get(a.popupRef) : undefined;
      return {
        subtype: a.subtype,
        rect: rectOf(a.rect),
        layerId: a.id,
        ...(a.quadPoints ? { quads: quadsOf(a.quadPoints) } : {}),
        ...(a.contentsObj?.str ? { contents: a.contentsObj.str } : {}),
        ...(popup ? { open: popup.open === true } : {}),
        ...(a.url === undefined ? {} : { uri: a.url }),
        ...(a.subtype === 'Ink' && a.borderStyle ? { strokeWidth: a.borderStyle.width } : {}),
      };
    });
}

const STYLE = `
  body { margin: 0; }
  .qa-viewer { position: absolute; left: 0; top: 0; }
  .qa-viewer .page { margin: 0; border: 0; }
  .qa-viewer.qa-shot .popupAnnotation, .qa-viewer.qa-shot .popup { visibility: hidden !important; }
`;

async function screenshotRaster(element: HTMLElement): Promise<Raster> {
  const base64 = await page.screenshot({ element, save: false });
  const blob = await (await fetch(`data:image/png;base64,${base64}`)).blob();
  return bitmapRaster(await createImageBitmap(blob));
}

function isShown(element: Element): boolean {
  return element.checkVisibility({ visibilityProperty: true }) && !element.closest('[hidden]');
}

/** Text of the popups visible in `layer`. */
function visiblePopupText(layer: HTMLElement): string {
  return [...layer.querySelectorAll('.popup')]
    .filter(isShown)
    .map((p) => p.textContent)
    .join(' ');
}

async function layerFacts(
  layerDiv: HTMLElement,
  pageDiv: HTMLElement,
  annotations: readonly ReportedAnnotation[],
): Promise<LayerFacts> {
  const openPopups = new Map<string, string>();
  const clickedPopups = new Map<string, string>();
  const initial = visiblePopupText(layerDiv);
  for (const a of annotations) {
    if (a.subtype !== 'Text' || !a.layerId) continue;
    const trigger = layerDiv.querySelector<HTMLElement>(`[data-annotation-id="${a.layerId}"]`);
    if (a.contents && initial.includes(a.contents)) {
      // Open on load: what the user sees is what clicking would show.
      openPopups.set(a.layerId, initial);
      clickedPopups.set(a.layerId, initial);
      continue;
    }
    if (!trigger) continue;
    // Clicking toggles the popup, as a user would; toggle back afterwards.
    trigger.click();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    clickedPopups.set(a.layerId, visiblePopupText(layerDiv));
    trigger.click();
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  const origin = pageDiv.getBoundingClientRect();
  const links = [...layerDiv.querySelectorAll<HTMLAnchorElement>('a[href]')].map((link) => {
    const box = link.getBoundingClientRect();
    return {
      href: link.href,
      box: {
        x: (box.left - origin.left) / SCALE,
        y: (box.top - origin.top) / SCALE,
        width: box.width / SCALE,
        height: box.height / SCALE,
      },
    };
  });
  return { openPopups, clickedPopups, links };
}

async function renderWithPdfjs(bytes: ArrayBuffer): Promise<RendererRun> {
  pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;
  // pdf_viewer.mjs (the viewer components Firefox uses) reads the library from this global.
  (globalThis as { pdfjsLib?: unknown }).pdfjsLib = pdfjs;
  const viewer = await import('pdfjs-dist/legacy/web/pdf_viewer.mjs');
  // Served by Vite from node_modules (a font file is too large to be inlined as data:).
  const fontDir = new URL('./', new URL(standardFontUrl, location.href)).href;
  // Note icons: pdf.js puts an <img> from here over notes (an empty SVG when the note has
  // its own appearance); without it the browser would draw a broken-image glyph.
  const imageDir = new URL('../legacy/web/images/', fontDir).href;
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(bytes.slice(0)),
    standardFontDataUrl: fontDir,
    enableXfa: false,
  }).promise;
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.append(style);
  const eventBus = new viewer.EventBus();
  // pdf.js's link service for a page shown without its full viewer (external links on).
  const linkService = new viewer.SimpleLinkService({ eventBus });
  const pages: RenderedPage[] = [];
  try {
    for (let pageIndex = 0; pageIndex < doc.numPages; pageIndex++) {
      const pdfPage = await doc.getPage(pageIndex + 1);
      const viewport = pdfPage.getViewport({ scale: SCALE });
      const container = document.createElement('div');
      container.className = 'pdfViewer qa-viewer';
      container.style.setProperty('--scale-factor', String(viewport.scale));
      const pageDiv = document.createElement('div');
      pageDiv.className = 'page';
      pageDiv.style.width = `${viewport.width}px`;
      pageDiv.style.height = `${viewport.height}px`;
      const wrapper = document.createElement('div');
      wrapper.className = 'canvasWrapper';
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      wrapper.append(canvas);
      pageDiv.append(wrapper);
      container.append(pageDiv);
      document.body.append(container);
      const annotationCanvasMap = new Map<string, HTMLCanvasElement>();
      await pdfPage.render({
        canvas,
        viewport,
        annotationMode: pdfjs.AnnotationMode.ENABLE_FORMS,
        annotationCanvasMap,
      }).promise;
      const builder = new viewer.AnnotationLayerBuilder({
        pdfPage,
        linkService,
        renderForms: true,
        imageResourcesPath: imageDir,
        annotationCanvasMap,
        onAppend: (div: HTMLDivElement) => {
          pageDiv.append(div);
        },
      });
      await builder.render({ viewport, intent: 'display' });
      const data = (await pdfPage.getAnnotations({ intent: 'display' })) as PdfjsAnnotationData[];
      const annotations = fromPdfjs(data);
      const layerDiv = builder.div;
      if (!layerDiv) throw new Error('pdf.js did not create an annotation layer');
      const layer = await layerFacts(layerDiv, pageDiv, annotations);
      container.classList.add('qa-shot');
      const raster = await screenshotRaster(pageDiv);
      if (raster.width !== canvas.width || raster.height !== canvas.height) {
        throw new Error(
          `Screenshot is ${raster.width}×${raster.height}, expected ${canvas.width}×${canvas.height} (device pixel ratio or viewport too small?)`,
        );
      }
      pages.push({ raster, annotations, layer });
      builder.cancel();
      container.remove();
      pdfPage.cleanup();
    }
  } finally {
    style.remove();
    await doc.loadingTask.destroy();
  }
  return { id: 'pdfjs', title: `pdf.js (Firefox), pdfjs-dist ${pdfjs.version ?? '?'}`, pages };
}

// ---------------------------------------------------------------------------------------
// Pixel checks
// ---------------------------------------------------------------------------------------

type Rgb = readonly [number, number, number];

function hexRgb(hex: string): Rgb {
  const channel = (i: number) => Number.parseInt(hex.slice(i, i + 2), 16);
  return [channel(1), channel(3), channel(5)];
}

const hex = (c: Rgb) =>
  `#${c
    .map((v) => Math.round(v).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()}`;
/** How far a colour is from white (0 = white). */
const ink = (r: number, g: number, b: number) => Math.max(255 - r, 255 - g, 255 - b);
const saturation = (r: number, g: number, b: number) => Math.max(r, g, b) - Math.min(r, g, b);
const luma = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;
const diff = (a: Rgb, r: number, g: number, b: number) =>
  Math.max(Math.abs(a[0] - r), Math.abs(a[1] - g), Math.abs(a[2] - b));

/** A pixel box (display space × SCALE), clipped to the raster; x1/y1 exclusive. */
interface Box {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

function boxOf(raster: Raster, rect: Rect, pad = 0): Box {
  return {
    x0: Math.max(0, Math.floor((rect.x - pad) * SCALE)),
    y0: Math.max(0, Math.floor((rect.y - pad) * SCALE)),
    x1: Math.min(raster.width, Math.ceil((rect.x + rect.width + pad) * SCALE)),
    y1: Math.min(raster.height, Math.ceil((rect.y + rect.height + pad) * SCALE)),
  };
}

function forEachPixel(
  raster: Raster,
  box: Box,
  fn: (r: number, g: number, b: number, x: number, y: number) => void,
): void {
  for (let y = box.y0; y < box.y1; y++) {
    for (let x = box.x0; x < box.x1; x++) {
      const i = (y * raster.width + x) * 4;
      fn(raster.data[i] ?? 255, raster.data[i + 1] ?? 255, raster.data[i + 2] ?? 255, x, y);
    }
  }
}

/** Colour tolerance: tighter for pale colours, so an opaque fill is told from a 50 % one. */
function tolerance(expected: Rgb): number {
  return Math.min(40, Math.max(10, ink(...expected) / 2));
}

/**
 * The dominant inked colour of a box: the most populated 16-level RGB bucket among pixels
 * that are inked about as strongly as the expected colour (which drops anti-aliased edges)
 * and, for a chromatic expectation, not grey (which drops black text under a markup).
 */
function dominantColour(raster: Raster, box: Box, expected: Rgb): Rgb | undefined {
  const minInk = Math.max(8, ink(...expected) * 0.6);
  const expectedSat = saturation(...expected);
  const minSat = expectedSat >= 24 ? Math.min(24, expectedSat / 2) : -1;
  const buckets = new Map<number, [number, number, number, number]>();
  forEachPixel(raster, box, (r, g, b) => {
    if (ink(r, g, b) < minInk || saturation(r, g, b) <= minSat) return;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const sum = buckets.get(key) ?? [0, 0, 0, 0];
    sum[0] += r;
    sum[1] += g;
    sum[2] += b;
    sum[3] += 1;
    buckets.set(key, sum);
  });
  let best: [number, number, number, number] | undefined;
  for (const sum of buckets.values()) if (!best || sum[3] > best[3]) best = sum;
  return best ? [best[0] / best[3], best[1] / best[3], best[2] / best[3]] : undefined;
}

/** Pixels close to the expected colour (and not white): count, bbox and centroid. */
function matching(raster: Raster, box: Box, expected: Rgb) {
  const tol = Math.min(tolerance(expected) * 1.5, ink(...expected) - 6);
  let count = 0;
  let sumX = 0;
  let sumY = 0;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  forEachPixel(raster, box, (r, g, b, x, y) => {
    if (diff(expected, r, g, b) > tol) return;
    count++;
    sumX += x + 0.5;
    sumY += y + 0.5;
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x + 1);
    y1 = Math.max(y1, y + 1);
  });
  return {
    count,
    centroid: count ? { x: sumX / count / SCALE, y: sumY / count / SCALE } : undefined,
    bbox: count
      ? { x: x0 / SCALE, y: y0 / SCALE, width: (x1 - x0) / SCALE, height: (y1 - y0) / SCALE }
      : undefined,
  };
}

function countPixels(
  raster: Raster,
  box: Box,
  test: (r: number, g: number, b: number) => boolean,
): number {
  let n = 0;
  forEachPixel(raster, box, (r, g, b) => {
    if (test(r, g, b)) n++;
  });
  return n;
}

const fmt = (n: number) => String(Math.round(n));
const fmtRect = (r: Rect) =>
  `x ${fmt(r.x)}–${fmt(r.x + r.width)}, y ${fmt(r.y)}–${fmt(r.y + r.height)} pt`;

/** How far (points) the drawing may stick out of the expected region. */
const PLACEMENT_SLACK = 4;
/** The margin (points) searched around the region for misplaced drawing. */
const SEARCH_MARGIN = 6;

/** A failed expectation; `code` marks the kinds a known renderer difference may excuse. */
interface Problem {
  readonly text: string;
  readonly code?: 'norotate-footprint';
}

const problem = (text: string): Problem => ({ text });

function checkAppearance(entry: PlanEntry, rendered: RenderedPage): Problem[] {
  const appearance = entry.appearance;
  if (!appearance) return [];
  const problems: Problem[] = [];
  const rotation = PAGE_ROTATIONS[entry.annotation.pageIndex] ?? 0;
  const { raster } = rendered;
  const region = displayRegion(appearance, rotation);
  const box = boxOf(raster, region);
  const expected = hexRgb(appearance.colour);

  if (appearance.placement === 'no-rotate' && rotation % 360 !== 0) {
    // Where the icon went instead: the rotated /Rect footprint (a renderer that pivots about
    // another corner, or turns the icon with the page).
    const footprint = userToDisplay(appearance.region, rotation);
    const inFootprint = matching(raster, boxOf(raster, footprint), expected).count;
    const atCorner = matching(raster, box, expected).count;
    if (inFootprint > atCorner) {
      return [
        {
          code: 'norotate-footprint',
          text: `icon placed in the rotated /Rect footprint (${fmtRect(footprint)}), not hung from the /Rect's upper-left corner (${fmtRect(region)})`,
        },
      ];
    }
  }

  const inked = countPixels(raster, box, (r, g, b) => ink(r, g, b) > 16);
  if (inked < 20) return [problem(`nothing drawn at ${fmtRect(region)} (display)`)];
  const dominant = dominantColour(raster, box, expected);
  if (!dominant || diff(expected, ...dominant) > tolerance(expected)) {
    const got = dominant ? hex(dominant) : 'none';
    problems.push(problem(`colour ${got} instead of ${appearance.colour}`));
  }

  const found = matching(raster, boxOf(raster, region, SEARCH_MARGIN), expected);
  if (found.bbox) {
    const b = found.bbox;
    const outside =
      b.x < region.x - PLACEMENT_SLACK ||
      b.y < region.y - PLACEMENT_SLACK ||
      b.x + b.width > region.x + region.width + PLACEMENT_SLACK ||
      b.y + b.height > region.y + region.height + PLACEMENT_SLACK;
    if (outside) {
      problems.push(problem(`drawn at ${fmtRect(b)}, expected ${fmtRect(region)} (display)`));
    }
    const spanX = b.width / region.width;
    const spanY = b.height / region.height;
    if (appearance.span !== 'none' && spanX < 0.6) {
      problems.push(problem(`spans ${fmt(spanX * 100)} % of the expected width`));
    }
    if (appearance.span === 'both' && spanY < 0.6) {
      problems.push(problem(`spans ${fmt(spanY * 100)} % of the expected height`));
    }
  }

  if (appearance.textVisible) {
    const textBox = boxOf(raster, userToDisplay(appearance.textVisible, rotation));
    const dark = countPixels(raster, textBox, (r, g, b) => luma(r, g, b) < 128);
    if (dark < 25) problems.push(problem(`text under it not visible (${dark} dark pixels)`));
  }

  if (appearance.exclusive) {
    const foreign = countPixels(
      raster,
      box,
      (r, g, b) => ink(r, g, b) > 64 && saturation(r, g, b) < 24,
    );
    if (foreign >= 20) {
      const what = `black or grey ink besides the ${appearance.colour} appearance`;
      problems.push(problem(`${what} (${foreign} pixels at 2×)`));
    }
  }

  if (appearance.strokeBand && rotation % 360 === 0) {
    const [lo, hi] = appearance.strokeBand;
    const stroke = matching(raster, box, expected);
    if (!stroke.centroid) {
      problems.push(problem('no stroke in the expected colour'));
    } else {
      // Height of the stroke's centre above the region's bottom edge, as a fraction.
      const f = (region.y + region.height - stroke.centroid.y) / region.height;
      if (f < lo || f > hi) {
        const band = `${fmt(lo * 100)}–${fmt(hi * 100)} %`;
        problems.push(problem(`stroke at ${fmt(f * 100)} % of the line height, expected ${band}`));
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------
// Variable-width ink (ADR-0018)
// ---------------------------------------------------------------------------------------

/**
 * Share (0–1) of the expected colour in a pixel: its ink projected onto "white → expected"
 * (anti-aliased edges count partly); pixels of another colour count 0.
 */
function coverage(raster: Raster, x: number, y: number, expected: Rgb): number {
  if (x < 0 || y < 0 || x >= raster.width || y >= raster.height) return 0;
  const i = (y * raster.width + x) * 4;
  const v = [0, 1, 2].map((c) => 255 - (raster.data[i + c] ?? 255));
  const d = expected.map((c) => 255 - c);
  const dd = d.reduce((sum, e) => sum + e * e, 0);
  if (dd === 0) return 0;
  const a = v.reduce((sum, e, c) => sum + e * (d[c] ?? 0), 0) / dd;
  const residual = Math.hypot(...v.map((e, c) => e - a * (d[c] ?? 0)));
  return residual > 48 ? 0 : Math.min(Math.max(a, 0), 1);
}

/** Bilinear coverage at a continuous pixel position. */
function coverageAt(raster: Raster, x: number, y: number, expected: Rgb): number {
  const fx = x - 0.5;
  const fy = y - 0.5;
  const i = Math.floor(fx);
  const j = Math.floor(fy);
  const u = fx - i;
  const v = fy - j;
  return (
    coverage(raster, i, j, expected) * (1 - u) * (1 - v) +
    coverage(raster, i + 1, j, expected) * u * (1 - v) +
    coverage(raster, i, j + 1, expected) * (1 - u) * v +
    coverage(raster, i + 1, j + 1, expected) * u * v
  );
}

/**
 * The drawn width of a straight variable-width stroke at each planned position: coverage
 * integrated across the stroke (in points, through the page rotation), and where its centre
 * lies relative to the centre line. Spike S1's measure (docs/research/09-ink-appearance-spike.md).
 */
function checkWidth(entry: PlanEntry, rendered: RenderedPage): Problem[] {
  const profile = entry.widthProfile;
  const appearance = entry.appearance;
  if (!profile || !appearance) return [problem('the plan has no width profile for it')];
  const rotation = PAGE_ROTATIONS[entry.annotation.pageIndex] ?? 0;
  const expected = hexRgb(appearance.colour);
  const dx = profile.to.x - profile.from.x;
  const dy = profile.to.y - profile.from.y;
  const length = Math.hypot(dx, dy);
  const normal = { x: -dy / length, y: dx / length };
  const step = 0.05;
  const reach = Math.max(profile.startWidth, profile.endWidth) + 4;
  const samples = profile.at.map((t) => {
    const c = { x: profile.from.x + dx * t, y: profile.from.y + dy * t };
    let sum = 0;
    let moment = 0;
    for (let s = -reach; s <= reach; s += step) {
      const p = pointToDisplay(c.x + normal.x * s, c.y + normal.y * s, rotation);
      const cov = coverageAt(rendered.raster, p.x * SCALE, p.y * SCALE, expected) * step;
      sum += cov;
      moment += cov * s;
    }
    return { t, planned: plannedWidth(profile, t), width: sum, offset: sum > 0 ? moment / sum : 0 };
  });
  const drawn = samples.map((s) => s.width.toFixed(2)).join('/');
  const planned = samples.map((s) => s.planned.toFixed(1)).join('/');
  const problems: Problem[] = [];
  if (samples.some((s) => Math.abs(s.width - s.planned) > profile.tolerance)) {
    problems.push(problem(`drawn width ${drawn} pt, planned ${planned} pt`));
  }
  if (samples.some((s) => Math.abs(s.offset) > profile.tolerance)) {
    const offsets = samples.map((s) => s.offset.toFixed(2)).join('/');
    problems.push(problem(`drawn off the centre line by ${offsets} pt`));
  }
  const first = samples[0]?.width ?? 0;
  const last = samples[samples.length - 1]?.width ?? 0;
  if (first <= 0 || last / first < profile.minRatio) {
    problems.push(problem(`width does not vary (${drawn} pt)`));
  }
  return problems;
}

function checkNominalWidth(entry: PlanEntry, a: ReportedAnnotation): Problem[] {
  const nominal = entry.annotation.kind === 'ink' ? entry.annotation.strokeWidth : undefined;
  if (nominal === undefined) return [problem('not an ink')];
  return a.strokeWidth === nominal
    ? []
    : [problem(`stroke width ${a.strokeWidth ?? 'missing'}, expected ${nominal}`)];
}

// ---------------------------------------------------------------------------------------
// Orientation of a note icon on a rotated page
// ---------------------------------------------------------------------------------------

interface Mask {
  readonly w: number;
  readonly h: number;
  readonly bits: Uint8Array;
}

/** Inked pixels (ink > 64) of `rect`, cropped to their bounding box. */
function inkMask(raster: Raster, rect: Rect): Mask | undefined {
  const box = boxOf(raster, rect);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  forEachPixel(raster, box, (r, g, b, x, y) => {
    if (ink(r, g, b) <= 64) return;
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x + 1);
    y1 = Math.max(y1, y + 1);
  });
  if (x1 <= x0 || x1 - x0 < 4 || y1 - y0 < 4) return undefined;
  const w = x1 - x0;
  const h = y1 - y0;
  const bits = new Uint8Array(w * h);
  forEachPixel(raster, { x0, y0, x1, y1 }, (r, g, b, x, y) => {
    bits[(y - y0) * w + (x - x0)] = ink(r, g, b) > 64 ? 1 : 0;
  });
  return { w, h, bits };
}

/** `mask` turned clockwise by `quarters` × 90°. */
function turn(mask: Mask, quarters: number): Mask {
  let m = mask;
  for (let q = 0; q < quarters; q++) {
    const { w, h, bits } = m;
    const out = new Uint8Array(w * h);
    for (let y = 0; y < w; y++) {
      for (let x = 0; x < h; x++) out[y * h + x] = bits[(h - 1 - x) * w + y] ?? 0;
    }
    m = { w: h, h: w, bits: out };
  }
  return m;
}

/** Intersection over union of two masks, `b` resampled (nearest) to `a`'s size. */
function similarity(a: Mask, b: Mask): number {
  let both = 0;
  let either = 0;
  for (let y = 0; y < a.h; y++) {
    for (let x = 0; x < a.w; x++) {
      const bx = Math.min(b.w - 1, Math.floor(((x + 0.5) * b.w) / a.w));
      const by = Math.min(b.h - 1, Math.floor(((y + 0.5) * b.h) / a.h));
      const p = a.bits[y * a.w + x] === 1;
      const q = b.bits[by * b.w + bx] === 1;
      if (p && q) both++;
      if (p || q) either++;
    }
  }
  return either ? both / either : 0;
}

const union = (a: Rect, b: Rect): Rect => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
};

const grow = (r: Rect, by: number): Rect => ({
  x: r.x - by,
  y: r.y - by,
  width: r.width + 2 * by,
  height: r.height + 2 * by,
});

/**
 * Compares the note icon on a rotated page with the same renderer's page-1 note (same icon,
 * upright page): the best-matching quarter turn tells whether it was turned with the page.
 */
function checkUpright(entry: PlanEntry, run: RendererRun): Problem[] {
  const appearance = entry.appearance;
  const reference = planEntry('note').appearance;
  const rotation = PAGE_ROTATIONS[entry.annotation.pageIndex] ?? 0;
  const page1 = run.pages[0];
  const rendered = run.pages[entry.annotation.pageIndex];
  if (!appearance || !reference || !page1 || !rendered) return [problem('nothing to compare')];
  const upright = inkMask(page1.raster, grow(displayRegion(reference, 0), 2));
  const window = union(
    displayRegion(appearance, rotation),
    userToDisplay(appearance.region, rotation),
  );
  const candidate = inkMask(rendered.raster, grow(window, 2));
  if (!upright) return [problem('the page-1 note icon (the reference) is missing')];
  if (!candidate) return [problem(`no icon near ${fmtRect(window)} (display)`)];
  const scores = [0, 1, 2, 3].map((q) => similarity(candidate, turn(upright, q)));
  const [straight = 0] = scores;
  const best = scores.indexOf(Math.max(...scores));
  if (best !== 0 && (scores[best] ?? 0) > straight + 0.05) {
    return [problem(`icon turned ${best * 90}° clockwise (with the page)`)];
  }
  if (straight < 0.5) {
    return [
      problem(`icon does not match the upright page-1 icon (similarity ${straight.toFixed(2)})`),
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------------------
// Data checks
// ---------------------------------------------------------------------------------------

function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** The reported annotation for a plan entry: same subtype, largest overlap with its geometry. */
function reportedFor(entry: PlanEntry, rendered: RenderedPage): ReportedAnnotation | undefined {
  let best: ReportedAnnotation | undefined;
  let bestArea = 0;
  for (const a of rendered.annotations) {
    if (a.subtype !== entry.subtype) continue;
    const area = overlap(a.rect, entry.geometry);
    if (area > bestArea) {
      best = a;
      bestArea = area;
    }
  }
  return best;
}

const near = (a: Rect, b: Rect, tol: number) =>
  Math.abs(a.x - b.x) <= tol &&
  Math.abs(a.y - b.y) <= tol &&
  Math.abs(a.width - b.width) <= tol &&
  Math.abs(a.height - b.height) <= tol;

function checkData(entry: PlanEntry, a: ReportedAnnotation): Problem[] {
  const problems: Problem[] = [];
  const g = entry.geometry;
  const covers =
    a.rect.x <= g.x + 1 &&
    a.rect.y <= g.y + 1 &&
    a.rect.x + a.rect.width >= g.x + g.width - 1 &&
    a.rect.y + a.rect.height >= g.y + g.height - 1;
  const bounded =
    a.rect.x >= g.x - 16 &&
    a.rect.y >= g.y - 16 &&
    a.rect.x + a.rect.width <= g.x + g.width + 16 &&
    a.rect.y + a.rect.height <= g.y + g.height + 16;
  if (!covers || !bounded) {
    problems.push(problem(`/Rect ${fmtRect(a.rect)}, expected about ${fmtRect(g)}`));
  }
  if ('quads' in entry.annotation) {
    const expected = entry.annotation.quads;
    const got = a.quads ?? [];
    const same = expected.every((q, i) => {
      const other = got[i];
      return other !== undefined && near(q, other, 1);
    });
    if (got.length !== expected.length || !same) {
      problems.push(problem(`QuadPoints ${got.map(fmtRect).join('; ') || 'missing'}`));
    }
  }
  const contents = entry.annotation.contents;
  if (contents !== undefined && a.contents !== contents) {
    problems.push(problem(`contents "${a.contents ?? ''}" instead of "${contents}"`));
  }
  return problems;
}

/** The plan entries a row checks. */
function rowKeys(row: MatrixRow): string[] {
  return [row.key, ...(row.alsoKeys ?? [])];
}

function checkRow(run: RendererRun, row: MatrixRow): Problem[] {
  const keys = rowKeys(row);
  if (keys.length === 1) return checkEntry(run, row, row.key);
  // Several entries: each problem names its entry.
  return keys.flatMap((key) =>
    checkEntry(run, row, key).map((p) => ({ ...p, text: `${key}: ${p.text}` })),
  );
}

function checkEntry(run: RendererRun, row: MatrixRow, key: string): Problem[] {
  const entry = planEntry(key);
  const { aspects } = row;
  const rendered = run.pages[entry.annotation.pageIndex];
  if (!rendered) return [problem('page not rendered')];
  const problems: Problem[] = [];
  if (aspects.includes('appearance')) problems.push(...checkAppearance(entry, rendered));
  if (aspects.includes('upright')) problems.push(...checkUpright(entry, run));
  if (aspects.includes('width')) problems.push(...checkWidth(entry, rendered));
  const reads = ['data', 'contents', 'open', 'uri', 'nominal-width'] as const;
  if (!aspects.some((a) => (reads as readonly string[]).includes(a))) return problems;
  const reported = reportedFor(entry, rendered);
  if (!reported) return [...problems, problem(`no ${entry.subtype} annotation reported`)];
  if (aspects.includes('data')) problems.push(...checkData(entry, reported));
  if (aspects.includes('nominal-width')) problems.push(...checkNominalWidth(entry, reported));
  const contents = entry.annotation.contents ?? '';
  const layer = rendered.layer;
  const layerId = reported.layerId ?? '';
  if (aspects.includes('contents')) {
    if (reported.contents !== contents) {
      problems.push(problem(`contents "${reported.contents ?? ''}" instead of "${contents}"`));
    }
    if (layer && !(layer.clickedPopups.get(layerId) ?? '').includes(contents)) {
      problems.push(problem('annotation layer shows no popup with the text for the note'));
    }
  }
  if (aspects.includes('open')) {
    if (reported.open !== true) problems.push(problem(`popup open state ${String(reported.open)}`));
    if (layer && !layer.openPopups.has(layerId)) {
      problems.push(problem('annotation layer does not show the popup on load'));
    }
  }
  if (aspects.includes('uri')) {
    if (reported.uri !== LINK_URI) problems.push(problem(`URI "${reported.uri ?? ''}"`));
    if (layer) {
      const rotation = PAGE_ROTATIONS[entry.annotation.pageIndex] ?? 0;
      const expected = userToDisplay(entry.geometry, rotation);
      const link = layer.links.find((l) => l.href === LINK_URI);
      if (!link) {
        problems.push(problem('annotation layer has no link to the URI'));
      } else if (!near(link.box, expected, 2)) {
        problems.push(problem(`link area at ${fmtRect(link.box)}, expected ${fmtRect(expected)}`));
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------------------

/**
 * Renderer behaviour that departs from ISO 32000 for every file, not because of the
 * sample. A cell whose only problems are listed here reads `differs: …` and does not fail
 * the run; any other problem still does. Keep this list short and specific.
 */
const KNOWN_DIFFERENCES: readonly {
  readonly renderer: RendererId;
  readonly key: string;
  readonly code: Problem['code'];
}[] = [
  // pdf.js keeps NoRotate annotations upright inside the rotated /Rect footprint (the
  // `.norotate` transform in its annotation layer CSS) instead of pivoting them about the
  // /Rect's upper-left corner; the icon is upright, one icon width from where ISO puts it.
  { renderer: 'pdfjs', key: 'rotated-note', code: 'norotate-footprint' },
];

type Verdict =
  | { readonly status: 'ok' }
  | { readonly status: 'differs' | 'fail'; readonly problems: readonly Problem[] };

function verdict(renderer: RendererId, key: string, problems: readonly Problem[]): Verdict {
  if (problems.length === 0) return { status: 'ok' };
  const known = problems.every((p) =>
    KNOWN_DIFFERENCES.some((k) => k.renderer === renderer && k.key === key && k.code === p.code),
  );
  return { status: known ? 'differs' : 'fail', problems };
}

function cellText(v: Verdict): string {
  if (v.status === 'ok') return 'ok';
  const text = v.problems.map((p) => p.text).join('; ');
  return `${v.status}: ${text}`.replaceAll('|', '\\|');
}

// ---------------------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------------------

const OUTLINE = { ok: '#00A152', differs: '#FF8F00', fail: '#D50000', none: '#1565C0' };

/**
 * Pages side by side at 1×, each plan region outlined with its entry's worst pixel verdict
 * (green ok, amber differs, red fail; dashed blue for an entry without an appearance).
 */
async function contactSheet(
  run: RendererRun,
  pixelVerdicts: ReadonlyMap<string, Verdict['status']>,
): Promise<string> {
  const gap = 24;
  const header = 28;
  const sizes = run.pages.map((p) => ({ w: p.raster.width / SCALE, h: p.raster.height / SCALE }));
  const width = gap + sizes.reduce((s, p) => s + p.w + gap, 0);
  const height = header + Math.max(...sizes.map((p) => p.h)) + gap;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No 2D canvas');
  ctx.fillStyle = '#E0E0E0';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#000000';
  ctx.font = 'bold 14px sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText(run.title, gap, header / 2);
  let left = gap;
  for (const [pageIndex, rendered] of run.pages.entries()) {
    const size = sizes[pageIndex] ?? { w: 0, h: 0 };
    const { raster } = rendered;
    const bitmap = await createImageBitmap(
      new ImageData(new Uint8ClampedArray(raster.data), raster.width, raster.height),
    );
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, left, header, size.w, size.h);
    bitmap.close();
    const rotation = PAGE_ROTATIONS[pageIndex] ?? 0;
    for (const entry of PLAN.filter((e) => e.annotation.pageIndex === pageIndex)) {
      const region = entry.appearance
        ? displayRegion(entry.appearance, rotation)
        : userToDisplay(entry.geometry, rotation);
      const colour = entry.appearance
        ? OUTLINE[pixelVerdicts.get(entry.key) ?? 'ok']
        : OUTLINE.none;
      ctx.strokeStyle = colour;
      ctx.lineWidth = 1;
      ctx.setLineDash(entry.appearance ? [] : [4, 2]);
      const x = left + region.x - 2.5;
      const y = header + region.y - 2.5;
      ctx.strokeRect(x, y, region.width + 5, region.height + 5);
      ctx.setLineDash([]);
      ctx.fillStyle = colour;
      ctx.font = '9px sans-serif';
      ctx.textBaseline = 'bottom';
      ctx.fillText(entry.key, x + 0.5, y - 1);
    }
    left += size.w + gap;
  }
  return pngBase64(canvas);
}

async function pngBase64(canvas: OffscreenCanvas): Promise<string> {
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return toBase64(new Uint8Array(await blob.arrayBuffer()));
}

/** A 2× crop around an entry's region (and footprint), for the evidence directory. */
async function evidenceCrop(run: RendererRun, entry: PlanEntry): Promise<string | undefined> {
  const rendered = run.pages[entry.annotation.pageIndex];
  const rotation = PAGE_ROTATIONS[entry.annotation.pageIndex] ?? 0;
  if (!rendered) return undefined;
  const footprint = userToDisplay(entry.geometry, rotation);
  const area = grow(
    entry.appearance ? union(displayRegion(entry.appearance, rotation), footprint) : footprint,
    16,
  );
  const box = boxOf(rendered.raster, area);
  const w = box.x1 - box.x0;
  const h = box.y1 - box.y0;
  if (w <= 0 || h <= 0) return undefined;
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if (!ctx) return undefined;
  const { raster } = rendered;
  ctx.putImageData(
    new ImageData(new Uint8ClampedArray(raster.data), raster.width, raster.height),
    -box.x0,
    -box.y0,
  );
  return pngBase64(canvas);
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function resultsTable(
  runs: readonly RendererRun[],
  verdicts: readonly (readonly Verdict[])[],
): string {
  const lines = [
    START,
    '<!-- Written by `pnpm --filter @pdf-editor/qa-tool matrix` (tools/qa/annotation-matrix.ts); do not edit by hand. -->',
    '',
    `| Check | ${runs.map((r) => r.title).join(' | ')} |`,
    `| --- | ${runs.map(() => '---').join(' | ')} |`,
  ];
  for (const [index, row] of ROWS.entries()) {
    const cells = runs.map((_, r) => cellText(verdicts[index]?.[r] ?? { status: 'ok' }));
    lines.push(`| ${row.title} | ${cells.join(' | ')} |`);
  }
  const all = verdicts.flat();
  const count = (status: Verdict['status']) => all.filter((v) => v.status === status).length;
  const sheets = runs.map((r) => `[${r.id}](samples/annotations-matrix-${r.id}.png)`).join(', ');
  lines.push(
    '',
    `${count('ok')} ok, ${count('differs')} differs, ${count('fail')} fail (of ${all.length}). ` +
      `Contact sheets: ${sheets}.`,
    END,
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------

test('annotation cross-viewer matrix (PDFium, pdf.js)', async () => {
  const bytes = fromBase64(await commands.readFile(SAMPLE_PATH, 'base64'));
  const runs = [await renderWithPdfium(bytes), await renderWithPdfjs(bytes)];
  expect(runs.map((r) => r.id)).toEqual(RENDERERS);

  const verdicts = ROWS.map((row) =>
    runs.map((run) => verdict(run.id, row.key, checkRow(run, row))),
  );

  for (const [r, run] of runs.entries()) {
    // Worst pixel verdict per entry, for the outlines and the evidence crops.
    const pixel = new Map<string, Verdict['status']>();
    const rank = { ok: 0, differs: 1, fail: 2 } as const;
    for (const [index, row] of ROWS.entries()) {
      const pixels: readonly string[] = ['appearance', 'upright', 'width'];
      if (!row.aspects.some((a) => pixels.includes(a))) continue;
      const status = verdicts[index]?.[r]?.status ?? 'ok';
      for (const key of rowKeys(row)) {
        if (rank[status] > rank[pixel.get(key) ?? 'ok']) pixel.set(key, status);
      }
    }
    await commands.writeFile(SHEET_PATH(run.id), await contactSheet(run, pixel), 'base64');
    if (EVIDENCE_DIR) {
      for (const [key, status] of pixel) {
        if (status === 'ok') continue;
        const crop = await evidenceCrop(run, planEntry(key));
        if (crop) await commands.writeFile(`${EVIDENCE_DIR}/${run.id}-${key}.png`, crop, 'base64');
      }
    }
  }

  const markdown = await commands.readFile(MATRIX_MD);
  const start = markdown.indexOf(START);
  const end = markdown.indexOf(END);
  if (start < 0 || end < start) throw new Error(`${MATRIX_MD} lacks the ${START} / ${END} markers`);
  await commands.writeFile(
    MATRIX_MD,
    markdown.slice(0, start) + resultsTable(runs, verdicts) + markdown.slice(end + END.length),
  );

  const failures = ROWS.flatMap((row, index) =>
    runs.flatMap((run, r) => {
      const v = verdicts[index]?.[r];
      return v?.status === 'fail' ? [`${row.title} [${run.id}]: ${cellText(v)}`] : [];
    }),
  );
  expect(failures, 'matrix cells marked fail').toEqual([]);
});
