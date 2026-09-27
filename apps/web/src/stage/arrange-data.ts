/**
 * Derived data for the light table, memoized on model identity so selectors return stable
 * references: which documents are shown as sections, where each page sits, and which
 * pages are outline targets (spec §6).
 */
import {
  type DocumentId,
  type PageId,
  type VirtualDocument,
  walkOutline,
  type Workspace,
} from '@pdf-editor/document-model';

import { useUiStore } from '../state/ui-store';
import { useWorkspaceStore } from '../state/workspace-store';

export interface ShownSection {
  readonly doc: VirtualDocument;
  readonly collapsed: boolean;
  readonly pinned: boolean;
}

/**
 * Sections in tab order: the active document plus every pinned one (spec §1). Pinned ids
 * of closed documents are skipped.
 */
export function shownSections(
  ws: Workspace,
  pinned: readonly DocumentId[],
  collapsed: readonly DocumentId[],
): ShownSection[] {
  return ws.documentOrder.flatMap((id): ShownSection[] => {
    const doc = ws.documents[id];
    const isPinned = pinned.includes(id);
    if (doc === undefined || (!isPinned && id !== ws.activeDocument)) return [];
    return [{ doc, collapsed: collapsed.includes(id), pinned: isPinned }];
  });
}

let last:
  | {
      ws: Workspace;
      pinned: readonly DocumentId[];
      collapsed: readonly DocumentId[];
      value: ShownSection[];
    }
  | undefined;

function cachedSections(
  ws: Workspace,
  pinned: readonly DocumentId[],
  collapsed: readonly DocumentId[],
): ShownSection[] {
  if (last?.ws === ws && last.pinned === pinned && last.collapsed === collapsed) return last.value;
  const value = shownSections(ws, pinned, collapsed);
  // Keep the previous array when nothing shown changed (e.g. an edit in a hidden tab).
  const previous = last?.value;
  const same =
    previous?.length === value.length &&
    previous.every(
      (s, i) =>
        s.doc === value[i]?.doc &&
        s.collapsed === value[i].collapsed &&
        s.pinned === value[i].pinned,
    );
  const result = same ? previous : value;
  last = { ws, pinned, collapsed, value: result };
  return result;
}

export function useShownSections(): ShownSection[] {
  const ws = useWorkspaceStore((s) => s.workspace);
  const pinned = useUiStore((s) => s.arrangePinned);
  const collapsed = useUiStore((s) => s.arrangeCollapsed);
  return cachedSections(ws, pinned, collapsed);
}

const indexCache = new WeakMap<VirtualDocument, ReadonlyMap<PageId, number>>();

/** Page id → index within the document. */
export function pageIndexes(doc: VirtualDocument): ReadonlyMap<PageId, number> {
  let map = indexCache.get(doc);
  if (map === undefined) {
    map = new Map(doc.pages.map((p, i) => [p.id, i] as const));
    indexCache.set(doc, map);
  }
  return map;
}

const outlineCache = new WeakMap<object, ReadonlySet<PageId>>();

/** Pages that outline nodes of the document point at (bookmark glyph, spec §6). */
export function outlineTargets(doc: VirtualDocument): ReadonlySet<PageId> {
  let set = outlineCache.get(doc.outline);
  if (set === undefined) {
    const targets = new Set<PageId>();
    walkOutline(doc.outline, (node) => {
      if (node.destination?.kind === 'page') targets.add(node.destination.page);
    });
    set = targets;
    outlineCache.set(doc.outline, set);
  }
  return set;
}
