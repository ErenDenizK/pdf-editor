/**
 * Drag and drop of outline items (pragmatic-drag-and-drop, like the light table). Each
 * row is a drag source and a drop target; the list-item hitbox splits a row into
 * "before" (top edge), "into" (middle: last child, or first child of an expanded item) and
 * "after" (bottom edge). An expanded item with children has no "after": its lower half is
 * "into", since the row below it is already its first child.
 */
import {
  type Instruction,
  attachInstruction,
  extractInstruction,
} from '@atlaskit/pragmatic-drag-and-drop-hitbox/list-item';
import type { Input } from '@atlaskit/pragmatic-drag-and-drop/types';
import {
  type DocumentId,
  isOutlinePathPrefix,
  type OutlineGap,
  type OutlineNode,
  type OutlinePath,
  outlineNodeAt,
} from '@pdf-editor/document-model';

export type DropPosition = 'before' | 'after' | 'into';

/** Data attached to an outline item drag. */
export interface OutlineDragData {
  readonly type: 'outline-item';
  readonly documentId: DocumentId;
  readonly key: string;
  [key: string | symbol]: unknown;
}

export function isOutlineDrag(data: Record<string | symbol, unknown>): data is OutlineDragData {
  return (
    data.type === 'outline-item' &&
    typeof data.documentId === 'string' &&
    typeof data.key === 'string'
  );
}

/** Whether an item may be dropped on a row: never on itself or inside its own subtree. */
export function canDropOn(from: OutlinePath, target: OutlinePath): boolean {
  return !isOutlinePathPrefix(from, target);
}

/** The gap a drop at `position` of the row `target` means, in the tree before the move. */
export function dropGap(
  nodes: readonly OutlineNode[],
  target: OutlinePath,
  position: DropPosition,
  expanded: boolean,
): OutlineGap | undefined {
  const node = outlineNodeAt(nodes, target);
  if (!node) return undefined;
  const parent = target.slice(0, -1);
  const index = target[target.length - 1] ?? 0;
  switch (position) {
    case 'before':
      return { parent, index };
    case 'after':
      return { parent, index: index + 1 };
    case 'into':
      return {
        parent: target,
        index: expanded && node.children.length > 0 ? 0 : node.children.length,
      };
  }
}

/** Attaches the hitbox instruction for a row to its drop-target data. */
export function withDropInstruction(
  data: Record<string | symbol, unknown>,
  input: Input,
  element: Element,
  expandedWithChildren: boolean,
): Record<string | symbol, unknown> {
  return attachInstruction(data, {
    input,
    element,
    axis: 'vertical',
    operations: {
      'reorder-before': 'available',
      'reorder-after': expandedWithChildren ? 'not-available' : 'available',
      combine: 'available',
    },
  });
}

/** The drop position a target's data carries, if any. */
export function dropPositionOf(data: Record<string | symbol, unknown>): DropPosition | null {
  const instruction: Instruction | null = extractInstruction(data);
  if (!instruction || instruction.blocked) return null;
  switch (instruction.operation) {
    case 'reorder-before':
      return 'before';
    case 'reorder-after':
      return 'after';
    case 'combine':
      return 'into';
  }
}
