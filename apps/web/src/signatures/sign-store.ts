/**
 * The signing choice per document (spec recognize-and-compare §3.4): the Sign dialog (from
 * the Document menu or the export dialog's Signature section) checks a certificate and keeps
 * it here, in memory only, for the export that signs. Cleared when that export dialog
 * closes or the document goes away; nothing is stored.
 */
import type { DocumentId } from '@pdf-editor/document-model';
import { create } from 'zustand';

import { useExportDialogStore } from '../export/export-store';
import type { SignDraft } from './signing';

export interface SignDialog {
  readonly documentId: DocumentId;
  /** The export dialog renders its own (nested) instance. */
  readonly origin: 'app' | 'export';
}

interface SignState {
  readonly dialog: SignDialog | null;
  /** The checked certificate and options per document. */
  readonly drafts: Readonly<Record<string, SignDraft>>;
  /** "Sign the exported file" per document. */
  readonly signOnExport: Readonly<Record<string, boolean>>;
}

export const useSignStore = create<SignState>()(() => ({
  dialog: null,
  drafts: {},
  signOnExport: {},
}));

export function openSignDialog(documentId: DocumentId, origin: SignDialog['origin'] = 'app'): void {
  useSignStore.setState({ dialog: { documentId, origin } });
}

export function closeSignDialog(): void {
  useSignStore.setState({ dialog: null });
}

/** Keeps a checked certificate for the document and turns signing on. */
export function setSignDraft(documentId: DocumentId, draft: SignDraft): void {
  useSignStore.setState((s) => ({
    drafts: { ...s.drafts, [documentId]: draft },
    signOnExport: { ...s.signOnExport, [documentId]: true },
  }));
}

export function setSignOnExport(documentId: DocumentId, on: boolean): void {
  useSignStore.setState((s) => ({ signOnExport: { ...s.signOnExport, [documentId]: on } }));
}

/** Drops the certificate bytes and password kept for the document. */
export function clearSignDraft(documentId: DocumentId): void {
  const { drafts, signOnExport } = useSignStore.getState();
  const draft = drafts[documentId];
  if (draft === undefined && signOnExport[documentId] === undefined) return;
  // Wipe our copy of the .p12 (the engine got copies, which its worker wipes).
  if (draft) new Uint8Array(draft.pkcs12).fill(0);
  const { [documentId]: _draft, ...rest } = drafts;
  const { [documentId]: _on, ...others } = signOnExport;
  useSignStore.setState({ drafts: rest, signOnExport: others });
}

/** The draft to sign the export of `documentId` with, when signing is on. */
export function activeSignDraft(documentId: DocumentId): SignDraft | undefined {
  const { drafts, signOnExport } = useSignStore.getState();
  return signOnExport[documentId] === true ? drafts[documentId] : undefined;
}

// The certificate lives as long as the export dialog it was chosen for.
useExportDialogStore.subscribe((state, previous) => {
  if (previous.documentId !== null && state.documentId !== previous.documentId) {
    clearSignDraft(previous.documentId);
  }
});
