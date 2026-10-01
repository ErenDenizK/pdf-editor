/**
 * What Home's cards and buttons do (experience-redesign §3). Combining always goes through
 * the merge dialog, card drops included (§13 decision 2): nothing merges without it.
 */
import {
  closeDocument,
  type DocumentId,
  removeSourceIfUnreferenced,
  type SourceId,
} from '@pdf-editor/document-model';

import { enterCompare } from '../compare/compare-commands';
import { useCompareStore } from '../compare/compare-store';
import { m } from '../i18n';
import { announce } from '../shell/announcer';
import { openOperationDialog } from '../stage/operation-dialogs-store';
import { useUiStore } from '../state/ui-store';
import { useWorkspaceStore } from '../state/workspace-store';
import { liveSelection } from './home-model';

const ui = () => useUiStore.getState();
const model = () => useWorkspaceStore.getState();
const order = () => model().workspace.documentOrder;

/** Shows Home (`0`, the app glyph, the palette). */
export function showHome(): void {
  ui().setViewMode('home');
}

/** Selects cards on Home and says how many are selected. */
export function selectOnHome(ids: readonly DocumentId[], anchor?: DocumentId | null): void {
  ui().setHomeSelection(ids, anchor);
  announce(m.home_announce_selected({ count: ids.length }));
}

/**
 * After files were opened: Home with the new cards selected when they were dropped on an
 * empty workspace (two or more) or opened while Home is showing; one file opened from an
 * empty Home goes to Read.
 */
export function showOpened(
  ids: readonly DocumentId[],
  context: { readonly wasEmpty: boolean; readonly dropped: boolean },
): void {
  if (ids.length === 0) return;
  const onHome = ui().viewMode === 'home';
  if (context.wasEmpty && ids.length === 1) {
    if (onHome) ui().setViewMode('read');
    return;
  }
  if (onHome || (context.wasEmpty && context.dropped)) {
    ui().setViewMode('home');
    selectOnHome(ids);
  }
}

/** Opens a card: Read on that document's tab. */
export function openInRead(id: DocumentId): void {
  if (model().workspace.documents[id] === undefined) return;
  model().setActive(id);
  ui().setViewMode('read');
}

/** The merge dialog, pre-ordered: the selection, a card drop's pair, or every tab. */
export function combine(ids: readonly DocumentId[]): void {
  const live = liveSelection(order(), ids);
  if (live.length < 2) return;
  openOperationDialog({ kind: 'merge-all', order: live });
}

/** Compare with A and B chosen: the first and second selected cards. */
export async function compareOnHome(a: DocumentId, b: DocumentId): Promise<void> {
  if (a === b) return;
  const state = useCompareStore.getState();
  if (state.a !== a || state.b !== b) {
    // A kept comparison of another pair is released before the choices change.
    if (state.status !== 'setup') {
      await import('../compare/compare-runner').then((runner) => runner.releaseCompare());
    }
    useCompareStore.setState({ a, b });
  }
  enterCompare();
  announce(m.compare_mode_long());
}

/** Arrange with the selected documents shown (every document when none is selected). */
export function arrangeOnHome(selection: readonly DocumentId[]): void {
  const all = order();
  const selected = liveSelection(all, selection);
  const shown = selected.length > 0 ? selected : all;
  const first = shown[0];
  if (first === undefined) return;
  model().setActive(first);
  ui().pinToArrange(shown);
  if (selected.length > 0) {
    for (const id of all) if (!shown.includes(id)) ui().hideFromArrange(id);
  }
  ui().setViewMode('arrange');
}

/** Closes the selected documents as one undoable step. */
export function closeOnHome(selection: readonly DocumentId[]): void {
  const ids = liveSelection(order(), selection);
  if (ids.length === 0) return;
  const ws = model().workspace;
  const names = ids.map((id) => ws.documents[id]?.title ?? '');
  const label =
    ids.length === 1
      ? m.history_close({ name: names[0] ?? '' })
      : m.home_history_close({ count: ids.length });
  const closed = model().applyOperation((current) => {
    let next = current;
    const sources = new Set<SourceId>();
    for (const id of ids) {
      for (const page of next.documents[id]?.pages ?? []) {
        if (page.ref.kind === 'source') sources.add(page.ref.source);
      }
      next = closeDocument(next, id);
    }
    for (const source of sources) next = removeSourceIfUnreferenced(next, source);
    return next;
  }, label);
  if (!closed) return;
  ui().setHomeSelection([], null);
  announce(
    ids.length === 1
      ? m.announce_closed({ name: names[0] ?? '' })
      : m.home_announce_closed({ count: ids.length }),
  );
}
