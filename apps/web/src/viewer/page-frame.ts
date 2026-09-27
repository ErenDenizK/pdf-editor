/** Builds the `PageFrame` of a page overlay (see geometry.ts). */
import type { Rotation, Size, SourceId } from '@pdf-editor/document-model';

import { getEngineService } from '../engine/engine-service';
import type { PageFrame } from './geometry';

export function pageFrame(input: {
  readonly sourceId: SourceId | undefined;
  readonly sourceIndex: number;
  /** Displayed size in points (after rotation). */
  readonly sizePt: Size;
  /** Total rotation: the page's intrinsic /Rotate plus `page.rotation`. */
  readonly rotation: Rotation;
  readonly cssScale: number;
  /** The page's view rotation on top of /Rotate; given, the frame knows the intrinsic part. */
  readonly page?: { readonly rotation: Rotation };
}): PageFrame {
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
    ...(input.page
      ? { intrinsicRotation: ((input.rotation - input.page.rotation + 360) % 360) as Rotation }
      : {}),
  };
}
