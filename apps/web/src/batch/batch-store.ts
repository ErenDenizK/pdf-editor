/**
 * Whether the Batch dialog is open. The dialog's own state (recipe, files, run) lives in
 * the dialog: it is neither undoable nor persisted, and closing the dialog drops the
 * outputs of a finished run.
 */
import { create } from 'zustand';

interface BatchState {
  readonly open: boolean;
}

export const useBatchStore = create<BatchState>()(() => ({ open: false }));

export function openBatchDialog(): void {
  useBatchStore.setState({ open: true });
}

export function closeBatchDialog(): void {
  useBatchStore.setState({ open: false });
}
