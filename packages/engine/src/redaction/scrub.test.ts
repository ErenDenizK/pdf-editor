/**
 * Scrub steps on synthetic documents (what the M4 fixtures do not exercise): structure
 * pruning and untagging, named-destination renaming with referrers, form fields, scripts
 * and per-object metadata, the placeholder, and fill plus overlay on rotated pages.
 */

import {
  degrees,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNull,
  type PDFObject,
  PDFRawStream,
  PDFString,
  StandardFonts,
} from '@cantoo/pdf-lib';
import wasmUrl from '@embedpdf/pdfium/pdfium.wasm?url';
import type { Rect } from '@pdf-editor/document-model';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { namedDestinationResolver } from '../pdflib/named-destinations';
import type { RedactionPlan } from '../types';
import { forensicCheck } from './forensic';
import { scrubRedactedDocument } from './scrub';
import { createRedactionHarness, type RedactionHarness } from './test-helpers';

const TOKEN = 'SECRET-7731';
const name = PDFName.of;
let h: RedactionHarness;

beforeAll(async () => {
  h = await createRedactionHarness(wasmUrl);
});
afterAll(async () => {
  await h.destroy();
});

async function build(init: (doc: PDFDocument) => Promise<void> | void): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  await init(doc);
  // Appearances are updated by the builders that need them: pdf-lib's own update drops /XFA.
  return (await doc.save({ useObjectStreams: false, updateFieldAppearances: false })).slice()
    .buffer;
}
const load = (bytes: ArrayBuffer) => PDFDocument.load(bytes.slice(0), { updateMetadata: false });
const text = (o: PDFObject | undefined) =>
  o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : o?.toString();

async function forensic(bytes: ArrayBuffer, plan: RedactionPlan) {
  const opened = await h.open(bytes);
  try {
    return await forensicCheck(bytes, plan, opened.deps);
  } finally {
    await opened.close();
  }
}

/** A tagged page: MCID 0 in the content; `structKids` builds the Document's kids. */
async function tagged(structKids: (doc: PDFDocument, page: PDFDict) => PDFObject[]) {
  return build(async (doc) => {
    const ctx = doc.context;
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([400, 300]);
    page.node.set(name('Resources'), ctx.obj({ Font: { F1: font.ref } }));
    page.node.set(name('StructParents'), ctx.obj(0));
    page.node.set(
      name('Contents'),
      ctx.register(ctx.stream('/P <</MCID 0>> BDC BT /F1 12 Tf 50 200 Td (Kept) Tj ET EMC')),
    );
    const kids = structKids(doc, page.node);
    const document = ctx.obj({ Type: 'StructElem', S: 'Document', K: kids });
    const docRef = ctx.register(document);
    for (const kid of kids) ctx.lookupMaybe(kid, PDFDict)?.set(name('P'), docRef);
    const root = ctx.register(
      ctx.obj({ Type: 'StructTreeRoot', K: docRef, ParentTree: ctx.obj({ Nums: [0, kids] }) }),
    );
    document.set(name('P'), root);
    doc.catalog.set(name('StructTreeRoot'), root);
    doc.catalog.set(name('MarkInfo'), ctx.obj({ Marked: true }));
  });
}

describe('structure tree', () => {
  test('elements whose marked content is gone are pruned; the rest keeps its text', async () => {
    const bytes = await tagged((doc, page) => [
      doc.context.register(
        doc.context.obj({
          Type: 'StructElem',
          S: 'P',
          Pg: page,
          K: 0,
          ActualText: PDFString.of('Kept'),
        }),
      ),
      doc.context.register(
        doc.context.obj({ Type: 'StructElem', S: 'P', Pg: page, K: 1, Alt: PDFString.of('gone') }),
      ),
    ]);
    const { bytes: out, report } = await scrubRedactedDocument(bytes, { areas: [], strings: [] });
    expect(report.structure).toBe('pruned');
    expect(report.structElementsPruned).toBe(2); // the gone P and its parent
    const doc = await load(out);
    const root = doc.context.lookup(doc.catalog.get(name('StructTreeRoot')), PDFDict);
    const document = doc.context.lookup(root.get(name('K')), PDFDict);
    const kept = doc.context.lookup(document.get(name('K')), PDFDict); // a single kid now
    expect(text(kept.get(name('ActualText')))).toBe('Kept');
    const nums = doc.context.lookup(
      doc.context.lookup(root.get(name('ParentTree')), PDFDict).get(name('Nums')),
      PDFArray,
    );
    const byMcid = doc.context.lookup(nums.get(1), PDFArray);
    expect(byMcid.get(1)).toBe(PDFNull);
  });

  test('a tree that fails validation is removed and the file is reported untagged', async () => {
    const bytes = await tagged((doc) => [doc.context.obj({ Type: 'StructElem', K: 0 })]); // no /S
    const { bytes: out, report } = await scrubRedactedDocument(bytes, { areas: [], strings: [] });
    expect(report.structure).toBe('untagged');
    const doc = await load(out);
    expect(doc.catalog.has(name('StructTreeRoot'))).toBe(false);
    expect(doc.catalog.lookup(name('MarkInfo'), PDFDict).get(name('Marked'))?.toString()).toBe(
      'false',
    );
    expect(doc.getPage(0).node.has(name('StructParents'))).toBe(false);
  });
});

describe('strings', () => {
  test('named destinations are renamed, the tree re-sorted, and referrers follow', async () => {
    const bytes = await build((doc) => {
      const ctx = doc.context;
      const page = doc.addPage([400, 300]);
      const dest = (y: number) => ctx.obj([page.ref, 'XYZ', 0, y, 0]);
      const leaf1 = ctx.register(
        ctx.obj({
          Limits: [PDFString.of(`${TOKEN}-dest`), PDFString.of('alpha')],
          Names: [PDFString.of(`${TOKEN}-dest`), dest(10), PDFString.of('alpha'), dest(20)],
        }),
      );
      const leaf2 = ctx.register(
        ctx.obj({
          Limits: [PDFString.of('secret-7731-dest'), PDFString.of('zulu')],
          Names: [PDFString.of('secret-7731-dest'), dest(30), PDFString.of('zulu'), dest(40)],
        }),
      );
      doc.catalog.set(
        name('Names'),
        ctx.obj({ Dests: ctx.register(ctx.obj({ Kids: [leaf1, leaf2] })) }),
      );
      doc.catalog.set(name('Dests'), ctx.obj({ [`${TOKEN}-old`]: dest(50) }));
      const link = ctx.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [10, 10, 50, 30],
        Dest: PDFString.of(`${TOKEN}-dest`),
      });
      const goTo = ctx.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [60, 10, 90, 30],
        A: { S: 'GoTo', D: PDFString.of('secret-7731-dest') },
      });
      page.node.set(name('Annots'), ctx.obj([ctx.register(link), ctx.register(goTo)]));
      const outlines = ctx.nextRef();
      const item = ctx.register(
        ctx.obj({ Title: PDFString.of('Old'), Parent: outlines, Dest: name(`${TOKEN}-old`) }),
      );
      ctx.assign(outlines, ctx.obj({ Type: 'Outlines', First: item, Last: item, Count: 1 }));
      doc.catalog.set(name('Outlines'), outlines);
    });
    const { bytes: out, report } = await scrubRedactedDocument(bytes, {
      areas: [],
      strings: [TOKEN],
    });
    expect(report.namesRenamed).toBe(3);
    const doc = await load(out);
    const ctx = doc.context;
    const tree = ctx.lookup(
      ctx.lookup(doc.catalog.get(name('Names')), PDFDict).get(name('Dests')),
      PDFDict,
    );
    expect(tree.has(name('Kids'))).toBe(false);
    const pairs = ctx.lookup(tree.get(name('Names')), PDFArray);
    const keys = Array.from({ length: pairs.size() / 2 }, (_, i) => text(pairs.get(i * 2)));
    expect(keys).toEqual(['[redacted]-dest', '[redacted]-dest (2)', 'alpha', 'zulu']);
    const [link, goTo] = doc
      .getPage(0)
      .node.Annots()!
      .asArray()
      .map((r) => ctx.lookup(r, PDFDict));
    expect(text(link!.get(name('Dest')))).toBe('[redacted]-dest');
    expect(text(ctx.lookup(goTo!.get(name('A')), PDFDict).get(name('D')))).toBe(
      '[redacted]-dest (2)',
    );
    const resolve = namedDestinationResolver(doc);
    expect(resolve('[redacted]-dest')?.get(3)?.toString()).toBe('10');
    expect(resolve('[redacted]-dest (2)')?.get(3)?.toString()).toBe('30');
    const dests = ctx.lookup(doc.catalog.get(name('Dests')), PDFDict);
    expect(dests.keys().map((k) => k.decodeText())).toEqual(['[redacted]-old']);
    const outline = ctx.lookup(
      ctx.lookup(doc.catalog.get(name('Outlines')), PDFDict).get(name('First')),
      PDFDict,
    );
    expect(outline.get(name('Dest'))).toBe(name('[redacted]-old'));
  });

  test('a custom placeholder is used (UTF-16 when needed), an unsafe one is replaced', async () => {
    const bytes = await build((doc) => {
      doc.addPage([200, 200]);
      doc.setTitle(`Report on ${TOKEN}`);
    });
    const custom = await scrubRedactedDocument(bytes, {
      areas: [],
      strings: [TOKEN],
      placeholder: '█',
    });
    expect((await load(custom.bytes)).getTitle()).toBe('Report on █');
    const unsafe = await scrubRedactedDocument(bytes, {
      areas: [],
      strings: [TOKEN],
      placeholder: TOKEN,
    });
    expect((await load(unsafe.bytes)).getTitle()).toBe('Report on [redacted]');
    expect(unsafe.report.warnings).toHaveLength(1);
  });
});

describe('forms, scripts and metadata', () => {
  test('a widget in an area loses its value and its field; a carrying value is cleared', async () => {
    const bytes = await build((doc) => {
      const page = doc.addPage([400, 300]);
      const form = doc.getForm();
      const fields: [string, string, number][] = [
        ['secret', TOKEN, 200],
        ['other', 'public', 120],
        ['notes', `notes about ${TOKEN}`, 40],
      ];
      for (const [id, value, y] of fields) {
        const field = form.createTextField(id);
        field.setText(value);
        field.addToPage(page, { x: 50, y, width: 200, height: 24 });
      }
      form.updateFieldAppearances();
      form.acroForm.dict.set(name('XFA'), doc.context.register(doc.context.stream('<xdp/>')));
    });
    const plan: RedactionPlan = {
      areas: [{ pageIndex: 0, rect: { x: 40, y: 190, width: 220, height: 40 } }],
      strings: [TOKEN],
    };
    const { bytes: out, report } = await scrubRedactedDocument(bytes, plan);
    expect(report).toMatchObject({
      fieldsCleared: 2,
      widgetsRemoved: 1,
      fieldsRemoved: 1,
      xfaRemoved: true,
    });
    const form = (await load(out)).getForm();
    expect(form.getFields().map((f) => f.getName())).toEqual(['other', 'notes']);
    expect(form.getTextField('other').getText()).toBe('public');
    expect(form.getTextField('notes').getText()).toBeUndefined();
    expect((await forensic(out, plan)).ok).toBe(true);
  });

  test('scripts, per-object XMP and /PieceInfo go; the catalog XMP is regenerated', async () => {
    const bytes = await build((doc) => {
      const ctx = doc.context;
      const page = doc.addPage([200, 200]);
      const js = (code: string) => ctx.obj({ S: 'JavaScript', JS: PDFString.of(code) });
      doc.catalog.set(name('OpenAction'), js('app.alert(1)'));
      doc.catalog.set(
        name('Names'),
        ctx.obj({ JavaScript: ctx.obj({ Names: [PDFString.of('init'), js('x')] }) }),
      );
      page.node.set(name('PieceInfo'), ctx.obj({ App: { Private: PDFString.of(TOKEN) } }));
      page.node.set(
        name('Metadata'),
        ctx.register(ctx.stream(`<x>${TOKEN}</x>`, { Type: 'Metadata', Subtype: 'XML' })),
      );
      doc.catalog.set(
        name('Metadata'),
        ctx.register(ctx.stream(`<x>${TOKEN}</x>`, { Type: 'Metadata', Subtype: 'XML' })),
      );
      doc.setTitle(`About ${TOKEN}`);
    });
    const plan: RedactionPlan = { areas: [], strings: [TOKEN] };
    const { bytes: out, report } = await scrubRedactedDocument(bytes, plan);
    expect(report.metadata).toEqual({
      xmpRegenerated: true,
      objectMetadata: 1,
      pieceInfo: 1,
      thumbnails: 0,
      javascript: 2,
    });
    const doc = await load(out);
    expect(doc.catalog.has(name('OpenAction'))).toBe(false);
    expect(doc.catalog.has(name('Names'))).toBe(false);
    const xmp = doc.context.lookup(doc.catalog.get(name('Metadata')));
    expect(xmp).toBeInstanceOf(PDFRawStream);
    expect(new TextDecoder().decode((xmp as PDFRawStream).contents)).toContain('About [redacted]');
    expect((await forensic(out, plan)).ok).toBe(true);
  });
});

describe('fill and overlay on rotated pages (areas in unrotated user space)', () => {
  test.each([0, 90, 180, 270])(
    '/Rotate %i: the overlay reads upright and every check passes',
    async (rotation) => {
      const bytes = await build(async (doc) => {
        const font = await doc.embedFont(StandardFonts.Helvetica);
        const page = doc.addPage([400, 300]);
        page.drawText(`Name: ${TOKEN} end`, { x: 40, y: 150, size: 14, font });
        page.drawText('KEEP-ME', { x: 40, y: 60, size: 14, font });
        page.setRotation(degrees(rotation));
      });
      const opened = await h.open(bytes);
      const hit = (await opened.deps.search(TOKEN))[0]!;
      await opened.close();
      const xs = hit.rects.flatMap((r) => [r.x, r.x + r.width]);
      const ys = hit.rects.flatMap((r) => [r.y, r.y + r.height]);
      const area: Rect = {
        x: Math.min(...xs) - 1,
        y: Math.min(...ys) - 1,
        width: Math.max(...xs) - Math.min(...xs) + 2,
        height: Math.max(...ys) - Math.min(...ys) + 2,
      };
      const plan: RedactionPlan = {
        areas: [{ pageIndex: 0, rect: area, overlayText: 'XX' }],
        strings: [TOKEN],
      };
      const engineBytes = await h.engineRedact(bytes, plan.areas);
      const { bytes: out, report } = await scrubRedactedDocument(engineBytes, plan);
      expect(report.warnings).toEqual([]);
      const result = await forensic(out, plan);
      expect(result.checks.filter((c) => !c.passed)).toEqual([]);
      const check = await h.open(out);
      const glyphs = (await check.deps.getPageText(0)).flatMap((r) => r.glyphs);
      await check.close();
      expect(glyphs.map((g) => g.text).join('')).toContain('KEEP-ME');
      const overlay = glyphs.filter((g) => g.text === 'X');
      expect(overlay).toHaveLength(2);
      const centre = (r: Rect) => [r.x + r.width / 2, r.y + r.height / 2] as const;
      const [a, b] = [centre(overlay[0]!.rect), centre(overlay[1]!.rect)];
      const angle =
        (Math.round((Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI / 90) * 90 + 360) % 360;
      expect(angle).toBe(rotation); // text turned with the page, so it reads left to right on screen
    },
  );
});
