/**
 * Page sizing shared by Read mode, the light table and the Pages panel.
 */
import {
  pageDisplaySize,
  type Size,
  type VirtualPage,
  type Workspace,
} from '@pdf-editor/document-model';

/** CSS pixels per PDF point at 100% zoom (96 dpi CSS inch / 72 pt). */
export const CSS_PX_PER_PT = 96 / 72;

const FALLBACK_SIZE: Size = { width: 612, height: 792 };

/** Displayed page size in points (rotation applied); never throws. */
export function displaySize(ws: Workspace, page: VirtualPage): Size {
  try {
    const size = pageDisplaySize(ws, page);
    return size.width > 0 && size.height > 0 ? size : FALLBACK_SIZE;
  } catch {
    return FALLBACK_SIZE;
  }
}

/** Scales `size` to fit a `boxWidth` × `boxHeight` box, preserving aspect ratio. */
export function fitInBox(size: Size, boxWidth: number, boxHeight: number): Size {
  const scale = Math.min(boxWidth / size.width, boxHeight / size.height);
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  };
}

/** Human rotation phrase for labels, e.g. ", rotated 90 degrees". */
export function rotationPhrase(total: number): string {
  return total === 0 ? '' : `, rotated ${total} degrees`;
}
