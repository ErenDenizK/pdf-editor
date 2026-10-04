/**
 * The eraser (experience-redesign spec §6.4, craft spec §5.6): Stroke takes whole paths,
 * Partial cuts pen paths where its circle passes.
 *
 * - **The circle.** The eraser is a circle of `eraserSize` CSS px on screen (the cursor shows
 *   it), so `size / 2 / zoom` points in user space. A drag sweeps it along the pointer's
 *   path: the swept area is the union of capsules around each step (`EraserSweep`), so a fast
 *   drag with sparse events leaves no gaps.
 * - **Stroke.** A path the swept area touches (its centre line within the radius plus half
 *   the nominal width, as before the eraser had a size) goes whole.
 * - **Partial.** Each pen path is cut where its outline meets the swept area: a segment's
 *   centre line is erased where it lies within the radius plus half the stroke's local width,
 *   so the round end of what remains just touches the circle. The cut point's width is
 *   interpolated between the segment's two widths (ADR-0018). Pieces shorter than
 *   `MIN_PIECE_PT` are specks and go too.
 * - **The split rule.** The result goes through the lasso's rule (`lasso/split.ts`,
 *   `splitInk` with a delete): the erased spans are the taken paths, the pieces are the rest,
 *   so the Ink keeps its id, its comment and the paths that remain (in order, widths parallel)
 *   and goes when nothing remains.
 * - **Whole objects.** Highlighter free ink (Multiply, constant width) and Highlight
 *   annotations erase whole in both modes: a Multiply path the circle touches goes, and a
 *   Highlight whose quads it touches is deleted.
 * - **History.** Everything one drag erases on a page is one history entry (`commitErase`):
 *   "Erase pen strokes" when a path was cut or removed from a burst, else the delete label.
 */
import type { EngineEdit, Rect } from '@pdf-editor/document-model';
import type { Annotation, InkAnnotation } from '@pdf-editor/engine';

import { m } from '../../i18n';
import { announce } from '../../shell/announcer';
import type { EraserMode } from '../../viewer/tool-store';
import { type PageTarget, useAnnotationStore } from '../annotation-store';
import { type ActionResult, executeEdit, readAnnotations, runAction } from '../edit-runner';
import { cssPointToUser, type PageFrame } from '../geometry';
import type { Point } from '../ink';
import { deleteLabel } from '../labels';
import { alignedWidths, splitInk } from '../lasso/split';

/** Pieces of a cut path shorter than this (points) are erased with it. */
export const MIN_PIECE_PT = 0.5;

/** The swept circle, user space: the pointer's path and the circle's radius. */
export interface EraserSweep {
  readonly points: readonly Point[];
  readonly radius: number;
}

/** The sweep of a drag whose pointer went through `points` (CSS px of the page). */
export function sweepFromCss(
  frame: PageFrame,
  points: readonly Point[],
  diameterPx: number,
): EraserSweep {
  return {
    points: points.map((p) => cssPointToUser(frame, p)),
    radius: diameterPx / 2 / frame.scale,
  };
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

type Interval = readonly [number, number];

const EPS = 1e-9;

/** The t in [0, 1] where A + t·(B − A) lies within `r` of `c` (a disc), or null. */
function discInterval(a: Point, b: Point, c: Point, r: number): Interval | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const fx = a.x - c.x;
  const fy = a.y - c.y;
  const qa = dx * dx + dy * dy;
  const qc = fx * fx + fy * fy - r * r;
  if (qa < EPS) return qc <= 0 ? [0, 1] : null;
  const qb = 2 * (fx * dx + fy * dy);
  const disc = qb * qb - 4 * qa * qc;
  if (disc < 0) return null;
  const root = Math.sqrt(disc);
  return [(-qb - root) / (2 * qa), (-qb + root) / (2 * qa)];
}

/** The t where `v0 + t·dv` lies in [lo, hi]. */
function slab(v0: number, dv: number, lo: number, hi: number): Interval | null {
  if (Math.abs(dv) < EPS) return v0 >= lo && v0 <= hi ? [-Infinity, Infinity] : null;
  const t1 = (lo - v0) / dv;
  const t2 = (hi - v0) / dv;
  return t1 < t2 ? [t1, t2] : [t2, t1];
}

/**
 * The t in [0, 1] where A + t·(B − A) lies within `r` of the segment C–D (a capsule), or
 * null. The capsule is convex, so this is one interval: the hull of the line's intervals in
 * the two end discs and the band between them.
 */
export function capsuleInterval(
  a: Point,
  b: Point,
  c: Point,
  d: Point,
  r: number,
): Interval | null {
  const parts: Interval[] = [];
  const first = discInterval(a, b, c, r);
  if (first) parts.push(first);
  const length = Math.hypot(d.x - c.x, d.y - c.y);
  if (length > EPS) {
    const second = discInterval(a, b, d, r);
    if (second) parts.push(second);
    const ux = (d.x - c.x) / length;
    const uy = (d.y - c.y) / length;
    const ax = a.x - c.x;
    const ay = a.y - c.y;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const along = slab(ax * ux + ay * uy, dx * ux + dy * uy, 0, length);
    const across = slab(-ax * uy + ay * ux, -dx * uy + dy * ux, -r, r);
    if (along && across) {
      const lo = Math.max(along[0], across[0]);
      const hi = Math.min(along[1], across[1]);
      if (lo <= hi) parts.push([lo, hi]);
    }
  }
  if (parts.length === 0) return null;
  const lo = Math.max(0, Math.min(...parts.map((p) => p[0])));
  const hi = Math.min(1, Math.max(...parts.map((p) => p[1])));
  return lo <= hi ? [lo, hi] : null;
}

/** The capsules of a sweep as segments (one press without a move is one disc). */
function sweepSegments(sweep: EraserSweep): (readonly [Point, Point])[] {
  const { points } = sweep;
  const only = points[0];
  if (points.length === 1 && only) return [[only, only]];
  const out: (readonly [Point, Point])[] = [];
  for (let i = 1; i < points.length; i++) {
    const c = points[i - 1];
    const d = points[i];
    if (c && d) out.push([c, d]);
  }
  return out;
}

interface Box {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

function boxOf(points: readonly Point[], pad: number): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

function overlaps(a: Box, b: Box): boolean {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
}

/** Sorted, merged intervals. */
function merge(intervals: Interval[]): Interval[] {
  intervals.sort((p, q) => p[0] - q[0]);
  const out: [number, number][] = [];
  for (const [lo, hi] of intervals) {
    const last = out[out.length - 1];
    if (last && lo <= last[1] + EPS) last[1] = Math.max(last[1], hi);
    else out.push([lo, hi]);
  }
  return out;
}

/** A point of a path with its full width (points). */
export interface WidthPoint {
  readonly x: number;
  readonly y: number;
  readonly w: number;
}

const round = (v: number, places: number) => {
  const f = 10 ** places;
  return Math.round(v * f) / f;
};

function lerp(a: WidthPoint, b: WidthPoint, t: number): WidthPoint {
  return {
    x: round(a.x + (b.x - a.x) * t, 2),
    y: round(a.y + (b.y - a.y) * t, 2),
    w: round(a.w + (b.w - a.w) * t, 3),
  };
}

function arcLength(points: readonly Point[]): number {
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    const p = points[i - 1];
    const q = points[i];
    if (p && q) length += Math.hypot(q.x - p.x, q.y - p.y);
  }
  return length;
}

/**
 * What remains of a path after the sweep: its pieces (each at least two points, widths
 * interpolated at the cuts), or null when the sweep does not reach it. `reach(wa, wb)` is how
 * far from a segment's centre line the circle's centre erases it (the radius plus half the
 * segment's width, or the nominal width in Stroke).
 */
export function erasePath(
  points: readonly WidthPoint[],
  sweep: EraserSweep,
  reach: (wa: number, wb: number) => number,
): WidthPoint[][] | null {
  const segments = sweepSegments(sweep);
  const widest = Math.max(0, ...points.map((p) => p.w));
  const sweepBox = boxOf(sweep.points, reach(widest, widest));
  if (segments.length === 0 || points.length === 0 || !overlaps(boxOf(points, 0), sweepBox)) {
    return null;
  }
  const only = points[0];
  if (points.length === 1 && only) {
    const r = reach(only.w, only.w);
    return segments.some(([c, d]) => capsuleInterval(only, only, c, d, r)) ? [] : null;
  }
  const pieces: WidthPoint[][] = [];
  let current: WidthPoint[] | null = null;
  let erased = false;
  const finish = () => {
    if (current && current.length > 1) pieces.push(current);
    current = null;
  };
  for (let k = 0; k + 1 < points.length; k++) {
    const a = points[k] as WidthPoint;
    const b = points[k + 1] as WidthPoint;
    const r = reach(a.w, b.w);
    const hits: Interval[] = [];
    const segmentBox = boxOf([a, b], r);
    for (const [c, d] of segments) {
      if (!overlaps(segmentBox, boxOf([c, d], 0))) continue;
      const hit = capsuleInterval(a, b, c, d, r);
      // A tangent touch (one point of the segment) erases nothing.
      if (hit && hit[1] - hit[0] > EPS) hits.push(hit);
    }
    // The kept parts of this segment: the complement of the erased intervals in [0, 1].
    const kept: Interval[] = [];
    let from = 0;
    for (const [lo, hi] of merge(hits)) {
      if (lo - from > EPS) kept.push([from, lo]);
      from = Math.max(from, hi);
    }
    if (1 - from > EPS) kept.push([from, 1]);
    if (hits.length > 0) erased = true;
    if (kept.length === 0) {
      finish();
      continue;
    }
    for (const [lo, hi] of kept) {
      // A cut inside the segment starts a new piece; else the piece goes on (or starts at A).
      if (lo > 0) finish();
      const piece: WidthPoint[] = current ?? [lo > 0 ? lerp(a, b, lo) : a];
      current = piece;
      if (hi < 1) {
        piece.push(lerp(a, b, hi));
        finish();
      } else {
        piece.push(b);
      }
    }
  }
  finish();
  if (!erased) return null;
  return pieces.filter((piece) => arcLength(piece) >= MIN_PIECE_PT);
}

// ---------------------------------------------------------------------------
// Annotations
// ---------------------------------------------------------------------------

function erasable(a: Annotation): boolean {
  return !a.flags?.locked && !a.flags?.hidden;
}

function inside(p: Point, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
}

/** Whether the capsule around C–D (radius `radius`) touches the rect. */
function capsuleTouchesRect(c: Point, d: Point, radius: number, r: Rect): boolean {
  if (inside(c, r) || inside(d, r)) return true;
  const corners: Point[] = [
    { x: r.x, y: r.y },
    { x: r.x + r.width, y: r.y },
    { x: r.x + r.width, y: r.y + r.height },
    { x: r.x, y: r.y + r.height },
  ];
  // The segment crosses an edge, or comes within the radius of one.
  for (let i = 0; i < 4; i++) {
    const p = corners[i] as Point;
    const q = corners[(i + 1) % 4] as Point;
    if (capsuleInterval(p, q, c, d, radius)) return true;
  }
  return false;
}

/** Whether the sweep touches a Highlight's quads. */
export function sweepTouchesQuads(quads: readonly Rect[], sweep: EraserSweep): boolean {
  const segments = sweepSegments(sweep);
  return quads.some((q) => segments.some(([c, d]) => capsuleTouchesRect(c, d, sweep.radius, q)));
}

/** The ink's paths with their widths: per-point when parallel, else the nominal width. */
function widthPaths(ink: InkAnnotation): WidthPoint[][] {
  const widths = alignedWidths(ink);
  return ink.paths.map((path, i) =>
    path.map((p, j) => ({ x: p.x, y: p.y, w: widths?.[i]?.[j] ?? ink.strokeWidth })),
  );
}

/** What erasing does to one Ink: unchanged (undefined), removed, or updated (same id). */
export type InkErase =
  | { readonly remove: true; readonly count: number }
  | { readonly remove: false; readonly update: InkAnnotation; readonly count: number };

/**
 * The sweep applied to one Ink by the split rule (module header). Stroke, and any Multiply
 * ink, takes whole paths; Partial replaces each touched path by its pieces.
 */
export function eraseInk(
  ink: InkAnnotation,
  sweep: EraserSweep,
  mode: EraserMode,
): InkErase | undefined {
  const whole = mode === 'stroke' || ink.blendMode === 'multiply';
  const reach = whole
    ? () => sweep.radius + ink.strokeWidth / 2
    : (wa: number, wb: number) => sweep.radius + (wa + wb) / 4;
  const aligned = alignedWidths(ink) !== undefined;
  // The Ink as the split rule sees it: the pieces left of each touched path (the rest),
  // then the touched path itself (taken, to be deleted).
  const paths: (readonly Point[])[] = [];
  const widths: (readonly number[])[] = [];
  const taken: number[] = [];
  widthPaths(ink).forEach((path, i) => {
    const original = ink.paths[i] ?? [];
    const pieces = erasePath(path, sweep, reach);
    const add = (points: readonly Point[], w: readonly number[]) => {
      paths.push(points);
      widths.push(w);
    };
    if (pieces === null) {
      add(
        original,
        path.map((p) => p.w),
      );
      return;
    }
    if (!whole) {
      for (const piece of pieces) {
        add(
          piece.map((p) => ({ x: p.x, y: p.y })),
          piece.map((p) => p.w),
        );
      }
    }
    taken.push(paths.length);
    add(
      original,
      path.map((p) => p.w),
    );
  });
  if (taken.length === 0) return undefined;
  const { widths: _old, ...base } = ink;
  const expanded: InkAnnotation = { ...base, paths, ...(aligned ? { widths } : {}) };
  const outcome = splitInk(expanded, taken, { kind: 'delete' }, '');
  if (outcome.remove || !outcome.update) return { remove: true, count: taken.length };
  return { remove: false, update: outcome.update, count: taken.length };
}

/** What one erase drag does on a page. */
export interface ErasePlan {
  /** Inks that keep their id with fewer or shorter paths. */
  readonly updates: readonly InkAnnotation[];
  /** Annotations that go whole: inks with nothing left, Highlights. */
  readonly removals: readonly Annotation[];
}

/** The plan of an erase drag over `annotations` (user space sweep). */
export function erasePlan(
  annotations: readonly Annotation[],
  sweep: EraserSweep,
  mode: EraserMode,
): ErasePlan {
  const updates: InkAnnotation[] = [];
  const removals: Annotation[] = [];
  if (sweep.points.length === 0) return { updates, removals };
  for (const a of annotations) {
    if (!erasable(a)) continue;
    if (a.kind === 'ink') {
      const outcome = eraseInk(a, sweep, mode);
      if (!outcome) continue;
      if (outcome.remove) removals.push(a);
      else updates.push(outcome.update);
    } else if (a.kind === 'highlight' && sweepTouchesQuads(a.quads, sweep)) {
      removals.push(a);
    }
  }
  return { updates, removals };
}

/**
 * Live feedback while dragging: the annotations (and ink path indices) under the eraser at
 * `p` (CSS px), added to `hits`. Only used to hide hit targets; the commit plans from the
 * whole sweep.
 */
export function eraseHits(
  hits: ReadonlyMap<string, ReadonlySet<number>>,
  annotations: readonly Annotation[],
  frame: PageFrame,
  p: Point,
  diameterPx: number,
): ReadonlyMap<string, ReadonlySet<number>> {
  const sweep = sweepFromCss(frame, [p], diameterPx);
  let next: Map<string, Set<number>> | undefined;
  const add = (id: string, index: number) => {
    next ??= new Map([...hits].map(([k, v]) => [k, new Set(v)]));
    const set = next.get(id) ?? new Set<number>();
    set.add(index);
    next.set(id, set);
  };
  for (const a of annotations) {
    if (!erasable(a)) continue;
    if (a.kind === 'highlight') {
      if (!hits.has(a.id) && sweepTouchesQuads(a.quads, sweep)) add(a.id, 0);
      continue;
    }
    if (a.kind !== 'ink') continue;
    const reach = () => sweep.radius + a.strokeWidth / 2;
    a.paths.forEach((path, i) => {
      if (hits.get(a.id)?.has(i)) return;
      const points = path.map((q) => ({ x: q.x, y: q.y, w: a.strokeWidth }));
      if (erasePath(points, sweep, reach) !== null) add(a.id, i);
    });
  }
  return next ?? hits;
}

// ---------------------------------------------------------------------------
// The commit
// ---------------------------------------------------------------------------

async function serializeAnnotation(a: Annotation) {
  const engine = await import('@pdf-editor/engine');
  return engine.serializeAnnotation(a);
}

function edit(kind: EngineEdit['kind'], target: PageTarget, payload: unknown): EngineEdit {
  return {
    id: globalThis.crypto.randomUUID(),
    source: target.source,
    pageIndex: target.pageIndex,
    kind,
    payload,
  };
}

/**
 * Erases what one drag swept on a page as one history entry, planned from the engine's
 * current annotations when the queued action runs. Resolves to the number of annotations
 * changed or removed, or undefined when nothing was under the eraser.
 */
export function commitErase(
  target: PageTarget,
  sweep: EraserSweep,
  mode: EraserMode,
): Promise<number | undefined> {
  return runAction(async (ctx): Promise<ActionResult<number> | undefined> => {
    const list = await readAnnotations(target.source, target.pageIndex, ctx);
    const { updates, removals } = erasePlan(list, sweep, mode);
    const edits: EngineEdit[] = [];
    for (const a of removals) {
      const done = await executeEdit(
        ctx,
        edit('annotation.delete', target, { annotationId: a.id }),
      );
      edits.push(done.recorded);
    }
    const author = useAnnotationStore.getState().author.trim();
    for (const ink of updates) {
      const stamped: InkAnnotation = {
        ...ink,
        modified: new Date().toISOString(),
        ...(ink.author === undefined && author !== '' ? { author } : {}),
      };
      const annotation = await serializeAnnotation(stamped);
      const done = await executeEdit(ctx, edit('annotation.update', target, { annotation }));
      edits.push(done.recorded);
    }
    if (edits.length === 0) return undefined;
    const label = updates.length > 0 ? m.history_annot_erase() : deleteLabel(removals);
    if (removals.length > 0) {
      announce(label);
      const store = useAnnotationStore.getState();
      const ids = new Set(removals.map((a) => a.id));
      if (
        store.selection?.source === target.source &&
        store.selection.ids.some((id) => ids.has(id))
      )
        store.select(null);
    }
    return { edits, label, value: updates.length + removals.length };
  });
}

// ---------------------------------------------------------------------------
// The cursor
// ---------------------------------------------------------------------------

/**
 * The eraser's cursor: a hollow circle of its diameter (CSS px) with a dark and a light ring,
 * so it shows on any page, and a centred hot spot.
 */
export function eraserCursor(diameter: number): string {
  const d = Math.max(4, diameter);
  const size = Math.ceil(d) + 4;
  const c = size / 2;
  const r = d / 2;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
    `viewBox="0 0 ${size} ${size}">` +
    `<circle cx="${c}" cy="${c}" r="${r}" fill="rgba(255,255,255,0.35)" ` +
    'stroke="rgba(0,0,0,0.75)" stroke-width="1"/>' +
    `<circle cx="${c}" cy="${c}" r="${r + 1}" fill="none" stroke="rgba(255,255,255,0.9)" ` +
    'stroke-width="1"/>' +
    '</svg>';
  const hot = Math.floor(c);
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${hot} ${hot}, cell`;
}
