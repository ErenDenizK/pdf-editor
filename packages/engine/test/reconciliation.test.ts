/**
 * Document-level reconciliation against the shared corpus: named destinations, form merge
 * policies, metadata (XMP, /ID, /Lang) and the extended verifier.
 */

import type { PDFHexString } from '@cantoo/pdf-lib';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFRef,
  decodePDFRawStream,
} from '@cantoo/pdf-lib';
import type { FormMergePolicy, SourceId } from '@pdf-editor/document-model';
import formsAUrl from '../../../test/fixtures/forms-a.pdf?url';
import formsBUrl from '../../../test/fixtures/forms-b.pdf?url';
import metadataUrl from '../../../test/fixtures/metadata-xmp.pdf?url';
import outlineUrl from '../../../test/fixtures/outline-named-dests.pdf?url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { PdfiumAdapter } from '../src/pdfium/pdfium-adapter';
import { PdfLibAssembler } from '../src/pdflib/pdflib-assembler';
import type { LinkAnnotation } from '../src/types';
import { makePdf, sid, vdoc, vpage, wasmUrl } from './helpers';

const fetchBytes = async (url: string) => (await fetch(url)).arrayBuffer();
const assembler = new PdfLibAssembler();
let adapter: PdfiumAdapter;

beforeAll(() => {
  adapter = new PdfiumAdapter({ wasmUrl, inspector: assembler });
});
afterAll(async () => {
  await adapter.destroy();
});

/** Page index (0-based) of a destination array's page ref in `doc`. */
function destIndex(doc: PDFDocument, dest: PDFArray): number {
  const ref = dest.get(0);
  return doc.getPages().findIndex((p) => ref instanceof PDFRef && p.ref === ref);
}

describe('named destinations', () => {
  const OUT = sid('outline');

  test('PDFium resolves named outline destinations on open', async () => {
    const opened = await adapter.open(OUT, await fetchBytes(outlineUrl));
    await adapter.close(OUT);
    const flat: [string, unknown][] = [];
    const walk = (nodes: typeof opened.outline) => {
      for (const n of nodes) {
        flat.push([
          n.title,
          n.destination?.kind === 'page' ? n.destination.pageIndex : n.destination,
        ]);
        walk(n.children);
      }
    };
    walk(opened.outline);
    expect(flat).toEqual([
      ['Chapter 1: Introduction', 0],
      ['Chapter 2 – Methods', 2], // named (name tree, string)
      ['2.1 Setup', 3], // GoTo action with a named destination
      ['2.2 Results', 4],
      ['2.2.1 Details', 4],
      ['Appendix', 5], // named (catalog /Dests, name)
    ]);
  });

  test('links to named and explicit destinations are rewritten to the copied pages', async () => {
    // Output: source pages 6, 2, 3, 4 -> the links on source page 2 target output 2 and 3.
    const result = await assembler.assemble({
      document: vdoc([5, 1, 2, 3].map((index) => vpage({ kind: 'source', source: OUT, index }))),
      sources: new Map([[OUT, await fetchBytes(outlineUrl)]]),
      blobs: new Map(),
    });
    expect(result.report).toMatchObject({ linksRewritten: 2, linksDropped: 0 });
    expect(result.report.warnings).toEqual([]);
    const out = await PDFDocument.load(result.bytes, { updateMetadata: false });
    expect(out.catalog.get(PDFName.of('Names'))).toBeUndefined();
    expect(out.catalog.get(PDFName.of('Dests'))).toBeUndefined();
    const annots = out.getPage(1).node.lookup(PDFName.of('Annots'), PDFArray);
    const targets: number[] = [];
    for (let i = 0; i < annots.size(); i++) {
      const annot = annots.lookup(i, PDFDict);
      const dest =
        annot.lookupMaybe(PDFName.of('Dest'), PDFArray) ??
        annot.lookupMaybe(PDFName.of('A'), PDFDict)?.lookupMaybe(PDFName.of('D'), PDFArray);
      if (dest) targets.push(destIndex(out, dest));
    }
    expect(targets.sort()).toEqual([2, 3]);

    // PDFium agrees: GoTo -> output page 3 (source page 4), named -> 2 (source page 3).
    await adapter.open(sid('named-out'), result.bytes.slice(0));
    const links = (await adapter.listAnnotations(sid('named-out'), 1)).filter(
      (a): a is LinkAnnotation => a.kind === 'link',
    );
    await adapter.close(sid('named-out'));
    expect(links.map((l) => l.targetPageIndex ?? l.uri).sort()).toEqual([
      2,
      3,
      'https://example.com/',
    ]);
  });

  test('a named link whose page was removed is dropped and counted', async () => {
    const result = await assembler.assemble({
      document: vdoc([0, 1, 3].map((index) => vpage({ kind: 'source', source: OUT, index }))),
      sources: new Map([[OUT, await fetchBytes(outlineUrl)]]),
      blobs: new Map(),
    });
    // GoTo to source page 4 survives (output 2); the named link to page 3 is dropped.
    expect(result.report).toMatchObject({ linksRewritten: 1, linksDropped: 1 });
  });
});

describe('form merge policies (forms-a + forms-b)', () => {
  const A = sid('forms-a');
  const B = sid('forms-b');

  async function merge(policy: FormMergePolicy) {
    const result = await assembler.assemble({
      document: vdoc(
        [
          vpage({ kind: 'source', source: A, index: 0 }),
          vpage({ kind: 'source', source: A, index: 1 }),
          vpage({ kind: 'source', source: B, index: 0 }),
          vpage({ kind: 'source', source: B, index: 1 }),
        ],
        { formMergePolicy: policy },
      ),
      sources: new Map<SourceId, ArrayBuffer>([
        [A, await fetchBytes(formsAUrl)],
        [B, await fetchBytes(formsBUrl)],
      ]),
      blobs: new Map(),
      sourceNames: new Map([
        [A, 'Form A.v2'],
        [B, 'Form B'],
      ]),
    });
    const id = sid(`forms-${policy}`);
    await adapter.open(id, result.bytes.slice(0));
    const fields = await adapter.listFormFields(id);
    await adapter.close(id);
    const values = Object.fromEntries(fields.map((f) => [f.name, f.value]));
    return { result, fields, values };
  }

  test('namespace-by-source wraps each file under its name (periods replaced)', async () => {
    const { result, values } = await merge('namespace-by-source');
    expect(values['Form A_v2.name']).toBe('Alice Example');
    expect(values['Form B.name']).toBe('Bob Example');
    expect(values['Form B.address.city']).toBe('Tokyo');
    expect(result.report.formFieldsRenamed).toContainEqual({
      from: 'only_in_b',
      to: 'Form B.only_in_b',
    });
  });

  test('rename-collisions keeps both fields with distinct names and their values', async () => {
    const { result, fields, values } = await merge('rename-collisions');
    expect(fields.map((f) => f.name).sort()).toEqual(
      [
        'address.city',
        'address_2.city',
        'agree',
        'agree_2',
        'choice',
        'choice_2',
        'country',
        'country_2',
        'name',
        'name_2',
        'only_in_a',
        'only_in_b',
      ].sort(),
    );
    expect(values.name).toBe('Alice Example');
    expect(values.name_2).toBe('Bob Example');
    expect(values['address.city']).toBe('Paris');
    expect(values['address_2.city']).toBe('Tokyo');
    expect(values.country_2).toBe('Japan');
    expect(result.report.formFieldsRenamed).toEqual(
      expect.arrayContaining([
        { from: 'name', to: 'name_2' },
        { from: 'address.city', to: 'address_2.city' },
      ]),
    );
    expect(result.report.formFieldsRenamed).toHaveLength(5);
    expect(result.report.formFieldsUnified).toEqual([]);
  });

  test('unify-same-name joins equal names into one field with the first value', async () => {
    const { result, fields, values } = await merge('unify-same-name');
    expect(fields.map((f) => f.name).sort()).toEqual(
      ['address.city', 'agree', 'choice', 'country', 'name', 'only_in_a', 'only_in_b'].sort(),
    );
    expect(values.name).toBe('Alice Example');
    expect(values['address.city']).toBe('Paris');
    expect(values.agree).toBe(true);
    expect(result.report.formFieldsRenamed).toEqual([]);
    expect([...result.report.formFieldsUnified].sort()).toEqual(
      ['address.city', 'agree', 'choice', 'country', 'name'].sort(),
    );
    expect(result.report.warnings.join(' ')).toContain('share the first file');

    const out = await PDFDocument.load(result.bytes, { updateMetadata: false });
    const form = out.getForm();
    // One field, two widgets (pages 1 and 3); the joined widget lost its stale appearance.
    const name = form.getTextField('name');
    const widgets = name.acroField.getWidgets();
    expect(widgets).toHaveLength(2);
    expect(widgets[1]?.dict.get(PDFName.of('AP'))).toBeUndefined();
    const acroForm = out.catalog.lookup(PDFName.of('AcroForm'), PDFDict);
    expect(acroForm.get(PDFName.of('NeedAppearances'))?.toString()).toBe('true');
    // The joined checkbox widget shows the shared (first) value.
    const agree = form.getCheckBox('agree').acroField.getWidgets();
    expect(agree.map((w) => w.getAppearanceState()?.decodeText())).toEqual(
      agree.map(() => agree[0]?.getAppearanceState()?.decodeText()),
    );
    // Choice options are not duplicated by joining equal fields (both files offer the same).
    const sourceForm = (await PDFDocument.load(await fetchBytes(formsAUrl))).getForm();
    const expected = sourceForm.getDropdown('country').getOptions();
    const options = form.getDropdown('country').getOptions();
    expect(options).toEqual(expected);
    expect(new Set(options).size).toBe(options.length);
    // Radio /Opt keeps one entry per widget.
    const radio = form.getRadioGroup('choice').acroField;
    const opt = radio.dict.lookupMaybe(PDFName.of('Opt'), PDFArray);
    expect(opt?.size()).toBe(radio.getWidgets().length);
  });
});

describe('metadata', () => {
  test('fresh /ID, XMP mirroring Info, /Lang passthrough', async () => {
    const M = sid('meta');
    const L = sid('lang');
    const source = await fetchBytes(metadataUrl);
    const sourceDoc = await PDFDocument.load(source.slice(0), { updateMetadata: false });
    const sourceId = sourceDoc.context.lookup(sourceDoc.context.trailerInfo.ID, PDFArray);
    const withLang = await makePdf([{ size: [100, 100], text: 'L' }], (doc) =>
      doc.setLanguage('en-GB'),
    );
    const result = await assembler.assemble({
      document: vdoc([
        vpage({ kind: 'source', source: L, index: 0 }),
        vpage({ kind: 'source', source: M, index: 0 }),
      ]),
      sources: new Map([
        [M, source],
        [L, withLang],
      ]),
      blobs: new Map(),
    });
    const out = await PDFDocument.load(result.bytes, { updateMetadata: false });
    const id = out.context.lookup(out.context.trailerInfo.ID, PDFArray);
    expect(id.size()).toBe(2);
    const hex = (i: number, array: PDFArray) => (array.get(i) as PDFHexString).asString();
    expect(hex(0, id)).toMatch(/^[0-9A-F]{32}$/i);
    expect(hex(0, id)).toBe(hex(1, id));
    expect(hex(0, id)).not.toBe(hex(0, sourceId));
    expect(out.catalog.lookup(PDFName.of('Lang'))?.toString()).toContain('en-GB');

    const stream = out.catalog.lookup(PDFName.of('Metadata'));
    expect(stream).toBeInstanceOf(PDFRawStream);
    const xmp = new TextDecoder().decode(decodePDFRawStream(stream as PDFRawStream).decode());
    expect(xmp).toContain('<pdf:Producer>pdf-editor</pdf:Producer>');
    expect(xmp).toContain('<rdf:li>en-GB</rdf:li>');
    expect(xmp).toContain('xmpMM:DocumentID');
    // Policy inherit-first-source: the first source here is the language one (no title).
    expect(xmp).not.toContain('Metadata and XMP fixture');

    // Metadata source first: its Info is inherited and mirrored in the new packet.
    const second = await assembler.assemble({
      document: vdoc([vpage({ kind: 'source', source: M, index: 0 })], {
        metadata: { policy: 'inherit-first-source', language: 'it' },
      }),
      sources: new Map([[M, await fetchBytes(metadataUrl)]]),
      blobs: new Map(),
    });
    const secondOut = await PDFDocument.load(second.bytes, { updateMetadata: false });
    const packet = new TextDecoder().decode(
      decodePDFRawStream(secondOut.catalog.lookup(PDFName.of('Metadata')) as PDFRawStream).decode(),
    );
    expect(packet).toContain('Metadata and XMP fixture');
    expect(packet).toContain('<rdf:li>Jane Q. Fixture</rdf:li>');
    expect(packet).toContain('<rdf:li>it</rdf:li>');
    expect(secondOut.getTitle()).toBe('Metadata and XMP fixture');
  });
});

describe('modification date', () => {
  test('stamps the export time unless the document sets a date explicitly', async () => {
    const S = sid('dated');
    const source = await fetchBytes(metadataUrl); // ModDate 2024-01-01
    const assemble = async (modificationDate?: string) => {
      const result = await assembler.assemble({
        document: vdoc([vpage({ kind: 'source', source: S, index: 0 })], {
          metadata: {
            policy: 'inherit-first-source',
            ...(modificationDate === undefined ? {} : { modificationDate }),
          },
        }),
        sources: new Map([[S, source.slice(0)]]),
        blobs: new Map(),
      });
      const out = await PDFDocument.load(result.bytes, { updateMetadata: false });
      const xmp = new TextDecoder().decode(
        decodePDFRawStream(out.catalog.lookup(PDFName.of('Metadata')) as PDFRawStream).decode(),
      );
      return { modified: out.getModificationDate(), xmp };
    };
    const before = Date.now();
    const stamped = await assemble();
    expect(stamped.modified?.getTime()).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
    expect(stamped.xmp).toContain(
      `<xmp:ModifyDate>${stamped.modified?.toISOString()}</xmp:ModifyDate>`,
    );
    const explicit = await assemble('2011-12-13T14:15:16.000Z');
    expect(explicit.modified?.toISOString()).toBe('2011-12-13T14:15:16.000Z');
    expect(explicit.xmp).toContain('<xmp:MetadataDate>2011-12-13T14:15:16.000Z</xmp:MetadataDate>');
  });
});

describe('verification expectations', () => {
  test('outline, labels, rotations and field names are checked', async () => {
    const A = sid('va');
    const B = sid('vb');
    const pages = [
      vpage({ kind: 'source', source: A, index: 0 }, { id: 'p0' as never }),
      vpage({ kind: 'source', source: B, index: 0 }, { id: 'p1' as never, rotation: 90 }),
    ];
    const result = await assembler.assemble({
      document: vdoc(pages, {
        outline: [
          {
            title: 'Top',
            destination: { kind: 'page', page: pages[0]?.id as never },
            open: true,
            children: [
              {
                title: 'Child',
                destination: { kind: 'page', page: pages[1]?.id as never },
                open: false,
                children: [],
              },
            ],
          },
        ],
        labels: [
          { startIndex: 0, style: 'roman-lower' },
          { startIndex: 1, style: 'decimal', prefix: 'B-' },
        ],
      }),
      sources: new Map([
        [A, await fetchBytes(formsAUrl)],
        [B, await makePdf([{ size: [200, 300], text: 'B' }])],
      ]),
      blobs: new Map(),
    });
    const base = {
      pageCount: 2,
      pageSizes: [
        { width: 612, height: 792 },
        { width: 200, height: 300 },
      ],
    };
    const good = await adapter.verify(result.bytes.slice(0), {
      ...base,
      rotations: [0, 90],
      outlineCount: 2,
      outlineTitles: ['Top', 'Child'],
      pageLabels: ['i', 'B-1'],
      formFieldNames: ['name', 'agree', 'choice', 'country'],
    });
    expect(good).toEqual({ ok: true, problems: [] });
    const bad = await adapter.verify(result.bytes.slice(0), {
      ...base,
      rotations: [0, 0],
      outlineCount: 3,
      outlineTitles: ['Top'],
      pageLabels: null,
      formFieldNames: ['name'],
    });
    expect(bad.ok).toBe(false);
    expect(bad.problems).toHaveLength(5);

    const blind = new PdfiumAdapter({ wasmUrl });
    try {
      const unverifiable = await blind.verify(result.bytes.slice(0), {
        ...base,
        pageLabels: ['i', 'B-1'],
      });
      expect(unverifiable.problems[0]).toContain('no source inspector');
    } finally {
      await blind.destroy();
    }
  });
});
