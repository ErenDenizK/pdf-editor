/**
 * The analysis worker behind `createAnalysisProxy`, fed by the PDFium worker's proxy exactly
 * as the app will do it: compare-a/b end to end (heat map and report transferred back),
 * conversion, cancellation, and the performance budget of spec §8.5 (200 pages at 100 dpi in
 * ≤ 60 s, no task over 200 ms) measured on many-pages.pdf against itself and a rotated copy,
 * and (opt-in, `VITE_ANALYSIS_PERF=1`) on 200 text-heavy Letter pages.
 */
import { degrees, PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
import type { SourceId } from '@pdf-editor/document-model';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import manifest from '../../../../test/fixtures/manifest.json';
import aUrl from '../../../../test/fixtures/compare-a.pdf?url';
import bUrl from '../../../../test/fixtures/compare-b.pdf?url';
import manyPagesUrl from '../../../../test/fixtures/many-pages.pdf?url';
import markdownUrl from '../../../../test/fixtures/markdown-source.pdf?url';
import { sid, wasmUrl } from '../../test/helpers';
import { checkAnnotationConformance } from '../annotations/conformance';
import { pdfiumConvertSource } from '../convert/pipeline';
import { EngineError, type CompareOptions, type OpenedDocument } from '../types';
import { type AnalysisProxy, createAnalysisProxy } from '../worker/create-analysis-proxy';
import { createPdfiumProxy, type PdfiumProxy } from '../worker/pdfium-proxy';
import { type CompareSource, pdfiumCompareSource } from './pipeline';

const golden = (
  manifest.fixtures.find((f) => f.file === 'markdown-source.pdf')?.expect as unknown as {
    markdown: { golden: string };
  }
).markdown.golden;

const fetchBytes = async (url: string) => (await fetch(url)).arrayBuffer();
const PERF =
  (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_ANALYSIS_PERF === '1';

let pdfium: PdfiumProxy;
let analysis: AnalysisProxy;
let counter = 0;

function newAnalysisWorker(): Worker {
  return new Worker(new URL('../worker/analysis.worker.ts', import.meta.url), {
    type: 'module',
    name: 'analysis test',
  });
}

beforeAll(() => {
  pdfium = createPdfiumProxy(
    new Worker(new URL('../worker/pdfium.worker.ts', import.meta.url), {
      type: 'module',
      name: 'pdfium test',
    }),
    { wasmUrl },
  );
  analysis = createAnalysisProxy(newAnalysisWorker());
});

afterAll(async () => {
  analysis.dispose();
  await pdfium.destroy();
});

interface Opened {
  readonly id: SourceId;
  readonly opened: OpenedDocument;
  readonly source: CompareSource;
}

/** Opens `bytes` in the PDFium worker; facts come from the analysis worker (pdf-lib). */
async function open(bytes: ArrayBuffer, name: string): Promise<Opened> {
  const id = sid(`w-${++counter}`);
  const copy = bytes.slice(0);
  const opened = await pdfium.open(id, bytes.slice(0));
  const source = pdfiumCompareSource(pdfium, id, opened, {
    name,
    facts: () => analysis.extractFacts(copy.slice(0)),
  });
  return { id, opened, source };
}

describe('through the workers', () => {
  test('compare-a vs compare-b: the seeded changes, a heat map and the report', async () => {
    const a = await open(await fetchBytes(aUrl), 'compare-a.pdf');
    const b = await open(await fetchBytes(bUrl), 'compare-b.pdf');
    const phases: string[] = [];
    const run = await analysis.compare(a.source, b.source, {
      onProgress: (p) => {
        if (phases[phases.length - 1] !== p.phase) phases.push(p.phase);
      },
    });
    const { result } = run;
    expect(phases).toEqual(['text', 'align', 'visual', 'text-diff', 'facts']);
    expect(result.pages.map((p) => [p.pair.a, p.pair.b])).toEqual([
      [0, 0],
      [1, 1],
      [2, undefined],
      [3, 2],
      [undefined, 3],
    ]);
    expect(result.text.changes.map((c) => [c.kind, c.a?.text, c.b?.text])).toEqual([
      ['changed', 'Monday', 'Tuesday'],
    ]);
    expect(result.facts.map((f) => [f.kind, f.key])).toEqual([['metadata', 'Title']]);
    // The heat map of page 2 has exactly the changed pixels.
    const visual = result.pages[1]!.visual!;
    const heat = await run.heatmap(visual.heatmapId!);
    expect([heat.width, heat.height]).toEqual([visual.width, visual.height]);
    let opaque = 0;
    for (let i = 3; i < heat.data.length; i += 4) if (heat.data[i] === 255) opaque++;
    expect(opaque).toBe(visual.changedPixels);
    // The report, built in the worker.
    const report = await analysis.buildReport(await fetchBytes(bUrl), result, {
      now: new Date('2026-09-28T12:00:00Z'),
    });
    const conformance = await checkAnnotationConformance(report);
    expect(conformance.ok).toBe(true);
    expect(conformance.counts.slice(1).reduce((n, c) => n + c, 0)).toBeGreaterThanOrEqual(4);
    await run.release();
    await expect(run.heatmap(visual.heatmapId!)).rejects.toThrow(/Unknown comparison/);
    await pdfium.close(a.id);
    await pdfium.close(b.id);
  });

  test('converts markdown-source.pdf to the golden through the workers', async () => {
    const id = sid('w-md');
    const opened = await pdfium.open(id, await fetchBytes(markdownUrl));
    const result = await analysis.convert(pdfiumConvertSource(pdfium, id, opened));
    expect(result.text).toBe(golden);
    expect(result.files.map((f) => f.path)).toEqual(['document.md', 'images/p1-1.png']);
    expect(result.zip!.byteLength).toBeGreaterThan(100);
    await pdfium.close(id);
  });

  test('a comparison is cancelled at once and the worker stays usable', async () => {
    const bytes = await fetchBytes(manyPagesUrl);
    const a = await open(bytes, 'many.pdf');
    const b = await open(bytes, 'many.pdf');
    const controller = new AbortController();
    const started = performance.now();
    const pending = analysis.compare(a.source, b.source, {
      signal: controller.signal,
      onProgress: (p) => {
        if (p.phase === 'visual' && p.done === 3) controller.abort();
      },
    });
    const error: unknown = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EngineError);
    expect((error as EngineError).code).toBe('aborted');
    expect(performance.now() - started).toBeLessThan(30_000);
    await pdfium.close(a.id);
    await pdfium.close(b.id);
    // Still usable.
    const x = await open(await fetchBytes(aUrl), 'a');
    const y = await open(await fetchBytes(aUrl), 'a');
    const run = await analysis.compare(x.source, y.source);
    expect(run.result.counts.identical).toBe(4);
    await run.release();
    await pdfium.close(x.id);
    await pdfium.close(y.id);
  });
});

// ---------------------------------------------------------------------------
// Performance (spec §8.5): 200 pages at 100 dpi ≤ 60 s, no task over 200 ms
// ---------------------------------------------------------------------------

/** The first `count` pages of `bytes`, optionally all rotated by `rotate`. */
async function slice(bytes: ArrayBuffer, count: number, rotate = 0): Promise<ArrayBuffer> {
  const source = await PDFDocument.load(bytes, { updateMetadata: false });
  const out = await PDFDocument.create({ updateMetadata: false });
  const pages = await out.copyPages(
    source,
    Array.from({ length: count }, (_, i) => i),
  );
  for (const page of pages) {
    if (rotate) page.setRotation(degrees((page.getRotation().angle + rotate) % 360));
    out.addPage(page);
  }
  return (await out.save()).slice().buffer;
}

/** 200 Letter pages of 40 lines of body text; `edit` changes one word on every tenth page. */
async function letterPages(count: number, edit: boolean): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const vocabulary =
    'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon'.split(
      ' ',
    );
  for (let p = 0; p < count; p++) {
    const page = doc.addPage([612, 792]);
    page.drawText(`Section ${p + 1}`, { x: 72, y: 730, size: 16, font });
    for (let l = 0; l < 40; l++) {
      const words = Array.from(
        { length: 12 },
        (_, w) => vocabulary[(p * 7 + l * 3 + w) % vocabulary.length]!,
      );
      if (edit && p % 10 === 0 && l === 5) words[4] = 'CHANGED';
      page.drawText(words.join(' '), { x: 72, y: 700 - l * 15, size: 10, font });
    }
  }
  return (await doc.save()).slice().buffer;
}

interface Measured {
  readonly label: string;
  readonly totalMs: number;
  readonly phases: Record<string, number>;
  readonly workerMaxSliceMs: number;
  readonly workerMaxSliceLabel: string;
  readonly mainMaxLongTaskMs: number;
  readonly result: Awaited<ReturnType<AnalysisProxy['compare']>>['result'];
}

async function measure(
  label: string,
  aBytes: ArrayBuffer,
  bBytes: ArrayBuffer,
  options: CompareOptions = {},
): Promise<Measured> {
  const a = await open(aBytes, 'a.pdf');
  const b = await open(bBytes, 'b.pdf');
  // Warm the PDFium worker (wasm compiled, first render done) before timing.
  await pdfium.renderPage(a.id, 0, { scale: 0.1 }).then((r) => r.bitmap.close());
  await analysis.resetStats();
  let longest = 0;
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) longest = Math.max(longest, entry.duration);
  });
  const longTasks = PerformanceObserver.supportedEntryTypes.includes('longtask');
  if (longTasks) observer.observe({ type: 'longtask', buffered: false });
  const phases: Record<string, number> = {};
  let last = performance.now();
  let current = '';
  const started = last;
  const run = await analysis.compare(a.source, b.source, {
    dpi: 100,
    ...options,
    onProgress: (p) => {
      const now = performance.now();
      if (current !== '') phases[current] = (phases[current] ?? 0) + now - last;
      current = p.phase;
      last = now;
    },
  });
  const end = performance.now();
  phases[current] = (phases[current] ?? 0) + end - last;
  observer.disconnect();
  const stats = await analysis.stats();
  await run.release();
  await pdfium.close(a.id);
  await pdfium.close(b.id);
  const measured: Measured = {
    label,
    totalMs: end - started,
    phases,
    workerMaxSliceMs: stats.maxSliceMs,
    workerMaxSliceLabel: stats.maxSliceLabel,
    mainMaxLongTaskMs: longTasks ? longest : -1,
    result: run.result,
  };
  const round = (v: number) => Math.round(v);
  // eslint-disable-next-line no-console -- intentional benchmark output
  console.info(
    `[timing] ${label}: total ${round(measured.totalMs)} ms; phases ${Object.entries(phases)
      .map(([k, v]) => `${k} ${round(v)}`)
      .join(
        ', ',
      )}; worker longest slice ${measured.workerMaxSliceMs.toFixed(1)} ms (${measured.workerMaxSliceLabel}); ` +
      `main-thread longest task ${round(measured.mainMaxLongTaskMs)} ms`,
  );
  return measured;
}

describe('performance: 200 pages at 100 dpi', () => {
  test('many-pages.pdf (first 200 pages) against itself', async () => {
    const pages = await slice(await fetchBytes(manyPagesUrl), 200);
    const m = await measure('many-pages 200 vs itself', pages, pages);
    expect(m.result.counts).toMatchObject({ identical: 200, changed: 0 });
    expect(m.totalMs).toBeLessThan(60_000);
    expect(m.workerMaxSliceMs).toBeLessThan(200);
    expect(m.mainMaxLongTaskMs).toBeLessThan(200);
  }, 120_000);

  test('many-pages.pdf (first 200 pages) against a rotated copy', async () => {
    const bytes = await fetchBytes(manyPagesUrl);
    const m = await measure(
      'many-pages 200 vs rotated copy',
      await slice(bytes, 200),
      await slice(bytes, 200, 90),
    );
    expect(m.result.settings.alignment).toBe('index');
    expect(m.result.counts).toMatchObject({
      changed: 200,
      textChanged: 0,
      textAdded: 0,
      textRemoved: 0,
    });
    expect(m.result.facts.filter((f) => f.kind === 'page-rotation')).toHaveLength(200);
    expect(m.totalMs).toBeLessThan(60_000);
    expect(m.workerMaxSliceMs).toBeLessThan(200);
    expect(m.mainMaxLongTaskMs).toBeLessThan(200);
  }, 120_000);

  // Opt-in (VITE_ANALYSIS_PERF=1): 400 renders and text reads keep the CPU busy for half a
  // minute, which would slow the tests running beside it in the suite.
  test.skipIf(!PERF)(
    '200 text-heavy Letter pages with a word changed on every tenth page',
    async () => {
      const m = await measure(
        '200 Letter pages, 20 edits',
        await letterPages(200, false),
        await letterPages(200, true),
      );
      expect(m.result.counts).toMatchObject({ identical: 180, changed: 20, textChanged: 20 });
      expect(m.totalMs).toBeLessThan(60_000);
      expect(m.workerMaxSliceMs).toBeLessThan(200);
      expect(m.mainMaxLongTaskMs).toBeLessThan(200);
    },
    180_000,
  );
});
