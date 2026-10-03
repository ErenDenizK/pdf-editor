/**
 * Paragraph tags from the structure tree (spec craft §4.1 step 1): types, MCIDs in tree
 * order, nesting, /ActualText and /Lang; `[]` without tags; malformed trees do not throw.
 */
import { PDFDocument, PDFName, type PDFObject, type PDFRef, PDFString } from '@cantoo/pdf-lib';
import type { SourceId } from '@pdf-editor/document-model';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import metadataUrl from '../../../../test/fixtures/redact-metadata.pdf?url';
import simpleUrl from '../../../../test/fixtures/simple-text.pdf?url';
import taggedUrl from '../../../../test/fixtures/tagged.pdf?url';
import { toBuffer } from '../../test/helpers';
import { RawText } from './raw';
import { type ParagraphTag, readParagraphTags } from './struct-tree';
import { createHarness, fixture, type Harness } from './test-helpers';

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h.adapter.destroy();
});

function tagsOf(source: SourceId, pageIndex: number): Promise<ParagraphTag[]> {
  return h.host.withRawAccess(source, (access) => {
    const raw = new RawText(access.module, access.memory);
    const page = access.doc.acquirePage(pageIndex);
    try {
      return readParagraphTags(raw, page.pagePtr);
    } finally {
      page.release();
    }
  });
}

const CONTENT = [
  '/H1 <</MCID 0>> BDC BT /F1 18 Tf 20 260 Td (Title) Tj ET EMC',
  '/Normal <</MCID 1>> BDC BT /F1 12 Tf 20 230 Td (First part ) Tj ET EMC',
  '/Span <</MCID 2>> BDC BT /F1 12 Tf 90 230 Td (span) Tj ET EMC',
  '/Normal <</MCID 3>> BDC BT /F1 12 Tf 120 230 Td ( tail) Tj ET EMC',
  '/Lbl <</MCID 4>> BDC BT /F1 12 Tf 20 200 Td (1.) Tj ET EMC',
  '/LBody <</MCID 5>> BDC BT /F1 12 Tf 40 200 Td (Item) Tj ET EMC',
  '/Artifact BMC BT /F1 9 Tf 20 20 Td (Footer) Tj ET EMC',
].join('\n');

/**
 * A tagged page: Document → H1 (MCID 0, /Lang), Normal (role-mapped to P: MCID 1, a Span
 * with MCID 2, an MCR dictionary with MCID 3, /ActualText), L → LI → Lbl (4), LBody (5).
 * `malformed` instead makes the Span's parent chain loop and gives an element a bogus /K.
 */
async function taggedPdf(malformed = false): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const page = doc.addPage([400, 300]);
  const helvetica = ctx.register(
    ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' }),
  );
  page.node.set(PDFName.of('Resources'), ctx.obj({ Font: { F1: helvetica } }));
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.stream(CONTENT)));
  page.node.set(PDFName.of('StructParents'), ctx.obj(0));
  const pg = page.ref;
  const root = ctx.nextRef();
  const documentRef = ctx.nextRef();
  const h1 = ctx.nextRef();
  const normal = ctx.nextRef();
  const span = ctx.nextRef();
  const list = ctx.nextRef();
  const item = ctx.nextRef();
  const label = ctx.nextRef();
  const body = ctx.nextRef();
  const element = (
    ref: PDFRef,
    s: string,
    parent: PDFRef,
    k: PDFObject,
    extra: Record<string, PDFObject> = {},
  ) => ctx.assign(ref, ctx.obj({ Type: 'StructElem', S: s, P: parent, Pg: pg, K: k, ...extra }));
  element(documentRef, 'Document', root, ctx.obj([h1, normal, list]));
  element(h1, 'H1', documentRef, ctx.obj(0), { Lang: PDFString.of('tr-TR') });
  const mcr = ctx.obj({ Type: 'MCR', Pg: pg, MCID: 3 });
  element(normal, 'Normal', documentRef, ctx.obj([1, span, mcr]), {
    ActualText: PDFString.of('First part span tail'),
  });
  element(span, 'Span', malformed ? span : normal, ctx.obj(2));
  element(list, 'L', documentRef, ctx.obj([item]));
  element(item, 'LI', list, malformed ? PDFString.of('bogus') : ctx.obj([label, body]));
  element(label, 'Lbl', item, ctx.obj(4));
  element(body, 'LBody', item, ctx.obj(5));
  const parentTree = ctx.obj({ Nums: [0, [h1, normal, span, normal, label, body]] });
  ctx.assign(
    root,
    ctx.obj({
      Type: 'StructTreeRoot',
      K: documentRef,
      ParentTree: parentTree,
      ParentTreeNextKey: 1,
      RoleMap: { Normal: 'P' },
    }),
  );
  doc.catalog.set(PDFName.of('StructTreeRoot'), root);
  doc.catalog.set(PDFName.of('MarkInfo'), ctx.obj({ Marked: true }));
  return toBuffer(await doc.save({ useObjectStreams: false }));
}

describe('readParagraphTags', () => {
  test('tagged.pdf: one P with MCID 0 on each page', async () => {
    const id = await h.open(await fixture(taggedUrl));
    expect(await tagsOf(id, 0)).toEqual([{ type: 'P', mcids: [0] }]);
    expect(await tagsOf(id, 1)).toEqual([{ type: 'P', mcids: [0] }]);
  });

  test('redact-metadata.pdf: the P carries its /ActualText', async () => {
    const id = await h.open(await fixture(metadataUrl));
    const tags = await tagsOf(id, 0);
    expect(tags).toHaveLength(1);
    expect(tags[0]).toMatchObject({ type: 'P', mcids: [0] });
    expect(tags[0]?.actualText).toContain('SECRET-7731');
  });

  test('role map, nesting, MCIDs in tree order, /Lang and /ActualText', async () => {
    const id = await h.open(await taggedPdf());
    expect(await tagsOf(id, 0)).toEqual([
      { type: 'H1', mcids: [0], lang: 'tr-TR' },
      { type: 'P', mcids: [1, 2, 3], actualText: 'First part span tail' },
      { type: 'LI', mcids: [4] },
      { type: 'LBody', mcids: [5], parent: 2 },
    ]);
  });

  test('an untagged page gives no tags', async () => {
    const id = await h.open(await fixture(simpleUrl));
    expect(await tagsOf(id, 0)).toEqual([]);
  });

  test('a malformed tree does not throw and keeps what it could read', async () => {
    const id = await h.open(await taggedPdf(true));
    const tags = await tagsOf(id, 0);
    expect(Array.isArray(tags)).toBe(true);
    expect(tags.find((t) => t.type === 'H1')).toEqual({ type: 'H1', mcids: [0], lang: 'tr-TR' });
    // The engine still works on the document afterwards.
    expect((await h.editor.locateRuns(id, 0)).length).toBeGreaterThan(0);
  });
});
