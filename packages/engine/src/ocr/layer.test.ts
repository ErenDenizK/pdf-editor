/**
 * The invisible layer through the PDFium worker and the `ocr.apply` edit (spec §1.2–§1.5,
 * research 07 §4): page facts before and after, the layer written from real recognition of
 * `scan-text.pdf`, found by PDFium search and read back by pdf.js, the page render unchanged,
 * undo marked "replay required", replay byte-identical, and a re-run with `replace: 'ours'`
 * swapping the layer instead of stacking a second one. The same layer on `scan-rotated.pdf`
 * (`/Rotate 90`) and `scan-turkish.pdf` (every Turkish letter found by PDFium search),
 * `replace: 'all-invisible'` swapping `scan-foreign-ocr.pdf`'s foreign layer for ours, and
 * spec §1.5's "hit rects within 2 pt of the manifest boxes". Also: the embedded glyphless
 * font is the pinned file.
 */
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfjsWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import lock from '../../ocr/langs.lock.json';
import { applyEngineEditWithResult } from '../edits/apply';
import { isReplayRequired } from '../edits/text-edit';
import type { OcrLayerPlan, OcrPageResult, SearchHit } from '../types';
import type { PdfiumProxy } from '../worker/pdfium-proxy';
import { ocrApplyEdit } from './edit';
import { GLYPHLESS_FONT_SHA256, glyphlessFontBytes } from './glyphless-font';
import { sha256Hex } from './packs';
import { createOcrRecognizer } from './recognizer';
import {
  boxRect,
  createProxy,
  edgeDistance,
  fixtureBytes,
  normalizeWord,
  OCR_BASE,
  overhang,
  percentile,
  type ScanName,
  sid,
  truth,
  wordAccuracy,
} from './test-helpers';
import { layerWordRect } from './verify';

let engine: PdfiumProxy;
const recognizer = createOcrRecognizer({ baseUrl: OCR_BASE, poolSize: 1 });
let source: ArrayBuffer;
let results: OcrPageResult[];

beforeAll(async () => {
  engine = createProxy('pdfium ocr layer test');
  source = await fixtureBytes('scan-text.pdf');
  const id = sid('layer-recognize');
  await engine.open(id, source.slice(0));
  results = [];
  for (const page of truth('scan-text.pdf').pages) {
    const raster = await engine.renderForOcr(id, page.page - 1, { dpi: 300 });
    results.push(await recognizer.recognize(raster, page.page - 1, ['eng']));
  }
  await engine.close(id);
});

afterAll(async () => {
  await recognizer.dispose();
  await engine.destroy();
});

/** RGBA pixels of a page at 150 dpi (what the layer's own verification compares, too). */
async function pixels(id: string, pageIndex: number): Promise<Uint8ClampedArray> {
  const { bitmap, width, height } = await engine.renderPage(sid(id), pageIndex, {
    scale: 150 / 72,
  });
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('no 2d context');
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return context.getImageData(0, 0, width, height).data;
}

/** How many bytes differ (`toEqual` on megabytes of pixels takes far too long). */
function differing(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) return Math.max(a.length, b.length);
  let count = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) count++;
  return count;
}

/** Distinct words of at least three letters on a page, as the recognizer read them. */
function searchableWords(result: OcrPageResult): string[] {
  const words = result.words.map((w) => normalizeWord(w.text)).filter((w) => w.length >= 3);
  return [...new Set(words)];
}

/** The words pdf.js extracts from each page (a second reader, as Firefox would). */
async function pdfjsWords(bytes: ArrayBuffer): Promise<string[][]> {
  pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)) });
  try {
    const doc = await task.promise;
    const pages: string[][] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const content = await (await doc.getPage(n)).getTextContent();
      const text = content.items.map((item) => ('str' in item ? item.str : '')).join(' ');
      pages.push(text.split(/\s+/u).map(normalizeWord).filter(Boolean));
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

async function hitsOn(id: string, word: string, pageIndex: number): Promise<SearchHit[]> {
  const hits = await engine.search(sid(id), word, { matchCase: true, wholeWord: true });
  return hits.filter((hit) => hit.pageIndex === pageIndex);
}

test('the embedded glyphless font is the pinned pdf.ttf', async () => {
  const font = glyphlessFontBytes();
  expect(font.length).toBe(lock.glyphlessFont.bytes);
  expect(await sha256Hex(font)).toBe(lock.glyphlessFont.sha256);
  expect(GLYPHLESS_FONT_SHA256).toBe(lock.glyphlessFont.sha256);
});

describe('page facts', () => {
  test('a scan without text, and one carrying another tool’s invisible layer', async () => {
    await engine.open(sid('facts-scan'), source.slice(0));
    const facts = await engine.ocrPageFacts(sid('facts-scan'));
    expect(facts).toHaveLength(2);
    for (const page of facts) {
      expect(page).toMatchObject({
        visibleText: false,
        invisibleText: 'none',
        ourLayer: false,
        imageOnly: true,
      });
      expect(page.imageDpi).toBeCloseTo(200, 0);
    }
    await engine.close(sid('facts-scan'));

    await engine.open(sid('facts-foreign'), await fixtureBytes('scan-foreign-ocr.pdf'));
    const foreign = await engine.ocrPageFacts(sid('facts-foreign'));
    expect(foreign[0]).toMatchObject({ visibleText: false, invisibleText: 'foreign' });
    await engine.close(sid('facts-foreign'));
  });
});

describe('the ocr.apply edit', () => {
  test('writes a verified, searchable layer and leaves the pixels alone', async () => {
    const id = 'layer-apply';
    await engine.open(sid(id), source.slice(0));
    const before = [await pixels(id, 0), await pixels(id, 1)];

    const edit = ocrApplyEdit('ocr-run-1', sid(id), {
      pages: results,
      replace: 'none',
      lang: 'en',
    });
    const done = await applyEngineEditWithResult(engine, edit);
    const ocr = done.ocr;
    if (!ocr) throw new Error('ocr.apply returned no layer result');
    expect(ocr.verification.ok).toBe(true);
    expect(ocr.verification.problems).toEqual([]);
    expect(ocr.decrypted).toBe(false);
    const total = results.reduce((n, r) => n + r.words.length, 0);
    expect(ocr.wordsWritten + ocr.wordsSkipped).toBe(total);
    expect(ocr.wordsWritten).toBeGreaterThan(0.98 * total);
    for (const check of ocr.verification.pages) {
      expect(check.pixelsDiffering).toBe(0);
      expect(check.found).toBe(check.words);
    }

    // The open document is the layered one: our layer on both pages, still no visible text.
    const facts = await engine.ocrPageFacts(sid(id));
    for (const page of facts) {
      expect(page).toMatchObject({ visibleText: false, invisibleText: 'ours', ourLayer: true });
    }
    // Independently of the layer's own check: the render is unchanged…
    expect(differing(await pixels(id, 0), before[0]!)).toBe(0);
    expect(differing(await pixels(id, 1), before[1]!)).toBe(0);
    // …and PDFium search finds the recognised words (spec §1.5: ≥ 98%), each hit on its word.
    for (const result of results) {
      const words = searchableWords(result);
      let found = 0;
      for (const word of words) {
        const hits = await hitsOn(id, word, result.pageIndex);
        if (hits.length > 0) found++;
      }
      expect(found / words.length).toBeGreaterThanOrEqual(0.98);
    }

    // pdf.js reads the same words from the layered bytes (spec §1.5, the qa tool's second reader).
    const extracted = await pdfjsWords(ocr.bytes);
    for (const result of results) {
      const words = new Set(extracted[result.pageIndex]);
      const expected = searchableWords(result);
      const read = expected.filter((word) => words.has(word)).length;
      expect(read / expected.length).toBeGreaterThanOrEqual(0.98);
    }

    // Undo cannot run in place: the inverse says "replay required" and refuses to apply.
    expect(isReplayRequired(done.inverse)).toBe(true);
    await expect(applyEngineEditWithResult(engine, done.inverse)).rejects.toMatchObject({
      code: 'unsupported',
    });

    // Replay onto a freshly opened source gives the same bytes (no second recognition).
    await engine.open(sid('layer-replay'), source.slice(0));
    const replayed = await applyEngineEditWithResult(engine, {
      ...done.applied,
      source: sid('layer-replay'),
    });
    const replayedBytes = new Uint8Array(replayed.ocr?.bytes ?? new ArrayBuffer(0));
    expect(replayedBytes.length).toBe(ocr.bytes.byteLength);
    expect(differing(replayedBytes, new Uint8Array(ocr.bytes))).toBe(0);
    await engine.close(sid('layer-replay'));

    // Re-OCR with `replace: 'ours'`: one layer per page afterwards, not two.
    const word = searchableWords(results[0]!)[0]!;
    const hitsBefore = (await hitsOn(id, word, 0)).length;
    const rerun = await applyEngineEditWithResult(
      engine,
      ocrApplyEdit('ocr-run-2', sid(id), { pages: results, replace: 'ours', lang: 'en' }),
    );
    expect(rerun.ocr?.verification.ok).toBe(true);
    expect(rerun.ocr?.removed.ourLayers).toBe(2);
    expect((await hitsOn(id, word, 0)).length).toBe(hitsBefore);
    await engine.close(sid(id));
  }, 120_000);
});

/** Recognitions of the other scans, once per file (300 dpi, the manifest's languages). */
const recognised = new Map<ScanName, Promise<OcrPageResult[]>>();

function recognise(file: ScanName): Promise<OcrPageResult[]> {
  let pending = recognised.get(file);
  if (!pending) {
    pending = (async () => {
      const id = sid(`layer-recognize-${file}`);
      await engine.open(id, await fixtureBytes(file));
      try {
        const expected = truth(file);
        const out: OcrPageResult[] = [];
        for (const page of expected.pages) {
          const raster = await engine.renderForOcr(id, page.page - 1, { dpi: 300 });
          out.push(await recognizer.recognize(raster, page.page - 1, expected.languages));
        }
        return out;
      } finally {
        await engine.close(id);
      }
    })();
    recognised.set(file, pending);
  }
  return pending;
}

/** Opens `file` as `id`, applies its recognition with `replace`, and checks the result. */
async function applyScan(
  file: ScanName,
  id: string,
  replace: OcrLayerPlan['replace'],
): Promise<{
  pages: OcrPageResult[];
  removed: { ourLayers: number; invisibleTextObjects: number };
}> {
  const pages = file === 'scan-text.pdf' ? results : await recognise(file);
  await engine.open(sid(id), await fixtureBytes(file));
  const before = await Promise.all(pages.map((p) => pixels(id, p.pageIndex)));
  const done = await applyEngineEditWithResult(
    engine,
    ocrApplyEdit(`ocr-${id}`, sid(id), { pages, replace }),
  );
  const ocr = done.ocr;
  if (!ocr) throw new Error('ocr.apply returned no layer result');
  expect(ocr.verification.ok).toBe(true);
  expect(ocr.verification.problems).toEqual([]);
  for (const check of ocr.verification.pages) {
    expect(check.found).toBe(check.words);
    expect(check.within2pt).toBe(check.found);
    expect(check.pixelsDiffering).toBe(0);
  }
  // Independently of the layer's own check: the render is unchanged.
  for (const [i, page] of pages.entries()) {
    expect(differing(await pixels(id, page.pageIndex), before[i]!)).toBe(0);
  }
  return { pages, removed: ocr.removed };
}

describe('the layer on other scans', () => {
  test('scan-rotated.pdf (/Rotate 90): verified, our layer, words found by search', async () => {
    const id = 'layer-rotated';
    const { pages } = await applyScan('scan-rotated.pdf', id, 'none');
    const facts = await engine.ocrPageFacts(sid(id));
    expect(facts[0]).toMatchObject({ visibleText: false, invisibleText: 'ours', ourLayer: true });
    const words = searchableWords(pages[0]!);
    let found = 0;
    for (const word of words) if ((await hitsOn(id, word, 0)).length > 0) found++;
    expect(found / words.length).toBeGreaterThanOrEqual(0.98);
    await engine.close(sid(id));
  }, 120_000);

  test('scan-turkish.pdf: verified, and every Turkish letter is in some search hit', async () => {
    const id = 'layer-turkish';
    const { pages } = await applyScan('scan-turkish.pdf', id, 'none');
    const words = searchableWords(pages[0]!);
    const hitWords: string[] = [];
    for (const word of words) if ((await hitsOn(id, word, 0)).length > 0) hitWords.push(word);
    // Spec §1.5: search finds ≥ 95% of scan-turkish's words, every Turkish letter in some hit.
    expect(hitWords.length / words.length).toBeGreaterThanOrEqual(0.95);
    for (const letter of 'çğıöşüÇĞIİÖŞÜ') {
      expect(
        hitWords.some((w) => w.includes(letter)),
        `a hit containing ${letter}`,
      ).toBe(true);
    }
    // pdf.js reads the letters, too.
    const doc = await engine.save(sid(id));
    const extracted = (await pdfjsWords(doc)).flat().join(' ');
    for (const letter of 'çğıöşüÇĞIİÖŞÜ') expect(extracted).toContain(letter);
    await engine.close(sid(id));
  }, 120_000);

  test("scan-foreign-ocr.pdf with 'all-invisible': the foreign layer is replaced by ours", async () => {
    const id = 'layer-foreign';
    await engine.open(sid('layer-foreign-facts'), await fixtureBytes('scan-foreign-ocr.pdf'));
    const before = await engine.ocrPageFacts(sid('layer-foreign-facts'));
    expect(before[0]).toMatchObject({ invisibleText: 'foreign', ourLayer: false });
    const foreignHits = (await hitsOn('layer-foreign-facts', 'Scanned', 0)).length;
    expect(foreignHits).toBe(1);
    await engine.close(sid('layer-foreign-facts'));

    const { pages, removed } = await applyScan('scan-foreign-ocr.pdf', id, 'all-invisible');
    expect(removed.invisibleTextObjects).toBeGreaterThan(0);
    const facts = await engine.ocrPageFacts(sid(id));
    expect(facts[0]).toMatchObject({ visibleText: false, invisibleText: 'ours', ourLayer: true });
    // One hit per recognised occurrence: the foreign copy of each word is gone.
    const word = 'Scanned';
    const occurrences = pages[0]!.words.filter((w) => normalizeWord(w.text) === word).length;
    expect(occurrences).toBe(1);
    expect((await hitsOn(id, word, 0)).length).toBe(1);
    await engine.close(sid(id));
  }, 120_000);
});

describe('spec §1.5: hit rects within 2 pt of the manifest boxes', () => {
  test.each([
    'scan-rotated.pdf',
    'scan-turkish.pdf',
    'scan-foreign-ocr.pdf',
    'scan-text.pdf',
  ] as const)(
    '%s',
    async (file) => {
      const id = `layer-hits-${file}`;
      const { pages } = await applyScan(
        file,
        id,
        file === 'scan-foreign-ocr.pdf' ? 'all-invisible' : 'none',
      );
      const expected = truth(file);
      for (const [i, result] of pages.entries()) {
        const page = expected.pages[i]!;
        const { matches } = wordAccuracy(page, result.words);
        const deviations: number[] = [];
        const covered: number[] = [];
        for (const [o, t] of matches) {
          const word = result.words[o]!;
          const box = boxRect(page.words[t]!.box);
          const rects = (await hitsOn(id, word.text, result.pageIndex)).flatMap((h) => h.rects);
          expect(rects.length, `hits for ${word.text}`).toBeGreaterThan(0);
          // The hit on this word: the one nearest to its ink.
          const nearest = rects.reduce((a, b) =>
            edgeDistance(a, box) <= edgeDistance(b, box) ? a : b,
          );
          deviations.push(edgeDistance(nearest, box));
          // Selection covers the ink (search rects are whole device pixels: ≤ 1 pt of rounding).
          covered.push(overhang(box, nearest));
          // Always within the layer's own tolerance of the box it was written to.
          expect(edgeDistance(nearest, layerWordRect(word))).toBeLessThanOrEqual(2);
        }
        const summary = {
          file,
          page: page.page,
          words: deviations.length,
          median: percentile(deviations, 0.5),
          max: percentile(deviations, 1),
          overhang: percentile(covered, 1),
        };
        console.warn(`OCR hit rects: ${JSON.stringify(summary)}`);
        expect(deviations.length).toBeGreaterThan(0.95 * page.words.length);
        if (page.skewDegrees === 0) {
          // Measured (M5 review): max 1.10 pt (rotated), 1.03 (Turkish), 1.04 (foreign); no
          // manifest box sticks out of its hit by more than 0.21 pt.
          expect(percentile(deviations, 1)).toBeLessThanOrEqual(2);
          expect(percentile(covered, 1)).toBeLessThan(0.5);
        } else {
          // The skewed page's dust specks: tesseract merges a speck touching a word into its
          // box (recognize.test.ts), so its hit is the grown box; the rest are within 2 pt.
          expect(percentile(deviations, 0.5)).toBeLessThan(1);
          expect(deviations.filter((d) => d <= 2).length / deviations.length).toBeGreaterThan(0.9);
          // Its manifest boxes bound the rotated glyph boxes, a little larger than the ink.
          expect(percentile(covered, 1)).toBeLessThan(1.5);
        }
      }
      await engine.close(sid(id));
    },
    120_000,
  );
});
