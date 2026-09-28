/**
 * `VerificationExpectation.ocrWords` (spec recognize-and-compare §1.3): an OCR layer written
 * through the PDFium worker (`applyOcrLayer`, from a fixed plan: no recognition) must yield
 * its words through the export verifier, with the layer verifier's rule (`locateWords`,
 * every word found, boxes within `OCR_RECT_TOLERANCE`). The same expectation fails on the
 * unlayered scan, and on boxes that moved; the layer survives the assembler's page copy,
 * reordering, duplication, rotation, crop and encryption with its user space unchanged.
 */
import type { SecurityPolicy } from '@pdf-editor/document-model';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { writableWord } from '../src/ocr/layer';
import { createProxy, fixtureBytes, sid } from '../src/ocr/test-helpers';
import { layerWordRect } from '../src/ocr/verify';
import { PdfLibAssembler } from '../src/pdflib/pdflib-assembler';
import type {
  OcrLayerPage,
  OcrLayerPlan,
  OcrLayerWord,
  OcrWordsExpectation,
  VerificationExpectation,
} from '../src/types';
import type { PdfiumProxy } from '../src/worker/pdfium-proxy';
import { vdoc, vpage } from './helpers';

const LETTER = { width: 612, height: 792 };
const SOURCE = sid('ocr-verify-source');

/** A line of words from `x` on the descender line `y`, 20 pt apart plus their widths. */
function line(texts: readonly string[], x: number, y: number, angle = 0): OcrLayerWord[] {
  let at = x;
  return texts.map((text) => {
    const width = 9 * text.length;
    const rad = (angle * Math.PI) / 180;
    const word = {
      text,
      origin: { x: at, y: y + (at - x) * Math.tan(rad) },
      width,
      fontSize: 16,
      angle,
      confidence: 95,
    };
    at += width + 6;
    return word;
  });
}

const PAGES: readonly OcrLayerPage[] = [
  {
    pageIndex: 0,
    languages: ['eng'],
    words: [
      ...line(['Scanned', 'Document', 'Test'], 72, 700),
      ...line(['quick', 'brown', 'fox', 'jumps'], 72, 640),
    ],
  },
  {
    pageIndex: 1,
    languages: ['eng'],
    words: [
      ...line(['Skewed', 'second', 'page'], 90, 600, 1.5),
      ...line(['Numbers', '2024', '7731'], 90, 560, 1.5),
    ],
  },
];
const PLAN: OcrLayerPlan = { pages: PAGES, replace: 'none', lang: 'en' };

/** The words of source page `index` as the export expects them on an output page. */
function expected(pageIndex: number, index: number): OcrWordsExpectation {
  const words = PAGES[index]?.words.filter(writableWord) ?? [];
  return { pageIndex, words: words.map((w) => ({ text: w.text, rect: layerWordRect(w) })) };
}

const expectation = (ocrWords: readonly OcrWordsExpectation[]): VerificationExpectation => ({
  pageCount: 2,
  pageSizes: [LETTER, LETTER],
  ocrWords,
});

let engine: PdfiumProxy;
let scan: ArrayBuffer;
let layered: ArrayBuffer;

beforeAll(async () => {
  engine = createProxy('pdfium ocr verification test');
  scan = await fixtureBytes('scan-text.pdf');
  await engine.open(SOURCE, scan.slice(0));
  const applied = await engine.applyOcrLayer(SOURCE, PLAN);
  expect(applied.verification.ok).toBe(true);
  expect(applied.verification.problems).toEqual([]);
  layered = applied.bytes.slice(0);
  await engine.close(SOURCE);
});

afterAll(async () => {
  await engine.destroy();
});

describe('VerificationExpectation.ocrWords', () => {
  test('passes on the layered bytes', async () => {
    const result = await engine.verify(
      layered.slice(0),
      expectation([expected(0, 0), expected(1, 1)]),
    );
    expect(result).toEqual({ ok: true, problems: [] });
  });

  test('fails on the unlayered scan, naming the page and the count', async () => {
    const result = await engine.verify(
      scan.slice(0),
      expectation([expected(0, 0), expected(1, 1)]),
    );
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      'Page 1: 7 of 7 OCR words not found in the text (Scanned, Document, Test, quick, brown)',
      'Page 2: 6 of 6 OCR words not found in the text (Skewed, second, page, Numbers, 2024)',
    ]);
  });

  test('fails when the words are elsewhere on the page, and passes by text without boxes', async () => {
    const page = expected(0, 0);
    const moved: OcrWordsExpectation = {
      pageIndex: 0,
      words: page.words.map((w, i) =>
        i < 2 && w.rect ? { ...w, rect: { ...w.rect, x: w.rect.x + 5 } } : w,
      ),
    };
    const result = await engine.verify(layered.slice(0), expectation([moved]));
    expect(result.ok).toBe(false);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatch(
      /^Page 1: 2 of 7 OCR words more than 2 pt from their place \(worst 5\.\d\d pt\)$/,
    );

    const textOnly: OcrWordsExpectation = {
      pageIndex: 0,
      words: moved.words.map(({ text }) => ({ text })),
    };
    expect(await engine.verify(layered.slice(0), expectation([textOnly]))).toEqual({
      ok: true,
      problems: [],
    });
  });

  test('a word the page does not carry fails the page it is expected on', async () => {
    const page = expected(1, 1);
    const extra: OcrWordsExpectation = {
      ...page,
      words: [...page.words, { text: 'Zebra', rect: { x: 90, y: 400, width: 45, height: 16 } }],
    };
    const result = await engine.verify(layered.slice(0), expectation([expected(0, 0), extra]));
    expect(result.problems).toEqual(['Page 2: 1 of 7 OCR words not found in the text (Zebra)']);
  });

  test('survives reordering, duplication, rotation, crop and encryption', async () => {
    const assembler = new PdfLibAssembler();
    const security: SecurityPolicy = {
      algorithm: 'aes-256',
      userPassword: 'user-pw',
      permissions: {
        print: true,
        printHighQuality: true,
        modify: false,
        copy: true,
        annotate: true,
        fillForms: true,
        accessibility: true,
        assemble: false,
      },
    };
    const crop = { x: 36, y: 300, width: 540, height: 460 };
    const { bytes } = await assembler.assemble(
      {
        document: vdoc([
          vpage({ kind: 'source', source: SOURCE, index: 1 }, { rotation: 90 }),
          vpage({ kind: 'source', source: SOURCE, index: 0 }),
          vpage({ kind: 'source', source: SOURCE, index: 0 }, { cropBox: crop }),
        ]),
        sources: new Map([[SOURCE, layered.slice(0)]]),
        blobs: new Map(),
      },
      { security },
    );
    const result = await engine.verify(bytes.slice(0), {
      pageCount: 3,
      pageSizes: [LETTER, LETTER, { width: crop.width, height: crop.height }],
      rotations: [90, 0, 0],
      password: 'user-pw',
      ocrWords: [expected(0, 1), expected(1, 0), expected(2, 0)],
    });
    expect(result).toEqual({ ok: true, problems: [] });
  });
});
