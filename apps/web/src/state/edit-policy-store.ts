/**
 * Settings of the Edit-mode interaction policy (craft spec §3.5), per device:
 *
 * - **"Pen draws in Edit"** (`penDrawsInEdit`): `'auto'` until a pen is first seen, which
 *   turns it on (`notePen`); then on or off as the person chooses. While on, a pen touching
 *   the page with Select armed draws with the armed preset and never hit-tests text, and a
 *   pen double-click never opens the text editor.
 * - **The one-time hint** (`editTextHintShown`): "Double-click to edit text" shows with the
 *   idle hover outline until the first double-click into the editor, and never again.
 *
 * Persisted in `pdf-editor:edit-policy:v1`, validated field by field.
 */
import { create } from 'zustand';

import { readJson, writeJson } from './safe-storage';

export const EDIT_POLICY_STORAGE_KEY = 'pdf-editor:edit-policy:v1';

export type PenDrawsInEdit = 'auto' | boolean;

export interface EditPolicySettings {
  readonly penDrawsInEdit: PenDrawsInEdit;
  readonly editTextHintShown: boolean;
}

export const DEFAULT_EDIT_POLICY: EditPolicySettings = {
  penDrawsInEdit: 'auto',
  editTextHintShown: false,
};

interface EditPolicyState extends EditPolicySettings {
  setPenDrawsInEdit(on: boolean): void;
  /** A pen was seen: "auto" becomes on (a choice already made stays). */
  notePen(): void;
  /** The hint has done its job (the first double-click into the editor). */
  markEditTextHintShown(): void;
}

/** Stored settings, field by field: anything unexpected falls back to the default. */
export function parseEditPolicy(value: unknown): EditPolicySettings {
  const record =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const pen = record.penDrawsInEdit;
  const hint = record.editTextHintShown;
  return {
    penDrawsInEdit:
      pen === 'auto' || typeof pen === 'boolean' ? pen : DEFAULT_EDIT_POLICY.penDrawsInEdit,
    editTextHintShown: typeof hint === 'boolean' ? hint : DEFAULT_EDIT_POLICY.editTextHintShown,
  };
}

export function loadEditPolicy(): EditPolicySettings {
  return parseEditPolicy(readJson(EDIT_POLICY_STORAGE_KEY));
}

export const useEditPolicyStore = create<EditPolicyState>()((set, get) => ({
  ...loadEditPolicy(),
  setPenDrawsInEdit: (on) => set({ penDrawsInEdit: on }),
  notePen: () => {
    if (get().penDrawsInEdit === 'auto') set({ penDrawsInEdit: true });
  },
  markEditTextHintShown: () => {
    if (!get().editTextHintShown) set({ editTextHintShown: true });
  },
}));

useEditPolicyStore.subscribe((state, previous) => {
  if (
    state.penDrawsInEdit === previous.penDrawsInEdit &&
    state.editTextHintShown === previous.editTextHintShown
  ) {
    return;
  }
  const settings: EditPolicySettings = {
    penDrawsInEdit: state.penDrawsInEdit,
    editTextHintShown: state.editTextHintShown,
  };
  writeJson(EDIT_POLICY_STORAGE_KEY, settings);
});

/** Whether a pen draws with Select armed: on, or still "auto" once a pen has been seen. */
export function penDrawsInEdit(
  settings: Pick<EditPolicySettings, 'penDrawsInEdit'>,
  penSeen: boolean,
): boolean {
  return settings.penDrawsInEdit === true || (settings.penDrawsInEdit === 'auto' && penSeen);
}

/** Tests: back to the defaults (or `settings`). */
export function resetEditPolicyStore(settings: Partial<EditPolicySettings> = {}): void {
  useEditPolicyStore.setState({ ...DEFAULT_EDIT_POLICY, ...settings });
}
