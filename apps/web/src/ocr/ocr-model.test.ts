/**
 * The pure OCR helpers (spec recognize-and-compare §1.2, §1.3, §1.5): page scope, the
 * replace option, default languages and their names, pack sizes, and the results read back
 * from `ocr.apply` edits (rows, rects, quality order, export summary), without the words a
 * later redaction removed.
 */
import type {
  EngineEdit,
  PageId,
  SourceId,
  VirtualDocument,
  VirtualPage,
} from '@pdf-editor/document-model';
import { OCR_LOW_CONFIDENCE, OCR_QUALITY_THRESHOLDS, type OcrPageFacts } from '@pdf-editor/engine';
import { describe, expect, it } from 'vitest';

import {
  countByQuality,
  defaultLanguages,
  defaultReplace,
  defaultScope,
  documentHasOcr,
  documentQualityRows,
  documentTargets,
  type FactsBySource,
  formatMegabytes,
  invisibleTextOf,
  languageList,
  languageName,
  languagesKey,
  lowConfidenceRows,
  ocrExportSummaryOf,
  ocrRecords,
  recordKey,
  replaceModeFor,
  scopeTargets,
  stepRow,
  storedWordRect,
  tagOfCode,
  thresholdsOf,
} from './ocr-model';

/** The engine's thresholds (types.ts): Good ≥ 90, Review 80–90, low confidence < 90. */
const T = thresholdsOf({ OCR_LOW_CONFIDENCE, OCR_QUALITY_THRESHOLDS });

const A = 'src-a' as SourceId;
const B = 'src-b' as SourceId;

function page(id: string, ref: VirtualPage['ref'], rotation: VirtualPage['rotation'] = 0) {
  return { id: id as PageId, ref, rotation, overlays: [] } as VirtualPage;
}

function documentOf(pages: VirtualPage[]): VirtualDocument {
  return { id: 'doc', title: 'doc', pages } as unknown as VirtualDocument;
}

const doc = documentOf([
  page('p1', { kind: 'source', source: A, index: 0 }),
  page('p2', { kind: 'source', source: A, index: 1 }, 90),
  page('p3', { kind: 'blank', size: { width: 612, height: 792 } }),
  page('p4', { kind: 'source', source: B, index: 0 }),
  // The same source page again: one layer, one target.
  page('p5', { kind: 'source', source: A, index: 0 }),
]);

function facts(
  pageIndex: number,
  visibleText: boolean,
  invisibleText: OcrPageFacts['invisibleText'] = 'none',
): OcrPageFacts {
  return {
    pageIndex,
    visibleText,
    invisibleText,
    ourLayer: invisibleText === 'ours',
    images: visibleText ? 0 : 1,
    imageOnly: !visibleText,
  };
}

const FACTS: FactsBySource = new Map([
  [A, [facts(0, false), facts(1, true)]],
  [B, [facts(0, false, 'foreign')]],
]);

describe('pages', () => {
  it('lists source pages once, in document order, without blank or image pages', () => {
    const targets = documentTargets(doc);
    expect(targets.map((t) => [t.pageId, t.source, t.index, t.docIndex, t.rotation])).toEqual([
      ['p1', A, 0, 0, 0],
      ['p2', A, 1, 1, 90],
      ['p4', B, 0, 3, 0],
    ]);
  });

  it('defaults to the pages without visible text, else to all pages', () => {
    const targets = documentTargets(doc);
    expect(defaultScope(targets, FACTS)).toBe('without-text');
    const withText: FactsBySource = new Map([
      [A, [facts(0, true), facts(1, true)]],
      [B, [facts(0, true)]],
    ]);
    expect(defaultScope(targets, withText)).toBe('all');
    // Facts not read yet: nothing is known to lack text.
    expect(defaultScope(targets, new Map())).toBe('all');
  });

  it('maps each scope to its pages', () => {
    const targets = documentTargets(doc);
    const ids = (scope: Parameters<typeof scopeTargets>[1], range: number[] | null = [], at = 0) =>
      scopeTargets(targets, scope, { facts: FACTS, currentPage: at, range })?.map((t) => t.pageId);
    expect(ids('without-text')).toEqual(['p1', 'p4']);
    expect(ids('all')).toEqual(['p1', 'p2', 'p4']);
    expect(ids('current', [], 1)).toEqual(['p2']);
    // The current page is a blank page: nothing to recognise.
    expect(ids('current', [], 2)).toEqual([]);
    expect(ids('range', [1, 2, 3])).toEqual(['p2', 'p4']);
    expect(ids('range', null)).toBeUndefined();
  });

  it('describes existing invisible text and picks the replace mode', () => {
    const targets = documentTargets(doc);
    const ours: FactsBySource = new Map([[A, [facts(0, false, 'ours'), facts(1, true)]]]);
    const onA = targets.filter((t) => t.source === A);
    const onB = targets.filter((t) => t.source === B);
    expect(invisibleTextOf(targets, FACTS)).toEqual({ ours: 0, foreign: 1 });
    expect(invisibleTextOf(onA, ours)).toEqual({ ours: 1, foreign: 0 });
    // A re-run over this app's layer starts ticked; another tool's text is kept by default.
    expect(defaultReplace({ ours: 1, foreign: 0 })).toBe(true);
    expect(defaultReplace({ ours: 1, foreign: 1 })).toBe(false);
    expect(defaultReplace({ ours: 0, foreign: 0 })).toBe(false);
    expect(replaceModeFor(false, onB, FACTS)).toBe('none');
    expect(replaceModeFor(true, onB, FACTS)).toBe('all-invisible');
    expect(replaceModeFor(true, onA, ours)).toBe('ours');
  });
});

describe('languages', () => {
  it('defaults to the UI language, then English, of those available', () => {
    const all = ['eng', 'tur', 'deu', 'fra'];
    expect(defaultLanguages('tr', all)).toEqual(['tur', 'eng']);
    expect(defaultLanguages('tr-TR', all)).toEqual(['tur', 'eng']);
    expect(defaultLanguages('en', all)).toEqual(['eng']);
    expect(defaultLanguages('de-AT', all)).toEqual(['deu', 'eng']);
    // No pack for the UI language: English alone.
    expect(defaultLanguages('ja', all)).toEqual(['eng']);
    expect(defaultLanguages('tr', ['tur'])).toEqual(['tur']);
    expect(defaultLanguages('ja', ['deu'])).toEqual(['deu']);
    expect(defaultLanguages('en', [])).toEqual([]);
  });

  it('names languages in the UI language, codes when unknown', () => {
    expect(tagOfCode('tur')).toBe('tr');
    expect(tagOfCode('chi_sim')).toBe('zh-Hans');
    expect(tagOfCode('xyz_abc')).toBe('xyz');
    expect(languageName('tur', 'en')).toBe('Turkish');
    expect(languageName('eng', 'tr')).toBe('İngilizce');
    expect(languageName('tur', 'tr')).toBe('Türkçe');
    expect(languageName('qqq', 'en')).toBe('qqq');
    expect(languageList(['tur', 'eng'], 'en')).toBe('Turkish and English');
    expect(languageList(['tur', 'eng', 'deu'], 'en')).toBe('Turkish, English, and German');
    expect(languageList(['tur', 'eng'], 'tr')).toBe('Türkçe ve İngilizce');
    expect(languageList(['eng'], 'en')).toBe('English');
    expect(languagesKey(['tur', 'eng'])).toBe('tur+eng');
  });

  it('formats pack sizes in decimal megabytes with one decimal', () => {
    expect(formatMegabytes(1_980_000, 'en')).toBe('2.0 MB');
    expect(formatMegabytes(4_110_000, 'en')).toBe('4.1 MB');
    expect(formatMegabytes(2_020_000, 'tr')).toMatch(/^2,0\sMB$/);
    // Never "0.0 MB" for a small file.
    expect(formatMegabytes(12_000, 'en')).toBe('0.1 MB');
  });
});

type Word = readonly [string, number, number, number, number, number, number];

function ocrEdit(
  id: string,
  source: SourceId,
  pages: {
    pageIndex: number;
    words: Word[];
    quality?: string;
    meanConfidence?: number;
    languages?: string[];
    dpi?: number;
  }[],
): EngineEdit {
  return {
    id,
    source,
    pageIndex: pages[0]?.pageIndex ?? 0,
    kind: 'ocr.apply',
    payload: {
      version: 1,
      replace: 'none',
      pages: pages.map((p) => ({ languages: ['eng'], ...p })),
    },
  };
}

describe('results in the model', () => {
  const first = ocrEdit('e1', A, [
    {
      pageIndex: 0,
      words: [
        ['Scanned', 72, 700, 60, 14, 0, 96],
        ['Documnet', 140, 700, 70, 14, 0, 62],
      ],
      quality: 'review',
      meanConfidence: 84,
      dpi: 300,
    },
    { pageIndex: 1, words: [], quality: 'no-text', meanConfidence: 0 },
  ]);
  const rerun = ocrEdit('e2', A, [
    {
      pageIndex: 0,
      words: [
        ['Scanned', 72, 700, 60, 14, 0, 97],
        ['Document', 140, 700, 70, 14, 0, 95],
      ],
      languages: ['tur', 'eng'],
    },
  ]);
  const other = ocrEdit('e3', B, [
    { pageIndex: 0, words: [['Poorly', 10, 10, 30, 10, 0, 40]], quality: 'poor' },
  ]);
  const annotation: EngineEdit = {
    id: 'x',
    source: A,
    pageIndex: 0,
    kind: 'annotation.create',
    payload: {},
  };

  it('reads the latest edit of every page', () => {
    const records = ocrRecords([first, annotation, rerun, other], T);
    expect(records.size).toBe(3);
    const a0 = records.get(recordKey(A, 0));
    expect(a0?.editId).toBe('e2');
    expect(a0?.languages).toEqual(['tur', 'eng']);
    // Without a recorded quality it follows from the mean confidence (96 → good).
    expect(a0?.quality).toBe('good');
    expect(a0?.meanConfidence).toBe(96);
    expect(records.get(recordKey(A, 1))?.quality).toBe('no-text');
    expect(records.get(recordKey(B, 0))?.quality).toBe('poor');
    expect(ocrRecords([first], T).get(recordKey(A, 0))?.dpi).toBe(300);
  });

  it('ignores malformed payloads', () => {
    const broken: EngineEdit = { ...first, id: 'b', payload: { pages: [{ pageIndex: 'x' }] } };
    expect(ocrRecords([broken, { ...first, id: 'n', payload: null }], T).size).toBe(0);
  });

  it('lists low-confidence words with their boxes', () => {
    const record = ocrRecords([first], T).get(recordKey(A, 0));
    if (!record) throw new Error('no record');
    const rows = lowConfidenceRows(record, T);
    expect(rows).toEqual([
      {
        index: 1,
        text: 'Documnet',
        confidence: 62,
        rect: { x: 140, y: 700, width: 70, height: 14 },
      },
    ]);
  });

  it('turns a word box with its baseline angle', () => {
    const upright = storedWordRect(['w', 100, 200, 50, 10, 90, 99]);
    expect(upright.x).toBeCloseTo(90);
    expect(upright.y).toBeCloseTo(200);
    expect(upright.width).toBeCloseTo(10);
    expect(upright.height).toBeCloseTo(50);
  });

  it('orders the document list worst first and summarises the export', () => {
    const edits = [first, other];
    const rows = documentQualityRows(doc, ocrRecords(edits, T));
    expect(rows.map((r) => [r.pageId, r.record.quality])).toEqual([
      ['p4', 'poor'],
      ['p2', 'no-text'],
      ['p1', 'review'],
    ]);
    expect(countByQuality(rows)).toEqual({ good: 0, review: 1, poor: 1, 'no-text': 1 });
    expect(documentHasOcr(edits, doc)).toBe(true);
    expect(documentHasOcr([annotation], doc)).toBe(false);
    // Page 2 (A:1) found no text: it adds none, so it is not counted.
    expect(ocrExportSummaryOf(doc, [first, rerun, other], T)).toEqual({
      pages: 2,
      languages: ['tur', 'eng'],
    });
    expect(ocrExportSummaryOf(doc, [annotation], T)).toBeUndefined();
  });

  function redaction(
    id: string,
    source: SourceId,
    areas: { pageIndex: number; rect: { x: number; y: number; width: number; height: number } }[],
    strings: string[] = [],
  ): EngineEdit {
    return {
      id,
      source,
      pageIndex: areas[0]?.pageIndex ?? 0,
      kind: 'redaction.apply',
      payload: { plan: { areas, strings } },
    };
  }

  it('hides the words a later redaction removed, keeping the stored indices', () => {
    // An area over "Documnet" (x 140–210 on page 1) only.
    const over = redaction('r1', A, [
      { pageIndex: 0, rect: { x: 135, y: 690, width: 85, height: 30 } },
    ]);
    const record = ocrRecords([first, over], T).get(recordKey(A, 0));
    expect(record?.words.map((w) => w[0])).toEqual(['Scanned']);
    expect(record?.storedIndex).toEqual([0]);
    expect(record?.meanConfidence).toBe(96);
    expect(record?.quality).toBe('good');
    expect(record && lowConfidenceRows(record, T)).toEqual([]);
    // The payload is untouched (undo and replay read it).
    expect((first.payload as { pages: { words: unknown[] }[] }).pages[0]?.words).toHaveLength(2);
    // Touching an edge, another page or another source: nothing goes.
    const edge = redaction('r2', A, [
      { pageIndex: 0, rect: { x: 210, y: 700, width: 20, height: 14 } },
    ]);
    const page2 = redaction('r3', A, [
      { pageIndex: 1, rect: { x: 0, y: 0, width: 612, height: 792 } },
    ]);
    const onB = redaction('r4', B, [
      { pageIndex: 0, rect: { x: 0, y: 0, width: 612, height: 792 } },
    ]);
    expect(ocrRecords([first, edge, page2, onB], T).get(recordKey(A, 0))?.words).toHaveLength(2);
    // A redaction before the run does not touch the run's words.
    expect(ocrRecords([over, first], T).get(recordKey(A, 0))?.words).toHaveLength(2);
  });

  it('hides every word a redacted string covers, across words, case and spaces', () => {
    const run = ocrEdit('e9', A, [
      {
        pageIndex: 0,
        words: [
          ['Account', 72, 700, 60, 14, 0, 95],
          ['TOP', 140, 700, 30, 14, 0, 60],
          ['secret', 175, 700, 50, 14, 0, 70],
          ['report', 230, 700, 50, 14, 0, 50],
        ],
      },
      { pageIndex: 1, words: [['Top-Secret', 72, 700, 80, 14, 0, 97]] },
    ]);
    // Area-less plans are not valid redactions, but strings apply to every page of the source.
    const scrub = redaction(
      'r5',
      A,
      [{ pageIndex: 3, rect: { x: 0, y: 0, width: 1, height: 1 } }],
      ['top secret'],
    );
    const records = ocrRecords([run, scrub], T);
    const page1 = records.get(recordKey(A, 0));
    expect(page1?.words.map((w) => w[0])).toEqual(['Account', 'report']);
    expect(page1 && lowConfidenceRows(page1, T).map((r) => [r.index, r.text])).toEqual([
      [3, 'report'],
    ]);
    // "Top-Secret" does not match "topsecret" (the hyphen stays), as the engine matches.
    expect(records.get(recordKey(A, 1))?.words).toHaveLength(1);
  });

  it('drops a page whose words were all redacted from the export summary', () => {
    const all = redaction('r6', B, [
      { pageIndex: 0, rect: { x: 0, y: 0, width: 612, height: 792 } },
    ]);
    const records = ocrRecords([first, other, all], T);
    expect(records.get(recordKey(B, 0))?.quality).toBe('no-text');
    expect(ocrExportSummaryOf(doc, [first, other, all], T)).toEqual({
      pages: 1,
      languages: ['eng'],
    });
    expect(ocrExportSummaryOf(doc, [other, all], T)).toBeUndefined();
  });

  it('steps through rows with J and K, wrapping', () => {
    expect(stepRow(3, -1, 1)).toBe(0);
    expect(stepRow(3, -1, -1)).toBe(2);
    expect(stepRow(3, 2, 1)).toBe(0);
    expect(stepRow(3, 0, -1)).toBe(2);
    expect(stepRow(0, -1, 1)).toBe(-1);
  });
});
