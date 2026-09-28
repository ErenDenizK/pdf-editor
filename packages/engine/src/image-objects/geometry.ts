/**
 * Matrix and rect helpers for image objects (pure; no PDFium). Matrices are PDF row-vector
 * affine matrices `[a, b, c, d, e, f]`: a point maps as `[x y 1] × M`. An image object's
 * matrix maps the unit square (the image, bottom-up) onto its container.
 */
import type { Rect } from '@pdf-editor/document-model';

import type { TextMatrix } from '../types';

/** Row-vector product: apply `a`, then `b`. */
export function multiplyMatrix(a: TextMatrix, b: TextMatrix): TextMatrix {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}

/** The inverse, or undefined for a singular matrix. */
export function invertMatrix(m: TextMatrix): TextMatrix | undefined {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return undefined;
  const a = m[3] / det;
  const b = -m[1] / det;
  const c = -m[2] / det;
  const d = m[0] / det;
  return [a, b, c, d, -(m[4] * a + m[5] * c), -(m[4] * b + m[5] * d)];
}

export function applyMatrix(m: TextMatrix, x: number, y: number): { x: number; y: number } {
  return { x: x * m[0] + y * m[2] + m[4], y: x * m[1] + y * m[3] + m[5] };
}

/** Bounding box of the unit square under `m` (an image object's bounds). */
export function imageBounds(m: TextMatrix): Rect {
  const corners = [
    applyMatrix(m, 0, 0),
    applyMatrix(m, 1, 0),
    applyMatrix(m, 0, 1),
    applyMatrix(m, 1, 1),
  ];
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/**
 * The matrix whose image bounds are `rect`, keeping the directions of the image's own axes
 * (rotation and skew): the image's width and height are scaled by `kx` and `ky` such that
 * the bounding box of the result is `rect`'s size, then it is moved onto `rect`. When no
 * positive `kx`, `ky` exist (an image turned by about 45°, whose bounding box cannot take
 * every aspect ratio), the bounds are scaled in page space instead (the image is sheared).
 * Undefined for an empty rect or a degenerate `m`.
 */
export function matrixForRect(m: TextMatrix, rect: Rect): TextMatrix | undefined {
  const from = imageBounds(m);
  if (!(from.width > 0 && from.height > 0 && rect.width > 0 && rect.height > 0)) return undefined;
  // Bounding box of diag(kx, ky) × m: width |a|kx + |c|ky, height |b|kx + |d|ky.
  const [a, b, c, d] = [Math.abs(m[0]), Math.abs(m[1]), Math.abs(m[2]), Math.abs(m[3])];
  const det = a * d - c * b;
  let scaled: TextMatrix | undefined;
  if (Math.abs(det) > 1e-9 * Math.max(a * d, c * b, 1e-12)) {
    const kx = (rect.width * d - c * rect.height) / det;
    const ky = (a * rect.height - b * rect.width) / det;
    if (kx > 0 && ky > 0 && Number.isFinite(kx) && Number.isFinite(ky)) {
      scaled = multiplyMatrix([kx, 0, 0, ky, 0, 0], m);
    }
  }
  if (!scaled) {
    const sx = rect.width / from.width;
    const sy = rect.height / from.height;
    scaled = multiplyMatrix(m, [sx, 0, 0, sy, 0, 0]);
  }
  const at = imageBounds(scaled);
  return [
    scaled[0],
    scaled[1],
    scaled[2],
    scaled[3],
    scaled[4] + rect.x - at.x,
    scaled[5] + rect.y - at.y,
  ];
}

/** Largest difference between the edges of two rects. */
export function rectDistance(a: Rect, b: Rect): number {
  return Math.max(
    Math.abs(a.x - b.x),
    Math.abs(a.y - b.y),
    Math.abs(a.x + a.width - (b.x + b.width)),
    Math.abs(a.y + a.height - (b.y + b.height)),
  );
}

/** Pixels per inch along the image's own axes for a page-space matrix. */
export function effectiveDpi(
  m: TextMatrix,
  pixelWidth: number,
  pixelHeight: number,
): { x: number; y: number } {
  const w = Math.hypot(m[0], m[1]);
  const h = Math.hypot(m[2], m[3]);
  return { x: w > 0 ? (pixelWidth * 72) / w : 0, y: h > 0 ? (pixelHeight * 72) / h : 0 };
}
