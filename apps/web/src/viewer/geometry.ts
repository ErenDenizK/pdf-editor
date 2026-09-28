/**
 * Mapping between PDF user space and the CSS pixels of a page as Read mode shows it.
 *
 * Engine geometry (glyph boxes, search hits, link rects, render clips) is *absolute*
 * unrotated user space: origin bottom-left, y up, and a CropBox at x = 50 means visible
 * content starts at x = 50 (packages/engine/src/pdfium/coords.ts). The page on screen is
 * the CropBox, turned clockwise by the page's total rotation (intrinsic /Rotate plus the
 * model's delta), origin top-left, y down, scaled by `scale` CSS pixels per point.
 *
 * Every overlay (text layer, search highlights, link hotspots, tiles) goes through here,
 * so there is exactly one place where rotation and the CropBox origin are applied.
 *
 * Resized pages (`VirtualPage.resize`) get an equivalent frame (`resizedPageFrame`): engine
 * geometry stays in the *source* page's user space, and the frame folds the resize matrix
 * x' = a·x + e, y' = d·y + f into its origin, size and scale (measured in content units of
 * 1/a new-page points, so `scale` is the content's CSS pixels per source point), plus
 * `stretchY` = d/a for a non-uniform stretch. Overlays need no resize logic of their own.
 */
import {
  type PageResize,
  type Rect,
  resizeTransform,
  type Rotation,
  type Size,
} from '@pdf-editor/document-model';

export interface PageFrame {
  /** Unrotated CropBox size in points. */
  readonly size: Size;
  /** Lower-left corner of the CropBox in user space ((0, 0) for most files). */
  readonly originX: number;
  readonly originY: number;
  /** Total clockwise rotation applied on screen. */
  readonly rotation: Rotation;
  /**
   * The part of `rotation` that is the page's own /Rotate (the rest is the app's view
   * rotation, VirtualPage.rotation). Only annotations drawn upright against /Rotate
   * (NoRotate note icons) need the split; undefined reads as 0.
   */
  readonly intrinsicRotation?: Rotation;
  /** CSS pixels per point. */
  readonly scale: number;
  /**
   * Resized pages stretched non-uniformly: user-space y is multiplied by this before the
   * mapping (x by 1). Undefined reads as 1. See `resizedPageFrame`.
   */
  readonly stretchY?: number;
}

/**
 * The frame of a resized page: `contentBox` is the source page's visible box (crop box, in
 * the source's user space), `resize` the stored (unrotated) resize, `rotation` the total
 * rotation and `cssScale` the CSS pixels per point of the *new* page. Mapping engine
 * geometry through it gives its place on the resized page as the export draws it
 * (packages/engine/src/pdflib/page-resize.ts uses the same matrix).
 */
export function resizedPageFrame(input: {
  readonly contentBox: Rect;
  readonly resize: PageResize;
  readonly rotation: Rotation;
  readonly cssScale: number;
  readonly intrinsicRotation?: Rotation;
}): PageFrame {
  const { contentBox: box, resize } = input;
  const t = resizeTransform({ width: box.width, height: box.height }, resize);
  const a = t.scaleX;
  const d = t.scaleY;
  const e = t.offsetX - a * box.x;
  const f = t.offsetY - d * box.y;
  return {
    size: { width: resize.width / a, height: resize.height / a },
    originX: -e / a + 0,
    originY: -f / a + 0,
    rotation: input.rotation,
    scale: input.cssScale * a,
    ...(Math.abs(d / a - 1) > 1e-9 ? { stretchY: d / a } : {}),
    ...(input.intrinsicRotation === undefined
      ? {}
      : { intrinsicRotation: input.intrinsicRotation }),
  };
}

export interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** Displayed size in points (after rotation). */
export function displayedSize(frame: PageFrame): Size {
  const quarter = frame.rotation === 90 || frame.rotation === 270;
  return quarter
    ? { width: frame.size.height, height: frame.size.width }
    : { width: frame.size.width, height: frame.size.height };
}

/**
 * A user-space rectangle as a CSS box on the displayed page. Rectangles stay axis-aligned
 * under quarter turns, so the result is exact.
 */
export function userRectToCss(frame: PageFrame, rect: Rect): Box {
  const { width: W, height: H } = frame.size;
  const k = frame.stretchY ?? 1;
  // Unrotated, top-left origin, y down.
  const ux = rect.x - frame.originX;
  const uy = frame.originY + H - k * (rect.y + rect.height);
  const w = rect.width;
  const h = rect.height * k;
  let box: Box;
  switch (frame.rotation) {
    case 90:
      box = { left: H - (uy + h), top: ux, width: h, height: w };
      break;
    case 180:
      box = { left: W - (ux + w), top: H - (uy + h), width: w, height: h };
      break;
    case 270:
      box = { left: uy, top: W - (ux + w), width: h, height: w };
      break;
    default:
      box = { left: ux, top: uy, width: w, height: h };
  }
  const s = frame.scale;
  return { left: box.left * s, top: box.top * s, width: box.width * s, height: box.height * s };
}

/** A user-space point in CSS pixels on the displayed page. */
export function userPointToCss(
  frame: PageFrame,
  point: { readonly x: number; readonly y: number },
): { x: number; y: number } {
  const box = userRectToCss(frame, { x: point.x, y: point.y, width: 0, height: 0 });
  return { x: box.left, y: box.top };
}

/**
 * The inverse of `userRectToCss` for a box given in displayed *points* (not CSS pixels):
 * which user-space rectangle a region of the displayed page shows. Used for render clips.
 */
export function displayRectToUser(frame: PageFrame, box: Box): Rect {
  const { width: W, height: H } = frame.size;
  let ux: number;
  let uy: number;
  let w: number;
  let h: number;
  switch (frame.rotation) {
    case 90:
      ux = box.top;
      uy = H - (box.left + box.width);
      w = box.height;
      h = box.width;
      break;
    case 180:
      ux = W - (box.left + box.width);
      uy = H - (box.top + box.height);
      w = box.width;
      h = box.height;
      break;
    case 270:
      ux = W - (box.top + box.height);
      uy = box.left;
      w = box.height;
      h = box.width;
      break;
    default:
      ux = box.left;
      uy = box.top;
      w = box.width;
      h = box.height;
  }
  const k = frame.stretchY ?? 1;
  return {
    x: ux + frame.originX,
    y: (frame.originY + H - (uy + h)) / k,
    width: w,
    height: h / k,
  };
}

/**
 * Reading direction of a line of glyphs on screen, in degrees clockwise from "left to
 * right": 0, 90 (top to bottom), 180 or 270. Computed from the first and last glyph
 * centres in user space, then turned by the page rotation. A single glyph reads upright
 * relative to user space.
 */
export function lineAngle(frame: PageFrame, glyphs: readonly { readonly rect: Rect }[]): Rotation {
  const first = glyphs[0];
  const last = glyphs[glyphs.length - 1];
  let user: Rotation = 0;
  if (first && last && first !== last) {
    const dx = last.rect.x + last.rect.width / 2 - (first.rect.x + first.rect.width / 2);
    // CSS y grows downward, user y upward.
    const dy = -(last.rect.y + last.rect.height / 2 - (first.rect.y + first.rect.height / 2));
    if (Math.abs(dx) >= Math.abs(dy)) user = dx >= 0 ? 0 : 180;
    else user = dy > 0 ? 90 : 270;
  }
  return ((user + frame.rotation) % 360) as Rotation;
}

/**
 * Placement of a text line drawn along `angle` inside its displayed box: the point the
 * (unrotated) span's top-left corner goes to, its length along the reading direction and
 * its thickness across it. The span is then turned by `angle` around that corner.
 */
export function orientedPlacement(
  box: Box,
  angle: Rotation,
): { left: number; top: number; length: number; thickness: number } {
  switch (angle) {
    case 90:
      return { left: box.left + box.width, top: box.top, length: box.height, thickness: box.width };
    case 180:
      return {
        left: box.left + box.width,
        top: box.top + box.height,
        length: box.width,
        thickness: box.height,
      };
    case 270:
      return {
        left: box.left,
        top: box.top + box.height,
        length: box.height,
        thickness: box.width,
      };
    default:
      return { left: box.left, top: box.top, length: box.width, thickness: box.height };
  }
}
