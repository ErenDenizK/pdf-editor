/**
 * Selection-box maths of the Image tool, in CSS pixels of the displayed page (so rotated
 * pages need nothing special: the box is converted to a user-space rect on commit). Eight
 * handles; Shift keeps the aspect ratio, Alt resizes from the centre; boxes never flip or
 * shrink below `min`.
 */
import type { Box } from '../annotations/geometry';

export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export const HANDLES: readonly Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** Smallest side of a resized box, CSS pixels. */
export const MIN_SIDE = 4;

export interface ResizeOptions {
  /** Shift: keep the start box's aspect ratio. */
  readonly keepAspect?: boolean;
  /** Alt: the centre stays; opposite edges move together. */
  readonly fromCenter?: boolean;
  readonly min?: number;
}

export function moveBox(box: Box, dx: number, dy: number): Box {
  return { ...box, left: box.left + dx, top: box.top + dy };
}

/** Horizontal and vertical direction of a handle: -1 (west / north), 0 or 1. */
export function handleSides(handle: Handle): { sx: -1 | 0 | 1; sy: -1 | 0 | 1 } {
  return {
    sx: handle.includes('e') ? 1 : handle.includes('w') ? -1 : 0,
    sy: handle.startsWith('s') ? 1 : handle.startsWith('n') ? -1 : 0,
  };
}

/** The box `start` with `handle` dragged by (dx, dy). */
export function resizeBox(
  start: Box,
  handle: Handle,
  dx: number,
  dy: number,
  options: ResizeOptions = {},
): Box {
  const min = options.min ?? MIN_SIDE;
  const { sx, sy } = handleSides(handle);
  const k = options.fromCenter ? 2 : 1;
  let width = start.width + sx * dx * k;
  let height = start.height + sy * dy * k;
  if (options.keepAspect && start.width > 0 && start.height > 0) {
    // Corners follow the larger relative change; edges drive the other side.
    let scale: number;
    if (sx === 0) scale = height / start.height;
    else if (sy === 0) scale = width / start.width;
    else scale = Math.max(width / start.width, height / start.height);
    scale = Math.max(scale, min / start.width, min / start.height);
    width = start.width * scale;
    height = start.height * scale;
  } else {
    width = Math.max(width, min);
    height = Math.max(height, min);
  }
  const cx = start.left + start.width / 2;
  const cy = start.top + start.height / 2;
  const left =
    options.fromCenter || sx === 0
      ? cx - width / 2
      : sx === 1
        ? start.left
        : start.left + start.width - width;
  const top =
    options.fromCenter || sy === 0
      ? cy - height / 2
      : sy === 1
        ? start.top
        : start.top + start.height - height;
  return { left, top, width, height };
}

/** Where a handle sits on a box (its centre), CSS pixels. */
export function handlePoint(box: Box, handle: Handle): { x: number; y: number } {
  const { sx, sy } = handleSides(handle);
  return {
    x: box.left + ((sx + 1) / 2) * box.width,
    y: box.top + ((sy + 1) / 2) * box.height,
  };
}

/** Arrow-key nudge in points (Shift: 10), as a CSS-pixel offset at `scale` px/pt. */
export function nudgeOffset(
  key: string,
  shift: boolean,
  scale: number,
): { dx: number; dy: number } | undefined {
  const step = (shift ? 10 : 1) * scale;
  switch (key) {
    case 'ArrowLeft':
      return { dx: -step, dy: 0 };
    case 'ArrowRight':
      return { dx: step, dy: 0 };
    case 'ArrowUp':
      return { dx: 0, dy: -step };
    case 'ArrowDown':
      return { dx: 0, dy: step };
    default:
      return undefined;
  }
}

/** Whether two boxes differ by more than `epsilon` CSS pixels on any edge. */
export function boxChanged(a: Box, b: Box, epsilon = 0.5): boolean {
  return (
    Math.abs(a.left - b.left) > epsilon ||
    Math.abs(a.top - b.top) > epsilon ||
    Math.abs(a.width - b.width) > epsilon ||
    Math.abs(a.height - b.height) > epsilon
  );
}
