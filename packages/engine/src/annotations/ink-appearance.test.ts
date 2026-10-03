/**
 * The variable-width ink writer and parser (ADR-0018): the appearance, /Rect and
 * `/PdfEditorInkWidths` built from an ink, and the widths read back and checked against
 * `/InkList`. Pure; the PDFium round trip is in pdfium/ink-appearance.test.ts.
 */
import { describe, expect, test } from 'vitest';

import {
  formatInkWidths,
  INK_WIDTHS_KEY,
  inkAppearance,
  MIN_INK_WIDTH,
  parseInkWidths,
  storedInkWidths,
} from './ink-appearance';
import { inkAppearanceContent, inkOutlineBounds, type InkPoint } from './ink-outline';

const line = (n: number, y = 100): InkPoint[] =>
  Array.from({ length: n }, (_, i) => ({ x: 100 + i * 10, y }));

const PATHS = [line(4), line(3, 150)];
const WIDTHS = [
  [1, 2.5, 4, 6],
  [0.5, 0.75, 1],
];

describe('formatInkWidths / parseInkWidths', () => {
  test('round trip: the outline version, one group per path, parallel to the paths', () => {
    const value = formatInkWidths(PATHS, WIDTHS);
    expect(value).toBe('2;1 2.5 4 6;0.5 0.75 1');
    expect(parseInkWidths(value, PATHS)).toEqual(WIDTHS);
    expect(INK_WIDTHS_KEY).toBe('PdfEditorInkWidths');
  });

  test('two decimals, no trailing zeros; widths below 0.01 are stored as 0.01', () => {
    const paths = [line(5)];
    const value = formatInkWidths(paths, [[1.234567, 2.001, 3.1, 0.001, 7]]);
    expect(value).toBe(`2;1.23 2 3.1 ${MIN_INK_WIDTH} 7`);
    // Every stored width parses back (a `0` would not).
    expect(parseInkWidths(value, paths)).toEqual([[1.23, 2, 3.1, 0.01, 7]]);
  });

  test('widths that do not match the paths are dropped', () => {
    expect(formatInkWidths(PATHS, [WIDTHS[0] ?? []])).toBeUndefined();
    expect(formatInkWidths(PATHS, [[1, 2, 3], WIDTHS[1] ?? []])).toBeUndefined();
    expect(formatInkWidths(PATHS, [[1, 2, 3, Number.NaN], WIDTHS[1] ?? []])).toBeUndefined();
    expect(formatInkWidths(PATHS, [[1, 2, 3, -1], WIDTHS[1] ?? []])).toBeUndefined();
    expect(formatInkWidths(PATHS, undefined)).toBeUndefined();

    const value = formatInkWidths(PATHS, WIDTHS);
    // A path gained or lost a point elsewhere, or a path was removed.
    expect(parseInkWidths(value, [line(5), line(3, 150)])).toBeUndefined();
    expect(parseInkWidths(value, [line(4)])).toBeUndefined();
    expect(parseInkWidths(value, [...PATHS, line(2)])).toBeUndefined();
  });

  test('absent, empty, other versions and malformed values read as no widths', () => {
    expect(parseInkWidths(undefined, PATHS)).toBeUndefined();
    expect(parseInkWidths('', PATHS)).toBeUndefined();
    expect(parseInkWidths('3;1 2 3 4;1 2 3', PATHS)).toBeUndefined();
    expect(parseInkWidths('1;1 2 x 4;1 2 3', PATHS)).toBeUndefined();
    expect(parseInkWidths('1;1 2 0 4;1 2 3', PATHS)).toBeUndefined();
    expect(parseInkWidths('1;1 2 3 4', PATHS)).toBeUndefined();
  });
});

describe('inkAppearance', () => {
  test('content, /Rect and widths from the stored (two-decimal) widths', () => {
    const widths = [
      [1.004, 2.5, 4, 6],
      [0.5, 0.75, 1],
    ];
    const write = inkAppearance({ paths: PATHS, widths, color: '#1E5BD8' });
    expect(write).toBeDefined();
    const stored = storedInkWidths(PATHS, widths) ?? [];
    expect(write?.stored).toEqual(stored);
    expect(write?.widths).toBe('2;1 2.5 4 6;0.5 0.75 1');
    expect(write?.rect).toEqual(inkOutlineBounds(PATHS, stored));
    expect(write?.content).toBe(
      inkAppearanceContent({ paths: PATHS, widths: stored, color: '#1E5BD8', opacity: 1 }),
    );
  });

  test('one nonzero fill in the annotation colour; /GS only below full opacity', () => {
    const opaque = inkAppearance({ paths: PATHS, widths: WIDTHS, color: '#E53935' });
    const lines = opaque?.content.split('\n') ?? [];
    expect(lines[0]).toBe('q');
    expect(lines).toContain('0.898 0.224 0.208 rg');
    expect(lines.filter((l) => l === 'f')).toHaveLength(1);
    expect(lines.at(-2)).toBe('f');
    expect(lines.at(-1)).toBe('Q');
    expect(lines).not.toContain('/GS gs');
    // One closed outline per path.
    expect(lines.filter((l) => l === 'h')).toHaveLength(PATHS.length);

    const translucent = inkAppearance({ paths: PATHS, widths: WIDTHS, opacity: 0.6 });
    expect(translucent?.content.split('\n')).toContain('/GS gs');
    // No colour: black, as the mapping writes /C.
    expect(translucent?.content.split('\n')).toContain('0 0 0 rg');
  });

  test('/Rect is the outline bounds plus 0.5 pt (round caps of the end widths)', () => {
    const write = inkAppearance({ paths: [line(4)], widths: [[2, 2, 2, 8]] });
    // Start cap radius 1, end cap radius 4, padding 0.5.
    expect(write?.rect.x).toBeCloseTo(100 - 1 - 0.5, 6);
    expect(write?.rect.width).toBeCloseTo(30 + 1 + 4 + 1, 6);
    expect(write?.rect.y).toBeCloseTo(100 - 4 - 0.5, 6);
    expect(write?.rect.height).toBeCloseTo(8 + 1, 6);
  });

  test('without matching widths there is nothing to write (constant width)', () => {
    expect(inkAppearance({ paths: PATHS })).toBeUndefined();
    expect(inkAppearance({ paths: PATHS, widths: [[1, 2]] })).toBeUndefined();
  });

  test('regenerating from the file gives the same stream as the first write', () => {
    const first = inkAppearance({
      paths: PATHS,
      widths: [
        [1.111, 2.222, 3.333, 4.444],
        [1, 1, 1],
      ],
    });
    const read = parseInkWidths(first?.widths, PATHS);
    expect(read).toBeDefined();
    const again = inkAppearance({ paths: PATHS, widths: read ?? [] });
    expect(again?.content).toBe(first?.content);
    expect(again?.widths).toBe(first?.widths);
  });
});
