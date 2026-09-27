/**
 * Facts the viewer needs from `open` and `search`: CropBox origins, streamed search hits
 * with match offsets, and outline open state and /XYZ parameters (read by the inspector
 * because EmbedPDF drops the /Count sign and reports null coordinates as 0). Also the
 * annotation post-pass running in the assembly worker.
 */

import type { PDFDict } from '@cantoo/pdf-lib';
import { PDFName, PDFNull, PDFNumber, PDFString } from '@cantoo/pdf-lib';
import cropboxUrl from '../../../test/fixtures/cropbox.pdf?url';
import outlineUrl from '../../../test/fixtures/outline-named-dests.pdf?url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { checkAnnotationConformance } from '../src/annotations/conformance';
import { PdfLibAssembler } from '../src/pdflib/pdflib-assembler';
import { PdfiumAdapter } from '../src/pdfium/pdfium-adapter';
import type { EngineOutlineNode, SearchHit } from '../src/types';
import { createAssemblerProxy } from '../src/worker/create-assembler-proxy';
import { makePdf, sid, wasmUrl } from './helpers';

const fetchBytes = async (url: string) => (await fetch(url)).arrayBuffer();

let adapter: PdfiumAdapter;

beforeAll(() => {
  adapter = new PdfiumAdapter({ wasmUrl, inspector: new PdfLibAssembler() });
});
afterAll(async () => {
  await adapter.destroy();
});

test('pages report their CropBox in user space', async () => {
  const opened = await adapter.open(sid('crop'), await fetchBytes(cropboxUrl));
  expect(opened.pages.map((p) => p.cropBox)).toEqual([
    { x: 72, y: 144, width: 468, height: 576 },
    { x: 150, y: 200, width: 300, height: 300 },
  ]);
  // Glyph rects are absolute user space: inside the CropBox, not at (0, 0).
  const runs = await adapter.getPageText(sid('crop'), 1);
  const visible = runs.find((r) => r.text.includes('VISIBLE PAGE 2'));
  expect(visible?.rect.x).toBeGreaterThanOrEqual(150);
  await adapter.close(sid('crop'));
});

describe('search', () => {
  test('streams hits per page and marks the match inside the context', async () => {
    const bytes = await makePdf([
      { size: [300, 200], text: 'alpha beta gamma' },
      { size: [300, 200], text: 'nothing here' },
      { size: [300, 200], text: 'beta again' },
    ]);
    await adapter.open(sid('search'), bytes);
    const progress: { page: number; hits: readonly SearchHit[] }[] = [];
    const hits = await adapter.search(sid('search'), 'beta', {
      onProgress: (pageHits, page) => progress.push({ page, hits: pageHits }),
    });
    expect(hits.map((h) => h.pageIndex)).toEqual([0, 2]);
    const streamed = progress.flatMap((p) => p.hits.map((h) => h.pageIndex));
    expect(streamed).toEqual([0, 2]);
    for (const hit of hits) {
      const start = hit.matchStart ?? -1;
      expect(hit.context.slice(start, start + (hit.matchLength ?? 0)).toLowerCase()).toBe('beta');
    }
    await adapter.close(sid('search'));
  });
});

describe('outline facts', () => {
  test('open state comes from the /Count sign', async () => {
    const opened = await adapter.open(sid('outline'), await fetchBytes(outlineUrl));
    const byTitle = new Map<string, EngineOutlineNode>();
    const walk = (nodes: readonly EngineOutlineNode[]) => {
      for (const n of nodes) {
        byTitle.set(n.title, n);
        walk(n.children);
      }
    };
    walk(opened.outline);
    expect(byTitle.get('Chapter 2 – Methods')?.open).toBe(true);
    expect(byTitle.get('2.2 Results')?.open).toBe(false);
    await adapter.close(sid('outline'));
  });

  test('/XYZ coordinates of exactly 0 are kept; null ones mean keep current', async () => {
    const bytes = await makePdf([{ size: [300, 400] }], (doc) => {
      const { context } = doc;
      const page = doc.getPage(0).ref;
      const root = context.obj({ Type: 'Outlines' });
      const rootRef = context.register(root);
      const item = (title: string, dest: unknown[], extra: Record<string, unknown> = {}) => {
        const dict = context.obj({
          Title: PDFString.of(title),
          Parent: rootRef,
          ...extra,
        } as never);
        (dict as unknown as PDFDict).set(PDFName.of('Dest'), context.obj(dest as never));
        return { dict: dict as unknown as PDFDict, ref: context.register(dict) };
      };
      const zero = item('Zero', [page, PDFName.of('XYZ'), 0, 0, PDFNull]);
      const child = item('Child', [page, PDFName.of('XYZ'), PDFNull, PDFNull, PDFNull]);
      const values = item('Values', [page, PDFName.of('XYZ'), 10, 350, 2]);
      child.dict.set(PDFName.of('Parent'), zero.ref);
      zero.dict.set(PDFName.of('First'), child.ref);
      zero.dict.set(PDFName.of('Last'), child.ref);
      zero.dict.set(PDFName.of('Count'), PDFNumber.of(1));
      zero.dict.set(PDFName.of('Next'), values.ref);
      values.dict.set(PDFName.of('Prev'), zero.ref);
      root.set(PDFName.of('First'), zero.ref);
      root.set(PDFName.of('Last'), values.ref);
      root.set(PDFName.of('Count'), PDFNumber.of(2));
      doc.catalog.set(PDFName.of('Outlines'), rootRef);
    });
    const opened = await adapter.open(sid('xyz'), bytes);
    const [zero, values] = opened.outline;
    expect(zero).toMatchObject({
      title: 'Zero',
      open: true,
      destination: { kind: 'page', pageIndex: 0, view: { fit: 'xyz', left: 0, top: 0 } },
    });
    expect(zero?.children[0]?.destination).toEqual({
      kind: 'page',
      pageIndex: 0,
      view: { fit: 'xyz' },
    });
    expect(values).toMatchObject({
      open: false,
      destination: { view: { fit: 'xyz', left: 10, top: 350, zoom: 2 } },
    });
    await adapter.close(sid('xyz'));
  });
});

test('the annotation post-pass and conformance check run in the assembly worker', async () => {
  const worker = new Worker(new URL('../src/worker/assembler.worker.ts', import.meta.url), {
    type: 'module',
  });
  const proxy = createAssemblerProxy(worker);
  const viaWorker = new PdfiumAdapter({ wasmUrl, inspector: proxy });
  try {
    await viaWorker.open(sid('w'), await makePdf([{ size: [300, 300] }]));
    await viaWorker.createAnnotation(sid('w'), {
      kind: 'text',
      pageIndex: 0,
      rect: { x: 20, y: 20, width: 20, height: 20 },
      contents: 'From the worker',
    });
    const saved = await viaWorker.save(sid('w'));
    expect(await checkAnnotationConformance(saved.slice(0))).toMatchObject({
      ok: true,
      counts: [1],
    });
    const verified = await viaWorker.verify(saved, {
      pageCount: 1,
      pageSizes: [{ width: 300, height: 300 }],
      checkAnnotations: true,
      annotationCounts: { 0: 1 },
    });
    expect(verified).toEqual({ ok: true, problems: [] });
  } finally {
    await viaWorker.destroy();
    proxy.dispose();
  }
});
