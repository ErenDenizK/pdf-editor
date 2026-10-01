/**
 * `whenPainted` (experience-redesign spec §6.1, §9): resolves in the animation frame after
 * the Read view's canvas reports the page painted at the asked generation or newer, and
 * after a timeout when no canvas reports it.
 */
import type { SourceId } from '@pdf-editor/document-model';
import { afterEach, describe, expect, it } from 'vitest';

import { notePagePainted, resetPaintLedger, whenPainted } from './read-controller';

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
