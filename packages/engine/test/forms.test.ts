/**
 * AcroForm filling (spec document-tools §1, §9): listing with options, export values and
 * flags; filling every field type in forms-a / forms-b; appearances after save and
 * re-open; flattening widgets only; rotated pages; XFA detection with AcroForm widgets.
 */
import { PDFDocument, PDFName, PDFString } from '@cantoo/pdf-lib';
import type { Rect, Rotation } from '@pdf-editor/document-model';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import formsAUrl from '../../../test/fixtures/forms-a.pdf?url';
import formsBUrl from '../../../test/fixtures/forms-b.pdf?url';
import xfaUrl from '../../../test/fixtures/xfa-stub.pdf?url';
import { applyEngineEdit } from '../src/edits';
import { PdfiumAdapter } from '../src/pdfium/pdfium-adapter';
import type { FormField } from '../src/types';
import { makePdf, sid, wasmUrl } from './helpers';

let adapter: PdfiumAdapter;
let counter = 0;

const fetchBytes = async (url: string) => (await fetch(url)).arrayBuffer();

beforeAll(() => {
  adapter = new PdfiumAdapter({ wasmUrl });
});

afterAll(async () => {
  await adapter.destroy();
});

async function open(bytes: ArrayBuffer) {
  const id = sid(`forms-${++counter}`);
  const opened = await adapter.open(id, bytes);
  return { id, opened };
}

function field(fields: readonly FormField[], name: string): FormField {
  const found = fields.find((f) => f.name === name);
  if (!found) throw new Error(`no field ${name}`);
  return found;
}

/** Dark pixels (all channels < 100) of an unrotated page render inside a user-space rect. */
async function darkPixels(id: ReturnType<typeof sid>, pageIndex: number, rect: Rect) {
  const r = await adapter.renderPage(id, pageIndex, { scale: 1 });
  const canvas = new OffscreenCanvas(r.width, r.height);
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
  ctx.drawImage(r.bitmap, 0, 0);
  const data = ctx.getImageData(
    Math.round(rect.x),
    Math.round(r.height - rect.y - rect.height),
    Math.round(rect.width),
    Math.round(rect.height),
  ).data;
  let dark = 0;
  for (let i = 0; i < data.length; i += 4) {
    if ((data[i] ?? 255) < 100 && (data[i + 1] ?? 255) < 100 && (data[i + 2] ?? 255) < 100) {
      dark += 1;
    }
  }
  return dark;
}

describe('listing', () => {
  test('forms-a: kinds, values, radio export values from /Opt, options and widgets', async () => {
    const { id, opened } = await open(await fetchBytes(formsAUrl));
    expect(opened.flags.hasAcroForm).toBe(true);
    const fields = await adapter.listFormFields(id);
    expect(fields.map((f) => [f.name, f.kind, f.value, f.pageIndex])).toEqual([
      ['name', 'text', 'Alice Example', 0],
      ['agree', 'checkbox', true, 0],
      ['choice', 'radio', 'optionA', 0],
      ['country', 'combobox', 'France', 0],
      ['address.city', 'text', 'Paris', 1],
      ['only_in_a', 'text', 'Present only in forms-a', 1],
    ]);
    const choice = field(fields, 'choice');
    expect(choice.options).toEqual(['optionA', 'optionB']);
    expect(choice.exportValues).toEqual(['optionA', 'optionB']);
    expect(choice.widgets?.map((w) => w.exportValue)).toEqual(['optionA', 'optionB']);
    expect(choice.widgets?.[1]?.rect.x).toBeGreaterThan(choice.widgets?.[0]?.rect.x ?? 0);
    expect(field(fields, 'agree').exportValues).toEqual(['Yes']);
    expect(field(fields, 'country').options).toEqual([
      'Canada',
      'France',
      'Germany',
      'Japan',
      'United States',
    ]);
    const name = field(fields, 'name');
    expect(Math.abs(name.rect.x - 180)).toBeLessThanOrEqual(1);
    expect(Math.abs(name.rect.width - 240)).toBeLessThanOrEqual(2);
    expect(name.readOnly).toBe(false);
    await adapter.close(id);
  });

  test('flags: multiline, password, comb, multi-select, editable, read-only, required, tooltip', async () => {
    const bytes = await makePdf([{ size: [400, 300] }], (doc) => {
      const form = doc.getForm();
      const page = doc.getPage(0);
      const notes = form.createTextField('notes');
      notes.enableMultiline();
      notes.enableRequired();
      notes.addToPage(page, { x: 10, y: 200, width: 200, height: 60 });
      const pin = form.createTextField('pin');
      pin.enablePassword();
      pin.enableReadOnly();
      pin.addToPage(page, { x: 10, y: 160, width: 100, height: 20 });
      const code = form.createTextField('code');
      code.setMaxLength(5);
      code.enableCombing();
      code.addToPage(page, { x: 10, y: 120, width: 100, height: 20 });
      const list = form.createOptionList('tags');
      list.setOptions(['a', 'b', 'c']);
      list.enableMultiselect();
      list.select(['a', 'c']);
      list.addToPage(page, { x: 250, y: 150, width: 80, height: 60 });
      const combo = form.createDropdown('city');
      combo.setOptions(['Oslo', 'Rome']);
      combo.enableEditing();
      combo.select('Rome');
      combo.addToPage(page, { x: 250, y: 100, width: 100, height: 20 });
      const button = form.createButton('go');
      button.addToPage('Go', page, { x: 250, y: 20, width: 60, height: 24 });
      // /TU (tooltip) is not in pdf-lib's high-level API.
      notes.acroField.dict.set(PDFName.of('TU'), PDFString.of('Your notes (optional)'));
    });
    const { id } = await open(bytes);
    const fields = await adapter.listFormFields(id);
    expect(field(fields, 'notes')).toMatchObject({
      multiline: true,
      required: true,
      tooltip: 'Your notes (optional)',
    });
    expect(field(fields, 'pin')).toMatchObject({ password: true, readOnly: true });
    expect(field(fields, 'code')).toMatchObject({ kind: 'text', comb: true });
    expect(field(fields, 'tags')).toMatchObject({
      kind: 'listbox',
      multiSelect: true,
      value: ['a', 'c'],
      options: ['a', 'b', 'c'],
    });
    expect(field(fields, 'city')).toMatchObject({
      kind: 'combobox',
      editable: true,
      value: 'Rome',
    });
    expect(field(fields, 'go').kind).toBe('button');
    await expect(adapter.setFormFieldValue(id, 'pin', '1234')).rejects.toMatchObject({
      code: 'unsupported',
    });
    await adapter.setFormFieldValue(id, 'tags', ['b']);
    await adapter.setFormFieldValue(id, 'city', 'Oslo');
    const after = await adapter.listFormFields(id);
    expect(field(after, 'tags').value).toEqual(['b']);
    expect(field(after, 'city').value).toBe('Oslo');
    await adapter.close(id);
  });

  test.each([90, 180, 270] as const)(
    'widget rects on a /Rotate %i page are user space',
    async (rotation: Rotation) => {
      const bytes = await makePdf([{ size: [300, 200], rotation }], (doc) => {
        const f = doc.getForm().createTextField('r');
        f.addToPage(doc.getPage(0), { x: 20, y: 100, width: 150, height: 24 });
      });
      const { id } = await open(bytes);
      const rect = field(await adapter.listFormFields(id), 'r').rect;
      // EmbedPDF reads the /Rect up to half a point outward.
      const near = (a: number, b: number) => Math.abs(a - b) <= 1;
      expect(near(rect.x, 20) && near(rect.y, 100), JSON.stringify(rect)).toBe(true);
      expect(near(rect.width, 150) && near(rect.height, 24), JSON.stringify(rect)).toBe(true);
      await adapter.close(id);
    },
  );

  test('xfa-stub: XFA flagged, AcroForm widgets listed and fillable', async () => {
    const { id, opened } = await open(await fetchBytes(xfaUrl));
    expect(opened.flags.hasXfa).toBe(true);
    expect(opened.flags.hasAcroForm).toBe(true);
    await adapter.setFormFieldValue(id, 'name', 'Xavier');
    expect(field(await adapter.listFormFields(id), 'name').value).toBe('Xavier');
    await adapter.close(id);
  });
});

describe.each([
  ['forms-a', formsAUrl, 'optionB'],
  ['forms-b', formsBUrl, 'optionA'],
] as const)('%s: fill every field type, save, re-open', (_label, url, radio) => {
  test('values and appearances survive the round trip', async () => {
    const { id } = await open(await fetchBytes(url));
    const before = await adapter.listFormFields(id);
    const agree = field(before, 'agree').value === true;
    await adapter.setFormFieldValue(id, 'name', 'Grace Hopper');
    await adapter.setFormFieldValue(id, 'agree', !agree);
    await adapter.setFormFieldValue(id, 'choice', radio);
    await adapter.setFormFieldValue(id, 'country', 'Germany');
    await adapter.setFormFieldValue(id, 'address.city', 'Arlington');
    const saved = await adapter.save(id);
    await adapter.close(id);

    const lib = await PDFDocument.load(saved.slice(0));
    const form = lib.getForm();
    expect(form.getTextField('name').getText()).toBe('Grace Hopper');
    expect(form.getCheckBox('agree').isChecked()).toBe(!agree);
    expect(form.getRadioGroup('choice').getSelected()).toBe(radio);
    expect(form.getDropdown('country').getSelected()).toEqual(['Germany']);
    // Every text/choice widget got an appearance, so viewers need not rebuild them.
    expect(String(form.acroForm.dict.get(PDFName.of('NeedAppearances')))).toBe('false');
    for (const f of form.getFields()) {
      for (const widget of f.acroField.getWidgets()) {
        expect(widget.getNormalAppearance(), f.getName()).toBeDefined();
      }
    }

    const { id: again } = await open(saved);
    const fields = await adapter.listFormFields(again);
    expect(fields.map((f) => [f.name, f.value]).slice(0, 5)).toEqual([
      ['name', 'Grace Hopper'],
      ['agree', !agree],
      ['choice', radio],
      ['country', 'Germany'],
      ['address.city', 'Arlington'],
    ]);
    expect(await darkPixels(again, 0, field(fields, 'name').rect)).toBeGreaterThan(50);
    await adapter.close(again);
  });
});

describe('flatten', () => {
  test('flattenForms bakes widgets into the page and keeps other annotations', async () => {
    const { id } = await open(await fetchBytes(formsAUrl));
    await adapter.setFormFieldValue(id, 'name', 'Flat Name');
    await adapter.createAnnotation(id, {
      kind: 'square',
      pageIndex: 0,
      rect: { x: 40, y: 40, width: 60, height: 40 },
      strokeWidth: 2,
      color: '#E53935',
    });
    const fields = await adapter.listFormFields(id);
    const flat = await adapter.save(id, { flattenForms: true });
    await adapter.close(id);

    const lib = await PDFDocument.load(flat.slice(0));
    expect(lib.getForm().getFields()).toHaveLength(0);
    expect(lib.getPageCount()).toBe(2);

    const { id: out } = await open(flat);
    expect(await adapter.listFormFields(out)).toEqual([]);
    const annotations = await adapter.listAnnotations(out, 0);
    expect(annotations.map((a) => a.kind)).toEqual(['square']);
    // The text value and the checked checkbox are now page content.
    expect(await darkPixels(out, 0, field(fields, 'name').rect)).toBeGreaterThan(50);
    expect(await darkPixels(out, 0, field(fields, 'agree').rect)).toBeGreaterThan(5);
    expect(await darkPixels(out, 1, field(fields, 'address.city').rect)).toBeGreaterThan(20);
    const text = (await adapter.getPageText(out, 0)).map((r) => r.text).join(' ');
    expect(text).toContain('Flat Name');
    await adapter.close(out);
  });
});

describe('edits', () => {
  test('form.set-value on a radio group has a read-back inverse', async () => {
    const { id } = await open(await fetchBytes(formsAUrl));
    const undo = await applyEngineEdit(adapter, {
      id: 'r1',
      source: id,
      pageIndex: 0,
      kind: 'form.set-value',
      payload: { name: 'choice', value: 'optionB' },
    });
    expect(undo.payload).toEqual({ name: 'choice', value: 'optionA' });
    expect(field(await adapter.listFormFields(id), 'choice').value).toBe('optionB');
    await applyEngineEdit(adapter, undo);
    expect(field(await adapter.listFormFields(id), 'choice').value).toBe('optionA');
    await adapter.close(id);
  });

  test('undoing the first radio fill clears the group in the engine and the output', async () => {
    const bytes = await makePdf([{ size: [300, 200] }], (doc) => {
      const group = doc.getForm().createRadioGroup('pick');
      group.addOptionToPage('left', doc.getPage(0), { x: 20, y: 20, width: 15, height: 15 });
      group.addOptionToPage('right', doc.getPage(0), { x: 60, y: 20, width: 15, height: 15 });
    });
    const { id } = await open(bytes);
    const note = await adapter.createAnnotation(id, {
      kind: 'square',
      pageIndex: 0,
      rect: { x: 100, y: 100, width: 40, height: 30 },
      strokeWidth: 1,
    });
    expect(field(await adapter.listFormFields(id), 'pick').value).toBeUndefined();
    const undo = await applyEngineEdit(adapter, {
      id: 'first',
      source: id,
      pageIndex: 0,
      kind: 'form.set-value',
      payload: { name: 'pick', value: 'right' },
    });
    expect(undo.payload).toEqual({ name: 'pick', value: null });
    expect(field(await adapter.listFormFields(id), 'pick').value).toBe('right');

    const redo = await applyEngineEdit(adapter, undo);
    expect(field(await adapter.listFormFields(id), 'pick').value).toBeUndefined();
    // Annotation ids survive the rewrite; the group can be filled again.
    expect((await adapter.listAnnotations(id, 0)).map((a) => a.id)).toEqual([note.id]);
    const saved = await adapter.save(id);
    const lib = await PDFDocument.load(saved.slice(0));
    expect(lib.getForm().getRadioGroup('pick').getSelected()).toBeUndefined();
    for (const widget of lib.getForm().getRadioGroup('pick').acroField.getWidgets()) {
      expect(String(widget.getAppearanceState())).toBe('/Off');
    }
    await applyEngineEdit(adapter, redo);
    expect(field(await adapter.listFormFields(id), 'pick').value).toBe('right');
    await adapter.close(id);
  });

  test('a non-editable dropdown can be emptied', async () => {
    const { id } = await open(await fetchBytes(formsAUrl));
    await adapter.setFormFieldValue(id, 'name', 'Kept');
    await adapter.setFormFieldValue(id, 'country', '');
    const fields = await adapter.listFormFields(id);
    expect(field(fields, 'country').value ?? '').toBe('');
    expect(field(fields, 'name').value).toBe('Kept');
    const lib = await PDFDocument.load((await adapter.save(id)).slice(0));
    expect(lib.getForm().getDropdown('country').getSelected()).toEqual([]);
    await adapter.setFormFieldValue(id, 'country', 'Japan');
    expect(field(await adapter.listFormFields(id), 'country').value).toBe('Japan');
    await adapter.close(id);
  });

  test('checkbox accepts state names', async () => {
    const { id } = await open(await fetchBytes(formsAUrl));
    await adapter.setFormFieldValue(id, 'agree', 'Off');
    expect(field(await adapter.listFormFields(id), 'agree').value).toBe(false);
    await adapter.setFormFieldValue(id, 'agree', 'Yes');
    expect(field(await adapter.listFormFields(id), 'agree').value).toBe(true);
    await expect(adapter.setFormFieldValue(id, 'agree', 'Maybe')).rejects.toMatchObject({
      code: 'unsupported',
    });
    await adapter.close(id);
  });
});
