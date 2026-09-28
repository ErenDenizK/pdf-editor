/**
 * View state of the Outline panel that the model does not carry: which items are expanded
 * in the panel, which one has the roving focus, and which one is being renamed.
 *
 * Outline nodes have no ids; the panel keys them by index path (`1.0.2`). Edits made
 * through `outline-actions.ts` remap the keys (`remapOutlinePath`), so expansion and focus
 * follow the items. Expansion is also remembered per outline *snapshot* (the model shares
 * the `outline` array between workspace snapshots), so undo and redo, which bring back an
 * earlier array, bring back the expansion that belonged to it.
 *
 * Expanding in the panel is view state: it does not change the document. What the saved
 * file shows expanded is the model's `open` flag, edited explicitly ("Expanded when the
 * file opens").
 */
import type { DocumentId, OutlineEdit, OutlineNode, OutlinePath } from '@pdf-editor/document-model';
import { remapOutlinePath } from '@pdf-editor/document-model';
import { create } from 'zustand';

import { initiallyExpanded } from '../shell/OutlinePanel.tree';

export function keyOf(path: OutlinePath): string {
  return path.join('.');
}

export function pathOf(key: string): OutlinePath {
  return key === '' ? [] : key.split('.').map(Number);
}

/** Keys of `path`'s ancestors (not the path itself). */
export function ancestorKeys(path: OutlinePath): string[] {
  const keys: string[] = [];
  for (let i = 1; i < path.length; i++) keys.push(keyOf(path.slice(0, i)));
  return keys;
}

interface Renaming {
  readonly documentId: DocumentId;
  readonly key: string;
}

interface OutlineViewState {
  /** Latest expansion per document (fallback for outline snapshots not seen yet). */
  readonly expanded: Readonly<Record<DocumentId, ReadonlySet<string>>>;
  readonly focused: Readonly<Record<DocumentId, string>>;
  readonly renaming: Renaming | null;
}

export const useOutlineViewStore = create<OutlineViewState>()(() => ({
  expanded: {},
  focused: {},
  renaming: null,
}));

/** Expansion remembered per outline array (see the module comment). */
const bySnapshot = new WeakMap<readonly OutlineNode[], ReadonlySet<string>>();

/**
 * The expansion to show for a document's outline: the one recorded for this snapshot, else
 * the document's latest (still valid after edits that only change destinations, e.g. page
 * deletions), else the authored `open` flags.
 */
export function expansionFor(
  documentId: DocumentId,
  outline: readonly OutlineNode[],
  latest: ReadonlySet<string> | undefined = useOutlineViewStore.getState().expanded[documentId],
): ReadonlySet<string> {
  const known = bySnapshot.get(outline) ?? latest;
  if (known !== undefined) return known;
  const initial = initiallyExpanded(outline);
  bySnapshot.set(outline, initial);
  return initial;
}

export function setExpansion(
  documentId: DocumentId,
  outline: readonly OutlineNode[],
  expanded: ReadonlySet<string>,
): void {
  bySnapshot.set(outline, expanded);
  useOutlineViewStore.setState((s) => ({ expanded: { ...s.expanded, [documentId]: expanded } }));
}

export function setItemExpanded(
  documentId: DocumentId,
  outline: readonly OutlineNode[],
  key: string,
  open: boolean,
): void {
  const current = expansionFor(documentId, outline);
  if (current.has(key) === open) return;
  const next = new Set(current);
  if (open) next.add(key);
  else next.delete(key);
  setExpansion(documentId, outline, next);
}

export function setFocusedKey(documentId: DocumentId, key: string): void {
  if (useOutlineViewStore.getState().focused[documentId] === key) return;
  useOutlineViewStore.setState((s) => ({ focused: { ...s.focused, [documentId]: key } }));
}

export function startRenaming(documentId: DocumentId, key: string): void {
  setFocusedKey(documentId, key);
  useOutlineViewStore.setState({ renaming: { documentId, key } });
}

export function stopRenaming(): void {
  if (useOutlineViewStore.getState().renaming !== null) {
    useOutlineViewStore.setState({ renaming: null });
  }
}

/**
 * Carries the view state across edits (applied in order): expansion keys and the focused
 * key are remapped, and `reveal` (a path in the edited tree) gets its ancestors expanded
 * and the focus.
 */
export function followEdits(
  documentId: DocumentId,
  before: readonly OutlineNode[],
  after: readonly OutlineNode[],
  edits: readonly OutlineEdit[],
  reveal: OutlinePath | undefined,
): void {
  const remap = (path: OutlinePath): OutlinePath | undefined => {
    let current: OutlinePath | undefined = path;
    for (const edit of edits) {
      if (current === undefined) return undefined;
      current = remapOutlinePath(current, edit);
    }
    return current;
  };
  const next = new Set<string>();
  for (const key of expansionFor(documentId, before)) {
    const mapped = remap(pathOf(key));
    if (mapped !== undefined) next.add(keyOf(mapped));
  }
  if (reveal !== undefined) for (const key of ancestorKeys(reveal)) next.add(key);
  setExpansion(documentId, after, next);
  if (reveal !== undefined) {
    setFocusedKey(documentId, keyOf(reveal));
    return;
  }
  const focused = useOutlineViewStore.getState().focused[documentId];
  const mapped = focused === undefined ? undefined : remap(pathOf(focused));
  if (mapped !== undefined) setFocusedKey(documentId, keyOf(mapped));
}

/** Resets everything (tests). */
export function resetOutlineView(): void {
  useOutlineViewStore.setState({ expanded: {}, focused: {}, renaming: null });
}
