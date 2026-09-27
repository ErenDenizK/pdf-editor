/**
 * Section operations (light-table spec §5) bound to the stores: split, merge into, merge
 * all, interleave, rename, copy to a new document and images as pages. Each commits one
 * history entry with a readable label, keeps the result visible in Arrange when its inputs
 * were, and announces the outcome. The dialogs and commands call these; the math lives in
 * `operation-plans.ts`.
 */
import {
  type BlobId,
  type DocumentId,
  documentTitleFromName,
  duplicatePages,
  type InterleaveMode,
  insertImagePage,
  interleave,
  mergeDocuments,
  newEmptyDocument,
  type PageId,
  renameDocument,
  type Size,
  type SplitSpec,
  splitDocument,
  splitPartSizes,
  type Workspace,
} from '@pdf-editor/document-model';

import { targetPages } from '../commands/app-commands';
import { inDocumentOrder } from '../dnd/drop';
import {
  decodeImageFile,
  imagePageSize,
  type ImageSizing,
  shouldAskImageSizing,
} from '../files/images';
import { m } from '../i18n';
import { announce } from '../shell/announcer';
import { useSelectionStore } from '../state/selection-store';
import { useUiStore } from '../state/ui-store';
import { pagesPhrase, type StoredBlob, useWorkspaceStore } from '../state/workspace-store';
import { askImageSizing } from './operation-dialogs-store';
import { type TitleProblem, validateTitle } from './operation-plans';

const model = () => useWorkspaceStore.getState();
const ui = () => useUiStore.getState();

/** Documents present after an operation that were not there before, in tab order. */
function createdDocuments(before: Workspace, after: Workspace): DocumentId[] {
  return after.documentOrder.filter((id) => before.documents[id] === undefined);
}

/** Whether any of the documents is on the light table (pinned, or the active tab). */
function isShown(inputs: readonly DocumentId[]): boolean {
  const { arrangePinned } = ui();
  const active = model().workspace.activeDocument;
  return inputs.some((id) => arrangePinned.includes(id) || id === active);
}

/**
 * Results of an operation stay on the light table when any input was shown there. Pins of
 * consumed inputs are left in place: undo brings those documents back as they were shown.
 */
function keepShown(wasShown: boolean, results: readonly DocumentId[]): void {
  if (wasShown && results.length > 0) ui().pinToArrange(results);
}

export function titleProblemMessage(problem: TitleProblem): string {
  switch (problem) {
    case 'empty':
      return m.title_error_empty();
    case 'too-long':
      return m.title_error_too_long({ max: 200 });
    case 'control':
      return m.title_error_control();
  }
}

// ---------------------------------------------------------------------------
// Split
// ---------------------------------------------------------------------------

/** Localized default part titles: "Report (1 of 3)". */
export function defaultPartTitles(title: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) =>
    m.split_part_title({ title, index: i + 1, count }),
  );
}

/**
 * Splits a document. `titles` name the parts (missing ones get "<title> (k of n)"). The
 * parts open as tabs (the first becomes active) in one history entry.
 */
export function splitSection(
  documentId: DocumentId,
  spec: SplitSpec,
  titles?: readonly (string | undefined)[],
): DocumentId[] {
  const before = model().workspace;
  const doc = before.documents[documentId];
  if (doc === undefined) return [];
  let created: DocumentId[] = [];
  const shown = isShown([documentId]);
  const committed = model().applyOperation(
    (ws, ids) => {
      const count = splitPartSizes(ws, documentId, spec).length;
      const defaults = defaultPartTitles(doc.title, count);
      const named = defaults.map((fallback, i) => titles?.[i] ?? fallback);
      const next = splitDocument(ws, documentId, spec, ids, { titles: named });
      created = createdDocuments(ws, next);
      return next;
    },
    () => m.history_split({ title: doc.title, count: created.length }),
  );
  if (!committed) return [];
  const remaining = model().workspace.documents[documentId] !== undefined;
  keepShown(shown, remaining ? [documentId, ...created] : created);
  announce(m.announce_split({ title: doc.title, count: created.length }));
  return created;
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/** "Merge into…": appends `sourceId`'s pages to `targetId` (the result keeps its title). */
export function mergeInto(sourceId: DocumentId, targetId: DocumentId): DocumentId | undefined {
  const ws = model().workspace;
  const source = ws.documents[sourceId];
  const target = ws.documents[targetId];
  if (source === undefined || target === undefined || sourceId === targetId) return undefined;
  let created: DocumentId | undefined;
  const shown = isShown([sourceId, targetId]);
  const committed = model().applyOperation(
    (current, ids) => {
      const next = mergeDocuments(
        current,
        { documentIds: [targetId, sourceId], title: target.title },
        ids,
      );
      created = next.activeDocument;
      return next;
    },
    m.history_merge_into({ source: source.title, target: target.title }),
  );
  if (!committed || created === undefined) return undefined;
  keepShown(shown, [created]);
  announce(
    m.announce_merged_into({
      pages: pagesPhrase(source.pages.length),
      source: source.title,
      target: target.title,
    }),
  );
  return created;
}

/** "Merge all open documents": concatenates `order` into one document titled `title`. */
export function mergeAll(order: readonly DocumentId[], title: string): DocumentId | undefined {
  const checked = validateTitle(title);
  if (!checked.ok || order.length < 2) return undefined;
  let created: DocumentId | undefined;
  const shown = isShown(order);
  const committed = model().applyOperation(
    (ws, ids) => {
      const next = mergeDocuments(ws, { documentIds: order, title: checked.title }, ids);
      created = next.activeDocument;
      return next;
    },
    m.history_merge_all({ count: order.length }),
  );
  if (!committed || created === undefined) return undefined;
  keepShown(shown, [created]);
  announce(m.announce_merged_all({ count: order.length, title: checked.title }));
  return created;
}

// ---------------------------------------------------------------------------
// Interleave
// ---------------------------------------------------------------------------

export function interleaveWith(
  a: DocumentId,
  b: DocumentId,
  mode: InterleaveMode,
): DocumentId | undefined {
  const ws = model().workspace;
  const first = ws.documents[a];
  const second = ws.documents[b];
  if (first === undefined || second === undefined || a === b) return undefined;
  let created: DocumentId | undefined;
  const shown = isShown([a, b]);
  const committed = model().applyOperation(
    (current, ids) => {
      const next = interleave(current, { a, b, mode }, ids);
      created = next.activeDocument;
      return next;
    },
    m.history_interleave({ a: first.title, b: second.title }),
  );
  if (!committed || created === undefined) return undefined;
  keepShown(shown, [created]);
  announce(
    m.announce_interleaved({
      a: first.title,
      b: second.title,
      pages: pagesPhrase(first.pages.length + second.pages.length),
    }),
  );
  return created;
}

// ---------------------------------------------------------------------------
// Rename
// ---------------------------------------------------------------------------

/** Renames a document; returns the problem when the title is not acceptable. */
export function renameDocumentTo(
  documentId: DocumentId,
  raw: string,
):
  | { readonly ok: true; readonly changed: boolean }
  | { readonly ok: false; readonly problem: TitleProblem } {
  const checked = validateTitle(raw);
  if (!checked.ok) return checked;
  const doc = model().workspace.documents[documentId];
  if (doc === undefined) return { ok: true, changed: false };
  const changed = model().applyOperation(
    (ws) => renameDocument(ws, documentId, checked.title),
    m.history_rename({ title: checked.title }),
  );
  if (changed) announce(m.announce_renamed({ title: checked.title }));
  return { ok: true, changed };
}

/** Starts renaming in place: in the section header in Arrange mode, else in the tab. */
export function startRename(documentId: DocumentId, surface?: 'tab' | 'section'): void {
  const where =
    surface ??
    (ui().viewMode === 'arrange' &&
    (ui().arrangePinned.includes(documentId) || model().workspace.activeDocument === documentId)
      ? 'section'
      : 'tab');
  ui().setRenaming({ documentId, surface: where });
}

// ---------------------------------------------------------------------------
// Copy to new document
// ---------------------------------------------------------------------------

/**
 * "Copy to new document": duplicates the target pages (fresh ids, originals untouched)
 * into a new document after the first page's tab, as one history entry.
 */
export function copyPagesToNewDocument(): boolean {
  const ws = model().workspace;
  const pageIds = inDocumentOrder(ws, targetPages());
  const first = pageIds[0];
  const sourceDoc =
    first === undefined
      ? undefined
      : ws.documentOrder
          .map((id) => ws.documents[id])
          .find((doc) => doc?.pages.some((p) => p.id === first));
  if (sourceDoc === undefined) return false;
  const previousActive = ws.activeDocument;
  const title = m.copy_document_title({ title: sourceDoc.title });
  let created: DocumentId | undefined;
  const committed = model().applyOperation(
    (current, ids) => {
      const made = newEmptyDocument(current, ids, {
        title,
        index: current.documentOrder.indexOf(sourceDoc.id) + 1,
      });
      created = made.documentId;
      return duplicatePages(made.workspace, pageIds, ids, {
        target: { document: made.documentId, index: 0 },
      });
    },
    m.history_copy_to_new({ pages: pagesPhrase(pageIds.length) }),
  );
  if (!committed || created === undefined) return false;
  ui().pinToArrange([created], previousActive);
  const copies = model().workspace.documents[created]?.pages.map((p) => p.id) ?? [];
  useSelectionStore.getState().apply({
    selected: new Set(copies),
    anchor: copies[0] ?? null,
    focused: copies[0] ?? null,
  });
  announce(m.announce_copied_to_new({ pages: pagesPhrase(pageIds.length), title }));
  return true;
}

// ---------------------------------------------------------------------------
// Images as pages
// ---------------------------------------------------------------------------

export interface PreparedImage {
  readonly file: File;
  readonly blob: BlobId;
  readonly size: Size;
}

export interface PreparedImages {
  readonly images: readonly PreparedImage[];
  /** Names of files the browser could not decode. */
  readonly failed: readonly string[];
}

/**
 * Decodes image files, asks "Fit to A4 width" vs "Original size" when that matters (several
 * images, or one larger than A4), and stores the bytes as blobs. Resolves to undefined when
 * the user cancels the question. Call it as (part of) an `applyComposed` prelude so the
 * blobs are protected until the insertion commits.
 */
export async function prepareImagePages(
  files: readonly File[],
  sizing?: ImageSizing,
): Promise<PreparedImages | undefined> {
  const decoded = await Promise.all(
    files.map(async (file) => {
      try {
        return { file, blob: await decodeImageFile(file) };
      } catch {
        return { file, blob: undefined };
      }
    }),
  );
  const ok = decoded.filter((d): d is { file: File; blob: StoredBlob } => d.blob !== undefined);
  const failed = decoded.filter((d) => d.blob === undefined).map((d) => d.file.name);
  if (ok.length === 0) return { images: [], failed };
  let choice: ImageSizing | undefined = sizing ?? 'fit-a4';
  if (sizing === undefined && shouldAskImageSizing(ok.map((d) => d.blob))) {
    const largest = ok.reduce(
      (best, d) =>
        d.blob.width * d.blob.height > best.width * best.height
          ? { width: d.blob.width, height: d.blob.height }
          : best,
      { width: 0, height: 0 },
    );
    choice = await askImageSizing(ok.length, largest);
    if (choice === undefined) return undefined;
  }
  const store = model();
  const sizingChoice = choice;
  const images = ok.map(({ file, blob }) => ({
    file,
    blob: store.addBlob(blob),
    size: imagePageSize(blob.width, blob.height, sizingChoice),
  }));
  return { images, failed };
}

/** Inserts prepared images into `documentId` at `index`; returns the new workspace. */
export function insertPreparedImages(
  ws: Workspace,
  ids: Parameters<typeof insertImagePage>[2],
  documentId: DocumentId,
  index: number,
  images: readonly PreparedImage[],
): Workspace {
  let next = ws;
  images.forEach((image, offset) => {
    next = insertImagePage(
      next,
      { document: documentId, index: index + offset, blob: image.blob, size: image.size },
      ids,
    );
  });
  return next;
}

/** "N files" or the single file's name, for labels such as "Insert 4 pages from x.pdf". */
export function fromPhrase(names: readonly string[]): string {
  return names.length === 1 ? (names[0] ?? '') : m.files_count({ count: names.length });
}

function announceFailed(failed: readonly string[]): string {
  return failed.length > 0 ? m.announce_images_failed({ names: failed.join(', ') }) : '';
}

/** "Insert images…": appends image pages to a document (or inserts them at `index`). */
export async function insertImagesInto(
  documentId: DocumentId,
  files: readonly File[],
  index?: number,
): Promise<PageId[]> {
  if (files.length === 0) return [];
  let placed: PageId[] = [];
  let failed: readonly string[] = [];
  let at = 0;
  const committed = await model().applyComposed(
    async () => {
      const prepared = await prepareImagePages(files);
      failed = prepared?.failed ?? [];
      return prepared !== undefined && prepared.images.length > 0 ? prepared : undefined;
    },
    (ws, ids, prepared) => {
      const doc = ws.documents[documentId];
      if (doc === undefined) return ws;
      at = Math.min(index ?? doc.pages.length, doc.pages.length);
      const next = insertPreparedImages(ws, ids, documentId, at, prepared.images);
      placed =
        next.documents[documentId]?.pages.slice(at, at + prepared.images.length).map((p) => p.id) ??
        [];
      return next;
    },
    (prepared) =>
      m.history_insert_pages({
        count: prepared.images.length,
        from: fromPhrase(prepared.images.map((i) => i.file.name)),
      }),
  );
  const title = model().workspace.documents[documentId]?.title ?? '';
  if (!committed) {
    if (failed.length > 0) announce(announceFailed(failed));
    return [];
  }
  useSelectionStore.getState().apply({
    selected: new Set(placed),
    anchor: placed[0] ?? null,
    focused: placed[0] ?? null,
  });
  announce(
    [
      m.announce_inserted_pages({
        pages: pagesPhrase(placed.length),
        from: fromPhrase(files.filter((f) => !failed.includes(f.name)).map((f) => f.name)),
        position: at + 1,
        title,
      }),
      announceFailed(failed),
    ]
      .filter(Boolean)
      .join('. '),
  );
  return placed;
}

/** Images opened on their own (picker, drop on the tab bar): one new document. */
export async function openImagesAsDocument(
  files: readonly File[],
): Promise<DocumentId | undefined> {
  if (files.length === 0) return undefined;
  const title = documentTitleFromName(
    (files[0]?.name ?? '').replace(/\.(png|jpe?g|webp)$/i, '.pdf'),
  );
  let created: DocumentId | undefined;
  let failed: readonly string[] = [];
  const committed = await model().applyComposed(
    async () => {
      const prepared = await prepareImagePages(files);
      failed = prepared?.failed ?? [];
      return prepared !== undefined && prepared.images.length > 0 ? prepared : undefined;
    },
    (ws, ids, prepared) => {
      const made = newEmptyDocument(ws, ids, { title });
      created = made.documentId;
      return insertPreparedImages(made.workspace, ids, made.documentId, 0, prepared.images);
    },
    (prepared) =>
      m.history_open({
        name: fromPhrase(prepared.images.map((i) => i.file.name)),
      }),
  );
  if (!committed) {
    if (failed.length > 0) announce(announceFailed(failed));
    return undefined;
  }
  announce([m.announce_opened({ name: title }), announceFailed(failed)].filter(Boolean).join('. '));
  return created;
}
