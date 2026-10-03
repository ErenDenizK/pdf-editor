/**
 * Freehand stroke processing (spec §3, §8): Catmull-Rom smoothing of the sampled pointer
 * path, then Douglas–Peucker simplification (0.3 pt) before the stroke is written. Points
 * are in PDF user space (points), so the tolerance is physical, not zoom-dependent.
 *
 * Variable-width strokes (experience-redesign spec §6.6, §9; ADR-0018) go the same way with
 * a width per point: the widths follow the points through each step (kept with their point,
 * interpolated along the smoothed curve), and simplification also keeps a point whose
 * outline edge would move by more than 0.1 pt without it, so the outline is simplified at
 * 0.1 pt while the centre line keeps its 0.3 pt.
 *
 * **One stroke model** (craft spec §5.2 item 2): the live preview and the commit smooth the
 * same way. `InkStrokeModel` dedupes the samples as they arrive (0.5 pt; at least 1.5 CSS px
 * for a mouse) and smooths every segment whose neighbours are known (`smoothPiece`:
 * centripetal Catmull-Rom, 4 steps), so all but the last two kept points are final while the
 * pen moves; the preview draws that, plus the raw tip. The stroke handed over is the kept
 * points, which `finishInkStroke`'s own dedupe keeps as they are, so the commit smooths them
 * into the same curve and adds only Douglas–Peucker and rounding: nothing snaps at release.
 * Centripetal parameterisation depends only on distances, so the curve is the same in CSS
 * pixels and in user space (a similarity apart).
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** A centre-line point with the stroke's full width there (points). */
export interface WidthPoint extends Point {
  readonly w: number;
}

/** Tolerance of the simplification, in points (spec §8). */
export const INK_TOLERANCE_PT = 0.3;
/** Tolerance of the outline edges (half widths) under simplification, points (spec §9). */
export const INK_OUTLINE_TOLERANCE_PT = 0.1;
/** Samples closer than this to the previous kept one are pointer jitter (points). */
export const INK_DEDUPE_PT = 0.5;
/** A mouse's samples are integer pixels: closer than this (CSS px) they are jitter too. */
export const INK_MOUSE_DEDUPE_CSS_PX = 1.5;
/** Catmull-Rom points per segment, in the preview and at commit. */
export const INK_SMOOTH_STEPS = 4;

/** Where the projection of `p` falls on segment a–b, 0 at `a` to 1 at `b`. */
function segmentParameter(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length2 = dx * dx + dy * dy;
  if (length2 === 0) return 0;
  return Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2));
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length2 = dx * dx + dy * dy;
  if (length2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * Douglas–Peucker as a keep mask. With `widths`, a point is also kept when the half width
 * interpolated between the ends of its span misses its own by more than `widthTolerance`.
 */
function simplifyMask(
  points: readonly Point[],
  tolerance: number,
  widths?: readonly number[],
  widthTolerance = INK_OUTLINE_TOLERANCE_PT,
): Uint8Array {
  const keep = new Uint8Array(points.length);
  if (points.length <= 2) return keep.fill(1);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop() as [number, number];
    const a = points[first] as Point;
    const b = points[last] as Point;
    let worst = -1;
    // Errors relative to their tolerances: above 1 the point is needed.
    let worstError = 1;
    for (let i = first + 1; i < last; i++) {
      const p = points[i] as Point;
      let error = distanceToSegment(p, a, b) / tolerance;
      if (widths) {
        const t = segmentParameter(p, a, b);
        const wa = widths[first] ?? 0;
        const wb = widths[last] ?? 0;
        const half = (wa + (wb - wa) * t) / 2;
        error = Math.max(error, Math.abs((widths[i] ?? 0) / 2 - half) / widthTolerance);
      }
      if (error > worstError) {
        worst = i;
        worstError = error;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([first, worst], [worst, last]);
    }
  }
  return keep;
}

/** Douglas–Peucker: keeps the points needed to stay within `tolerance` of the input. */
export function simplify(points: readonly Point[], tolerance = INK_TOLERANCE_PT): Point[] {
  if (points.length <= 2) return [...points];
  const keep = simplifyMask(points, tolerance);
  return points.filter((_, i) => keep[i] === 1);
}

/**
 * Uniform Catmull-Rom spline through `points`, sampled `steps` times per segment.
 * Equivalent to the cubic Bézier chain with control points p1 + (p2 - p0) / 6 and
 * p2 - (p3 - p1) / 6; the curve passes through every input point. Strokes use the
 * centripetal form (`smoothPiece`); this one stays for other callers.
 */
export function catmullRom(points: readonly Point[], steps = 4): Point[] {
  if (points.length < 3 || steps < 2) return [...points];
  const out: Point[] = [points[0] as Point];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)] as Point;
    const p1 = points[i] as Point;
    const p2 = points[i + 1] as Point;
    const p3 = points[Math.min(points.length - 1, i + 2)] as Point;
    // Bézier control points of this segment.
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const u = 1 - t;
      out.push({
        x: u * u * u * p1.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p2.x,
        y: u * u * u * p1.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p2.y,
      });
    }
  }
  return out;
}

/** Knot interval of centripetal Catmull-Rom: the square root of the chord length. */
function knot(a: Point, b: Point): number {
  return Math.sqrt(Math.hypot(b.x - a.x, b.y - a.y));
}

/**
 * The tangent (per unit of the knot parameter) at `b` between `a` and `c`, with knot
 * intervals `dab` and `dbc`; one-sided where a neighbour is missing (or coincides).
 */
function tangentAt(
  a: Point | undefined,
  b: Point,
  c: Point | undefined,
  dab: number,
  dbc: number,
): Point {
  const hasA = a !== undefined && dab > 1e-9;
  const hasC = c !== undefined && dbc > 1e-9;
  if (hasA && hasC) {
    return {
      x: (b.x - a.x) / dab - (c.x - a.x) / (dab + dbc) + (c.x - b.x) / dbc,
      y: (b.y - a.y) / dab - (c.y - a.y) / (dab + dbc) + (c.y - b.y) / dbc,
    };
  }
  if (hasC) return { x: (c.x - b.x) / dbc, y: (c.y - b.y) / dbc };
  if (hasA) return { x: (b.x - a.x) / dab, y: (b.y - a.y) / dab };
  return { x: 0, y: 0 };
}

/**
 * The smoothed centre line of the segments `kept[from]` → … → `kept[to]`: centripetal
 * Catmull-Rom, `steps` points per segment (the segment's start excluded, its end included),
 * widths interpolated linearly along each segment. Segment i depends on `kept[i − 1]` to
 * `kept[i + 2]` (the ends of `kept` stand in for missing neighbours), so it is final once
 * `kept[i + 2]` exists: the live preview smooths all but the last two kept points with it,
 * and `finishInkStroke` the whole stroke. Appends to `out` and returns it.
 */
export function smoothPiece(
  kept: readonly WidthPoint[],
  from: number,
  to: number,
  out: WidthPoint[] = [],
  steps = INK_SMOOTH_STEPS,
): WidthPoint[] {
  for (let i = Math.max(0, from); i < Math.min(to, kept.length - 1); i++) {
    const p0 = kept[i - 1];
    const p1 = kept[i] as WidthPoint;
    const p2 = kept[i + 1] as WidthPoint;
    const p3 = kept[i + 2];
    const d01 = p0 ? knot(p0, p1) : 0;
    const d12 = knot(p1, p2);
    const d23 = p3 ? knot(p2, p3) : 0;
    if (d12 <= 1e-9) {
      // Coincident points (only the forced last point can be): no curve to draw.
      for (let s = 1; s <= steps; s++) {
        out.push({ x: p2.x, y: p2.y, w: p1.w + ((p2.w - p1.w) * s) / steps });
      }
      continue;
    }
    // Hermite tangents scaled to the segment's knot interval, as Bézier control points.
    const m1 = tangentAt(p0, p1, p2, d01, d12);
    const m2 = tangentAt(p1, p2, p3, d12, d23);
    const c1 = { x: p1.x + (m1.x * d12) / 3, y: p1.y + (m1.y * d12) / 3 };
    const c2 = { x: p2.x - (m2.x * d12) / 3, y: p2.y - (m2.y * d12) / 3 };
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const u = 1 - t;
      out.push(
        s === steps
          ? { x: p2.x, y: p2.y, w: p2.w }
          : {
              x: u * u * u * p1.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p2.x,
              y: u * u * u * p1.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p2.y,
              w: p1.w + (p2.w - p1.w) * t,
            },
      );
    }
  }
  return out;
}

/** The whole stroke through `kept`, smoothed (`smoothPiece` from the first point to the last). */
export function smoothStroke(kept: readonly WidthPoint[]): WidthPoint[] {
  const first = kept[0];
  if (!first) return [];
  return smoothPiece(kept, 0, kept.length - 1, [first]);
}

/** Indices of the samples `dedupe` keeps. */
function dedupeIndices(points: readonly Point[], min: number): number[] {
  const out: number[] = [];
  for (const [i, p] of points.entries()) {
    const last = points[out[out.length - 1] ?? -1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) >= min) out.push(i);
  }
  if (out.length > 0 && out[out.length - 1] !== points.length - 1) out.push(points.length - 1);
  return out;
}

/** Drops consecutive samples closer than `min` (pointer jitter at high sample rates). */
export function dedupe(points: readonly Point[], min: number): Point[] {
  return dedupeIndices(points, min).map((i) => points[i] as Point);
}

/**
 * The dedupe distance of a stroke drawn at `scale` CSS px per point, in CSS px: the commit's
 * 0.5 pt (a hair more, so the commit's own dedupe keeps every point kept here despite
 * rounding), and at least 1.5 CSS px for a mouse.
 */
export function inkDedupeDistance(pointerType: string, scale: number): number {
  const commit = INK_DEDUPE_PT * scale * 1.001;
  return pointerType === 'mouse' ? Math.max(commit, INK_MOUSE_DEDUPE_CSS_PX) : commit;
}

/**
 * The stroke model the live preview draws (craft spec §5.2 item 2), fed one sample at a
 * time in any unit (the pen uses CSS px at the stroke's starting zoom):
 *
 * - `kept`: the deduped samples (a sample at least `minDistance` from the previous kept one);
 * - `smooth`: `smoothPiece` through `kept[0]` … `kept[m − 2]`, final (only ever appended);
 * - `tip()`: the raw rest, `kept[m − 1]` and the newest sample when it was not kept;
 * - `handover()`: what the commit gets, the kept points plus the newest sample (the
 *   commit's dedupe always keeps the last point, so it keeps exactly these);
 * - `finish()`: the whole stroke smoothed, as `finishInkStroke` smooths `handover()`.
 */
export class InkStrokeModel {
  readonly kept: WidthPoint[] = [];
  readonly smooth: WidthPoint[] = [];
  private newest: WidthPoint | null = null;

  constructor(readonly minDistance: number) {}

  /** Adds a sample; true when it was kept. */
  add(p: WidthPoint): boolean {
    const kept = this.kept;
    const last = kept[kept.length - 1];
    if (last && Math.hypot(p.x - last.x, p.y - last.y) < this.minDistance) {
      this.newest = p;
      return false;
    }
    this.newest = null;
    kept.push(p);
    const m = kept.length;
    if (m === 1) this.smooth.push(p);
    // The segment kept[m − 3] → kept[m − 2] now has both neighbours.
    else if (m >= 3) smoothPiece(kept, m - 3, m - 2, this.smooth);
    return true;
  }

  /** The raw points after `smooth` (its last point not repeated). */
  tip(): WidthPoint[] {
    const out: WidthPoint[] = [];
    const m = this.kept.length;
    if (m >= 2) out.push(this.kept[m - 1] as WidthPoint);
    if (this.newest) out.push(this.newest);
    return out;
  }

  handover(): WidthPoint[] {
    return this.newest ? [...this.kept, this.newest] : [...this.kept];
  }

  /** The last two segments smoothed with the stroke's end, after `smooth`. */
  finishTail(): WidthPoint[] {
    const all = this.handover();
    const m = this.kept.length;
    if (m < 2 && all.length < 2) return [];
    return smoothPiece(all, Math.max(0, m - 2), all.length - 1);
  }

  /** The whole stroke smoothed: `smooth` plus `finishTail()`. */
  finish(): WidthPoint[] {
    return [...this.smooth, ...this.finishTail()];
  }
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** The stroke as written: de-jittered, smoothed, simplified; rounded to 0.01 pt. */
export function finishStroke(points: readonly Point[]): Point[] {
  return finishInkStroke(points.map((p) => ({ x: p.x, y: p.y, w: 1 }))).points;
}

/** A variable-width stroke as written: the centre line and its widths, point for point. */
export interface FinishedInk {
  readonly points: Point[];
  readonly widths: number[];
}

/**
 * `finishStroke` with a width per point (spec §9): dedupe (0.5 pt), the stroke model's
 * centripetal Catmull-Rom (`smoothStroke`) and Douglas–Peucker (0.3 pt) on the centre line;
 * each width stays with its point, smoothed points take the width interpolated between the
 * two input points they lie between, and simplification keeps the points the outline needs
 * within 0.1 pt. Points and widths are rounded to 0.01 pt (the `/PdfEditorInkWidths`
 * precision); widths stay ≥ 0.01. Given an `InkStrokeModel`'s `handover()` (in points), the
 * dedupe keeps every point and the result is that model's `finish()` simplified.
 */
export function finishInkStroke(points: readonly WidthPoint[]): FinishedInk {
  const kept = dedupeIndices(points, INK_DEDUPE_PT).map((i) => points[i] as WidthPoint);
  const smooth = smoothStroke(kept);
  const widths = smooth.map((p) => p.w);
  const keep = simplifyMask(smooth, INK_TOLERANCE_PT, widths, INK_OUTLINE_TOLERANCE_PT);
  const out: FinishedInk = { points: [], widths: [] };
  smooth.forEach((p, i) => {
    if (keep[i] !== 1) return;
    out.points.push({ x: round2(p.x), y: round2(p.y) });
    out.widths.push(Math.max(0.01, round2(widths[i] ?? 0)));
  });
  return out;
}

/** Shift constraint for lines: the end point snapped to the nearest multiple of 45°. */
export function snapAngle(start: Point, end: Point): Point {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return end;
  const step = Math.PI / 4;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  return { x: start.x + Math.cos(angle) * length, y: start.y + Math.sin(angle) * length };
}

/** Shift constraint for rectangles and ellipses: a square with the larger side. */
export function snapSquare(start: Point, end: Point): Point {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const side = Math.max(Math.abs(dx), Math.abs(dy));
  return { x: start.x + Math.sign(dx || 1) * side, y: start.y + Math.sign(dy || 1) * side };
}

/** Distance from `p` to a polyline. */
export function distanceToPolyline(p: Point, path: readonly Point[]): number {
  if (path.length === 0) return Number.POSITIVE_INFINITY;
  if (path.length === 1) {
    const only = path[0] as Point;
    return Math.hypot(p.x - only.x, p.y - only.y);
  }
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < path.length - 1; i++) {
    best = Math.min(best, distanceToSegment(p, path[i] as Point, path[i + 1] as Point));
  }
  return best;
}

/** Bounding box of point lists, grown by `pad` on every side. */
export function boundsOf(
  paths: readonly (readonly Point[])[],
  pad = 0,
): { x: number; y: number; width: number; height: number } {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const path of paths) {
    for (const p of path) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 };
  return {
    x: minX - pad,
    y: minY - pad,
    width: maxX - minX + 2 * pad,
    height: maxY - minY + 2 * pad,
  };
}
