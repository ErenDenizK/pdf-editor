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

import { partitionFiles } from '../files/open-files';
import { m } from '../i18n';
import { announce } from '../shell/announcer';
import {
  fromPhrase,
  insertPreparedImages,
  type PreparedImages,
  prepareImagePages,
} from '../stage/section-operations';
import { useSelectionStore } from '../state/selection-store';
import { useUiStore } from '../state/ui-store';
import {
  addLoadedSource,
  type LoadedSources,
  pagesPhrase,
  useWorkspaceStore,
} from '../state/workspace-store';

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
      ? m.history_duplicate_to({ pages: count, title })
      : m.history_duplicate_pages({ pages: count })
    : crossDocument
      ? m.history_move_to({ pages: count, title })
      : m.history_move_to_position({ pages: count, position });
  const announcement = transfer.duplicate
    ? m.announce_duplicated_to({ pages: count, position, title })
    : m.announce_moved_to({ pages: count, position, title });
  return {
    workspace: next,
    result: { pageIds: placed, position, label, announcement },
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
    () => result?.label ?? m.history_move({ count: transfer.pageIds.length }),
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

/**
 * OS files dropped on a section: PDFs (all their pages) and images (one page each) are
 * inserted at `target` in drop order, as one history entry ("Insert 4 pages from x.pdf").
 * The files are opened by the engine (and images decoded) in the operation's prelude, so
 * nothing reaches history until the whole insertion commits.
 */
export async function insertFilesAt(files: readonly File[], target: PageTarget): Promise<PageId[]> {
  if (files.length === 0) return [];
  const store = model();
  const { pdfs, images } = partitionFiles(files);
  let placed: PageId[] = [];
  let loadedSources: LoadedSources = { loaded: [], skipped: [] };
  let prepared: PreparedImages | undefined;
  let insertedFrom: string[] = [];
  let index = target.index;
  const committed = await store.applyComposed(
    async () => {
      const [loaded, preparedImages] = await Promise.all([
        store.loadSources(pdfs),
        images.length > 0 ? prepareImagePages(images) : Promise.resolve({ images: [], failed: [] }),
      ]);
      loadedSources = loaded;
      prepared = preparedImages;
      if (preparedImages === undefined) return undefined; // the size question was cancelled
      return loaded.loaded.length + preparedImages.images.length > 0
        ? { loaded, images: preparedImages }
        : undefined;
    },
    (ws, ids, { loaded, images: prepared }) => {
      const targetDoc = ws.documents[target.document];
      // The section went away while the files were opening: nothing to insert into.
      if (targetDoc === undefined) return ws;
      index = Math.min(target.index, targetDoc.pages.length);
      let next = ws;
      let at = index;
      const names: string[] = [];
      for (const file of files) {
        const source = loaded.loaded.find((l) => l.file === file)?.source;
        if (source !== undefined) {
          const added = addLoadedSource(next, source, ids);
          const pageIds = added.workspace.documents[added.documentId]?.pages.map((p) => p.id) ?? [];
          next = movePages(added.workspace, {
            pageIds,
            target: { document: targetDoc.id, index: at },
          });
          next = closeDocument(next, added.documentId);
          at += pageIds.length;
          names.push(source.name);
          continue;
        }
        const image = prepared.images.find((i) => i.file === file);
        if (image !== undefined) {
          next = insertPreparedImages(next, ids, targetDoc.id, at, [image]);
          at += 1;
          names.push(file.name);
        }
      }
      insertedFrom = names;
      placed = next.documents[targetDoc.id]?.pages.slice(index, at).map((p) => p.id) ?? [];
      return setActiveDocument(next, targetDoc.id);
    },
    () => m.history_insert_pages({ count: placed.length, from: fromPhrase(insertedFrom) }),
  );
  const skippedNames = [...loadedSources.skipped.map((s) => s.name), ...(prepared?.failed ?? [])];
  const skippedNote =
    skippedNames.length > 0 ? m.announce_skipped_files({ names: skippedNames.join(', ') }) : '';
  if (!committed) {
    if (skippedNote) announce(skippedNote);
    return [];
  }
  useSelectionStore.getState().apply({
    selected: new Set(placed),
    anchor: placed[0] ?? null,
    focused: placed[0] ?? null,
  });
  const title = model().workspace.documents[target.document]?.title ?? '';
  announce(
    [
      m.announce_inserted_pages({
        pages: pagesPhrase(placed.length),
        from: fromPhrase(insertedFrom),
        position: index + 1,
        title,
      }),
      skippedNote,
    ]
      .filter(Boolean)
      .join('. '),
  );
  return placed;
}

/** Shows a document as a light-table section (tab drop, "Show in Arrange"). */
export function showInArrange(documentId: PageTarget['document']): void {
  const ws = model().workspace;
  const doc = ws.documents[documentId];
  if (doc === undefined) return;
  useUiStore.getState().pinToArrange([documentId], ws.activeDocument);
  useUiStore.getState().setArrangeCollapsed(documentId, false);
  announce(m.announce_showing_in_arrange({ title: doc.title }));
}
