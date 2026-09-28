/**
 * Materializes the form fields created in the app (`VirtualDocument.fields`, document-model
 * fields.ts) as AcroForm fields of the output (spec redaction-and-text-editing §3). Runs
 * inside the assembler's AcroForm reconciliation, after the source fields were merged into
 * the output's /AcroForm:
 *
 * - Each field is built with pdf-lib's form API (`createTextField`, `createCheckBox`, …),
 *   which writes the field, its widgets (/Rect, /P, /MK with border, background and
 *   rotation, /BS, /F Print) and their appearance streams (/AP, on/off states for check
 *   boxes and radio buttons). Signature placeholders are written by hand: an unsigned
 *   /FT /Sig field with a widget and a plain box appearance (this app does not sign).
 * - Field flags (/Ff: required, read-only, multiline, comb, radio, combo, edit, multi-
 *   select, no-toggle-to-off), /MaxLen, /Opt, /TU, /Q, /DA (Helvetica, fixed size or 0 for
 *   auto), /V and /DV are written; /DR gets Helvetica when it has no font by that name.
 * - Widget rects are the model's (unrotated user space of the page's content), mapped
 *   through the page's resize matrix; /MK /R is the page's total rotation, so the field
 *   reads upright as the page is displayed.
 * - Tab order: fields are appended to /Fields and their widgets to the page's /Annots in
 *   the model's order (the created fields' tab order); pages keep their /Tabs.
 * - Names that collide with a source field at the root follow the document's form merge
 *   policy: `unify-same-name` joins a compatible field (one field, the source's value;
 *   `join`), otherwise the created field is renamed `name_2` (`name_3`, …) and reported.
 * - Values with characters Helvetica (WinAnsi) cannot encode get their appearance from a
 *   bundled font (`fontFor`); /DA keeps Helvetica.
 * - With `flatten`, each created widget's current appearance is drawn into the page and
 *   the field removed (the source fields are flattened by PDFium before assembly).
 */

import {
  degrees,
  drawObject,
  PDFArray,
  PDFDict,
  type PDFDocument,
  type PDFField,
  type PDFFont,
  PDFHexString,
  PDFName,
  PDFNumber,
  type PDFPage,
  PDFRef,
  PDFStream,
  PDFString,
  type PDFTextField,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  TextAlignment,
  translate,
} from '@cantoo/pdf-lib';
import {
  type CreatedField,
  type CreatedFieldKind,
  FIELD_BORDER_WIDTH,
  FIELD_COLORS,
  fieldFontSize,
  type FieldColor,
  type PageId,
  type Rect,
  type Rotation,
} from '@pdf-editor/document-model';

import type { FormFieldKind } from '../types';
import { ENGINE_KIND } from './created-field-kinds';
import { type ResizeMatrix, transformRect } from './page-resize';

/** pdf-lib does not export its widget options type. */
type FieldAppearanceOptions = NonNullable<Parameters<PDFTextField['addToPage']>[1]>;

/** Where a page of the virtual document landed in the output. */
export interface CreatedFieldPage {
  readonly page: PDFPage;
  /** 0-based output page index. */
  readonly index: number;
  /** Total rotation of the output page. */
  readonly rotation: Rotation;
  /** Resized pages: the matrix from the page's content box into the new page. */
  readonly matrix?: ResizeMatrix;
}

export interface CreatedFieldsInput {
  readonly out: PDFDocument;
  /** In tab order. */
  readonly fields: readonly CreatedField[];
  readonly pages: ReadonlyMap<PageId, CreatedFieldPage>;
  readonly policy: 'namespace-by-source' | 'rename-collisions' | 'unify-same-name';
  /**
   * Helvetica, or a bundled font when Helvetica cannot encode `text` (see `winAnsiText`).
   * Called only for fields whose appearance shows text, so nothing is embedded unused.
   */
  readonly fontFor: (text: string) => Promise<PDFFont>;
  /** The standard Helvetica for /DR (called only when fields are written, not flattened). */
  readonly helvetica: () => Promise<PDFFont>;
  readonly warn: (message: string) => void;
  /**
   * Joins the created field `created` into the source field `target` (same name, same
   * type) under `unify-same-name`; returns false when they cannot be joined.
   */
  readonly join: (target: PDFRef, created: PDFRef, name: string) => boolean;
  readonly flatten: boolean;
}

/** A created field as written (for the report and the verification expectation). */
export interface WrittenField {
  readonly name: string;
  readonly kind: FormFieldKind;
  readonly pageIndices: readonly number[];
}

export interface CreatedFieldsResult {
  readonly written: readonly WrittenField[];
  readonly renamed: readonly { readonly from: string; readonly to: string }[];
  readonly unified: readonly string[];
  /** Widgets drawn into page content (`flatten`). */
  readonly flattened: number;
  /** Fields left out (their pages are not in the output). */
  readonly skipped: number;
}

const K = {
  AcroForm: PDFName.of('AcroForm'),
  AP: PDFName.of('AP'),
  AS: PDFName.of('AS'),
  DA: PDFName.of('DA'),
  DR: PDFName.of('DR'),
  DV: PDFName.of('DV'),
  F: PDFName.of('F'),
  Ff: PDFName.of('Ff'),
  Fields: PDFName.of('Fields'),
  Font: PDFName.of('Font'),
  FT: PDFName.of('FT'),
  Kids: PDFName.of('Kids'),
  N: PDFName.of('N'),
  Off: PDFName.of('Off'),
  Opt: PDFName.of('Opt'),
  Q: PDFName.of('Q'),
  T: PDFName.of('T'),
  TU: PDFName.of('TU'),
};

const FF_READ_ONLY = 1;
const FF_REQUIRED = 2;
const FF_RADIO = 1 << 15;
const FF_PUSHBUTTON = 1 << 16;
const FF_COMBO = 1 << 17;

/** Font key the created fields' /DA names (standard Helvetica in /DR). */
export const FIELD_FONT_KEY = 'Helvetica';

const QUADDING: Readonly<Record<CreatedField['align'], number>> = { left: 0, center: 1, right: 2 };
const ALIGNMENT: Readonly<Record<CreatedField['align'], TextAlignment>> = {
  left: TextAlignment.Left,
  center: TextAlignment.Center,
  right: TextAlignment.Right,
};

function color(key: FieldColor) {
  const c = FIELD_COLORS[key];
  return c ? rgb(c.r, c.g, c.b) : undefined;
}

/**
 * pdf-lib's widget box for an exact /Rect: `createWidget` grows the box by the border
 * width and, for rotated widgets, takes the width and height as seen upright with the
 * origin at a different corner (pdf-lib `rotateRectangle`). This inverts that mapping.
 */
export function pdfLibBox(
  rect: Rect,
  borderWidth: number,
  rotation: Rotation,
): { x: number; y: number; width: number; height: number } {
  const b = borderWidth / 2;
  const quarter = rotation === 90 || rotation === 270;
  const width = (quarter ? rect.height : rect.width) - borderWidth;
  const height = (quarter ? rect.width : rect.height) - borderWidth;
  switch (rotation) {
    case 90:
      return { x: rect.x + rect.width - b, y: rect.y + b, width, height };
    case 180:
      return { x: rect.x + rect.width - b, y: rect.y + rect.height - b, width, height };
    case 270:
      return { x: rect.x + b, y: rect.y + rect.height - b, width, height };
    default:
      return { x: rect.x + b, y: rect.y + b, width, height };
  }
}

function fieldNameOf(dict: PDFDict): string | undefined {
  const t = dict.lookup(K.T);
  return t instanceof PDFString || t instanceof PDFHexString ? t.decodeText() : undefined;
}

/** Root field names of the output's /AcroForm with their refs. */
function rootFields(out: PDFDocument): Map<string, PDFRef> {
  const names = new Map<string, PDFRef>();
  const acroForm = out.context.lookupMaybe(out.catalog.get(K.AcroForm), PDFDict);
  const fields = acroForm ? out.context.lookupMaybe(acroForm.get(K.Fields), PDFArray) : undefined;
  for (const item of fields?.asArray() ?? []) {
    if (!(item instanceof PDFRef)) continue;
    const dict = out.context.lookupMaybe(item, PDFDict);
    const name = dict ? fieldNameOf(dict) : undefined;
    if (name !== undefined && !names.has(name)) names.set(name, item);
  }
  return names;
}

/** Makes sure /DR /Font has Helvetica under FIELD_FONT_KEY. */
function ensureDefaultResources(out: PDFDocument, helvetica: PDFFont): void {
  const { context } = out;
  const acroForm = context.lookup(out.catalog.get(K.AcroForm), PDFDict);
  let dr = context.lookupMaybe(acroForm.get(K.DR), PDFDict);
  if (!dr) {
    dr = context.obj({});
    acroForm.set(K.DR, dr);
  }
  let fonts = context.lookupMaybe(dr.get(K.Font), PDFDict);
  if (!fonts) {
    fonts = context.obj({});
    dr.set(K.Font, fonts);
  }
  if (!fonts.get(PDFName.of(FIELD_FONT_KEY))) fonts.set(PDFName.of(FIELD_FONT_KEY), helvetica.ref);
  if (!acroForm.get(K.DA)) acroForm.set(K.DA, PDFString.of(`/${FIELD_FONT_KEY} 0 Tf 0 g`));
}

/** /DA of a field: its size, or 0 for auto (viewers fit the text while typing). */
function defaultAppearance(
  field: CreatedField,
  size = field.fontSize === 'auto' ? 0 : field.fontSize,
): string {
  return `/${FIELD_FONT_KEY} ${size} Tf 0 g`;
}

function setFlags(dict: PDFDict, set: number): void {
  const current = dict.lookup(K.Ff);
  const flags = current instanceof PDFNumber ? current.asNumber() : 0;
  dict.set(K.Ff, PDFNumber.of(flags | set));
}

function textOf(value: CreatedField['value']): string {
  if (value === undefined || typeof value === 'boolean') return '';
  return typeof value === 'string' ? value : value.join(' ');
}

/** Everything whose appearance shows text: value, options, button label. */
function shownText(field: CreatedField): string {
  return [textOf(field.value), ...(field.options ?? []), field.label ?? ''].join('');
}

/** A plain box appearance for a signature placeholder (background, border, a baseline). */
function signatureAppearance(
  out: PDFDocument,
  field: CreatedField,
  rect: Rect,
  rotation: Rotation,
): PDFRef {
  const quarter = rotation === 90 || rotation === 270;
  const w = quarter ? rect.height : rect.width;
  const h = quarter ? rect.width : rect.height;
  const ops: string[] = [];
  // Rotate the upright drawing into the widget (same matrices as pdf-lib's rotateInPlace).
  if (rotation === 90) ops.push(`0 1 -1 0 ${rect.width} 0 cm`);
  else if (rotation === 180) ops.push(`-1 0 0 -1 ${rect.width} ${rect.height} cm`);
  else if (rotation === 270) ops.push(`0 -1 1 0 0 ${rect.height} cm`);
  const bg = FIELD_COLORS[field.background];
  if (bg) ops.push(`${bg.r} ${bg.g} ${bg.b} rg 0 0 ${w} ${h} re f`);
  const border = FIELD_COLORS[field.border];
  if (border) {
    const b = FIELD_BORDER_WIDTH;
    ops.push(
      `${border.r} ${border.g} ${border.b} RG ${b} w ${b / 2} ${b / 2} ${w - b} ${h - b} re S`,
    );
  }
  const line = FIELD_COLORS[field.border] ?? { r: 0.5, g: 0.5, b: 0.5 };
  const y = Math.max(3, h * 0.28);
  ops.push(`${line.r} ${line.g} ${line.b} RG 0.75 w ${w * 0.08} ${y} m ${w * 0.92} ${y} l S`);
  const stream = out.context.stream(ops.join('\n'), {
    Type: 'XObject',
    Subtype: 'Form',
    BBox: [0, 0, rect.width, rect.height],
  });
  return out.context.register(stream);
}

/** Writes an unsigned signature field (/FT /Sig) with its widgets. */
function addSignatureField(
  out: PDFDocument,
  field: CreatedField,
  name: string,
  placements: readonly { target: CreatedFieldPage; rect: Rect }[],
): PDFRef {
  const { context } = out;
  const fieldDict = context.obj({ FT: 'Sig', T: PDFHexString.fromText(name) });
  const fieldRef = context.register(fieldDict);
  const kids: PDFRef[] = [];
  for (const { target, rect } of placements) {
    const bc = FIELD_COLORS[field.border];
    const bg = FIELD_COLORS[field.background];
    const mk = context.obj({ R: target.rotation });
    if (bc) mk.set(PDFName.of('BC'), context.obj([bc.r, bc.g, bc.b]));
    if (bg) mk.set(PDFName.of('BG'), context.obj([bg.r, bg.g, bg.b]));
    const widget = context.obj({
      Type: 'Annot',
      Subtype: 'Widget',
      Rect: [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height],
      F: 4,
      P: target.page.ref,
      Parent: fieldRef,
      MK: mk,
      BS: { W: bc ? FIELD_BORDER_WIDTH : 0, S: 'S' },
      AP: { N: signatureAppearance(out, field, rect, target.rotation) },
    });
    const widgetRef = context.register(widget);
    kids.push(widgetRef);
    target.page.node.addAnnot(widgetRef);
  }
  fieldDict.set(K.Kids, context.obj(kids));
  const acroForm = context.lookup(out.catalog.get(K.AcroForm), PDFDict);
  let fields = context.lookupMaybe(acroForm.get(K.Fields), PDFArray);
  if (!fields) {
    fields = context.obj([]);
    acroForm.set(K.Fields, fields);
  }
  fields.push(fieldRef);
  return fieldRef;
}

/** Same kind of terminal field as `kind` (for `unify-same-name`). */
function compatibleWith(out: PDFDocument, ref: PDFRef, kind: CreatedFieldKind): boolean {
  const dict = out.context.lookupMaybe(ref, PDFDict);
  if (!dict) return false;
  const kids = dict.lookup(K.Kids);
  if (kids instanceof PDFArray) {
    const hasFieldKids = kids
      .asArray()
      .some((k) => k instanceof PDFRef && out.context.lookupMaybe(k, PDFDict)?.get(K.T));
    if (hasFieldKids) return false;
  }
  const ft = dict.lookup(K.FT);
  const ffValue = dict.lookup(K.Ff);
  const ff = ffValue instanceof PDFNumber ? ffValue.asNumber() : 0;
  switch (kind) {
    case 'text':
      return ft === PDFName.of('Tx');
    case 'checkbox':
      return ft === PDFName.of('Btn') && (ff & (FF_RADIO | FF_PUSHBUTTON)) === 0;
    case 'radio':
      return ft === PDFName.of('Btn') && (ff & FF_RADIO) !== 0;
    case 'button':
      return ft === PDFName.of('Btn') && (ff & FF_PUSHBUTTON) !== 0;
    case 'dropdown':
      return ft === PDFName.of('Ch') && (ff & FF_COMBO) !== 0;
    case 'listbox':
      return ft === PDFName.of('Ch') && (ff & FF_COMBO) === 0;
    case 'signature':
      return ft === PDFName.of('Sig');
    default:
      return false;
  }
}

/** Smallest `${base}_${n}` (n >= 2) not in `taken`. */
function uniqueName(base: string, taken: ReadonlySet<string>): string {
  let n = 2;
  while (taken.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

/** The appearance a viewer shows for a widget now (for flattening). */
function currentAppearance(out: PDFDocument, widget: PDFDict): PDFRef | undefined {
  const ap = out.context.lookupMaybe(widget.get(K.AP), PDFDict);
  let normal = ap?.get(K.N);
  const resolved = normal === undefined ? undefined : out.context.lookup(normal);
  if (resolved instanceof PDFDict && !(resolved instanceof PDFStream)) {
    const state = out.context.lookupMaybe(widget.get(K.AS), PDFName) ?? K.Off;
    normal = resolved.get(state);
  }
  return normal instanceof PDFRef ? normal : undefined;
}

/** Draws a created field's widgets into their pages and removes the field. */
function flattenField(out: PDFDocument, fieldRef: PDFRef): number {
  const { context } = out;
  let drawn = 0;
  for (const widgetRef of widgetRefs(out, fieldRef)) {
    const widget = context.lookup(widgetRef, PDFDict);
    const pageRef = widget.get(PDFName.of('P'));
    const page = out.getPages().find((p) => p.ref === pageRef);
    const appearance = currentAppearance(out, widget);
    // Nothing of the widget may stay behind unreachable (redaction's forensic check).
    for (const ref of appearanceRefs(out, widget)) if (ref !== appearance) context.delete(ref);
    context.delete(widgetRef);
    if (!page) continue;
    const rect = context.lookupMaybe(widget.get(PDFName.of('Rect')), PDFArray);
    if (appearance && rect) {
      const [x1, y1] = [0, 1].map((i) => (context.lookup(rect.get(i)) as PDFNumber).asNumber());
      const key = page.node.newXObject('FlatField', appearance);
      page.pushOperators(
        pushGraphicsState(),
        translate(x1 ?? 0, y1 ?? 0),
        drawObject(key),
        popGraphicsState(),
      );
      drawn += 1;
    }
    page.node.removeAnnot(widgetRef);
  }
  const acroForm = context.lookup(out.catalog.get(K.AcroForm), PDFDict);
  const fields = context.lookupMaybe(acroForm.get(K.Fields), PDFArray);
  const at = fields?.indexOf(fieldRef);
  if (fields && at !== undefined && at >= 0) fields.remove(at);
  context.delete(fieldRef);
  return drawn;
}

/** Sets /V and /DV of a pdf-lib field from the model (text-like fields). */
function setDefault(dict: PDFDict, value: CreatedField['defaultValue']): void {
  if (value === undefined || typeof value === 'boolean') return;
  dict.set(
    K.DV,
    typeof value === 'string'
      ? PDFHexString.fromText(value)
      : dict.context.obj(value.map((v) => PDFHexString.fromText(v))),
  );
}

/** Characters of Windows-1252 (WinAnsi) above 0x7e that are not Latin-1. */
const WIN_ANSI_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');

/** Whether the standard Helvetica (WinAnsi) can show `text` (line breaks aside). */
export function winAnsiText(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x0a || code === 0x0d || code === 0x09) continue;
    if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) continue;
    if (!WIN_ANSI_EXTRA.has(char)) return false;
  }
  return true;
}

/** Every appearance stream a widget's /AP names (normal, rollover, down; all states). */
function appearanceRefs(out: PDFDocument, widget: PDFDict): PDFRef[] {
  const ap = out.context.lookupMaybe(widget.get(K.AP), PDFDict);
  const refs: PDFRef[] = [];
  for (const [, entry] of ap?.entries() ?? []) {
    const resolved = out.context.lookup(entry);
    if (entry instanceof PDFRef && resolved instanceof PDFStream) refs.push(entry);
    else if (resolved instanceof PDFDict && !(resolved instanceof PDFStream)) {
      for (const [, state] of resolved.entries()) if (state instanceof PDFRef) refs.push(state);
    }
  }
  return refs;
}

/** Widget refs of a field (its /Kids, or itself when merged). */
function widgetRefs(out: PDFDocument, fieldRef: PDFRef): PDFRef[] {
  const field = out.context.lookup(fieldRef, PDFDict);
  const kids = out.context.lookupMaybe(field.get(K.Kids), PDFArray);
  return (kids?.asArray() ?? [fieldRef]).filter((k): k is PDFRef => k instanceof PDFRef);
}

async function buildField(
  input: CreatedFieldsInput,
  field: CreatedField,
  name: string,
  placements: readonly { target: CreatedFieldPage; rect: Rect }[],
): Promise<PDFRef> {
  const { out } = input;
  const form = out.getForm();
  if (field.kind === 'signature') return addSignatureField(out, field, name, placements);

  const hasBorder = FIELD_COLORS[field.border] !== null;
  const borderWidth = hasBorder ? FIELD_BORDER_WIDTH : 0;
  const shown = shownText(field);
  // Check boxes and radio buttons draw paths: no font is embedded for them.
  const needsFont = field.kind !== 'checkbox' && field.kind !== 'radio';
  const font = needsFont ? await input.fontFor(shown) : undefined;
  if (needsFont && !winAnsiText(shown)) {
    input.warn(
      'Some form field text uses characters Helvetica cannot encode; its appearance uses a bundled font',
    );
  }
  const optionsFor = (target: CreatedFieldPage, rect: Rect): FieldAppearanceOptions => {
    // pdf-lib fills in white / black for colour keys that are absent; a present
    // `undefined` means none, hence the untyped record.
    const options: Record<string, unknown> = {
      ...pdfLibBox(rect, borderWidth, target.rotation),
      rotate: degrees(target.rotation),
      textColor: rgb(0, 0, 0),
      backgroundColor: color(field.background),
      borderColor: color(field.border),
      borderWidth,
      font,
    };
    return options;
  };
  // Appearances are drawn at the size the app shows (`fieldFontSize`); /DA gets the
  // field's own size (0 for auto) once they are generated.
  const firstPlacement = placements[0];
  const upright =
    firstPlacement === undefined
      ? 20
      : firstPlacement.target.rotation === 90 || firstPlacement.target.rotation === 270
        ? firstPlacement.rect.width
        : firstPlacement.rect.height;
  const drawDA = defaultAppearance(field, fieldFontSize(field, upright));
  let made: PDFField;
  switch (field.kind) {
    case 'text': {
      const text = form.createTextField(name);
      text.acroField.setDefaultAppearance(drawDA);
      if (field.maxLength !== undefined) text.setMaxLength(field.maxLength);
      if (field.multiline) text.enableMultiline();
      if (field.comb) text.enableCombing();
      text.setAlignment(ALIGNMENT[field.align]);
      if (typeof field.value === 'string' && field.value !== '') text.setText(field.value);
      setDefault(text.acroField.dict, field.defaultValue);
      for (const p of placements) text.addToPage(p.target.page, optionsFor(p.target, p.rect));
      made = text;
      break;
    }
    case 'checkbox': {
      const box = form.createCheckBox(name);
      box.acroField.setDefaultAppearance(drawDA);
      for (const p of placements) box.addToPage(p.target.page, optionsFor(p.target, p.rect));
      if (field.value === true) box.check();
      else box.uncheck();
      if (field.defaultValue !== undefined) {
        box.acroField.dict.set(K.DV, field.defaultValue === true ? PDFName.of('Yes') : K.Off);
      }
      made = box;
      break;
    }
    case 'radio': {
      const group = form.createRadioGroup(name);
      group.acroField.setDefaultAppearance(drawDA);
      group.disableOffToggling();
      for (const [i, p] of placements.entries()) {
        const widget = field.widgets[i];
        group.addOptionToPage(
          widget?.exportValue ?? `Choice${i + 1}`,
          p.target.page,
          optionsFor(p.target, p.rect),
        );
      }
      if (typeof field.value === 'string') group.select(field.value);
      else group.clear();
      if (typeof field.defaultValue === 'string') {
        const index = field.widgets.findIndex((w) => w.exportValue === field.defaultValue);
        const onValues = group.acroField.getOnValues();
        const on = onValues[index];
        if (on) group.acroField.dict.set(K.DV, on);
      }
      made = group;
      break;
    }
    case 'dropdown': {
      const dropdown = form.createDropdown(name);
      dropdown.acroField.setDefaultAppearance(drawDA);
      dropdown.setOptions([...(field.options ?? [])]);
      if (field.editable) dropdown.enableEditing();
      dropdown.acroField.dict.set(K.Q, PDFNumber.of(QUADDING[field.align]));
      if (typeof field.value === 'string' && field.value !== '') dropdown.select(field.value);
      setDefault(dropdown.acroField.dict, field.defaultValue);
      for (const p of placements) dropdown.addToPage(p.target.page, optionsFor(p.target, p.rect));
      made = dropdown;
      break;
    }
    case 'listbox': {
      const list = form.createOptionList(name);
      list.acroField.setDefaultAppearance(drawDA);
      list.setOptions([...(field.options ?? [])]);
      if (field.multiSelect) list.enableMultiselect();
      list.acroField.dict.set(K.Q, PDFNumber.of(QUADDING[field.align]));
      const selected =
        typeof field.value === 'string'
          ? field.value === ''
            ? []
            : [field.value]
          : typeof field.value === 'object'
            ? [...field.value]
            : [];
      if (selected.length > 0) list.select(selected);
      setDefault(list.acroField.dict, field.defaultValue);
      for (const p of placements) list.addToPage(p.target.page, optionsFor(p.target, p.rect));
      made = list;
      break;
    }
    case 'button': {
      const button = form.createButton(name);
      button.acroField.setDefaultAppearance(drawDA);
      button.acroField.dict.set(K.Q, PDFNumber.of(QUADDING[field.align]));
      for (const p of placements) {
        button.addToPage(field.label ?? '', p.target.page, optionsFor(p.target, p.rect));
      }
      made = button;
      break;
    }
    default:
      throw new Error(`Unknown field kind ${String(field.kind)}`);
  }
  const dict = made.acroField.dict;
  if (field.tooltip !== undefined && field.tooltip !== '') {
    dict.set(K.TU, PDFHexString.fromText(field.tooltip));
  }
  let flags = 0;
  if (field.readOnly) flags |= FF_READ_ONLY;
  if (field.required && field.kind !== 'button') flags |= FF_REQUIRED;
  if (flags !== 0) setFlags(dict, flags);
  // pdf-lib rewrites /DA with the appearance font's resource name; /DA names the /DR font.
  dict.set(K.DA, PDFString.of(defaultAppearance(field)));
  return made.ref;
}

/** Adds the created fields to the output's /AcroForm (which must exist). */
export async function addCreatedFields(input: CreatedFieldsInput): Promise<CreatedFieldsResult> {
  const { out, fields, pages } = input;
  const written: WrittenField[] = [];
  const renamed: { from: string; to: string }[] = [];
  const unified: string[] = [];
  let flattened = 0;
  let skipped = 0;
  if (fields.length === 0) return { written, renamed, unified, flattened, skipped };
  if (!input.flatten) ensureDefaultResources(out, await input.helvetica());
  const roots = rootFields(out);
  const taken = new Set(roots.keys());
  const made: PDFRef[] = [];
  for (const field of fields) {
    const placements = field.widgets.flatMap((w) => {
      const target = pages.get(w.page);
      if (!target) return [];
      const rect = target.matrix ? transformRect(target.matrix, w.rect) : w.rect;
      return [{ target, rect }];
    });
    if (placements.length === 0 || placements.length !== field.widgets.length) {
      // The assembler writes what it is given; fields with a widget on a missing page do
      // not occur (the model prunes them), so this only guards odd inputs.
      skipped += 1;
      if (placements.length === 0) continue;
    }
    const clash = roots.get(field.name);
    let name = field.name;
    let joinTarget: PDFRef | undefined;
    if (clash !== undefined || taken.has(name)) {
      if (
        input.policy === 'unify-same-name' &&
        clash !== undefined &&
        compatibleWith(out, clash, field.kind)
      ) {
        joinTarget = clash;
        name = uniqueName(`${field.name}__created`, taken);
      } else {
        name = uniqueName(field.name, taken);
        renamed.push({ from: field.name, to: name });
        if (input.policy === 'unify-same-name' && clash !== undefined) {
          input.warn(
            'Some fields with equal names differ in type and were renamed instead of joined',
          );
        }
      }
    }
    taken.add(name);
    const ref = await buildField(input, field, name, placements);
    const pageIndices = placements.map((p) => p.target.index);
    // Joining text and choice widgets drops their appearance (the shared value is laid
    // out by viewers, /NeedAppearances): delete the streams so none is left unreachable.
    const dropped =
      joinTarget !== undefined && field.kind !== 'checkbox' && field.kind !== 'radio'
        ? widgetRefs(out, ref).flatMap((w) => appearanceRefs(out, out.context.lookup(w, PDFDict)))
        : [];
    if (joinTarget !== undefined && input.join(joinTarget, ref, field.name)) {
      for (const stream of dropped) out.context.delete(stream);
      unified.push(field.name);
      written.push({ name: field.name, kind: ENGINE_KIND[field.kind], pageIndices });
      continue;
    }
    if (joinTarget !== undefined) {
      // Could not join after all: keep it under a proper unique name.
      const fallback = uniqueName(field.name, taken);
      taken.add(fallback);
      out.context.lookup(ref, PDFDict).set(K.T, PDFHexString.fromText(fallback));
      renamed.push({ from: field.name, to: fallback });
      name = fallback;
    }
    made.push(ref);
    written.push({ name, kind: ENGINE_KIND[field.kind], pageIndices });
  }
  if (input.flatten) {
    for (const ref of made) flattened += flattenField(out, ref);
    // An /AcroForm left without fields goes too.
    const acroFormRef = out.catalog.get(K.AcroForm);
    const acroForm = out.context.lookupMaybe(acroFormRef, PDFDict);
    const remaining = acroForm
      ? out.context.lookupMaybe(acroForm.get(K.Fields), PDFArray)
      : undefined;
    if (acroForm && (remaining?.size() ?? 0) === 0) {
      out.catalog.delete(K.AcroForm);
      if (acroFormRef instanceof PDFRef) out.context.delete(acroFormRef);
    }
  }
  return { written: input.flatten ? [] : written, renamed, unified, flattened, skipped };
}
