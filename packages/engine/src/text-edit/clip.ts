/**
 * Clip paths (review M4). A text object's clip cannot be given to a new object through the
 * raw API (`FPDFPage_InsertClipPath` clips the whole page, no call sets an object's clip), so
 * glyphs re-created in new objects are drawn unclipped. The editor keeps as many glyphs as
 * it can in the original object, which keeps its clip, and refuses an edit (`clipped`) when
 * a re-created glyph would reach outside the clip it had.
 *
 * `FPDFPageObj_GetClipPath` reports the clip in the space of the object's container (page
 * space for page objects, form space for objects in a form). Curves are flattened; the test
 * is point-in-polygon (even-odd) on the corners of each glyph box, shrunk by a small margin.
 */
import type { Rect } from '@pdf-editor/document-model';

import type { TextMatrix } from '../types';
import type { Point, RawText } from './raw';

/** A clip: the intersection of its polygons. */
export type ClipRegion = readonly (readonly Point[])[];

/** `FPDF_SEGMENT_*`. */
const SEGMENT_LINETO = 0;
const SEGMENT_BEZIERTO = 1;
const SEGMENT_MOVETO = 2;

/** Points per flattened Bézier segment. */
const BEZIER_STEPS = 12;

/** Margin a glyph box may overlap the clip edge by, points. */
const CLIP_MARGIN = 0.25;

function apply(m: TextMatrix, p: Point): Point {
  return { x: p.x * m[0] + p.y * m[2] + m[4], y: p.x * m[1] + p.y * m[3] + m[5] };
}

/** The object's clip as polygons, mapped by `toPage`; undefined when it has none. */
export function clipOf(raw: RawText, obj: number, toPage?: TextMatrix): ClipRegion | undefined {
  const { m, mem } = raw;
  const clip = m.FPDFPageObj_GetClipPath(obj);
  if (!clip) return undefined;
  const paths = m.FPDFClipPath_CountPaths(clip);
  if (paths <= 0) return undefined;
  const region: Point[][] = [];
  for (let p = 0; p < paths; p++) {
    const count = m.FPDFClipPath_CountPathSegments(clip, p);
    const polygon: Point[] = [];
    const pending: Point[] = [];
    for (let s = 0; s < count; s++) {
      const segment = m.FPDFClipPath_GetPathSegment(clip, p, s);
      if (!segment) continue;
      const point = mem.withMem(8, (ptr) =>
        m.FPDFPathSegment_GetPoint(segment, ptr, ptr + 4)
          ? { x: mem.f32(ptr), y: mem.f32(ptr + 4) }
          : undefined,
      );
      if (!point) continue;
      const type = m.FPDFPathSegment_GetType(segment);
      if (type === SEGMENT_BEZIERTO) {
        pending.push(point);
        if (pending.length === 3) {
          const start = polygon[polygon.length - 1] ?? point;
          const [c1, c2, end] = pending as [Point, Point, Point];
          for (let k = 1; k <= BEZIER_STEPS; k++) {
            const t = k / BEZIER_STEPS;
            const u = 1 - t;
            polygon.push({
              x:
                u * u * u * start.x +
                3 * u * u * t * c1.x +
                3 * u * t * t * c2.x +
                t * t * t * end.x,
              y:
                u * u * u * start.y +
                3 * u * u * t * c1.y +
                3 * u * t * t * c2.y +
                t * t * t * end.y,
            });
          }
          pending.length = 0;
        }
      } else if (type === SEGMENT_LINETO || type === SEGMENT_MOVETO) {
        polygon.push(point);
      }
    }
    if (polygon.length >= 3) region.push(toPage ? polygon.map((q) => apply(toPage, q)) : polygon);
    else region.push([]);
  }
  return region;
}

/** A rectangle `[x0, y0, x1, y1]` in the space `toPage` maps from, as a clip. */
export function rectClip(
  rect: readonly [number, number, number, number],
  toPage: TextMatrix,
): ClipRegion {
  const [x0, y0, x1, y1] = rect;
  return [
    [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
    ].map((p) => apply(toPage, p)),
  ];
}

function inside(polygon: readonly Point[], p: Point): boolean {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i] as Point;
    const b = polygon[j] as Point;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      hit = !hit;
    }
  }
  return hit;
}

/** Whether every clip region contains the box (its corners, shrunk by the margin). */
export function clipsContain(regions: readonly ClipRegion[], box: Rect): boolean {
  const mx = Math.min(CLIP_MARGIN, box.width / 2);
  const my = Math.min(CLIP_MARGIN, box.height / 2);
  const corners: Point[] = [
    { x: box.x + mx, y: box.y + my },
    { x: box.x + box.width - mx, y: box.y + my },
    { x: box.x + mx, y: box.y + box.height - my },
    { x: box.x + box.width - mx, y: box.y + box.height - my },
  ];
  return regions.every((region) =>
    region.every((polygon) => polygon.length >= 3 && corners.every((c) => inside(polygon, c))),
  );
}
