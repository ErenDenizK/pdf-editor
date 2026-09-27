import { describe, expect, it } from 'vitest';
import {
  canRedo,
  canUndo,
  createHistory,
  currentWorkspace,
  historyEntries,
  jumpTo,
  pushHistory,
  redo,
  undo,
} from '../history';
import { rotatePages } from '../pages';
import type { Workspace } from '../types';
import { expectCode, open, pageIds, must } from './fixtures';

const { ws: w0, docs } = open(['A', 2]);
const a1 = must(pageIds(w0, must(docs[0]))[0]);
const rotate = (ws: Workspace): Workspace => rotatePages(ws, [a1], 90);
const w1 = rotate(w0);
const w2 = rotate(w1);
const w3 = rotate(w2);

describe('history', () => {
  it('undoes and redoes', () => {
    let h = createHistory(w0);
    expect(canUndo(h)).toBe(false);
    h = pushHistory(h, w1, 'Rotate', { now: 1000 });
    h = pushHistory(h, w2, 'Rotate', { now: 2000 });
    expect(currentWorkspace(h)).toBe(w2);
    h = undo(h);
    expect(currentWorkspace(h)).toBe(w1);
    expect(canRedo(h)).toBe(true);
    h = redo(h);
    expect(currentWorkspace(h)).toBe(w2);
    expect(redo(h)).toBe(h);
    expect(undo(undo(undo(h)))).toEqual(undo(undo(h)));
  });

  it('coalesces pushes with the same key inside the window', () => {
    let h = createHistory(w0);
    h = pushHistory(h, w1, 'Drag', { coalesceKey: 'drag', now: 1000 });
    h = pushHistory(h, w2, 'Drag', { coalesceKey: 'drag', now: 1500 });
    h = pushHistory(h, w3, 'Drag', { coalesceKey: 'drag', now: 2200 });
    expect(h.past).toHaveLength(1);
    expect(currentWorkspace(h)).toBe(w3);
    expect(currentWorkspace(undo(h))).toBe(w0);
  });

  it('does not coalesce across keys, outside the window, or with no key', () => {
    let h = createHistory(w0);
    h = pushHistory(h, w1, 'Drag', { coalesceKey: 'drag', now: 1000 });
    h = pushHistory(h, w2, 'Drag', { coalesceKey: 'drag', now: 1801 });
    expect(h.past).toHaveLength(2);
    h = pushHistory(h, w3, 'Color', { coalesceKey: 'color', now: 1802 });
    expect(h.past).toHaveLength(3);
    h = pushHistory(h, w1, 'Plain', { now: 1803 });
    h = pushHistory(h, w2, 'Plain', { now: 1804 });
    expect(h.past).toHaveLength(5);
  });

  it('never coalesces into an entry reached by undo', () => {
    let h = createHistory(w0);
    h = pushHistory(h, w1, 'Drag', { coalesceKey: 'drag', now: 1000 });
    h = pushHistory(h, w2, 'Other', { now: 1100 });
    h = undo(h);
    h = pushHistory(h, w3, 'Drag', { coalesceKey: 'drag', now: 1200 });
    expect(historyEntries(h).map((e) => e.label)).toEqual(['Open', 'Drag', 'Drag']);
  });

  it('invalidates redo on a new push', () => {
    let h = createHistory(w0);
    h = pushHistory(h, w1, 'One', { now: 1 });
    h = pushHistory(h, w2, 'Two', { now: 2 });
    h = undo(h);
    h = pushHistory(h, w3, 'Three', { now: 3 });
    expect(canRedo(h)).toBe(false);
    expect(historyEntries(h).map((e) => e.label)).toEqual(['Open', 'One', 'Three']);
  });

  it('ignores pushes of the present workspace', () => {
    const h = createHistory(w0);
    expect(pushHistory(h, w0, 'Nothing')).toBe(h);
  });

  it('caps the number of undo steps', () => {
    let h = createHistory(w0);
    let ws = w0;
    for (let i = 0; i < 10; i++) {
      ws = rotate(ws);
      h = pushHistory(h, ws, `Step ${i}`, { now: i, limit: 3 });
    }
    expect(h.past.map((e) => e.label)).toEqual(['Step 6', 'Step 7', 'Step 8']);
    expectCode(() => pushHistory(h, w0, 'x', { limit: -1 }), 'invalid-argument');
  });

  it('lists entries and jumps to any of them', () => {
    let h = createHistory(w0, 'Open', 0);
    h = pushHistory(h, w1, 'One', { now: 1 });
    h = pushHistory(h, w2, 'Two', { now: 2 });
    h = pushHistory(h, w3, 'Three', { now: 3 });
    h = jumpTo(h, 1);
    expect(historyEntries(h)).toEqual([
      { index: 0, label: 'Open', at: 0, state: 'past' },
      { index: 1, label: 'One', at: 1, state: 'present' },
      { index: 2, label: 'Two', at: 2, state: 'future' },
      { index: 3, label: 'Three', at: 3, state: 'future' },
    ]);
    expect(currentWorkspace(jumpTo(h, 3))).toBe(w3);
    expect(jumpTo(h, 1)).toBe(h);
    expectCode(() => jumpTo(h, 4), 'invalid-index');
    expectCode(() => jumpTo(h, -1), 'invalid-index');
  });
});
