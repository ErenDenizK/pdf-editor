/** A page of a compared or converted tab, as a page the engine has open (no imports). */
import type { Rotation, Size, SourceId } from '@pdf-editor/document-model';

/** One page of a tab, as a page the engine has open. */
export interface SidePage {
  readonly sourceId: SourceId;
  readonly index: number;
  /** View rotation on top of the page's own /Rotate. */
  readonly delta: Rotation;
  /** The page's own /Rotate. */
  readonly intrinsic: Rotation;
  /** Unrotated CropBox size in points. */
  readonly size: Size;
  /** CropBox lower-left corner in user space. */
  readonly origin: { readonly x: number; readonly y: number };
}

export const totalRotation = (page: SidePage): Rotation =>
  ((page.intrinsic + page.delta) % 360) as Rotation;

/** Displayed size in points (after rotation). */
export function displayedPageSize(page: SidePage): Size {
  const quarter = totalRotation(page) % 180 !== 0;
  return quarter
    ? { width: page.size.height, height: page.size.width }
    : { width: page.size.width, height: page.size.height };
}
