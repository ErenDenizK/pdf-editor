import type { PDFNumber } from '@cantoo/pdf-lib';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString } from '@cantoo/pdf-lib';
import type { OutlineNode, SourceId, VirtualPage } from '@pdf-editor/document-model';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { PdfiumAdapter } from '../src/pdfium/pdfium-adapter';
import { PdfLibAssembler } from '../src/pdflib/pdflib-assembler';
import type { AssemblyInput, AssemblyResult, TextRun } from '../src/types';
import { createAssemblerProxy } from '../src/worker/create-assembler-proxy';
import { logTiming, makePdf, pageNumberOverlay, pid, sid, vdoc, vpage, wasmUrl } from './helpers';

const A = sid('srcA');
const B = sid('srcB');

let adapter: PdfiumAdapter;
const assembler = new PdfLibAssembler();

beforeAll(() => {
  adapter = new PdfiumAdapter({ wasmUrl });
});
afterAll(async () => {
  await adapter.destroy();
});

function text(runs: readonly TextRun[]): string {
  return runs.map((r) => r.text).join(' ');
}

/** Source A: 4 portrait pages; page 1 has /Rotate 90; page 0 links to pages 2 and 3. */
async function sourceA(): Promise<ArrayBuffer> {
  return makePdf(
    [
      { size: [200, 300], text: 'A0' },
      { size: [200, 300], text: 'A1', rotation: 90 },
      { size: [200, 300], text: 'A2' },
      { size: [200, 300], text: 'A3' },
    ],
    (doc) => {
      doc.setTitle('Source A');
      const page0 = doc.getPage(0);
      const link = (target: number, y: number) =>
        doc.context.register(
          doc.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: [20, y, 120, y + 20],
            Border: [0, 0, 0],
            Dest: [doc.getPage(target).ref, 'Fit'],
          }),
        );
      page0.node.set(PDFName.of('Annots'), doc.context.obj([link(2, 200), link(3, 240)]));
    },
  );
}

async function sourceB(): Promise<ArrayBuffer> {
  return makePdf([
    { size: [300, 200], text: 'B0' },
    { size: [300, 200], text: 'B1' },
  ]);
}

describe('assemble: interleave, rotation, blank page, overlays, outline, labels', () => {
  let result: AssemblyResult;
  let pages: VirtualPage[];
  const progress: number[] = [];

  beforeAll(async () => {
    const watermark = {
      ...pageNumberOverlay,
      layer: 'behind' as const,
      template: 'WM',
      anchor: 'center' as const,
      offset: { x: 0, y: 0 },
      opacity: 0.3,
      rotate: 45,
    };
    pages = [
      vpage(
        { kind: 'source', source: A, index: 0 },
        { id: pid('a0'), overlays: [pageNumberOverlay, watermark] },
      ),
      vpage(
        { kind: 'source', source: B, index: 0 },
        { id: pid('b0'), overlays: [pageNumberOverlay] },
      ),
      vpage(
        { kind: 'source', source: A, index: 1 },
        { id: pid('a1'), rotation: 90, overlays: [pageNumberOverlay] },
      ),
      vpage(
        { kind: 'blank', size: { width: 100, height: 100 } },
        { id: pid('blank'), overlays: [pageNumberOverlay] },
      ),
      vpage(
        { kind: 'source', source: B, index: 1 },
        { id: pid('b1'), rotation: 270, overlays: [pageNumberOverlay] },
      ),
      vpage(
        { kind: 'source', source: A, index: 2 },
        { id: pid('a2'), overlays: [pageNumberOverlay] },
      ),
    ];
    const outline: OutlineNode[] = [
      { title: 'Intro', destination: { kind: 'page', page: pid('a0') }, open: true, children: [] },
      {
        title: 'Gone',
        destination: { kind: 'unresolved', reason: 'page deleted' },
        open: false,
        children: [],
      },
      {
        title: 'Chapter',
        destination: { kind: 'page', page: pid('b1'), view: { fit: 'fit' } },
        open: true,
        children: [
          {
            title: 'Sub',
            destination: { kind: 'page', page: pid('a2'), view: { fit: 'xyz', top: 100 } },
            open: false,
            children: [],
          },
        ],
      },
      {
        title: 'Web',
        destination: { kind: 'uri', uri: 'https://example.org/' },
        open: false,
        children: [],
      },
    ];
    const input: AssemblyInput = {
      document: vdoc(pages, {
        outline,
        labels: [
          { startIndex: 0, style: 'roman-lower' },
          { startIndex: 2, style: 'decimal', prefix: 'P-', firstNumber: 1 },
        ],
      }),
      sources: new Map<SourceId, ArrayBuffer>([
        [A, await sourceA()],
        [B, await sourceB()],
      ]),
      blobs: new Map(),
    };
    const started = performance.now();
    result = await assembler.assemble(input, { onProgress: (done) => progress.push(done) });
    logTiming('assemble 6 pages from 2 sources', started);
  });

  test('reports reconciliation', () => {
    expect(result.report).toMatchObject({
      outlineNodesKept: 4,
      outlineNodesDropped: 1,
      linksRewritten: 1,
      linksDropped: 1,
      formFieldsRenamed: [],
      structureTreeRemoved: false,
      xfaRemoved: false,
    });
    expect(progress.at(-1)).toBe(6);
  });

  test('pdf-lib sees page order, rotation, labels, outline and metadata', async () => {
    const out = await PDFDocument.load(result.bytes, { updateMetadata: false });
    expect(out.getPageCount()).toBe(6);
    expect(out.getPages().map((p) => p.getRotation().angle)).toEqual([0, 0, 180, 0, 270, 0]);
    const labels = out.catalog.lookup(PDFName.of('PageLabels'), PDFDict);
    const nums = labels.lookup(PDFName.of('Nums'), PDFArray);
    expect(nums.size()).toBe(4);
    expect((nums.get(0) as PDFNumber).asNumber()).toBe(0);
    expect((nums.get(2) as PDFNumber).asNumber()).toBe(2);
    const second = nums.lookup(3, PDFDict);
    expect(second.get(PDFName.of('S'))).toBe(PDFName.of('D'));
    expect(
      out.catalog.lookup(PDFName.of('Outlines'), PDFDict).get(PDFName.of('Count'))?.toString(),
    ).toBe('4');
    expect(out.getTitle()).toBe('Source A');
    expect(out.getProducer()).toBe('Recto');
    // The rewritten link targets output page 5 (A2); the one to A3 was dropped.
    const annots = out.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
    expect(annots.size()).toBe(1);
    const dest = annots.lookup(0, PDFDict).lookup(PDFName.of('Dest'), PDFArray);
    expect(dest.get(0)).toBe(out.getPage(5).ref);
    // Behind overlay is prepended: first content stream is ours, then the q-wrapped original.
    const contents = out.getPage(0).node.lookup(PDFName.of('Contents'), PDFArray);
    expect(contents.size()).toBeGreaterThanOrEqual(4);
  });

  test('PDFium sees the same structure and text in virtual order', async () => {
    const opened = await adapter.open(sid('assembled'), result.bytes.slice(0));
    expect(opened.pageCount).toBe(6);
    expect(opened.pages.map((p) => p.rotation)).toEqual([0, 0, 180, 0, 270, 0]);
    expect(opened.pages.map((p) => [p.size.width, p.size.height])).toEqual([
      [200, 300],
      [300, 200],
      [200, 300],
      [100, 100],
      [300, 200],
      [200, 300],
    ]);
    const markers = ['A0', 'B0', 'A1', '', 'B1', 'A2'];
    for (let i = 0; i < 6; i++) {
      const pageText = text(await adapter.getPageText(sid('assembled'), i));
      if (markers[i]) expect(pageText).toContain(markers[i]);
      expect(pageText).toContain(`${i + 1}/6`);
    }
    expect(text(await adapter.getPageText(sid('assembled'), 0))).toContain('WM');
    expect(opened.outline.map((n) => n.title)).toEqual(['Intro', 'Chapter', 'Web']);
    expect(opened.outline[0]?.destination).toMatchObject({ kind: 'page', pageIndex: 0 });
    expect(opened.outline[1]?.destination).toMatchObject({ kind: 'page', pageIndex: 4 });
    expect(opened.outline[1]?.children[0]).toMatchObject({
      title: 'Sub',
      destination: { kind: 'page', pageIndex: 5 },
    });
    expect(opened.outline[2]?.destination).toEqual({ kind: 'uri', uri: 'https://example.org/' });
    await adapter.close(sid('assembled'));
  });

  test('page number sits at the displayed bottom-center of a page rotated 270', async () => {
    await adapter.open(sid('rot'), result.bytes.slice(0));
    const runs = await adapter.getPageText(sid('rot'), 4);
    await adapter.close(sid('rot'));
    const number = runs.find((r) => r.text.includes('5/6'));
    expect(number).toBeDefined();
    // Box 300x200, /Rotate 270: displayed bottom edge is user x = 0, displayed horizontal
    // center is user y = 100; the text runs downward from y ~ 100 + width / 2.
    const rect = number?.rect ?? { x: 0, y: 0, width: 0, height: 0 };
    expect(rect.x).toBeGreaterThan(5);
    expect(rect.x).toBeLessThan(30);
    expect(rect.y + rect.height / 2).toBeGreaterThan(90);
    expect(rect.y + rect.height / 2).toBeLessThan(110);
  });

  test('verifier accepts the output and flags a wrong page count', async () => {
    const pageSizes = [
      { width: 200, height: 300 },
      { width: 300, height: 200 },
      { width: 200, height: 300 },
      { width: 100, height: 100 },
      { width: 300, height: 200 },
      { width: 200, height: 300 },
    ];
    expect((await adapter.verify(result.bytes.slice(0), { pageCount: 6, pageSizes })).ok).toBe(
      true,
    );
    const wrong = await adapter.verify(result.bytes.slice(0), { pageCount: 5, pageSizes });
    expect(wrong.ok).toBe(false);
    expect(wrong.problems[0]).toContain('expected 5');
  });
});

describe('assemble: forms, security, errors', () => {
  async function formSource(value: string): Promise<ArrayBuffer> {
    return makePdf([{ size: [300, 200] }], (doc) => {
      const field = doc.getForm().createTextField('name');
      field.setText(value);
      field.addToPage(doc.getPage(0), { x: 20, y: 100, width: 150, height: 24 });
    });
  }

  test('namespaces form fields by source when several sources contribute', async () => {
    const result = await assembler.assemble({
      document: vdoc([
        vpage({ kind: 'source', source: A, index: 0 }),
        vpage({ kind: 'source', source: B, index: 0 }),
      ]),
      sources: new Map([
        [A, await formSource('Ada')],
        [B, await formSource('Grace')],
      ]),
      blobs: new Map(),
    });
    expect(result.report.formFieldsRenamed).toEqual([
      { from: 'name', to: 'srcA.name' },
      { from: 'name', to: 'srcB.name' },
    ]);
    await adapter.open(sid('forms'), result.bytes);
    const fields = await adapter.listFormFields(sid('forms'));
    await adapter.close(sid('forms'));
    expect(fields.map((f) => [f.name, f.value, f.pageIndex])).toEqual([
      ['srcA.name', 'Ada', 0],
      ['srcB.name', 'Grace', 1],
    ]);
  });

  test('encrypts with AES-256 including strings', async () => {
    const source = await formSource('Confidential value');
    const result = await assembler.assemble(
      {
        document: vdoc([vpage({ kind: 'source', source: A, index: 0 })], {
          metadata: { policy: 'explicit', title: 'Top Secret Title' },
        }),
        sources: new Map([[A, source]]),
        blobs: new Map(),
      },
      {
        security: {
          algorithm: 'aes-256',
          userPassword: 'user-pw',
          ownerPassword: 'owner-pw',
          permissions: {
            print: true,
            printHighQuality: false,
            modify: false,
            copy: false,
            annotate: true,
            fillForms: true,
            accessibility: true,
            assemble: false,
          },
        },
      },
    );
    const raw = new TextDecoder('latin1').decode(result.bytes);
    expect(raw).not.toContain('Top Secret Title');
    expect(raw).not.toContain('Confidential value');
    await expect(adapter.open(sid('secure'), result.bytes.slice(0))).rejects.toMatchObject({
      code: 'password-required',
    });
    const opened = await adapter.open(sid('secure'), result.bytes.slice(0), {
      password: 'user-pw',
    });
    expect(opened.flags.encrypted).toBe(true);
    expect(opened.metadata.title).toBe('Top Secret Title');
    expect(opened.metadata.producer).toBe('Recto');
    const fields = await adapter.listFormFields(sid('secure'));
    expect(fields[0]?.value).toBe('Confidential value');
    await adapter.close(sid('secure'));
  });

  test('rejects encrypted sources with unsupported-encryption', async () => {
    const encrypted = await makePdf([{ size: [100, 100], text: 'x' }], (doc) => {
      doc.encrypt({ userPassword: 'pw', ownerPassword: 'owner' });
    });
    await expect(
      assembler.assemble({
        document: vdoc([vpage({ kind: 'source', source: A, index: 0 })]),
        sources: new Map([[A, encrypted]]),
        blobs: new Map(),
      }),
    ).rejects.toMatchObject({ code: 'unsupported-encryption' });
  });

  test('image pages and compatibility mode', async () => {
    // 1x1 red PNG.
    const png = Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
      ),
      (c) => c.charCodeAt(0),
    );
    const result = await assembler.assemble(
      {
        document: vdoc([
          vpage({ kind: 'image', blob: 'img' as never, size: { width: 300, height: 400 } }),
        ]),
        sources: new Map(),
        blobs: new Map([['img', png.buffer]]),
      },
      { compatibility: true },
    );
    const head = new TextDecoder('latin1').decode(result.bytes.slice(0, 8));
    expect(head).toBe('%PDF-1.4');
    expect(new TextDecoder('latin1').decode(result.bytes)).not.toContain('/ObjStm');
    const out = await PDFDocument.load(result.bytes);
    expect(out.getPage(0).getSize()).toEqual({ width: 300, height: 400 });
  });

  test('works behind the Comlink worker proxy with transfer and progress', async () => {
    const worker = new Worker(new URL('../src/worker/assembler.worker.ts', import.meta.url), {
      type: 'module',
    });
    const proxy = createAssemblerProxy(worker);
    try {
      const sourceBytes = await sourceB();
      const progress: number[] = [];
      const result = await proxy.assemble(
        {
          document: vdoc([
            vpage({ kind: 'source', source: B, index: 1 }),
            vpage({ kind: 'source', source: B, index: 0 }),
          ]),
          sources: new Map([[B, sourceBytes]]),
          blobs: new Map(),
        },
        { onProgress: (done) => progress.push(done) },
      );
      expect(sourceBytes.byteLength).toBe(0); // transferred
      expect(progress.length).toBeGreaterThan(0);
      const out = await PDFDocument.load(result.bytes);
      expect(out.getPageCount()).toBe(2);
      expect(result.report.warnings).toEqual([]);

      const error = await proxy
        .assemble({
          document: vdoc([vpage({ kind: 'source', source: A, index: 0 })]),
          sources: new Map(),
          blobs: new Map(),
        })
        .catch((e: unknown) => e);
      expect(error).toMatchObject({ name: 'EngineError', code: 'internal' });
    } finally {
      proxy.dispose();
    }
  });
});

test('PDFString import keeps pdf-lib tree-shaking honest', () => {
  expect(PDFString.of('x').asString()).toBe('x');
});
