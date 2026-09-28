/**
 * SPIKE S1 (M5): not product code. Question 2 of docs/research/07-ocr-spike.md: word
 * accuracy, time and memory of tesseract.js 7 (LSTM-only core, served from our origin) on
 * pages rasterised by the app's PDFium adapter, tessdata_fast versus `4.0.0_best_int`, eng
 * and tur, at 200/300/400 dpi, one and two recognizers; and which coordinates `rotateAuto`
 * reports. Writes results/ocr-accuracy.json.
 *
 *   pnpm --filter @pdf-editor/ocr-spike spike ocr-accuracy
 *
 * Pages: simple-text.pdf p1 (digital), a dense English and a dense Turkish A4 page (Noto
 * Serif 11 pt, every Turkish letter), and "scans" of both made by makeScan at four quality
 * levels (sampling DPI, skew, blur, noise, JPEG quality). Chromium only; timings are from
 * the machine the spike ran on (see the report).
 */
import type { SourceId } from '@pdf-editor/document-model';
import { beforeAll, expect, test } from 'vitest';
import { commands } from 'vitest/browser';

import simpleTextUrl from '../../test/fixtures/simple-text.pdf?url';
import {
  accuracy,
  coreVariant,
  createRecognizer,
  denseTextPage,
  lcsMatches,
  makeScan,
  normalizeWord,
  openPdf,
  type OcrPage,
  type Pack,
  pdfium,
  pgm,
  png,
  recognize,
  renderGrey,
  SENTENCES_EN,
  SENTENCES_TR,
  type ScanOptions,
  type TextPage,
  type TruthWord,
} from './spike-lib';

interface Fixture {
  readonly name: string;
  readonly lang: 'eng' | 'tur';
  readonly bytes: Uint8Array;
  readonly truth: readonly TruthWord[];
  /** For the rotateAuto check: truth in the scan's own coordinates and before skewing. */
  readonly original?: readonly TruthWord[];
}

const results: Record<string, unknown> = {
  userAgent: navigator.userAgent,
  hardwareConcurrency: navigator.hardwareConcurrency,
  coreVariant: coreVariant(),
};
const fixtures: Fixture[] = [];

const QUALITIES: readonly (readonly [string, Omit<ScanOptions, 'seed'>])[] = [
  ['scan300', { dpi: 300, skew: 1.5, noise: 12, blur: 0, jpegQuality: 0.85 }],
  ['scan200', { dpi: 200, skew: -0.8, noise: 20, blur: 0.6, jpegQuality: 0.75 }],
  ['scan150', { dpi: 150, skew: 2.5, noise: 35, blur: 1.0, jpegQuality: 0.6 }],
  ['scan120', { dpi: 120, skew: 2, noise: 38, blur: 1.1, jpegQuality: 0.55 }],
  ['scan100', { dpi: 100, skew: 3, noise: 45, blur: 1.2, jpegQuality: 0.5 }],
];

async function simpleTextFixture(): Promise<Fixture> {
  const bytes = new Uint8Array(await (await fetch(simpleTextUrl)).arrayBuffer());
  const id = await openPdf(bytes);
  const runs = await pdfium().getPageText(id, 0);
  await pdfium().close(id);
  const truth = runs.flatMap((run) =>
    run.text
      .split(/\s+/)
      .filter((t) => t !== '')
      .map((text) => ({ text, rect: run.rect })),
  );
  return { name: 'simple-text p1 (digital)', lang: 'eng', bytes, truth };
}

beforeAll(async () => {
  fixtures.push(await simpleTextFixture());
  const dense: [string, 'eng' | 'tur', TextPage][] = [
    ['en', 'eng', await denseTextPage(SENTENCES_EN, 1, 42, 'Annual report of the committee')],
    ['tr', 'tur', await denseTextPage(SENTENCES_TR, 2, 42, 'Belediye meclisi toplantı notları')],
  ];
  let seed = 10;
  for (const [key, lang, page] of dense) {
    fixtures.push({ name: `${key} dense (digital)`, lang, bytes: page.bytes, truth: page.words });
    for (const [quality, options] of QUALITIES) {
      const scan = await makeScan(page, { ...options, seed: seed++ });
      fixtures.push({
        name: `${key} ${quality}`,
        lang,
        bytes: scan.bytes,
        truth: scan.words,
        original: page.words,
      });
    }
  }
  results.fixtures = fixtures.map((f) => ({ name: f.name, words: f.truth.length }));
});

/** Each test writes its own file as it goes, so a partial or filtered run keeps its data. */
async function save(section: string, data: unknown): Promise<void> {
  const host = await commands.hostLoad();
  await commands.writeFile(
    `results/accuracy-${section}.json`,
    `${JSON.stringify({ ...results, host, [section]: data }, null, 2)}\n`,
  );
}

interface Run {
  page: string;
  pack: Pack;
  langs: string;
  dpi: number;
  renderMs: number;
  recognizeMs: number;
  pixels: number;
  words: number;
  meanConfidence: number;
  wordAccuracy: number;
  cer: number;
  /** The same after dropping words under confidence 30 (spec §1.3). */
  kept: number;
  meanConfidenceKept: number;
  wordAccuracyKept: number;
  /** Share of kept words that are correct. */
  precisionKept: number;
}

async function rasterPgm(
  bytes: Uint8Array,
  dpi: number,
): Promise<{ image: Uint8Array; ms: number }> {
  const id: SourceId = await openPdf(bytes);
  const t0 = performance.now();
  const grey = await renderGrey(id, 0, dpi);
  const image = pgm(grey);
  const ms = performance.now() - t0;
  await pdfium().close(id);
  return { image, ms };
}

test('PGM is accepted and reads the same as PNG; encode cost', async () => {
  const fixture = fixtures.find((f) => f.name === 'en scan300');
  if (!fixture) throw new Error('fixture');
  const id = await openPdf(fixture.bytes);
  const grey = await renderGrey(id, 0, 300);
  await pdfium().close(id);
  let t0 = performance.now();
  const asPgm = pgm(grey);
  const pgmMs = performance.now() - t0;
  t0 = performance.now();
  const asPng = await png(grey);
  const pngMs = performance.now() - t0;
  const worker = await createRecognizer('fast', ['eng']);
  const a = await recognize(worker, asPgm);
  const b = await recognize(worker, asPng);
  await worker.terminate();
  const imageFormat = {
    pixels: grey.width * grey.height,
    pgmBytes: asPgm.length,
    pgmEncodeMs: Math.round(pgmMs),
    pngBytes: asPng.length,
    pngEncodeMs: Math.round(pngMs),
    pgmRecognizeMs: Math.round(a.ms),
    pngRecognizeMs: Math.round(b.ms),
    sameWords: a.words.map((w) => w.text).join(' ') === b.words.map((w) => w.text).join(' '),
  };
  await save('image-format', imageFormat);
  expect(a.words.length).toBeGreaterThan(100);
  expect(imageFormat.sameWords).toBe(true);
});

const BANDS = [0, 30, 50, 60, 70, 80, 85, 90, 95, 101];

test.each(['fast', 'best_int'] as const)('accuracy and time matrix: %s', async (pack) => {
  const runs: Run[] = [];
  const startup: Record<string, number> = {};
  const perWord: { confidence: number; correct: boolean }[] = [];
  const bands = () =>
    BANDS.slice(0, -1).map((lo, i) => {
      const hi = BANDS[i + 1] ?? 101;
      const inBand = perWord.filter((w) => w.confidence >= lo && w.confidence < hi);
      const correct = inBand.filter((w) => w.correct).length;
      return {
        band: `${lo}–${hi - 1}`,
        words: inBand.length,
        correctPct: inBand.length ? Math.round((1000 * correct) / inBand.length) / 10 : null,
      };
    });
  // Full DPI sweep on the digital and the two better scans; the degraded scans (used to
  // calibrate the quality thresholds) at 300 dpi only; tur+eng on the Turkish 300 dpi scan.
  const plan: [readonly string[], (f: Fixture) => boolean, readonly number[]][] = [
    [['eng'], (f) => f.lang === 'eng' && !f.name.includes('scan1'), [200, 300, 400]],
    [['eng'], (f) => f.lang === 'eng' && f.name.includes('scan1'), [300]],
    [['tur'], (f) => f.lang === 'tur' && !f.name.includes('scan1'), [200, 300, 400]],
    [['tur'], (f) => f.lang === 'tur' && f.name.includes('scan1'), [300]],
    [['tur', 'eng'], (f) => f.name === 'tr scan300', [300]],
  ];
  for (const [langs, select, dpis] of plan) {
    const t0 = performance.now();
    const worker = await createRecognizer(pack, langs);
    startup[`${pack} ${langs.join('+')}`] = Math.round(performance.now() - t0);
    for (const fixture of fixtures.filter(select)) {
      for (const dpi of dpis) {
        const { image, ms } = await rasterPgm(fixture.bytes, dpi);
        const page = await recognize(worker, image);
        const acc = accuracy(fixture.truth, page);
        perWord.push(...acc.perWord);
        const keptWords = page.words.filter((w) => w.confidence >= 30);
        const kept: OcrPage = {
          ...page,
          words: keptWords,
          meanConfidence:
            keptWords.reduce((sum, w) => sum + w.confidence, 0) / Math.max(1, keptWords.length),
        };
        const accKept = accuracy(fixture.truth, kept);
        const round1 = (v: number) => Math.round(v * 10) / 10;
        const run: Run = {
          page: fixture.name,
          pack,
          langs: langs.join('+'),
          dpi,
          renderMs: Math.round(ms),
          recognizeMs: Math.round(page.ms),
          pixels: image.length,
          words: page.words.length,
          meanConfidence: Math.round(page.meanConfidence * 10) / 10,
          wordAccuracy: Math.round(acc.wordAccuracy * 1000) / 10,
          cer: Math.round(acc.cer * 1000) / 10,
          kept: keptWords.length,
          meanConfidenceKept: round1(kept.meanConfidence),
          wordAccuracyKept: round1(accKept.wordAccuracy * 100),
          precisionKept: round1(
            (100 * accKept.perWord.filter((w) => w.correct).length) / Math.max(1, keptWords.length),
          ),
        };
        runs.push(run);
        console.log(JSON.stringify(run));
        await save(`matrix-${pack}`, { startup, runs, confidenceBands: bands() });
      }
    }
    await worker.terminate();
  }
  expect(runs.length).toBeGreaterThan(20);
});

test('rotateAuto: which coordinates the word boxes are in', async () => {
  const fixture = fixtures.find((f) => f.name === 'en scan300');
  if (!fixture?.original) throw new Error('fixture');
  const { image } = await rasterPgm(fixture.bytes, 300);
  const worker = await createRecognizer('fast', ['eng']);
  const plain = await recognize(worker, image, { rotateAuto: false });
  const auto = await recognize(worker, image, { rotateAuto: true });
  await worker.terminate();
  const s = 72 / 300;
  const pageHeight = 841.89;
  // Words paired by sequence alignment (LCS of normalised words), then box centres compared.
  const error = (page: OcrPage, truth: readonly TruthWord[]): { words: number; meanPt: number } => {
    const t = truth.map((w) => normalizeWord(w.text));
    const pairs = lcsMatches(
      t,
      page.words.map((w) => normalizeWord(w.text)),
    );
    const d: number[] = [];
    for (const [j, i] of pairs) {
      const w = page.words[j];
      const rect = truth[i]?.rect;
      if (!w || !rect || t[i] === '') continue;
      const cx = ((w.bbox.x0 + w.bbox.x1) / 2) * s;
      const cy = pageHeight - ((w.bbox.y0 + w.bbox.y1) / 2) * s;
      d.push(Math.hypot(cx - (rect.x + rect.width / 2), cy - (rect.y + rect.height / 2)));
    }
    return {
      words: d.length,
      meanPt: Math.round((d.reduce((x, y) => x + y, 0) / d.length) * 100) / 100,
    };
  };
  const rotateAuto = {
    appliedSkewDeg: 1.5,
    detectedRadians: auto.rotateRadians,
    detectedDeg: Math.round(((auto.rotateRadians * 180) / Math.PI) * 100) / 100,
    plain: {
      vsScanCoordinates: error(plain, fixture.truth),
      vsDeskewedCoordinates: error(plain, fixture.original),
      meanConfidence: plain.meanConfidence,
      ms: Math.round(plain.ms),
    },
    auto: {
      vsScanCoordinates: error(auto, fixture.truth),
      vsDeskewedCoordinates: error(auto, fixture.original),
      meanConfidence: auto.meanConfidence,
      ms: Math.round(auto.ms),
    },
  };
  await save('rotate-auto', rotateAuto);
  expect(Math.abs(auto.rotateRadians)).toBeGreaterThan(0.005);
});

test('time and memory: one versus two recognizers, per DPI', async () => {
  // Realistic pages only (the 100/120 dpi scans are noise-bound, see the matrix).
  const set = fixtures.filter(
    (f) => f.lang === 'eng' && /dense|scan300|scan200|scan150/.test(f.name),
  );
  const pages = [...set, ...set];
  const memory: unknown[] = [];
  const settle = () => new Promise((r) => setTimeout(r, 2000));
  // Footprint = renderer RSS with the recognizers alive (after their pages) minus RSS once
  // they are terminated: WASM memory only grows, so this is their peak heap plus code.
  for (const dpi of [200, 300, 400]) {
    const images = await Promise.all(pages.map(async (f) => (await rasterPgm(f.bytes, dpi)).image));
    const one = await createRecognizer('fast', ['eng']);
    let t0 = performance.now();
    for (const image of images) await recognize(one, image);
    const oneMs = performance.now() - t0;
    await settle();
    const aliveOne = await commands.rendererMemory();
    await one.terminate();
    await settle();
    const goneOne = await commands.rendererMemory();
    const pool = await Promise.all([
      createRecognizer('fast', ['eng']),
      createRecognizer('fast', ['eng']),
    ]);
    t0 = performance.now();
    await Promise.all(
      pool.map(async (worker, k) => {
        for (let i = k; i < images.length; i += 2) {
          const image = images[i];
          if (image) await recognize(worker, image);
        }
      }),
    );
    const twoMs = performance.now() - t0;
    await settle();
    const aliveTwo = await commands.rendererMemory();
    await Promise.all(pool.map((w) => w.terminate()));
    await settle();
    const goneTwo = await commands.rendererMemory();
    const row = {
      dpi,
      pages: images.length,
      oneRecognizer: {
        msPerPage: Math.round(oneMs / images.length),
        footprintMiB: aliveOne.rssMiB - goneOne.rssMiB,
      },
      twoRecognizers: {
        msPerPage: Math.round(twoMs / images.length),
        footprintMiB: aliveTwo.rssMiB - goneTwo.rssMiB,
      },
      rendererPeakMiB: goneTwo.peakMiB,
    };
    memory.push(row);
    await save('throughput', memory);
  }
  expect(memory.length).toBe(3);
});
