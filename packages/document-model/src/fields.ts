/**
 * Form fields created in this app (M4, spec redaction-and-text-editing §3): document-level
 * data like the furniture rules, referencing pages of the document by id. The assembler
 * turns them into AcroForm fields with widgets and appearances at export; the web app
 * draws them as live widgets and stores their values here (source fields keep theirs in
 * the engine).
 *
 * The array order of `VirtualDocument.fields` is the tab order of the created fields.
 * Every operation returns a new Workspace (or the same one when nothing changed), so
 * undo and redo are the history's snapshots. Page operations keep fields coherent through
 * `pruneFields` (a deleted page takes its fields along; undo brings them back) and
 * `adoptFields` (fields follow pages into another document).
 */
import { DocumentModelError } from './errors';
import {
  isArrayValue,
  isPositiveFinite,
  lookup,
  pageIndex,
  putDocuments,
  requireDocument,
  requireSource,
  withWorkspace,
} from './internal';
import { pageContentSize } from './selectors';
import type {
  CreatedField,
  CreatedFieldKind,
  CreatedFieldValue,
  CreatedFieldWidget,
  DocumentId,
  FieldAlign,
  FieldColor,
  FieldId,
  PageId,
  Rect,
  RgbColor,
  Size,
  VirtualDocument,
  VirtualPage,
  Workspace,
} from './types';

export const CREATED_FIELD_KINDS: readonly CreatedFieldKind[] = [
  'text',
  'checkbox',
  'radio',
  'dropdown',
  'listbox',
  'signature',
  'button',
];

export const FIELD_ALIGNS: readonly FieldAlign[] = ['left', 'center', 'right'];

/** The field colour palette; `none` draws nothing. */
export const FIELD_COLORS: Readonly<Record<FieldColor, RgbColor | null>> = {
  none: null,
  black: { r: 0, g: 0, b: 0 },
  gray: { r: 0.5, g: 0.5, b: 0.5 },
  blue: { r: 0.16, g: 0.32, b: 0.75 },
  red: { r: 0.8, g: 0.1, b: 0.1 },
  white: { r: 1, g: 1, b: 1 },
  'light-gray': { r: 0.93, g: 0.93, b: 0.93 },
  'light-blue': { r: 0.87, g: 0.92, b: 1 },
  'light-yellow': { r: 1, g: 0.98, b: 0.82 },
};

export const FIELD_COLOR_KEYS = Object.keys(FIELD_COLORS) as readonly FieldColor[];

/** Prefix of automatic names ("Text1", "CheckBox2", …). */
export const FIELD_NAME_PREFIX: Readonly<Record<CreatedFieldKind, string>> = {
  text: 'Text',
  checkbox: 'CheckBox',
  radio: 'RadioGroup',
  dropdown: 'Dropdown',
  listbox: 'ListBox',
  signature: 'Signature',
  button: 'Button',
};

/** Size a field gets when placed with a plain click (points, unrotated). */
export const DEFAULT_FIELD_SIZE: Readonly<Record<CreatedFieldKind, Size>> = {
  text: { width: 160, height: 22 },
  checkbox: { width: 14, height: 14 },
  radio: { width: 14, height: 14 },
  dropdown: { width: 140, height: 22 },
  listbox: { width: 140, height: 64 },
  signature: { width: 180, height: 44 },
  button: { width: 90, height: 24 },
};

/** Border width of fields with a border (points); the export and the app's look agree. */
export const FIELD_BORDER_WIDTH = 1;
/** Largest size an 'auto' font gets: single-line fields, and multi-line fields and lists. */
export const AUTO_FONT_MAX = 12;
export const AUTO_FONT_MAX_MULTILINE = 10;

/**
 * The font size a field is drawn with: its own, or for 'auto' one that fits a line in the
 * widget's upright height (inside border and padding), at most 12 pt (10 pt for multi-line
 * text and list boxes), at least 4 pt. The export draws appearances at this size and keeps
 * /DA at 0 (auto) so other viewers may refit while typing.
 */
export function fieldFontSize(field: CreatedField, uprightHeight: number): number {
  if (field.fontSize !== 'auto') return field.fontSize;
  const border = FIELD_COLORS[field.border] === null ? 0 : FIELD_BORDER_WIDTH;
  const inner = uprightHeight - 2 * (border + 1);
  const many = field.multiline === true || field.kind === 'listbox';
  const max = many ? AUTO_FONT_MAX_MULTILINE : AUTO_FONT_MAX;
  return Math.round(Math.min(max, Math.max(4, inner * 0.72)) * 10) / 10;
}

/** Smallest widget side the model accepts (points). */
export const MIN_FIELD_SIDE = 4;
export const MAX_FIELD_FONT_SIZE = 144;
export const MAX_FIELD_NAME_LENGTH = 120;
/** Tolerance of the "inside the page" invariant, in points. */
const EPSILON = 0.01;

/** Branded id constructor (only validates a non-empty string). */
export function formFieldId(value: string): FieldId {
  if (typeof value !== 'string' || value.length === 0) {
    throw new DocumentModelError('invalid-argument', 'FieldId must be a non-empty string');
  }
  return value as FieldId;
}

/** The created fields of a document, in tab order. */
export function documentFields(doc: VirtualDocument): readonly CreatedField[] {
  return doc.fields ?? [];
}

/** A field name as written: no periods (they separate name parts), no control characters. */
export function fieldNameProblem(name: string): string | undefined {
  if (typeof name !== 'string' || name.trim() === '') return 'is empty';
  if (name !== name.trim()) return 'has leading or trailing spaces';
  if (name.length > MAX_FIELD_NAME_LENGTH) return `is longer than ${MAX_FIELD_NAME_LENGTH}`;
  if (name.includes('.')) return 'contains a period';
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return 'contains control characters';
  }
  return undefined;
}

/** First free automatic name for `kind`: "Text1", then "Text2", … */
export function nextFieldName(kind: CreatedFieldKind, taken: Iterable<string>): string {
  const used = new Set(taken);
  const prefix = FIELD_NAME_PREFIX[kind];
  let n = 1;
  while (used.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

/** First free copy name: "Name_2", "Name_3", … (the assembler's rename scheme too). */
export function copyFieldName(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = name.replace(/_\d+$/, '');
  let n = 2;
  while (used.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

/** Clamps a rect into `bounds` (keeping its size when it fits, else shrinking it). */
export function clampFieldRect(rect: Rect, bounds: Rect): Rect {
  const width = Math.max(MIN_FIELD_SIDE, Math.min(rect.width, bounds.width));
  const height = Math.max(MIN_FIELD_SIDE, Math.min(rect.height, bounds.height));
  const x = Math.min(Math.max(rect.x, bounds.x), bounds.x + bounds.width - width);
  const y = Math.min(Math.max(rect.y, bounds.y), bounds.y + bounds.height - height);
  return { x, y, width, height };
}

/**
 * Where fields of a page may lie, as far as the model knows: blank and image pages span
 * `[0, 0, size]`; a source page's origin is the engine's (CropBox), so only its size is
 * known (`box` undefined).
 */
export function fieldBounds(ws: Workspace, page: VirtualPage): { box?: Rect; size: Size } {
  if (page.ref.kind !== 'source') {
    return { box: { x: 0, y: 0, ...page.ref.size }, size: page.ref.size };
  }
  const info = requireSource(ws, page.ref.source).pages[page.ref.index];
  const size = info?.size ?? pageContentSize(ws, page);
  return page.cropBox === undefined ? { size } : { size: sizeMax(size, page.cropBox) };
}

function sizeMax(a: Size, b: Size): Size {
  return { width: Math.max(a.width, b.width), height: Math.max(a.height, b.height) };
}

/** A new field with the defaults of its kind; `overrides` win. */
export function newFormField(
  kind: CreatedFieldKind,
  id: FieldId,
  name: string,
  widgets: readonly CreatedFieldWidget[],
  overrides: Partial<Omit<CreatedField, 'id' | 'kind' | 'name' | 'widgets'>> = {},
): CreatedField {
  const base: CreatedField = {
    id,
    kind,
    name,
    widgets:
      kind === 'radio'
        ? widgets.map((w, i) =>
            w.exportValue === undefined ? { ...w, exportValue: `Choice${i + 1}` } : w,
          )
        : widgets,
    fontSize: 'auto',
    border: kind === 'signature' ? 'blue' : 'gray',
    background: kind === 'button' ? 'light-gray' : 'none',
    required: false,
    readOnly: false,
    align: kind === 'button' ? 'center' : 'left',
  };
  const defaults: Partial<CreatedField> =
    kind === 'dropdown' || kind === 'listbox'
      ? { options: ['Option 1', 'Option 2', 'Option 3'] }
      : kind === 'button'
        ? { label: 'Button' }
        : kind === 'checkbox'
          ? { value: false }
          : {};
  return { ...base, ...defaults, ...overrides };
}

// ---------------------------------------------------------------------------
// Validation (shared by the operations and the invariants)
// ---------------------------------------------------------------------------

function isList(value: CreatedFieldValue): value is readonly string[] {
  return typeof value === 'object';
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function valueProblem(field: CreatedField, value: CreatedFieldValue, what: string): string[] {
  const out: string[] = [];
  const options = field.options ?? [];
  switch (field.kind) {
    case 'text':
      if (typeof value !== 'string') out.push(`${what} must be text`);
      else if (field.maxLength !== undefined && value.length > field.maxLength) {
        out.push(`${what} is longer than the maximum length`);
      }
      break;
    case 'checkbox':
      if (typeof value !== 'boolean') out.push(`${what} must be true or false`);
      break;
    case 'radio':
      if (typeof value !== 'string' || !field.widgets.some((w) => w.exportValue === value)) {
        out.push(`${what} must be the export value of one of its buttons`);
      }
      break;
    case 'dropdown':
      if (typeof value !== 'string') out.push(`${what} must be text`);
      else if (!field.editable && value !== '' && !options.includes(value)) {
        out.push(`${what} is not one of the options`);
      }
      break;
    case 'listbox':
      if (field.multiSelect) {
        if (
          !isList(value) ||
          value.some((v) => typeof v !== 'string' || !options.includes(v)) ||
          new Set(value).size !== value.length
        ) {
          out.push(`${what} must be distinct options`);
        }
      } else if (typeof value !== 'string' || (value !== '' && !options.includes(value))) {
        out.push(`${what} is not one of the options`);
      }
      break;
    default:
      out.push(`${what}: ${field.kind} fields have no value`);
  }
  return out;
}

/**
 * Problems of one field on its own (widgets are checked against pages by
 * `fieldPlacementProblems`). Empty when the field is valid.
 */
export function fieldProblems(field: CreatedField): string[] {
  const out: string[] = [];
  const what = `field "${field.name}"`;
  if (!CREATED_FIELD_KINDS.includes(field.kind)) out.push(`${what}: unknown kind`);
  const nameProblem = fieldNameProblem(field.name);
  if (nameProblem !== undefined) out.push(`${what}: name ${nameProblem}`);
  if (!isArrayValue(field.widgets) || field.widgets.length === 0) {
    out.push(`${what}: has no widget`);
  } else if (field.kind !== 'radio' && field.widgets.length !== 1) {
    out.push(`${what}: ${field.kind} fields have exactly one widget`);
  }
  for (const [i, w] of (field.widgets ?? []).entries()) {
    const r = w.rect;
    if (
      !r ||
      !Number.isFinite(r.x) ||
      !Number.isFinite(r.y) ||
      !isPositiveFinite(r.width) ||
      !isPositiveFinite(r.height)
    ) {
      out.push(`${what}: widget ${i + 1} has an invalid rect`);
    }
    if (field.kind === 'radio') {
      if (typeof w.exportValue !== 'string' || w.exportValue.trim() === '') {
        out.push(`${what}: radio button ${i + 1} has no export value`);
      }
    } else if (w.exportValue !== undefined) {
      out.push(`${what}: only radio buttons have export values`);
    }
  }
  if (field.kind === 'radio') {
    const values = field.widgets.map((w) => w.exportValue);
    if (new Set(values).size !== values.length) {
      out.push(`${what}: radio export values must be distinct`);
    }
  }
  if (
    field.fontSize !== 'auto' &&
    !(isPositiveFinite(field.fontSize) && field.fontSize <= MAX_FIELD_FONT_SIZE)
  ) {
    out.push(`${what}: font size must be 'auto' or within 0…${MAX_FIELD_FONT_SIZE}`);
  }
  if (!(field.border in FIELD_COLORS) || !(field.background in FIELD_COLORS)) {
    out.push(`${what}: unknown colour`);
  }
  if (!FIELD_ALIGNS.includes(field.align)) out.push(`${what}: unknown alignment`);
  if (typeof field.required !== 'boolean' || typeof field.readOnly !== 'boolean') {
    out.push(`${what}: required and readOnly must be booleans`);
  }
  if (field.tooltip !== undefined && typeof field.tooltip !== 'string') {
    out.push(`${what}: tooltip must be text`);
  }
  const textOnly = ['multiline', 'comb', 'maxLength'] as const;
  if (field.kind !== 'text' && textOnly.some((k) => field[k] !== undefined)) {
    out.push(`${what}: multiline, comb and maxLength apply to text fields only`);
  }
  if (field.maxLength !== undefined) {
    if (!(Number.isSafeInteger(field.maxLength) && field.maxLength > 0)) {
      out.push(`${what}: maxLength must be a positive integer`);
    }
  }
  if (field.comb === true && (field.maxLength === undefined || field.multiline === true)) {
    out.push(`${what}: a comb field needs a maximum length and a single line`);
  }
  const choice = field.kind === 'dropdown' || field.kind === 'listbox';
  if (choice) {
    const options = field.options;
    if (!isArrayValue(options) || options === undefined || options.length === 0) {
      out.push(`${what}: a choice field needs at least one option`);
    } else if (
      options.some((o) => typeof o !== 'string' || o.trim() === '') ||
      new Set(options).size !== options.length
    ) {
      out.push(`${what}: options must be distinct and not empty`);
    }
  } else if (field.options !== undefined) {
    out.push(`${what}: only dropdowns and list boxes have options`);
  }
  if (field.multiSelect !== undefined && field.kind !== 'listbox') {
    out.push(`${what}: multiSelect applies to list boxes only`);
  }
  if (field.editable !== undefined && field.kind !== 'dropdown') {
    out.push(`${what}: editable applies to dropdowns only`);
  }
  if (field.label !== undefined && field.kind !== 'button') {
    out.push(`${what}: only push buttons have a label`);
  }
  if (field.value !== undefined) out.push(...valueProblem(field, field.value, `${what}: value`));
  if (field.defaultValue !== undefined) {
    out.push(...valueProblem(field, field.defaultValue, `${what}: default value`));
  }
  return out;
}

/** Problems of a field's widgets against the document's pages. */
function fieldPlacementProblems(
  ws: Workspace,
  doc: VirtualDocument,
  field: CreatedField,
  pagesById: ReadonlyMap<PageId, VirtualPage>,
): string[] {
  const out: string[] = [];
  for (const [i, w] of field.widgets.entries()) {
    const page = pagesById.get(w.page);
    const what = `field "${field.name}" widget ${i + 1}`;
    if (page === undefined) {
      out.push(`${what}: page ${String(w.page)} is not in document ${doc.id}`);
      continue;
    }
    let bounds: { box?: Rect; size: Size };
    try {
      bounds = fieldBounds(ws, page);
    } catch {
      continue; // A dangling source is reported by the page checks.
    }
    const r = w.rect;
    if (!r || !isPositiveFinite(r.width) || !isPositiveFinite(r.height)) continue;
    if (bounds.box) {
      const b = bounds.box;
      if (
        r.x < b.x - EPSILON ||
        r.y < b.y - EPSILON ||
        r.x + r.width > b.x + b.width + EPSILON ||
        r.y + r.height > b.y + b.height + EPSILON
      ) {
        out.push(`${what}: rect lies outside the page`);
      }
    } else if (r.width > bounds.size.width + EPSILON || r.height > bounds.size.height + EPSILON) {
      out.push(`${what}: rect is larger than the page`);
    }
  }
  return out;
}

/** Every problem of a document's created fields (invariants.ts). */
export function documentFieldProblems(ws: Workspace, doc: VirtualDocument): string[] {
  const fields = doc.fields;
  if (fields === undefined) return [];
  if (!isArrayValue(fields)) return [`document ${doc.id}: fields must be an array`];
  const out: string[] = [];
  const pagesById = new Map(doc.pages.map((p) => [p.id, p] as const));
  const ids = new Set<FieldId>();
  const names = new Set<string>();
  for (const field of fields) {
    if (ids.has(field.id)) out.push(`document ${doc.id}: field id ${field.id} is used twice`);
    ids.add(field.id);
    if (names.has(field.name)) {
      out.push(`document ${doc.id}: field name "${field.name}" is used twice`);
    }
    names.add(field.name);
    for (const p of fieldProblems(field)) out.push(`document ${doc.id}: ${p}`);
    for (const p of fieldPlacementProblems(ws, doc, field, pagesById)) {
      out.push(`document ${doc.id}: ${p}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

function requireField(doc: VirtualDocument, id: FieldId): { field: CreatedField; index: number } {
  const fields = documentFields(doc);
  const index = fields.findIndex((f) => f.id === id);
  const field = fields[index];
  if (field === undefined) {
    throw new DocumentModelError('invalid-argument', `Unknown field ${String(id)} in ${doc.id}`);
  }
  return { field, index };
}

function withFields(
  ws: Workspace,
  doc: VirtualDocument,
  fields: readonly CreatedField[],
): Workspace {
  const { fields: _old, ...rest } = doc;
  const next: VirtualDocument =
    fields.length === 0 ? { ...rest, clean: false } : { ...rest, fields, clean: false };
  // Validates the whole set (names, placement) against the pages.
  const problems = documentFieldProblems(ws, next);
  if (problems.length > 0) {
    throw new DocumentModelError('invalid-argument', problems.join('; '));
  }
  return withWorkspace(ws, { documents: putDocuments(ws.documents, [next]) });
}

/**
 * Adds a field (built with `newFormField`) at `index` of the tab order (default: last).
 * The name must be unique among the document's created fields; widgets must lie on pages
 * of the document.
 */
export function addFormField(
  ws: Workspace,
  documentId: DocumentId,
  field: CreatedField,
  index?: number,
): Workspace {
  const doc = requireDocument(ws, documentId);
  const fields = documentFields(doc);
  if (fields.some((f) => f.id === field.id)) {
    throw new DocumentModelError('duplicate-id', `Field id already in use: ${String(field.id)}`);
  }
  const at = index ?? fields.length;
  if (!Number.isInteger(at) || at < 0 || at > fields.length) {
    throw new DocumentModelError('invalid-index', `Field index ${at} outside 0…${fields.length}`);
  }
  return withFields(ws, doc, [...fields.slice(0, at), field, ...fields.slice(at)]);
}

/**
 * Properties `updateFormField` changes. An explicit `undefined` removes an optional
 * property (e.g. `maxLength: undefined`).
 */
export type FieldPatch = {
  readonly [K in keyof Omit<CreatedField, 'id' | 'kind'>]?: CreatedField[K] | undefined;
};

/**
 * Keeps values consistent after a property change: values that are no longer options go,
 * a list box that stops being multi-select keeps its first selection, text is cut to the
 * maximum length.
 */
function normalizeValues(field: CreatedField): CreatedField {
  const fix = (value: CreatedFieldValue | undefined): CreatedFieldValue | undefined => {
    if (value === undefined) return undefined;
    const options = field.options ?? [];
    switch (field.kind) {
      case 'text':
        if (typeof value !== 'string') return undefined;
        return field.maxLength !== undefined && value.length > field.maxLength
          ? value.slice(0, field.maxLength)
          : value;
      case 'listbox':
        if (field.multiSelect) {
          const list = isList(value) ? value : typeof value === 'string' ? [value] : [];
          const kept = [...new Set(list.filter((v) => options.includes(v)))];
          return isList(value) && sameStrings(kept, value) ? value : kept;
        }
        if (isList(value)) return value.find((v) => options.includes(v)) ?? '';
        return typeof value === 'string' && (value === '' || options.includes(value))
          ? value
          : undefined;
      case 'dropdown':
        return typeof value === 'string' &&
          (field.editable || value === '' || options.includes(value))
          ? value
          : undefined;
      case 'radio':
        return typeof value === 'string' && field.widgets.some((w) => w.exportValue === value)
          ? value
          : undefined;
      default:
        return value;
    }
  };
  let next = field;
  for (const key of ['value', 'defaultValue'] as const) {
    const before = next[key];
    const after = fix(before);
    if (after === before) continue;
    if (after === undefined) {
      const { [key]: _gone, ...rest } = next;
      next = rest;
    } else {
      next = { ...next, [key]: after };
    }
  }
  if (next.kind === 'text' && next.comb === true && next.multiline === true) {
    next = { ...next, multiline: false };
  }
  return next;
}

/** Changes properties of a field (rename included); see `FieldPatch`. */
export function updateFormField(
  ws: Workspace,
  documentId: DocumentId,
  id: FieldId,
  patch: FieldPatch,
): Workspace {
  const doc = requireDocument(ws, documentId);
  const { field, index } = requireField(doc, id);
  const removed = new Set<string>();
  const draft = new Map<string, unknown>(Object.entries(field));
  let changed = false;
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'id' || key === 'kind') continue;
    if (value === undefined) {
      if (draft.has(key)) {
        removed.add(key);
        changed = true;
      }
    } else if (JSON.stringify(draft.get(key)) !== JSON.stringify(value)) {
      draft.set(key, value);
      changed = true;
    }
  }
  if (!changed) return ws;
  const next = normalizeValues(
    Object.fromEntries([...draft].filter(([key]) => !removed.has(key))) as unknown as CreatedField,
  );
  const fields = documentFields(doc).map((f, i) => (i === index ? next : f));
  return withFields(ws, doc, fields);
}

/** Sets a field's value (what filling it in the app does); `undefined` empties it. */
export function setFormFieldValue(
  ws: Workspace,
  documentId: DocumentId,
  id: FieldId,
  value: CreatedFieldValue | undefined,
): Workspace {
  const doc = requireDocument(ws, documentId);
  const { field } = requireField(doc, id);
  if (field.kind === 'signature' || field.kind === 'button') {
    throw new DocumentModelError('invalid-argument', `${field.kind} fields have no value`);
  }
  if (value !== undefined) {
    const problems = valueProblem(field, value, `field "${field.name}": value`);
    if (problems.length > 0) throw new DocumentModelError('invalid-argument', problems.join('; '));
  }
  return updateFormField(ws, documentId, id, { value });
}

/** Moves or resizes one widget (`widget` indexes `field.widgets`; 0 for one-widget fields). */
export function setFormFieldRect(
  ws: Workspace,
  documentId: DocumentId,
  id: FieldId,
  rect: Rect,
  widget = 0,
): Workspace {
  const doc = requireDocument(ws, documentId);
  const { field } = requireField(doc, id);
  const current = field.widgets[widget];
  if (current === undefined) {
    throw new DocumentModelError('invalid-index', `Field ${field.name} has no widget ${widget}`);
  }
  const r = current.rect;
  if (r.x === rect.x && r.y === rect.y && r.width === rect.width && r.height === rect.height) {
    return ws;
  }
  const widgets = field.widgets.map((w, i) =>
    i === widget
      ? { ...w, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }
      : w,
  );
  return updateFormField(ws, documentId, id, { widgets });
}

/** Removes fields (unknown ids throw). */
export function deleteFormFields(
  ws: Workspace,
  documentId: DocumentId,
  ids: readonly FieldId[],
): Workspace {
  const doc = requireDocument(ws, documentId);
  if (ids.length === 0) return ws;
  for (const id of ids) requireField(doc, id);
  const gone = new Set(ids);
  return withFields(
    ws,
    doc,
    documentFields(doc).filter((f) => !gone.has(f.id)),
  );
}

/**
 * Duplicates a field under `newId` right after it in the tab order, named `Name_2` (the
 * first free copy name), its widgets shifted by `offset` (points; kept inside the page by
 * the caller). The copy starts with the original's value.
 */
export function duplicateFormField(
  ws: Workspace,
  documentId: DocumentId,
  id: FieldId,
  newId: FieldId,
  offset: { readonly dx: number; readonly dy: number } = { dx: 0, dy: 0 },
): Workspace {
  const doc = requireDocument(ws, documentId);
  const { field, index } = requireField(doc, id);
  const fields = documentFields(doc);
  const copy: CreatedField = {
    ...field,
    id: newId,
    name: copyFieldName(
      field.name,
      fields.map((f) => f.name),
    ),
    widgets: field.widgets.map((w) => ({
      ...w,
      rect: { ...w.rect, x: w.rect.x + offset.dx, y: w.rect.y + offset.dy },
    })),
  };
  return addFormField(ws, documentId, copy, index + 1);
}

/** Sets the tab order; `order` must be a permutation of the document's field ids. */
export function reorderFormFields(
  ws: Workspace,
  documentId: DocumentId,
  order: readonly FieldId[],
): Workspace {
  const doc = requireDocument(ws, documentId);
  const fields = documentFields(doc);
  const byId = new Map(fields.map((f) => [f.id, f] as const));
  if (order.length !== fields.length || new Set(order).size !== order.length) {
    throw new DocumentModelError('invalid-argument', 'Order must be a permutation of the fields');
  }
  const next = order.map((id) => {
    const field = byId.get(id);
    if (field === undefined) {
      throw new DocumentModelError('invalid-argument', `Unknown field ${String(id)}`);
    }
    return field;
  });
  if (next.every((f, i) => f === fields[i])) return ws;
  return withFields(ws, doc, next);
}

/**
 * Moves a field one step earlier (-1) or later (1) in the tab order among the created
 * fields that share its first widget's page (what the Forms panel shows). No-op at the ends.
 */
export function stepFormFieldOrder(
  ws: Workspace,
  documentId: DocumentId,
  id: FieldId,
  direction: -1 | 1,
): Workspace {
  const doc = requireDocument(ws, documentId);
  const { field, index } = requireField(doc, id);
  const fields = [...documentFields(doc)];
  const page = field.widgets[0]?.page;
  let other = index + direction;
  while (other >= 0 && other < fields.length && fields[other]?.widgets[0]?.page !== page) {
    other += direction;
  }
  const swap = fields[other];
  if (swap === undefined) return ws;
  fields[other] = field;
  fields[index] = swap;
  return withFields(ws, doc, fields);
}

/** Adds a button to a radio group (its export value defaults to the next "ChoiceN"). */
export function addRadioButton(
  ws: Workspace,
  documentId: DocumentId,
  id: FieldId,
  widget: CreatedFieldWidget,
): Workspace {
  const doc = requireDocument(ws, documentId);
  const { field } = requireField(doc, id);
  if (field.kind !== 'radio') {
    throw new DocumentModelError('invalid-argument', 'Only radio groups take more buttons');
  }
  let exportValue = widget.exportValue;
  if (exportValue === undefined) {
    const taken = new Set(field.widgets.map((w) => w.exportValue));
    let n = field.widgets.length + 1;
    while (taken.has(`Choice${n}`)) n++;
    exportValue = `Choice${n}`;
  }
  return updateFormField(ws, documentId, id, {
    widgets: [...field.widgets, { ...widget, exportValue }],
  });
}

/** Removes one button of a radio group; the last button cannot go (delete the field). */
export function removeRadioButton(
  ws: Workspace,
  documentId: DocumentId,
  id: FieldId,
  widget: number,
): Workspace {
  const doc = requireDocument(ws, documentId);
  const { field } = requireField(doc, id);
  if (field.kind !== 'radio' || field.widgets[widget] === undefined) {
    throw new DocumentModelError('invalid-index', `No radio button ${widget} in ${field.name}`);
  }
  if (field.widgets.length === 1) {
    throw new DocumentModelError('invalid-argument', 'A radio group needs at least one button');
  }
  return updateFormField(ws, documentId, id, {
    widgets: field.widgets.filter((_, i) => i !== widget),
  });
}

/** Finds a created field by id across the workspace's documents. */
export function findFormField(
  ws: Workspace,
  id: FieldId,
): { readonly document: DocumentId; readonly field: CreatedField } | undefined {
  for (const doc of Object.values<VirtualDocument>(ws.documents)) {
    const field = doc.fields?.find((f) => f.id === id);
    if (field) return { document: doc.id, field };
  }
  return undefined;
}

/** Created fields with a widget on `pageId`, with the widget indices there. */
export function fieldsOnPage(
  ws: Workspace,
  pageId: PageId,
): { readonly document: DocumentId; readonly field: CreatedField; readonly widget: number }[] {
  const location = pageIndex(ws).get(pageId);
  if (location === undefined) return [];
  const doc = lookup(ws.documents, location.document);
  const out: { document: DocumentId; field: CreatedField; widget: number }[] = [];
  for (const field of doc?.fields ?? []) {
    field.widgets.forEach((w, widget) => {
      if (w.page === pageId) out.push({ document: location.document, field, widget });
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Page operations (pages.ts)
// ---------------------------------------------------------------------------

/**
 * Drops widgets on pages that are not live, and fields left without widgets. Returns the
 * input when nothing changed.
 */
export function pruneFields(
  fields: readonly CreatedField[] | undefined,
  live: ReadonlySet<PageId>,
): readonly CreatedField[] | undefined {
  if (fields === undefined) return undefined;
  let changed = false;
  const out: CreatedField[] = [];
  for (const field of fields) {
    const widgets = field.widgets.filter((w) => live.has(w.page));
    if (widgets.length === field.widgets.length) {
      out.push(field);
      continue;
    }
    changed = true;
    if (widgets.length === 0) continue;
    const kept = { ...field, widgets };
    // A radio value whose button went away is no longer a valid value.
    out.push(normalizeValues(kept));
  }
  return changed ? out : fields;
}

/**
 * Fields `incoming` joined after `existing` (merge, interleave, pages moved into a
 * document): names taken by earlier fields get the next copy name (`Name_2`); duplicate ids
 * cannot occur (every id lives in one document).
 */
export function joinFields(
  existing: readonly CreatedField[] | undefined,
  incoming: readonly CreatedField[] | undefined,
): readonly CreatedField[] | undefined {
  if (incoming === undefined || incoming.length === 0) return existing;
  const out = [...(existing ?? [])];
  const names = new Set(out.map((f) => f.name));
  for (const field of incoming) {
    const name = names.has(field.name) ? copyFieldName(field.name, names) : field.name;
    names.add(name);
    out.push(name === field.name ? field : { ...field, name });
  }
  return out;
}

/** `doc` with `fields` (the key omitted when there are none). */
export function withDocumentFields(
  doc: VirtualDocument,
  fields: readonly CreatedField[] | undefined,
): VirtualDocument {
  if (fields === doc.fields) return doc;
  const { fields: _old, ...rest } = doc;
  return fields === undefined || fields.length === 0 ? rest : { ...rest, fields };
}

/** Fields of `doc` all of whose widgets are on `pages`. */
export function fieldsWithin(
  doc: VirtualDocument,
  pages: ReadonlySet<PageId>,
): readonly CreatedField[] {
  return documentFields(doc).filter((f) => f.widgets.every((w) => pages.has(w.page)));
}
