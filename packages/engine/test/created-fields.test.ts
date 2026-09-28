/**
 * Form fields created in the app (spec redaction-and-text-editing §3): the assembler
 * writes them as AcroForm fields with widgets and appearances (created-fields.ts), onto
 * source and blank pages; re-opened with the PDFium adapter they list with their kinds,
 * names, values and pages, fill and save like any field, flatten into visible content,
 * and meet source fields of the same name according to the form merge policy.
 */
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber } from '@cantoo/pdf-lib';
import {
  type CreatedField,
  type CreatedFieldKind,
  type FormMergePolicy,
  formFieldId,
  newFormField,
  type PageId,
  type Rect,
  type SourceId,
  type VirtualDocument,
} from '@pdf-editor/document-model';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import formsAUrl from '../../../test/fixtures/forms-a.pdf?url';
import rotatedUrl from '../../../test/fixtures/rotated-pages.pdf?url';
import simpleUrl from '../../../test/fixtures/simple-text.pdf?url';
import { ENGINE_KIND } from '../src/pdflib/created-field-kinds';
import { pdfLibBox, winAnsiText } from '../src/pdflib/created-fields';
import { unreachableFindings } from '../src/redaction/forensic-objects';
import { PdfiumAdapter } from '../src/pdfium/pdfium-adapter';
import { PdfLibAssembler } from '../src/pdflib/pdflib-assembler';
import type { FormField } from '../src/types';
import { pid, sid, vdoc, vpage, wasmUrl } from './helpers';

let adapter: PdfiumAdapter;
const assembler = new PdfLibAssembler();
let counter = 0;
const fetchBytes = async (url: string) => (await fetch(url)).arrayBuffer();
const SIMPLE = sid('simple-text');

beforeAll(() => {
  adapter = new PdfiumAdapter({ wasmUrl });
});

afterAll(async () => {
  await adapter.destroy();
});

const src = pid('created-src');
const blank = pid('created-blank');

/** simple-text page 1 (Letter) and a blank A5 page. */
function pages() {
  return [
    vpage({ kind: 'source', source: SIMPLE, index: 0 }, { id: src }),
    vpage({ kind: 'blank', size: { width: 420, height: 595 } }, { id: blank }),
  ];
}

let fieldCounter = 0;
function made(
  kind: CreatedFieldKind,
  name: string,
  page: PageId,
  rect: Rect,
  extra: Partial<CreatedField> = {},
): CreatedField {
  return newFormField(kind, formFieldId(`fld-${++fieldCounter}`), name, [{ page, rect }], extra);
}

/** One field of every kind, on the source page and the blank page. */
function everyKind(): CreatedField[] {
  return [
    made(
      'text',
      'FullName',
      src,
      { x: 72, y: 600, width: 200, height: 22 },
      {
        value: 'Ada Lovelace',
        tooltip: 'Your full name',
        required: true,
      },
    ),
    made(
      'text',
      'Notes',
      src,
      { x: 72, y: 480, width: 240, height: 80 },
      {
        multiline: true,
        value: 'Line one\nLine two',
        fontSize: 10,
      },
    ),
    made(
      'text',
      'Code',
      src,
      { x: 72, y: 440, width: 120, height: 22 },
      {
        maxLength: 6,
        comb: true,
        value: 'AB12',
      },
    ),
    made('checkbox', 'Agree', src, { x: 72, y: 400, width: 14, height: 14 }, { value: true }),
    {
      ...made('radio', 'Size', src, { x: 72, y: 360, width: 14, height: 14 }),
      widgets: [
        { page: src, rect: { x: 72, y: 360, width: 14, height: 14 }, exportValue: 'Small' },
        { page: src, rect: { x: 100, y: 360, width: 14, height: 14 }, exportValue: 'Large' },
      ],
      value: 'Large',
    },
    made(
      'dropdown',
      'Country',
      blank,
      { x: 40, y: 500, width: 150, height: 22 },
      {
        options: ['France', 'Japan', 'Türkiye'],
        value: 'Japan',
      },
    ),
    made(
      'listbox',
      'Colours',
      blank,
      { x: 40, y: 400, width: 150, height: 60 },
      {
        options: ['Red', 'Green', 'Blue'],
        multiSelect: true,
        value: ['Red', 'Blue'],
      },
    ),
    made('signature', 'Signature', blank, { x: 40, y: 300, width: 180, height: 44 }),
    made(
      'button',
      'Submit',
      blank,
      { x: 40, y: 240, width: 90, height: 24 },
      {
        label: 'Submit',
        readOnly: true,
      },
    ),
  ];
}

async function assemble(
  doc: VirtualDocument,
  sources: ReadonlyMap<SourceId, ArrayBuffer>,
  options: { flattenForms?: boolean } = {},
) {
  return assembler.assemble({ document: doc, sources, blobs: new Map() }, options);
}

async function reopen(bytes: ArrayBuffer) {
  const id = sid(`created-${++counter}`);
  await adapter.open(id, bytes.slice(0));
  return id;
}

function byName(fields: readonly FormField[], name: string): FormField {
  const found = fields.find((f) => f.name === name);
  if (!found) throw new Error(`no field ${name} in ${fields.map((f) => f.name).join(', ')}`);
  return found;
}

/** Dark pixels (all channels < 110) of an unrotated page render inside a user-space rect. */
async function darkPixels(id: SourceId, pageIndex: number, rect: Rect): Promise<number> {
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
    if ((data[i] ?? 255) < 110 && (data[i + 1] ?? 255) < 110 && (data[i + 2] ?? 255) < 110) {
      dark += 1;
    }
  }
  return dark;
}

describe('created fields: every kind on a source page and a blank page', () => {
  test('re-open lists kinds, names, values, flags and pages; verification passes', async () => {
    const fields = everyKind();
    const doc = vdoc(pages(), { fields });
    const { bytes, report } = await assemble(doc, new Map([[SIMPLE, await fetchBytes(simpleUrl)]]));
    expect(report.createdFields?.map((f) => f.name)).toEqual(fields.map((f) => f.name));
    expect(report.formFieldsRenamed).toEqual([]);

    const id = await reopen(bytes);
    const listed = await adapter.listFormFields(id);
    expect(listed.map((f) => [f.name, f.kind, f.pageIndex]).sort()).toEqual(
      fields.map((f) => [f.name, ENGINE_KIND[f.kind], f.widgets[0]?.page === src ? 0 : 1]).sort(),
    );
    expect(byName(listed, 'FullName')).toMatchObject({
      value: 'Ada Lovelace',
      tooltip: 'Your full name',
      required: true,
    });
    expect(byName(listed, 'Notes')).toMatchObject({ multiline: true, value: 'Line one\nLine two' });
    // /MaxLen is on the field (the adapter reports it from widgets only; see below).
    expect(byName(listed, 'Code')).toMatchObject({ comb: true, value: 'AB12' });
    expect(byName(listed, 'Agree').value).toBe(true);
    const size = byName(listed, 'Size');
    expect(size.value).toBe('Large');
    expect(size.widgets?.map((w) => w.exportValue)).toEqual(['Small', 'Large']);
    expect(byName(listed, 'Country')).toMatchObject({
      value: 'Japan',
      options: ['France', 'Japan', 'Türkiye'],
    });
    expect(byName(listed, 'Colours')).toMatchObject({ multiSelect: true, value: ['Red', 'Blue'] });
    expect(byName(listed, 'Submit').readOnly).toBe(true);
    // An unsigned placeholder: no signer, no date (the adapter pairs every /Sig field with
    // PDFium's signature list, which counts unsigned fields too, hence an empty object).
    expect(byName(listed, 'Signature').signature?.signer).toBeUndefined();
    expect(byName(listed, 'Signature').signature?.date).toBeUndefined();

    // Widget rects are the model's.
    const fullName = byName(listed, 'FullName');
    expect(fullName.rect.x).toBeCloseTo(72, 0);
    expect(fullName.rect.y).toBeCloseTo(600, 0);
    expect(fullName.rect.width).toBeCloseTo(200, 0);
    expect(fullName.rect.height).toBeCloseTo(22, 0);

    // Appearances: the value, the check mark and the selected radio button are drawn.
    expect(await darkPixels(id, 0, { x: 74, y: 602, width: 150, height: 18 })).toBeGreaterThan(20);
    expect(await darkPixels(id, 0, { x: 74, y: 402, width: 10, height: 10 })).toBeGreaterThan(8);
    expect(await darkPixels(id, 0, { x: 102, y: 362, width: 10, height: 10 })).toBeGreaterThan(8);
    await adapter.close(id);

    const verified = await adapter.verify(bytes.slice(0), {
      pageCount: 2,
      pageSizes: [
        { width: 612, height: 792 },
        { width: 420, height: 595 },
      ],
      createdFields: fields.map((f) => ({
        name: f.name,
        kind: ENGINE_KIND[f.kind],
        pageIndices: f.widgets.map((w) => (w.page === src ? 0 : 1)),
      })),
    });
    expect(verified).toEqual({ ok: true, problems: [] });
  });

  test('the AcroForm carries /DR Helvetica, /DA, /Q, /MaxLen, /Opt and the tab order', async () => {
    const fields = everyKind();
    const { bytes } = await assemble(
      vdoc(pages(), { fields }),
      new Map([[SIMPLE, await fetchBytes(simpleUrl)]]),
    );
    const out = await PDFDocument.load(bytes);
    const acroForm = out.catalog.lookup(PDFName.of('AcroForm'), PDFDict);
    const dr = acroForm.lookup(PDFName.of('DR'), PDFDict);
    expect(dr.lookup(PDFName.of('Font'), PDFDict).get(PDFName.of('Helvetica'))).toBeDefined();
    const form = out.getForm();
    expect(form.getFields().map((f) => f.getName())).toEqual(fields.map((f) => f.name));
    const notes = form.getTextField('Notes');
    expect(notes.acroField.getDefaultAppearance()).toBe('/Helvetica 10 Tf 0 g');
    expect(form.getTextField('FullName').acroField.getDefaultAppearance()).toBe(
      '/Helvetica 0 Tf 0 g',
    );
    expect(form.getTextField('Code').getMaxLength()).toBe(6);
    expect(form.getDropdown('Country').getOptions()).toEqual(['France', 'Japan', 'Türkiye']);
    // Widgets of the source page follow the created fields' order after its own annotations.
    const annots = out.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
    const names = annots.asArray().map((ref) => {
      const widget = out.context.lookup(ref, PDFDict);
      const parent = widget.lookupMaybe(PDFName.of('Parent'), PDFDict) ?? widget;
      return parent.lookup(PDFName.of('T'), PDFHexString).decodeText();
    });
    expect(names).toEqual(['FullName', 'Notes', 'Code', 'Agree', 'Size', 'Size']);
    expect(notes.acroField.dict.lookup(PDFName.of('Q'))).toEqual(PDFNumber.of(0));
  });

  test('a filled created field fills and saves like any field (round trip)', async () => {
    const fields = [made('text', 'City', src, { x: 72, y: 600, width: 200, height: 22 })];
    const { bytes } = await assemble(
      vdoc(pages(), { fields }),
      new Map([[SIMPLE, await fetchBytes(simpleUrl)]]),
    );
    const id = await reopen(bytes);
    await adapter.setFormFieldValue(id, 'City', 'İstanbul');
    const saved = await adapter.save(id);
    await adapter.close(id);
    const again = await reopen(saved);
    expect(byName(await adapter.listFormFields(again), 'City').value).toBe('İstanbul');
    await adapter.close(again);
  });

  test('flattenForms draws the created fields into the pages and writes no field', async () => {
    const fields = everyKind();
    const { bytes, report } = await assemble(
      vdoc(pages(), { fields }),
      new Map([[SIMPLE, await fetchBytes(simpleUrl)]]),
      { flattenForms: true },
    );
    expect(report.createdFields).toEqual([]);
    const id = await reopen(bytes);
    expect(await adapter.listFormFields(id)).toEqual([]);
    expect(await adapter.listAnnotations(id, 0)).toEqual([]);
    // The value and the check mark are page content now.
    expect(await darkPixels(id, 0, { x: 74, y: 602, width: 150, height: 18 })).toBeGreaterThan(20);
    expect(await darkPixels(id, 0, { x: 74, y: 402, width: 10, height: 10 })).toBeGreaterThan(8);
    expect(await darkPixels(id, 1, { x: 42, y: 242, width: 86, height: 20 })).toBeGreaterThan(10);
    await adapter.close(id);
  });

  test('non-WinAnsi values get a bundled font appearance and a warning', async () => {
    const fields = [
      made('text', 'Ad', blank, { x: 40, y: 500, width: 200, height: 22 }, { value: 'Şişli Ğ' }),
    ];
    const { bytes, report } = await assemble(
      vdoc([vpage({ kind: 'blank', size: { width: 420, height: 595 } }, { id: blank })], {
        fields,
      }),
      new Map(),
    );
    expect(report.warnings.join()).toMatch(/Helvetica cannot encode/);
    const id = await reopen(bytes);
    expect(byName(await adapter.listFormFields(id), 'Ad').value).toBe('Şişli Ğ');
    expect(await darkPixels(id, 0, { x: 42, y: 502, width: 150, height: 18 })).toBeGreaterThan(20);
    await adapter.close(id);
  });
});

/** Objects of the output nothing refers to (the redaction self-check's rule). */
async function unreachable(bytes: ArrayBuffer): Promise<string[]> {
  const doc = await PDFDocument.load(bytes.slice(0), { updateMetadata: false });
  return unreachableFindings(doc).map((f) => `${f.where}: ${f.detail}`);
}

describe('created fields leave nothing unreachable', () => {
  test('an export without created fields embeds no field font or form', async () => {
    const { bytes } = await assemble(
      vdoc(pages()),
      new Map([[SIMPLE, await fetchBytes(simpleUrl)]]),
    );
    const out = await PDFDocument.load(bytes);
    expect(out.catalog.get(PDFName.of('AcroForm'))).toBeUndefined();
    expect(await unreachable(bytes)).toEqual([]);
    const fonts = out.context
      .enumerateIndirectObjects()
      .filter(([, o]) => o instanceof PDFDict && o.get(PDFName.of('Type')) === PDFName.of('Font'));
    const source = await PDFDocument.load(await fetchBytes(simpleUrl));
    const sourceFonts = source.context
      .enumerateIndirectObjects()
      .filter(([, o]) => o instanceof PDFDict && o.get(PDFName.of('Type')) === PDFName.of('Font'));
    expect(fonts.length).toBe(sourceFonts.length);
  });

  test('written, flattened and joined fields leave no unreachable object', async () => {
    const sources = new Map([[SIMPLE, await fetchBytes(simpleUrl)]]);
    const written = await assemble(vdoc(pages(), { fields: everyKind() }), sources);
    expect(await unreachable(written.bytes)).toEqual([]);
    const flat = await assemble(vdoc(pages(), { fields: everyKind() }), sources, {
      flattenForms: true,
    });
    expect(await unreachable(flat.bytes)).toEqual([]);
    expect(
      (await PDFDocument.load(flat.bytes)).catalog.get(PDFName.of('AcroForm')),
    ).toBeUndefined();
    // Check boxes alone flattened: no font at all.
    const boxes = await assemble(
      vdoc(pages(), {
        fields: [
          made('checkbox', 'Only', src, { x: 72, y: 400, width: 14, height: 14 }, { value: true }),
        ],
      }),
      sources,
      { flattenForms: true },
    );
    expect(await unreachable(boxes.bytes)).toEqual([]);
    const A = sid('forms-a');
    const page = pid('forms-a-unreachable');
    const joined = await assemble(
      vdoc([vpage({ kind: 'source', source: A, index: 0 }, { id: page })], {
        formMergePolicy: 'unify-same-name',
        fields: [made('text', 'name', page, { x: 180, y: 300, width: 200, height: 22 })],
      }),
      new Map([[A, await fetchBytes(formsAUrl)]]),
    );
    expect(joined.report.formFieldsUnified).toEqual(['name']);
    expect(await unreachable(joined.bytes)).toEqual([]);
  });

  test('winAnsiText accepts Latin-1 and cp1252 extras, not Turkish or Greek', () => {
    expect(winAnsiText('Café – “quoted” €5\nnext')).toBe(true);
    expect(winAnsiText('Şişli')).toBe(false);
    expect(winAnsiText('αβγ')).toBe(false);
  });
});

describe('created fields on rotated and resized pages', () => {
  test('/MK /R follows the page rotation and the rect stays in user space', async () => {
    const R = sid('rotated');
    const page = pid('rot-90');
    const rect = { x: 100, y: 200, width: 150, height: 24 };
    const { bytes } = await assemble(
      vdoc([vpage({ kind: 'source', source: R, index: 1 }, { id: page })], {
        fields: [made('text', 'Turned', page, rect, { value: 'Upright' })],
      }),
      new Map([[R, await fetchBytes(rotatedUrl)]]),
    );
    const out = await PDFDocument.load(bytes);
    const widget = out.getForm().getTextField('Turned').acroField.getWidgets()[0];
    expect(widget?.getAppearanceCharacteristics()?.getRotation()).toBe(90);
    const r = widget?.getRectangle();
    expect(r).toEqual(rect);
    const id = await reopen(bytes);
    const listed = byName(await adapter.listFormFields(id), 'Turned');
    expect(listed.rect.x).toBeCloseTo(rect.x, 0);
    expect(listed.rect.width).toBeCloseTo(rect.width, 0);
    await adapter.close(id);
  });

  test('pdfLibBox inverts pdf-lib’s widget box at every rotation', () => {
    const rect = { x: 10, y: 20, width: 100, height: 30 };
    for (const rotation of [0, 90, 180, 270] as const) {
      const box = pdfLibBox(rect, 1, rotation);
      // pdf-lib rotateRectangle with the border-grown size (see created-fields.ts).
      const w = box.width + 1;
      const h = box.height + 1;
      const b = 0.5;
      const back =
        rotation === 0
          ? { x: box.x - b, y: box.y - b, width: w, height: h }
          : rotation === 90
            ? { x: box.x - h + b, y: box.y - b, width: h, height: w }
            : rotation === 180
              ? { x: box.x - w + b, y: box.y - h + b, width: w, height: h }
              : { x: box.x - b, y: box.y - w + b, width: h, height: w };
      expect(back).toEqual(rect);
    }
  });

  test('a resized page maps the widget through the resize matrix', async () => {
    const page = pid('resized');
    const { bytes } = await assemble(
      vdoc(
        [
          {
            ...vpage({ kind: 'blank', size: { width: 200, height: 200 } }, { id: page }),
            resize: { width: 400, height: 400, mode: 'scale', anchor: 'center' },
          },
        ],
        { fields: [made('checkbox', 'Scaled', page, { x: 10, y: 10, width: 20, height: 20 })] },
      ),
      new Map(),
    );
    const out = await PDFDocument.load(bytes);
    const r = out.getForm().getCheckBox('Scaled').acroField.getWidgets()[0]?.getRectangle();
    expect(r).toEqual({ x: 20, y: 20, width: 40, height: 40 });
  });
});

describe('created fields meet source fields (forms-a) under each policy', () => {
  const A = sid('forms-a');

  async function withCreated(policy: FormMergePolicy, kind: CreatedFieldKind = 'text') {
    const page = pid(`forms-a-0-${policy}-${kind}`);
    const created = made(
      kind,
      'name',
      page,
      { x: 180, y: 300, width: 200, height: 22 },
      kind === 'text' ? { value: 'Created value' } : {},
    );
    const doc = vdoc(
      [
        vpage({ kind: 'source', source: A, index: 0 }, { id: page }),
        vpage({ kind: 'source', source: A, index: 1 }),
      ],
      { formMergePolicy: policy, fields: [created] },
    );
    const result = await assemble(doc, new Map([[A, await fetchBytes(formsAUrl)]]));
    const id = await reopen(result.bytes);
    const fields = await adapter.listFormFields(id);
    await adapter.close(id);
    const verified = await adapter.verify(result.bytes.slice(0), {
      pageCount: 2,
      pageSizes: [],
      createdFields: [{ name: 'name', kind: ENGINE_KIND[kind], pageIndices: [0] }],
    });
    return { result, fields, verified };
  }

  test('rename-collisions renames the created field and reports it', async () => {
    const { result, fields, verified } = await withCreated('rename-collisions');
    expect(byName(fields, 'name').value).toBe('Alice Example');
    expect(byName(fields, 'name_2').value).toBe('Created value');
    expect(result.report.formFieldsRenamed).toEqual([{ from: 'name', to: 'name_2' }]);
    expect(verified.ok).toBe(true);
  });

  test('namespace-by-source with one source keeps source names; the created field is renamed', async () => {
    const { result, fields } = await withCreated('namespace-by-source');
    expect(fields.map((f) => f.name)).toContain('name');
    expect(byName(fields, 'name_2').value).toBe('Created value');
    expect(result.report.formFieldsRenamed).toEqual([{ from: 'name', to: 'name_2' }]);
  });

  test('unify-same-name joins a compatible created field (one field, the source value)', async () => {
    const { result, fields, verified } = await withCreated('unify-same-name');
    const name = byName(fields, 'name');
    expect(name.value).toBe('Alice Example');
    expect(name.widgets).toHaveLength(2);
    expect(fields.filter((f) => f.name.startsWith('name'))).toHaveLength(1);
    expect(result.report.formFieldsUnified).toEqual(['name']);
    expect(verified.ok).toBe(true);
  });

  test('unify-same-name renames an incompatible created field with a warning', async () => {
    const { result, fields } = await withCreated('unify-same-name', 'checkbox');
    expect(byName(fields, 'name_2').kind).toBe('checkbox');
    expect(result.report.warnings.join()).toMatch(/differ in type/);
  });

  test('verification reports a missing created field', async () => {
    const { result } = await withCreated('rename-collisions');
    const verified = await adapter.verify(result.bytes.slice(0), {
      pageCount: 2,
      pageSizes: [],
      createdFields: [{ name: 'Missing', kind: 'text', pageIndices: [0] }],
    });
    expect(verified.problems).toEqual(['Created form field "Missing" is missing']);
  });
});
