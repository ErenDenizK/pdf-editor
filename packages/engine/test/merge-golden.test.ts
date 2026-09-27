/**
 * Golden-file test for the v1.0 merge scenario (VISION.md success criteria): six corpus
 * files are opened through the PDFium adapter into a document-model workspace, merged,
 * interleaved, two pages rotated and one deleted, then exported the way the app does it
 * (`planExport` -> assembler -> verifier). The output is re-opened with PDFium and pdf-lib.
 */

import type { PDFHexString } from '@cantoo/pdf-lib';
import { PDFArray, PDFDocument, PDFName } from '@cantoo/pdf-lib';
import {
  addSource,
  createSequentialIdGenerator,
  createWorkspace,
  type DocumentId,
  deletePages,
  effectiveLabels,
  getDocument,
  mergeDocuments,
  movePages,
  type PageId,
  pageTotalRotation,
  rotatePages,
  type SourceId,
  type Workspace,
} from '@pdf-editor/document-model';
import formsAUrl from '../../../test/fixtures/forms-a.pdf?url';
import formsBUrl from '../../../test/fixtures/forms-b.pdf?url';
import manifest from '../../../test/fixtures/manifest.json';
import manyPagesUrl from '../../../test/fixtures/many-pages.pdf?url';
import outlineUrl from '../../../test/fixtures/outline-named-dests.pdf?url';
import pageLabelsUrl from '../../../test/fixtures/page-labels.pdf?url';
import rotatedUrl from '../../../test/fixtures/rotated-pages.pdf?url';
import taggedUrl from '../../../test/fixtures/tagged.pdf?url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { planExport } from '../src/export-plan';
import { PdfiumAdapter } from '../src/pdfium/pdfium-adapter';
import { PdfLibAssembler } from '../src/pdflib/pdflib-assembler';
import type { AssemblyResult, EngineOutlineNode, LinkAnnotation } from '../src/types';
import { logTiming, sid, wasmUrl } from './helpers';

const fetchBytes = async (url: string) => (await fetch(url)).arrayBuffer();

interface ManifestFixture {
  readonly file: string;
  readonly expect: { readonly pages?: readonly { readonly markers?: readonly string[] }[] };
}
const fixtures = (manifest as { fixtures: readonly ManifestFixture[] }).fixtures;
/** The unique marker text of (1-based) `page` of `file`, from manifest.json. */
function marker(file: string, page: number): string {
  const markers = fixtures.find((f) => f.file === file)?.expect.pages?.[page - 1]?.markers ?? [];
  const last = markers[markers.length - 1];
  if (last === undefined) throw new Error(`no marker for ${file} p${page}`);
  return last;
}

const FILES = {
  O: { file: 'outline-named-dests.pdf', url: outlineUrl },
  L: { file: 'page-labels.pdf', url: pageLabelsUrl },
  FA: { file: 'forms-a.pdf', url: formsAUrl },
  FB: { file: 'forms-b.pdf', url: formsBUrl },
  R: { file: 'rotated-pages.pdf', url: rotatedUrl },
  T: { file: 'tagged.pdf', url: taggedUrl },
} as const;
type Key = keyof typeof FILES;

/** Interleaved order before the deletion: [source, 1-based page]. */
const ORDER: readonly [Key, number][] = [
  ['O', 1],
  ['L', 1],
  ['L', 2],
  ['L', 3],
  ['FA', 1],
  ['O', 2],
  ['R', 1],
  ['L', 4],
  ['O', 3],
  ['FB', 1],
  ['O', 4],
  ['R', 2],
  ['L', 5],
  ['FA', 2],
  ['O', 5],
  ['T', 1],
  ['FB', 2],
  ['L', 6],
  ['O', 6],
  ['R', 3],
  ['L', 7],
  ['T', 2],
  ['L', 8],
  ['R', 4],
];
const DELETED: [Key, number] = ['O', 5];
/** Output order after the deletion. */
const OUTPUT = ORDER.filter(([k, p]) => !(k === DELETED[0] && p === DELETED[1]));

const adapter = new PdfiumAdapter({ wasmUrl, inspector: new PdfLibAssembler() });
const assembler = new PdfLibAssembler();
const bytes = new Map<SourceId, ArrayBuffer>();
const sourceOf = new Map<Key, SourceId>();
let ws: Workspace;
let docId: DocumentId;
let result: AssemblyResult;
const OUT = sid('golden-output');

function pageIdOf(key: Key, page: number): PageId {
  const source = sourceOf.get(key);
  const doc = getDocument(ws, docId);
  const found = doc.pages.find(
    (p) => p.ref.kind === 'source' && p.ref.source === source && p.ref.index === page - 1,
  );
  if (!found) throw new Error(`page ${key}${page} not in document`);
  return found.id;
}

beforeAll(async () => {
  const ids = createSequentialIdGenerator('golden');
  ws = createWorkspace();
  const documents: DocumentId[] = [];
  for (const [key, { file, url }] of Object.entries(FILES) as [Key, (typeof FILES)[Key]][]) {
    const source = sid(`src-${key}`);
    const data = await fetchBytes(url);
    bytes.set(source, data.slice(0));
    const opened = await adapter.open(source, data);
    const added = addSource(
      ws,
      { ...opened, name: file, byteLength: bytes.get(source)?.byteLength ?? 0 },
      ids,
      { sourceId: source },
    );
    ws = added.workspace;
    documents.push(added.documentId);
    sourceOf.set(key, source);
  }
  ws = mergeDocuments(ws, { documentIds: documents, title: 'Merged' }, ids);
  docId = ws.activeDocument as DocumentId;
  ORDER.forEach(([key, page], index) => {
    ws = movePages(ws, {
      pageIds: [pageIdOf(key, page)],
      target: { document: docId, index },
    });
  });
  ws = rotatePages(ws, [pageIdOf('O', 1)], 270);
  ws = rotatePages(ws, [pageIdOf('R', 2)], 90);
  ws = deletePages(ws, [pageIdOf(...DELETED)]);

  const plan = planExport(ws, docId);
  const started = performance.now();
  result = await assembler.assemble({
    document: plan.document,
    sources: new Map(plan.sources.map((s) => [s, (bytes.get(s) as ArrayBuffer).slice(0)])),
    blobs: new Map(),
    sourceNames: plan.sourceNames,
  });
  logTiming('assemble six-source golden merge (23 pages)', started);
  await adapter.open(OUT, result.bytes.slice(0));
});

afterAll(async () => {
  await adapter.destroy();
});

describe('six-source merge (golden)', () => {
  test('the model order matches the scenario', () => {
    const doc = getDocument(ws, docId);
    expect(doc.pages).toHaveLength(OUTPUT.length);
    expect(doc.pages.map((p) => (p.ref.kind === 'source' ? p.ref.index : -1))).toEqual(
      OUTPUT.map(([, page]) => page - 1),
    );
  });

  test('page count and order via each page’s marker text', async () => {
    const opened = await adapter.open(sid('golden-count'), result.bytes.slice(0));
    await adapter.close(sid('golden-count'));
    expect(opened.pageCount).toBe(OUTPUT.length);
    for (const [index, [key, page]] of OUTPUT.entries()) {
      const text = (await adapter.getPageText(OUT, index)).map((r) => r.text).join('\n');
      expect(text, `output page ${index + 1}`).toContain(marker(FILES[key].file, page));
    }
  });

  test('rotations (intrinsic + user) survive, seen by PDFium and pdf-lib', async () => {
    const doc = getDocument(ws, docId);
    const expected = doc.pages.map((p) => pageTotalRotation(ws, p));
    // O1 rotated 270; R2 (intrinsic 90) rotated 90 more; the other R pages keep /Rotate.
    expect(expected[0]).toBe(270);
    expect(expected[OUTPUT.findIndex(([k, p]) => k === 'R' && p === 2)]).toBe(180);
    const opened = await adapter.open(sid('golden-rot'), result.bytes.slice(0));
    await adapter.close(sid('golden-rot'));
    expect(opened.pages.map((p) => p.rotation)).toEqual(expected);
    const out = await PDFDocument.load(result.bytes.slice(0), { updateMetadata: false });
    expect(out.getPages().map((p) => p.getRotation().angle)).toEqual(expected);
  });

  test('page labels: authored labels kept, other pages numbered by position', async () => {
    const doc = getDocument(ws, docId);
    const labels = effectiveLabels(ws, doc);
    OUTPUT.forEach(([key, page], index) => {
      if (key === 'L') {
        const authored = ['i', 'ii', 'iii', '1', '2', '3', 'A-1', 'A-2'][page - 1];
        expect(labels[index]).toBe(authored);
      } else {
        expect(labels[index]).toBe(String(index + 1));
      }
    });
    const opened = await adapter.open(sid('golden-labels'), result.bytes.slice(0));
    await adapter.close(sid('golden-labels'));
    expect(opened.pages.map((p) => p.label)).toEqual(labels);
  });

  test('outline: surviving titles in order, wrapped per source, at the new pages', async () => {
    const opened = await adapter.open(sid('golden-outline'), result.bytes.slice(0));
    await adapter.close(sid('golden-outline'));
    const flat: [string, number | undefined, number][] = [];
    const walk = (nodes: readonly EngineOutlineNode[], depth: number) => {
      for (const n of nodes) {
        flat.push([
          n.title,
          n.destination?.kind === 'page' ? n.destination.pageIndex : undefined,
          depth,
        ]);
        walk(n.children, depth + 1);
      }
    };
    walk(opened.outline, 0);
    const at = (key: Key, page: number) => OUTPUT.findIndex(([k, p]) => k === key && p === page);
    // "2.2 Results" and "2.2.1 Details" targeted the deleted page and are gone.
    expect(flat).toEqual([
      ['outline-named-dests', at('O', 1), 0],
      ['Chapter 1: Introduction', at('O', 1), 1],
      ['Chapter 2 – Methods', at('O', 3), 1],
      ['2.1 Setup', at('O', 4), 2],
      ['Appendix', at('O', 6), 1],
      ['page-labels', at('L', 1), 0],
      ['forms-a', at('FA', 1), 0],
      ['forms-b', at('FB', 1), 0],
      ['rotated-pages', at('R', 1), 0],
      ['tagged', at('T', 1), 0],
    ]);
    expect(result.report.outlineNodesKept).toBe(10);
  });

  test('the GoTo link and the named-destination link point at the new page indices', async () => {
    const at = (key: Key, page: number) => OUTPUT.findIndex(([k, p]) => k === key && p === page);
    const links = (await adapter.listAnnotations(OUT, at('O', 2))).filter(
      (a): a is LinkAnnotation => a.kind === 'link',
    );
    const targets = links.map((l) => l.targetPageIndex ?? l.uri);
    expect(targets).toContain(at('O', 4)); // GoTo (explicit) to source page 4
    expect(targets).toContain(at('O', 3)); // /Dest named "chapter-2" -> source page 3
    expect(targets).toContain('https://example.com/');
    expect(result.report.linksRewritten).toBe(2);
    expect(result.report.linksDropped).toBe(0);
  });

  test('form fields from both files exist under their source namespaces', async () => {
    const fields = await adapter.listFormFields(OUT);
    const names = fields.map((f) => f.name).sort();
    const base = ['name', 'agree', 'choice', 'country', 'address.city'];
    expect(names).toEqual(
      [
        ...base.map((n) => `forms-a.${n}`),
        'forms-a.only_in_a',
        ...base.map((n) => `forms-b.${n}`),
        'forms-b.only_in_b',
      ].sort(),
    );
    const value = (name: string) => fields.find((f) => f.name === name)?.value;
    expect(value('forms-a.name')).toBe('Alice Example');
    expect(value('forms-b.name')).toBe('Bob Example');
    expect(result.report.formFieldsRenamed).toHaveLength(12);
  });

  test('structure tree removed (tagged source included) and reported', async () => {
    expect(result.report.structureTreeRemoved).toBe(true);
    const out = await PDFDocument.load(result.bytes.slice(0), { updateMetadata: false });
    expect(out.catalog.get(PDFName.of('StructTreeRoot'))).toBeUndefined();
    expect(out.catalog.get(PDFName.of('MarkInfo'))).toBeUndefined();
    for (const page of out.getPages()) {
      expect(page.node.get(PDFName.of('StructParents'))).toBeUndefined();
    }
  });

  test('/ID present and different from every source’s', async () => {
    const idOf = async (data: ArrayBuffer) => {
      const doc = await PDFDocument.load(data.slice(0), { updateMetadata: false });
      const id = doc.context.lookupMaybe(doc.context.trailerInfo.ID, PDFArray);
      return (id?.get(0) as PDFHexString | undefined)?.asString();
    };
    const outId = await idOf(result.bytes);
    expect(outId).toMatch(/^[0-9A-F]{32}$/i);
    for (const data of bytes.values()) expect(await idOf(data)).not.toBe(outId);
  });

  test('verification with the planned expectation passes', async () => {
    const plan = planExport(ws, docId);
    expect(plan.expectation.outlineCount).toBe(10);
    const verdict = await adapter.verify(result.bytes.slice(0), {
      ...plan.expectation,
      formFieldNames: (await adapter.listFormFields(OUT)).map((f) => f.name),
    });
    expect(verdict).toEqual({ ok: true, problems: [] });
  });
});

test('timing: many-pages.pdf (400 pages, inherited attributes) reversed', async () => {
  const ids = createSequentialIdGenerator('many');
  const source = sid('many');
  const data = await fetchBytes(manyPagesUrl);
  const opened = await adapter.open(source, data.slice(0));
  const many = addSource(
    createWorkspace(),
    { ...opened, name: 'many-pages.pdf', byteLength: data.byteLength },
    ids,
    {
      sourceId: source,
    },
  ).workspace;
  const id = many.activeDocument as DocumentId;
  const plan = planExport(many, id);
  const started = performance.now();
  const out = await assembler.assemble({
    document: { ...plan.document, pages: [...plan.document.pages].reverse() },
    sources: new Map([[source, data]]),
    blobs: new Map(),
  });
  logTiming('assemble many-pages.pdf (400 pages, reversed)', started);
  const verified = performance.now();
  const verdict = await adapter.verify(out.bytes.slice(0), {
    pageCount: 400,
    pageSizes: [],
    rotations: [
      ...Array.from({ length: 20 }, () => 90),
      ...Array.from({ length: 380 }, () => 0),
    ] as (0 | 90)[],
  });
  logTiming('verify many-pages output', verified);
  expect(verdict).toEqual({ ok: true, problems: [] });
});
