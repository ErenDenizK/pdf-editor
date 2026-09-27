/**
 * Page selection (light-table spec §2): a set of PageIds, the range anchor for Shift, and
 * the keyboard-focused page (roving tabindex in the grid). Pure helpers compute the next
 * selection from an ordered page list so they are testable without React.
 *
 * Selection may span documents and survives mode switches. Pages that leave the
 * workspace (delete, undo of an open) are pruned automatically, from the selection and
 * from the light table's page clipboard (Mod+X / Mod+C, spec §3).
 */
import type { PageId, Workspace } from '@pdf-editor/document-model';
import { create } from 'zustand';

import { useWorkspaceStore } from './workspace-store';

export interface SelectionSnapshot {
  readonly selected: ReadonlySet<PageId>;
  readonly anchor: PageId | null;
  readonly focused: PageId | null;
}

export interface ClickModifiers {
  readonly shift: boolean;
  /** Cmd on macOS, Ctrl elsewhere. */
  readonly mod: boolean;
}

export const EMPTY_SELECTION: SelectionSnapshot = {
  selected: new Set(),
  anchor: null,
  focused: null,
};

/** Pages between `from` and `to` (inclusive) in `order`; just `to` if `from` is absent. */
export function rangeBetween(order: readonly PageId[], from: PageId | null, to: PageId): PageId[] {
  const end = order.indexOf(to);
  if (end < 0) return [];
  const start = from === null ? -1 : order.indexOf(from);
  if (start < 0) return [to];
  const [lo, hi] = start <= end ? [start, end] : [end, start];
  return order.slice(lo, hi + 1);
}

/**
 * Click semantics: plain click selects one page; Mod toggles; Shift selects the range from
 * the anchor (Shift+Mod adds that range to the selection). The anchor moves on plain and Mod
 * clicks only, so repeated Shift clicks pivot around it.
 */
export function clickSelection(
  state: SelectionSnapshot,
  order: readonly PageId[],
  id: PageId,
  modifiers: ClickModifiers,
): SelectionSnapshot {
  if (modifiers.shift) {
    const anchor = state.anchor !== null && order.includes(state.anchor) ? state.anchor : null;
    const range = rangeBetween(order, anchor, id);
    const selected = modifiers.mod ? new Set([...state.selected, ...range]) : new Set(range);
    return { selected, anchor: anchor ?? id, focused: id };
  }
  if (modifiers.mod) {
    const selected = new Set(state.selected);
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    return { selected, anchor: id, focused: id };
  }
  return { selected: new Set([id]), anchor: id, focused: id };
}

/** Shift+Arrow: select the range from the anchor to `id` and focus it. */
export function extendSelection(
  state: SelectionSnapshot,
  order: readonly PageId[],
  id: PageId,
): SelectionSnapshot {
  const anchor =
    state.anchor !== null && order.includes(state.anchor) ? state.anchor : (state.focused ?? id);
  return { selected: new Set(rangeBetween(order, anchor, id)), anchor, focused: id };
}

/** Space: toggle the focused page. */
export function toggleSelection(state: SelectionSnapshot, id: PageId): SelectionSnapshot {
  return clickSelection(state, [id], id, { shift: false, mod: true });
}

export function selectAllOf(order: readonly PageId[], focused: PageId | null): SelectionSnapshot {
  return {
    selected: new Set(order),
    anchor: order[0] ?? null,
    focused: focused ?? order[0] ?? null,
  };
}

/**
 * Grid focus movement. Left/Right step through pages and wrap across row ends; Up/Down move
 * by a row (clamped); Home/End go to the first/last page. Returns the new index.
 */
export function moveFocusIndex(
  index: number,
  count: number,
  key: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End',
  columns: number,
): number {
  if (count <= 0) return -1;
  const cols = Math.max(1, columns);
  const current = index < 0 ? 0 : Math.min(index, count - 1);
  switch (key) {
    case 'ArrowLeft':
      return Math.max(0, current - 1);
    case 'ArrowRight':
      return Math.min(count - 1, current + 1);
    case 'ArrowUp':
      return current - cols >= 0 ? current - cols : current;
    case 'ArrowDown':
      return current + cols < count ? current + cols : current;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
  }
}

/**
 * Marquee selection (spec §2): the pages under the rectangle, added to `base` when the
 * marquee is additive (Shift or Mod held at press). Focus and anchor move to the first hit
 * so a following Shift+Click extends from where the marquee started.
 */
export function marqueeSelection(
  base: SelectionSnapshot,
  hits: readonly PageId[],
  additive: boolean,
): SelectionSnapshot {
  const selected = new Set(additive ? [...base.selected, ...hits] : hits);
  const first = hits[0];
  if (first === undefined) return { ...base, selected };
  return { selected, anchor: first, focused: first };
}

/** Same members, regardless of order. */
export function sameSelection(a: ReadonlySet<PageId>, b: ReadonlySet<PageId>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/** Drops ids for which `exists` is false; returns `state` itself when nothing changed. */
export function pruneSelection(
  state: SelectionSnapshot,
  exists: (id: PageId) => boolean,
): SelectionSnapshot {
  const selected = [...state.selected].filter(exists);
  const anchor = state.anchor !== null && exists(state.anchor) ? state.anchor : null;
  const focused = state.focused !== null && exists(state.focused) ? state.focused : null;
  if (
    selected.length === state.selected.size &&
    anchor === state.anchor &&
    focused === state.focused
  ) {
    return state;
  }
  return { selected: new Set(selected), anchor, focused };
}

/**
 * Pages cut (moved on paste) or copied (duplicated on paste) in the light table. This is
 * an in-app clipboard of page ids, not the system clipboard: pages are model objects.
 */
export interface PageClipboard {
  readonly pageIds: readonly PageId[];
  readonly mode: 'cut' | 'copy';
}

interface SelectionState extends SelectionSnapshot {
  readonly clipboard: PageClipboard | null;
  apply: (next: SelectionSnapshot) => void;
  clear: () => void;
  setFocused: (id: PageId | null) => void;
  setClipboard: (clipboard: PageClipboard | null) => void;
}

export const useSelectionStore = create<SelectionState>()((set) => ({
  ...EMPTY_SELECTION,
  clipboard: null,
  apply: (next) => set({ selected: next.selected, anchor: next.anchor, focused: next.focused }),
  clear: () => set((s) => (s.selected.size === 0 ? s : { selected: new Set(), anchor: null })),
  setFocused: (focused) => set({ focused }),
  setClipboard: (clipboard) => set({ clipboard }),
}));

/** Drops clipboard pages that no longer exist; null when none are left. */
export function pruneClipboard(
  clipboard: PageClipboard | null,
  exists: (id: PageId) => boolean,
): PageClipboard | null {
  if (clipboard === null) return null;
  const pageIds = clipboard.pageIds.filter(exists);
  if (pageIds.length === clipboard.pageIds.length) return clipboard;
  return pageIds.length === 0 ? null : { ...clipboard, pageIds };
}

export function selectionSnapshot(): SelectionSnapshot {
  const { selected, anchor, focused } = useSelectionStore.getState();
  return { selected, anchor, focused };
}

function pageExistsIn(ws: Workspace): (id: PageId) => boolean {
  const live = new Set<PageId>();
  for (const doc of Object.values(ws.documents)) for (const page of doc.pages) live.add(page.id);
  return (id) => live.has(id);
}

// Keep the selection consistent with the model (deletes, undo, closed tabs).
useWorkspaceStore.subscribe((state, previous) => {
  if (state.workspace === previous.workspace) return;
  const current = selectionSnapshot();
  const { clipboard } = useSelectionStore.getState();
  const empty = current.selected.size === 0 && current.anchor === null && current.focused === null;
  if (empty && clipboard === null) return;
  const exists = pageExistsIn(state.workspace);
  const next = pruneSelection(current, exists);
  if (next !== current) useSelectionStore.getState().apply(next);
  const nextClipboard = pruneClipboard(clipboard, exists);
  if (nextClipboard !== clipboard) useSelectionStore.getState().setClipboard(nextClipboard);
});
