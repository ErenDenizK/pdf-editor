/** Whether the "Apply redactions" dialog is open (the Redactions panel's button). */
import { create } from 'zustand';

interface ApplyDialogState {
  readonly open: boolean;
  setOpen: (open: boolean) => void;
}

export const useApplyDialogStore = create<ApplyDialogState>()((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));
