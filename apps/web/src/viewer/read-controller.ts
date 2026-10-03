/**
 * Imperative handle on the mounted Read view, for commands that act on the viewport
 * (PageUp / PageDown / Space). Null while Read mode is not shown.
 *
 * Also the Read view's paint notifications (`whenPainted`): page overlays that show
 * feedback for content the page bitmap will draw (the ink preview) wait for that bitmap.
 * `onPageBitmap` listeners hear, in the task that drew it, every bitmap a Read canvas
 * draws, so the dry ink layer hands over without a frame between (craft spec §5.3 item 7).
 *
 * And the render deferral policy (craft spec §5.3 item 7, research 12 §5):
 * - `deferPageRender`: a page whose fresh ink the dry layer still holds (`setRenderHold`)
 *   re-renders only when its burst closes, or when `requestIdleCallback` (timeout
 *   `IDLE_RENDER_TIMEOUT_MS`) fires with no pointer down, or when `releasePageRenders` is
 *   called (a zoom or scroll moved the page beyond the dry layer, an undo). Never while a
 *   stroke on it is still being committed: the bitmap would show it twice.
 * - `whenPenUp`: thumbnails and neighbouring pages wait while a pen is down (`notePenDown`).
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
  notePageBitmap(source, pageIndex, generation);
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

// ---------------------------------------------------------------------------
// Bitmap notifications (craft spec §5.3 item 7)
// ---------------------------------------------------------------------------

type BitmapListener = (source: SourceId, pageIndex: number, generation: number) => void;
const bitmapListeners = new Set<BitmapListener>();

/**
 * Subscribes to the bitmaps Read canvases draw: called synchronously, in the task that drew
 * the bitmap of `generation` (any scale: a stretched preview of that generation counts), so
 * whatever the listener removes is removed in the same frame. Returns the unsubscriber.
 */
export function onPageBitmap(listener: BitmapListener): () => void {
  bitmapListeners.add(listener);
  return () => {
    bitmapListeners.delete(listener);
  };
}

/**
 * Called by a Read canvas right after it drew a bitmap of `generation` that is not (or not
 * yet) at its final scale; `notePagePainted` covers the final one.
 */
export function notePageBitmap(source: SourceId, pageIndex: number, generation: number): void {
  for (const listener of [...bitmapListeners]) listener(source, pageIndex, generation);
}

// ---------------------------------------------------------------------------
// Pointers and the pen
// ---------------------------------------------------------------------------

/** Pointers down anywhere in the window (`requestIdleCallback` renders wait for none). */
const pointersDown = new Set<number>();
/** The pen stroke in progress: its pointer and page, or null. */
let pen: { readonly pointerId: number; readonly key: string } | null = null;
let penWaiters = new Set<() => void>();

function noop(): void {
  // Nothing to cancel.
}

function pointerReleased(pointerId: number): void {
  pointersDown.delete(pointerId);
  if (pen?.pointerId === pointerId) {
    pen = null;
    const waiting = penWaiters;
    penWaiters = new Set();
    // After the release's own task, so the stroke's commit reaches the engine first.
    if (waiting.size > 0) {
      setTimeout(() => {
        for (const run of waiting) run();
      }, 0);
    }
  }
  if (pointersDown.size === 0) checkHeld();
}

let pointersTracked = false;

function trackPointers(): void {
  if (pointersTracked || typeof window === 'undefined') return;
  pointersTracked = true;
  window.addEventListener('pointerdown', (e) => pointersDown.add(e.pointerId), {
    capture: true,
    passive: true,
  });
  const up = (e: PointerEvent) => pointerReleased(e.pointerId);
  window.addEventListener('pointerup', up, { capture: true, passive: true });
  window.addEventListener('pointercancel', up, { capture: true, passive: true });
  // A pointer released outside the window, or a lost tab: nothing stays down for ever.
  window.addEventListener('blur', () => {
    for (const id of [...pointersDown]) pointerReleased(id);
    if (pen) pointerReleased(pen.pointerId);
  });
}

/**
 * A pen stroke started on page `pageIndex` of `source` (the annotation layer's press, while
 * the pen is armed): until `pointerId` is released, `whenPenUp` holds renders of other pages.
 */
export function notePenDown(source: SourceId, pageIndex: number, pointerId: number): void {
  pointersDown.add(pointerId);
  pen = { pointerId, key: paintKey(source, pageIndex) };
}

/** Whether a pen stroke is in progress (on `source:pageIndex` when given). */
export function penIsDown(source?: SourceId, pageIndex?: number): boolean {
  if (!pen) return false;
  return source === undefined || pen.key === paintKey(source, pageIndex ?? 0);
}

/**
 * Runs `run` now, or once the pen is lifted when a pen stroke is in progress on another page
 * than `source:pageIndex` (thumbnails pass no page: they always wait). Returns the canceller.
 */
export function whenPenUp(run: () => void, source?: SourceId, pageIndex?: number): () => void {
  if (!pen || (source !== undefined && pen.key === paintKey(source, pageIndex ?? 0))) {
    run();
    return noop;
  }
  let cancelled = false;
  const waiter = () => {
    if (!cancelled) run();
  };
  penWaiters.add(waiter);
  return () => {
    cancelled = true;
    penWaiters.delete(waiter);
  };
}

// ---------------------------------------------------------------------------
// Render deferral (craft spec §5.3 item 7)
// ---------------------------------------------------------------------------

/** A deferred re-render waits for idle time at most this long (ms), then runs. */
export const IDLE_RENDER_TIMEOUT_MS = 2000;
/** Without `requestIdleCallback`: a deferred re-render runs after this quiet time (ms). */
export const IDLE_RENDER_FALLBACK_MS = 300;

/** What the dry ink layer tells the policy about a page (`dry-ink.ts` registers it). */
export interface RenderHold {
  /** The page has fresh ink its bitmap does not show yet: its re-render may wait. */
  holds(source: SourceId, pageIndex: number): boolean;
  /** A stroke on it is still being committed: no bitmap may be drawn before it lands. */
  committing(source: SourceId, pageIndex: number): boolean;
  /** A pen burst is open on it (the strokes keep coming). */
  burstOpen(source: SourceId, pageIndex: number): boolean;
}

interface HeldPage {
  readonly source: SourceId;
  readonly pageIndex: number;
  readonly runs: Set<() => void>;
  /** An idle callback fired with no pointer down. */
  due: boolean;
  /** `releasePageRenders`: a zoom, a scroll or another edit; pointers do not matter. */
  forced: boolean;
}

let hold: RenderHold | null = null;
const held = new Map<string, HeldPage>();
let idleHandle: (() => void) | null = null;
let frameHandle: number | null = null;

/** Registers what holds page renders (the dry ink layer); null removes it. */
export function setRenderHold(next: RenderHold | null): void {
  hold = next;
  if (!next) releaseAll();
}

function release(key: string): void {
  const page = held.get(key);
  if (!page) return;
  held.delete(key);
  for (const run of [...page.runs]) run();
}

function releaseAll(): void {
  for (const key of [...held.keys()]) release(key);
}

/** Re-evaluates every held page: runs the renders whose wait is over. */
function checkHeld(): void {
  for (const [key, page] of [...held]) {
    if (!hold?.holds(page.source, page.pageIndex)) {
      release(key);
      continue;
    }
    if (hold.committing(page.source, page.pageIndex)) continue;
    if (page.forced) {
      release(key);
      continue;
    }
    if (pointersDown.size > 0 || pen) continue;
    if (page.due || !hold.burstOpen(page.source, page.pageIndex)) release(key);
  }
  if (held.size === 0) stopWatching();
}

function requestIdle(): void {
  if (idleHandle) return;
  const fire = () => {
    idleHandle = null;
    if (pointersDown.size > 0 || pen) {
      // A pointer is down: the next release asks again.
      if (held.size > 0) watchPointerUp();
      return;
    }
    for (const page of held.values()) page.due = true;
    checkHeld();
  };
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(fire, { timeout: IDLE_RENDER_TIMEOUT_MS });
    idleHandle = () => window.cancelIdleCallback(id);
  } else {
    const id = window.setTimeout(fire, IDLE_RENDER_FALLBACK_MS);
    idleHandle = () => window.clearTimeout(id);
  }
}

let waitingForUp = false;

/** After the pointers are up, idle time is asked for again. */
function watchPointerUp(): void {
  waitingForUp = true;
}

/**
 * Each frame while renders are held: a closed burst, a landed commit or released pointers
 * end the wait without polling the stores from their hot paths.
 */
function watchFrames(): void {
  if (frameHandle !== null || typeof requestAnimationFrame !== 'function') return;
  const tick = () => {
    frameHandle = null;
    if (waitingForUp && pointersDown.size === 0 && !pen) {
      waitingForUp = false;
      requestIdle();
    }
    checkHeld();
    if (held.size > 0) frameHandle = requestAnimationFrame(tick);
  };
  frameHandle = requestAnimationFrame(tick);
}

function stopWatching(): void {
  idleHandle?.();
  idleHandle = null;
  waitingForUp = false;
  if (frameHandle !== null) cancelAnimationFrame(frameHandle);
  frameHandle = null;
}

/**
 * Runs the re-render `run` of page `pageIndex` of `source` (a Read canvas whose page content
 * changed) now, or later by the policy in the module header: after the pen is lifted when a
 * stroke is in progress on another page, and while the dry ink layer holds fresh ink of this
 * page, until its burst closes, idle time comes with no pointer down, or
 * `releasePageRenders`. Returns the canceller.
 */
export function deferPageRender(source: SourceId, pageIndex: number, run: () => void): () => void {
  let cancelled = false;
  let cancelHold: (() => void) | null = null;
  const holdThenRun = () => {
    if (cancelled) return;
    if (!hold?.holds(source, pageIndex)) {
      run();
      return;
    }
    const key = paintKey(source, pageIndex);
    let page = held.get(key);
    if (!page) {
      page = { source, pageIndex, runs: new Set(), due: false, forced: false };
      held.set(key, page);
    }
    const entry = page;
    const once = () => run();
    entry.runs.add(once);
    cancelHold = () => {
      entry.runs.delete(once);
      if (entry.runs.size === 0 && held.get(key) === entry) held.delete(key);
      if (held.size === 0) stopWatching();
    };
    if (pointersDown.size > 0 || pen) watchPointerUp();
    else requestIdle();
    watchFrames();
  };
  const cancelPen = whenPenUp(holdThenRun, source, pageIndex);
  return () => {
    cancelled = true;
    cancelPen();
    cancelHold?.();
  };
}

/**
 * Ends the wait of page `pageIndex` of `source` (all pages without arguments), pointer down
 * or not: a zoom or a scroll moved it beyond the dry layer, or an edit other than a stroke
 * (an undo) changed it. Strokes still being committed keep it waiting until they land.
 */
export function releasePageRenders(source?: SourceId, pageIndex?: number): void {
  for (const [key, page] of held) {
    if (source === undefined || key === paintKey(source, pageIndex ?? 0)) page.forced = true;
  }
  checkHeld();
}

/** Renders held now (tests and diagnostics). */
export function heldPageRenders(): number {
  let count = 0;
  for (const page of held.values()) count += page.runs.size;
  return count;
}

trackPointers();

/** Tests: forget held renders, pointers and the pen. */
export function resetRenderDeferral(): void {
  stopWatching();
  held.clear();
  pointersDown.clear();
  pen = null;
  penWaiters = new Set();
}
