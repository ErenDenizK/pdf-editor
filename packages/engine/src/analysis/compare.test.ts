/**
 * Comparison (spec §2) on the calling thread: compare-a vs compare-b reproduces exactly the
 * seeded changes (test/fixtures manifest `expect.compare`), a document against itself and
 * against a rotated copy, alignment with shuffled and duplicated pages, and the report.
 */
import { degrees, PDFDocument } from '@cantoo/pdf-lib';
import type { Rect, SourceId } from '@pdf-editor/document-model';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import manifest from '../../../../test/fixtures/manifest.json';
import aUrl from '../../../../test/fixtures/compare-a.pdf?url';
import bUrl from '../../../../test/fixtures/compare-b.pdf?url';
import { sid, wasmUrl } from '../../test/helpers';
import { checkAnnotationConformance } from '../annotations/conformance';
import { buildComparisonReportWithCounts } from '../pdflib/compare-report';
import { PdfiumAdapter } from '../pdfium/pdfium-adapter';
import type { ComparisonResult, OpenedDocument, TextRun } from '../types';
import { alignBestMatch, alignByIndex, type AlignPage, similarityMatrix } from './align';
import { createLocalAnalysisBackend } from './backend';
import { extractCompareFacts } from './facts';
import { compareDocuments, type CompareSource, pdfiumCompareSource } from './pipeline';
import { Slicer } from './scheduler';
import { shingles, tokenizePage } from './tokens';

interface CompareExpect {
  readonly pageMap: readonly { a: number | null; b: number | null }[];
  readonly changes: readonly {
    kind: string;
    a?: unknown;
    b?: unknown;
    aPage?: number;
    bPage?: number;
    words?: number;
    heading?: string;
    key?: string;
  }[];
}
const expected = (
  manifest.fixtures.find((f) => f.file === 'compare-b.pdf')?.expect as unknown as {
    compare: CompareExpect;
  }
).compare;

const fetchBytes = async (url: string) => (await fetch(url)).arrayBuffer();
const box = (b: readonly number[]): Rect => ({ x: b[0]!, y: b[1]!, width: b[2]!, height: b[3]! });

/** Every edge within `tolerance` points. */
function near(actual: Rect, want: Rect, tolerance: number): boolean {
  return (
    Math.abs(actual.x - want.x) <= tolerance &&
    Math.abs(actual.y - want.y) <= tolerance &&
    Math.abs(actual.x + actual.width - (want.x + want.width)) <= tolerance &&
    Math.abs(actual.y + actual.height - (want.y + want.height)) <= tolerance
  );
}

function inside(inner: Rect, outer: Rect, pad: number): boolean {
  return (
    inner.x >= outer.x - pad &&
    inner.y >= outer.y - pad &&
    inner.x + inner.width <= outer.x + outer.width + pad &&
    inner.y + inner.height <= outer.y + outer.height + pad
  );
}

let adapter: PdfiumAdapter;
let counter = 0;

beforeAll(() => {
  adapter = new PdfiumAdapter({ wasmUrl });
});
afterAll(async () => {
  await adapter.destroy();
});

async function openSource(
  bytes: ArrayBuffer,
  name: string,
  facts: 'engine' | 'bytes' = 'bytes',
): Promise<{ id: SourceId; opened: OpenedDocument; source: CompareSource }> {
  const id = sid(`cmp-${++counter}`);
  const opened = await adapter.open(id, bytes.slice(0));
  const source = pdfiumCompareSource(adapter, id, opened, {
    name,
    ...(facts === 'bytes' ? { facts: () => extractCompareFacts(bytes.slice(0)) } : {}),
  });
  return { id, opened, source };
}

async function compare(
  a: ArrayBuffer,
  b: ArrayBuffer,
  facts: 'engine' | 'bytes' = 'bytes',
): Promise<ComparisonResult> {
  const sa = await openSource(a, 'a.pdf', facts);
  const sb = await openSource(b, 'b.pdf', facts);
  try {
    const run = await compareDocuments(createLocalAnalysisBackend(), sa.source, sb.source);
    await run.release();
    return run.result;
  } finally {
    await adapter.close(sa.id);
    await adapter.close(sb.id);
  }
}

describe('compare-a.pdf vs compare-b.pdf', () => {
  let result: ComparisonResult;

  beforeAll(async () => {
    result = await compare(await fetchBytes(aUrl), await fetchBytes(bUrl));
  });

  test('page map 1:1, 2:2, 3:–, 4:3, –:4 with confidence', () => {
    expect(result.settings.alignment).toBe('best-match');
    expect(
      result.pages.map((p) => ({
        a: (p.pair.a ?? -1) + 1 || null,
        b: (p.pair.b ?? -1) + 1 || null,
      })),
    ).toEqual(expected.pageMap);
    const [p1, p2, p3, p4, p5] = result.pages;
    expect(p1!.pair.similarity).toBeGreaterThan(0.7);
    expect(p1!.pair.similarity).toBeLessThan(1);
    expect(p2!.pair.similarity).toBe(1);
    expect(p4!.pair.similarity).toBe(1);
    expect(p3!.pair.similarity).toBeLessThan(0.15);
    expect(p5!.pair.similarity).toBeLessThan(0.15);
    expect(result.pages.map((p) => p.status)).toEqual([
      'changed',
      'changed',
      'deleted',
      'identical',
      'inserted',
    ]);
  });

  test('the text diff reports only Monday -> Tuesday, with its boxes', () => {
    const seeded = expected.changes.find((c) => c.kind === 'text-changed') as {
      a: { text: string; box: number[] };
      b: { text: string; box: number[] };
    };
    expect(result.text.scope).toBe('document');
    expect(result.text.changes).toHaveLength(1);
    const change = result.text.changes[0]!;
    expect(change.kind).toBe('changed');
    expect(change.a).toMatchObject({ page: 0, text: seeded.a.text });
    expect(change.b).toMatchObject({ page: 0, text: seeded.b.text });
    expect(change.a!.line).toBe(
      'The committee approved the budget on Monday after a short debate.',
    );
    expect(change.a!.rects).toHaveLength(1);
    expect(change.b!.rects).toHaveLength(1);
    // PDFium's char boxes are whole points and include the line's ascent: within 3 pt.
    expect(near(change.a!.rects[0]!, box(seeded.a.box), 3)).toBe(true);
    expect(near(change.b!.rects[0]!, box(seeded.b.box), 3)).toBe(true);
    expect(result.counts).toMatchObject({ textChanged: 1, textAdded: 0, textRemoved: 0 });
  });

  test('deleted and inserted pages carry their heading and word count', () => {
    const deleted = expected.changes.find((c) => c.kind === 'page-deleted')!;
    const inserted = expected.changes.find((c) => c.kind === 'page-inserted')!;
    expect(result.pages[2]).toMatchObject({
      status: 'deleted',
      words: deleted.words,
      firstLine: deleted.heading,
    });
    expect(result.pages[4]).toMatchObject({
      status: 'inserted',
      words: inserted.words,
      firstLine: inserted.heading,
    });
  });

  test('the pixel diff finds the changed word and the moved image; identical pages have none', () => {
    const [p1, p2, , p4] = result.pages;
    // Page 1: from the changed word to the end of its line ("Tuesday" is 3.3 pt wider than
    // "Monday", so the rest of the line moves).
    const line = box([284.78, 687.52, 442 - 284.78, 11.1]);
    expect(p1!.visual!.changedPixels).toBeGreaterThan(0);
    for (const r of p1!.visual!.regions) expect(inside(r, line, 8)).toBe(true);
    expect(Math.min(...p1!.visual!.regions.map((r) => r.x))).toBeGreaterThan(284.78 - 8);
    // Page 2: the image moved 20 pt right: changes within the union of both placements.
    const moved = expected.changes.find((c) => c.kind === 'image-moved') as unknown as {
      a: number[];
      b: number[];
    };
    const union = {
      x: moved.a[0]!,
      y: moved.a[1]!,
      width: moved.b[0]! + moved.b[2]! - moved.a[0]!,
      height: moved.a[3]!,
    };
    const regions = p2!.visual!.regions;
    expect(regions.length).toBeGreaterThan(0);
    for (const r of regions) expect(inside(r, union, 8)).toBe(true);
    const x0 = Math.min(...regions.map((r) => r.x));
    const x1 = Math.max(...regions.map((r) => r.x + r.width));
    expect(Math.abs(x0 - union.x)).toBeLessThanOrEqual(8);
    expect(Math.abs(x1 - (union.x + union.width))).toBeLessThanOrEqual(8);
    expect(p2!.visual!.sizeMismatch).toBe(false);
    expect(p2!.textChanges).toBe(0);
    // Pages a4 and b3 are identical.
    expect(p4!.visual).toMatchObject({
      changedPixels: 0,
      changedRatio: 0,
      regions: [],
      sizeMismatch: false,
    });
    expect(p4!.visual!.heatmapId).toBeUndefined();
    expect(p4!.textChanges).toBe(0);
  });

  test('the facts list only the title change', () => {
    expect(result.facts).toEqual([
      { kind: 'metadata', key: 'Title', a: 'Quarterly report', b: 'Quarterly report (revised)' },
    ]);
  });

  test('the result is JSON-serialisable as is', () => {
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  test('the report: summary page first, annotations on the second document, conformant', async () => {
    const b = await fetchBytes(bUrl);
    const { bytes, counts } = await buildComparisonReportWithCounts(b, result, {
      now: new Date('2026-09-28T12:00:00Z'),
    });
    expect(counts.summaryPages).toBe(1);
    const squares = result.pages.reduce((n, p) => n + (p.visual?.regions.length ?? 0), 0) + 1; // + inserted page
    expect(counts).toMatchObject({ square: squares, highlight: 1, note: 1, omitted: 0 });
    const conformance = await checkAnnotationConformance(bytes);
    expect(conformance.problems).toEqual([]);
    expect(conformance.ok).toBe(true);
    // PDFium opens it and lists the same annotations per page.
    const id = sid('report');
    const opened = await adapter.open(id, bytes.slice().buffer);
    expect(opened.pageCount).toBe(5);
    const perPage: string[][] = [];
    for (let i = 0; i < opened.pageCount; i++) {
      perPage.push((await adapter.listAnnotations(id, i)).map((a) => a.kind));
    }
    await adapter.close(id);
    const p1Squares = result.pages[0]!.visual!.regions.length;
    const p2Squares = result.pages[1]!.visual!.regions.length;
    expect(perPage).toEqual([
      [],
      [...Array<string>(p1Squares).fill('square'), 'highlight'],
      Array<string>(p2Squares).fill('square'),
      ['text'],
      ['square'],
    ]);
    const highlight = (
      await (async () => {
        const again = await adapter.open(sid('report-2'), bytes.slice().buffer);
        const list = await adapter.listAnnotations(sid('report-2'), 1);
        await adapter.close(again.id);
        return list;
      })()
    ).find((a) => a.kind === 'highlight');
    expect(highlight?.contents).toContain('Changed: "Monday" → "Tuesday"');
    // The summary page says what a pixel diff can and cannot tell.
    const summary = await (async () => {
      const again = await adapter.open(sid('report-3'), bytes.slice().buffer);
      const runs: readonly TextRun[] = await adapter.getPageText(again.id, 0);
      await adapter.close(again.id);
      return runs.map((r) => r.text).join('\n');
    })();
    expect(summary).toContain('Comparison report');
    expect(summary).toContain('cannot tell intent');
    expect(summary).toContain('Quarterly report (revised)');
  });
});

describe('a document against itself and a rotated copy', () => {
  test('self-compare reports no change of any kind', async () => {
    const a = await fetchBytes(aUrl);
    const result = await compare(a, a);
    expect(result.settings.alignment).toBe('index');
    expect(
      result.pages.every((p) => p.status === 'identical' && p.visual?.changedPixels === 0),
    ).toBe(true);
    expect(result.text.changes).toEqual([]);
    expect(result.facts).toEqual([]);
    expect(result.counts).toMatchObject({
      identical: 4,
      changed: 0,
      inserted: 0,
      deleted: 0,
      visualRegions: 0,
    });
  });

  test('engine facts (no pdf-lib pass) agree on compare-a/b', async () => {
    const result = await compare(await fetchBytes(aUrl), await fetchBytes(bUrl), 'engine');
    expect(result.facts).toEqual([
      { kind: 'metadata', key: 'Title', a: 'Quarterly report', b: 'Quarterly report (revised)' },
    ]);
  });

  test('a rotated copy: same text, every page visually different and rotated in the facts', async () => {
    const a = await fetchBytes(aUrl);
    const doc = await PDFDocument.load(a, { updateMetadata: false });
    for (const page of doc.getPages()) page.setRotation(degrees(90));
    const rotated = (await doc.save()).slice().buffer;
    const result = await compare(a, rotated);
    expect(result.settings.alignment).toBe('index');
    expect(result.pages.map((p) => [p.pair.a, p.pair.b])).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
    expect(result.text.changes).toEqual([]);
    for (const p of result.pages) {
      expect(p.status).toBe('changed');
      expect(p.geometryChanged).toBe(true);
      expect(p.visual!.sizeMismatch).toBe(true);
      expect(p.visual!.changedRatio).toBeGreaterThan(0.2);
      // Regions are reported in each page's own user space, inside the page.
      for (const r of p.visual!.regions)
        expect(inside(r, { x: 0, y: 0, width: 612, height: 792 }, 0.01)).toBe(true);
    }
    expect(result.facts).toEqual(
      [0, 1, 2, 3].map((i) => ({
        kind: 'page-rotation',
        key: 'rotation',
        a: '0°',
        b: '90°',
        aPage: i,
        bPage: i,
      })),
    );
  });
});

describe('alignment', () => {
  const words = (seed: number) =>
    Array.from({ length: 30 }, (_, i) => `w${seed}x${(i * 7 + seed) % 31}y${i}`).join(' ');
  const pageOf = (text: string): AlignPage => {
    const tokens = tokenizePage(
      text === '' ? [] : [{ text, rect: { x: 0, y: 0, width: 1, height: 1 }, glyphs: [] }],
    );
    return { shingles: shingles(tokens.tokens), words: tokens.tokens.filter((t) => t.word).length };
  };
  const pages = (seeds: readonly number[]) => seeds.map((s) => pageOf(words(s)));
  const map = (pairs: readonly { a?: number; b?: number }[]) =>
    pairs.map((p) => `${p.a ?? '-'}:${p.b ?? '-'}`);

  async function best(a: AlignPage[], b: AlignPage[]) {
    const slicer = new Slicer('test');
    return alignBestMatch(await similarityMatrix(a, b, slicer), 0.15, slicer);
  }

  test('a duplicated page is an inserted page', async () => {
    expect(map(await best(pages([1, 2, 3]), pages([1, 2, 2, 3])))).toEqual([
      '0:0',
      '1:1',
      '-:2',
      '2:3',
    ]);
  });

  test('swapped pages: order is kept, one of them pairs, the other is deleted and inserted', async () => {
    const result = map(await best(pages([1, 2, 3, 4]), pages([1, 3, 2, 4])));
    expect(result[0]).toBe('0:0');
    expect(result[result.length - 1]).toBe('3:3');
    expect(result.filter((r) => r.includes('-'))).toHaveLength(2);
    expect(result).toHaveLength(5);
  });

  test('pages without text are matched by thumbnail', async () => {
    const thumb = (v: number) => new Uint8Array(1024).fill(v);
    const a: AlignPage[] = [
      { ...pageOf(''), thumb: thumb(250) },
      { ...pageOf(''), thumb: thumb(20) },
    ];
    const b: AlignPage[] = [{ ...pageOf(''), thumb: thumb(22) }];
    const pairs = await best(a, b);
    expect(map(pairs)).toEqual(['0:-', '1:0']);
    expect(pairs[1]).toMatchObject({ basis: 'thumbnail' });
    expect(pairs[1]!.similarity).toBeGreaterThan(0.9);
  });

  test('by index pairs positions and reports the extra pages', async () => {
    const slicer = new Slicer('test');
    const pairs = alignByIndex(await similarityMatrix(pages([1, 2]), pages([1, 5, 6]), slicer));
    expect(map(pairs)).toEqual(['0:0', '1:1', '-:2']);
    expect(pairs[0]!.similarity).toBe(1);
    expect(pairs[1]!.similarity).toBe(0);
  });
});
