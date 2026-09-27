/** Small builders shared by the drawing tools and the selection-based markup. */
import type { Rect } from '@pdf-editor/document-model';
import type { NewAnnotation } from '@pdf-editor/engine';

import type { ToolMode } from '../viewer/tool-store';
import type { StyleGroup } from './annotation-store';
import { rectFromPoints, roundRect } from './geometry';

/** Which remembered style a tool uses. */
export function styleGroupOf(tool: ToolMode): StyleGroup {
  switch (tool) {
    case 'highlight':
    case 'underline':
    case 'strikeout':
    case 'squiggly':
    case 'ink':
    case 'note':
      return tool;
    case 'text-box':
      return 'text';
    default:
      return 'shape';
  }
}

function rectUnion(a: Rect, b: Rect): Rect {
  return rectFromPoints(
    { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) },
    { x: Math.max(a.x + a.width, b.x + b.width), y: Math.max(a.y + a.height, b.y + b.height) },
  );
}

/** A text markup annotation over `quads` (user space), its rect their union. */
export function markupDraft(
  kind: 'highlight' | 'underline' | 'strikeout' | 'squiggly',
  pageIndex: number,
  quads: readonly Rect[],
  color: string,
  opacity: number,
): NewAnnotation {
  let rect = quads[0] ?? { x: 0, y: 0, width: 0, height: 0 };
  for (const q of quads) rect = rectUnion(rect, q);
  return { kind, pageIndex, quads, rect: roundRect(rect), color, opacity };
}
