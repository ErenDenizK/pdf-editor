/**
 * Edited outlines through the whole export pipeline: the model's outline editing
 * operations (document-model outline.ts) on a real file with named destinations, then
 * `planExport` -> assembler -> the PDFium verification pass, and the output re-opened with
 * PDFium (titles, nesting, targets, /XYZ positions, open state) and pdf-lib (/Count signs).
 */
import type { PDFNumber } from '@cantoo/pdf-lib';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef } from '@cantoo/pdf-lib';
import {
  addSource,
  countDeadOutlineLinks,
  createSequentialIdGenerator,
  createWorkspace,
  type DocumentId,
  deletePages,
  editOutline,
  getDocument,
  movePages,
  outlineItem,
  outlineMoveGap,
  type PageId,
  renameOutlineNode,
  setOutlineDestination,
  setOutlineOpen,
  type Workspace,
} from '@pdf-editor/document-model';
import outlineUrl from '../../../test/fixtures/outline-named-dests.pdf?url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { planExport } from '../src/export-plan';
import { PdfiumAdapter } from '../src/pdfium/pdfium-adapter';
import { PdfLibAssembler } from '../src/pdflib/pdflib-assembler';
import type { AssemblyResult, EngineOutlineNode } from '../src/types';
import { sid, wasmUrl } from './helpers';

const assembler = new PdfLibAssembler();
const adapter = new PdfiumAdapter({ wasmUrl, inspector: assembler });
const SOURCE = sid('outline-edit-src');

let ws: Workspace;
let docId: DocumentId;
let pages: PageId[];
let result: AssemblyResult;
let plan: ReturnType<typeof planExport>;

/** Pre-order: depth, title, target page index (or link / none), open (for parents). */
function flatten(nodes: readonly EngineOutlineNode[], depth = 0): string[] {
  return nodes.flatMap((node) => {
    const d = node.destination;
    const target =
      d?.kind === 'page' ? `p${d.pageIndex + 1}` : d?.kind === 'uri' ? 'link' : (d?.kind ?? '-');
    const open = node.children.length > 0 ? (node.open ? ' open' : ' closed') : '';
    return [
      `${'  '.repeat(depth)}${node.title} → ${target}${open}`,
      ...flatten(node.children, depth + 1),
    ];
  });
}

beforeAll(async () => {
  const bytes = await (await fetch(outlineUrl)).arrayBuffer();
  const opened = await adapter.open(SOURCE, bytes.slice(0));
  await adapter.close(SOURCE);
  const added = addSource(
    createWorkspace(),
    { ...opened, name: 'outline-named-dests.pdf', byteLength: bytes.byteLength },
    createSequentialIdGenerator('oe'),
    { sourceId: SOURCE },
  );
  ws = added.workspace;
  docId = added.documentId;
  pages = getDocument(ws, docId).pages.map((p) => p.id);
  const at = (path: readonly number[]) => path;

  // Authored: Chapter 1 (p1) · Chapter 2 (p3, open) [2.1 (p4), 2.2 (p5, closed) [2.2.1 (p5)]]
  // · Appendix (p6).
  // 1. Add a bookmark to page 2 at y = 500, after Chapter 1.
  ws = editOutline(ws, docId, {
    kind: 'insert',
    at: { parent: [], index: 1 },
    node: outlineItem('Page two', {
      kind: 'page',
      page: pages[1] as PageId,
      view: { fit: 'xyz', top: 500 },
    }),
  }).workspace;
  // 2. Rename "2.2.1 Details".
  ws = renameOutlineNode(ws, docId, at([2, 1, 0]), '  Details, revised ');
  // 3. Move "Appendix" under "Chapter 1" (drag into), then indent "Page two" under it too.
  ws = editOutline(ws, docId, { kind: 'move', from: [3], to: { parent: [0], index: 0 } }).workspace;
  const indent = outlineMoveGap(getDocument(ws, docId).outline, [1], 'indent');
  if (!indent) throw new Error('indent not possible');
  ws = editOutline(ws, docId, { kind: 'move', from: [1], to: indent }).workspace;
  // 4. Open "Chapter 1" and "2.2 Results" in the saved file, close "Chapter 2"; point "Chapter 1" at /Fit.
  ws = setOutlineOpen(ws, docId, [0], true);
  ws = setOutlineOpen(ws, docId, [1, 1], true);
  ws = setOutlineOpen(ws, docId, [1], false);
  ws = setOutlineDestination(ws, docId, [0], {
    kind: 'page',
    page: pages[0] as PageId,
    view: { fit: 'fit' },
  });
  // 5. Pages move and one is deleted: targets follow by id; the dead leaf is dropped.
  ws = movePages(ws, { pageIds: [pages[5] as PageId], target: { document: docId, index: 1 } });
  ws = deletePages(ws, [pages[3] as PageId]);

  plan = planExport(ws, docId);
  result = await assembler.assemble({
    document: plan.document,
    sources: new Map([[SOURCE, bytes.slice(0)]]),
    blobs: new Map(),
    sourceNames: plan.sourceNames,
  });
});

afterAll(async () => {
  await adapter.destroy();
});

describe('edited outline export', () => {
  test('the verification pass accepts the output and checks the edited titles', async () => {
    expect(plan.expectation.outlineTitles).toEqual([
      'Chapter 1: Introduction',
      'Appendix',
      'Page two',
      'Chapter 2 – Methods',
      '2.2 Results',
      'Details, revised',
    ]);
    const verified = await adapter.verify(result.bytes.slice(0), plan.expectation);
    expect(verified).toEqual({ ok: true, problems: [] });
    // It would notice a wrong tree.
    const wrong = await adapter.verify(result.bytes.slice(0), {
      ...plan.expectation,
      outlineTitles: ['Chapter 1: Introduction', 'Page two', 'Appendix'],
    });
    expect(wrong.ok).toBe(false);
    // The dead link ("2.1 Setup", its page deleted) is in the model; planExport drops it.
    expect(countDeadOutlineLinks(getDocument(ws, docId).outline)).toBe(1);
    expect(result.report.outlineNodesKept).toBe(6);
    expect(result.report.outlineNodesDropped).toBe(0);
  });

  test('PDFium reads back titles, nesting, targets and open state', async () => {
    const out = sid('outline-edit-out');
    const opened = await adapter.open(out, result.bytes.slice(0));
    await adapter.close(out);
    // Output pages: p1, Appendix page (moved to 2nd), p2, p3, p5 (p4 deleted).
    expect(flatten(opened.outline)).toEqual([
      'Chapter 1: Introduction → p1 open',
      '  Appendix → p2',
      '  Page two → p3',
      'Chapter 2 – Methods → p4 closed',
      '  2.2 Results → p5 open',
      '    Details, revised → p5',
    ]);
    const pageTwo = opened.outline[0]?.children[1]?.destination;
    expect(pageTwo).toMatchObject({ kind: 'page', pageIndex: 2, view: { fit: 'xyz', top: 500 } });
  });

  test('pdf-lib sees /Fit, /XYZ and the /Count signs', async () => {
    const doc = await PDFDocument.load(result.bytes.slice(0), { updateMetadata: false });
    const root = doc.catalog.lookup(PDFName.of('Outlines'), PDFDict);
    const first = root.lookup(PDFName.of('First'), PDFDict);
    const dest = first.lookup(PDFName.of('Dest'), PDFArray);
    expect(dest.get(1)).toBe(PDFName.of('Fit'));
    const ref = dest.get(0);
    expect(ref instanceof PDFRef && doc.getPage(0).ref === ref).toBe(true);
    const count = (dict: PDFDict) => (dict.get(PDFName.of('Count')) as PDFNumber).asNumber();
    expect(count(first)).toBe(2);
    const chapter2 = first.lookup(PDFName.of('Next'), PDFDict);
    // Closed: minus the items visible when it is opened (2.2 Results and its open child).
    expect(count(chapter2)).toBe(-2);
    // Root: Chapter 1 + its 2 children + Chapter 2 (closed).
    expect(count(root)).toBe(4);
    const pageTwo = first.lookup(PDFName.of('Last'), PDFDict).lookup(PDFName.of('Dest'), PDFArray);
    expect(pageTwo.get(1)).toBe(PDFName.of('XYZ'));
    expect((pageTwo.get(3) as PDFNumber).asNumber()).toBe(500);
  });
});
