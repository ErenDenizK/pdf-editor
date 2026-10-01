/** The split rule of lasso edits (experience-redesign spec §6.5), pure. */
import type { InkAnnotation } from '@pdf-editor/engine';
import { describe, expect, it } from 'vitest';

import {
  alignedWidths,
  inkWithPaths,
  restyleInk,
  splitInk,
  splitPlan,
  translateInk,
} from './split';

const P = (x: number, y: number) => ({ x, y });

/** Three strokes; widths 1, 2, 3 pt per stroke so each path is recognisable by its widths. */
function burst(extra: Partial<InkAnnotation> = {}): InkAnnotation {
  return {
    id: 'ink-1',
    kind: 'ink',
    pageIndex: 0,
    rect: { x: 0, y: 0, width: 100, height: 100 },
    color: '#1F1F1F',
    opacity: 0.8,
    author: 'Ada',
    contents: 'a comment',
    modified: '2026-10-01T00:00:00.000Z',
    strokeWidth: 2,
    paths: [
      [P(10, 10), P(20, 10)],
      [P(30, 10), P(40, 12), P(50, 10)],
      [P(60, 10), P(70, 10)],
    ],
    widths: [
      [1, 1],
      [2, 2, 2],
      [3, 3],
    ],
    ...extra,
  };
}

describe('splitPlan', () => {
  it('sorts, dedupes and bounds the taken indices; the rest keeps its order', () => {
    expect(splitPlan(4, [2, 0, 2, 9, -1])).toEqual({ taken: [0, 2], rest: [1, 3], whole: false });
    expect(splitPlan(2, [1, 0])).toEqual({ taken: [0, 1], rest: [], whole: true });
    expect(splitPlan(2, [])).toEqual({ taken: [], rest: [0, 1], whole: false });
  });
});

describe('widths stay parallel to paths', () => {
  it('keeps each path with its own widths', () => {
    const only = inkWithPaths(burst(), [0, 2]);
    expect(only.paths).toEqual([
      [P(10, 10), P(20, 10)],
      [P(60, 10), P(70, 10)],
    ]);
    expect(only.widths).toEqual([
      [1, 1],
      [3, 3],
    ]);
    // The rect follows the paths, grown by half the widest width plus 1.
    expect(only.rect).toEqual({ x: 7.5, y: 7.5, width: 65, height: 5 });
  });

  it('drops widths that do not match the paths (written elsewhere)', () => {
    const odd = burst({ widths: [[1, 1], [2]] });
    expect(alignedWidths(odd)).toBeUndefined();
    expect(inkWithPaths(odd, [1]).widths).toBeUndefined();
    expect(
      alignedWidths(
        burst({
          widths: [
            [1, 1],
            [2, 2],
            [3, 3],
          ],
        }),
      ),
    ).toBeUndefined();
  });
});

describe('splitInk', () => {
  it('recolouring some paths splits: the rest keeps the id and comment, the taken get a new id', () => {
    const out = splitInk(burst(), [1], { kind: 'style', patch: { color: '#e53935' } }, 'new');
    expect(out.remove).toBe(false);
    expect(out.count).toBe(1);
    expect(out.update?.id).toBe('ink-1');
    expect(out.update?.color).toBe('#1F1F1F');
    expect(out.update?.contents).toBe('a comment');
    expect(out.update?.paths).toHaveLength(2);
    expect(out.update?.widths).toEqual([
      [1, 1],
      [3, 3],
    ]);
    const created = out.create;
    expect(created?.id).toBe('new');
    expect(created?.color).toBe('#E53935');
    expect(created?.author).toBe('Ada');
    expect(created?.opacity).toBe(0.8);
    expect(created?.contents).toBeUndefined();
    expect(created?.paths).toEqual([[P(30, 10), P(40, 12), P(50, 10)]]);
    expect(created?.widths).toEqual([[2, 2, 2]]);
    expect(out.picks).toEqual({ new: [0] });
  });

  it('recolouring every path edits the ink in place', () => {
    const out = splitInk(burst(), [2, 1, 0], { kind: 'style', patch: { color: '#e53935' } }, 'new');
    expect(out.create).toBeUndefined();
    expect(out.update?.id).toBe('ink-1');
    expect(out.update?.color).toBe('#E53935');
    expect(out.update?.paths).toHaveLength(3);
    expect(out.picks).toEqual({ 'ink-1': [0, 1, 2] });
  });

  it('deleting some paths removes them from the ink; deleting all removes the ink', () => {
    const some = splitInk(burst(), [0], { kind: 'delete' }, 'new');
    expect(some.create).toBeUndefined();
    expect(some.remove).toBe(false);
    expect(some.update?.paths).toHaveLength(2);
    expect(some.update?.widths).toEqual([
      [2, 2, 2],
      [3, 3],
    ]);
    expect(some.picks).toEqual({});
    const all = splitInk(burst(), [0, 1, 2], { kind: 'delete' }, 'new');
    expect(all).toEqual({ remove: true, picks: {}, count: 3 });
  });

  it('moving some paths translates their points only; widths unchanged', () => {
    const out = splitInk(burst(), [0, 2], { kind: 'move', dx: 5, dy: -3 }, 'new');
    expect(out.update?.paths).toEqual([[P(30, 10), P(40, 12), P(50, 10)]]);
    expect(out.create?.paths).toEqual([
      [P(15, 7), P(25, 7)],
      [P(65, 7), P(75, 7)],
    ]);
    expect(out.create?.widths).toEqual([
      [1, 1],
      [3, 3],
    ]);
    expect(out.create?.rect).toEqual({ x: 12.5, y: 4.5, width: 65, height: 5 });
    expect(out.picks).toEqual({ new: [0, 1] });
  });

  it('takes nothing for indices out of range', () => {
    expect(splitInk(burst(), [7], { kind: 'delete' }, 'new')).toEqual({
      remove: false,
      picks: {},
      count: 0,
    });
  });
});

describe('restyle and move of a whole ink', () => {
  it('a width change scales the per-point widths with the nominal width', () => {
    const next = restyleInk(burst(), { strokeWidth: 4 });
    expect(next.strokeWidth).toBe(4);
    expect(next.widths).toEqual([
      [2, 2],
      [4, 4, 4],
      [6, 6],
    ]);
    expect(restyleInk(burst(), { opacity: 0.333 }).opacity).toBe(0.33);
  });

  it('a move keeps the widths and moves the rect', () => {
    const moved = translateInk(burst(), 1, 1);
    expect(moved.widths).toEqual(burst().widths);
    expect(moved.paths[0]).toEqual([P(11, 11), P(21, 11)]);
  });
});
