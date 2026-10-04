/**
 * The notice after Combine (review F8): "Combined 2 files · Undo". It stays while the combine
 * is the latest step in history (any later edit, undo or redo takes it away, so its Undo can
 * only ever undo the combine) and until it is dismissed or times out. Ctrl/Cmd+Z works as
 * well; the announcement after the combine names the shortcut.
 */
import { create } from 'zustand';

import { m } from '../i18n';
import { announce } from '../shell/announcer';
import { useWorkspaceStore } from '../state/workspace-store';

/** Which history step the notice belongs to. */
interface Step {
  readonly label: string;
  readonly at: number;
  readonly past: number;
}

interface CombinedToastState {
  readonly toast: { readonly count: number; readonly step: Step } | null;
}

export const useCombinedToast = create<CombinedToastState>(() => ({ toast: null }));

const model = () => useWorkspaceStore.getState();

function currentStep(): Step {
  const { history } = model();
  return { label: history.present.label, at: history.present.at, past: history.past.length };
}

const sameStep = (a: Step, b: Step) => a.label === b.label && a.at === b.at && a.past === b.past;

let unsubscribe: (() => void) | null = null;

/** Shows the notice for the combine that was just committed (the present history step). */
export function showCombinedToast(count: number): void {
  const step = currentStep();
  unsubscribe?.();
  useCombinedToast.setState({ toast: { count, step } });
  unsubscribe = useWorkspaceStore.subscribe((state, previous) => {
    if (state.history === previous.history) return;
    if (!sameStep(currentStep(), step)) dismissCombinedToast();
  });
}

export function dismissCombinedToast(): void {
  unsubscribe?.();
  unsubscribe = null;
  if (useCombinedToast.getState().toast !== null) useCombinedToast.setState({ toast: null });
}

/** The notice's Undo: undoes the combine, and only the combine. */
export function undoCombine(): void {
  const toast = useCombinedToast.getState().toast;
  dismissCombinedToast();
  if (toast === null || !sameStep(currentStep(), toast.step)) return;
  const label = model().undo();
  if (label) announce(m.announce_undid({ label }));
}
