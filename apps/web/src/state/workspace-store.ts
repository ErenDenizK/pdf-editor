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
 * references it (undo can bring it back); it is closed once history no longer does.
 */
import {
  addSource,
  closeDocument as closeDocumentOp,
  createHistory,
  createRandomIdGenerator,
  createWorkspace,
  deletePages as deletePagesOp,
  type DocumentId,
  duplicatePages as duplicatePagesOp,
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

interface WorkspaceState {
  readonly history: History;
  /** Always `history.present.workspace`. */
  readonly workspace: Workspace;
  readonly files: Readonly<Record<SourceId, SourceFileInfo>>;
  readonly documentColors: Readonly<Record<DocumentId, number>>;
  /** Files being read or opened by the engine right now. */
  readonly opening: number;

  openFiles: (files: readonly File[]) => Promise<OpenFilesReport>;
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
  undo: () => string | undefined;
  redo: () => string | undefined;
  jumpTo: (index: number) => void;
}

const ids: IdGenerator = createRandomIdGenerator();
let colorCounter = 0;

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
    set({ history: pushed, workspace: pushed.present.workspace });
    collectGarbage();
    return true;
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

  /** Closes engine sources that no history entry references any more. */
  const collectGarbage = (): void => {
    const { history, files } = get();
    const live = new Set<string>();
    for (const entry of [...history.past, history.present, ...history.future]) {
      for (const id of Object.keys(entry.workspace.sources)) live.add(id);
    }
    const dead = (Object.keys(files) as SourceId[]).filter((id) => !live.has(id));
    if (dead.length === 0) return;
    for (const id of dead) void getEngineService().close(id);
    const deadSet = new Set<string>(dead);
    set({
      files: Object.fromEntries(Object.entries(files).filter(([id]) => !deadSet.has(id))),
    });
  };

  return {
    history: initialHistory(),
    workspace: createWorkspace(),
    files: {},
    documentColors: {},
    opening: 0,

    openFiles: async (files) => {
      if (files.length === 0) return { opened: [], skipped: [] };
      const service = getEngineService();
      set((s) => ({ opening: s.opening + files.length }));
      // Open in parallel; add to the workspace in the order the files were given.
      const pending = files.map((file) => ({ file, result: service.open(file) }));
      const opened: { name: string; documentId: DocumentId }[] = [];
      const skipped: { name: string; error: EngineFailure }[] = [];
      for (const { file, result: promise } of pending) {
        const result = await promise;
        set((s) => ({ opening: Math.max(0, s.opening - 1) }));
        if (!result.ok) {
          skipped.push({ name: file.name, error: result.error });
          continue;
        }
        const source = result.value;
        let documentId: DocumentId | undefined;
        const colorIndex = colorCounter % SOURCE_TAG_COUNT;
        const added = commit(
          (ws) => {
            // The engine's id is the handle to the open document (and its retained bytes).
            const r = addSource(ws, toSourceInput(source), ids, { sourceId: source.id });
            documentId = r.documentId;
            return r.workspace;
          },
          m.history_open({ name: source.name }),
        );
        if (!added || documentId === undefined) {
          void service.close(source.id);
          skipped.push({
            name: file.name,
            error: { code: 'internal', message: 'The document model rejected the file' },
          });
          continue;
        }
        colorCounter += 1;
        const docId = documentId;
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
          documentColors: { ...s.documentColors, [docId]: colorIndex },
        }));
        opened.push({ name: source.name, documentId: docId });
      }
      // Activate the first new document, as dropping several files reads left to right.
      const first = opened[0];
      if (first !== undefined && get().workspace.documents[first.documentId] !== undefined) {
        replacePresent(setActiveDocument(get().workspace, first.documentId));
      }
      return { opened, skipped };
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
  for (const id of Object.keys(files) as SourceId[]) void getEngineService().close(id);
  useWorkspaceStore.setState({
    history: initialHistory(),
    workspace: createWorkspace(),
    files: {},
    documentColors: {},
    opening: 0,
  });
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
