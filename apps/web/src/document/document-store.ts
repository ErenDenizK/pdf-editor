/**
 * Which document-tools dialog is open (spec document-tools.md §3, §4): Set password,
 * Remove password, Strip metadata, or the Document info sheet (experience-redesign §4.2). `origin` says where it was opened from: the export
 * dialog renders its own (nested) instance so focus stays inside the modal stack.
 */
import type { DocumentId } from '@pdf-editor/document-model';
import { create } from 'zustand';

export type DocumentDialogKind = 'set-password' | 'remove-password' | 'strip-metadata' | 'info';

export interface DocumentDialog {
  readonly kind: DocumentDialogKind;
  readonly documentId: DocumentId;
  readonly origin: 'app' | 'export';
}

interface DocumentDialogState {
  readonly dialog: DocumentDialog | null;
}

export const useDocumentDialogStore = create<DocumentDialogState>()(() => ({ dialog: null }));

export function openDocumentDialog(
  kind: DocumentDialogKind,
  documentId: DocumentId,
  origin: DocumentDialog['origin'] = 'app',
): void {
  useDocumentDialogStore.setState({ dialog: { kind, documentId, origin } });
}

export function closeDocumentDialog(): void {
  useDocumentDialogStore.setState({ dialog: null });
}
