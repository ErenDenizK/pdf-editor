/**
 * The Edit policy's device settings (craft spec §3.5): "Pen draws in Edit" turns on the
 * first time a pen is seen, unless already chosen; the one-time hint is remembered; both
 * persist and are validated field by field.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_EDIT_POLICY,
  EDIT_POLICY_STORAGE_KEY,
  parseEditPolicy,
  penDrawsInEdit,
  resetEditPolicyStore,
  useEditPolicyStore,
} from './edit-policy-store';

afterEach(() => {
  resetEditPolicyStore();
  localStorage.removeItem(EDIT_POLICY_STORAGE_KEY);
});

const stored = () => JSON.parse(localStorage.getItem(EDIT_POLICY_STORAGE_KEY) ?? 'null') as unknown;

describe('edit policy settings', () => {
  it('defaults: auto, the hint not yet shown', () => {
    expect(DEFAULT_EDIT_POLICY).toEqual({ penDrawsInEdit: 'auto', editTextHintShown: false });
    expect(parseEditPolicy(undefined)).toEqual(DEFAULT_EDIT_POLICY);
  });

  it('parses field by field', () => {
    expect(parseEditPolicy({ penDrawsInEdit: false, editTextHintShown: true })).toEqual({
      penDrawsInEdit: false,
      editTextHintShown: true,
    });
    expect(parseEditPolicy({ penDrawsInEdit: 'yes', editTextHintShown: 1 })).toEqual(
      DEFAULT_EDIT_POLICY,
    );
    expect(parseEditPolicy([true])).toEqual(DEFAULT_EDIT_POLICY);
  });

  it('auto draws only once a pen has been seen; a choice wins', () => {
    expect(penDrawsInEdit({ penDrawsInEdit: 'auto' }, false)).toBe(false);
    expect(penDrawsInEdit({ penDrawsInEdit: 'auto' }, true)).toBe(true);
    expect(penDrawsInEdit({ penDrawsInEdit: false }, true)).toBe(false);
    expect(penDrawsInEdit({ penDrawsInEdit: true }, false)).toBe(true);
  });

  it('the first pen turns auto on and it is remembered; an explicit off stays off', () => {
    useEditPolicyStore.getState().notePen();
    expect(useEditPolicyStore.getState().penDrawsInEdit).toBe(true);
    expect(stored()).toEqual({ penDrawsInEdit: true, editTextHintShown: false });

    useEditPolicyStore.getState().setPenDrawsInEdit(false);
    useEditPolicyStore.getState().notePen();
    expect(useEditPolicyStore.getState().penDrawsInEdit).toBe(false);
    expect(stored()).toEqual({ penDrawsInEdit: false, editTextHintShown: false });
  });

  it('the hint, once shown to its end, is remembered', () => {
    useEditPolicyStore.getState().markEditTextHintShown();
    expect(useEditPolicyStore.getState().editTextHintShown).toBe(true);
    expect(stored()).toEqual({ penDrawsInEdit: 'auto', editTextHintShown: true });
  });
});
