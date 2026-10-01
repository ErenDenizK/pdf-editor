/**
 * Materializes `VirtualPage.resize` (document-model resize.ts) on a page of the output.
 *
 * Embedding the page as a Form XObject on a new page would be simpler but loses its
 * annotations, links and form widgets. Instead the copied page keeps its identity and:
 * (a) its page boxes become the new size: MediaBox and CropBox `[0 0 W H]`; BleedBox,
 *     TrimBox and ArtBox are transformed and clipped to it (dropped when nothing is left);
 * (b) its content streams are wrapped in `q <matrix> cm <content box> re W n … Q`, so the
 *     content is scaled and moved, and clipped to what the crop showed before (content the
 *     old CropBox hid does not appear in the margins a larger canvas opens up);
 * (c) every annotation's geometry goes through the same matrix: /Rect, /QuadPoints, /L,
 *     /Vertices, /InkList, /Path, /CL; /RD margins and /LL, /LLE, /LLO lengths are scaled,
 *     and so are the per-point ink widths in `/PdfEditorInkWidths` (ADR-0018, by the
 *     geometric mean of the two factors), so the first edit after the resize redraws the
 *     stroke at the width it shows.
 *     Appearance streams are left alone: a reader maps an appearance's transformed /BBox
 *     onto /Rect (ISO 32000-2 §12.5.5), so a scaled /Rect scales the appearance with it and
 *     streams shared between page occurrences are never rewritten;
 * (d) form widgets are annotations: their /Rect moves like any other, the fields stay
 *     fillable and readers generate new appearances in the new rectangle;
 * (e) destinations that target a resized page (link /Dest, GoTo /D, outline entries) are
 *     transformed with `transformDestination` by the caller once the target is known;
 * (f) everything happens in unrotated user space (the model stores the resize there), so
 *     /Rotate is untouched and a rotated page is resized "under" its rotation; the old
 *     CropBox is the content box, so crop and resize compose.
 *
 * Point transform: x' = a·x + e, y' = d·y + f (a, d > 0; no rotation or skew).
 *
 * Limitations:
 * - Annotations with the NoZoom flag (typically note icons) keep their on-screen size in
 *   readers that honour the flag; their /Rect is still moved, so the icon stays anchored.
 * - Border widths (/BS /W, /Border) and font sizes in /DA are not scaled: appearances that a
 *   reader regenerates (forms with /NeedAppearances, annotations without /AP) use the new
 *   rectangle at the original stroke width and font size.
 * - Non-uniform (stretch) resizes scale leader-line lengths (/LL, /LLE, /LLO) by the
 *   geometric mean of the two factors; /Measure scale ratios of /VP viewports are not
 *   rescaled (their /BBox is moved).
 * - Annotations that lay outside the old CropBox (invisible before) may become visible in
 *   the margins of a larger page; annotations cut off by `scale` or a shrinking `canvas`
 *   stay in the file outside the page box (the caller reports them).
 * - /Thumb (an embedded thumbnail of the old page) is dropped rather than regenerated.
 */
import {
  clip,
  concatTransformationMatrix,
  endPath,
  PDFArray,
  PDFDict,
  type PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  type PDFObject,
  type PDFPage,
  PDFRef,
  PDFStream,
  PDFString,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
} from '@cantoo/pdf-lib';
import { type PageResize, type Rect, resizeTransform } from '@pdf-editor/document-model';

import { MIN_INK_WIDTH } from '../annotations/ink-appearance';
import { decodeInkWidths, encodeInkWidths, INK_WIDTHS_KEY } from '../annotations/ink-outline';

/** x' = a·x + e, y' = d·y + f. */
export interface ResizeMatrix {
  readonly a: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}

const name = (key: string) => PDFName.of(key);
const K = {
  Annots: name('Annots'),
  ArtBox: name('ArtBox'),
  BBox: name('BBox'),
  BleedBox: name('BleedBox'),
  CL: name('CL'),
  Contents: name('Contents'),
  CropBox: name('CropBox'),
  InkList: name('InkList'),
  InkWidths: name(INK_WIDTHS_KEY),
  L: name('L'),
  LL: name('LL'),
  LLE: name('LLE'),
  LLO: name('LLO'),
  MediaBox: name('MediaBox'),
  Path: name('Path'),
  Popup: name('Popup'),
  QuadPoints: name('QuadPoints'),
  RD: name('RD'),
  Rect: name('Rect'),
  Thumb: name('Thumb'),
  TrimBox: name('TrimBox'),
  Vertices: name('Vertices'),
  VP: name('VP'),
};

/** The matrix taking the content box `box` (user space) into the resized page. */
export function pageResizeMatrix(box: Rect, resize: PageResize): ResizeMatrix {
  const t = resizeTransform({ width: box.width, height: box.height }, resize);
  return {
    a: t.scaleX,
    d: t.scaleY,
    e: t.offsetX - t.scaleX * box.x,
    f: t.offsetY - t.scaleY * box.y,
  };
}

export function transformPoint(m: ResizeMatrix, x: number, y: number): [number, number] {
  return [m.a * x + m.e, m.d * y + m.f];
}

export function transformRect(m: ResizeMatrix, r: Rect): Rect {
  const [x1, y1] = transformPoint(m, r.x, r.y);
  const [x2, y2] = transformPoint(m, r.x + r.width, r.y + r.height);
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

/** Numbers of a (possibly indirect) array; undefined when it holds anything else. */
function numbers(doc: PDFDocument, value: PDFObject | undefined): number[] | undefined {
  const array = doc.context.lookupMaybe(value, PDFArray);
  if (!array) return undefined;
  const out: number[] = [];
  for (let i = 0; i < array.size(); i++) {
    const item = doc.context.lookup(array.get(i));
    if (!(item instanceof PDFNumber)) return undefined;
    out.push(item.asNumber());
  }
  return out;
}

/** A normalized rectangle from a box array; undefined when it is not four numbers. */
export function boxRect(doc: PDFDocument, value: PDFObject | undefined): Rect | undefined {
  const n = numbers(doc, value);
  if (n?.length !== 4) return undefined;
  const [x1, y1, x2, y2] = n as [number, number, number, number];
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

function intersect(a: Rect, b: Rect): Rect | undefined {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const top = Math.min(a.y + a.height, b.y + b.height);
  return right > x && top > y ? { x, y, width: right - x, height: top - y } : undefined;
}

function rectArray(doc: PDFDocument, r: Rect): PDFArray {
  return doc.context.obj([r.x, r.y, r.x + r.width, r.y + r.height]);
}

/** Transforms a flat list of x, y pairs; always a fresh direct array (never in place). */
function pointsArray(doc: PDFDocument, m: ResizeMatrix, flat: readonly number[]): PDFArray {
  const out: number[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    out.push(...transformPoint(m, flat[i] as number, flat[i + 1] as number));
  }
  return doc.context.obj(out);
}

/**
 * The visible box of a page as a reader shows it: the CropBox (else the MediaBox),
 * intersected with the MediaBox. This is the content box a resize maps.
 */
export function visibleBox(page: PDFPage): Rect {
  const doc = page.doc;
  const media = boxRect(doc, page.node.MediaBox()) ?? { x: 0, y: 0, width: 612, height: 792 };
  const crop = boxRect(doc, page.node.CropBox());
  return (crop && intersect(crop, media)) ?? media;
}

/**
 * Transforms one annotation's geometry in place (new direct arrays for every value, so
 * indirect or shared arrays are never rewritten). Returns its new /Rect.
 */
function transformAnnotation(doc: PDFDocument, annot: PDFDict, m: ResizeMatrix): Rect | undefined {
  const rect = boxRect(doc, annot.get(K.Rect));
  let moved: Rect | undefined;
  if (rect) {
    moved = transformRect(m, rect);
    annot.set(K.Rect, rectArray(doc, moved));
  }
  for (const key of [K.QuadPoints, K.Vertices, K.L, K.CL]) {
    const flat = numbers(doc, annot.get(key));
    if (flat) annot.set(key, pointsArray(doc, m, flat));
  }
  scaleInkWidths(doc, annot, Math.sqrt(m.a * m.d));
  for (const key of [K.InkList, K.Path]) {
    const lists = doc.context.lookupMaybe(annot.get(key), PDFArray);
    if (!lists) continue;
    const next: PDFArray[] = [];
    for (let i = 0; i < lists.size(); i++) {
      const flat = numbers(doc, lists.get(i));
      if (flat) next.push(pointsArray(doc, m, flat));
    }
    annot.set(key, doc.context.obj(next));
  }
  const rd = numbers(doc, annot.get(K.RD));
  if (rd?.length === 4) {
    const [l, t, r, b] = rd as [number, number, number, number];
    annot.set(K.RD, doc.context.obj([l * m.a, t * m.d, r * m.a, b * m.d]));
  }
  const lengthScale = Math.sqrt(m.a * m.d);
  for (const key of [K.LL, K.LLE, K.LLO]) {
    const value = doc.context.lookup(annot.get(key));
    if (value instanceof PDFNumber) annot.set(key, PDFNumber.of(value.asNumber() * lengthScale));
  }
  return moved;
}

/**
 * Scales the widths in an ink's `/PdfEditorInkWidths` by `factor` (two decimals, at least
 * `MIN_INK_WIDTH`, as the adapter stores them). A value that does not match the /InkList
 * (empty, of another version, edited elsewhere) is left alone: it already reads as "no
 * widths". Called before the /InkList is transformed (only its point counts are read).
 */
function scaleInkWidths(doc: PDFDocument, annot: PDFDict, factor: number): void {
  const raw = doc.context.lookup(annot.get(K.InkWidths));
  if (!(raw instanceof PDFString || raw instanceof PDFHexString)) return;
  const lists = doc.context.lookupMaybe(annot.get(K.InkList), PDFArray);
  if (!lists) return;
  const paths: { x: number; y: number }[][] = [];
  for (let i = 0; i < lists.size(); i++) {
    const flat = numbers(doc, lists.get(i)) ?? [];
    paths.push(Array.from({ length: Math.floor(flat.length / 2) }, () => ({ x: 0, y: 0 })));
  }
  const widths = decodeInkWidths(raw.decodeText(), paths);
  if (!widths) return;
  const scaled = widths.map((ws) =>
    ws.map((w) => Math.max(MIN_INK_WIDTH, Math.round(w * factor * 100) / 100)),
  );
  annot.set(K.InkWidths, PDFString.of(encodeInkWidths(scaled)));
}

export interface PageResizeOutcome {
  /** Annotations whose rectangle was inside the content box but is not inside the page. */
  readonly annotationsOutside: number;
}

/**
 * Applies a resize to `page` (see the module comment). `box` is the content box (the
 * page's visible box before the resize) and `matrix` comes from `pageResizeMatrix` for it.
 * `seen` collects the annotation dictionaries already transformed in this output, so a
 * dictionary reachable twice (a /Popup that is also in /Annots, a malformed shared
 * annotation) moves once.
 */
export function applyPageResize(
  doc: PDFDocument,
  page: PDFPage,
  resize: PageResize,
  box: Rect,
  matrix: ResizeMatrix,
  seen: Set<PDFDict>,
): PageResizeOutcome {
  const { context } = doc;
  const node = page.node;
  const pageBox: Rect = { x: 0, y: 0, width: resize.width, height: resize.height };

  // (b) Content: q cm clip … Q around the existing streams, in a fresh direct array.
  const contents = context.lookup(node.get(K.Contents));
  const items: PDFObject[] = [];
  if (contents instanceof PDFArray) items.push(...contents.asArray());
  else if (contents instanceof PDFStream) items.push(node.get(K.Contents) as PDFObject);
  if (items.length > 0) {
    const start = context.register(
      context.contentStream([
        pushGraphicsState(),
        concatTransformationMatrix(matrix.a, 0, 0, matrix.d, matrix.e, matrix.f),
        rectangle(box.x, box.y, box.width, box.height),
        clip(),
        endPath(),
      ]),
    );
    const end = context.register(context.contentStream([popGraphicsState()]));
    node.set(K.Contents, context.obj([start, ...items, end]));
  }

  // (a) Page boxes.
  for (const key of [K.BleedBox, K.TrimBox, K.ArtBox]) {
    const current = boxRect(doc, node.get(key));
    if (!current) {
      node.delete(key);
      continue;
    }
    const moved = intersect(transformRect(matrix, current), pageBox);
    if (moved) node.set(key, rectArray(doc, moved));
    else node.delete(key);
  }
  node.set(K.MediaBox, rectArray(doc, pageBox));
  node.set(K.CropBox, rectArray(doc, pageBox));
  node.delete(K.Thumb);
  const viewports = context.lookupMaybe(node.get(K.VP), PDFArray);
  if (viewports) {
    const next: PDFObject[] = [];
    for (let i = 0; i < viewports.size(); i++) {
      const viewport = context.lookupMaybe(viewports.get(i), PDFDict);
      if (!viewport) continue;
      const copy = viewport.clone();
      const bbox = boxRect(doc, copy.get(K.BBox));
      if (bbox) copy.set(K.BBox, rectArray(doc, transformRect(matrix, bbox)));
      next.push(copy);
    }
    node.set(K.VP, context.obj(next));
  }

  // (c), (d) Annotations and widgets.
  let annotationsOutside = 0;
  const annots = context.lookupMaybe(node.get(K.Annots), PDFArray);
  const queue: PDFDict[] = [];
  for (let i = 0; i < (annots?.size() ?? 0); i++) {
    const annot = context.lookupMaybe(annots?.get(i), PDFDict);
    if (annot) queue.push(annot);
  }
  // Popups found below are appended while iterating; the array iterator visits them too.
  for (const annot of queue) {
    if (seen.has(annot)) continue;
    seen.add(annot);
    const before = boxRect(doc, annot.get(K.Rect));
    const after = transformAnnotation(doc, annot, matrix);
    if (before && after && inside(before, box) && !inside(after, pageBox)) annotationsOutside++;
    // A popup that is not listed in /Annots still belongs to this page.
    const popup = annot.get(K.Popup);
    const popupDict = popup instanceof PDFRef ? context.lookupMaybe(popup, PDFDict) : undefined;
    if (popupDict) queue.push(popupDict);
  }
  return { annotationsOutside };
}

function inside(inner: Rect, outer: Rect, tolerance = 0.5): boolean {
  return (
    inner.x >= outer.x - tolerance &&
    inner.y >= outer.y - tolerance &&
    inner.x + inner.width <= outer.x + outer.width + tolerance &&
    inner.y + inner.height <= outer.y + outer.height + tolerance
  );
}

/**
 * Transforms the coordinates of an explicit destination array (`[page /XYZ left top
 * zoom]`, `/FitH top`, `/FitV left`, `/FitR l b r t`, `/FitBH top`, `/FitBV left`) in place.
 * Null coordinates ("keep the current value") stay null; zoom is kept.
 */
export function transformDestination(doc: PDFDocument, dest: PDFArray, m: ResizeMatrix): void {
  const kind = doc.context.lookup(dest.get(1));
  if (!(kind instanceof PDFName)) return;
  const at = (i: number): number | undefined => {
    const value = doc.context.lookup(dest.get(i));
    return value instanceof PDFNumber ? value.asNumber() : undefined;
  };
  const setX = (i: number) => {
    const x = at(i);
    if (x !== undefined) dest.set(i, PDFNumber.of(m.a * x + m.e));
  };
  const setY = (i: number) => {
    const y = at(i);
    if (y !== undefined) dest.set(i, PDFNumber.of(m.d * y + m.f));
  };
  switch (kind.decodeText()) {
    case 'XYZ':
      setX(2);
      setY(3);
      break;
    case 'FitH':
    case 'FitBH':
      setY(2);
      break;
    case 'FitV':
    case 'FitBV':
      setX(2);
      break;
    case 'FitR':
      setX(2);
      setY(3);
      setX(4);
      setY(5);
      break;
    default:
      break;
  }
}
