/**
 * Light-table page actions (spec §3 keyboard alternative, §4 contextual bar and context
 * menu). Pure planners (exported for tests) plus thin store-bound actions that commit one
 * history entry each and announce the outcome.
 */
import {
  type DocumentId,
  findPageLocation,
  insertBlankPage,
  movePages,
  newEmptyDocument,
  type PageId,
  type PageTarget,
  type SourceId,
  type VirtualDocument,
  type Workspace,
} from '@pdf-editor/document-model';

import { targetPages } from '../commands/app-commands';
import { currentPlatform } from '../commands/shortcuts';
import { inDocumentOrder, transferPages } from '../dnd/drop';
import { announce } from '../shell/announcer';
import { type PageClipboard, useSelectionStore } from '../state/selection-store';
import { useUiStore } from '../state/ui-store';
import { pagesPhrase, useWorkspaceStore } from '../state/workspace-store';

const model = () => useWorkspaceStore.getState();
const selection = () => useSelectionStore.getState();

function select(ids: readonly PageId[], focus: PageId | null = ids[0] ?? null): void {
  selection().apply({ selected: new Set(ids), anchor: ids[0] ?? null, focused: focus });
}

// ---------------------------------------------------------------------------
// Pure planners
// ---------------------------------------------------------------------------

/**
 * Where a paste lands: right after the focused page, in the focused page's document (also
 * across documents). With no focused page, at the end of `fallback`.
 */
export function pasteTarget(
  ws: Workspace,
  focused: PageId | null,
  fallback: DocumentId | undefined,
): PageTarget | undefined {
  const location = focused === null ? undefined : findPageLocation(ws, focused);
  if (location !== undefined) return { document: location.document, index: location.index + 1 };
  const doc = fallback === undefined ? undefined : ws.documents[fallback];
  return doc === undefined ? undefined : { document: doc.id, index: doc.pages.length };
}

/**
 * Paste semantics: a cut clipboard moves its pages (and is consumed); a copied clipboard,
 * or Mod+Shift+V, duplicates them at the target and stays available for another paste.
 */
export function planPaste(
  clipboard: PageClipboard | null,
  asDuplicate: boolean,
): { readonly duplicate: boolean; readonly consume: boolean } | undefined {
  if (clipboard === null || clipboard.pageIds.length === 0) return undefined;
  const duplicate = asDuplicate || clipboard.mode === 'copy';
  return { duplicate, consume: !duplicate };
}

export type MoveEdge = 'row-start' | 'row-end' | 'section-start' | 'section-end';

/**
 * Alt+Shift+Arrow: the insertion index that moves the selected pages of `doc` to the
 * start or end of the row of the first (start) or last (end) selected page, or of the
 * whole section. Undefined when none of the pages are in `doc`.
 */
export function edgeTarget(
  doc: VirtualDocument,
  pageIds: ReadonlySet<PageId>,
  edge: MoveEdge,
  columns: number,
): number | undefined {
  const indices = doc.pages.flatMap((p, i) => (pageIds.has(p.id) ? [i] : []));
  const first = indices[0];
  const last = indices[indices.length - 1];
  if (first === undefined || last === undefined) return undefined;
  const cols = Math.max(1, columns);
  switch (edge) {
    case 'section-start':
      return 0;
    case 'section-end':
      return doc.pages.length;
    case 'row-start':
      return Math.floor(first / cols) * cols;
    case 'row-end':
      return Math.min(doc.pages.length, (Math.floor(last / cols) + 1) * cols);
  }
}

/**
 * Brings a document into `order` (a permutation of its page ids) with `movePages` calls,
 * left to right: once positions before p are final, the page wanted at p sits at p or
 * later, so a pre-removal move to gap p places it without disturbing what is done.
 */
export function reorderDocument(
  ws: Workspace,
  documentId: DocumentId,
  order: readonly PageId[],
): Workspace {
  let next = ws;
  order.forEach((id, position) => {
    if (next.documents[documentId]?.pages[position]?.id === id) return;
    next = movePages(next, { pageIds: [id], target: { document: documentId, index: position } });
  });
  return next;
}

/**
 * Reverses the order of the given pages within each document: the selected slots stay
 * where they are and receive the pages in reverse order; other pages do not move. The
 * model has no permutation operation, so this composes `movePages` (one history entry).
 */
export function reverseOrder(ws: Workspace, pageIds: Iterable<PageId>): Workspace {
  const wanted = new Set(pageIds);
  let next = ws;
  for (const docId of ws.documentOrder) {
    const doc = ws.documents[docId];
    if (doc === undefined) continue;
    const slots = doc.pages.flatMap((p, i) => (wanted.has(p.id) ? [i] : []));
    if (slots.length < 2) continue;
    const reversed = slots.map((i) => doc.pages[i]?.id).reverse();
    const order = doc.pages.map((page) => page.id);
    slots.forEach((slot, j) => {
      const id = reversed[j];
      if (id !== undefined) order[slot] = id;
    });
    next = reorderDocument(next, docId, order);
  }
  return next;
}

/** 1-based odd or even positions of a document. */
export function parityPages(doc: VirtualDocument, parity: 'odd' | 'even'): PageId[] {
  return doc.pages.filter((_, i) => (i % 2 === 0) === (parity === 'odd')).map((p) => p.id);
}

/** Pages of the given documents that show a page of `source`, in section order. */
export function pagesFromSource(
  ws: Workspace,
  documents: readonly DocumentId[],
  source: SourceId,
): PageId[] {
  return documents.flatMap(
    (id) =>
      ws.documents[id]?.pages
        .filter((p) => p.ref.kind === 'source' && p.ref.source === source)
        .map((p) => p.id) ?? [],
  );
}

// ---------------------------------------------------------------------------
// Store-bound actions
// ---------------------------------------------------------------------------

export function cutPages(): boolean {
  const pageIds = targetPages();
  if (pageIds.length === 0) return false;
  selection().setClipboard({ pageIds, mode: 'cut' });
  announce(`Cut ${pagesPhrase(pageIds.length)}. Paste after a page with ${modName()} V`);
  return true;
}

export function copyPages(): boolean {
  const pageIds = targetPages();
  if (pageIds.length === 0) return false;
  selection().setClipboard({ pageIds, mode: 'copy' });
  announce(`Copied ${pagesPhrase(pageIds.length)}`);
  return true;
}

export function pastePages(asDuplicate: boolean): boolean {
  const { clipboard, focused } = selection();
  const plan = planPaste(clipboard, asDuplicate);
  if (plan === undefined || clipboard === null) return false;
  const ws = model().workspace;
  const target = pasteTarget(ws, focused, ws.activeDocument);
  if (target === undefined) return false;
  const result = transferPages({
    pageIds: clipboard.pageIds,
    target,
    duplicate: plan.duplicate,
  });
  if (result === undefined) return false;
  if (plan.consume) selection().setClipboard(null);
  return true;
}

/** Alt+Shift+Arrow. Keyboard moves coalesce with Alt+Arrow moves into one undo step. */
export function movePagesToEdge(edge: MoveEdge, columns: number): boolean {
  const ws = model().workspace;
  const pages = targetPages();
  const first = pages[0];
  const location = first === undefined ? undefined : findPageLocation(ws, first);
  const doc = location === undefined ? undefined : ws.documents[location.document];
  if (doc === undefined) return false;
  const inDoc = pages.filter((id) => findPageLocation(ws, id)?.document === doc.id);
  const index = edgeTarget(doc, new Set(inDoc), edge, columns);
  if (index === undefined) return false;
  return (
    transferPages({
      pageIds: inDoc,
      target: { document: doc.id, index },
      duplicate: false,
      coalesceKey: `move:${[...inDoc].sort().join(',')}`,
    }) !== undefined
  );
}

/** "Move to…": appends the target pages to another document and shows it. */
export function movePagesToDocument(documentId: DocumentId): boolean {
  const ws = model().workspace;
  const doc = ws.documents[documentId];
  const pageIds = targetPages();
  if (doc === undefined || pageIds.length === 0) return false;
  useUiStore.getState().pinToArrange([documentId], ws.activeDocument);
  return (
    transferPages({
      pageIds,
      target: { document: documentId, index: doc.pages.length },
      duplicate: false,
    }) !== undefined
  );
}

/**
 * "Extract to new document": moves the target pages (from one or several documents) into
 * a new document placed after the first one's tab. The model's `splitDocument` only splits
 * one document into contiguous parts, so extraction is `newEmptyDocument` + `movePages`.
 */
export function extractPages(): boolean {
  const ws = model().workspace;
  const pageIds = inDocumentOrder(ws, targetPages());
  const first = pageIds[0];
  const location = first === undefined ? undefined : findPageLocation(ws, first);
  const source = location === undefined ? undefined : ws.documents[location.document];
  if (source === undefined) return false;
  const previousActive = ws.activeDocument;
  let created: DocumentId | undefined;
  const title = `${source.title} (extract)`;
  const committed = model().applyOperation(
    (current, ids) => {
      const { workspace, documentId } = newEmptyDocument(current, ids, {
        title,
        index: current.documentOrder.indexOf(source.id) + 1,
      });
      created = documentId;
      return movePages(workspace, { pageIds, target: { document: documentId, index: 0 } });
    },
    `Extract ${pagesPhrase(pageIds.length)}`,
  );
  if (!committed || created === undefined) return false;
  useUiStore.getState().pinToArrange([created], previousActive);
  select(pageIds);
  announce(`Extracted ${pagesPhrase(pageIds.length)} to ${title}`);
  return true;
}

/** Inserts one blank page after the focused (else last) target page. */
export function insertBlankAfter(): boolean {
  const ws = model().workspace;
  const pages = targetPages();
  const { focused } = selection();
  const anchor = focused !== null && pages.includes(focused) ? focused : pages[pages.length - 1];
  const location = anchor === undefined ? undefined : findPageLocation(ws, anchor);
  if (location === undefined) return false;
  const target = { document: location.document, index: location.index + 1 };
  const committed = model().applyOperation(
    (current, ids) => insertBlankPage(current, target, ids),
    'Insert blank page',
  );
  if (!committed) return false;
  const inserted = model().workspace.documents[target.document]?.pages[target.index]?.id;
  if (inserted !== undefined) select([inserted]);
  const title = model().workspace.documents[target.document]?.title ?? '';
  announce(`Inserted a blank page at position ${target.index + 1} in ${title}`);
  return true;
}

export function reverseSelectedPages(): boolean {
  const pageIds = targetPages();
  if (pageIds.length < 2) return false;
  const committed = model().applyOperation(
    (ws) => reverseOrder(ws, pageIds),
    `Reverse order of ${pagesPhrase(pageIds.length)}`,
  );
  if (committed) announce(`Reversed the order of ${pagesPhrase(pageIds.length)}`);
  return committed;
}

export function selectFromSource(pageId: PageId, documents: readonly DocumentId[]): boolean {
  const ws = model().workspace;
  const location = findPageLocation(ws, pageId);
  const page =
    location === undefined ? undefined : ws.documents[location.document]?.pages[location.index];
  if (page?.ref.kind !== 'source') return false;
  const ids = pagesFromSource(ws, documents, page.ref.source);
  select(ids, pageId);
  const name = ws.sources[page.ref.source]?.name ?? 'this file';
  announce(`Selected ${pagesPhrase(ids.length)} from ${name}`);
  return true;
}

export function selectParity(documentId: DocumentId, parity: 'odd' | 'even'): boolean {
  const doc = model().workspace.documents[documentId];
  if (doc === undefined) return false;
  const ids = parityPages(doc, parity);
  select(ids);
  announce(`Selected ${pagesPhrase(ids.length)}, ${parity} positions in ${doc.title}`);
  return true;
}

function modName(): string {
  return currentPlatform === 'mac' ? 'Command' : 'Control';
}
