/**
 * What a completed drop (or its keyboard equivalent) does to the model. Every function
 * here commits exactly one history entry with a readable label, announces the result in
 * the live region, and leaves the moved (or new) pages selected and focused.
 *
 * Kept free of DOM and drag-library details so the same code serves pointer drops, cut
 * and paste, "Move to…" and tests.
 */
import {
  closeDocument,
  duplicatePages,
  findPageLocation,
  movePages,
  type PageId,
  type PageTarget,
  setActiveDocument,
  type Workspace,
} from '@pdf-editor/document-model';

import { announce } from '../shell/announcer';
import { useSelectionStore } from '../state/selection-store';
import { useUiStore } from '../state/ui-store';
import { pagesPhrase, useWorkspaceStore } from '../state/workspace-store';

const model = () => useWorkspaceStore.getState();

/** Page ids in tab order, then page order (the order moves keep). */
export function inDocumentOrder(ws: Workspace, ids: Iterable<PageId>): PageId[] {
  const wanted = new Set(ids);
  const ordered: PageId[] = [];
  for (const docId of ws.documentOrder) {
    for (const page of ws.documents[docId]?.pages ?? []) {
      if (wanted.has(page.id)) ordered.push(page.id);
    }
  }
  return ordered;
}

export interface PageTransfer {
  readonly pageIds: readonly PageId[];
  readonly target: PageTarget;
  /** Alt on drop, Mod+Shift+V, a copied clipboard: duplicate at the target instead. */
  readonly duplicate: boolean;
  /** Keyboard moves coalesce into one undo step within 800 ms. */
  readonly coalesceKey?: string;
}

export interface TransferResult {
  /** Pages at their destination (the originals for a move, the copies for a duplicate). */
  readonly pageIds: readonly PageId[];
  /** 1-based position of the first page in the target document. */
  readonly position: number;
  readonly label: string;
  readonly announcement: string;
}

/**
 * Applies a move or duplicate to a workspace without committing it. Returns undefined for
 * a no-op (dropping pages back where they are) or invalid input.
 */
export function planTransfer(
  ws: Workspace,
  transfer: PageTransfer,
  ids: Parameters<typeof duplicatePages>[2],
): { readonly workspace: Workspace; readonly result: TransferResult } | undefined {
  const targetDoc = ws.documents[transfer.target.document];
  if (targetDoc === undefined) return undefined;
  const pageIds = inDocumentOrder(ws, transfer.pageIds);
  if (pageIds.length === 0) return undefined;
  const index = Math.min(Math.max(0, transfer.target.index), targetDoc.pages.length);
  const target = { document: targetDoc.id, index };
  const count = pagesPhrase(pageIds.length);
  const crossDocument = pageIds.some((id) => findPageLocation(ws, id)?.document !== targetDoc.id);

  let next: Workspace;
  let placed: PageId[];
  if (transfer.duplicate) {
    next = duplicatePages(ws, pageIds, ids, { target });
    const pages = next.documents[targetDoc.id]?.pages ?? [];
    placed = pages.slice(index, index + pageIds.length).map((p) => p.id);
  } else {
    next = movePages(ws, { pageIds, target });
    placed = pageIds;
  }
  if (next === ws) return undefined;
  const first = placed[0];
  const position = first === undefined ? 1 : (findPageLocation(next, first)?.index ?? 0) + 1;
  const title = targetDoc.title;
  const label = transfer.duplicate
    ? crossDocument
      ? `Duplicate ${count} to ${title}`
      : `Duplicate ${count}`
    : crossDocument
      ? `Move ${count} to ${title}`
      : `Move ${count} to position ${position}`;
  const verb = transfer.duplicate ? 'Duplicated' : 'Moved';
  return {
    workspace: next,
    result: {
      pageIds: placed,
      position,
      label,
      announcement: `${verb} ${count} to position ${position} in ${title}`,
    },
  };
}

/**
 * Commits a move or duplicate (drop, paste, "Move to…", keyboard edge moves) as one
 * history entry. The target document becomes active and the placed pages selected.
 */
export function transferPages(transfer: PageTransfer): TransferResult | undefined {
  performance.mark('light-table:transfer');
  let result: TransferResult | undefined;
  const store = model();
  const committed = store.applyOperation(
    (ws, ids) => {
      const plan = planTransfer(ws, transfer, ids);
      if (plan === undefined) return ws;
      result = plan.result;
      return setActiveDocument(plan.workspace, transfer.target.document);
    },
    () => result?.label ?? 'Move pages',
    transfer.coalesceKey === undefined ? {} : { coalesceKey: transfer.coalesceKey },
  );
  if (!committed || result === undefined) return undefined;
  const placed = result.pageIds;
  useSelectionStore.getState().apply({
    selected: new Set(placed),
    anchor: placed[0] ?? null,
    focused: placed[0] ?? null,
  });
  announce(result.announcement);
  performance.measure('light-table:transfer-commit', 'light-table:transfer');
  // Upper bound for "drop to painted": two frames later the re-render has been painted.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      performance.measure('light-table:transfer-paint', 'light-table:transfer');
    }),
  );
  return result;
}

/** Opens files and inserts all their pages at `target` (OS files dropped on a section). */
export async function insertFilesAt(files: readonly File[], target: PageTarget): Promise<PageId[]> {
  if (files.length === 0) return [];
  const store = model();
  const { opened, skipped } = await store.openFiles(files);
  const before = model().workspace;
  const openedDocs = opened.map((o) => o.documentId).filter((id) => before.documents[id]);
  const pageIds = openedDocs.flatMap((id) => before.documents[id]?.pages.map((p) => p.id) ?? []);
  const skippedNote =
    skipped.length > 0 ? `. Skipped ${skipped.map((s) => s.name).join(', ')}` : '';
  const targetDoc = before.documents[target.document];
  if (targetDoc === undefined || pageIds.length === 0) {
    // The section went away while the files were opening: they stay as new documents.
    if (opened.length > 0) announce(`Opened ${opened.length} files${skippedNote}`);
    else if (skipped.length > 0) announce(`Skipped ${skipped.map((s) => s.name).join(', ')}`);
    return [];
  }
  const index = Math.min(target.index, targetDoc.pages.length);
  const from = opened.length === 1 ? (opened[0]?.name ?? 'file') : `${opened.length} files`;
  const label = `Insert ${pagesPhrase(pageIds.length)} from ${from}`;
  const committed = model().applyOperation((ws) => {
    let next = movePages(ws, { pageIds, target: { document: targetDoc.id, index } });
    for (const id of openedDocs) next = closeDocument(next, id);
    return setActiveDocument(next, targetDoc.id);
  }, label);
  if (!committed) return [];
  useSelectionStore.getState().apply({
    selected: new Set(pageIds),
    anchor: pageIds[0] ?? null,
    focused: pageIds[0] ?? null,
  });
  announce(
    `Inserted ${pagesPhrase(pageIds.length)} from ${from} at position ${index + 1} in ${targetDoc.title}${skippedNote}`,
  );
  return pageIds;
}

/** Shows a document as a light-table section (tab drop, "Show in Arrange"). */
export function showInArrange(documentId: PageTarget['document']): void {
  const ws = model().workspace;
  const doc = ws.documents[documentId];
  if (doc === undefined) return;
  useUiStore.getState().pinToArrange([documentId], ws.activeDocument);
  useUiStore.getState().setArrangeCollapsed(documentId, false);
  announce(`Showing ${doc.title} in Arrange`);
}
