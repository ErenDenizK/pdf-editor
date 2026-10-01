/**
 * Imperative handle on the mounted Read view, for commands that act on the viewport
 * (PageUp / PageDown / Space). Null while Read mode is not shown.
 *
 * Also the Read view's paint notifications (`whenPainted`): page overlays that show
 * feedback for content the page bitmap will draw (the ink preview) wait for that bitmap.
 */
import type { SourceId } from '@pdf-editor/document-model';

export interface ReadController {
  /** Scrolls about one screen down (+1) or up (-1); in single-page layout, turns pages at the ends. */
  scrollByScreen(direction: 1 | -1): void;
  /** Whether keyboard focus is in or around the pages (not in a panel or control). */
  ownsFocus(): boolean;
}

let current: ReadController | null = null;

export function setReadController(controller: ReadController | null): void {
  current = controller;
}

export function readController(): ReadController | null {
  return current;
}

// ---------------------------------------------------------------------------
// Paint notifications (experience-redesign spec §6.1, §9)
// ---------------------------------------------------------------------------

/**
 * How long `whenPainted` waits for a Read-mode canvas before it gives up and resolves: a
 * page scrolled out of view, unmounted, or shown stretched (a resized page without an
 * exact-scale canvas) never reports a paint, and a preview must not stay forever.
 */
export const PAINT_TIMEOUT_MS = 2000;

interface PaintWaiter {
  readonly generation: number;
  readonly resolve: () => void;
}

/** Newest painted generation per `${source}:${pageIndex}`. */
const painted = new Map<string, number>();
const waiters = new Map<string, Set<PaintWaiter>>();

function paintKey(source: SourceId, pageIndex: number): string {
  return `${source}:${pageIndex}`;
}

/** Runs `callback` in the next animation frame (a timer where frames do not run). */
function nextFrame(callback: () => void): void {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => callback());
  else setTimeout(callback, 16);
}

/**
 * Called by the Read view's page canvas (`PageCanvas` with `exact`) once it has drawn the
 * bitmap of a page at `generation` (the engine service's `pageRevision`) at its final
 * scale. Wakes the `whenPainted` waiters that this generation satisfies.
 */
export function notePagePainted(source: SourceId, pageIndex: number, generation: number): void {
  const key = paintKey(source, pageIndex);
  if ((painted.get(key) ?? -1) < generation) painted.set(key, generation);
  const list = waiters.get(key);
  if (!list) return;
  for (const waiter of [...list]) {
    if (waiter.generation > generation) continue;
    list.delete(waiter);
    waiter.resolve();
  }
  if (list.size === 0) waiters.delete(key);
}

/**
 * Resolves in the first animation frame after the Read view has painted the page bitmap of
 * `generation` or newer (or after `timeoutMs`). The ink preview waits for it so that it is
 * removed in the frame that already shows the committed stroke: removing it earlier makes
 * the stroke vanish for a frame or two while PDFium re-renders the page (the "blink" of the
 * 2026-10 audit, §3 step 4).
 *
 * The bitmap is drawn into the canvas before the frame callback runs, so the frame that
 * runs it presents the new pixels; whatever the caller removes then (or later) is never
 * missing from the screen. Tiles at very high zoom (`TiledPage`) may arrive after the base
 * canvas; the base canvas already shows the stroke, only less sharp.
 */
export function whenPainted(
  source: SourceId,
  pageIndex: number,
  generation: number,
  timeoutMs = PAINT_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolve) => {
    const key = paintKey(source, pageIndex);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      if (timer !== undefined) clearTimeout(timer);
      nextFrame(resolve);
    };
    if ((painted.get(key) ?? -1) >= generation) {
      done();
      return;
    }
    const waiter: PaintWaiter = { generation, resolve: done };
    const list = waiters.get(key) ?? new Set<PaintWaiter>();
    list.add(waiter);
    waiters.set(key, list);
    timer = setTimeout(() => {
      timer = undefined;
      list.delete(waiter);
      if (list.size === 0 && waiters.get(key) === list) waiters.delete(key);
      nextFrame(resolve);
    }, timeoutMs);
  });
}

/** Tests: forget painted generations and pending waiters. */
export function resetPaintLedger(): void {
  painted.clear();
  waiters.clear();
}
