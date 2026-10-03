/**
 * Group resize and rotate of the lasso selection (craft spec §5.5, WP P12).
 *
 * The handles work on the selection's bounding box as the page shows it (CSS pixels): a
 * resize scales about the edge or corner opposite the dragged handle, a rotation turns
 * about the box's centre. That map is carried to unrotated user space through the page
 * frame (`userTransform`), so a page shown turned or stretched behaves as it looks, and then
 * applied to each kind as PDF allows:
 *
 * | Kind | Scale | Rotate |
 * |---|---|---|
 * | Ink | points mapped; widths and the nominal width × √(sx·sy) | points mapped |
 * | Line, arrow, polyline, polygon | vertices mapped (stroke width kept) | vertices mapped |
 * | Rectangle, ellipse | rect scaled | orbits the centre, unrotated |
 * | Free text | rect scaled; font size too under uniform scale only | orbits, unrotated |
 * | Stamp, signature image | keeps its aspect: centre mapped, size × min(sx, sy) | orbits, unrotated |
 * | Note | moves with the group, icon size kept | orbits |
 * | Text markups | quads translated only | quads translated only |
 *
 * PDF gives rectangles, ellipses, free text and notes no rotation of their own, so they keep
 * their orientation and their centre follows the turn. A rotated stamp would need an
 * appearance /Matrix: deferred, so a stamp keeps its orientation too and the bar says so.
 *
 * The split rule of `split.ts` is unchanged: an Ink with only some paths taken gives the
 * taken ones to a new Ink, which carries the transform (`splitLassoInk`).
 */
import type { Rect } from '@pdf-editor/document-model';
import type { Annotation, InkAnnotation } from '@pdf-editor/engine';

import {
  type Box,
  cssPointToUser,
  noteIconRect,
  type PageFrame,
  rectFromPoints,
  roundRect,
  translateAnnotation,
} from '../geometry';
import { boundsOf, type Point } from '../ink';
import { alignedWidths, inkRect, type PathEdit, type SplitOutcome, splitInk } from './split';

/** An affine map: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export interface Affine {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}

export const IDENTITY: Affine = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** A group transform of the lasso selection, in user space (the frame places note icons). */
export interface TransformEdit {
  readonly kind: 'transform';
  readonly matrix: Affine;
  readonly frame?: PageFrame;
}

/** Every edit of a lasso selection: the path edits of `split.ts` and the group transform. */
export type LassoEdit = PathEdit | TransformEdit;

/** The eight resize handles of the bounding box. */
export type BoxHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export const BOX_HANDLES: readonly BoxHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** Smallest box side (CSS px) a resize leaves; boxes never flip. */
export const MIN_BOX_PX = 4;

/** Smallest stored width (points), as the adapter stores ink widths. */
const MIN_WIDTH = 0.01;

const EPS = 1e-6;

const q = (v: number) => Math.round(v * 100) / 100;

export function applyAffine(m: Affine, p: Point): Point {
  return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
}

/** `m` after `n`: the map p ↦ m(n(p)). */
export function multiply(m: Affine, n: Affine): Affine {
  return {
    a: m.a * n.a + m.c * n.b,
    b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d,
    d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e,
    f: m.b * n.e + m.d * n.f + m.f,
  };
}

export function invert(m: Affine): Affine {
  const det = m.a * m.d - m.b * m.c;
  if (Math.abs(det) < 1e-12) return IDENTITY;
  const a = m.d / det;
  const b = -m.b / det;
  const c = -m.c / det;
  const d = m.a / det;
  return { a, b, c, d, e: -(a * m.e + c * m.f), f: -(b * m.e + d * m.f) };
}

/** Scales by (sx, sy) about `origin`. */
export function scaling(origin: Point, sx: number, sy: number): Affine {
  return { a: sx, b: 0, c: 0, d: sy, e: origin.x * (1 - sx), f: origin.y * (1 - sy) };
}

/**
 * Turns by `degrees` about `centre`. In CSS pixels (y down) a positive angle turns
 * clockwise on screen.
 */
export function rotation(centre: Point, degrees: number): Affine {
  const t = (degrees * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  return {
    a: cos,
    b: sin,
    c: -sin,
    d: cos,
    e: centre.x - cos * centre.x + sin * centre.y,
    f: centre.y - sin * centre.x - cos * centre.y,
  };
}

/** The map from the page's CSS pixels to user space (exact: the frame's map is affine). */
export function cssToUser(frame: PageFrame): Affine {
  const o = cssPointToUser(frame, { x: 0, y: 0 });
  const x = cssPointToUser(frame, { x: 1, y: 0 });
  const y = cssPointToUser(frame, { x: 0, y: 1 });
  return { a: x.x - o.x, b: x.y - o.y, c: y.x - o.x, d: y.y - o.y, e: o.x, f: o.y };
}

/** A transform drawn on the page (CSS pixels) as a user-space transform. */
export function userTransform(frame: PageFrame, css: Affine): Affine {
  const toUser = cssToUser(frame);
  return multiply(toUser, multiply(css, invert(toUser)));
}

/** No rotation or skew: x' depends on x only, y' on y only. */
export function axisAligned(m: Affine): boolean {
  return Math.abs(m.b) < EPS && Math.abs(m.c) < EPS;
}

/** The factor lengths scale by on average, √|det| (√(sx·sy) for a scale; 1 for a turn). */
export function lengthScale(m: Affine): number {
  return Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
}

/** An axis-aligned scale by the same factor both ways (within 0.1 %). */
export function uniformScale(m: Affine): boolean {
  if (!axisAligned(m)) return false;
  const sx = Math.abs(m.a);
  const sy = Math.abs(m.d);
  return Math.abs(sx - sy) <= 1e-3 * Math.max(sx, sy);
}

function centre(r: Rect): Point {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/** `r` with its centre at `c`, its size kept. */
function centredAt(r: Rect, c: Point, width = r.width, height = r.height): Rect {
  return roundRect({ x: c.x - width / 2, y: c.y - height / 2, width, height });
}

/** A rect kind's rect: scaled when the map is axis-aligned, else orbiting unrotated. */
function mapRect(r: Rect, m: Affine): Rect {
  if (!axisAligned(m)) return centredAt(r, applyAffine(m, centre(r)));
  const p0 = applyAffine(m, { x: r.x, y: r.y });
  const p1 = applyAffine(m, { x: r.x + r.width, y: r.y + r.height });
  return roundRect(rectFromPoints(p0, p1));
}

/** The geometry of an ink mapped by `m`: points, widths × √(sx·sy) and its rect. */
export function transformInkGeometry(
  ink: InkAnnotation,
  m: Affine,
): Pick<InkAnnotation, 'paths' | 'strokeWidth' | 'rect' | 'widths'> {
  const k = lengthScale(m);
  const paths = ink.paths.map((path) =>
    path.map((p) => {
      const r = applyAffine(m, p);
      return { x: q(r.x), y: q(r.y) };
    }),
  );
  const width = (w: number) => Math.max(MIN_WIDTH, q(w * k));
  const strokeWidth = width(ink.strokeWidth);
  const widths = alignedWidths(ink)?.map((ws) => ws.map(width));
  return {
    paths,
    strokeWidth,
    ...(widths ? { widths } : {}),
    rect: inkRect(paths, strokeWidth, widths),
  };
}

/** An ink mapped by `m` (widths that do not match its paths are dropped). */
export function transformInk(ink: InkAnnotation, m: Affine): InkAnnotation {
  const { widths: _old, ...base } = ink;
  return { ...base, ...transformInkGeometry(ink, m) };
}

/** Moves `a` so that `anchor` lands where `m` takes it. */
function follow(a: Annotation, anchor: Point, m: Affine): Annotation {
  const to = applyAffine(m, anchor);
  return translateAnnotation(a, to.x - anchor.x, to.y - anchor.y);
}

/**
 * The annotation after the group transform `m` (user space), by the table in the module
 * header. `frame` places a note's icon, whose centre the note follows (its /Rect without).
 */
export function transformAnnotation(a: Annotation, m: Affine, frame?: PageFrame): Annotation {
  switch (a.kind) {
    case 'ink':
      return transformInk(a, m);
    case 'line':
    case 'polyline':
    case 'polygon': {
      if (!a.vertices || a.vertices.length === 0) return { ...a, rect: mapRect(a.rect, m) };
      const vertices = a.vertices.map((p) => {
        const r = applyAffine(m, p);
        return { x: q(r.x), y: q(r.y) };
      });
      return { ...a, vertices, rect: roundRect(boundsOf([vertices], a.strokeWidth / 2 + 6)) };
    }
    case 'square':
    case 'circle':
    case 'link':
      return { ...a, rect: mapRect(a.rect, m) };
    case 'free-text': {
      const rect = mapRect(a.rect, m);
      if (!uniformScale(m)) return { ...a, rect };
      const fontSize = Math.max(1, Math.round(a.fontSize * Math.abs(m.a) * 10) / 10);
      return { ...a, rect, fontSize };
    }
    case 'stamp': {
      const c = applyAffine(m, centre(a.rect));
      if (!axisAligned(m)) return { ...a, rect: centredAt(a.rect, c) };
      const s = Math.min(Math.abs(m.a), Math.abs(m.d));
      return { ...a, rect: centredAt(a.rect, c, a.rect.width * s, a.rect.height * s) };
    }
    case 'text':
      return follow(a, centre(frame ? noteIconRect(frame, a.rect) : a.rect), m);
    case 'highlight':
    case 'underline':
    case 'strikeout':
    case 'squiggly':
    case 'redact': {
      const corners = a.quads.flatMap((r) => [
        { x: r.x, y: r.y },
        { x: r.x + r.width, y: r.y + r.height },
      ]);
      const area = corners.length > 0 ? boundsOf([corners]) : a.rect;
      return follow(a, centre(area), m);
    }
  }
}

/**
 * The split rule (`splitInk`) for any lasso edit: a transform splits exactly as a move
 * does, and the taken paths (the whole Ink, or the new one) carry it.
 */
export function splitLassoInk(
  ink: InkAnnotation,
  picked: readonly number[],
  edit: LassoEdit,
  newId: string,
): SplitOutcome {
  if (edit.kind !== 'transform') return splitInk(ink, picked, edit, newId);
  const outcome = splitInk(ink, picked, { kind: 'move', dx: 0, dy: 0 }, newId);
  if (outcome.create) {
    const { widths: _old, ...base } = outcome.create;
    return {
      ...outcome,
      create: { ...base, ...transformInkGeometry(outcome.create, edit.matrix) },
    };
  }
  // Every path taken: the Ink itself carries the transform.
  if (outcome.update && !outcome.remove) {
    return { ...outcome, update: transformInk(outcome.update, edit.matrix) };
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// The handles' arithmetic (CSS pixels of the page)
// ---------------------------------------------------------------------------

/** A scale of the bounding box: factors and the fixed point, CSS pixels. */
export interface BoxScale {
  readonly sx: number;
  readonly sy: number;
  readonly origin: Point;
}

/** The point of `box` where `handle` sits. */
export function handlePoint(box: Box, handle: BoxHandle): Point {
  const x = handle.includes('w')
    ? box.left
    : handle.includes('e')
      ? box.left + box.width
      : box.left + box.width / 2;
  const y = handle.startsWith('n')
    ? box.top
    : handle.startsWith('s')
      ? box.top + box.height
      : box.top + box.height / 2;
  return { x, y };
}

/** The handle across the box from `handle` (its fixed point while it is dragged). */
export function oppositeHandle(handle: BoxHandle): BoxHandle {
  const flip: Record<string, string> = { n: 's', s: 'n', e: 'w', w: 'e' };
  return handle
    .split('')
    .map((ch) => flip[ch] ?? ch)
    .join('') as BoxHandle;
}

/** A box side's factor after it grows by `delta`: never below `MIN_BOX_PX`, never flipped. */
function sideFactor(side: number, delta: number): number {
  if (side < 1) return 1;
  return Math.max(MIN_BOX_PX / side, (side + delta) / side);
}

/**
 * The scale of `box` when `handle` is dragged by (dx, dy) CSS px, about the opposite edge
 * or corner. `keepAspect` (Shift on a corner) scales both ways by the larger factor. A
 * side under 1 px (a straight horizontal stroke) does not scale unless the aspect is kept.
 */
export function handleScale(
  box: Box,
  handle: BoxHandle,
  dx: number,
  dy: number,
  keepAspect: boolean,
): BoxScale {
  const origin = handlePoint(box, oppositeHandle(handle));
  const horizontal = handle.includes('e') ? dx : handle.includes('w') ? -dx : null;
  const vertical = handle.startsWith('s') ? dy : handle.startsWith('n') ? -dy : null;
  let sx = horizontal === null ? 1 : sideFactor(box.width, horizontal);
  let sy = vertical === null ? 1 : sideFactor(box.height, vertical);
  if (keepAspect && horizontal !== null && vertical !== null) {
    const thin = box.width < 1 ? sy : box.height < 1 ? sx : Math.max(sx, sy);
    sx = thin;
    sy = thin;
  }
  return { sx, sy, origin };
}

/** The CSS transform of a box scale. */
export function boxScaleAffine(s: BoxScale): Affine {
  return scaling(s.origin, s.sx, s.sy);
}

/** The angle (degrees, clockwise on screen) of `p` around `c`, CSS pixels. */
export function angleAround(c: Point, p: Point): number {
  return (Math.atan2(p.y - c.y, p.x - c.x) * 180) / Math.PI;
}

/** `degrees` in (-180, 180]. */
export function normalizeDegrees(degrees: number): number {
  const d = ((((degrees + 180) % 360) + 360) % 360) - 180;
  return d === -180 ? 180 : d;
}

/** `degrees` snapped to the nearest multiple of `step`. */
export function snapDegrees(degrees: number, step: number): number {
  return Math.round(degrees / step) * step;
}

/**
 * A keyboard resize of `box` by `step` CSS px: the right and bottom edges move, the left
 * and top stay (Right and Down grow it, Left and Up shrink it).
 */
export function keyScale(box: Box, key: string, step: number): BoxScale | undefined {
  const origin = { x: box.left, y: box.top };
  switch (key) {
    case 'ArrowRight':
      return { sx: sideFactor(box.width, step), sy: 1, origin };
    case 'ArrowLeft':
      return { sx: sideFactor(box.width, -step), sy: 1, origin };
    case 'ArrowDown':
      return { sx: 1, sy: sideFactor(box.height, step), origin };
    case 'ArrowUp':
      return { sx: 1, sy: sideFactor(box.height, -step), origin };
    default:
      return undefined;
  }
}

/** A keyboard rotation: Right and Down turn clockwise, Left and Up counter-clockwise. */
export function keyDegrees(key: string, step: number): number | undefined {
  if (key === 'ArrowRight' || key === 'ArrowDown') return step;
  if (key === 'ArrowLeft' || key === 'ArrowUp') return -step;
  return undefined;
}
