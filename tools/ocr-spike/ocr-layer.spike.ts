/**
 * SPIKE S1 (M5): not product code. Question 3 of docs/research/07-ocr-spike.md: the
 * invisible text layer of spec recognize-and-compare §1.2, prototyped in spike-lib.ts
 * (`addInvisibleLayer`, Tesseract's glyphless pdf.ttf as a Type0/CIDFontType2 font, one
 * Form XObject of render-mode-3 words, each stretched with Tz to its OCR box). Checks it
 * with the app's PDFium adapter (getPageText, search, render) and with pdf.js (text
 * extraction), in English and Turkish. Writes results/ocr-layer.json and the two layered
 * PDFs to results/ for inspection.
 *
 *   pnpm --filter @pdf-editor/ocr-spike spike ocr-layer
 */
import type { Rect } from '@pdf-editor/document-model';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfjsWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { afterAll, expect, test } from 'vitest';
import { commands } from 'vitest/browser';

import {
  addInvisibleLayer,
  createRecognizer,
  denseTextPage,
  layerWords,
  lcsMatches,
  makeScan,
  normalizeWord,
  openPdf,
  pdfium,
  pgm,
  recognize,
  renderGrey,
  SENTENCES_EN,
  SENTENCES_TR,
} from './spike-lib';

const results: Record<string, unknown> = {};
const DPI = 300;
const PAGE_HEIGHT = 841.89;

afterAll(async () => {
  await commands.writeFile('results/ocr-layer.json', `${JSON.stringify(results, null, 2)}\n`);
});

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function union(rects: readonly Rect[]): Rect {
  const x0 = Math.min(...rects.map((r) => r.x));
  const y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.width));
  const y1 = Math.max(...rects.map((r) => r.y + r.height));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return (
    Math.round((sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? NaN) * 100) /
    100
  );
}

async function pdfjsText(bytes: Uint8Array): Promise<string> {
  pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;
  const task = pdfjs.getDocument({ data: bytes.slice() });
  const doc = await task.promise;
  const page = await doc.getPage(1);
  const content = await page.getTextContent();
  let text = '';
  for (const item of content.items) {
    if ('str' in item) text += item.str + (item.hasEOL ? '\n' : '');
  }
  await task.destroy();
  return text;
}

const TURKISH = ['ç', 'ğ', 'ı', 'İ', 'ö', 'ş', 'ü', 'Ç', 'Ğ', 'Ö', 'Ş', 'Ü'];

test.each([
  ['eng', 'word', SENTENCES_EN, 'Annual report of the committee', 1],
  ['tur', 'word', SENTENCES_TR, 'Belediye meclisi toplantı notları', 2],
  ['eng', 'line', SENTENCES_EN, 'Annual report of the committee', 1],
  ['tur', 'line', SENTENCES_TR, 'Belediye meclisi toplantı notları', 2],
] as const)(
  'invisible layer on a 300 dpi scan (%s, %s mode)',
  async (lang, mode, sentences, title, seed) => {
    const page = await denseTextPage(sentences, seed, 42, title);
    const scan = await makeScan(page, {
      dpi: 300,
      skew: 1.5,
      noise: 12,
      blur: 0,
      jpegQuality: 0.85,
      seed: 100 + seed,
    });
    const sourceId = await openPdf(scan.bytes);
    const grey = await renderGrey(sourceId, 0, DPI);
    const worker = await createRecognizer('fast', [lang]);
    const ocr = await recognize(worker, pgm(grey));
    await worker.terminate();
    const kept = ocr.words.filter((w) => w.confidence >= 30);
    const ttf = new Uint8Array(await (await fetch('/ocr/pdf.ttf')).arrayBuffer());
    const layered = await addInvisibleLayer(
      scan.bytes,
      layerWords(kept, DPI, PAGE_HEIGHT),
      ttf,
      lang,
      mode,
    );
    await commands.writeFile(`results/layer-${lang}-${mode}.pdf`, toBase64(layered), 'base64');
    const id = await openPdf(layered);

    // 1. PDFium text: same words, same order.
    const runs = await pdfium().getPageText(id, 0);
    const pdfiumWords = runs.flatMap((r) => r.text.split(/\s+/)).filter((t) => t !== '');
    const ocrWords = kept.map((w) => w.text);
    const sameOrder = pdfiumWords.join(' ') === ocrWords.join(' ');

    // 2. PDFium search: every distinct word, hit rect against the OCR box (points).
    const s = 72 / DPI;
    const deviations: number[] = [];
    const heights: number[] = [];
    let searched = 0;
    let found = 0;
    const seen = new Set<string>();
    for (const w of kept) {
      const query = normalizeWord(w.text);
      if (query.length < 3 || seen.has(query)) continue;
      seen.add(query);
      searched++;
      const hits = await pdfium().search(id, query, { matchCase: true });
      const box = {
        x: w.bbox.x0 * s,
        y: PAGE_HEIGHT - w.bbox.y1 * s,
        width: (w.bbox.x1 - w.bbox.x0) * s,
        height: (w.bbox.y1 - w.bbox.y0) * s,
      };
      let best = Infinity;
      let bestRect: Rect | undefined;
      for (const hit of hits) {
        if (hit.rects.length === 0) continue;
        const r = union(hit.rects);
        const d = Math.hypot(r.x - box.x, r.y + r.height / 2 - (box.y + box.height / 2));
        if (d < best) {
          best = d;
          bestRect = r;
        }
      }
      if (!bestRect) continue;
      found++;
      // Horizontal edges only for whole-word queries (punctuation may be cut from the query).
      const horizontal =
        query === w.text
          ? Math.max(
              Math.abs(bestRect.x - box.x),
              Math.abs(bestRect.x + bestRect.width - (box.x + box.width)),
            )
          : Math.abs(bestRect.x - box.x);
      const vertical = Math.max(
        Math.max(0, bestRect.y - box.y),
        Math.max(0, box.y + box.height - (bestRect.y + bestRect.height)),
      );
      deviations.push(Math.max(horizontal, vertical));
      heights.push(bestRect.height / box.height);
    }

    // 3. Invisible: page render identical before and after, at 150 dpi.
    const before = await renderGrey(sourceId, 0, 150);
    const after = await renderGrey(id, 0, 150);
    let differing = 0;
    for (let i = 0; i < before.data.length; i++) if (before.data[i] !== after.data[i]) differing++;

    // 4. pdf.js extraction.
    const pdfjsWords = (await pdfjsText(layered)).split(/\s+/).filter((t) => t !== '');
    const pdfjsSame = pdfjsWords.join(' ') === ocrWords.join(' ');

    // 5. Turkish letters that OCR produced survive both readers.
    const ocrText = ocrWords.join(' ');
    const letters = TURKISH.filter((c) => ocrText.includes(c));
    const lettersPdfium = letters.filter((c) => pdfiumWords.join(' ').includes(c));
    const lettersPdfjs = letters.filter((c) => pdfjsWords.join(' ').includes(c));

    // 6. A few searches a Turkish user would type, case-insensitive (PDFium's folding).
    const folding: Record<string, number> = {};
    if (lang === 'tur') {
      for (const q of [
        'İstanbul',
        'istanbul',
        'ISTANBUL',
        'Işık',
        'ışık',
        'önemli',
        'ÖNEMLİ',
        'değiştirdiğini',
      ]) {
        folding[q] = (await pdfium().search(id, q)).length;
      }
    }

    // Where extraction differs from the OCR words (both directions, first 12).
    const diff = (extracted: readonly string[]) => {
      const pairs = lcsMatches(ocrWords, extracted);
      const matchedOcr = new Set(pairs.values());
      const context = extracted
        .map((_, j) => j)
        .filter((j) => !pairs.has(j))
        .slice(0, 4)
        .map((j) => extracted.slice(Math.max(0, j - 3), j + 4).join(' '));
      return {
        context,
        extractedOnly: extracted.filter((_, j) => !pairs.has(j)).slice(0, 12),
        ocrOnly: ocrWords.filter((_, i) => !matchedOcr.has(i)).slice(0, 12),
      };
    };

    await pdfium().close(id);
    await pdfium().close(sourceId);
    results[`${lang} ${mode}`] = {
      ocrWords: ocr.words.length,
      keptWords: kept.length,
      droppedBelow30: ocr.words.length - kept.length,
      layeredBytes: layered.length,
      scanBytes: scan.bytes.length,
      pdfium: {
        wordsExtracted: pdfiumWords.length,
        sameWordsSameOrder: sameOrder,
        diff: diff(pdfiumWords),
        searchedDistinct: searched,
        found,
        rectMaxEdgeDeviationPt: {
          median: percentile(deviations, 0.5),
          p95: percentile(deviations, 0.95),
          max: percentile(deviations, 1),
          within2pt: deviations.filter((d) => d <= 2).length,
        },
        hitHeightOverOcrBoxHeight: {
          median: percentile(heights, 0.5),
          p95: percentile(heights, 0.95),
        },
        turkishSearch: folding,
      },
      render150dpi: { pixels: before.data.length, differing },
      pdfjs: {
        wordsExtracted: pdfjsWords.length,
        sameWordsSameOrder: pdfjsSame,
        diff: diff(pdfjsWords),
      },
      turkishLetters: {
        inOcr: letters.join(''),
        pdfium: lettersPdfium.join(''),
        pdfjs: lettersPdfjs.join(''),
      },
    };
    expect(differing).toBe(0);
    // Word order is recorded, not asserted: PDFium reorders a few words on skewed lines.
    expect(found).toBe(searched);
    expect(lettersPdfium).toEqual(letters);
    expect(lettersPdfjs).toEqual(letters);
  },
);
