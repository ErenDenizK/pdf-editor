/**
 * The Changes list mapping (compare/changes.ts): rows by page map, where each change is
 * revealed, J/K order, the partial list while the run is in progress, and the text export.
 */
import type { ComparisonResult, PagePair, PixelDiffResult } from '@pdf-editor/engine';
import { describe, expect, it } from 'vitest';

import { changeLabel, honestyLines, sharePercent } from './change-labels';
import {
  buildChangeList,
  buildPartialChangeList,
  rowIndex,
  rowStatus,
  stepChange,
  unionRect,
} from './changes';
import { changesMarkdown } from './changes-text';

const pairs: PagePair[] = [
  { a: 0, b: 0, similarity: 0.9, basis: 'text' },
  { a: 1, b: 1, similarity: 1, basis: 'text' },
  { a: 2, similarity: 0.1, basis: 'none' },
  { a: 3, b: 2, similarity: 1, basis: 'text' },
  { b: 3, similarity: 0.05, basis: 'none' },
];

function visual(regions: PixelDiffResult['regions'], changedPixels = 100): PixelDiffResult {
  return {
    dpi: 100,
    width: 850,
    height: 1100,
    changedPixels,
    changedRatio: changedPixels / (850 * 1100),
    regions,
    regionsA: regions,
    sizeMismatch: false,
    ...(changedPixels > 0 ? { heatmapId: `h${regions.length}` } : {}),
  };
}

const moved = [
  { x: 72, y: 480, width: 20, height: 96 },
  { x: 216, y: 480, width: 20, height: 96 },
];

const result: ComparisonResult = {
  version: 1,
  a: { name: 'a', pageCount: 4 },
  b: { name: 'b', pageCount: 4 },
  settings: { alignment: 'best-match', dpi: 100, threshold: 0.1, visual: true, text: true },
  pages: [
    {
      pair: pairs[0]!,
      status: 'changed',
      visual: visual([{ x: 280, y: 684, width: 52, height: 16 }]),
      textChanges: 1,
      geometryChanged: false,
    },
    {
      pair: pairs[1]!,
      status: 'changed',
      visual: visual(moved),
      textChanges: 0,
      geometryChanged: false,
    },
    {
      pair: pairs[2]!,
      status: 'deleted',
      textChanges: 0,
      words: 22,
      firstLine: 'Appendix to be removed',
      geometryChanged: false,
    },
    {
      pair: pairs[3]!,
      status: 'identical',
      visual: visual([], 0),
      textChanges: 0,
      geometryChanged: false,
    },
    {
      pair: pairs[4]!,
      status: 'inserted',
      textChanges: 0,
      words: 22,
      firstLine: 'Added in revision',
      geometryChanged: false,
    },
  ],
  text: {
    scope: 'document',
    changes: [
      {
        kind: 'changed',
        a: {
          page: 0,
          text: 'Monday',
          rects: [{ x: 284.78, y: 687.52, width: 42.68, height: 11.1 }],
        },
        b: {
          page: 0,
          text: 'Tuesday',
          rects: [{ x: 284.78, y: 687.52, width: 46.02, height: 11.1 }],
          line: 'The committee approved the budget on Tuesday after a short debate.',
        },
      },
      // Removed words on a page that only A has (the deleted page): revealed on A.
      {
        kind: 'removed',
        a: { page: 2, text: 'gone', rects: [{ x: 10, y: 10, width: 5, height: 5 }] },
      },
      // Added words on B's page 3 (paired with A's page 4).
      { kind: 'added', b: { page: 2, text: 'new', rects: [{ x: 1, y: 2, width: 3, height: 4 }] } },
    ],
    pairsOverBudget: [],
    tokens: { a: 100, b: 100 },
  },
  facts: [
    { kind: 'metadata', key: 'Title', a: 'Quarterly report', b: 'Quarterly report (revised)' },
    { kind: 'annotations', key: 'Highlight', a: '1', b: '2', aPage: 1, bPage: 1 },
    { kind: 'attachment', key: 'data.csv', b: 'data.csv' },
    { kind: 'page-size', key: 'size', a: '612 × 792', aPage: 2 },
  ],
  counts: {
    identical: 1,
    changed: 2,
    inserted: 1,
    deleted: 1,
    textAdded: 1,
    textRemoved: 1,
    textChanged: 1,
    visualRegions: 3,
    facts: 4,
  },
  notes: ['1', '2', '3', '4'],
};

describe('buildChangeList', () => {
  const list = buildChangeList(result);

  it('puts document facts first and groups the rest by page-map row', () => {
    expect(list.document.map((i) => i.id)).toEqual(['fact:0', 'fact:2']);
    expect(list.groups.map((g) => [g.row, g.status, g.items.map((i) => i.id)])).toEqual([
      [0, 'changed', ['visual:0', 'text:0']],
      [1, 'changed', ['visual:1', 'fact:1']],
      [2, 'deleted', ['page:2', 'text:1', 'fact:3']],
      [3, 'identical', ['text:2']],
      [4, 'inserted', ['page:4']],
    ]);
    expect(list.flat.map((i) => i.id)).toEqual([
      'fact:0',
      'fact:2',
      'visual:0',
      'text:0',
      'visual:1',
      'fact:1',
      'page:2',
      'text:1',
      'fact:3',
      'text:2',
      'page:4',
    ]);
  });

  it('gives every row a sign: + added, − removed, ~ changed', () => {
    const signs = Object.fromEntries(list.flat.map((i) => [i.id, i.sign]));
    expect(signs).toMatchObject({
      'fact:0': '~',
      'fact:2': '+',
      'fact:3': '-',
      'text:0': '~',
      'text:1': '-',
      'text:2': '+',
      'page:2': '-',
      'page:4': '+',
      'visual:1': '~',
    });
  });

  it('reveals text on B where it exists, removed text on A, areas on B', () => {
    const byId = new Map(list.flat.map((i) => [i.id, i]));
    const word = byId.get('text:0');
    expect(word).toMatchObject({ row: 0, side: 'b' });
    expect(word?.rect?.x).toBeCloseTo(284.78, 6);
    expect(word?.rect?.width).toBeCloseTo(46.02, 6);
    expect(word?.rect?.height).toBeCloseTo(11.1, 6);
    expect(byId.get('text:1')).toMatchObject({ row: 2, side: 'a' });
    expect(byId.get('visual:1')).toMatchObject({
      row: 1,
      side: 'b',
      rect: { x: 72, y: 480, width: 164, height: 96 },
      regions: 2,
    });
    expect(byId.get('page:2')).toMatchObject({ side: 'a', page: 2, words: 22 });
    expect(byId.get('page:4')).toMatchObject({ side: 'b', page: 3 });
    expect(byId.get('fact:0')).toMatchObject({ row: null });
  });

  it('labels changes in words', () => {
    const byId = new Map(list.flat.map((i) => [i.id, i]));
    expect(changeLabel(byId.get('text:0')!)).toEqual({
      title: '“Monday” → “Tuesday”',
      detail: 'The committee approved the budget on Tuesday after a short debate.',
    });
    expect(changeLabel(byId.get('page:2')!)).toEqual({
      title: 'Page 3 deleted',
      detail: '“Appendix to be removed” · 22 words',
    });
    expect(changeLabel(byId.get('visual:1')!).title).toBe('2 changed areas');
    expect(changeLabel(byId.get('fact:2')!)).toEqual({
      title: 'Attachment “data.csv”',
      detail: 'only in B: “data.csv”',
    });
  });

  it('reports an identical comparison as an empty list', () => {
    const same = buildChangeList({
      ...result,
      pages: [result.pages[3]!],
      text: { ...result.text, changes: [] },
      facts: [],
    });
    expect(same.flat).toEqual([]);
  });
});

describe('buildPartialChangeList', () => {
  it('lists inserted and deleted pages at once and areas as they land', () => {
    const partial = buildPartialChangeList(pairs, { 1: visual(moved), 3: visual([], 0) });
    expect(partial.flat.map((i) => i.id)).toEqual(['visual:1', 'page:2', 'page:4']);
    expect(partial.groups.map((g) => g.status)).toEqual(['changed', 'deleted', 'inserted']);
    expect(rowStatus(0, pairs, {}, null)).toBe('pending');
    expect(rowStatus(3, pairs, { 3: visual([], 0) }, null)).toBe('identical');
    expect(rowStatus(0, pairs, {}, result)).toBe('changed');
  });
});

describe('helpers', () => {
  it('steps through changes and wraps around', () => {
    const flat = buildChangeList(result).flat;
    expect(stepChange(flat, null, 1)?.id).toBe('fact:0');
    expect(stepChange(flat, null, -1)?.id).toBe('page:4');
    expect(stepChange(flat, 'page:4', 1)?.id).toBe('fact:0');
    expect(stepChange(flat, 'fact:0', -1)?.id).toBe('page:4');
    expect(stepChange(flat, 'visual:0', 1)?.id).toBe('text:0');
    expect(stepChange([], null, 1)).toBeUndefined();
  });

  it('maps pages to rows and unions rectangles', () => {
    const rows = rowIndex(pairs);
    expect([...rows.a]).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
    expect([...rows.b]).toEqual([
      [0, 0],
      [1, 1],
      [2, 3],
      [3, 4],
    ]);
    expect(unionRect([])).toBeUndefined();
    expect(unionRect(moved)).toEqual({ x: 72, y: 480, width: 164, height: 96 });
  });

  it('formats shares of a page', () => {
    expect(sharePercent(0.0123)).toBe('1.2%');
    expect(sharePercent(0.00001)).toBe('< 0.1%');
    expect(sharePercent(0)).toBe('0%');
  });

  it('translates the engine notes, and shows unknown ones as written', () => {
    expect(honestyLines(result)[0]).toBe(
      'Pixel differences at 100 dpi: they show where pages look different, not why; a pixel diff cannot tell intent.',
    );
    expect(honestyLines({ ...result, notes: ['Something new.'] }, ['x'])).toEqual([
      'Something new.',
      'x has cropped, resized or added pages, so it was compared as it will be exported, including its page numbers and watermarks.',
    ]);
  });
});

describe('changesMarkdown', () => {
  it('writes the list with signs, groups and the honesty lines', () => {
    const text = changesMarkdown(result, buildChangeList(result));
    expect(text.split('\n').slice(0, 5)).toEqual([
      '# Changes: a → b',
      '',
      'Pages: 2 changed · 1 inserted · 1 deleted · 1 unchanged',
      '',
      '> Pixel differences at 100 dpi: they show where pages look different, not why; a pixel diff cannot tell intent.',
    ]);
    expect(text).toContain(
      '## Document\n\n- ~ Document info: Title — “Quarterly report” → “Quarterly report (revised)”\n- + Attachment “data.csv” — only in B: “data.csv”\n',
    );
    expect(text).toContain(
      '## Page 3 of A\n\n- − Page 3 deleted — “Appendix to be removed” · 22 words\n',
    );
    expect(text).toContain('## Page 4 ↔ 3\n\n- + Added “new”\n');
    expect(text).toContain(
      '## Page 4 of B\n\n- + Page 4 inserted — “Added in revision” · 22 words\n',
    );
  });
});
