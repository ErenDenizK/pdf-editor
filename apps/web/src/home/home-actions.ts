/**
 * What Home's cards and buttons do (experience-redesign §3), and how the shell moves between
 * Home and a document (ADR-0019 §1–§2). Combining always goes through the merge dialog, card
 * drops included (§13 decision 2): nothing merges without it. Combining keeps the files open
 * and makes a new document of them (review F8).
 */
import {
  closeDocument,
  type DocumentId,
  removeSourceIfUnreferenced,
  type SourceId,
} from '@pdf-editor/document-model';

import { noteReopenedFrom, openDocuments } from '../commands/app-commands';
import { enterCompare } from '../compare/compare-commands';
import { useCompareStore } from '../compare/compare-store';
import { pickFiles, rememberFileHandle } from '../files/open-files';
import {
  canReopenRecent,
  type RecentEntry,
  removeRecent,
  reopenRecent,
  setRecentNote,
  useRecentsStore,
} from '../files/recents';
import { m } from '../i18n';
import { announce } from '../shell/announcer';
import { openOperationDialog } from '../stage/operation-dialogs-store';
import { mergeAll } from '../stage/section-operations';
import { type DocumentMode, useUiStore } from '../state/ui-store';
import { useWorkspaceStore } from '../state/workspace-store';
import { showCombinedToast } from './combined-toast';
import { liveSelection } from './home-model';

const ui = () => useUiStore.getState();
const model = () => useWorkspaceStore.getState();
const order = () => model().workspace.documentOrder;

/** Shows Home (`0`, the app glyph, the palette, "Show Home"). */
export function showHome(): void {
  ui().showHome();
}

/**
 * Makes a document the active tab (its tab, its Files row). On Home this leaves Home for the
 * document in the view and mode it was last shown in (ADR-0019 §1); elsewhere the view stays.
 */
export function showTab(id: DocumentId): void {
  if (model().workspace.documents[id] === undefined) return;
  model().setActive(id);
  if (ui().destination === 'home') ui().showDocument(id);
}

/**
 * Read (locked) or Edit for the active document (`1`, `2`, the mode control): the page view
 * in both, so switching never moves the page (ADR-0019 §2). Announced.
 */
export function showDocumentMode(mode: DocumentMode): void {
  const id = model().workspace.activeDocument;
  if (id === undefined) return;
  ui().setDocumentMode(id, mode);
  ui().setViewMode('read');
  announce(mode === 'read' ? m.read_locked_announce() : m.mode_edit_long());
}

/**
 * Keeps the shell in step with the open documents: remembers the view each document is
 * shown in (for leaving Home by its tab) and, once the last document closes, starts over as
 * on a fresh start, so Home's empty state shows and the next file opens in Read.
 */
export function watchDestination(): () => void {
  const remember = () => {
    const state = ui();
    const id = model().workspace.activeDocument;
    // Compare is entered with its own command; a tab click never lands in it.
    if (state.destination !== 'document' || id === undefined || state.viewMode === 'compare') {
      return;
    }
    state.rememberView(id, state.viewMode);
  };
  const offUi = useUiStore.subscribe((state, previous) => {
    if (state.viewMode !== previous.viewMode || state.destination !== previous.destination) {
      remember();
    }
  });
  const offWorkspace = useWorkspaceStore.subscribe((state, previous) => {
    if (state.workspace === previous.workspace) return;
    if (state.workspace.documentOrder.length === 0) {
      if (previous.workspace.documentOrder.length > 0) {
        useUiStore.setState({
          destination: 'document',
          viewMode: 'read',
          documentMode: {},
          lastView: {},
        });
      }
      return;
    }
    if (state.workspace.activeDocument !== previous.workspace.activeDocument) remember();
  });
  return () => {
    offUi();
    offWorkspace();
  };
}

/** Selects cards on Home and says how many are selected. */
export function selectOnHome(ids: readonly DocumentId[], anchor?: DocumentId | null): void {
  ui().setHomeSelection(ids, anchor);
  announce(m.home_announce_selected({ count: ids.length }));
}

/**
 * After files were opened, dropped or picked alike ("Open files", the palette, the menu):
 * Home with the new cards selected when two or more arrive on an empty workspace or any
 * arrive while Home is showing; one file opened on an empty workspace goes to Read.
 */
export function showOpened(
  ids: readonly DocumentId[],
  context: { readonly wasEmpty: boolean },
): void {
  if (ids.length === 0) return;
  const onHome = ui().destination === 'home';
  if (context.wasEmpty && ids.length === 1) {
    if (onHome) ui().setViewMode('read');
    return;
  }
  if (onHome || context.wasEmpty) {
    ui().showHome();
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

/**
 * The Combine dialog's confirm (review F8): a new document of the files in `ids`, in that
 * order, titled `title` ("Combined – A + B" by default); the files stay open. One history
 * entry, announced with its undo shortcut and shown as "Combined 2 files · Undo".
 */
export function combineInto(ids: readonly DocumentId[], title: string): DocumentId | undefined {
  const created = mergeAll(ids, title, { keepSources: true });
  if (created !== undefined) showCombinedToast(ids.length);
  return created;
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

/** Opens what a Recents reopen produced: one file goes straight to Read, several to Home. */
async function openFromRecents(files: readonly File[]): Promise<boolean> {
  const wasEmpty = order().length === 0;
  const ids = await openDocuments(files);
  const [only] = ids;
  if (only !== undefined && ids.length === 1) openInRead(only);
  else showOpened(ids, { wasEmpty });
  return ids.length > 0;
}

/**
 * A Recents row (click, Enter): reopens the file through its handle, asking for read
 * permission within the click where the browser needs it. Without a handle, or when the
 * handle fails (permission denied, file moved), the row turns to "Open again…" and says so
 * in one line; "Open again…" opens the file dialog. Call it straight from the event, with no
 * await before it, so the permission request keeps the click's user activation.
 */
export async function openRecent(entry: RecentEntry): Promise<void> {
  const access = useRecentsStore.getState().access[entry.id];
  if (!canReopenRecent(entry) || access === 'unavailable') {
    await openRecentAgain(entry);
    return;
  }
  const result = await reopenRecent(entry);
  if (!result.ok) {
    setRecentNote({ id: entry.id, name: entry.name, kind: 'unavailable' });
    announce(m.recents_note_unavailable({ name: entry.name }));
    return;
  }
  setRecentNote(null);
  rememberFileHandle(result.file, result.handle);
  noteReopenedFrom(result.file, entry.id);
  await openFromRecents([result.file]);
}

/** "Open again…": the file dialog, with one line saying why it opened. */
export async function openRecentAgain(entry: RecentEntry): Promise<void> {
  const note = { id: entry.id, name: entry.name, kind: 'open-again' } as const;
  // The dialog opens first, within the click's user activation; the note follows at once.
  const picking = pickFiles('openable');
  setRecentNote(note);
  announce(m.recents_note_open_again({ name: entry.name }));
  const files = await picking;
  if (files.length === 0) return;
  for (const file of files) {
    if (file.name === entry.name) noteReopenedFrom(file, entry.id);
  }
  if (await openFromRecents(files)) {
    if (useRecentsStore.getState().note === note) setRecentNote(null);
  }
}

/** "Remove from recents" and Delete on a row. */
export function removeRecentEntry(entry: RecentEntry): void {
  void removeRecent(entry.id);
  announce(m.recents_announce_removed({ name: entry.name }));
}
