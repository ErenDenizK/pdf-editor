/**
 * Builds the `PageFrame` of a page overlay (see geometry.ts). A resized page
 * (`VirtualPage.resize`) gets `resizedPageFrame`, so every overlay that maps through the
 * frame (text, links, search, annotations, forms, redaction marks) follows the resize.
 */
import {
  type PageRef,
  type PageResize,
  pageContentSize,
  type Rect,
  type Rotation,
  type Size,
  type SourceId,
  type VirtualPage,
} from '@pdf-editor/document-model';

import { getEngineService } from '../engine/engine-service';
import { useWorkspaceStore } from '../state/workspace-store';
import { type PageFrame, resizedPageFrame } from './geometry';

/** What the frame needs to know about the page itself (a `VirtualPage` fits). */
export interface FramePage {
  /** The page's view rotation on top of /Rotate. */
  readonly rotation: Rotation;
  readonly resize?: PageResize | undefined;
  readonly cropBox?: Rect | undefined;
  readonly ref?: PageRef;
}

/**
 * The visible box of a page's source content in its own user space: the model's crop box,
 * else the engine's CropBox of the source page, else the page size at the origin.
 */
export function pageContentBox(
  page: FramePage,
  sourceId: SourceId | undefined,
  sourceIndex: number,
): Rect {
  if (page.cropBox !== undefined) return page.cropBox;
  if (page.ref !== undefined && page.ref.kind !== 'source') {
    return { x: 0, y: 0, ...page.ref.size };
  }
  const crop =
    sourceId === undefined ? undefined : getEngineService().pageCropBox(sourceId, sourceIndex);
  if (crop !== undefined && crop.width > 0 && crop.height > 0) return crop;
  let size: Size = { width: 612, height: 792 };
  if (page.ref !== undefined) {
    try {
      size = pageContentSize(useWorkspaceStore.getState().workspace, page as VirtualPage);
    } catch {
      // Keep the fallback: an unknown source (closed meanwhile) must not break an overlay.
    }
  }
  return { x: crop?.x ?? 0, y: crop?.y ?? 0, ...size };
}

export function pageFrame(input: {
  readonly sourceId: SourceId | undefined;
  readonly sourceIndex: number;
  /** Displayed size in points (after rotation). */
  readonly sizePt: Size;
  /** Total rotation: the page's intrinsic /Rotate plus `page.rotation`. */
  readonly rotation: Rotation;
  readonly cssScale: number;
  /**
   * The page's view rotation on top of /Rotate; given, the frame knows the intrinsic part.
   * With a `resize` (a `VirtualPage` carries it) the frame follows the resized page.
   */
  readonly page?: FramePage;
}): PageFrame {
  const intrinsic = input.page
    ? { intrinsicRotation: ((input.rotation - input.page.rotation + 360) % 360) as Rotation }
    : {};
  if (input.page?.resize !== undefined) {
    return resizedPageFrame({
      contentBox: pageContentBox(input.page, input.sourceId, input.sourceIndex),
      resize: input.page.resize,
      rotation: input.rotation,
      cssScale: input.cssScale,
      ...intrinsic,
    });
  }
  const quarter = input.rotation === 90 || input.rotation === 270;
  const size = quarter ? { width: input.sizePt.height, height: input.sizePt.width } : input.sizePt;
  const crop =
    input.sourceId === undefined
      ? undefined
      : getEngineService().pageCropBox(input.sourceId, input.sourceIndex);
  return {
    size,
    originX: crop?.x ?? 0,
    originY: crop?.y ?? 0,
    rotation: input.rotation,
    scale: input.cssScale,
    ...intrinsic,
  };
}
