/**
 * Pure crop planning (M4 §3): what displayed margins do to each page, and the workspace
 * with those crops set. No stores and no engine: the page box (the source page's own
 * CropBox, else MediaBox) comes from the caller, so the crop dialog (actions.ts, with the
 * engine service's boxes) and the batch runner (batch/steps.ts, with the boxes of its
 * privately opened sources) share it.
 */
import {
  getPage,
  type PageId,
  pageContentSize,
  pageTotalRotation,
  type Rect,
  setPageCropBox,
  type SourceId,
  type VirtualPage,
  type Workspace,
} from '@pdf-editor/document-model';

import { cropFromMargins, isNoCrop, type Margins } from './geometry';

/** The full visible box of a page's source content (unrotated user space). */
export type PageBoxOf = (page: VirtualPage) => Rect;

/**
 * `PageBoxOf` from the workspace and the engine's CropBoxes of its sources (`cropBoxOf`):
 * the source page's CropBox when it has one, else its size at the origin; blank and image
 * pages are their size at the origin. The model's own crop is ignored. Never throws.
 */
export function pageBoxIn(
  ws: Workspace,
  cropBoxOf: (source: SourceId, index: number) => Rect | undefined,
): PageBoxOf {
  return (page) => {
    if (page.ref.kind !== 'source') return { x: 0, y: 0, ...page.ref.size };
    const crop = cropBoxOf(page.ref.source, page.ref.index);
    if (crop !== undefined && crop.width > 0 && crop.height > 0) return crop;
    const { cropBox: _ignored, ...uncropped } = page;
    try {
      return { x: crop?.x ?? 0, y: crop?.y ?? 0, ...pageContentSize(ws, uncropped) };
    } catch {
      return { x: 0, y: 0, width: 612, height: 792 };
    }
  };
}

/** The page, or undefined when it no longer exists. */
export function findPage(ws: Workspace, id: PageId): VirtualPage | undefined {
  try {
    return getPage(ws, id);
  } catch {
    return undefined;
  }
}

/** One page's new crop; `crop` undefined clears it (the whole page shows again). */
export interface PageCrop {
  readonly pageId: PageId;
  readonly crop: Rect | undefined;
}

export interface CropPlan {
  readonly crops: readonly PageCrop[];
  /** Blank and image pages: the assembler writes no /CropBox for them, so they are left. */
  readonly notPdf: number;
  /** Pages too small for the margins (less than the minimum side would be left). */
  readonly tooSmall: number;
}

/**
 * What displayed `margins` do to each of `pageIds`: every page gets the crop the margins
 * leave of its own page box (`pageBox`), in its own rotation. All-zero margins clear the
 * crop.
 */
export function planCrops(
  ws: Workspace,
  pageIds: readonly PageId[],
  margins: Margins,
  pageBox: PageBoxOf,
): CropPlan {
  const crops: PageCrop[] = [];
  let notPdf = 0;
  let tooSmall = 0;
  const clear = isNoCrop(margins);
  for (const pageId of pageIds) {
    const page = findPage(ws, pageId);
    if (page === undefined) continue;
    if (page.ref.kind !== 'source') {
      notPdf++;
      continue;
    }
    if (clear) {
      crops.push({ pageId, crop: undefined });
      continue;
    }
    const crop = cropFromMargins(pageBox(page), margins, pageTotalRotation(ws, page));
    if (crop === undefined) tooSmall++;
    else crops.push({ pageId, crop });
  }
  return { crops, notPdf, tooSmall };
}

/** The workspace with the plan's crops set (one model change per page). */
export function withCrops(ws: Workspace, crops: readonly PageCrop[]): Workspace {
  return crops.reduce((acc, { pageId, crop }) => setPageCropBox(acc, pageId, crop), ws);
}
