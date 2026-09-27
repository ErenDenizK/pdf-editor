/** Which document the export dialog is open for (null: closed). */
import type { DocumentId } from '@pdf-editor/document-model';
import { create } from 'zustand';

interface ExportDialogState {
  readonly documentId: DocumentId | null;
}

export const useExportDialogStore = create<ExportDialogState>()(() => ({ documentId: null }));

export function openExportDialog(documentId: DocumentId): void {
  useExportDialogStore.setState({ documentId });
}

export function closeExportDialog(): void {
  useExportDialogStore.setState({ documentId: null });
}
