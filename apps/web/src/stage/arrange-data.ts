/**
 * Derived data for the light table, memoized on model identity so selectors return stable
 * references: which documents are shown as sections (all open ones unless hidden), where
 * each page sits, and which pages are outline targets (spec §6).
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
  /** Whether "Hide from Arrange" applies: every section but the active document's. */
  readonly hideable: boolean;
}

/**
 * Whether a document is on the light table: every open document is, unless hidden with
 * "Hide from Arrange" (experience-redesign §8, decision 12); the active one always is.
 */
export function isShownInArrange(
  ws: Workspace,
  hidden: readonly DocumentId[],
  id: DocumentId,
): boolean {
  return ws.documents[id] !== undefined && (id === ws.activeDocument || !hidden.includes(id));
}

/** Sections in tab order: every open document that is not hidden, and the active one. */
export function shownSections(
  ws: Workspace,
  hidden: readonly DocumentId[],
  collapsed: readonly DocumentId[],
): ShownSection[] {
  return ws.documentOrder.flatMap((id): ShownSection[] => {
    const doc = ws.documents[id];
    if (doc === undefined || !isShownInArrange(ws, hidden, id)) return [];
    return [{ doc, collapsed: collapsed.includes(id), hideable: id !== ws.activeDocument }];
  });
}

let last:
  | {
      ws: Workspace;
      hidden: readonly DocumentId[];
      collapsed: readonly DocumentId[];
      value: ShownSection[];
    }
  | undefined;

function cachedSections(
  ws: Workspace,
  hidden: readonly DocumentId[],
  collapsed: readonly DocumentId[],
): ShownSection[] {
  if (last?.ws === ws && last.hidden === hidden && last.collapsed === collapsed) return last.value;
  const value = shownSections(ws, hidden, collapsed);
  // Keep the previous array when nothing shown changed (e.g. an edit in a hidden tab).
  const previous = last?.value;
  const same =
    previous?.length === value.length &&
    previous.every(
      (s, i) =>
        s.doc === value[i]?.doc &&
        s.collapsed === value[i].collapsed &&
        s.hideable === value[i].hideable,
    );
  const result = same ? previous : value;
  last = { ws, hidden, collapsed, value: result };
  return result;
}

export function useShownSections(): ShownSection[] {
  const ws = useWorkspaceStore((s) => s.workspace);
  const hidden = useUiStore((s) => s.arrangeHidden);
  const collapsed = useUiStore((s) => s.arrangeCollapsed);
  return cachedSections(ws, hidden, collapsed);
}

/** Non-hook form of `isShownInArrange` for commands and operations. */
export function shownInArrangeNow(id: DocumentId): boolean {
  return isShownInArrange(
    useWorkspaceStore.getState().workspace,
    useUiStore.getState().arrangeHidden,
    id,
  );
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
