import { describe, expect, it } from 'vitest';

import { needsTiles, tilesFor, TILE_PX } from '../pages/TiledPage';
import { computeRows } from './ReadView';

const sizes = [
  { width: 612, height: 792 },
  { width: 842, height: 595 },
  { width: 612, height: 792 },
];

describe('Read layouts', () => {
  it('continuous: one page per row', () => {
    expect(computeRows(sizes, 'continuous', 0).map((r) => r.pages)).toEqual([[0], [1], [2]]);
  });

  it('two-up: spreads of two, a lone last page, widths summed and heights maxed', () => {
    const rows = computeRows(sizes, 'two-up', 0);
    expect(rows.map((r) => r.pages)).toEqual([[0, 1], [2]]);
    expect(rows[0]).toMatchObject({ width: 612 + 842, height: 792 });
  });

  it('single: only the current page (clamped)', () => {
    expect(computeRows(sizes, 'single', 1).map((r) => r.pages)).toEqual([[1]]);
    expect(computeRows(sizes, 'single', 9).map((r) => r.pages)).toEqual([[2]]);
    expect(computeRows([], 'single', 0)).toEqual([]);
  });
});

describe('tiling', () => {
  it('turns on only when the page bitmap would exceed the 16 MP cap', () => {
    // Letter at 100% (1.33 CSS px/pt) is small; at 500% with DPR 1 it is ~24 MP.
    expect(needsTiles(1.33, 612, 792)).toBe(false);
    expect(needsTiles(5 * (96 / 72) * 2, 612, 792)).toBe(true);
  });

  it('covers only the visible region with TILE_PX tiles, clipped at the page edge', () => {
    const bucket = 8; // 128 pt tiles
    const edge = TILE_PX / bucket;
    const tiles = tilesFor({ width: 612, height: 792 }, bucket, {
      left: 100,
      top: 300,
      right: 300,
      bottom: 400,
    });
    expect(tiles.map((t) => [t.col, t.row])).toEqual([
      [0, 2],
      [1, 2],
      [2, 2],
      [0, 3],
      [1, 3],
      [2, 3],
    ]);
    const edgeTiles = tilesFor({ width: 612, height: 792 }, bucket, {
      left: 600,
      top: 780,
      right: 900,
      bottom: 900,
    });
    expect(edgeTiles).toEqual([
      {
        col: 4,
        row: 6,
        left: 4 * edge,
        top: 6 * edge,
        width: 612 - 4 * edge,
        height: 792 - 6 * edge,
      },
    ]);
    expect(
      tilesFor({ width: 612, height: 792 }, bucket, { left: 700, top: 0, right: 800, bottom: 10 }),
    ).toEqual([]);
  });
});
