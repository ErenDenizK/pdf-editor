/**
 * The viewer's PDFium engine in our own worker (ADR-0011 §1), through `createPdfiumProxy`:
 * open, render (bitmap transferred), text, search progress, annotation + save round trip,
 * the inspector bridge, error codes, cancellation, and teardown.
 */
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import encryptedUrl from '../../../test/fixtures/encrypted-aes-128.pdf?url';
import manyPagesUrl from '../../../test/fixtures/many-pages.pdf?url';
import pageLabelsUrl from '../../../test/fixtures/page-labels.pdf?url';
import simpleTextUrl from '../../../test/fixtures/simple-text.pdf?url';
import { PdfLibAssembler } from '../src/pdflib/pdflib-assembler';
import { EngineError, type SearchHit } from '../src/types';
import { createPdfiumProxy, type PdfiumProxy } from '../src/worker/pdfium-proxy';
import { sid, wasmUrl } from './helpers';

const FIXTURES = new Map<string, ArrayBuffer>();

async function fixture(url: string): Promise<ArrayBuffer> {
  let bytes = FIXTURES.get(url);
  if (!bytes) {
    bytes = await (await fetch(url)).arrayBuffer();
    FIXTURES.set(url, bytes);
  }
  return bytes.slice(0);
}

function newWorker(): Worker {
  return new Worker(new URL('../src/worker/pdfium.worker.ts', import.meta.url), {
    type: 'module',
    name: 'pdfium test',
  });
}

let engine: PdfiumProxy;

beforeAll(() => {
  engine = createPdfiumProxy(newWorker(), { wasmUrl, inspector: new PdfLibAssembler() });
});

afterAll(async () => {
  await engine.destroy();
});

describe('PdfiumProxy', () => {
  test('opens a fixture (bytes transferred), renders a bitmap and reads text', async () => {
    const bytes = await fixture(simpleTextUrl);
    const opened = await engine.open(sid('p-open'), bytes);
    expect(bytes.byteLength).toBe(0);
    expect(opened.pageCount).toBe(3);
    expect(opened.pages[0]?.size).toEqual({ width: 612, height: 792 });
    expect(opened.metadata.title).toBe('Simple text fixture');

    const render = await engine.renderPage(sid('p-open'), 0, { scale: 0.5 });
    expect(render.bitmap).toBeInstanceOf(ImageBitmap);
    expect([render.width, render.height]).toEqual([306, 396]);
    expect([render.bitmap.width, render.bitmap.height]).toEqual([306, 396]);
    // Something was drawn: the marker line is dark on white.
    const canvas = new OffscreenCanvas(render.width, render.height);
    const context = canvas.getContext('2d')!;
    context.drawImage(render.bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, render.width, render.height).data;
    let dark = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i]! < 128) dark++;
    expect(dark).toBeGreaterThan(100);
    render.bitmap.close();

    const runs = await engine.getPageText(sid('p-open'), 0);
    expect(runs.map((r) => r.text)).toEqual([
      'PAGE 1 OF simple-text',
      'This is page 1 of a three-page US Letter document set in Helvetica.',
      'The quick brown fox jumps over the lazy dog.',
    ]);
    expect(runs[0]!.glyphs.length).toBeGreaterThan(10);
    await engine.close(sid('p-open'));
  });

  test('search reports every page through onProgress before resolving', async () => {
    await engine.open(sid('p-search'), await fixture(simpleTextUrl));
    const progress: number[] = [];
    const hits = await engine.search(sid('p-search'), 'OF simple-text', {
      onProgress: (_pageHits: readonly SearchHit[], pageIndex: number) => {
        progress.push(pageIndex);
      },
    });
    expect(hits.map((h) => h.pageIndex)).toEqual([0, 1, 2]);
    expect(progress).toEqual([0, 1, 2]);
    await engine.close(sid('p-search'));
  });

  test('annotation + save round trip; verify runs in the worker', async () => {
    await engine.open(sid('p-annot'), await fixture(simpleTextUrl));
    const runs = await engine.getPageText(sid('p-annot'), 0);
    const created = await engine.createAnnotation(sid('p-annot'), {
      kind: 'highlight',
      pageIndex: 0,
      rect: runs[0]!.rect,
      quads: [runs[0]!.rect],
      color: '#FFEB3B',
      contents: 'from the worker',
    });
    expect(created.id).toBeTruthy();
    const saved = await engine.save(sid('p-annot'));
    expect(saved).toBeInstanceOf(ArrayBuffer);
    expect(saved.byteLength).toBeGreaterThan(1000);

    const verified = await engine.verify(saved, {
      pageCount: 3,
      pageSizes: [
        { width: 612, height: 792 },
        { width: 612, height: 792 },
        { width: 612, height: 792 },
      ],
      annotationCounts: { 0: 1 },
      checkAnnotations: true,
      annotationIds: [created.id],
    });
    expect(verified).toEqual({ ok: true, problems: [] });
    // verify copies: the caller keeps its bytes.
    expect(saved.byteLength).toBeGreaterThan(1000);

    await engine.open(sid('p-annot-2'), saved);
    const annotations = await engine.listAnnotations(sid('p-annot-2'), 0);
    const highlight = annotations.find((a) => a.id === created.id);
    expect(highlight).toMatchObject({ kind: 'highlight', contents: 'from the worker' });
    await engine.close(sid('p-annot'));
    await engine.close(sid('p-annot-2'));
  });

  test('the caller-side inspector is reached through the bridge (page labels)', async () => {
    const opened = await engine.open(sid('p-labels'), await fixture(pageLabelsUrl));
    expect(opened.pages.map((p) => p.label)).toEqual([
      'i',
      'ii',
      'iii',
      '1',
      '2',
      '3',
      'A-1',
      'A-2',
    ]);
    await engine.close(sid('p-labels'));
  });

  test('engine error codes survive the thread boundary', async () => {
    const garbage = new TextEncoder().encode('not a pdf at all').buffer;
    await expect(engine.open(sid('p-bad'), garbage)).rejects.toMatchObject({
      name: 'EngineError',
      code: 'corrupt',
    });
    await expect(engine.open(sid('p-locked'), await fixture(encryptedUrl))).rejects.toMatchObject({
      code: 'password-required',
    });
    const unlocked = await engine.open(sid('p-locked'), await fixture(encryptedUrl), {
      password: 'user',
    });
    expect(unlocked.pageCount).toBe(3);
    await engine.close(sid('p-locked'));
    await expect(engine.getPageText(sid('p-never-opened'), 0)).rejects.toBeInstanceOf(EngineError);
  });

  test('a render can be aborted; the engine keeps working', async () => {
    await engine.open(sid('p-abort'), await fixture(manyPagesUrl));
    const already = new AbortController();
    already.abort();
    await expect(
      engine.renderPage(sid('p-abort'), 0, { scale: 1, signal: already.signal }),
    ).rejects.toMatchObject({ code: 'aborted' });

    // Queue several large renders and abort them while the worker is busy.
    const controller = new AbortController();
    const renders = Array.from({ length: 6 }, (_, i) =>
      engine.renderPage(sid('p-abort'), i, { scale: 4, signal: controller.signal }),
    );
    controller.abort();
    const settled = await Promise.allSettled(renders);
    for (const result of settled) {
      expect(result.status).toBe('rejected');
      expect((result as PromiseRejectedResult).reason).toMatchObject({ code: 'aborted' });
    }
    const after = await engine.renderPage(sid('p-abort'), 1, { scale: 0.25 });
    expect(after.width).toBeGreaterThan(0);
    after.bitmap.close();
    await engine.close(sid('p-abort'));
  });

  test('destroy terminates the worker and rejects pending and later calls', async () => {
    const worker = newWorker();
    const terminate = vi.spyOn(worker, 'terminate');
    const own = createPdfiumProxy(worker, { wasmUrl });
    await own.open(sid('d'), await fixture(simpleTextUrl));
    const pending = own.renderPage(sid('d'), 0, { scale: 2 });
    await own.destroy();
    expect(terminate).toHaveBeenCalledTimes(1);
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
    await expect(own.getPageText(sid('d'), 0)).rejects.toMatchObject({ code: 'internal' });
    own.dispose(); // idempotent
    expect(terminate).toHaveBeenCalledTimes(1);
  });
});
