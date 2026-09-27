/**
 * Freehand stroke processing (spec §3, §8): Catmull-Rom smoothing of the sampled pointer
 * path, then Douglas–Peucker simplification (0.3 pt) before the stroke is written. Points
 * are in PDF user space (points), so the tolerance is physical, not zoom-dependent.
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Tolerance of the simplification, in points (spec §8). */
export const INK_TOLERANCE_PT = 0.3;

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length2 = dx * dx + dy * dy;
  if (length2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Douglas–Peucker: keeps the points needed to stay within `tolerance` of the input. */
export function simplify(points: readonly Point[], tolerance = INK_TOLERANCE_PT): Point[] {
  if (points.length <= 2) return [...points];
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop() as [number, number];
    const a = points[first] as Point;
    const b = points[last] as Point;
    let worst = -1;
    let worstDistance = tolerance;
    for (let i = first + 1; i < last; i++) {
      const d = distanceToSegment(points[i] as Point, a, b);
      if (d > worstDistance) {
        worst = i;
        worstDistance = d;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([first, worst], [worst, last]);
    }
  }
  return points.filter((_, i) => keep[i] === 1);
}

/**
 * Centripetal-free (uniform) Catmull-Rom spline through `points`, sampled `steps` times per
 * segment. Equivalent to the cubic Bézier chain with control points p1 + (p2 - p0) / 6 and
 * p2 - (p3 - p1) / 6; the curve passes through every input point.
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

/** Drops consecutive samples closer than `min` (pointer jitter at high sample rates). */
export function dedupe(points: readonly Point[], min: number): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) >= min) out.push(p);
  }
  const final = points[points.length - 1];
  if (final && out[out.length - 1] !== final && out.length > 0) out.push(final);
  return out;
}

/** The stroke as written: de-jittered, smoothed, simplified; rounded to 0.01 pt. */
export function finishStroke(points: readonly Point[]): Point[] {
  const smooth = simplify(catmullRom(dedupe(points, 0.5)), INK_TOLERANCE_PT);
  return smooth.map((p) => ({ x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 }));
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
