/**
 * The size readout of the Image tool's bar: size on the page in points, pixel size and the
 * effective resolution (dots per inch on the page), also while a resize is being dragged.
 */
import type { Rect } from '@pdf-editor/document-model';
import type { LocatedImage } from '@pdf-editor/engine';

import { formatNumber } from '../i18n';

/** Bounds closer than this (points, every edge) are the same image after a re-locate. */
const SAME_BOUNDS = 0.5;

export function sameImage(a: Rect, b: Rect): boolean {
  return (
    Math.abs(a.x - b.x) <= SAME_BOUNDS &&
    Math.abs(a.y - b.y) <= SAME_BOUNDS &&
    Math.abs(a.width - b.width) <= SAME_BOUNDS &&
    Math.abs(a.height - b.height) <= SAME_BOUNDS
  );
}

export function formatPt(value: number): string {
  return formatNumber(value, { maximumFractionDigits: 1 });
}

export interface SizeReadout {
  /** Size of the bounds on the page, points. */
  readonly width: number;
  readonly height: number;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  /** The lower of the two axes' effective resolutions, rounded. */
  readonly dpi: number;
}

/**
 * The readout for `image` shown at `rect` (default: where it is). A resize scales the
 * image's axes with the bounds, so the resolution scales inversely.
 */
export function sizeReadout(image: LocatedImage, rect: Rect = image.bounds): SizeReadout {
  const sx = image.bounds.width > 0 ? rect.width / image.bounds.width : 1;
  const sy = image.bounds.height > 0 ? rect.height / image.bounds.height : 1;
  const dpiX = sx > 0 ? image.dpi.x / sx : 0;
  const dpiY = sy > 0 ? image.dpi.y / sy : 0;
  return {
    width: rect.width,
    height: rect.height,
    pixelWidth: image.pixelWidth,
    pixelHeight: image.pixelHeight,
    dpi: Math.round(Math.min(dpiX, dpiY)),
  };
}
