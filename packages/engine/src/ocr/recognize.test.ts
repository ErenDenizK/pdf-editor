/**
 * Recognition end to end in the browser (spec §1.5, research 07 §3): the PDFium worker
 * renders each scan fixture page to PGM (`renderForOcr`), tesseract.js (served from this
 * origin, the patched worker, packs through `OcrPackStore`) recognises it, and the words are
 * checked against the manifest's ground truth (`expect.ocr`): word accuracy (the spike's LCS
 * measure), user-space boxes, quality states. Also: the per-page time budget on a noisy page
 * (the recognizer is replaced and the next page works), two recognizers in parallel, and no
 * request leaves the origin (fetch interceptor + resource timing on this page; the e2e test's
 * Playwright request log covers the workers' own requests).
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { ocrReportOf } from './quality';
import { createOcrRecognizer } from './recognizer';
import {
  boxRect,
  createProxy,
  edgeDistance,
  fixtureBytes,
  OCR_BASE,
  overhang,
  percentile,
  type ScanName,
  sid,
  truth,
  wordAccuracy,
} from './test-helpers';
import { encodePgm } from './pgm';
import { layerWordRect } from './verify';
import type { OcrPageResult, OcrRaster } from '../types';
import type { PdfiumProxy } from '../worker/pdfium-proxy';

let engine: PdfiumProxy;
const recognizer = createOcrRecognizer({ baseUrl: OCR_BASE, poolSize: 1 });
const foreignRequests: string[] = [];
const originalFetch = globalThis.fetch;
const numbers: Record<string, unknown> = {};

beforeAll(() => {
  engine = createProxy('pdfium ocr recognize test');
  // Every fetch this page makes during the run must stay on the origin.
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (url.origin !== location.origin) foreignRequests.push(url.href);
    return originalFetch(input, init);
  };
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await recognizer.dispose();
  await engine.destroy();
  // The numbers for the report (research 07 comparison), visible with --reporter=verbose.
  console.warn(`OCR numbers: ${JSON.stringify(numbers, null, 1)}`);
});

async function recognizeFixture(
  file: ScanName,
  dpi: number,
  codes?: readonly string[],
): Promise<{ results: OcrPageResult[]; rasters: OcrRaster[]; renderMs: number[] }> {
  const id = sid(`${file}@${dpi}`);
  await engine.open(id, await fixtureBytes(file));
  const expected = truth(file);
  const results: OcrPageResult[] = [];
  const rasters: OcrRaster[] = [];
  const renderMs: number[] = [];
  for (const page of expected.pages) {
    const t0 = performance.now();
    const raster = await engine.renderForOcr(id, page.page - 1, { dpi });
    renderMs.push(Math.round(performance.now() - t0));
    rasters.push({ ...raster, bytes: raster.bytes.slice(0) });
    results.push(await recognizer.recognize(raster, page.page - 1, codes ?? expected.languages));
  }
  await engine.close(id);
  return { results, rasters, renderMs };
}

describe('recognition of the scan fixtures', () => {
  test.each([
    // [fixture, dpi, minimum accuracy per page] – the spike read clean pages at 99–100%.
    ['scan-text.pdf', 300, [0.98, 0.95]],
    ['scan-text.pdf', 200, [0.98, 0.95]],
    ['scan-turkish.pdf', 300, [0.95]],
    ['scan-rotated.pdf', 300, [0.98]],
    ['scan-foreign-ocr.pdf', 300, [0.98]],
  ] as const)('%s at %i dpi', async (file, dpi, minimum) => {
    const { results, rasters, renderMs } = await recognizeFixture(file, dpi);
    const expected = truth(file);
    const summary: Record<string, unknown>[] = [];
    results.forEach((result, i) => {
      const page = expected.pages[i]!;
      const raster = rasters[i]!;
      const { accuracy, matches } = wordAccuracy(page, result.words);
      // Boxes: every matched word's user-space ink box against the manifest's.
      const deviations: number[] = [];
      for (const [o, t] of matches) {
        deviations.push(edgeDistance(result.words[o]!.rect, boxRect(page.words[t]!.box)));
      }
      const worst = [...matches]
        .map(([o, t]) => ({
          word: result.words[o]!.text,
          d:
            Math.round(edgeDistance(result.words[o]!.rect, boxRect(page.words[t]!.box)) * 100) /
            100,
        }))
        .sort((x, y) => y.d - x.d)
        .slice(0, 3);
      summary.push({
        worst,
        page: page.page,
        accuracy: Math.round(accuracy * 1000) / 10,
        words: result.words.length,
        truth: page.words.length,
        mean: Math.round(result.meanConfidence * 10) / 10,
        quality: result.quality,
        lowConfidence: result.lowConfidence,
        dropped: result.dropped,
        renderMs: renderMs[i],
        recognizeMs: result.durationMs,
        pixels: `${raster.width}x${raster.height}`,
        boxMedian: Math.round(percentile(deviations, 0.5) * 100) / 100,
        boxMax: Math.round(percentile(deviations, 1) * 100) / 100,
      });
      numbers[`${file} @${dpi}`] = summary;
      console.warn(`OCR ${file} @${dpi}: ${JSON.stringify(summary.at(-1))}`);
      expect(raster.dpi).toBe(dpi);
      expect(accuracy).toBeGreaterThanOrEqual(minimum[i] ?? 0.95);
      // Clean or lightly speckled 14–22 pt text at ≥ 200 dpi: Good (research 07: 95–96).
      expect(result.quality).toBe('good');
      expect(result.engine).toMatch(/^tesseract\.js 7\.0\.0 .*lstm, tessdata_fast 87416418$/);
      // Ink boxes: tesseract's pixel boxes mapped through `toUser` land on the manifest's
      // boxes (skewed page: axis-aligned bounds on both sides).
      if (page.skewDegrees === 0) {
        expect(percentile(deviations, 1)).toBeLessThan(1);
      } else {
        // The skewed page carries 2,500 seeded dust specks; tesseract merges a speck that
        // touches a word into its box (measured: 5 of 41 words beyond 2 pt at 200 dpi, where
        // the specks keep their full size, 2 of 40 at 300 dpi). A speck can only grow a box,
        // never move it, so no truth box sticks out of its OCR box by more than the slack of
        // the manifest's skewed boxes (bounds of the rotated glyph boxes, a little larger
        // than the ink: measured up to 1.3 pt at 300 dpi and 2.0 pt at 200 dpi).
        for (const [o, t] of matches) {
          expect(overhang(boxRect(page.words[t]!.box), result.words[o]!.rect)).toBeLessThan(2.5);
        }
        expect(percentile(deviations, 0.5)).toBeLessThan(1);
        expect(deviations.filter((d) => d <= 2).length / deviations.length).toBeGreaterThan(0.85);
      }
      // Words carry their line and a consistent layer geometry: the layer box of every word
      // is its ink box (geometry.ts `inkGeometry`), turned by its line's angle; only a flat
      // mark (a dash, below the 1 pt minimum size) gets a slightly taller box.
      for (const word of result.words) {
        expect(word.line).toBeGreaterThanOrEqual(0);
        expect(word.line).toBeLessThan(result.lines.length);
        expect(word.lowConfidence).toBe(word.confidence < 90);
        expect(word.angle).toBe(result.lines[word.line]!.angle);
        expect(word.fontSize).toBeGreaterThanOrEqual(1);
        const layer = layerWordRect(word);
        expect(overhang(word.rect, layer), word.text).toBeLessThan(0.01);
        expect(edgeDistance(layer, word.rect), word.text).toBeLessThan(
          word.fontSize === 1 ? 1 : 0.01,
        );
      }
    });
    numbers[`${file} @${dpi}`] = summary;
    if (file === 'scan-turkish.pdf') {
      // Every Turkish letter of the pangram lines comes back.
      const text = results[0]!.words.map((w) => w.text).join(' ');
      for (const letter of 'çğıöşüÇĞIİÖŞÜ') expect(text).toContain(letter);
    }
    if (file === 'scan-rotated.pdf') {
      // Read upright in display orientation; the baseline runs up the page in user space.
      const angles = results[0]!.words.map((w) => w.angle);
      expect(percentile(angles, 0.5)).toBeCloseTo(90, 0);
    }
  });

  test('tur+eng on the Turkish page, and the run report', async () => {
    const { results } = await recognizeFixture('scan-turkish.pdf', 300, ['tur', 'eng']);
    const { accuracy } = wordAccuracy(truth('scan-turkish.pdf').pages[0]!, results[0]!.words);
    numbers['scan-turkish.pdf tur+eng'] = Math.round(accuracy * 1000) / 10;
    expect(accuracy).toBeGreaterThanOrEqual(0.95);
    expect(results[0]!.languages).toEqual(['tur', 'eng']);
    const report = ocrReportOf(results, { totalMs: 1234.4 });
    expect(report).toMatchObject({
      pages: 1,
      languages: ['tur', 'eng'],
      byQuality: { good: 1, review: 0, poor: 0, 'no-text': 0 },
      words: results[0]!.words.length,
      timedOut: 0,
      totalMs: 1234,
    });
  });
});

/** Uniform noise: Tesseract finds thousands of "words" and takes very long (research 07). */
function noisePage(width: number, height: number, seed: number): OcrRaster {
  const grey = new Uint8Array(width * height);
  let a = seed >>> 0;
  for (let i = 0; i < grey.length; i++) {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    grey[i] = ((t ^ (t >>> 14)) >>> 0) % 256 < 110 ? 0 : 255;
  }
  const bytes = encodePgm(grey, width, height);
  return {
    pageIndex: 0,
    bytes: bytes.buffer as ArrayBuffer,
    width,
    height,
    dpi: 300,
    toUser: [72 / 300, 0, 0, -72 / 300, 0, (height * 72) / 300],
  };
}

describe('time budget, blank pages, cancellation and the pool', () => {
  test('a noisy page times out, its recognizer is replaced and the next page works', async () => {
    const quick = createOcrRecognizer({ baseUrl: OCR_BASE, poolSize: 1, pageTimeoutMs: 1500 });
    try {
      await quick.ensureLanguages(['eng']);
      expect(quick.alive).toBe(1);
      const t0 = performance.now();
      const noisy = await quick.recognize(noisePage(2400, 3200, 7), 0, ['eng']);
      const elapsed = performance.now() - t0;
      expect(noisy.timedOut).toBe(true);
      expect(noisy.quality).toBe('poor');
      expect(noisy.words).toEqual([]);
      expect(elapsed).toBeLessThan(4000);
      expect(quick.alive).toBe(0);
      // A real page on a fresh recognizer.
      const id = sid('budget-scan');
      await engine.open(id, await fixtureBytes('scan-text.pdf'));
      const raster = await engine.renderForOcr(id, 0, { dpi: 200 });
      await engine.close(id);
      const page = await quick.recognize(raster, 0, ['eng']);
      expect(page.timedOut).toBeUndefined();
      expect(page.quality).toBe('good');
      numbers.timeout = { budgetMs: 1500, elapsedMs: Math.round(elapsed) };
    } finally {
      await quick.dispose();
    }
  });

  test('a blank page is "no text found"', async () => {
    const grey = new Uint8Array(850 * 1100).fill(255);
    const raster: OcrRaster = {
      pageIndex: 0,
      bytes: encodePgm(grey, 850, 1100).buffer as ArrayBuffer,
      width: 850,
      height: 1100,
      dpi: 100,
      toUser: [0.72, 0, 0, -0.72, 0, 792],
    };
    const result = await recognizer.recognize(raster, 3, ['eng']);
    expect(result).toMatchObject({ pageIndex: 3, quality: 'no-text', meanConfidence: 0 });
    expect(result.words).toEqual([]);
  });

  test('cancelling a recognition rejects with aborted and the next call works', async () => {
    const controller = new AbortController();
    const pending = recognizer.recognize(noisePage(2400, 3200, 11), 0, ['eng'], {
      signal: controller.signal,
    });
    setTimeout(() => {
      controller.abort();
    }, 300);
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
    const id = sid('after-abort');
    await engine.open(id, await fixtureBytes('scan-turkish.pdf'));
    const raster = await engine.renderForOcr(id, 0, { dpi: 200 });
    await engine.close(id);
    expect((await recognizer.recognize(raster, 0, ['tur'])).quality).toBe('good');
  });

  test('two recognizers read two pages in parallel, with progress', async () => {
    const pool = createOcrRecognizer({ baseUrl: OCR_BASE, poolSize: 2 });
    try {
      const id = sid('pool-scan');
      await engine.open(id, await fixtureBytes('scan-text.pdf'));
      const rasters = [
        await engine.renderForOcr(id, 0, { dpi: 300 }),
        await engine.renderForOcr(id, 1, { dpi: 300 }),
      ];
      await engine.close(id);
      const progress: number[] = [];
      const t0 = performance.now();
      const results = await Promise.all(
        rasters.map((raster, i) =>
          pool.recognize(raster, i, ['eng'], {
            onProgress: (p) => {
              if (p.phase === 'recognize') progress.push(p.done);
            },
          }),
        ),
      );
      numbers.twoRecognizers = {
        wallMs: Math.round(performance.now() - t0),
        pageMs: results.map((r) => r.durationMs),
      };
      expect(pool.alive).toBe(2);
      expect(results.map((r) => r.quality)).toEqual(['good', 'good']);
      expect(progress.length).toBeGreaterThan(0);
      expect(Math.max(...progress)).toBe(1);
    } finally {
      await pool.dispose();
    }
    expect(pool.alive).toBe(0);
  });

  test('nothing was requested from another origin', () => {
    const resources = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((name) => new URL(name).origin !== location.origin);
    expect(foreignRequests).toEqual([]);
    expect(resources).toEqual([]);
  });
});
