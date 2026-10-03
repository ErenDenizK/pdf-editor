/**
 * Lasso geometry (craft spec §5.5, after experience-redesign spec §6.5): what a freehand
 * lasso takes.
 *
 * **Match rule.** The lasso is the closed polygon of the dragged points (the last point joins
 * the first). A path is taken when it touches the region: at least one of its points lies
 * inside the polygon (even–odd rule, so a lasso that crosses itself leaves its doubly
 * enclosed loops out), or at least one of its segments crosses an edge of the polygon. A
 * stroke the lasso line merely passes through is therefore taken, as is a stroke wholly
 * inside. Every kind is reduced to such paths (`hitOutlines`):
 *
 * - **Ink**: each path on its own; the lasso takes paths, not the annotation (`paths`).
 * - **Line, arrow, polyline**: the vertices as one open path; **polygon**: closed.
 * - **Rectangle**: its four edges; **ellipse**: 32 points sampled on it (both on the
 *   border's centre line, the rect inset by half the stroke).
 * - **Free text, stamp, signature image**: the rect's corners and edges, so a corner inside
 *   or an edge crossing takes it.
 * - **Note**: its icon rect, where the renderer draws it (`displayRect`, NoRotate notes).
 * - **Text markups** (highlight, underline, strikeout, squiggly): each quad, and any quad
 *   touched takes it: a corner inside, an edge crossing, or the lasso drawn inside the quad.
 *
 * Links, redaction marks and form widgets are never taken; locked and hidden annotations are
 * skipped (they cannot be edited). Everything but ink is taken whole (`whole`). All of it
 * runs in page user space, so zoom and page rotation do not change the result.
 */
import type { Rect } from '@pdf-editor/document-model';
import type { Annotation } from '@pdf-editor/engine';

import { type Box, displayRect, type PageFrame, userToCss } from '../geometry';
import { boundsOf, type Point } from '../ink';

/** Path indices per Ink annotation id, ascending. */
export type PathPicks = Readonly<Record<string, readonly number[]>>;

/** What a lasso took: ink paths, and other annotations whole (ids in page order). */
export interface LassoPicks {
  readonly paths: PathPicks;
  readonly whole: readonly string[];
}

/** Points sampled on an ellipse for its hit test and highlight. */
export const ELLIPSE_SAMPLES = 32;

/** True when `p` lies inside `polygon` (even–odd rule; the edge counts as either side). */
export function pointInPolygon(p: Point, polygon: readonly Point[]): boolean {
  let inside = false;
  const n = polygon.length;
  if (n < 3) return false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = polygon[i] as Point;
    const b = polygon[j] as Point;
    if (a.y > p.y !== b.y > p.y) {
      const x = a.x + ((p.y - a.y) * (b.x - a.x)) / (b.y - a.y);
      if (p.x < x) inside = !inside;
    }
  }
  return inside;
}

/** Twice the signed area of the triangle a, b, c (positive when counter-clockwise). */
function cross(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

/** True when `p`, known to be collinear with a–b, lies within the segment's box. */
function within(a: Point, b: Point, p: Point): boolean {
  return (
    Math.min(a.x, b.x) <= p.x &&
    p.x <= Math.max(a.x, b.x) &&
    Math.min(a.y, b.y) <= p.y &&
    p.y <= Math.max(a.y, b.y)
  );
}

/**
 * True when segments a–b and c–d share at least one point: a proper crossing, an end
 * touching the other segment, or collinear overlap.
 */
export function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  if (d1 === 0 && within(c, d, a)) return true;
  if (d2 === 0 && within(c, d, b)) return true;
  if (d3 === 0 && within(a, b, c)) return true;
  if (d4 === 0 && within(a, b, d)) return true;
  return false;
}

function overlaps(a: Rect, b: Rect): boolean {
  return (
    a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height
  );
}

/** The match rule for one path (see the module header). */
export function pathTouchesPolygon(
  path: readonly Point[],
  polygon: readonly Point[],
  polygonBounds: Rect = boundsOf([polygon]),
): boolean {
  if (polygon.length < 3 || path.length === 0) return false;
  if (!overlaps(boundsOf([path]), polygonBounds)) return false;
  for (const p of path) if (pointInPolygon(p, polygon)) return true;
  const n = polygon.length;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1] as Point;
    const b = path[i] as Point;
    const box = boundsOf([[a, b]]);
    if (!overlaps(box, polygonBounds)) continue;
    for (let k = 0, j = n - 1; k < n; j = k++) {
      const c = polygon[j] as Point;
      const d = polygon[k] as Point;
      if (segmentsIntersect(a, b, c, d)) return true;
    }
  }
  return false;
}

/** The rect's corners as a closed path (counter-clockwise from the lower left). */
export function rectOutline(r: Rect): Point[] {
  const x1 = r.x + r.width;
  const y1 = r.y + r.height;
  return [
    { x: r.x, y: r.y },
    { x: x1, y: r.y },
    { x: x1, y: y1 },
    { x: r.x, y: y1 },
    { x: r.x, y: r.y },
  ];
}

/** `n` points on the ellipse inscribed in `r`, closed (the first point repeats). */
export function ellipseOutline(r: Rect, n: number = ELLIPSE_SAMPLES): Point[] {
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  const out: Point[] = [];
  for (let i = 0; i <= n; i++) {
    const t = ((i % n) / n) * 2 * Math.PI;
    out.push({ x: cx + (r.width / 2) * Math.cos(t), y: cy + (r.height / 2) * Math.sin(t) });
  }
  return out;
}

/** `r` shrunk by `by` on every side, never below a point. */
function inset(r: Rect, by: number): Rect {
  const dx = Math.min(by, r.width / 2);
  const dy = Math.min(by, r.height / 2);
  return { x: r.x + dx, y: r.y + dy, width: r.width - 2 * dx, height: r.height - 2 * dy };
}

/** Whether the lasso can take `a` at all (never links, redaction marks; never locked or hidden). */
export function lassoable(a: Annotation): boolean {
  return a.kind !== 'link' && a.kind !== 'redact' && !a.flags?.locked && !a.flags?.hidden;
}

/** True for kinds hit as areas as well as outlines (text markup quads). */
function hitAsArea(a: Annotation): boolean {
  return (
    a.kind === 'highlight' ||
    a.kind === 'underline' ||
    a.kind === 'strikeout' ||
    a.kind === 'squiggly'
  );
}

/**
 * The paths (user space) a whole annotation is hit by, and its highlight traces (module
 * header); empty for ink (taken by path) and for kinds the lasso never takes. `frame` places
 * a note's icon (`displayRect`); without it the note's /Rect is used.
 */
export function hitOutlines(a: Annotation, frame?: PageFrame): Point[][] {
  switch (a.kind) {
    case 'line':
    case 'polyline':
      return a.vertices && a.vertices.length > 0
        ? [a.vertices.map((p) => ({ x: p.x, y: p.y }))]
        : [rectOutline(a.rect)];
    case 'polygon': {
      const v = a.vertices;
      if (!v || v.length === 0) return [rectOutline(a.rect)];
      const first = v[0] as Point;
      return [[...v.map((p) => ({ x: p.x, y: p.y })), { x: first.x, y: first.y }]];
    }
    case 'square':
      return [rectOutline(inset(a.rect, a.strokeWidth / 2))];
    case 'circle':
      return [ellipseOutline(inset(a.rect, a.strokeWidth / 2))];
    case 'free-text':
    case 'stamp':
      return [rectOutline(a.rect)];
    case 'text':
      return [rectOutline(frame ? displayRect(frame, a) : a.rect)];
    case 'highlight':
    case 'underline':
    case 'strikeout':
    case 'squiggly':
      return a.quads.map(rectOutline);
    default:
      return [];
  }
}

/** The match rule for a whole annotation (module header); false for ink and excluded kinds. */
export function annotationTouchesPolygon(
  a: Annotation,
  polygon: readonly Point[],
  frame?: PageFrame,
  polygonBounds: Rect = boundsOf([polygon]),
): boolean {
  if (polygon.length < 3 || a.kind === 'ink' || !lassoable(a)) return false;
  const area = hitAsArea(a);
  const first = polygon[0] as Point;
  return hitOutlines(a, frame).some(
    (outline) =>
      pathTouchesPolygon(outline, polygon, polygonBounds) ||
      // A lasso drawn inside a quad touches it too.
      (area && outline.length > 2 && pointInPolygon(first, outline)),
  );
}

/**
 * What a lasso takes on one page (user space): for every visible, unlocked Ink with at least
 * one matching path, its matching path indices; every other annotation it touches, whole
 * (module header). `frame` places note icons.
 */
export function lassoPicks(
  annotations: readonly Annotation[],
  polygon: readonly Point[],
  frame?: PageFrame,
): LassoPicks {
  const paths: Record<string, number[]> = {};
  const whole: string[] = [];
  if (polygon.length < 3) return { paths, whole };
  const bounds = boundsOf([polygon]);
  for (const a of annotations) {
    if (!lassoable(a)) continue;
    if (a.kind === 'ink') {
      const taken: number[] = [];
      a.paths.forEach((path, i) => {
        if (pathTouchesPolygon(path, polygon, bounds)) taken.push(i);
      });
      if (taken.length > 0) paths[a.id] = taken;
    } else if (annotationTouchesPolygon(a, polygon, frame, bounds)) {
      whole.push(a.id);
    }
  }
  return { paths, whole };
}

/**
 * The lasso picks of a selection: `paths` for its ink, and every other selected annotation
 * whole (the selection holds exactly the lasso's ids, `activePathSelection`).
 */
export function picksOfSelection(selected: readonly Annotation[], paths: PathPicks): LassoPicks {
  return { paths, whole: selected.filter((a) => paths[a.id] === undefined).map((a) => a.id) };
}

/** How many items the lasso took: paths plus whole annotations. */
export function lassoCount(picks: LassoPicks): number {
  return pickCount(picks.paths) + picks.whole.length;
}

/** The whole annotations of `picks` among `annotations`, in page order. */
export function pickedWhole(
  annotations: readonly Annotation[],
  whole: readonly string[],
): Annotation[] {
  const ids = new Set(whole);
  return annotations.filter((a) => ids.has(a.id));
}

/** How many paths `picks` holds. */
export function pickCount(picks: PathPicks): number {
  let count = 0;
  for (const indices of Object.values(picks)) count += indices.length;
  return count;
}

/** The picked paths of `annotations`, in user space (for highlights and bounds). */
export function pickedPaths(
  annotations: readonly Annotation[],
  picks: PathPicks,
): { readonly annotation: Annotation; readonly index: number; readonly path: readonly Point[] }[] {
  const out: {
    readonly annotation: Annotation;
    readonly index: number;
    readonly path: readonly Point[];
  }[] = [];
  for (const a of annotations) {
    if (a.kind !== 'ink') continue;
    for (const index of picks[a.id] ?? []) {
      const path = a.paths[index];
      if (path) out.push({ annotation: a, index, path });
    }
  }
  return out;
}

/** A path moved by (dx, dy). */
export function translatePath(path: readonly Point[], dx: number, dy: number): Point[] {
  return path.map((p) => ({ x: p.x + dx, y: p.y + dy }));
}

/** Drops points closer than `min` to the previous kept one (a lasso trail, CSS px). */
export function thinTrail(points: readonly Point[], min: number): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) >= min) out.push(p);
  }
  return out;
}

/**
 * The box (CSS px of the displayed page) around the picked paths and whole annotations,
 * grown by half their widest stroke; null when none of them is loaded.
 */
export function pickedCssBounds(
  frame: PageFrame,
  annotations: readonly Annotation[],
  picks: PathPicks,
  whole: readonly string[] = [],
): Box | null {
  let pad = 0;
  const css: Point[][] = [];
  for (const { annotation, path } of pickedPaths(annotations, picks)) {
    css.push(path.map((p) => userToCss(frame, p)));
    if (annotation.kind === 'ink') pad = Math.max(pad, (annotation.strokeWidth * frame.scale) / 2);
  }
  for (const a of pickedWhole(annotations, whole)) {
    for (const outline of hitOutlines(a, frame)) css.push(outline.map((p) => userToCss(frame, p)));
    if (a.kind === 'line' || a.kind === 'polyline' || a.kind === 'polygon') {
      pad = Math.max(pad, (a.strokeWidth * frame.scale) / 2);
    }
  }
  if (css.length === 0) return null;
  const r = boundsOf(css, pad);
  return { left: r.x, top: r.y, width: r.width, height: r.height };
}
