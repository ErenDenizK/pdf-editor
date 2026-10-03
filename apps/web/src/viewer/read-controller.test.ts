/**
 * `whenPainted` (experience-redesign spec §6.1, §9): resolves in the animation frame after
 * the Read view's canvas reports the page painted at the asked generation or newer, and
 * after a timeout when no canvas reports it. The render deferral policy and the bitmap
 * notifications of the dry ink layer (craft spec §5.3 item 7).
 */
import type { SourceId } from '@pdf-editor/document-model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  deferPageRender,
  heldPageRenders,
  notePageBitmap,
  notePagePainted,
  notePenDown,
  onPageBitmap,
  penIsDown,
  releasePageRenders,
  resetPaintLedger,
  resetRenderDeferral,
  setRenderHold,
  whenPainted,
  whenPenUp,
} from './read-controller';

const source = 'src_paint' as SourceId;

function tracked(promise: Promise<void>): { done: () => boolean } {
  let done = false;
  void promise.then(() => {
    done = true;
  });
  return { done: () => done };
}

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('whenPainted', () => {
  afterEach(() => {
    resetPaintLedger();
  });

  it('waits for the asked generation, then resolves in the next animation frame', async () => {
    const wait = tracked(whenPainted(source, 0, 3));
    notePagePainted(source, 0, 2);
    notePagePainted(source, 1, 3);
    await frame();
    await tick();
    expect(wait.done()).toBe(false);

    notePagePainted(source, 0, 3);
    // Not synchronously: the frame that presents the new bitmap runs the callback.
    await Promise.resolve();
    expect(wait.done()).toBe(false);
    await frame();
    await tick();
    expect(wait.done()).toBe(true);
  });

  it('resolves for a generation painted already, or a newer one', async () => {
    notePagePainted(source, 2, 5);
    await whenPainted(source, 2, 4);
    await whenPainted(source, 2, 5);
    const later = tracked(whenPainted(source, 2, 6));
    notePagePainted(source, 2, 8);
    await frame();
    await tick();
    expect(later.done()).toBe(true);
  });

  it('gives up after the timeout when no canvas reports the page', async () => {
    const started = performance.now();
    await whenPainted(source, 4, 1, 50);
    expect(performance.now() - started).toBeGreaterThanOrEqual(45);
  });
});

describe('render deferral (craft spec §5.3 item 7)', () => {
  const state = { holds: true, committing: false, burstOpen: true };
  const idle = () => new Promise<void>((resolve) => requestIdleCallback(() => resolve()));
  const down = (pointerId: number) =>
    window.dispatchEvent(new PointerEvent('pointerdown', { pointerId }));
  const up = (pointerId: number) =>
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId }));

  beforeEach(() => {
    Object.assign(state, { holds: true, committing: false, burstOpen: true });
    setRenderHold({
      holds: () => state.holds,
      committing: () => state.committing,
      burstOpen: () => state.burstOpen,
    });
  });
  afterEach(() => {
    setRenderHold(null);
    resetRenderDeferral();
  });

  it('runs at once when nothing holds the page', () => {
    state.holds = false;
    const run = vi.fn();
    deferPageRender(source, 0, run);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('with a burst open: waits for idle time, never with a pointer down', async () => {
    const run = vi.fn();
    down(1);
    deferPageRender(source, 0, run);
    await idle();
    await frame();
    await frame();
    expect(run).not.toHaveBeenCalled();
    expect(heldPageRenders()).toBe(1);
    up(1);
    // Idle time is asked for again after the release, then the render runs.
    await frame();
    await idle();
    await frame();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a closing burst ends the wait in the next frame, before idle time', async () => {
    const run = vi.fn();
    deferPageRender(source, 0, run);
    expect(run).not.toHaveBeenCalled();
    state.burstOpen = false;
    await frame();
    await frame();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('never while a stroke is being committed, even when released', async () => {
    state.committing = true;
    const run = vi.fn();
    deferPageRender(source, 0, run);
    releasePageRenders(source, 0);
    await idle();
    await frame();
    expect(run).not.toHaveBeenCalled();
    state.committing = false;
    await frame();
    await frame();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a release (zoom, scroll beyond the layer, undo) runs it now, pointer down or not', () => {
    const run = vi.fn();
    const other = vi.fn();
    down(2);
    deferPageRender(source, 0, run);
    deferPageRender(source, 1, other);
    releasePageRenders(source, 0);
    expect(run).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
    releasePageRenders();
    expect(other).toHaveBeenCalledTimes(1);
    up(2);
  });

  it('fresh ink gone (handed over or undone): the next check runs the render', async () => {
    const run = vi.fn();
    down(3);
    deferPageRender(source, 0, run);
    state.holds = false;
    await frame();
    await frame();
    expect(run).toHaveBeenCalledTimes(1);
    up(3);
  });

  it('a pen down on page 0 holds the other pages and thumbnails until it is lifted', async () => {
    notePenDown(source, 0, 9);
    expect(penIsDown()).toBe(true);
    expect(penIsDown(source, 0)).toBe(true);
    expect(penIsDown(source, 1)).toBe(false);
    state.holds = false;
    const own = vi.fn();
    const neighbour = vi.fn();
    const thumbnail = vi.fn();
    const cancelled = vi.fn();
    deferPageRender(source, 0, own);
    deferPageRender(source, 1, neighbour);
    whenPenUp(thumbnail);
    whenPenUp(cancelled)();
    expect(own).toHaveBeenCalledTimes(1);
    expect(neighbour).not.toHaveBeenCalled();
    expect(thumbnail).not.toHaveBeenCalled();
    up(9);
    expect(penIsDown()).toBe(false);
    // After the release's task, so the stroke's commit reaches the engine first.
    expect(thumbnail).not.toHaveBeenCalled();
    await tick();
    expect(neighbour).toHaveBeenCalledTimes(1);
    expect(thumbnail).toHaveBeenCalledTimes(1);
    expect(cancelled).not.toHaveBeenCalled();
  });
});

describe('bitmap notifications', () => {
  it('every Read bitmap reaches the listeners in the drawing task; a final paint too', () => {
    const seen: [number, number][] = [];
    const off = onPageBitmap((_source, pageIndex, generation) =>
      seen.push([pageIndex, generation]),
    );
    notePageBitmap(source, 0, 4);
    notePagePainted(source, 1, 5);
    expect(seen).toEqual([
      [0, 4],
      [1, 5],
    ]);
    off();
    notePageBitmap(source, 0, 6);
    expect(seen).toHaveLength(2);
  });
});
