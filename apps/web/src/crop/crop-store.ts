/**
 * State of "Crop pages…" that outlives the dialog: drawing a crop area in Read mode.
 *
 * "Draw crop area" closes the dialog and keeps what it held (`resume`); the crop layer
 * (CropLayer.tsx, a page overlay) then takes the pages until the user drags a rectangle
 * (the dialog opens again with that rectangle as its margins) or presses Esc (it opens
 * again unchanged). This is not a viewer tool (tool-store.ts): the drawing belongs to the
 * dialog and ends with it.
 */
import type { DocumentId, PageId } from '@pdf-editor/document-model';
import { create } from 'zustand';

import type { ResizeUnit } from '../stage/ResizeDialog';
import type { Margins } from './geometry';

export type CropScope = 'selection' | 'document' | 'same-size';

/** What the dialog shows; restored when it opens again after drawing. */
export interface CropDraft {
  readonly documentId: DocumentId;
  /** The selection the dialog was opened for (empty for a whole document). */
  readonly pageIds: readonly PageId[];
  readonly margins: Margins;
  readonly unit: ResizeUnit;
  readonly scope: CropScope;
  readonly discard: boolean;
}

interface CropState {
  /** Drawing in Read mode: the dialog's draft, until a rectangle is drawn or Esc. */
  readonly drawing: CropDraft | null;
  /** The draft the dialog takes when it opens again (after drawing). */
  readonly resume: CropDraft | null;
}

export const useCropStore = create<CropState>()(() => ({ drawing: null, resume: null }));

export function isDrawingCrop(): boolean {
  return useCropStore.getState().drawing !== null;
}

/** The draft to resume for `documentId`, if the dialog is opening again after drawing. */
export function peekResume(documentId: DocumentId): CropDraft | null {
  const { resume } = useCropStore.getState();
  return resume?.documentId === documentId ? resume : null;
}

export function clearResume(): void {
  if (useCropStore.getState().resume !== null) useCropStore.setState({ resume: null });
}

/** Tests: forget any drawing and draft. */
export function resetCropStore(): void {
  useCropStore.setState({ drawing: null, resume: null });
}
