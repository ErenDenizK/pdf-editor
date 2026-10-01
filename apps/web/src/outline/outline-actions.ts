/**
 * Outline editing actions for the panel, its context menu and the command palette. Each
 * action commits one model edit (`editOutline`, document-model outline.ts) as one labelled
 * history entry, carries the panel's view state across it (`followEdits`) and announces the
 * result for screen readers. Destructive actions are undoable and never confirmed
 * (DESIGN.md §4.3).
 */
import {
  type DocumentId,
  effectiveLabel,
  editOutline,
  type OutlineEdit,
  type OutlineGap,
  type OutlineMoveDirection,
  type OutlineNode,
  type OutlinePath,
  outlineItem,
  outlineMoveGap,
  outlineNodeAt,
  remapOutlinePath,
  type VirtualDocument,
  type Workspace,
} from '@pdf-editor/document-model';

import { currentPlatform } from '../commands/shortcuts';
import { m } from '../i18n';
import { announce } from '../shell/announcer';
import { isNavigatorShowing, useUiStore } from '../state/ui-store';
import { useWorkspaceStore } from '../state/workspace-store';
import { currentViewDestination } from './current-view';
import {
  followEdits,
  keyOf,
  pathOf,
  startRenaming,
  useOutlineViewStore,
} from './outline-view-store';

/** The title as shown: blank titles (possible in files) read "Untitled". */
export function displayTitle(node: OutlineNode): string {
  const title = node.title.trim();
  return title === '' ? m.outline_untitled() : title;
}

function workspace(): Workspace {
  return useWorkspaceStore.getState().workspace;
}

function documentOf(id: DocumentId): VirtualDocument | undefined {
  const ws = workspace();
  return Object.hasOwn(ws.documents, id) ? ws.documents[id] : undefined;
}

function undoHint(): string {
  return currentPlatform === 'mac' ? m.undo_hint_mac() : m.undo_hint_other();
}

/**
 * Commits a sequence of edits as one history entry and carries the view state across.
 * `reveal` is where the focus goes afterwards (in the edited tree); by default the last
 * edit's node. Returns the path of the last edited node, or undefined when nothing changed.
 */
function commit(
  documentId: DocumentId,
  edits: readonly OutlineEdit[],
  label: string,
  reveal?: (after: readonly OutlineNode[], lastPath: OutlinePath) => OutlinePath | undefined,
): OutlinePath | undefined {
  const before = documentOf(documentId)?.outline;
  if (before === undefined || edits.length === 0) return undefined;
  let lastPath: OutlinePath | undefined;
  const changed = useWorkspaceStore.getState().applyOperation((ws) => {
    let next = ws;
    for (const edit of edits) {
      const result = editOutline(next, documentId, edit);
      next = result.workspace;
      lastPath = result.path;
    }
    return next;
  }, label);
  const after = documentOf(documentId)?.outline;
  if (!changed || after === undefined || lastPath === undefined) return undefined;
  const target = reveal ? reveal(after, lastPath) : lastPath;
  followEdits(documentId, before, after, edits, target);
  return lastPath;
}

function gapAfter(path: OutlinePath): OutlineGap {
  return { parent: path.slice(0, -1), index: (path[path.length - 1] ?? -1) + 1 };
}

/** Where "Add bookmark" goes: after the focused item, else at the end of the top level. */
function defaultGap(doc: VirtualDocument): OutlineGap {
  const key = useOutlineViewStore.getState().focused[doc.id];
  const path = key === undefined ? undefined : pathOf(key);
  if (path !== undefined && outlineNodeAt(doc.outline, path) !== undefined) return gapAfter(path);
  return { parent: [], index: doc.outline.length };
}

/**
 * Adds a bookmark to the current view (page and scroll position) and starts renaming it.
 * `at` defaults to right after the focused item. Returns the new item's path.
 */
export function addBookmark(documentId: DocumentId, at?: OutlineGap): OutlinePath | undefined {
  const ws = workspace();
  const doc = documentOf(documentId);
  if (!doc) return undefined;
  const destination = currentViewDestination(ws, doc);
  const index = destination ? doc.pages.findIndex((p) => p.id === destination.page) : -1;
  const title =
    index >= 0
      ? m.outline_new_title({ label: effectiveLabel(ws, doc, index) })
      : m.outline_untitled();
  const node = outlineItem(title, destination);
  const path = commit(
    documentId,
    [{ kind: 'insert', at: at ?? defaultGap(doc), node }],
    m.history_outline_add({ title }),
  );
  if (path === undefined) return undefined;
  announce(m.announce_outline_added({ title }));
  startRenaming(documentId, keyOf(path));
  return path;
}

export function addChildBookmark(documentId: DocumentId, parent: OutlinePath) {
  const node = outlineNodeAt(documentOf(documentId)?.outline ?? [], parent);
  if (!node) return undefined;
  return addBookmark(documentId, { parent, index: node.children.length });
}

export function addSiblingBookmark(documentId: DocumentId, path: OutlinePath) {
  return addBookmark(documentId, gapAfter(path));
}

export type RenameOutcome = 'renamed' | 'unchanged' | 'empty';

/** Renames an item; a blank title is refused (`empty`), the item keeps its title. */
export function renameBookmark(
  documentId: DocumentId,
  path: OutlinePath,
  title: string,
): RenameOutcome {
  const trimmed = title.trim();
  if (trimmed === '') return 'empty';
  const node = outlineNodeAt(documentOf(documentId)?.outline ?? [], path);
  if (!node || node.title === trimmed) return 'unchanged';
  const done = commit(
    documentId,
    [{ kind: 'rename', path, title: trimmed }],
    m.history_outline_rename({ title: trimmed }),
  );
  return done === undefined ? 'unchanged' : 'renamed';
}

/** Deletes an item with its children; the focus moves to a neighbour. */
export function deleteBookmark(documentId: DocumentId, path: OutlinePath): boolean {
  const node = outlineNodeAt(documentOf(documentId)?.outline ?? [], path);
  if (!node) return false;
  const title = displayTitle(node);
  const done = commit(
    documentId,
    [{ kind: 'remove', path }],
    m.history_outline_delete({ title }),
    (after) => {
      const parent = path.slice(0, -1);
      const index = path[path.length - 1] ?? 0;
      const siblings = parent.length === 0 ? after : outlineNodeAt(after, parent)?.children;
      const count = siblings?.length ?? 0;
      if (index < count) return path;
      if (count > 0) return [...parent, count - 1];
      return parent.length > 0 ? parent : undefined;
    },
  );
  if (done === undefined) return false;
  announce(m.announce_outline_deleted({ title, shortcut: undoHint() }));
  return true;
}

function announceMoved(node: OutlineNode, path: OutlinePath): void {
  announce(
    m.announce_outline_moved({
      title: displayTitle(node),
      level: path.length,
      position: (path[path.length - 1] ?? 0) + 1,
    }),
  );
}

/** Keyboard move (Alt+Arrows, context menu): up, down, indent, outdent. */
export function moveBookmark(
  documentId: DocumentId,
  path: OutlinePath,
  direction: OutlineMoveDirection,
): OutlinePath | undefined {
  const outline = documentOf(documentId)?.outline ?? [];
  const node = outlineNodeAt(outline, path);
  if (!node) return undefined;
  const gap = outlineMoveGap(outline, path, direction);
  if (!gap) {
    announce(m.announce_outline_move_blocked({ title: displayTitle(node) }));
    return undefined;
  }
  return dropBookmark(documentId, path, gap);
}

/** Moves an item (with its children) to a gap of the current tree (drag and drop). */
export function dropBookmark(
  documentId: DocumentId,
  from: OutlinePath,
  to: OutlineGap,
): OutlinePath | undefined {
  const node = outlineNodeAt(documentOf(documentId)?.outline ?? [], from);
  if (!node) return undefined;
  const path = commit(
    documentId,
    [{ kind: 'move', from, to }],
    m.history_outline_move({ title: displayTitle(node) }),
  );
  if (path !== undefined) announceMoved(node, path);
  return path;
}

/** Points an item at the current view (page and position). */
export function setDestinationToCurrentView(documentId: DocumentId, path: OutlinePath): boolean {
  const ws = workspace();
  const doc = documentOf(documentId);
  const node = outlineNodeAt(doc?.outline ?? [], path);
  if (!doc || !node) return false;
  const destination = currentViewDestination(ws, doc);
  if (!destination) return false;
  const title = displayTitle(node);
  const done = commit(
    documentId,
    [{ kind: 'set-destination', path, destination }],
    m.history_outline_destination({ title }),
  );
  if (done === undefined) return false;
  const index = doc.pages.findIndex((p) => p.id === destination.page);
  announce(m.announce_outline_destination({ title, label: effectiveLabel(ws, doc, index) }));
  return true;
}

/** Toggles whether the item is expanded when the exported file is opened. */
export function toggleStartExpanded(documentId: DocumentId, path: OutlinePath): boolean {
  const node = outlineNodeAt(documentOf(documentId)?.outline ?? [], path);
  if (!node) return false;
  return (
    commit(
      documentId,
      [{ kind: 'set-open', path, open: !node.open }],
      m.history_outline_expanded({ title: displayTitle(node) }),
    ) !== undefined
  );
}

/**
 * The edits that remove dead links (as `removeDeadOutlineLinks`): unresolved leaves go,
 * unresolved items with children stay as headings. Listed in reverse pre-order so each
 * path is still valid when its edit runs.
 */
export function deadLinkEdits(nodes: readonly OutlineNode[]): OutlineEdit[] {
  const edits: OutlineEdit[] = [];
  const visit = (list: readonly OutlineNode[], parent: OutlinePath): number => {
    let kept = list.length;
    for (let i = list.length - 1; i >= 0; i--) {
      const node = list[i] as OutlineNode;
      const path = [...parent, i];
      const children = visit(node.children, path);
      if (node.destination?.kind !== 'unresolved') continue;
      if (children === 0) {
        edits.push({ kind: 'remove', path });
        kept -= 1;
      } else {
        edits.push({ kind: 'set-destination', path, destination: null });
      }
    }
    return kept;
  };
  visit(nodes, []);
  return edits;
}

/** Removes every dead link of the document's outline (one undo step). */
export function removeDeadLinks(documentId: DocumentId): boolean {
  const doc = documentOf(documentId);
  if (!doc) return false;
  const edits = deadLinkEdits(doc.outline);
  if (edits.length === 0) return false;
  const focus = useOutlineViewStore.getState().focused[documentId];
  const done = commit(documentId, edits, m.history_outline_remove_dead(), (after) => {
    if (focus === undefined) return undefined;
    // Keep the focus on the same item when it survived, else on the first item.
    let path: OutlinePath | undefined = pathOf(focus);
    for (const edit of edits) {
      if (path === undefined) break;
      path = remapOutlinePath(path, edit);
    }
    return path ?? (after.length > 0 ? [0] : undefined);
  });
  if (done === undefined) return false;
  announce(m.announce_outline_dead_removed());
  return true;
}

/** Opens the Outline panel (palette commands act where the user can see the result). */
export function showOutlinePanel(): void {
  const ui = useUiStore.getState();
  if (!isNavigatorShowing(ui, 'outline')) ui.showNavigator('outline');
}
