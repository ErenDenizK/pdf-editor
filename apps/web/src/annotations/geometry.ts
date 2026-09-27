/**
 * Annotation geometry on top of the viewer's page frame (viewer/geometry.ts is the one
 * place where rotation and the CropBox origin are applied). Annotations are written in
 * absolute, unrotated PDF user space and displayed rotated (spec §3); pointer positions
 * arrive in CSS pixels of the displayed page.
 */
import type { Rect } from '@pdf-editor/document-model';
import type { Annotation } from '@pdf-editor/engine';

import {
  type Box,
  displayRectToUser,
  type PageFrame,
  userPointToCss,
  userRectToCss,
} from '../viewer/geometry';
import { boundsOf, type Point } from './ink';

export type { Box, PageFrame };

/** A CSS-pixel point on the displayed page → user space. */
export function cssPointToUser(frame: PageFrame, p: Point): Point {
  const r = displayRectToUser(frame, {
    left: p.x / frame.scale,
    top: p.y / frame.scale,
    width: 0,
    height: 0,
  });
  return { x: r.x, y: r.y };
}

/** A CSS-pixel box on the displayed page → a user-space rect. */
export function cssBoxToUser(frame: PageFrame, box: Box): Rect {
  const s = frame.scale;
  return displayRectToUser(frame, {
    left: box.left / s,
    top: box.top / s,
    width: box.width / s,
    height: box.height / s,
  });
}

export function userToCss(frame: PageFrame, p: Point): Point {
  return userPointToCss(frame, p);
}

export function rectToCss(frame: PageFrame, r: Rect): Box {
  return userRectToCss(frame, r);
}

/** Box spanned by two CSS points (any order). */
export function boxFromPoints(a: Point, b: Point): Box {
  return {
    left: Math.min(a.x, b.x),
    top: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

/** Rect spanned by two user points (any order). */
export function rectFromPoints(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

export function roundRect(r: Rect): Rect {
  const q = (v: number) => Math.round(v * 100) / 100;
  return { x: q(r.x), y: q(r.y), width: q(r.width), height: q(r.height) };
}

export function inflate(r: Rect, by: number): Rect {
  return { x: r.x - by, y: r.y - by, width: r.width + 2 * by, height: r.height + 2 * by };
}

/** Whether an annotation's geometry can be moved / resized with handles (spec §3). */
export function canMove(a: Annotation): boolean {
  return a.kind !== 'link' && !isTextMarkup(a);
}

export function canResize(a: Annotation): boolean {
  return (
    a.kind === 'square' ||
    a.kind === 'circle' ||
    a.kind === 'free-text' ||
    a.kind === 'stamp' ||
    a.kind === 'ink'
  );
}

export function isTextMarkup(a: Pick<Annotation, 'kind'>): boolean {
  return (
    a.kind === 'highlight' ||
    a.kind === 'underline' ||
    a.kind === 'strikeout' ||
    a.kind === 'squiggly' ||
    a.kind === 'redact'
  );
}

/** The rect an annotation occupies, derived from its geometry when it has one. */
export function geometryRect(a: Annotation): Rect {
  switch (a.kind) {
    case 'ink':
      return a.paths.length > 0 ? boundsOf(a.paths, a.strokeWidth / 2 + 1) : a.rect;
    case 'line':
    case 'polygon':
    case 'polyline':
      return a.vertices && a.vertices.length > 0
        ? boundsOf([a.vertices], a.strokeWidth / 2 + (a.kind === 'line' ? 6 : 1))
        : a.rect;
    default:
      return a.rect;
  }
}

/** The annotation with its geometry mapped by an affine user-space map `f`. */
function mapGeometry(a: Annotation, f: (p: Point) => Point, rect: Rect): Annotation {
  switch (a.kind) {
    case 'ink':
      return {
        ...a,
        paths: a.paths.map((path) => path.map(f)),
        rect: roundRect(rect),
      };
    case 'line':
    case 'polygon':
    case 'polyline':
      return {
        ...a,
        rect: roundRect(rect),
        ...(a.vertices ? { vertices: a.vertices.map(f) } : {}),
      };
    case 'highlight':
    case 'underline':
    case 'strikeout':
    case 'squiggly':
    case 'redact':
      return {
        ...a,
        rect: roundRect(rect),
        quads: a.quads.map((q) => {
          const p = f({ x: q.x, y: q.y });
          const r = f({ x: q.x + q.width, y: q.y + q.height });
          return rectFromPoints(p, r);
        }),
      };
    default:
      return { ...a, rect: roundRect(rect) };
  }
}

/** Moves an annotation by a user-space delta. */
export function translateAnnotation(a: Annotation, dx: number, dy: number): Annotation {
  const r = a.rect;
  const q = (v: number) => Math.round(v * 100) / 100;
  return mapGeometry(a, (p) => ({ x: q(p.x + dx), y: q(p.y + dy) }), {
    x: r.x + dx,
    y: r.y + dy,
    width: r.width,
    height: r.height,
  });
}

/** Scales an annotation so that its rect `from` becomes `to` (both user space). */
export function resizeAnnotation(a: Annotation, from: Rect, to: Rect): Annotation {
  const sx = from.width > 0 ? to.width / from.width : 1;
  const sy = from.height > 0 ? to.height / from.height : 1;
  const q = (v: number) => Math.round(v * 100) / 100;
  const f = (p: Point) => ({ x: q(to.x + (p.x - from.x) * sx), y: q(to.y + (p.y - from.y) * sy) });
  const r = a.rect;
  const p0 = f({ x: r.x, y: r.y });
  const p1 = f({ x: r.x + r.width, y: r.y + r.height });
  return mapGeometry(a, f, rectFromPoints(p0, p1));
}

/** The kind as the UI names it: arrows are lines with an arrow end. */
export type DisplayKind = Annotation['kind'] | 'arrow' | 'signature';

export function displayKind(a: Annotation): DisplayKind {
  if (a.kind === 'line' && a.lineEndings?.end !== undefined && a.lineEndings.end !== 'none') {
    return 'arrow';
  }
  return a.kind;
}
