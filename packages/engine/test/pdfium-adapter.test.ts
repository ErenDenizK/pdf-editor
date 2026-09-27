import { PDFDocument } from '@cantoo/pdf-lib';
import { createPdfiumEngine } from '@embedpdf/engines/pdfium-worker-engine';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { PdfiumAdapter } from '../src/pdfium/pdfium-adapter';
import { EngineError, type MarkupAnnotation, type TextRun } from '../src/types';
import { logTiming, makePdf, sid, toBuffer, wasmUrl } from './helpers';

const factoryCalls: { fontFallback: unknown }[] = [];
let adapter: PdfiumAdapter;
let sample: ArrayBuffer;

function textOf(runs: readonly TextRun[]): string {
  return runs.map((r) => r.text).join('\n');
}

beforeAll(async () => {
  adapter = new PdfiumAdapter({
    wasmUrl,
    engineFactory: (url, options) => {
      factoryCalls.push({ fontFallback: options.fontFallback });
      return createPdfiumEngine(url, options);
    },
  });
  sample = await makePdf([
    { size: [200, 300], text: 'Hello World' },
    { size: [200, 300], text: 'Rotated page', rotation: 90 },
    { size: [400, 250], text: 'Third' },
  ]);
  const started = performance.now();
  await adapter.open(sid('warmup'), sample.slice(0));
  logTiming('wasm init + first open', started);
  await adapter.close(sid('warmup'));
});

afterAll(async () => {
  await adapter.destroy();
});

describe('open', () => {
  test('disables the CDN font fallback by default', () => {
    expect(factoryCalls).toHaveLength(1);
    expect(factoryCalls[0]?.fontFallback).toBeNull();
  });

  test('reports page count, unrotated sizes, rotation, fingerprint and metadata', async () => {
    const doc = await adapter.open(sid('a'), sample.slice(0));
    expect(doc.pageCount).toBe(3);
    expect(doc.pages.map((p) => p.size)).toEqual([
      { width: 200, height: 300 },
      { width: 200, height: 300 },
      { width: 400, height: 250 },
    ]);
    expect(doc.pages.map((p) => p.rotation)).toEqual([0, 90, 0]);
    expect(doc.pages[0]?.label).toBeUndefined();
    expect(doc.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(doc.flags.encrypted).toBe(false);
    expect(doc.flags.hasAcroForm).toBe(false);
    expect(doc.metadata.producer).toContain('pdf-lib');
    expect(doc.outline).toEqual([]);
    await adapter.close(sid('a'));
  });

  test('maps password errors', async () => {
    const encrypted = await makePdf([{ size: [100, 100], text: 'Secret' }], (doc) => {
      doc.encrypt({ userPassword: 'open-sesame', ownerPassword: 'owner' });
    });
    await expect(adapter.open(sid('enc'), encrypted.slice(0))).rejects.toMatchObject({
      code: 'password-required',
    });
    await expect(
      adapter.open(sid('enc'), encrypted.slice(0), { password: 'wrong' }),
    ).rejects.toMatchObject({ code: 'password-incorrect' });
    const doc = await adapter.open(sid('enc'), encrypted.slice(0), { password: 'open-sesame' });
    expect(doc.flags.encrypted).toBe(true);
    await adapter.close(sid('enc'));
  });

  test('maps garbage to corrupt', async () => {
    const garbage = new TextEncoder().encode('this is not a pdf').buffer;
    const error = await adapter.open(sid('bad'), garbage).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EngineError);
    expect((error as EngineError).code).toBe('corrupt');
  });

  test('rejects with aborted when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      adapter.open(sid('abort'), sample.slice(0), { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'aborted' });
  });
});

describe('with an open document', () => {
  beforeAll(async () => {
    await adapter.open(sid('doc'), sample.slice(0));
  });
  afterAll(async () => {
    await adapter.close(sid('doc'));
  });

  test('renders at scale 1 and 2 with an extra 90 degree rotation', async () => {
    const started = performance.now();
    const r1 = await adapter.renderPage(sid('doc'), 0, { scale: 1 });
    logTiming('render 200x300pt page at scale 1', started);
    expect([r1.width, r1.height]).toEqual([200, 300]);
    expect([r1.bitmap.width, r1.bitmap.height]).toEqual([200, 300]);
    const r2 = await adapter.renderPage(sid('doc'), 0, { scale: 2, rotation: 90 });
    expect([r2.width, r2.height]).toEqual([600, 400]);
    // Page 1 already has /Rotate 90: +90 more shows it upright-but-flipped (180).
    const r3 = await adapter.renderPage(sid('doc'), 1, { scale: 1, rotation: 90 });
    expect([r3.width, r3.height]).toEqual([200, 300]);
    const t4 = performance.now();
    const r4 = await adapter.renderPage(sid('doc'), 2, { scale: 2 });
    logTiming('render 400x250pt page at scale 2', t4);
    expect([r4.width, r4.height]).toEqual([800, 500]);
  });

  test('renders a clip rectangle', async () => {
    const r = await adapter.renderPage(sid('doc'), 0, {
      scale: 2,
      clip: { x: 0, y: 0, width: 100, height: 50 },
    });
    expect([r.width, r.height]).toEqual([200, 100]);
  });

  test('extracts drawn text with user-space glyph boxes', async () => {
    const runs = await adapter.getPageText(sid('doc'), 0);
    expect(textOf(runs)).toBe('Hello World');
    const run = runs[0] as TextRun;
    // Drawn at baseline y=40, x=20, 14pt.
    expect(run.rect.x).toBeGreaterThanOrEqual(18);
    expect(run.rect.x).toBeLessThan(24);
    expect(run.rect.y).toBeGreaterThan(30);
    expect(run.rect.y + run.rect.height).toBeLessThan(60);
    expect(run.glyphs[0]?.text).toBe('H');
    expect(run.glyphs[0]?.fontSize).toBeCloseTo(14);
  });

  test('extracts text on a rotated page in unrotated user space', async () => {
    const runs = await adapter.getPageText(sid('doc'), 1);
    expect(textOf(runs)).toBe('Rotated page');
    const rect = (runs[0] as TextRun).rect;
    expect(rect.x).toBeGreaterThanOrEqual(18);
    expect(rect.x).toBeLessThan(24);
    expect(rect.y).toBeGreaterThan(30);
    expect(rect.width).toBeGreaterThan(rect.height);
  });

  test('search finds a term with a rect', async () => {
    const hits = await adapter.search(sid('doc'), 'world');
    expect(hits).toHaveLength(1);
    const hit = hits[0];
    expect(hit?.pageIndex).toBe(0);
    expect(hit?.context).toContain('World');
    const rect = hit?.rects[0];
    expect(rect).toBeDefined();
    expect(rect?.x).toBeGreaterThan(50);
    expect(rect?.y).toBeGreaterThan(30);
    expect(await adapter.search(sid('doc'), 'world', { matchCase: true })).toHaveLength(0);
  });

  test('highlight annotation create / list / update / delete roundtrip', async () => {
    const quad = { x: 20, y: 38, width: 80, height: 16 };
    const created = await adapter.createAnnotation(sid('doc'), {
      kind: 'highlight',
      pageIndex: 0,
      rect: quad,
      quads: [quad],
      color: '#FFEB3B',
      contents: 'note',
    });
    expect(created.id).not.toBe('');
    expect(created.kind).toBe('highlight');
    let list = await adapter.listAnnotations(sid('doc'), 0);
    const found = list.find((a) => a.id === created.id) as MarkupAnnotation | undefined;
    expect(found?.kind).toBe('highlight');
    expect(found?.contents).toBe('note');
    expect(found?.quads).toHaveLength(1);
    expect(found?.quads[0]?.x).toBeCloseTo(20, 0);
    expect(found?.quads[0]?.y).toBeCloseTo(38, 0);

    const updated = await adapter.updateAnnotation(sid('doc'), {
      ...(found as MarkupAnnotation),
      contents: 'changed',
    });
    expect(updated.contents).toBe('changed');

    const saved = await adapter.save(sid('doc'));
    const reopened = await PDFDocument.load(saved);
    const annots = reopened.getPage(0).node.Annots();
    expect(annots?.size()).toBe(1);

    await adapter.deleteAnnotation(sid('doc'), 0, created.id);
    list = await adapter.listAnnotations(sid('doc'), 0);
    expect(list.find((a) => a.id === created.id)).toBeUndefined();
  });

  test('creates ink, square and free-text annotations', async () => {
    const ink = await adapter.createAnnotation(sid('doc'), {
      kind: 'ink',
      pageIndex: 2,
      rect: { x: 10, y: 10, width: 100, height: 100 },
      paths: [
        [
          { x: 10, y: 10 },
          { x: 60, y: 80 },
          { x: 110, y: 20 },
        ],
      ],
      strokeWidth: 2,
      color: '#1E88E5',
    });
    const square = await adapter.createAnnotation(sid('doc'), {
      kind: 'square',
      pageIndex: 2,
      rect: { x: 150, y: 50, width: 60, height: 40 },
      strokeWidth: 1,
      color: '#E53935',
    });
    const freeText = await adapter.createAnnotation(sid('doc'), {
      kind: 'free-text',
      pageIndex: 2,
      rect: { x: 220, y: 150, width: 120, height: 30 },
      text: 'Typed',
      fontSize: 12,
    });
    const list = await adapter.listAnnotations(sid('doc'), 2);
    expect(list.map((a) => a.kind).sort()).toEqual(['free-text', 'ink', 'square']);
    const listedInk = list.find((a) => a.id === ink.id);
    expect(listedInk?.kind === 'ink' && listedInk.paths[0]?.length).toBe(3);
    expect(list.find((a) => a.id === freeText.id)).toMatchObject({
      kind: 'free-text',
      text: 'Typed',
    });
    for (const a of [ink, square, freeText]) await adapter.deleteAnnotation(sid('doc'), 2, a.id);
  });

  test('save roundtrip keeps pages and text', async () => {
    const bytes = await adapter.save(sid('doc'));
    expect(bytes).toBeInstanceOf(ArrayBuffer);
    const copy = await adapter.open(sid('copy'), bytes);
    expect(copy.pageCount).toBe(3);
    expect(copy.pages.map((p) => p.rotation)).toEqual([0, 90, 0]);
    expect(textOf(await adapter.getPageText(sid('copy'), 2))).toBe('Third');
    await adapter.close(sid('copy'));
  });
});

describe('forms', () => {
  test('lists and fills a text field', async () => {
    const bytes = await makePdf([{ size: [300, 200] }], (doc) => {
      const field = doc.getForm().createTextField('customer.name');
      field.setText('Ada');
      field.addToPage(doc.getPage(0), { x: 20, y: 100, width: 150, height: 24 });
    });
    const opened = await adapter.open(sid('form'), bytes);
    expect(opened.flags.hasAcroForm).toBe(true);
    const fields = await adapter.listFormFields(sid('form'));
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({
      name: 'customer.name',
      kind: 'text',
      value: 'Ada',
      pageIndex: 0,
    });
    await adapter.setFormFieldValue(sid('form'), 'customer.name', 'Grace');
    const saved = await adapter.save(sid('form'));
    const reloaded = await PDFDocument.load(saved);
    expect(reloaded.getForm().getTextField('customer.name').getText()).toBe('Grace');
    await adapter.close(sid('form'));
  });
});

describe('verify', () => {
  test('passes for matching expectations and detects a wrong page count', async () => {
    const bytes = await makePdf([
      { size: [200, 300], text: 'One' },
      { size: [200, 300], text: 'Two' },
    ]);
    const sizes = [
      { width: 200, height: 300 },
      { width: 200, height: 300 },
    ];
    expect(await adapter.verify(bytes.slice(0), { pageCount: 2, pageSizes: sizes })).toEqual({
      ok: true,
      problems: [],
    });
    const wrong = await adapter.verify(bytes.slice(0), { pageCount: 3, pageSizes: sizes });
    expect(wrong.ok).toBe(false);
    expect(wrong.problems.join(' ')).toContain('Page count is 2, expected 3');
  });

  test('detects text left inside a redacted region and wrong sizes', async () => {
    const bytes = await makePdf([{ size: [200, 300], text: 'Leaked', at: [20, 40] }]);
    const result = await adapter.verify(bytes, {
      pageCount: 1,
      pageSizes: [{ width: 210, height: 300 }],
      redactedRegions: [{ pageIndex: 0, rect: { x: 10, y: 30, width: 120, height: 30 } }],
    });
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes('Leaked'))).toBe(true);
    expect(result.problems.some((p) => p.includes('expected 210x300pt'))).toBe(true);
  });

  test('applyRedactions removes text under a redact annotation', async () => {
    const bytes = await makePdf([{ size: [200, 300], text: 'Classified', at: [20, 40] }]);
    await adapter.open(sid('redact'), bytes);
    const region = { x: 10, y: 30, width: 150, height: 30 };
    await adapter.createAnnotation(sid('redact'), {
      kind: 'redact',
      pageIndex: 0,
      rect: region,
      quads: [region],
    });
    await adapter.applyRedactions(sid('redact'));
    const saved = await adapter.save(sid('redact'));
    await adapter.close(sid('redact'));
    const result = await adapter.verify(saved, {
      pageCount: 1,
      pageSizes: [{ width: 200, height: 300 }],
      redactedRegions: [{ pageIndex: 0, rect: region }],
    });
    expect(result).toEqual({ ok: true, problems: [] });
  });
});

test('toBuffer helper produces a standalone ArrayBuffer', () => {
  expect(toBuffer(new Uint8Array([1, 2, 3])).byteLength).toBe(3);
});
