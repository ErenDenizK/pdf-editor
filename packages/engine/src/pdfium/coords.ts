/**
 * Coordinate conversion between EmbedPDF "device" space and PDF user space.
 *
 * EmbedPDF 2.x (opened with `normalizeRotation: false`, our default) reports every rect and
 * point — glyph boxes, search hits, annotation rects, ink points — in the page's *display*
 * space: points, origin at the top-left of the page as displayed (after /Rotate), y down,
 * relative to the CropBox. `PdfPageObject.size` is the displayed (rotated) size. This mirrors
 * the private `convertPagePointToDevicePoint` / `convertDevicePointToPagePoint` helpers of
 * the engine (verified against @embedpdf/engines 2.15.1).
 *
 * Our contracts use PDF user space: unrotated, origin bottom-left, y up, absolute
 * coordinates (a CropBox at x=50 means user x starts at 50).
 */

import type { Position, Rect as DeviceRect, PdfPageObject } from '@embedpdf/models';
import type { Rect, Rotation, Size } from '@pdf-editor/document-model';

export interface PageGeometry {
  /** Quarter turns clockwise (the page's /Rotate / 90). */
  readonly quarterTurns: 0 | 1 | 2 | 3;
  /** Displayed (rotated) size, as EmbedPDF reports it. */
  readonly displayWidth: number;
  readonly displayHeight: number;
  /** Lower-left corner of the CropBox in user space. */
  readonly originX: number;
  readonly originY: number;
}

export function pageGeometry(page: PdfPageObject): PageGeometry {
  const crop = page.boxes?.crop;
  return {
    quarterTurns: (page.rotation & 3) as 0 | 1 | 2 | 3,
    displayWidth: page.size.width,
    displayHeight: page.size.height,
    originX: crop ? crop.left : 0,
    originY: crop ? crop.bottom : 0,
  };
}

/** Unrotated page size (CropBox) — EmbedPDF reports the rotated one. */
export function unrotatedSize(page: PdfPageObject): Size {
  const odd = (page.rotation & 1) === 1;
  return odd
    ? { width: page.size.height, height: page.size.width }
    : { width: page.size.width, height: page.size.height };
}

export function rotationDegrees(page: PdfPageObject): Rotation {
  return (((page.rotation & 3) * 90) % 360) as Rotation;
}

export function deviceToUserPoint(g: PageGeometry, p: Position): { x: number; y: number } {
  const W = g.displayWidth;
  const H = g.displayHeight;
  let x: number;
  let y: number;
  switch (g.quarterTurns) {
    case 0:
      x = p.x;
      y = H - p.y;
      break;
    case 1:
      x = p.y;
      y = p.x;
      break;
    case 2:
      x = W - p.x;
      y = p.y;
      break;
    default:
      x = H - p.y;
      y = W - p.x;
      break;
  }
  return { x: x + g.originX, y: y + g.originY };
}

export function userToDevicePoint(g: PageGeometry, p: { x: number; y: number }): Position {
  const W = g.displayWidth;
  const H = g.displayHeight;
  const px = p.x - g.originX;
  const py = p.y - g.originY;
  switch (g.quarterTurns) {
    case 0:
      return { x: px, y: H - py };
    case 1:
      return { x: py, y: px };
    case 2:
      return { x: W - px, y: py };
    default:
      return { x: W - py, y: H - px };
  }
}

function boundsOf(points: readonly { x: number; y: number }[]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

export function deviceToUserRect(g: PageGeometry, r: DeviceRect): Rect {
  const { x, y } = r.origin;
  const { width, height } = r.size;
  const b = boundsOf([
    deviceToUserPoint(g, { x, y }),
    deviceToUserPoint(g, { x: x + width, y }),
    deviceToUserPoint(g, { x, y: y + height }),
    deviceToUserPoint(g, { x: x + width, y: y + height }),
  ]);
  return { x: b.minX, y: b.minY, width: b.maxX - b.minX, height: b.maxY - b.minY };
}

export function userToDeviceRect(g: PageGeometry, r: Rect): DeviceRect {
  const b = boundsOf([
    userToDevicePoint(g, { x: r.x, y: r.y }),
    userToDevicePoint(g, { x: r.x + r.width, y: r.y }),
    userToDevicePoint(g, { x: r.x, y: r.y + r.height }),
    userToDevicePoint(g, { x: r.x + r.width, y: r.y + r.height }),
  ]);
  return {
    origin: { x: b.minX, y: b.minY },
    size: { width: b.maxX - b.minX, height: b.maxY - b.minY },
  };
}

/**
 * An annotation or widget /Rect as EmbedPDF 2.15 reports it. Unlike glyph boxes and quads,
 * `convertPageRectToDeviceRect` converts only the (left, top) corner and keeps the
 * *unrotated* width and height, so on /Rotate 90/180/270 pages `size` is transposed
 * relative to display space and `origin` is not the top-left corner. The user-space rect is
 * therefore (left, top - height, width, height) with (left, top) = the converted origin.
 * (Writes go through `setPageAnnoRect`, which converts all four corners, so
 * `userToDeviceRect` stays correct for them.)
 */
export function annotationRectToUser(g: PageGeometry, r: DeviceRect): Rect {
  const topLeft = deviceToUserPoint(g, r.origin);
  return {
    x: topLeft.x,
    y: topLeft.y - r.size.height,
    width: r.size.width,
    height: r.size.height,
  };
}

/** Smallest user-space rect containing all rects; undefined for an empty list. */
export function unionRect(rects: readonly Rect[]): Rect | undefined {
  if (rects.length === 0) {
    return undefined;
  }
  const b = boundsOf(
    rects.flatMap((r) => [
      { x: r.x, y: r.y },
      { x: r.x + r.width, y: r.y + r.height },
    ]),
  );
  return { x: b.minX, y: b.minY, width: b.maxX - b.minX, height: b.maxY - b.minY };
}
