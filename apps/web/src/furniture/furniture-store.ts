/**
 * Transient furniture state: which furniture dialog is open, and the preview it shows.
 *
 * While a dialog is open its settings are turned into overlays on every change and stored
 * here as a `FurniturePreview`; the page layer (FurnitureLayer) draws the preview instead
 * of the document's committed furniture of that kind. Nothing touches the model or history
 * until Apply; Cancel (or closing) drops the preview.
 */
import type { BatesConfig, DocumentId, OverlayOp } from '@pdf-editor/document-model';
import { create } from 'zustand';

import type { FurnitureKind } from './furniture-model';

export interface FurnitureDialogState {
  readonly kind: FurnitureKind;
  readonly documentId: DocumentId;
  /** Distinguishes openings: a reopened dialog starts from the model again. */
  readonly nonce: number;
}

export interface FurniturePreview {
  readonly kind: FurnitureKind;
  /** Documents the preview replaces furniture on (several for a Bates run). */
  readonly documents: readonly DocumentId[];
  /** Overlays of `kind` shown on every page of those documents. */
  readonly overlays: readonly OverlayOp[];
  /** Bates numbering per document while previewing a Bates run. */
  readonly bates?: Readonly<Record<DocumentId, BatesConfig>>;
}

interface FurnitureState {
  readonly dialog: FurnitureDialogState | null;
  readonly preview: FurniturePreview | null;
}

export const useFurnitureStore = create<FurnitureState>()(() => ({ dialog: null, preview: null }));

let openings = 0;

export function openFurnitureDialog(kind: FurnitureKind, documentId: DocumentId): void {
  useFurnitureStore.setState({ dialog: { kind, documentId, nonce: ++openings }, preview: null });
}

export function closeFurnitureDialog(): void {
  useFurnitureStore.setState({ dialog: null, preview: null });
}

export function setFurniturePreview(preview: FurniturePreview | null): void {
  useFurnitureStore.setState({ preview });
}
