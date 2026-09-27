import { describe, expect, it } from 'vitest';

import {
  cellRect,
  cellsInRect,
  computeLayout,
  edgeScrollSpeed,
  gapAt,
  gapBar,
  gapForIndex,
  GRID,
  type GridMetrics,
  gridMetrics,
  normalizeRect,
  rowItemIndex,
  sectionAtY,
} from './geometry';

/** 4 columns of 100px cells, 20px gutters, 32px side padding, 200px rows. */
const M: GridMetrics = {
  cellWidth: 100,
  boxHeight: 130,
  rowHeight: 200,
  columns: 4,
  padX: 32,
  gapX: 20,
};
const PITCH = M.cellWidth + M.gapX;
/** x at the centre of the gutter before column c. */
const gutter = (c: number) => M.padX + c * PITCH - M.gapX / 2;
/** x at the centre of cell c. */
const centre = (c: number) => M.padX + c * PITCH + M.cellWidth / 2;

describe('gridMetrics', () => {
  it('fits as many columns as the width allows, at least one', () => {
    // 32 + 4 × 144 + 3 × 20 + 32 = 700
    expect(gridMetrics(700, 144).columns).toBe(4);
    expect(gridMetrics(699, 144).columns).toBe(3);
    expect(gridMetrics(50, 400).columns).toBe(1);
    const m = gridMetrics(1000, 200);
    expect(m.boxHeight).toBe(Math.round(200 * GRID.boxAspect));
    expect(m.rowHeight).toBe(m.boxHeight + GRID.metaHeight + GRID.gapY);
  });
});

describe('gapAt', () => {
  it('snaps to the nearest gutter within a row', () => {
    expect(gapAt(M, 10, gutter(0), 50)).toEqual({ index: 0, row: 0, column: 0 });
    expect(gapAt(M, 10, centre(0) - 1, 50).index).toBe(0);
    expect(gapAt(M, 10, centre(0) + 1, 50).index).toBe(1);
    expect(gapAt(M, 10, gutter(2), 50)).toEqual({ index: 2, row: 0, column: 2 });
    // Second row.
    expect(gapAt(M, 10, gutter(1), 250)).toEqual({ index: 5, row: 1, column: 1 });
  });

  it('distinguishes a row end from the next row start (same index, different bar)', () => {
    const end = gapAt(M, 10, centre(3) + 30, 50);
    const start = gapAt(M, 10, gutter(0), 250);
    expect(end).toEqual({ index: 4, row: 0, column: 4 });
    expect(start).toEqual({ index: 4, row: 1, column: 0 });
    expect(gapBar(M, end).x).toBeGreaterThan(gapBar(M, start).x);
    expect(gapBar(M, end).y).toBe(0);
    expect(gapBar(M, start).y).toBe(M.rowHeight);
  });

  it('clamps to the cells of a short last row and far-right pointers', () => {
    // 10 pages: last row (row 2) has 2 cells.
    expect(gapAt(M, 10, centre(3), 450)).toEqual({ index: 10, row: 2, column: 2 });
    expect(gapAt(M, 10, 5000, 50)).toEqual({ index: 4, row: 0, column: 4 });
    expect(gapAt(M, 10, -100, 50)).toEqual({ index: 0, row: 0, column: 0 });
  });

  it('means "end of section" below the last row and "first row" above the grid', () => {
    expect(gapAt(M, 10, gutter(0), 10_000)).toEqual({ index: 10, row: 2, column: 2 });
    expect(gapAt(M, 8, gutter(0), 400)).toEqual({ index: 8, row: 1, column: 4 });
    expect(gapAt(M, 10, gutter(1), -30)).toEqual({ index: 1, row: 0, column: 1 });
  });

  it('returns gap 0 in an empty section', () => {
    expect(gapAt(M, 0, 999, 999)).toEqual({ index: 0, row: 0, column: 0 });
  });

  it('works with a single column', () => {
    const one = { ...M, columns: 1 };
    expect(gapAt(one, 3, centre(0) + 1, 250)).toEqual({ index: 2, row: 1, column: 1 });
    expect(gapAt(one, 3, gutter(0), 250)).toEqual({ index: 1, row: 1, column: 0 });
  });
});

describe('gapForIndex / gapBar', () => {
  it('maps indices to bars, with the section end at the last row end', () => {
    expect(gapForIndex(M, 10, 0)).toEqual({ index: 0, row: 0, column: 0 });
    expect(gapForIndex(M, 10, 5)).toEqual({ index: 5, row: 1, column: 1 });
    expect(gapForIndex(M, 10, 10)).toEqual({ index: 10, row: 2, column: 2 });
    expect(gapForIndex(M, 8, 8)).toEqual({ index: 8, row: 1, column: 4 });
    expect(gapForIndex(M, 0, 3)).toEqual({ index: 0, row: 0, column: 0 });
  });

  it('centres the 2px bar in the gutter, spanning the thumbnail box', () => {
    const bar = gapBar(M, { index: 1, row: 0, column: 1 });
    expect(bar.x + 1).toBe(gutter(1));
    expect(bar.height).toBe(M.boxHeight);
  });
});

describe('computeLayout', () => {
  const layout = computeLayout(
    [
      { id: 'a', count: 10, collapsed: false },
      { id: 'b', count: 0, collapsed: false },
      { id: 'c', count: 5, collapsed: true },
    ],
    M,
  );

  it('stacks header, rows and a trailing gap per section', () => {
    const [a, b, c] = layout.sections;
    expect(a).toMatchObject({ top: GRID.padTop, rows: 3, gridHeight: 600 });
    expect(a?.gridTop).toBe(GRID.padTop + GRID.headerHeight);
    expect(b).toMatchObject({ rows: 1, gridHeight: GRID.emptyRowHeight, top: a?.bottom });
    expect(c).toMatchObject({ rows: 0, gridHeight: 0, collapsed: true });
    expect(layout.totalHeight).toBe((c?.bottom ?? 0) + GRID.padBottom);
  });

  it('produces virtualizer items whose starts are contiguous', () => {
    expect(layout.items.map((i) => i.kind)).toEqual([
      'header',
      'row',
      'row',
      'row',
      'gap',
      'header',
      'row',
      'gap',
      'header',
      'gap',
    ]);
    for (let i = 1; i < layout.items.length; i++) {
      const previous = layout.items[i - 1]!;
      expect(layout.items[i]!.start).toBe(previous.start + previous.size);
    }
  });

  it('finds the row item of a page and the section at a y', () => {
    const [a, , c] = layout.sections;
    expect(rowItemIndex(a!, 5, M.columns)).toBe(2);
    expect(rowItemIndex(c!, 3, M.columns)).toBe(c!.firstItem);
    expect(sectionAtY(layout, (a?.gridTop ?? 0) + 10)?.id).toBe('a');
    expect(sectionAtY(layout, -5)).toBeUndefined();
  });
});

describe('cellsInRect (marquee)', () => {
  const layout = computeLayout(
    [
      { id: 'a', count: 10, collapsed: false },
      { id: 'b', count: 6, collapsed: false },
    ],
    M,
  );
  const [a, b] = layout.sections;

  it('hits the cells a rectangle touches, in page order', () => {
    const first = cellRect(a!, M, 1);
    const sixth = cellRect(a!, M, 6);
    const hits = cellsInRect(
      layout,
      M,
      normalizeRect(sixth.right - 5, sixth.bottom - 5, first.left + 5, first.top + 5),
    );
    expect(hits).toEqual([{ section: 'a', indices: [1, 2, 5, 6] }]);
  });

  it('ignores gutters and empty slots of a short last row', () => {
    const gap = {
      left: gutter(1) - 2,
      right: gutter(1) + 2,
      top: a!.gridTop,
      bottom: a!.gridTop + 50,
    };
    expect(cellsInRect(layout, M, gap)).toEqual([]);
    // Row 2 of section a has cells 8, 9 only.
    const row2 = a!.gridTop + 2 * M.rowHeight + 10;
    const hits = cellsInRect(layout, M, { left: 0, right: 2000, top: row2, bottom: row2 + 5 });
    expect(hits).toEqual([{ section: 'a', indices: [8, 9] }]);
  });

  it('spans sections', () => {
    const from = cellRect(a!, M, 9);
    const to = cellRect(b!, M, 0);
    const hits = cellsInRect(
      layout,
      M,
      normalizeRect(from.left + 1, from.top + 1, to.left + 1, to.top + 1),
    );
    expect(hits).toEqual([
      { section: 'a', indices: [8, 9] },
      { section: 'b', indices: [0, 1] },
    ]);
  });
});

describe('edgeScrollSpeed', () => {
  it('is zero in the middle and ramps up towards either edge', () => {
    expect(edgeScrollSpeed(500, 0, 1000)).toBe(0);
    expect(edgeScrollSpeed(10, 0, 1000)).toBeLessThan(0);
    expect(edgeScrollSpeed(0, 0, 1000)).toBe(-24);
    expect(edgeScrollSpeed(990, 0, 1000)).toBeGreaterThan(0);
    expect(Math.abs(edgeScrollSpeed(40, 0, 1000))).toBeLessThan(
      Math.abs(edgeScrollSpeed(5, 0, 1000)),
    );
  });
});
