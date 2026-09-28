/**
 * Which section-operation dialog is open (split, merge, interleave, resize, crop, image
 * sizing).
 * One dialog at a time; `OperationDialogs` renders it. The image-sizing dialog is a
 * question: `askImageSizing` resolves when the user answers (undefined when cancelled).
 */
import type { DocumentId, PageId } from '@pdf-editor/document-model';
import { create } from 'zustand';

import type { ImageSizing } from '../files/images';

export type OperationDialog =
  | { readonly kind: 'split'; readonly documentId: DocumentId }
  | { readonly kind: 'interleave'; readonly documentId: DocumentId }
  | { readonly kind: 'merge-into'; readonly documentId: DocumentId }
  | { readonly kind: 'merge-all' }
  | {
      readonly kind: 'resize';
      /** The document the dialog was opened for (the section, else the first page's). */
      readonly documentId: DocumentId;
      /** The selected pages, in document order; empty when opened for a whole document. */
      readonly pageIds: readonly PageId[];
    }
  | {
      readonly kind: 'crop';
      /** The document the dialog was opened for (the section, else the first page's). */
      readonly documentId: DocumentId;
      /** The selected pages, in document order; empty when opened for a whole document. */
      readonly pageIds: readonly PageId[];
    }
  | {
      readonly kind: 'image-size';
      readonly count: number;
      /** Largest image in points at 72 dpi, for the "Original size" hint. */
      readonly largest: { readonly width: number; readonly height: number };
      readonly resolve: (choice: ImageSizing | undefined) => void;
    };

interface OperationDialogState {
  readonly dialog: OperationDialog | null;
}

export const useOperationDialogStore = create<OperationDialogState>()(() => ({ dialog: null }));

export function openOperationDialog(dialog: Exclude<OperationDialog, { kind: 'image-size' }>) {
  closeOperationDialog();
  useOperationDialogStore.setState({ dialog });
}

/** Closes the open dialog; a pending image-sizing question resolves as cancelled. */
export function closeOperationDialog(): void {
  const current = useOperationDialogStore.getState().dialog;
  useOperationDialogStore.setState({ dialog: null });
  if (current?.kind === 'image-size') current.resolve(undefined);
}

/** Asks "Fit to A4 width" vs "Original size"; undefined when the user cancels. */
export function askImageSizing(
  count: number,
  largest: { readonly width: number; readonly height: number },
): Promise<ImageSizing | undefined> {
  closeOperationDialog();
  return new Promise((resolve) => {
    let settled = false;
    useOperationDialogStore.setState({
      dialog: {
        kind: 'image-size',
        count,
        largest,
        resolve: (choice) => {
          if (settled) return;
          settled = true;
          resolve(choice);
        },
      },
    });
  });
}

/** Answers the open image-sizing question and closes the dialog. */
export function answerImageSizing(choice: ImageSizing): void {
  const current = useOperationDialogStore.getState().dialog;
  if (current?.kind !== 'image-size') return;
  useOperationDialogStore.setState({ dialog: null });
  current.resolve(choice);
}
