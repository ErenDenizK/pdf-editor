/**
 * Lasso geometry (experience-redesign spec §6.5): which pen paths a freehand lasso takes.
 *
 * **Match rule.** The lasso is the closed polygon of the dragged points (the last point joins
 * the first). A path of an Ink annotation is taken when it touches the region: at least one
 * of its points lies inside the polygon (even–odd rule, so a lasso that crosses itself
 * leaves its doubly enclosed loops out), or at least one of its segments crosses an edge of
 * the polygon. A stroke the lasso line merely passes through is therefore taken, as is a
 * stroke wholly inside. Locked and hidden inks are never taken (they cannot be edited), and
 * other annotation kinds are left to the Select tool. All of it runs in page user space, so
 * zoom and page rotation do not change the result.
 */
import type { Rect } from '@pdf-editor/document-model';
import type { Annotation } from '@pdf-editor/engine';

import { type Box, type PageFrame, userToCss } from '../geometry';
import { boundsOf, type Point } from '../ink';

/** Path indices per Ink annotation id, ascending. */
export type PathPicks = Readonly<Record<string, readonly number[]>>;

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

/**
 * The paths a lasso takes on one page (user space): for every visible, unlocked Ink with at
 * least one matching path, its matching path indices. Other kinds are not taken.
 */
export function lassoPicks(
  annotations: readonly Annotation[],
  polygon: readonly Point[],
): PathPicks {
  const picks: Record<string, number[]> = {};
  if (polygon.length < 3) return picks;
  const bounds = boundsOf([polygon]);
  for (const a of annotations) {
    if (a.kind !== 'ink' || a.flags?.locked || a.flags?.hidden) continue;
    const taken: number[] = [];
    a.paths.forEach((path, i) => {
      if (pathTouchesPolygon(path, polygon, bounds)) taken.push(i);
    });
    if (taken.length > 0) picks[a.id] = taken;
  }
  return picks;
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
 * The box (CSS px of the displayed page) around the picked paths, grown by half their widest
 * stroke; null when none of them is loaded.
 */
export function pickedCssBounds(
  frame: PageFrame,
  annotations: readonly Annotation[],
  picks: PathPicks,
): Box | null {
  let pad = 0;
  const css: Point[][] = [];
  for (const { annotation, path } of pickedPaths(annotations, picks)) {
    css.push(path.map((p) => userToCss(frame, p)));
    if (annotation.kind === 'ink') pad = Math.max(pad, (annotation.strokeWidth * frame.scale) / 2);
  }
  if (css.length === 0) return null;
  const r = boundsOf(css, pad);
  return { left: r.x, top: r.y, width: r.width, height: r.height };
}
