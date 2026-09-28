/**
 * Form fills as history entries (spec document-tools §1). Each action runs in the
 * annotation edit runner's serial queue (one engine, one queue): read the field from the
 * engine, execute `form.set-value` engine edits (whose inverses are read back by the
 * engine package), and commit one labelled history entry ("Fill Name", "Clear all
 * fields"). The engine regenerates the widget appearances, so pages re-render with the
 * value (edit-runner invalidates the edited pages; the form store the other widget pages).
 */
import type { EngineEdit, SourceId } from '@pdf-editor/document-model';
import type { FormField } from '@pdf-editor/engine';

import { type ActionResult, executeEdit, runAction } from '../annotations/edit-runner';
import { m } from '../i18n';
import { fillCreatedField } from './create/field-actions';
import type { ActiveField } from './form-store';

export type FieldValue = FormField['value'];

/** What the UI calls a field: its tooltip (/TU) when it has one, else its name. */
export function fieldLabel(field: FormField): string {
  const tip = field.tooltip?.trim();
  return tip !== undefined && tip !== '' ? tip : field.name;
}

function sameValue(a: FieldValue, b: FieldValue): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function formEdit(source: SourceId, field: FormField, value: FieldValue): EngineEdit {
  return {
    id: globalThis.crypto.randomUUID(),
    source,
    pageIndex: field.pageIndex,
    kind: 'form.set-value',
    payload: { name: field.name, value: value ?? null },
  };
}

/**
 * Sets one field's value as one history entry. Resolves to true when a change was
 * committed (false: unchanged, read-only, refused by the engine).
 */
export async function fillField(
  source: SourceId,
  name: string,
  value: FieldValue,
): Promise<boolean> {
  try {
    const done = await runAction(async (ctx): Promise<ActionResult<true> | undefined> => {
      const field = (await ctx.editor.listFormFields(source)).find((f) => f.name === name);
      if (!field || field.readOnly || sameValue(field.value, value)) return undefined;
      const executed = await executeEdit(ctx, formEdit(source, field, value));
      const label = m.forms_fill({ name: fieldLabel(field) });
      return { edits: [executed.recorded], label, value: true };
    });
    return done === true;
  } catch (error) {
    console.warn(`Filling ${name} failed`, error);
    return false;
  }
}

/**
 * Commits a value typed or picked in a field editor: created fields (forms/create) are
 * model operations, source fields engine edits. Resolves to whether a change was committed.
 */
export async function commitFieldValue(here: ActiveField, value: FieldValue): Promise<boolean> {
  if (here.fieldId !== undefined) return fillCreatedField(here.fieldId, value);
  if (here.source === undefined) return false;
  return fillField(here.source, here.name, value);
}

/** The value that empties a field (`{ value: undefined }`: a radio group with none on). */
export function emptyValue(field: FormField): { readonly value: FieldValue } | undefined {
  switch (field.kind) {
    case 'text':
    case 'combobox':
      return { value: '' };
    case 'checkbox':
      return { value: false };
    case 'listbox':
      return { value: field.multiSelect ? [] : '' };
    case 'radio':
      return { value: undefined };
    default:
      // Buttons and signatures have no value to empty.
      return undefined;
  }
}

function isEmpty(field: FormField): boolean {
  const v = field.value;
  return v === undefined || v === '' || v === false || (typeof v === 'object' && v.length === 0);
}

/**
 * Empties every fillable field of the given sources as one history entry ("Clear all
 * fields"). Resolves to the number of fields cleared. With `coalesceKey`, a model entry
 * pushed right after with the same key (created fields) joins this one.
 */
export async function clearAllFields(
  sources: readonly SourceId[],
  coalesceKey?: string,
): Promise<number> {
  try {
    const count = await runAction(async (ctx): Promise<ActionResult<number> | undefined> => {
      const edits: EngineEdit[] = [];
      for (const source of sources) {
        for (const field of await ctx.editor.listFormFields(source)) {
          if (field.readOnly || isEmpty(field)) continue;
          const empty = emptyValue(field);
          if (empty === undefined) continue;
          edits.push((await executeEdit(ctx, formEdit(source, field, empty.value))).recorded);
        }
      }
      if (edits.length === 0) return undefined;
      const label = m.forms_clear_all_label();
      return {
        edits,
        label,
        value: edits.length,
        ...(coalesceKey === undefined ? {} : { coalesceKey }),
      };
    });
    return count ?? 0;
  } catch (error) {
    console.warn('Clearing the form failed', error);
    return 0;
  }
}
