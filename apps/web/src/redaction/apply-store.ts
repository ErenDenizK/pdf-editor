/**
 * The "Apply redactions" dialog (the Redactions panel's button) and the apply it runs.
 *
 * The run lives here, not in the dialog: while it works the dialog refuses to close (Esc,
 * the backdrop and every other close request are ignored), and its outcome (applied,
 * blocked, error) stays here until the dialog that shows it closes, so a dialog opened
 * again while or after the run shows the progress or the result sheet, never a fresh form.
 */
import { create } from 'zustand';

import { type ApplyChoices, type ApplyOutcome, applyTickedRedactions } from './apply';

export type ApplyRun =
  | { readonly kind: 'idle' }
  | { readonly kind: 'working' }
  | { readonly kind: 'done'; readonly outcome: ApplyOutcome };

const IDLE: ApplyRun = { kind: 'idle' };

interface ApplyDialogState {
  readonly open: boolean;
  readonly run: ApplyRun;
  /** Opens or closes the dialog; closing is ignored while the apply runs. */
  setOpen: (open: boolean) => void;
}

export const useApplyDialogStore = create<ApplyDialogState>()((set) => ({
  open: false,
  run: IDLE,
  setOpen: (open) => set((s) => (!open && s.run.kind === 'working' ? s : { open })),
}));

/** Applies the ticked marks with `choices`, keeping the progress and the outcome here. */
export async function runApply(choices: ApplyChoices): Promise<ApplyOutcome | undefined> {
  if (useApplyDialogStore.getState().run.kind === 'working') return undefined;
  useApplyDialogStore.setState({ run: { kind: 'working' } });
  let outcome: ApplyOutcome;
  try {
    outcome = await applyTickedRedactions(choices);
  } catch (error) {
    // applyTickedRedactions never rejects; this keeps the dialog out of "working" forever.
    outcome = { kind: 'error', message: error instanceof Error ? error.message : String(error) };
  }
  useApplyDialogStore.setState({ run: { kind: 'done', outcome } });
  return outcome;
}

/** Forgets a finished run's outcome (its sheet was seen: Back, or the dialog closed). */
export function dismissApplyOutcome(): void {
  if (useApplyDialogStore.getState().run.kind === 'done') {
    useApplyDialogStore.setState({ run: IDLE });
  }
}

/** Tests: closed, nothing running. */
export function resetApplyDialog(): void {
  useApplyDialogStore.setState({ open: false, run: IDLE });
}
