/**
 * Document tools state (spec document-tools.md §5–§7): which tool dialog is open, and the
 * compression preset applied to each document's export ("Apply to export"). Kept apart
 * from the workspace store: it is export configuration, not document content, and is
 * neither undoable nor persisted. Imported by the export pipeline, so it must stay free of
 * engine runtime imports (types only).
 */
import type { DocumentId } from '@pdf-editor/document-model';
import type { CompressionSettings } from '@pdf-editor/engine';
import { create } from 'zustand';

/** `markdown`: PDF → Markdown / text (convert/ConvertDialog.tsx). */
export type ToolDialog = 'compress' | 'images' | 'markdown';

interface ToolsState {
  readonly dialog: { readonly kind: ToolDialog; readonly documentId: DocumentId } | null;
  /** Compression applied after assembly when the document is exported. */
  readonly exportCompression: Readonly<Record<DocumentId, CompressionSettings>>;
}

export const useToolsStore = create<ToolsState>()(() => ({
  dialog: null,
  exportCompression: {},
}));

export function openToolDialog(kind: ToolDialog, documentId: DocumentId): void {
  useToolsStore.setState({ dialog: { kind, documentId } });
}

export function closeToolDialog(): void {
  useToolsStore.setState({ dialog: null });
}

export function setExportCompression(
  documentId: DocumentId,
  settings: CompressionSettings | null,
): void {
  useToolsStore.setState((state) => {
    const rest = Object.fromEntries(
      Object.entries(state.exportCompression).filter(([id]) => id !== documentId),
    ) as Record<DocumentId, CompressionSettings>;
    return { exportCompression: settings === null ? rest : { ...rest, [documentId]: settings } };
  });
}

export function exportCompressionFor(documentId: DocumentId): CompressionSettings | undefined {
  return useToolsStore.getState().exportCompression[documentId];
}
