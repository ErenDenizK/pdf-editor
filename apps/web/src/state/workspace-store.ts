/**
 * ============================================================================
 * INTEGRATION POINT: workspace (document) state.
 *
 * TODO(document-model): replace this placeholder with the workspace from
 * `@pdf-editor/document-model` (ARCHITECTURE.md §3, ADR-0005). The shell reads only the
 * `WorkspaceDocument` fields below; keep them (or adapt `useWorkspaceStore` selectors)
 * when swapping in the real model. Page counts, outline, history and selection come from
 * the model and are not represented here.
 * ============================================================================
 *
 * What the placeholder does: it records dropped or picked `File` objects (name, size) so
 * the tab bar, empty state, files panel and status bar work end to end. It never reads
 * file bytes.
 */
import { create } from 'zustand';

import { useUiStore } from './ui-store';

export interface WorkspaceDocument {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly lastModified: number;
  /** Index into the source colour tags (light table), stable for the document's life. */
  readonly colorIndex: number;
  /** Unknown until the engine opens the file. */
  readonly pageCount: number | null;
  readonly file: File;
}

export const SOURCE_TAG_COUNT = 6;

interface WorkspaceState {
  documents: readonly WorkspaceDocument[];
  /** Adds files as documents; returns the created entries. */
  addFiles: (files: readonly File[]) => WorkspaceDocument[];
  closeDocument: (id: string) => void;
}

let counter = 0;
function createId(): string {
  counter += 1;
  return globalThis.crypto?.randomUUID?.() ?? `doc-${Date.now().toString(36)}-${counter}`;
}

export const useWorkspaceStore = create<WorkspaceState>()((set, get) => ({
  documents: [],
  addFiles: (files) => {
    const start = get().documents.length;
    const created = files.map<WorkspaceDocument>((file, index) => ({
      id: createId(),
      name: file.name,
      size: file.size,
      lastModified: file.lastModified,
      colorIndex: (start + index) % SOURCE_TAG_COUNT,
      pageCount: null,
      file,
    }));
    if (created.length > 0) set((s) => ({ documents: [...s.documents, ...created] }));
    return created;
  },
  closeDocument: (id) => set((s) => ({ documents: s.documents.filter((d) => d.id !== id) })),
}));

/** Opens files as tabs and activates the first new one. */
export function openDocuments(files: readonly File[]): void {
  const created = useWorkspaceStore.getState().addFiles(files);
  const first = created[0];
  if (first) useUiStore.getState().setActiveTab(first.id);
}

/** Closes a tab and moves activation to its neighbour (right, else left). */
export function closeDocument(id: string): void {
  const { documents, closeDocument: remove } = useWorkspaceStore.getState();
  const index = documents.findIndex((d) => d.id === id);
  if (index < 0) return;
  const ui = useUiStore.getState();
  if (ui.activeTabId === id) {
    const neighbour = documents[index + 1] ?? documents[index - 1] ?? null;
    ui.setActiveTab(neighbour?.id ?? null);
  }
  remove(id);
}

export function useActiveDocument(): WorkspaceDocument | undefined {
  const activeId = useUiStore((s) => s.activeTabId);
  return useWorkspaceStore((s) => s.documents.find((d) => d.id === activeId));
}
