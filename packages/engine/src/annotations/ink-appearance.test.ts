/**
 * The variable-width ink writer and parser (ADR-0018): the appearance, /Rect and
 * `/PdfEditorInkWidths` built from an ink, and the widths read back and checked against
 * `/InkList`. Pure; the PDFium round trip is in pdfium/ink-appearance.test.ts.
 */
import { describe, expect, test } from 'vitest';

import {
  clearInkOutlineCache,
  formatInkWidths,
  INK_OUTLINE_CACHE_PATHS,
  INK_WIDTHS_KEY,
  inkAppearance,
  inkOutlineCacheStats,
  MIN_INK_WIDTH,
  parseInkWidths,
  storedInkWidths,
} from './ink-appearance';
import {
  encodeInkWidths,
  inkAppearanceContent,
  inkOutlineBounds,
  type InkPoint,
} from './ink-outline';

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

function expectBoundsNear(
  actual: { x: number; y: number; width: number; height: number } | undefined,
  expected: { x: number; y: number; width: number; height: number },
): void {
  expect(actual).toBeDefined();
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    expect(Math.abs((actual?.[key] ?? Number.NaN) - expected[key])).toBeLessThan(1e-9);
  }
}

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
    expectBoundsNear(write?.rect, inkOutlineBounds(PATHS, stored));
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

/** A handwriting-like stroke: `n` points along a wavy line from (x, y), widths 1–3 pt. */
function handStroke(x: number, y: number, n: number, seed: number) {
  const path: InkPoint[] = [];
  const widths: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / Math.max(1, n - 1);
    path.push({
      x: x + t * 18 + Math.sin(t * 9 + seed) * 2.3,
      y: y + Math.cos(t * 7 + seed * 1.7) * 6.1 + ((i * 37 + seed) % 5) * 0.013,
    });
    widths.push(1 + ((i * 13 + seed) % 7) * 0.31);
  }
  return { path, widths };
}

function burst(paths: number, points = 100) {
  const strokes = Array.from({ length: paths }, (_, k) => handStroke(60 + k * 7.5, 500, points, k));
  return { paths: strokes.map((s) => s.path), widths: strokes.map((s) => s.widths) };
}

describe('per-path outline cache (craft spec §5.3 item 8)', () => {
  test('cached and uncached builds are byte for byte the same', () => {
    clearInkOutlineCache();
    const { paths, widths } = burst(12, 40);
    for (const opacity of [1, 0.5]) {
      const cold = inkAppearance({ paths, widths, color: '#1760EE', opacity });
      const warm = inkAppearance({ paths, widths, color: '#1760EE', opacity });
      const stored = storedInkWidths(paths, widths) ?? [];
      const expected = inkAppearanceContent({ paths, widths: stored, color: '#1760EE', opacity });
      expect(cold?.content).toBe(expected);
      expect(warm?.content).toBe(expected);
      expect(warm?.widths).toBe(encodeInkWidths(stored));
      expectBoundsNear(warm?.rect, inkOutlineBounds(paths, stored));
    }
    // A dot and an empty path among others.
    const odd = {
      paths: [[{ x: 10, y: 10 }], [], ...paths.slice(0, 2)],
      widths: [[3], [], ...widths.slice(0, 2)],
    };
    const stored = storedInkWidths(odd.paths, odd.widths) ?? [];
    expect(inkAppearance(odd)?.content).toBe(
      inkAppearanceContent({ paths: odd.paths, widths: stored, color: '#000000' }),
    );
    expect(inkAppearance(odd)?.widths).toBe(encodeInkWidths(stored));
  });

  test('an append outlines the new path only; a changed point or width misses', () => {
    clearInkOutlineCache();
    const { paths, widths } = burst(5, 20);
    inkAppearance({ paths: paths.slice(0, 4), widths: widths.slice(0, 4) });
    expect(inkOutlineCacheStats()).toMatchObject({ misses: 4, hits: 0 });
    inkAppearance({ paths, widths });
    expect(inkOutlineCacheStats()).toMatchObject({ misses: 5, hits: 4 });
    // The same path with one width changed (beyond the two stored decimals) is a new entry.
    const changed = widths.map((w, k) => (k === 2 ? w.map((x, i) => (i === 3 ? x + 0.5 : x)) : w));
    inkAppearance({ paths, widths: changed });
    expect(inkOutlineCacheStats()).toMatchObject({ misses: 6, hits: 8 });
    // A moved point too.
    const moved = paths.map((p, k) => (k === 0 ? p.map((q) => ({ x: q.x + 1, y: q.y })) : p));
    const write = inkAppearance({ paths: moved, widths });
    expect(inkOutlineCacheStats()).toMatchObject({ misses: 7, hits: 12 });
    expect(write?.content).toBe(
      inkAppearanceContent({
        paths: moved,
        widths: storedInkWidths(moved, widths) ?? [],
        color: '#000000',
      }),
    );
  });

  test('the cache is bounded', () => {
    clearInkOutlineCache();
    for (let k = 0; k < INK_OUTLINE_CACHE_PATHS + 10; k++) {
      const s = handStroke(k, 0, 2, k);
      inkAppearance({ paths: [s.path], widths: [s.widths] });
    }
    expect(inkOutlineCacheStats().size).toBe(INK_OUTLINE_CACHE_PATHS);
  });

  test('[p9] appending the 64th path of a burst costs the new path only', () => {
    const { paths, widths } = burst(64, 100);
    const time = (fn: () => void, runs: number) => {
      const samples: number[] = [];
      for (let r = 0; r < runs; r++) {
        const t0 = performance.now();
        fn();
        samples.push(performance.now() - t0);
      }
      samples.sort((a, b) => a - b);
      return samples[Math.floor(samples.length / 2)] ?? Number.NaN;
    };
    // Before: every path outlined again (what each append cost without the cache).
    const stored = storedInkWidths(paths, widths) ?? [];
    const full = time(() => {
      inkAppearanceContent({ paths, widths: stored, color: '#1760EE' });
      inkOutlineBounds(paths, stored);
      encodeInkWidths(stored);
    }, 9);
    // After: the first 63 paths are cached by the previous appends; the 64th is new.
    const appends: number[] = [];
    for (let r = 0; r < 9; r++) {
      clearInkOutlineCache();
      inkAppearance({ paths: paths.slice(0, 63), widths: widths.slice(0, 63), color: '#1760EE' });
      const t0 = performance.now();
      inkAppearance({ paths, widths, color: '#1760EE' });
      appends.push(performance.now() - t0);
    }
    appends.sort((a, b) => a - b);
    const median = appends[Math.floor(appends.length / 2)] ?? Number.NaN;
    // eslint-disable-next-line no-console -- the [p9] numbers of docs/qa/ink-latency-baseline.md
    console.info(
      `[p9] 64-path burst (100 points each): appearance of every path ${full.toFixed(2)} ms; ` +
        `append of the 64th with 63 cached ${median.toFixed(2)} ms`,
    );
    expect(median).toBeLessThan(full);
    expect(median).toBeLessThan(5);
  });
});
