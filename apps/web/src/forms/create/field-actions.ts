/**
 * Created form fields as history entries (spec redaction-and-text-editing §3). Every
 * action is one model operation through `applyOperation` on the document that holds the
 * field; values live in the model (source fields keep theirs in the engine), so filling a
 * created field is "Fill Name" like a source field, and undo / redo are snapshots.
 */
import {
  addFormField,
  addRadioButton,
  clampFieldRect,
  type CreatedField,
  type CreatedFieldKind,
  type DocumentId,
  deleteFormFields,
  duplicateFormField,
  type FieldId,
  type FieldPatch,
  findFormField,
  formFieldId,
  getActiveDocument,
  newFormField,
  nextFieldName,
  type PageId,
  type Rect,
  removeRadioButton,
  setFormFieldRect,
  setFormFieldValue,
  stepFormFieldOrder,
  updateFormField,
  type Workspace,
} from '@pdf-editor/document-model';
import type { FormField } from '@pdf-editor/engine';

import { m } from '../../i18n';
import { announce } from '../../shell/announcer';
import { useWorkspaceStore } from '../../state/workspace-store';
import { documentSources, useFormStore } from '../form-store';
import { useCreateStore } from './create-store';
import { toCreatedValue } from './field-model';

const workspace = () => useWorkspaceStore.getState().workspace;

/** The field and the document that holds it, in the current workspace. */
export function locateField(
  id: FieldId,
): { readonly document: DocumentId; readonly field: CreatedField } | undefined {
  return findFormField(workspace(), id);
}

/** A readable kind name ("text field", "checkbox", …). */
export function kindName(kind: CreatedFieldKind): string {
  switch (kind) {
    case 'text':
      return m.forms_create_kind_text();
    case 'checkbox':
      return m.forms_create_kind_checkbox();
    case 'radio':
      return m.forms_create_kind_radio();
    case 'dropdown':
      return m.forms_create_kind_dropdown();
    case 'listbox':
      return m.forms_create_kind_listbox();
    case 'signature':
      return m.forms_create_kind_signature();
    default:
      return m.forms_create_kind_button();
  }
}

/**
 * Root names of the source fields the document shows (read from the form store): an
 * automatic name avoids them so the export does not have to rename the new field.
 */
export function sourceRootNames(ws: Workspace, documentId: DocumentId): Set<string> {
  const doc = ws.documents[documentId];
  const names = new Set<string>();
  if (!doc) return names;
  const sources = useFormStore.getState().sources;
  for (const source of documentSources(doc)) {
    for (const field of sources[source]?.fields ?? []) names.add(field.name.split('.')[0] ?? '');
  }
  return names;
}

function commit(
  operation: (ws: Workspace) => Workspace,
  label: string | (() => string),
  coalesceKey?: string,
): boolean {
  return useWorkspaceStore
    .getState()
    .applyOperation(
      (ws) => operation(ws),
      label,
      coalesceKey === undefined ? undefined : { coalesceKey },
    );
}

/**
 * Adds a field of `kind` at `rect` on `pageId` (active document) under the next free
 * automatic name, selects it and turns "Edit fields" on. Resolves to its id.
 */
export function addField(kind: CreatedFieldKind, pageId: PageId, rect: Rect): FieldId | undefined {
  const doc = getActiveDocument(workspace());
  if (!doc?.pages.some((p) => p.id === pageId)) return undefined;
  const id = formFieldId(`field_${globalThis.crypto.randomUUID()}`);
  let name = '';
  const done = commit(
    (ws) => {
      const current = ws.documents[doc.id];
      const taken = new Set([
        ...(current?.fields ?? []).map((f) => f.name),
        ...sourceRootNames(ws, doc.id),
      ]);
      name = nextFieldName(kind, taken);
      return addFormField(ws, doc.id, newFormField(kind, id, name, [{ page: pageId, rect }]));
    },
    () => m.forms_create_add_label({ name }),
  );
  if (!done) return undefined;
  const store = useCreateStore.getState();
  store.setDesign(true);
  store.select({ fieldId: id, widget: 0 });
  announce(m.forms_create_added({ name }));
  return id;
}

/** Applies `operation` to the document holding `id` (no-op when the field is gone). */
function onField(
  id: FieldId,
  operation: (ws: Workspace, document: DocumentId, field: CreatedField) => Workspace,
  label: (field: CreatedField) => string,
  coalesceKey?: string,
): boolean {
  const found = locateField(id);
  if (!found) return false;
  try {
    return commit(
      (ws) => operation(ws, found.document, found.field),
      label(found.field),
      coalesceKey,
    );
  } catch (error) {
    console.warn('Changing a form field failed', error);
    return false;
  }
}

/** Changes properties (one history entry, "Edit Name"; renames say "Rename"). */
export function updateField(id: FieldId, patch: FieldPatch, coalesceKey?: string): boolean {
  return onField(
    id,
    (ws, doc) => updateFormField(ws, doc, id, patch),
    (field) =>
      patch.name !== undefined && patch.name !== field.name
        ? m.forms_create_rename_label({ name: field.name, to: patch.name })
        : m.forms_create_edit_label({ name: field.name }),
    coalesceKey,
  );
}

/**
 * Moves or resizes one widget, clamped into `bounds` (the page's visible box in user
 * space). Nudges pass a coalesce key so a run of arrow presses is one entry.
 */
export function placeWidget(
  id: FieldId,
  widget: number,
  rect: Rect,
  bounds: Rect,
  kind: 'move' | 'resize',
  coalesceKey?: string,
): boolean {
  const clamped = clampFieldRect(rect, bounds);
  return onField(
    id,
    (ws, doc) => setFormFieldRect(ws, doc, id, clamped, widget),
    (field) =>
      kind === 'move'
        ? m.forms_create_move_label({ name: field.name })
        : m.forms_create_resize_label({ name: field.name }),
    coalesceKey,
  );
}

export function deleteField(id: FieldId): boolean {
  const name = locateField(id)?.field.name ?? '';
  const done = onField(
    id,
    (ws, doc) => deleteFormFields(ws, doc, [id]),
    (field) => m.forms_create_delete_label({ name: field.name }),
  );
  if (done) {
    const store = useCreateStore.getState();
    if (store.selected?.fieldId === id) store.select(null);
    announce(m.forms_create_deleted({ name }));
  }
  return done;
}

/** Duplicates below the original (or above when there is no room) and selects the copy. */
export function duplicateField(id: FieldId, bounds: Rect): FieldId | undefined {
  const found = locateField(id);
  const first = found?.field.widgets[0];
  if (!found || !first) return undefined;
  const copy = formFieldId(`field_${globalThis.crypto.randomUUID()}`);
  const gap = 6;
  const below = first.rect.y - first.rect.height - gap;
  const dy = below >= bounds.y ? -(first.rect.height + gap) : first.rect.height + gap;
  const moved = clampFieldRect({ ...first.rect, y: first.rect.y + dy }, bounds);
  const done = onField(
    id,
    (ws, doc) =>
      duplicateFormField(ws, doc, id, copy, {
        dx: moved.x - first.rect.x,
        dy: moved.y - first.rect.y,
      }),
    (field) => m.forms_create_duplicate_label({ name: field.name }),
  );
  if (!done) return undefined;
  useCreateStore.getState().select({ fieldId: copy, widget: 0 });
  return copy;
}

/** Moves a field earlier (-1) or later (1) in the tab order of its page. */
export function stepTabOrder(id: FieldId, direction: -1 | 1): boolean {
  return onField(
    id,
    (ws, doc) => stepFormFieldOrder(ws, doc, id, direction),
    () => m.forms_create_reorder_label(),
  );
}

/** Adds a button to a radio group next to `widget` (below it, or above without room). */
export function addRadioButtonNear(id: FieldId, widget: number, bounds: Rect): boolean {
  const found = locateField(id);
  const from = found?.field.widgets[widget];
  if (!found || !from) return false;
  const gap = 6;
  const below = from.rect.y - from.rect.height - gap;
  const y = below >= bounds.y ? below : from.rect.y + from.rect.height + gap;
  const rect = clampFieldRect({ ...from.rect, y }, bounds);
  const done = onField(
    id,
    (ws, doc) => addRadioButton(ws, doc, id, { page: from.page, rect }),
    (field) => m.forms_create_edit_label({ name: field.name }),
  );
  if (done) useCreateStore.getState().select({ fieldId: id, widget: found.field.widgets.length });
  return done;
}

export function removeRadioButtonAt(id: FieldId, widget: number): boolean {
  const done = onField(
    id,
    (ws, doc) => removeRadioButton(ws, doc, id, widget),
    (field) => m.forms_create_edit_label({ name: field.name }),
  );
  if (done) useCreateStore.getState().select({ fieldId: id, widget: 0 });
  return done;
}

/** Fills a created field (one history entry, "Fill Name"). False when nothing changed. */
export function fillCreatedField(id: FieldId, value: FormField['value']): boolean {
  const found = locateField(id);
  if (!found || found.field.readOnly) return false;
  const next = toCreatedValue(found.field, value);
  if (JSON.stringify(next ?? null) === JSON.stringify(found.field.value ?? null)) return false;
  const tip = found.field.tooltip?.trim();
  const label = tip === undefined || tip === '' ? found.field.name : tip;
  return onField(
    id,
    (ws, doc) => setFormFieldValue(ws, doc, id, next),
    () => m.forms_fill({ name: label }),
  );
}

/** The value that empties a created field, or undefined for fields without a value. */
function emptyCreated(field: CreatedField): { value: CreatedField['value'] } | undefined {
  switch (field.kind) {
    case 'text':
    case 'dropdown':
      return { value: '' };
    case 'checkbox':
      return { value: false };
    case 'listbox':
      return { value: field.multiSelect ? [] : '' };
    case 'radio':
      return { value: undefined };
    default:
      return undefined;
  }
}

function isEmpty(value: CreatedField['value']): boolean {
  return (
    value === undefined ||
    value === '' ||
    value === false ||
    (typeof value === 'object' && value.length === 0)
  );
}

/**
 * Empties every fillable created field of a document. With `coalesceKey` the entry joins
 * the one the engine's "Clear all fields" pushes. Resolves to the number cleared.
 */
export function clearCreatedFields(documentId: DocumentId, coalesceKey?: string): number {
  const doc = workspace().documents[documentId];
  const targets = (doc?.fields ?? []).filter(
    (f) => !f.readOnly && !isEmpty(f.value) && emptyCreated(f) !== undefined,
  );
  if (targets.length === 0) return 0;
  const done = commit(
    (ws) =>
      targets.reduce(
        (next, field) => setFormFieldValue(next, documentId, field.id, emptyCreated(field)?.value),
        ws,
      ),
    m.forms_clear_all_label(),
    coalesceKey,
  );
  return done ? targets.length : 0;
}
