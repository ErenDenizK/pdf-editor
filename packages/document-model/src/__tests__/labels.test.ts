import { describe, expect, it } from 'vitest';
import {
  deriveLabelRanges,
  deriveRangesFromLabels,
  effectiveLabel,
  formatRangeLabel,
  fromRoman,
  labelCandidates,
  needsPageLabels,
  parseLabel,
  setLabelRanges,
  toAlpha,
  toRoman,
} from '../labels';
import { getDocument } from '../selectors';
import type { DocumentId, PageLabelRange } from '../types';
import { expectCode, labelsOf, must, open } from './fixtures';
import { movePages, reversePages } from '../pages';
import { newEmptyDocument } from '../workspace';

/** Formats derived ranges back into strings; must reproduce the input exactly. */
function render(ranges: readonly PageLabelRange[], count: number): string[] {
  return Array.from({ length: count }, (_, i) => {
    let range: PageLabelRange | undefined;
    for (const r of ranges) if (r.startIndex <= i) range = r;
    if (range === undefined) throw new Error(`no range covers ${i}`);
    return formatRangeLabel(range, i - range.startIndex);
  });
}

describe('number formats', () => {
  it('formats and parses roman numerals canonically', () => {
    expect(toRoman(1994)).toBe('MCMXCIV');
    expect(fromRoman('MCMXCIV')).toBe(1994);
    expect(fromRoman('IIII')).toBeUndefined();
    expect(fromRoman('')).toBeUndefined();
  });

  it('formats PDF alphabetic numbering', () => {
    expect([1, 26, 27, 53].map(toAlpha)).toEqual(['A', 'Z', 'AA', 'AAA']);
  });
});

describe('parseLabel', () => {
  it.each([
    ['12', { style: 'decimal', prefix: '', number: 12 }],
    ['A-1', { style: 'decimal', prefix: 'A-', number: 1 }],
    ['iv', { style: 'roman-lower', prefix: '', number: 4 }],
    ['App. XIV', { style: 'roman-upper', prefix: 'App. ', number: 14 }],
    ['b', { style: 'alpha-lower', prefix: '', number: 2 }],
    ['007', { style: 'decimal', prefix: '00', number: 7 }],
    ['Cover', { style: 'none', prefix: 'Cover' }],
    ['0', { style: 'none', prefix: '0' }],
    ['', { style: 'none', prefix: '' }],
  ])('parses %j', (label, expected) => {
    expect(parseLabel(label)).toEqual(expected);
  });

  it('lists every reading that round-trips', () => {
    for (const label of ['C', 'x', 'AA', 'iiii', 'p-10']) {
      for (const candidate of labelCandidates(label)) {
        const range: PageLabelRange =
          candidate.number === undefined
            ? { startIndex: 0, style: candidate.style, prefix: candidate.prefix }
            : {
                startIndex: 0,
                style: candidate.style,
                prefix: candidate.prefix,
                firstNumber: candidate.number,
              };
        expect(formatRangeLabel(range, 0)).toBe(label);
      }
    }
  });
});

describe('deriveRangesFromLabels', () => {
  it('compresses roman front matter followed by a decimal body', () => {
    const labels = ['i', 'ii', 'iii', 'iv', '1', '2', '3', '4', '5'];
    const ranges = deriveRangesFromLabels(labels);
    expect(ranges).toEqual([
      { startIndex: 0, style: 'roman-lower', firstNumber: 1 },
      { startIndex: 4, style: 'decimal', firstNumber: 1 },
    ]);
    expect(render(ranges, labels.length)).toEqual(labels);
  });

  it('detects prefixed sequences such as appendix pages', () => {
    const labels = ['1', '2', 'A-1', 'A-2', 'A-3', 'B-1'];
    expect(deriveRangesFromLabels(labels)).toEqual([
      { startIndex: 0, style: 'decimal', firstNumber: 1 },
      { startIndex: 2, style: 'decimal', prefix: 'A-', firstNumber: 1 },
      { startIndex: 5, style: 'decimal', prefix: 'B-', firstNumber: 1 },
    ]);
  });

  it('uses lookahead to disambiguate letters that are also roman numerals', () => {
    expect(deriveRangesFromLabels(['c', 'd', 'e'])).toEqual([
      { startIndex: 0, style: 'alpha-lower', firstNumber: 3 },
    ]);
    expect(deriveRangesFromLabels(['x', 'xi'])).toEqual([
      { startIndex: 0, style: 'roman-lower', firstNumber: 10 },
    ]);
    expect(deriveRangesFromLabels(['Y', 'Z', 'AA'])).toEqual([
      { startIndex: 0, style: 'alpha-upper', firstNumber: 25 },
    ]);
  });

  it('falls back to literal none-style ranges for inexpressible labels', () => {
    const labels = ['Cover', 'Cover', '', '1'];
    const ranges = deriveRangesFromLabels(labels);
    expect(ranges).toEqual([
      { startIndex: 0, style: 'none', prefix: 'Cover' },
      { startIndex: 2, style: 'none' },
      { startIndex: 3, style: 'decimal', firstNumber: 1 },
    ]);
    expect(render(ranges, labels.length)).toEqual(labels);
  });

  it('round-trips arbitrary label lists', () => {
    let seed = 42;
    const random = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    const pool = [
      '1',
      '2',
      '3',
      'i',
      'ii',
      'x',
      'A',
      'B',
      'AA',
      'A-1',
      'A-2',
      'Cover',
      '',
      '07',
      '08',
      'XL',
    ];
    for (let run = 0; run < 200; run++) {
      const labels = Array.from({ length: random(12) }, () => pool[random(pool.length)] ?? '');
      expect(render(deriveRangesFromLabels(labels), labels.length)).toEqual(labels);
    }
  });
});

describe('effective labels', () => {
  const { ws, docs } = open(['A', 3, { labels: ['iv', 'v', '1'] }], ['B', 2]);
  const [a, b] = docs as [DocumentId, DocumentId];

  it('falls back to authored labels, then to positions', () => {
    expect(labelsOf(ws, a)).toEqual(['iv', 'v', '1']);
    expect(labelsOf(ws, b)).toEqual(['1', '2']);
  });

  it('lets explicit ranges win from their start index on', () => {
    const next = setLabelRanges(ws, a, [
      { startIndex: 1, style: 'alpha-upper', prefix: 'P', firstNumber: 2 },
    ]);
    expect(labelsOf(next, a)).toEqual(['iv', 'PB', 'PC']);
  });

  it('derives /PageLabels ranges from effective labels', () => {
    expect(deriveLabelRanges(ws, getDocument(ws, a))).toEqual([
      { startIndex: 0, style: 'roman-lower', firstNumber: 4 },
      { startIndex: 2, style: 'decimal', firstNumber: 1 },
    ]);
  });

  it('validates indices and ranges', () => {
    expectCode(() => effectiveLabel(ws, getDocument(ws, a), 3), 'invalid-index');
    expectCode(() => setLabelRanges(ws, a, [{ startIndex: 3, style: 'decimal' }]), 'invalid-range');
    expectCode(
      () =>
        setLabelRanges(ws, a, [
          { startIndex: 1, style: 'decimal' },
          { startIndex: 1, style: 'roman-lower' },
        ]),
      'invalid-range',
    );
    expectCode(
      () => setLabelRanges(ws, a, [{ startIndex: 0, style: 'decimal', firstNumber: 0 }]),
      'invalid-range',
    );
    expectCode(
      () => setLabelRanges(ws, a, [{ startIndex: 0, style: 'hex' as never }]),
      'invalid-range',
    );
  });

  it('sorts ranges given out of order', () => {
    const next = setLabelRanges(ws, a, [
      { startIndex: 2, style: 'decimal' },
      { startIndex: 0, style: 'roman-lower' },
    ]);
    expect(labelsOf(next, a)).toEqual(['i', 'ii', '1']);
  });
});

describe('needsPageLabels', () => {
  const { ws, docs, ids } = open(['A', 3, { labels: ['iv', 'v', '1'] }], ['B', 3]);
  const [a, b] = docs as [DocumentId, DocumentId];
  const needs = (w: typeof ws, d: DocumentId): boolean => needsPageLabels(w, getDocument(w, d));

  it('is false for plain 1…n numbering and for empty documents', () => {
    expect(needs(ws, b)).toBe(false);
    expect(needs(reversePages(ws, b), b)).toBe(false);
    const empty = newEmptyDocument(ws, ids);
    expect(needs(empty.workspace, empty.documentId)).toBe(false);
  });

  it('is false for explicit ranges that reproduce plain numbering', () => {
    expect(
      needs(setLabelRanges(ws, b, [{ startIndex: 0, style: 'decimal', firstNumber: 1 }]), b),
    ).toBe(false);
  });

  it('is true for authored labels, offsets, prefixes and other styles', () => {
    expect(needs(ws, a)).toBe(true);
    expect(
      needs(setLabelRanges(ws, b, [{ startIndex: 0, style: 'decimal', firstNumber: 2 }]), b),
    ).toBe(true);
    expect(
      needs(setLabelRanges(ws, b, [{ startIndex: 0, style: 'decimal', prefix: 'B-' }]), b),
    ).toBe(true);
    expect(needs(setLabelRanges(ws, b, [{ startIndex: 2, style: 'roman-lower' }]), b)).toBe(true);
  });

  it('turns true when a page with an authored label moves in', () => {
    const moved = movePages(ws, {
      pageIds: [must(getDocument(ws, a).pages[0]).id],
      target: { document: b, index: 3 },
    });
    expect(labelsOf(moved, b)).toEqual(['1', '2', '3', 'iv']);
    expect(needs(moved, b)).toBe(true);
  });
});
