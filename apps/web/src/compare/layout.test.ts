/** Compare view geometry (compare/layout.ts): fit, rows, visibility and reveal maths. */
import { describe, expect, it } from 'vitest';

import type { SourceId } from '@pdf-editor/document-model';

import {
  fitPageScale,
  fitScale,
  heatmapCss,
  LAYOUT,
  layoutRows,
  markerBox,
  revealScrollTop,
  rowSizes,
  sheetBox,
  visibleRows,
} from './layout';
import type { SidePage } from './side-page';

const letter = { width: 612, height: 792 };
const page = (overrides: Partial<SidePage> = {}): SidePage => ({
  sourceId: 's' as SourceId,
  index: 0,
  delta: 0,
  intrinsic: 0,
  size: letter,
  origin: { x: 0, y: 0 },
  ...overrides,
});

describe('fit and rows', () => {
  const rows = [{ a: letter, b: letter }, { a: letter }, { b: { width: 792, height: 612 } }];

  it('fits two columns (side by side) or one (overlay) to the width', () => {
    // Widest page 792 pt; 1000 px minus padding and the gap, over two columns.
    expect(fitScale(rows, 'side', 1000)).toBeCloseTo((1000 - 64 - 24) / 2 / 792, 6);
    expect(fitScale(rows, 'overlay', 1000)).toBeCloseTo((1000 - 64) / 792, 6);
    // Fit page also fits the tallest page (792 pt) in the height.
    const available = 600 - LAYOUT.header - LAYOUT.padTop - LAYOUT.label - LAYOUT.rowGap;
    expect(fitPageScale(rows, 'overlay', 1000, 600)).toBeCloseTo(available / 792, 6);
    expect(fitScale([], 'side', 0)).toBeGreaterThan(0);
  });

  it('stacks rows by their taller page, after the sticky header', () => {
    const layout = layoutRows(rows, 'side', 0.5);
    const first = LAYOUT.header + LAYOUT.padTop;
    expect(layout.tops).toEqual([
      first,
      first + LAYOUT.label + 396 + LAYOUT.rowGap,
      first + 2 * (LAYOUT.label + 396 + LAYOUT.rowGap),
    ]);
    expect(layout.heights).toEqual([LAYOUT.label + 396, LAYOUT.label + 396, LAYOUT.label + 306]);
    expect(layout.columnWidth).toBe(396);
    expect(layout.contentWidth).toBe(2 * LAYOUT.padX + 2 * 396 + LAYOUT.columnGap);
  });

  it('finds the rows in view', () => {
    const layout = layoutRows(rows, 'side', 0.5);
    expect(visibleRows(layout, 0, 100)).toEqual({ first: 0, last: 0 });
    expect(visibleRows(layout, 0, 10_000)).toEqual({ first: 0, last: 2 });
    expect(visibleRows(layout, layout.tops[1]! + 10, 50)).toEqual({ first: 1, last: 1 });
    expect(visibleRows(layout, 99_999, 100)).toEqual({ first: 2, last: 2 });
    expect(visibleRows(layoutRows([], 'side', 1), 0, 100)).toEqual({ first: 0, last: -1 });
  });

  it('builds row sizes from the page map, rotated pages turned', () => {
    const a = [page(), page({ index: 1, delta: 90 })];
    const b = [page()];
    expect(rowSizes([{ a: 0, b: 0 }, { a: 1 }], a, b)).toEqual([
      { a: letter, b: letter },
      { a: { width: 792, height: 612 } },
    ]);
  });
});

describe('sheets and markers', () => {
  const layout = layoutRows([{ a: letter, b: { width: 306, height: 396 } }], 'side', 1);

  it('centres each page in its column side by side, and aligns top-left in overlay', () => {
    expect(sheetBox(layout, 'side', 'a', page())).toEqual({
      left: LAYOUT.padX,
      top: LAYOUT.label,
      width: 612,
      height: 792,
    });
    const small = page({ size: { width: 306, height: 396 } });
    expect(sheetBox(layout, 'side', 'b', small).left).toBe(
      LAYOUT.padX + 612 + LAYOUT.columnGap + (612 - 306) / 2,
    );
    expect(sheetBox(layout, 'overlay', 'b', small).left).toBe(LAYOUT.padX);
  });

  it('maps user-space boxes onto the page, through rotation and the CropBox origin', () => {
    const rect = { x: 72, y: 700, width: 100, height: 20 };
    expect(markerBox(layout, 'side', 'a', page(), rect)).toEqual({
      left: LAYOUT.padX + 72,
      top: LAYOUT.label + (792 - 720),
      width: 100,
      height: 20,
    });
    // Cropped at (10, 20): the same box moves up-left by the origin.
    const cropped = page({ origin: { x: 10, y: 20 } });
    expect(markerBox(layout, 'side', 'a', cropped, rect)).toMatchObject({
      left: LAYOUT.padX + 62,
      top: LAYOUT.label + (792 + 20 - 720),
    });
    // A quarter turn clockwise: x runs down the displayed page, the page top goes right.
    const turned = page({ delta: 90 });
    const rotated = layoutRows([{ a: { width: 792, height: 612 } }], 'side', 1);
    expect(markerBox(rotated, 'side', 'a', turned, rect)).toEqual({
      left: LAYOUT.padX + 792 - (792 - 720) - 20,
      top: LAYOUT.label + 72,
      width: 20,
      height: 100,
    });
  });

  it('sizes the heat map from its dpi', () => {
    expect(heatmapCss({ width: 850, height: 1100, dpi: 100 }, 1)).toEqual({
      width: 612,
      height: 792,
    });
    expect(heatmapCss({ width: 1275, height: 1650, dpi: 150 }, 0.5)).toEqual({
      width: 306,
      height: 396,
    });
  });
});

describe('revealScrollTop', () => {
  const rows = Array.from({ length: 10 }, () => ({ a: letter, b: letter }));
  const layout = layoutRows(rows, 'side', 1);
  const base = {
    layout,
    mode: 'side' as const,
    side: 'b' as const,
    page: page(),
    viewportHeight: 600,
  };

  it('scrolls a box a third of the way down the viewport', () => {
    const rect = { x: 72, y: 100, width: 50, height: 10 };
    const top = layout.tops[4]! + LAYOUT.label + (792 - 110);
    expect(revealScrollTop({ ...base, row: 4, rect, scrollTop: 0 })).toBe(Math.round(top - 200));
  });

  it('keeps the scroll when the box is already in view (below the sticky header)', () => {
    const rect = { x: 72, y: 700, width: 50, height: 10 };
    const top = layout.tops[2]! + LAYOUT.label + (792 - 710);
    expect(revealScrollTop({ ...base, row: 2, rect, scrollTop: top - 100 })).toBe(top - 100);
    // Hidden under the header: scrolls.
    expect(revealScrollTop({ ...base, row: 2, rect, scrollTop: top - 10 })).not.toBe(top - 10);
  });

  it('brings a row without a box to the top, clamped to the content', () => {
    expect(revealScrollTop({ ...base, row: 3, scrollTop: 0 })).toBe(
      layout.tops[3]! - LAYOUT.header - LAYOUT.padTop,
    );
    expect(revealScrollTop({ ...base, row: 0, scrollTop: 500 })).toBe(0);
    const last = revealScrollTop({ ...base, row: 9, scrollTop: 0 });
    expect(last).toBeLessThanOrEqual(layout.contentHeight - 600);
  });
});
