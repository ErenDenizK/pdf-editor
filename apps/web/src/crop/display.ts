/**
 * Showing a cropped page (`VirtualPage.cropBox`) the way the export writes it. The engine
 * renders a source page for its own visible box (its CropBox, else its MediaBox); a page the
 * model crops shows only part of that bitmap. Surfaces that draw page bitmaps already place
 * the bitmap of a resized page inside its sheet (stage/ResizedContent.tsx, `contentFrame`);
 * a crop is one more placement: the whole page box relative to the crop, clipped by the
 * sheet. `contentFrame` composes the two, so Read mode, the light table and the Pages panel
 * follow a crop with no code of their own; the overlays follow through the page frame.
 */
import {
  pageTotalRotation,
  type Rect,
  type Size,
  type VirtualPage,
  type Workspace,
} from '@pdf-editor/document-model';

import { pageContentBox } from '../viewer/page-frame';
import { cropPlacement, type Placement, turned } from './geometry';

/** Below this (points) a crop edge counts as the page edge. */
const SAME_EDGE = 0.01;

/**
 * The full visible box of the page's source content, whatever the model crops: the source
 * page's own CropBox (else MediaBox) in unrotated user space; the page size at the origin
 * for blank and image pages. Never throws.
 */
export function pageBoxOf(page: VirtualPage): Rect {
  const { cropBox: _ignored, ...uncropped } = page;
  const ref = page.ref;
  return pageContentBox(
    uncropped,
    ref.kind === 'source' ? ref.source : undefined,
    ref.kind === 'source' ? ref.index : 0,
  );
}

function sameRect(a: Rect, b: Rect): boolean {
  return (
    Math.abs(a.x - b.x) < SAME_EDGE &&
    Math.abs(a.y - b.y) < SAME_EDGE &&
    Math.abs(a.width - b.width) < SAME_EDGE &&
    Math.abs(a.height - b.height) < SAME_EDGE
  );
}

/** Where the page bitmap of a cropped page goes, relative to its (displayed) crop. */
export interface CropFrame extends Placement {
  /** The whole page box as displayed (after rotation), in points: what the bitmap covers. */
  readonly widthPt: number;
  readonly heightPt: number;
}

/**
 * The crop frame of a page, or undefined when the page is not cropped (no crop box, or one
 * that is the whole page box). Never throws.
 */
export function cropFrame(ws: Workspace, page: VirtualPage): CropFrame | undefined {
  const crop = page.cropBox;
  if (crop === undefined) return undefined;
  try {
    const box = pageBoxOf(page);
    if (sameRect(box, crop)) return undefined;
    const rotation = pageTotalRotation(ws, page);
    const shown: Size = turned(box, rotation);
    return {
      ...cropPlacement(box, crop, rotation),
      widthPt: shown.width,
      heightPt: shown.height,
    };
  } catch {
    return undefined;
  }
}
