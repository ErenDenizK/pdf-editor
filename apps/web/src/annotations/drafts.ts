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

/**
 * The style a tool draws with, for the tools that have one: what the style controls change
 * while that tool is armed and nothing is selected (spec §6.3). The eraser, stamps, the
 * signature, redaction and the page tools have none.
 */
export function toolStyleGroup(tool: ToolMode): StyleGroup | undefined {
  switch (tool) {
    case 'highlight':
    case 'underline':
    case 'strikeout':
    case 'squiggly':
    case 'ink':
    case 'rectangle':
    case 'ellipse':
    case 'line':
    case 'arrow':
    case 'text-box':
    case 'note':
      return styleGroupOf(tool);
    default:
      return undefined;
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
