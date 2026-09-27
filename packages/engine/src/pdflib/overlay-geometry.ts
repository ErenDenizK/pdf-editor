/**
 * Overlay placement on the *visible* page: the CropBox as displayed after /Rotate.
 *
 * Overlays (page numbers, headers, watermarks) are authored against what the user sees, so
 * anchors and offsets live in "display space": origin at the bottom-left corner of the page
 * as displayed, x to the right, y up, in points. Content streams are written in the page's
 * unrotated user space, so every placement is mapped back through the page rotation.
 *
 * Conventions:
 * - `offset` is a displacement in display space (+x right, +y up) applied after anchoring.
 *   A bottom-right page number 36pt from both edges is `{ x: -36, y: 36 }`.
 * - `rotate` is counter-clockwise degrees in display space, around the content box center.
 * - `rotation` is the page's effective /Rotate (clockwise degrees).
 */

import type { Anchor, Rect, Rotation, Size } from '@pdf-editor/document-model';

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Placement {
  /** Drawing origin in user space: the content's unrotated lower-left corner. */
  readonly x: number;
  readonly y: number;
  /** Counter-clockwise rotation (degrees) to draw with in user space, in [0, 360). */
  readonly angle: number;
}

export function normalizeRotation(degrees: number): Rotation {
  const quarter = Math.round(degrees / 90);
  return ((((quarter % 4) + 4) % 4) * 90) as Rotation;
}

/** Size of the visible box as displayed. */
export function displaySize(box: Rect, rotation: Rotation): Size {
  return rotation === 90 || rotation === 270
    ? { width: box.height, height: box.width }
    : { width: box.width, height: box.height };
}

/** Maps a display-space point to user space for a page whose visible box is `box`. */
export function displayToUser(point: Point, box: Rect, rotation: Rotation): Point {
  switch (rotation) {
    case 0:
      return { x: box.x + point.x, y: box.y + point.y };
    case 90:
      return { x: box.x + box.width - point.y, y: box.y + point.x };
    case 180:
      return { x: box.x + box.width - point.x, y: box.y + box.height - point.y };
    case 270:
      return { x: box.x + point.y, y: box.y + box.height - point.x };
  }
}

/** Lower-left corner (display space) of a `content`-sized box anchored inside `page`. */
export function anchorOrigin(anchor: Anchor, page: Size, content: Size): Point {
  const [vertical, horizontal] = anchor === 'center' ? ['middle', 'center'] : anchor.split('-');
  const x =
    horizontal === 'left'
      ? 0
      : horizontal === 'right'
        ? page.width - content.width
        : (page.width - content.width) / 2;
  const y =
    vertical === 'bottom'
      ? 0
      : vertical === 'top'
        ? page.height - content.height
        : (page.height - content.height) / 2;
  return { x, y };
}

/**
 * Places a content box, given its lower-left corner in display space, rotated by `rotate`
 * degrees (CCW) around its center, onto a page with visible box `box` and /Rotate `rotation`.
 */
export function placeAt(
  lowerLeft: Point,
  content: Size,
  box: Rect,
  rotation: Rotation,
  rotate = 0,
): Placement {
  const rad = (rotate * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = lowerLeft.x + content.width / 2;
  const cy = lowerLeft.y + content.height / 2;
  const hx = -content.width / 2;
  const hy = -content.height / 2;
  const originDisplay = { x: cx + hx * cos - hy * sin, y: cy + hx * sin + hy * cos };
  const origin = displayToUser(originDisplay, box, rotation);
  return { x: origin.x, y: origin.y, angle: (((rotate + rotation) % 360) + 360) % 360 };
}

export interface OverlayPlacementInput {
  readonly box: Rect;
  readonly rotation: Rotation;
  readonly anchor: Anchor;
  readonly offset: Point;
  readonly content: Size;
  readonly rotate?: number;
}

/** Anchor + offset + rotation → user-space drawing origin and angle. */
export function placeOverlay(input: OverlayPlacementInput): Placement {
  const page = displaySize(input.box, input.rotation);
  const origin = anchorOrigin(input.anchor, page, input.content);
  return placeAt(
    { x: origin.x + input.offset.x, y: origin.y + input.offset.y },
    input.content,
    input.box,
    input.rotation,
    input.rotate ?? 0,
  );
}

/**
 * Lower-left corners (display space) of tiles covering the page, phased so that the tile
 * placed by anchor + offset is part of the grid. `margin` widens the covered area on every
 * side (for rotated tiles, whose corners reach beyond their unrotated box).
 */
export function tileOrigins(
  page: Size,
  content: Size,
  first: Point,
  gap: { readonly gapX: number; readonly gapY: number },
  margin = 0,
): Point[] {
  const stepX = Math.max(1, content.width + gap.gapX);
  const stepY = Math.max(1, content.height + gap.gapY);
  const startX = first.x - Math.ceil((first.x + content.width + margin) / stepX) * stepX;
  const startY = first.y - Math.ceil((first.y + content.height + margin) / stepY) * stepY;
  const origins: Point[] = [];
  for (let y = startY; y < page.height + margin; y += stepY) {
    for (let x = startX; x < page.width + margin; x += stepX) {
      if (x + content.width > -margin && y + content.height > -margin) origins.push({ x, y });
    }
  }
  return origins;
}
