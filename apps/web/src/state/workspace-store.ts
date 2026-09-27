/**
 * Workspace state: the document model (`@pdf-editor/document-model`, ADR-0005) is the
 * source of truth. The store holds the undo `History`; `workspace` is always
 * `history.present.workspace`. Every mutating action pushes a labelled history entry.
 *
 * Next to the model, the store keeps UI facts the model deliberately does not carry: the
 * original file facts (size, modified date) and the colour tag assigned per source and per
 * document (light-table spec §1). These never change once assigned, so they live outside
 * history.
 *
 * Engine lifetime: a source stays open in the PDFium worker while any history entry
 * references it (undo can bring it back); it is closed once history no longer does. Image
 * blobs (image pages) follow the same rule: the model references them by `BlobId`, the
 * bytes live here, and they are released once no history entry references them.
 *
 * Composed operations (`applyComposed`) run an async prelude first (open files in the
 * engine, decode images, ask the user something) and then commit one model operation as a
 * single history entry: dropping a PDF onto a section is one undo step, not "open" plus
 * "insert".
 *
 * Work in progress: a source opened or a blob stored by an operation that has not
 * committed yet is in no history entry, so garbage collection (run by every commit,
 * including other operations' commits) would drop it. The operation that creates it owns
 * a `ProtectionLease`; `loadSources` and `addBlob` protect each id they create under the
 * caller's lease the moment it exists, and only that lease's `release()` lifts it. The
 * protections are reference counts, so one operation finishing never unprotects what
 * another one is still preparing.
 */
import {
  addSource,
  type BlobId,
  closeDocument as closeDocumentOp,
  createHistory,
  createRandomIdGenerator,
  createWorkspace,
  DEFAULT_COALESCE_WINDOW_MS,
  deletePages as deletePagesOp,
  type DocumentId,
  duplicatePages as duplicatePagesOp,
  type EngineEdit,
  getActiveDocument,
  type History,
  type IdGenerator,
  jumpTo as jumpToOp,
  movePages as movePagesOp,
  type PageId,
  type PageTarget,
  pushHistory,
  redo as redoOp,
  removeSourceIfUnreferenced,
  rotatePages as rotatePagesOp,
  setActiveDocument,
  type SourceId,
  type SourceInput,
  undo as undoOp,
  type VirtualDocument,
  type Workspace,
} from '@pdf-editor/document-model';
import { create } from 'zustand';

import { type EngineFailure, getEngineService, type OpenedSource } from '../engine/engine-service';
import { m } from '../i18n';

/** Number of source colour tags in tokens.css (`--tag-0` … `--tag-5`). */
export const SOURCE_TAG_COUNT = 6;

export interface SourceFileInfo {
  readonly name: string;
  readonly size: number;
  readonly lastModified: number;
  /** Index into the source colour tags, stable for the source's life. */
  readonly colorIndex: number;
}

export interface OpenFilesReport {
  readonly opened: readonly { readonly name: string; readonly documentId: DocumentId }[];
  readonly skipped: readonly { readonly name: string; readonly error: EngineFailure }[];
}

/** Image bytes referenced by image pages. PNG or JPEG only (what the assembler embeds). */
export interface StoredBlob {
  readonly bytes: ArrayBuffer;
  readonly type: 'image/png' | 'image/jpeg';
  /** Pixel size of the image. */
  readonly width: number;
  readonly height: number;
  readonly name: string;
}

/**
 * Garbage-collection protection held by one operation for the sources and blobs it created
 * but has not committed yet (see the module comment). `openFiles` and `applyComposed`
 * create one per run and release it after their commit (or when they give up).
 */
export interface ProtectionLease {
  /** True once released; ids created under a released lease are not protected. */
  readonly released: boolean;
  /** Lifts every protection this lease holds (idempotent). */
  release(): void;
}

/** Files opened by the engine but not yet added to the model (see `loadSources`). */
export interface LoadedSources {
  readonly loaded: readonly { readonly file: File; readonly source: OpenedSource }[];
  readonly skipped: readonly { readonly name: string; readonly error: EngineFailure }[];
}

interface WorkspaceState {
  readonly history: History;
  /** Always `history.present.workspace`. */
  readonly workspace: Workspace;
  readonly files: Readonly<Record<SourceId, SourceFileInfo>>;
  readonly documentColors: Readonly<Record<DocumentId, number>>;
  readonly blobs: Readonly<Record<BlobId, StoredBlob>>;
  /** Files being read or opened by the engine right now. */
  readonly opening: number;
  /**
   * Sources whose engine document was changed by an engine edit (annotations) at any
   * point in this session, even if the edit was undone since: export must serialize them
   * through the engine (`needsEngineSave`) rather than reuse the original bytes.
   */
  readonly dirtySources: ReadonlySet<SourceId>;
  /**
   * Binary parts of engine edits (stamp appearances), stored once by content id instead of
   * inline in every edit payload and inverse. Kept while any history entry's edits refer to
   * them (`engineEditBlobIds`).
   */
  readonly editBlobs: Readonly<Record<string, Blob>>;
  /** Stores an edit blob under its content id (idempotent). */
  putEditBlob: (id: string, blob: Blob) => void;

  openFiles: (files: readonly File[]) => Promise<OpenFilesReport>;
  /**
   * Opens files in the engine and registers their file facts, without touching the model
   * or history. Each opened source is protected under `lease` as soon as it is registered;
   * add it with `addLoadedSource` inside an operation (usually the `applyComposed` that
   * owns the lease). Sources never added are closed once the lease is released.
   */
  loadSources: (files: readonly File[], lease: ProtectionLease) => Promise<LoadedSources>;
  /**
   * Stores image bytes for image pages and returns the id the model references. The blob
   * is protected under `lease` until it is released; by then it must be in history.
   */
  addBlob: (blob: StoredBlob, lease: ProtectionLease) => BlobId;
  closeDocument: (id: DocumentId) => void;
  setActive: (id: DocumentId) => void;
  movePages: (
    pageIds: readonly PageId[],
    target: PageTarget,
    options?: { readonly label?: string; readonly coalesceKey?: string },
  ) => boolean;
  rotatePages: (pageIds: readonly PageId[], delta: number) => boolean;
  deletePages: (pageIds: readonly PageId[]) => boolean;
  duplicatePages: (pageIds: readonly PageId[]) => boolean;
  /**
   * Commits any model operation (or a composition of several) as one labelled history
   * entry. The operation receives the store's id generator for new pages and documents.
   * A label function is called after the operation ran, for labels that depend on the
   * outcome. Returns false when the operation threw or changed nothing.
   */
  applyOperation: (
    operation: (ws: Workspace, ids: IdGenerator) => Workspace,
    label: string | (() => string),
    options?: { readonly coalesceKey?: string },
  ) => boolean;
  /**
   * `applyOperation` with an async prelude: awaits `prelude` (open files, decode images,
   * ask the user), then commits `operation` with the prelude's result as one history
   * entry. A prelude that resolves to `undefined` cancels. The prelude receives the
   * operation's lease: pass it to `loadSources` and `addBlob` so what the prelude creates
   * survives other operations' commits until this one has committed. Resolves to whether
   * a change was committed.
   */
  applyComposed: <P>(
    prelude: (lease: ProtectionLease) => Promise<P | undefined>,
    operation: (ws: Workspace, ids: IdGenerator, prelude: P) => Workspace,
    label: string | ((prelude: P) => string),
  ) => Promise<boolean>;
  /**
   * Records content edits the engine has already executed (annotations) as one labelled
   * history entry: appends them, each with its `inverse`, to `Workspace.engineEdits` and
   * marks their sources dirty. Undo and redo move between snapshots; whoever executes
   * engine edits (annotations/edit-runner.ts) replays the difference through the engine.
   * With `coalesceKey`, a push that coalesces with the present entry (same key within the
   * 800 ms window) may replace the present entry's last edit by `merge(last, next)` (e.g.
   * one update from the first slider value to the last). Returns false when nothing was
   * committed.
   */
  applyEngineEdit: (
    edits: EngineEdit | readonly EngineEdit[],
    label: string,
    options?: {
      readonly coalesceKey?: string;
      readonly merge?: (previous: EngineEdit, next: EngineEdit) => EngineEdit | undefined;
    },
  ) => boolean;
  undo: () => string | undefined;
  redo: () => string | undefined;
  jumpTo: (index: number) => void;
}

const ids: IdGenerator = createRandomIdGenerator();
let colorCounter = 0;

/**
 * Sources and blobs protected by running operations, with the number of leases holding
 * each. Garbage collection keeps every id in here.
 */
const protections = new Map<SourceId | BlobId, number>();

function protect(id: SourceId | BlobId): void {
  protections.set(id, (protections.get(id) ?? 0) + 1);
}

function unprotect(id: SourceId | BlobId): void {
  const count = protections.get(id);
  if (count === undefined) return;
  if (count <= 1) protections.delete(id);
  else protections.set(id, count - 1);
}

class Lease implements ProtectionLease {
  private readonly held: (SourceId | BlobId)[] = [];
  private done = false;

  get released(): boolean {
    return this.done;
  }

  /** Protects `id` for this lease's owner; false when the lease was already released. */
  hold(id: SourceId | BlobId): boolean {
    if (this.done) return false;
    protect(id);
    this.held.push(id);
    return true;
  }

  release(): void {
    if (this.done) return;
    this.done = true;
    for (const id of this.held) unprotect(id);
    this.held.length = 0;
  }
}

/** Only leases made by this store can hold ids. */
function asLease(lease: ProtectionLease): Lease {
  if (!(lease instanceof Lease)) throw new Error('Not a workspace store lease');
  return lease;
}

export function pagesPhrase(count: number): string {
  return m.pages_count({ count });
}

/** Stable key for a set of pages; used to coalesce repeated edits of one selection. */
function selectionKey(pageIds: readonly PageId[]): string {
  return [...pageIds].sort().join(',');
}

function toSourceInput(opened: OpenedSource): SourceInput {
  const doc = opened.document;
  return {
    name: opened.name,
    byteLength: opened.byteLength,
    pageCount: doc.pageCount,
    pages: doc.pages,
    fingerprint: doc.fingerprint,
    flags: doc.flags,
    metadata: doc.metadata,
    outline: doc.outline,
  };
}

function initialHistory(): History {
  return createHistory(createWorkspace(), m.history_start(), Date.now());
}

/**
 * Adds a loaded source to the model (inside an operation). Returns the new workspace and
 * the document that shows the source's pages.
 */
export function addLoadedSource(
  ws: Workspace,
  source: OpenedSource,
  idGenerator: IdGenerator,
): { readonly workspace: Workspace; readonly documentId: DocumentId } {
  // The engine's id is the handle to the open document (and its retained bytes).
  const r = addSource(ws, toSourceInput(source), idGenerator, { sourceId: source.id });
  return { workspace: r.workspace, documentId: r.documentId };
}

const blobCache = new WeakMap<VirtualDocument, readonly BlobId[]>();

/** Blob ids referenced by a document's image pages and image overlays (memoized). */
function documentBlobs(doc: VirtualDocument): readonly BlobId[] {
  let found = blobCache.get(doc);
  if (found === undefined) {
    const set = new Set<BlobId>();
    for (const page of doc.pages) {
      if (page.ref.kind === 'image') set.add(page.ref.blob);
      for (const overlay of page.overlays) if (overlay.kind === 'image') set.add(overlay.blob);
    }
    found = [...set];
    blobCache.set(doc, found);
  }
  return found;
}

/** Blob ids a document needs at export. */
export function blobsOfDocument(doc: VirtualDocument): readonly BlobId[] {
  return documentBlobs(doc);
}

export const useWorkspaceStore = create<WorkspaceState>()((set, get) => {
  /** Applies a model operation; model misuse is reported, never thrown into the UI. */
  const commit = (
    operation: (ws: Workspace) => Workspace,
    label: string,
    coalesceKey?: string,
  ): boolean => {
    const { history, workspace } = get();
    let next: Workspace;
    try {
      next = operation(workspace);
    } catch (error) {
      console.warn(`${label} failed`, error);
      return false;
    }
    if (next === workspace) return false;
    const pushed = pushHistory(
      history,
      next,
      label,
      coalesceKey === undefined ? {} : { coalesceKey },
    );
    set({
      history: pushed,
      workspace: pushed.present.workspace,
      documentColors: colorsFor(pushed.present.workspace),
    });
    collectGarbage();
    return true;
  };

  /**
   * Documents created by operations (split parts, merges, extracts) take the colour of
   * their first source, so a tab keeps the colour of the file its pages came from.
   */
  const colorsFor = (ws: Workspace): Readonly<Record<DocumentId, number>> => {
    const { documentColors, files } = get();
    let next: Record<DocumentId, number> | undefined;
    for (const id of ws.documentOrder) {
      if (documentColors[id] !== undefined) continue;
      const doc = ws.documents[id];
      if (doc === undefined) continue;
      const first = documentSources(doc)[0];
      const colorIndex = first === undefined ? undefined : (files[first]?.colorIndex ?? undefined);
      next ??= { ...documentColors };
      next[id] = colorIndex ?? colorCounter++ % SOURCE_TAG_COUNT;
    }
    return next ?? documentColors;
  };

  /** Replaces the present snapshot without an undo step (tab activation). */
  const replacePresent = (next: Workspace): void => {
    const { history, workspace } = get();
    if (next === workspace) return;
    set({
      history: { ...history, present: { ...history.present, workspace: next } },
      workspace: next,
    });
  };

  const moveHistory = (next: History): boolean => {
    if (next === get().history) return false;
    set({ history: next, workspace: next.present.workspace });
    collectGarbage();
    return true;
  };

  /** Closes engine sources (and drops blobs) that no history entry references any more. */
  const collectGarbage = (): void => {
    const { history, files, blobs } = get();
    const entries = [...history.past, history.present, ...history.future];
    const live = new Set<string>(protections.keys());
    for (const entry of entries) {
      for (const id of Object.keys(entry.workspace.sources)) live.add(id);
    }
    const dead = (Object.keys(files) as SourceId[]).filter((id) => !live.has(id));
    if (dead.length > 0) {
      for (const id of dead) void getEngineService().close(id);
      const deadSet = new Set<string>(dead);
      const dirty = get().dirtySources;
      set({
        files: Object.fromEntries(Object.entries(files).filter(([id]) => !deadSet.has(id))),
        ...(dead.some((id) => dirty.has(id))
          ? { dirtySources: new Set([...dirty].filter((id) => !deadSet.has(id))) }
          : {}),
      });
    }
    const { editBlobs } = get();
    const editBlobIds = Object.keys(editBlobs);
    if (editBlobIds.length > 0) {
      const referenced = new Set<string>();
      const seenEdits = new Set<Workspace['engineEdits']>();
      for (const entry of entries) {
        const edits = entry.workspace.engineEdits;
        if (seenEdits.has(edits)) continue;
        seenEdits.add(edits);
        for (const edit of edits) for (const id of engineEditBlobIds(edit)) referenced.add(id);
      }
      if (!editBlobIds.every((id) => referenced.has(id) || protections.has(id as BlobId))) {
        set({
          editBlobs: Object.fromEntries(
            Object.entries(editBlobs).filter(
              ([id]) => referenced.has(id) || protections.has(id as BlobId),
            ),
          ),
        });
      }
    }
    const blobIds = Object.keys(blobs) as BlobId[];
    if (blobIds.length === 0) return;
    const liveBlobs = new Set<string>(protections.keys());
    const seen = new Set<VirtualDocument>();
    for (const entry of entries) {
      for (const doc of Object.values(entry.workspace.documents)) {
        if (seen.has(doc)) continue;
        seen.add(doc);
        for (const id of documentBlobs(doc)) liveBlobs.add(id);
      }
    }
    if (blobIds.every((id) => liveBlobs.has(id))) return;
    set({
      blobs: Object.fromEntries(Object.entries(blobs).filter(([id]) => liveBlobs.has(id))),
    });
  };

  const loadSources = async (
    files: readonly File[],
    protection: ProtectionLease,
  ): Promise<LoadedSources> => {
    const lease = asLease(protection);
    if (files.length === 0) return { loaded: [], skipped: [] };
    const service = getEngineService();
    set((s) => ({ opening: s.opening + files.length }));
    // Open in parallel; report in the order the files were given.
    const pending = files.map((file) => ({ file, result: service.open(file) }));
    const loaded: { file: File; source: OpenedSource }[] = [];
    const skipped: { name: string; error: EngineFailure }[] = [];
    for (const { file, result: promise } of pending) {
      const result = await promise;
      set((s) => ({ opening: Math.max(0, s.opening - 1) }));
      if (!result.ok) {
        skipped.push({ name: file.name, error: result.error });
        continue;
      }
      const source = result.value;
      // Not in any history entry yet: protect it from garbage collection for the owner
      // of the lease (openFiles, applyComposed) until it has committed or given up.
      const held = lease.hold(source.id);
      const colorIndex = colorCounter % SOURCE_TAG_COUNT;
      colorCounter += 1;
      set((s) => ({
        files: {
          ...s.files,
          [source.id]: {
            name: source.name,
            size: source.byteLength,
            lastModified: source.lastModified,
            colorIndex,
          },
        },
      }));
      loaded.push({ file, source });
      // The owner already gave up (its prelude failed while this file was opening).
      if (!held) collectGarbage();
    }
    return { loaded, skipped };
  };

  /** Commits each loaded source as its own tab ("Open x.pdf"), in the given order. */
  const commitOpened = (
    loaded: LoadedSources['loaded'],
    opened: { name: string; documentId: DocumentId }[],
    skipped: { name: string; error: EngineFailure }[],
  ): void => {
    for (const { file, source } of loaded) {
      let documentId: DocumentId | undefined;
      const added = commit(
        (ws) => {
          const r = addLoadedSource(ws, source, ids);
          documentId = r.documentId;
          return r.workspace;
        },
        m.history_open({ name: source.name }),
      );
      if (!added || documentId === undefined) {
        skipped.push({
          name: file.name,
          error: { code: 'internal', message: 'The document model rejected the file' },
        });
        continue;
      }
      opened.push({ name: source.name, documentId });
    }
  };

  return {
    history: initialHistory(),
    workspace: createWorkspace(),
    files: {},
    documentColors: {},
    blobs: {},
    opening: 0,
    dirtySources: new Set(),
    editBlobs: {},

    putEditBlob: (id, blob) => {
      if (get().editBlobs[id] !== undefined) return;
      set((s) => ({ editBlobs: { ...s.editBlobs, [id]: blob } }));
    },

    openFiles: async (files) => {
      if (files.length === 0) return { opened: [], skipped: [] };
      const lease = new Lease();
      const opened: { name: string; documentId: DocumentId }[] = [];
      const skipped: { name: string; error: EngineFailure }[] = [];
      try {
        const result = await loadSources(files, lease);
        skipped.push(...result.skipped);
        commitOpened(result.loaded, opened, skipped);
      } finally {
        lease.release();
        collectGarbage();
      }
      // Activate the first new document, as dropping several files reads left to right.
      const first = opened[0];
      if (first !== undefined && get().workspace.documents[first.documentId] !== undefined) {
        replacePresent(setActiveDocument(get().workspace, first.documentId));
      }
      return { opened, skipped };
    },

    loadSources,

    addBlob: (blob, protection) => {
      const lease = asLease(protection);
      const id = ids.blob();
      set((s) => ({ blobs: { ...s.blobs, [id]: blob } }));
      // Protected from the moment it exists: other operations commit (and collect) while
      // the owner's prelude is still running.
      if (!lease.hold(id)) collectGarbage();
      return id;
    },

    closeDocument: (id) => {
      const doc = get().workspace.documents[id];
      if (doc === undefined) return;
      const sources = new Set<SourceId>();
      for (const page of doc.pages) if (page.ref.kind === 'source') sources.add(page.ref.source);
      commit(
        (ws) => {
          let next = closeDocumentOp(ws, id);
          for (const source of sources) next = removeSourceIfUnreferenced(next, source);
          return next;
        },
        m.history_close({ name: doc.title }),
      );
    },

    setActive: (id) => {
      const { workspace } = get();
      if (workspace.documents[id] === undefined) return;
      replacePresent(setActiveDocument(workspace, id));
    },

    movePages: (pageIds, target, options = {}) =>
      pageIds.length > 0 &&
      commit(
        (ws) => movePagesOp(ws, { pageIds, target }),
        options.label ?? m.history_move({ count: pageIds.length }),
        options.coalesceKey,
      ),

    rotatePages: (pageIds, delta) =>
      pageIds.length > 0 &&
      commit(
        (ws) => rotatePagesOp(ws, pageIds, delta),
        m.history_rotate({ count: pageIds.length }),
        `rotate:${selectionKey(pageIds)}`,
      ),

    deletePages: (pageIds) =>
      pageIds.length > 0 &&
      commit((ws) => deletePagesOp(ws, pageIds), m.history_delete({ count: pageIds.length })),

    duplicatePages: (pageIds) =>
      pageIds.length > 0 &&
      commit(
        (ws) => duplicatePagesOp(ws, pageIds, ids),
        m.history_duplicate({ count: pageIds.length }),
      ),

    applyOperation: (operation, label, options = {}) => {
      if (typeof label === 'string') {
        return commit((ws) => operation(ws, ids), label, options.coalesceKey);
      }
      let next: Workspace;
      try {
        next = operation(get().workspace, ids);
      } catch (error) {
        console.warn('Operation failed', error);
        return false;
      }
      return commit(() => next, label(), options.coalesceKey);
    },

    applyComposed: async (prelude, operation, label) => {
      // Whatever the prelude creates is protected under this lease, and only this lease:
      // other operations finishing meanwhile never lift it (see the module comment).
      const lease = new Lease();
      try {
        let result: Awaited<ReturnType<typeof prelude>>;
        try {
          result = await prelude(lease);
        } catch (error) {
          console.warn('Operation prelude failed', error);
          result = undefined;
        }
        if (result === undefined) return false;
        const value = result;
        let next: Workspace;
        try {
          next = operation(get().workspace, ids, value);
        } catch (error) {
          console.warn('Operation failed', error);
          return false;
        }
        return commit(() => next, typeof label === 'string' ? label : label(value));
      } finally {
        lease.release();
        collectGarbage();
      }
    },

    applyEngineEdit: (input, label, options = {}) => {
      const edits: readonly EngineEdit[] = Array.isArray(input) ? input : [input as EngineEdit];
      if (edits.length === 0) return false;
      const { history } = get();
      const { coalesceKey, merge } = options;
      const now = Date.now();
      const present = history.present;
      const coalesces =
        coalesceKey !== undefined &&
        present.coalesceKey === coalesceKey &&
        history.future.length === 0 &&
        now - present.at >= 0 &&
        now - present.at <= DEFAULT_COALESCE_WINDOW_MS;
      const committed = commit(
        (ws) => {
          const previous = ws.engineEdits[ws.engineEdits.length - 1];
          const only = edits.length === 1 ? edits[0] : undefined;
          const merged = coalesces && merge && previous && only ? merge(previous, only) : undefined;
          const engineEdits = merged
            ? [...ws.engineEdits.slice(0, -1), merged]
            : [...ws.engineEdits, ...edits];
          return { ...ws, engineEdits };
        },
        label,
        coalesceKey,
      );
      if (committed) {
        const dirty = get().dirtySources;
        if (edits.some((edit) => !dirty.has(edit.source))) {
          set({ dirtySources: new Set([...dirty, ...edits.map((edit) => edit.source)]) });
        }
      }
      return committed;
    },

    undo: () => {
      const label = get().history.present.label;
      return moveHistory(undoOp(get().history)) ? label : undefined;
    },
    redo: () => (moveHistory(redoOp(get().history)) ? get().history.present.label : undefined),
    jumpTo: (index) => {
      try {
        moveHistory(jumpToOp(get().history, index));
      } catch (error) {
        console.warn('History jump failed', error);
      }
    },
  };
});

/** Resets to an empty workspace (tests). Open engine sources are closed. */
export function resetWorkspace(): void {
  const { files } = useWorkspaceStore.getState();
  protections.clear();
  for (const id of Object.keys(files) as SourceId[]) void getEngineService().close(id);
  useWorkspaceStore.setState({
    history: initialHistory(),
    workspace: createWorkspace(),
    files: {},
    documentColors: {},
    blobs: {},
    opening: 0,
    dirtySources: new Set(),
    editBlobs: {},
  });
}

/**
 * Edit blob ids an engine edit (and its inverse) refers to: `payload.annotation.image.blob`
 * (annotations/edit-runner.ts stores stamp images this way).
 */
export function engineEditBlobIds(edit: EngineEdit): string[] {
  const ids: string[] = [];
  for (let e: EngineEdit | undefined = edit; e; e = e.inverse) {
    const payload = e.payload as { annotation?: { image?: { blob?: unknown } } } | null;
    const id = payload?.annotation?.image?.blob;
    if (typeof id === 'string') ids.push(id);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Derived data. Memoized on the workspace (and files) identity so selectors return
// stable references and components re-render only when the model changes.
// ---------------------------------------------------------------------------

export interface TabItem {
  readonly id: DocumentId;
  readonly title: string;
  readonly colorIndex: number;
  readonly pageCount: number;
}

const tabCache = new WeakMap<Workspace, { colors: object; items: readonly TabItem[] }>();

export function tabItems(
  ws: Workspace,
  documentColors: Readonly<Record<DocumentId, number>>,
): readonly TabItem[] {
  const cached = tabCache.get(ws);
  if (cached?.colors === documentColors) return cached.items;
  const items = ws.documentOrder.flatMap((id): TabItem[] => {
    const doc = ws.documents[id];
    if (doc === undefined) return [];
    return [
      {
        id,
        title: doc.title,
        colorIndex: documentColors[id] ?? 0,
        pageCount: doc.pages.length,
      },
    ];
  });
  tabCache.set(ws, { colors: documentColors, items });
  return items;
}

export function useTabItems(): readonly TabItem[] {
  return useWorkspaceStore((s) => tabItems(s.workspace, s.documentColors));
}

export function useActiveDocument(): VirtualDocument | undefined {
  return useWorkspaceStore((s) => getActiveDocument(s.workspace));
}

export function useHasDocuments(): boolean {
  return useWorkspaceStore((s) => s.workspace.documentOrder.length > 0);
}

/** Sources referenced by a document, in page order of first appearance. */
export function documentSources(doc: VirtualDocument): SourceId[] {
  const seen = new Set<SourceId>();
  for (const page of doc.pages) if (page.ref.kind === 'source') seen.add(page.ref.source);
  return [...seen];
}
