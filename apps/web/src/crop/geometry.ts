/**
 * Crop maths (M4 §3 "crop as CropBox"). Pure functions shared by the crop dialog, its
 * preview, the Read-mode drawing layer, the display of cropped pages and the discard plan.
 *
 * Two spaces meet here:
 *
 * - **Display space**: what the user sees and types. Margins are named after the sides of
 *   the page *as displayed* (after the page's total rotation: intrinsic /Rotate plus the
 *   model's delta), in points, measured from the page's full visible box.
 * - **Unrotated user space**: what the model stores (`VirtualPage.cropBox`), the assembler
 *   writes (/CropBox) and the redaction plan uses: points, origin bottom-left, y up, absolute
 *   (a source whose own CropBox starts at x = 50 has its visible content from x = 50).
 *
 * The "page box" of a crop is the source page's full visible box (its own CropBox, else its
 * MediaBox) in unrotated user space: every crop lies inside it, and margins are measured
 * from it, so a page with an earlier crop opens with that crop as its margins.
 */
import { MIN_PAGE_SIDE, type Rect, type Rotation, type Size } from '@pdf-editor/document-model';

/** Distances from the displayed page's edges, in points (display orientation). */
export interface Margins {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export type Side = keyof Margins;

/** Sides clockwise from the top: rotating the page clockwise shifts them by one. */
export const SIDES: readonly Side[] = ['top', 'right', 'bottom', 'left'];

export const NO_MARGINS: Margins = { top: 0, right: 0, bottom: 0, left: 0 };

/** Smallest side of a crop, in points (the model's smallest page side). */
export const MIN_CROP_SIDE = MIN_PAGE_SIDE;

/** Below this (points) a margin or a band counts as zero. */
const EPSILON = 0.01;

function quarterTurns(rotation: Rotation): number {
  return (((rotation / 90) % 4) + 4) % 4;
}

/**
 * Displayed margins → the same margins named after the *unrotated* page's sides. Turning a
 * page clockwise by k quarters shows its unrotated side u at displayed side u + k: at 90°
 * the unrotated left edge is on top.
 */
export function toUnrotatedMargins(displayed: Margins, rotation: Rotation): Margins {
  const k = quarterTurns(rotation);
  const out: Record<Side, number> = { top: 0, right: 0, bottom: 0, left: 0 };
  SIDES.forEach((side, u) => {
    out[side] = displayed[SIDES[(u + k) % 4] as Side];
  });
  return out;
}

/** The inverse of `toUnrotatedMargins`. */
export function toDisplayedMargins(unrotated: Margins, rotation: Rotation): Margins {
  const k = quarterTurns(rotation);
  const out: Record<Side, number> = { top: 0, right: 0, bottom: 0, left: 0 };
  SIDES.forEach((side, i) => {
    out[side] = unrotated[SIDES[(i - k + 4) % 4] as Side];
  });
  return out;
}

/** Size as displayed: width and height swapped for quarter turns. */
export function turned(size: Size, rotation: Rotation): Size {
  return rotation === 90 || rotation === 270 ? { width: size.height, height: size.width } : size;
}

/** The part of `rect` inside `box`; undefined when they do not overlap. */
export function clampRect(rect: Rect, box: Rect): Rect | undefined {
  const x = Math.max(rect.x, box.x);
  const y = Math.max(rect.y, box.y);
  const right = Math.min(rect.x + rect.width, box.x + box.width);
  const top = Math.min(rect.y + rect.height, box.y + box.height);
  if (right - x <= 0 || top - y <= 0) return undefined;
  return { x, y, width: right - x, height: top - y };
}

/** Whether every margin is (practically) zero: the crop is the whole page. */
export function isNoCrop(margins: Margins): boolean {
  return SIDES.every((side) => Math.abs(margins[side]) < EPSILON);
}

export type MarginsProblem = 'invalid' | 'too-small';

/**
 * Why `margins` cannot crop a page of `displayed` size: a negative or non-finite margin,
 * or less than `MIN_CROP_SIDE` left in either direction. Undefined when they can.
 */
export function marginsProblem(margins: Margins, displayed: Size): MarginsProblem | undefined {
  if (SIDES.some((side) => !Number.isFinite(margins[side]) || margins[side] < 0)) {
    return 'invalid';
  }
  const width = displayed.width - margins.left - margins.right;
  const height = displayed.height - margins.top - margins.bottom;
  return width < MIN_CROP_SIDE || height < MIN_CROP_SIDE ? 'too-small' : undefined;
}

/**
 * The crop box (unrotated user space) that displayed `margins` leave of a page whose full
 * visible box is `box`, shown at `rotation`. Undefined when they leave too little
 * (`marginsProblem`).
 */
export function cropFromMargins(box: Rect, margins: Margins, rotation: Rotation): Rect | undefined {
  if (marginsProblem(margins, turned(box, rotation)) !== undefined) return undefined;
  const u = toUnrotatedMargins(margins, rotation);
  return {
    x: box.x + u.left,
    y: box.y + u.bottom,
    width: box.width - u.left - u.right,
    height: box.height - u.top - u.bottom,
  };
}

/** The displayed margins of `crop` (clamped to `box`) on a page shown at `rotation`. */
export function marginsFromCrop(box: Rect, crop: Rect | undefined, rotation: Rotation): Margins {
  const inside = crop === undefined ? undefined : clampRect(crop, box);
  if (inside === undefined) return NO_MARGINS;
  const unrotated: Margins = {
    top: box.y + box.height - (inside.y + inside.height),
    right: box.x + box.width - (inside.x + inside.width),
    bottom: inside.y - box.y,
    left: inside.x - box.x,
  };
  return toDisplayedMargins(unrotated, rotation);
}

/** Margins rounded to `digits` decimals (for display and stable comparisons). */
export function roundMargins(margins: Margins, digits = 2): Margins {
  const f = 10 ** digits;
  const r = (v: number) => Math.round(v * f) / f + 0;
  return {
    top: r(margins.top),
    right: r(margins.right),
    bottom: r(margins.bottom),
    left: r(margins.left),
  };
}

/**
 * The parts of `box` outside `crop` as at most four bands (unrotated user space): full-width
 * bands above and below the crop, and the bands left and right of it between them. Empty
 * bands are left out. This is what "discard content outside the crop" redacts.
 */
export function discardBands(box: Rect, crop: Rect): Rect[] {
  const inside = clampRect(crop, box);
  if (inside === undefined) return [{ ...box }];
  const boxTop = box.y + box.height;
  const boxRight = box.x + box.width;
  const cropTop = inside.y + inside.height;
  const cropRight = inside.x + inside.width;
  const bands: Rect[] = [
    { x: box.x, y: cropTop, width: box.width, height: boxTop - cropTop },
    { x: box.x, y: box.y, width: box.width, height: inside.y - box.y },
    { x: box.x, y: inside.y, width: inside.x - box.x, height: inside.height },
    { x: cropRight, y: inside.y, width: boxRight - cropRight, height: inside.height },
  ];
  return bands.filter((band) => band.width > EPSILON && band.height > EPSILON);
}

/** The smallest rectangle containing every rect (undefined for none). */
export function unionRects(rects: readonly Rect[]): Rect | undefined {
  if (rects.length === 0) return undefined;
  let left = Number.POSITIVE_INFINITY;
  let bottom = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let top = Number.NEGATIVE_INFINITY;
  for (const r of rects) {
    left = Math.min(left, r.x);
    bottom = Math.min(bottom, r.y);
    right = Math.max(right, r.x + r.width);
    top = Math.max(top, r.y + r.height);
  }
  return { x: left, y: bottom, width: right - left, height: top - bottom };
}

/** A box as fractions of its container (left/top from the container's top-left corner). */
export interface Placement {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Where the whole page (`box`) sits relative to its displayed crop (`crop`), as fractions
 * of the crop as displayed at `rotation`: the page bitmap the engine renders covers `box`,
 * so a surface showing a cropped page places that bitmap here and clips to the sheet.
 */
export function cropPlacement(box: Rect, crop: Rect, rotation: Rotation): Placement {
  const W = crop.width;
  const H = crop.height;
  // Unrotated, top-left origin, y down, relative to the crop.
  const ux = box.x - crop.x;
  const uy = crop.y + crop.height - (box.y + box.height);
  const w = box.width;
  const h = box.height;
  let placed: Placement;
  switch (rotation) {
    case 90:
      placed = { left: H - (uy + h), top: ux, width: h, height: w };
      break;
    case 180:
      placed = { left: W - (ux + w), top: H - (uy + h), width: w, height: h };
      break;
    case 270:
      placed = { left: uy, top: W - (ux + w), width: h, height: w };
      break;
    default:
      placed = { left: ux, top: uy, width: w, height: h };
  }
  const shown = turned({ width: W, height: H }, rotation);
  return {
    left: placed.left / shown.width + 0,
    top: placed.top / shown.height + 0,
    width: placed.width / shown.width,
    height: placed.height / shown.height,
  };
}

/** `inner` (fractions of a box) placed inside `outer` (fractions of the sheet). */
export function composePlacement(outer: Placement, inner: Placement): Placement {
  return {
    left: outer.left + inner.left * outer.width,
    top: outer.top + inner.top * outer.height,
    width: inner.width * outer.width,
    height: inner.height * outer.height,
  };
}

/** Which part of the crop rectangle a drag holds: an edge, a corner, or the whole. */
export type Handle = 'n' | 'e' | 's' | 'w' | 'ne' | 'se' | 'sw' | 'nw' | 'move';

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), Math.max(min, max));

/**
 * Displayed margins after dragging `handle` by (dx, dy) display points (x right, y down)
 * from `start`, on a page displayed at `size`. Edges stop at the page and at
 * `MIN_CROP_SIDE` from the opposite edge; "move" keeps the crop's size.
 */
export function dragMargins(
  start: Margins,
  handle: Handle,
  dx: number,
  dy: number,
  size: Size,
): Margins {
  if (handle === 'move') {
    const mx = clamp(dx, -start.left, start.right);
    const my = clamp(dy, -start.top, start.bottom);
    return {
      top: start.top + my,
      bottom: start.bottom - my,
      left: start.left + mx,
      right: start.right - mx,
    };
  }
  const next = { ...start };
  if (handle.includes('n')) {
    next.top = clamp(start.top + dy, 0, size.height - start.bottom - MIN_CROP_SIDE);
  }
  if (handle.includes('s')) {
    next.bottom = clamp(start.bottom - dy, 0, size.height - start.top - MIN_CROP_SIDE);
  }
  if (handle.includes('w')) {
    next.left = clamp(start.left + dx, 0, size.width - start.right - MIN_CROP_SIDE);
  }
  if (handle.includes('e')) {
    next.right = clamp(start.right - dx, 0, size.width - start.left - MIN_CROP_SIDE);
  }
  return next;
}

/**
 * The displayed margins of a rectangle drawn on the displayed page (`rect` in display
 * points from the top-left corner), clamped to a page displayed at `size`.
 */
export function marginsFromDisplayRect(
  rect: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  },
  size: Size,
): Margins {
  const left = clamp(rect.left, 0, size.width);
  const top = clamp(rect.top, 0, size.height);
  const right = clamp(rect.left + rect.width, 0, size.width);
  const bottom = clamp(rect.top + rect.height, 0, size.height);
  return { top, left, right: size.width - right, bottom: size.height - bottom };
}
