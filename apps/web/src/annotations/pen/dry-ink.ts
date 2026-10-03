/**
 * The dry ink layer (craft spec §5.3 item 7, research 12 §5): committed pen strokes drawn by
 * us until the page bitmap shows them, so a stroke is on screen in the frame after
 * pointer-up and PDFium re-renders the page only when the writing pauses.
 *
 * - **Strokes.** At release the pen's live preview hands its committed shape (the centre
 *   line and widths the engine writes, `SettleInk`'s `final`) to `drySettle`, which keeps it
 *   in user space with its colour, opacity and blend and draws it, in the same task, into
 *   the page's dry canvases (`DryInkView`, mounted by `DryInkLayer.tsx` between the page
 *   bitmap and the annotation layer's wet canvas). The outline is the preview's and the
 *   engine's (`inkOutlineOps`), so nothing moves. The live canvas is cleared in that task.
 * - **Revision.** Once the commit lands, `inkCommitted` tags the stroke with the page's
 *   revision (`EngineService.pageRevision`), the first that contains it. When a Read canvas
 *   draws a bitmap of revision *r* (`onPageBitmap`, in the task that drew it), the strokes
 *   tagged ≤ *r* are removed and the dry canvases redrawn in that same task: there is no
 *   frame where the stroke is missing or drawn twice. A stroke whose commit fails is dropped
 *   at once.
 * - **Deferral.** The page's re-render waits while it holds strokes (the policy is
 *   `deferPageRender` in viewer/read-controller.ts; this module tells it what it holds,
 *   which strokes are still being committed and whether a burst is open). A zoom or a
 *   scroll that moves the page beyond the dry canvases redraws them for the new view and
 *   ends the wait.
 * - **Groups.** Strokes are grouped by opacity and blend, one canvas per group: each stroke
 *   is filled opaque and the canvas carries the CSS opacity (as the preview does), and the
 *   free Highlighter's strokes sit on a canvas that blends with Multiply. The layer is not a
 *   stacking context, so that blend reaches the page bitmap below.
 * - **Edits.** An undo, the eraser or a lasso edit that removes or moves a stroke still held
 *   here drops it as soon as the annotation store no longer has its path (after having had
 *   it), and the page re-renders through the normal path at once. After any history move
 *   other than a stroke, the page's next revision (that edit landing in the engine)
 *   re-renders at once instead of waiting, and its bitmap takes every older stroke over. A
 *   page resize, rotation or zoom redraws from the kept user-space geometry.
 * - **Pen down.** A press on an armed pen layer is reported to the policy (`notePenDown`),
 *   so thumbnails and neighbouring pages wait until the pen is lifted.
 */
import type { SourceId } from '@pdf-editor/document-model';
import type { Annotation } from '@pdf-editor/engine';
import { inkOutlineOps } from '@pdf-editor/engine/ink-outline';

import { getEngineService } from '../../engine/engine-service';
import { useWorkspaceStore } from '../../state/workspace-store';
import {
  notePenDown,
  onPageBitmap,
  releasePageRenders,
  setRenderHold,
  whenPainted,
} from '../../viewer/read-controller';
import { pageKey, useAnnotationStore } from '../annotation-store';
import { cssPointToUser, type PageFrame, userToCss } from '../geometry';
import type { Point } from '../ink';
import { mountedLayers } from '../layer-registry';
import { currentBurst } from './bursts';
import { penSession, type SettleInk } from './ink-input';
import { type InkPreview, outlinePath } from './ink-preview';
import { inkStats, type InkStrokeStats } from './ink-stats';

/** How a dry stroke composites: as ink, or with Multiply (the free Highlighter). */
export type DryBlend = 'normal' | 'multiply';

/** A committed stroke as the dry layer keeps it. */
export interface DryStrokeInit {
  readonly source: SourceId;
  readonly pageIndex: number;
  /** User-space centre line, as committed. */
  readonly points: readonly Point[];
  /** Full width at each point, points. */
  readonly widths: readonly number[];
  /** `#rrggbb`. */
  readonly color: string;
  readonly opacity: number;
  readonly blend: DryBlend;
}

/**
 * Margin (CSS px) kept around the visible part of the page on the dry canvases, so a small
 * scroll needs no redraw.
 */
export const DRY_MARGIN_PX = 128;
/**
 * A stroke whose commit has not landed after this long (ms) no longer holds the page's
 * re-render back (an engine that never answers must not freeze the page).
 */
export const DRY_COMMIT_WAIT_MS = 5000;
/** Two committed points closer than this (points) are the same (float32 read-back). */
const SAME_POINT_PT = 0.02;

let serial = 0;

export class DryStroke {
  /** The first page revision that contains the stroke; null while its commit runs. */
  revision: number | null = null;
  /** The annotation store has shown the stroke's path (so its absence means an edit). */
  seen = false;
  /** Removed from the layer. */
  gone = false;
  readonly heldAt = performance.now();
  readonly id = ++serial;

  constructor(
    readonly key: string,
    readonly init: DryStrokeInit,
    readonly stats: InkStrokeStats | null,
  ) {}

  /** Strokes of one group share a canvas. */
  get group(): string {
    return `${this.init.blend}:${this.init.opacity}`;
  }
}

/** Strokes held per source page (`source:pageIndex`), oldest first. */
const pages = new Map<string, DryStroke[]>();
/** Mounted views per source page (a source page shown twice has two). */
const views = new Map<string, Set<DryInkView>>();
/** The newest bitmap revision a Read canvas drew per source page. */
const shown = new Map<string, number>();
/**
 * Pages whose next revision is an edit other than a stroke (an undo, the eraser, a lasso
 * edit): the revision at that history move. A newer revision re-renders without waiting.
 */
const flushAfter = new Map<string, number>();
/** `SettleInk` release functions of dry strokes, for `inkCommitted`. */
const handles = new WeakMap<() => void, DryStroke>();

/** Runs `callback` in the next animation frame (a timer where frames do not run). */
function nextFrame(callback: () => void): void {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => callback());
  else setTimeout(callback, 16);
}

/** The strokes the dry layer holds for page `pageIndex` of `source` (tests, the views). */
export function dryStrokes(source: SourceId, pageIndex: number): readonly DryStroke[] {
  return pages.get(pageKey(source, pageIndex)) ?? [];
}

/** Whether a dry layer is mounted for page `pageIndex` of `source`. */
export function hasDryView(source: SourceId, pageIndex: number): boolean {
  return (views.get(pageKey(source, pageIndex))?.size ?? 0) > 0;
}

function redrawViews(key: string): void {
  for (const view of views.get(key) ?? []) view.redraw();
}

/** Adds a committed stroke to the layer and draws it in this task. */
export function holdDryStroke(init: DryStrokeInit, stats: InkStrokeStats | null = null): DryStroke {
  const key = pageKey(init.source, init.pageIndex);
  const stroke = new DryStroke(key, init, stats);
  const list = pages.get(key) ?? [];
  list.push(stroke);
  pages.set(key, list);
  for (const view of views.get(key) ?? []) view.add(stroke);
  const collector = inkStats();
  if (collector && stats) {
    collector.heldDry(stats);
    // The frame that presents the draw.
    nextFrame(() => collector.visible(stats));
  }
  return stroke;
}

/** Removes strokes of one page and redraws its views; `settled` reports the hand-over. */
function remove(key: string, strokes: readonly DryStroke[]): void {
  if (strokes.length === 0) return;
  for (const stroke of strokes) stroke.gone = true;
  const left = (pages.get(key) ?? []).filter((s) => !s.gone);
  if (left.length > 0) pages.set(key, left);
  else {
    pages.delete(key);
    flushAfter.delete(key);
  }
  redrawViews(key);
  const collector = inkStats();
  if (!collector) return;
  const records = strokes.flatMap((s) => (s.stats ? [s.stats] : []));
  if (records.length > 0) nextFrame(() => records.forEach((r) => collector.settled(r)));
}

/** Drops a stroke now (its commit failed, or it was undone). */
export function dropDryStroke(stroke: DryStroke): void {
  if (!stroke.gone) remove(stroke.key, [stroke]);
}

/**
 * The stroke's commit landed: page revision `revision` is the first that contains it. When
 * a bitmap of that revision is already on screen, the stroke goes at once.
 */
export function commitDryStroke(stroke: DryStroke, revision: number): void {
  if (stroke.gone || stroke.revision !== null) return;
  stroke.revision = revision;
  if ((shown.get(stroke.key) ?? -1) >= revision) {
    remove(stroke.key, [stroke]);
    return;
  }
  const entry = useAnnotationStore.getState().pages[stroke.key];
  if (entry) reconcile(stroke.key, entry.annotations);
}

/**
 * A Read canvas drew the bitmap of `generation` for the page (viewer/read-controller.ts
 * `onPageBitmap`, in the task that drew it): the strokes it contains leave the layer now.
 */
export function handOverDryInk(source: SourceId, pageIndex: number, generation: number): void {
  const key = pageKey(source, pageIndex);
  if ((shown.get(key) ?? -1) < generation) shown.set(key, generation);
  if ((flushAfter.get(key) ?? Number.POSITIVE_INFINITY) < generation) flushAfter.delete(key);
  const list = pages.get(key);
  if (!list) return;
  remove(
    key,
    list.filter((s) => s.revision !== null && s.revision <= generation),
  );
}

/**
 * Wraps the pen's `SettleInk` for the page of `target` (shown through `frame`, drawn in
 * `style`'s colour and opacity): the finished stroke goes to the dry layer when one is
 * mounted for the page and the committed shape is given, else to the preview's own settling
 * canvas. The returned release drops a dry stroke whose commit did not land (`inkCommitted`
 * was not called); after the commit it does nothing (the page bitmap takes the stroke
 * over). `preview.multiply` tells a live free Highlighter stroke (`HighlighterPreview`):
 * opaque, with Multiply.
 */
export function drySettle(
  settle: SettleInk,
  preview: InkPreview & { readonly multiply?: boolean },
  target: { readonly source: SourceId; readonly pageIndex: number },
  frame: PageFrame,
  style: () => { readonly color: string; readonly opacity: number },
): SettleInk {
  return (final) => {
    if (!final || final.length === 0 || !hasDryView(target.source, target.pageIndex)) {
      return settle(final);
    }
    const highlighter = preview.multiply === true;
    const { color, opacity } = style();
    const points: Point[] = [];
    const widths: number[] = [];
    for (let i = 0; i < final.length; i++) {
      points.push(cssPointToUser(frame, { x: final.x(i), y: final.y(i) }));
      widths.push(final.w(i) / frame.scale);
    }
    // Taken here, so the pipeline's "not settled" path does not count the stroke cancelled.
    const stats = inkStats()?.takeEnded() ?? null;
    const stroke = holdDryStroke(
      {
        source: target.source,
        pageIndex: target.pageIndex,
        points,
        widths,
        color,
        opacity: highlighter ? 1 : opacity,
        blend: highlighter ? 'multiply' : 'normal',
      },
      stats,
    );
    // Same task as the dry draw: the live stroke and the Highlighter's layer blend end.
    preview.cancel();
    const release = () => {
      if (stroke.revision === null) dropDryStroke(stroke);
    };
    handles.set(release, stroke);
    return release;
  };
}

/**
 * The stroke settled with `release` (from a `SettleInk`) was committed to page `pageIndex`
 * of `source`: a dry stroke is tagged with the page's revision now, and the page bitmap
 * takes it over; a settling preview waits for that bitmap (`whenPainted`). Call it as soon
 * as the commit resolves, then `release()` as before.
 */
export function inkCommitted(
  release: () => void,
  source: SourceId,
  pageIndex: number,
): Promise<void> {
  const generation = getEngineService().pageRevision(source, pageIndex);
  const stroke = handles.get(release);
  if (!stroke) return whenPainted(source, pageIndex, generation);
  commitDryStroke(stroke, generation);
  return Promise.resolve();
}

// ---------------------------------------------------------------------------
// Edits: undo, eraser, lasso (the annotation store and the history)
// ---------------------------------------------------------------------------

function samePath(a: readonly Point[], b: readonly Point[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const p = a[i];
    const q = b[i];
    if (!p || !q) return false;
    if (Math.abs(p.x - q.x) > SAME_POINT_PT || Math.abs(p.y - q.y) > SAME_POINT_PT) return false;
  }
  return true;
}

/**
 * Compares the committed strokes of a page with its annotations: a stroke whose path the
 * store had and no longer has was undone, erased or moved, so it leaves the layer now and
 * the page re-renders.
 */
function reconcile(key: string, annotations: readonly Annotation[]): void {
  const list = pages.get(key);
  if (!list) return;
  const paths: (readonly Point[])[] = [];
  for (const a of annotations) if (a.kind === 'ink') paths.push(...a.paths);
  const gone: DryStroke[] = [];
  for (const stroke of list) {
    if (stroke.revision === null) continue;
    if (paths.some((p) => samePath(p, stroke.init.points))) stroke.seen = true;
    else if (stroke.seen) gone.push(stroke);
  }
  const first = gone[0];
  if (!first) return;
  remove(key, gone);
  releasePageRenders(first.init.source, first.init.pageIndex);
}

let installed = false;

/** Installs the hand-over, the render hold and the edit rules once (on import). */
export function installDryInk(): void {
  if (installed) return;
  installed = true;
  onPageBitmap(handOverDryInk);
  setRenderHold({
    holds: (source, pageIndex) => {
      const key = pageKey(source, pageIndex);
      if ((pages.get(key)?.length ?? 0) === 0) return false;
      const flush = flushAfter.get(key);
      return flush === undefined || getEngineService().pageRevision(source, pageIndex) <= flush;
    },
    committing: (source, pageIndex) => {
      const now = performance.now();
      return (pages.get(pageKey(source, pageIndex)) ?? []).some(
        (s) => s.revision === null && now - s.heldAt < DRY_COMMIT_WAIT_MS,
      );
    },
    burstOpen: (source, pageIndex) => {
      const burst = currentBurst();
      return burst?.target.source === source && burst.target.pageIndex === pageIndex;
    },
  });
  useAnnotationStore.subscribe((state, previous) => {
    if (pages.size === 0 || state.pages === previous.pages) return;
    for (const key of [...pages.keys()]) {
      const entry = state.pages[key];
      if (entry && entry !== previous.pages[key]) reconcile(key, entry.annotations);
    }
  });
  useWorkspaceStore.subscribe((state, previous) => {
    if (pages.size === 0 || state.history === previous.history) return;
    const now = state.history;
    const before = previous.history;
    // A stroke joins or starts a burst entry; anything else (undo, redo, another edit)
    // re-renders the pages through the normal path as soon as it reaches the engine (an
    // undo reaches it after the history moved, an edit just before its pages change).
    const stroke =
      now.future.length === 0 &&
      before.future.length === 0 &&
      (now.present.coalesceKey?.startsWith('ink-burst:') ?? false);
    if (stroke) return;
    const service = getEngineService();
    for (const [key, list] of pages) {
      const first = list[0];
      if (first) flushAfter.set(key, service.pageRevision(first.init.source, first.init.pageIndex));
    }
  });
  getEngineService().onSourceClosed((source) => {
    for (const key of [...pages.keys()]) {
      const list = pages.get(key) ?? [];
      if (list[0]?.init.source === source) remove(key, list);
    }
    for (const key of [...shown.keys()]) if (key.startsWith(`${source}:`)) shown.delete(key);
  });
  if (typeof window !== 'undefined') {
    // A press on an armed pen layer: thumbnails and other pages wait for the pen.
    window.addEventListener(
      'pointerdown',
      (event) => {
        if (event.button !== 0) return;
        if (event.pointerType === 'touch' && penSession().penSeen) return;
        const element =
          event.target instanceof Element ? event.target.closest('[data-annotation-layer]') : null;
        if (!element) return;
        // The armed pen, or a pen drawing in Select.
        const armed = element.matches('[data-tool="ink"][data-drawing]');
        if (!armed && event.pointerType !== 'pen') return;
        for (const layer of mountedLayers.values()) {
          if (layer.element !== element) continue;
          notePenDown(layer.target.source, layer.target.pageIndex, event.pointerId);
          return;
        }
      },
      { capture: true, passive: true },
    );
  }
}

/** Tests: forget every stroke and bitmap revision (views stay mounted, emptied). */
export function resetDryInk(): void {
  const keys = [...pages.keys()];
  pages.clear();
  shown.clear();
  flushAfter.clear();
  for (const key of keys) redrawViews(key);
}

// ---------------------------------------------------------------------------
// The view: one page's dry canvases
// ---------------------------------------------------------------------------

/** A box in CSS pixels of the page sheet. */
interface CssBox {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

interface GroupCanvas {
  readonly canvas: HTMLCanvasElement;
  readonly context: CanvasRenderingContext2D | null;
}

function sameFrame(a: PageFrame, b: PageFrame): boolean {
  return (
    a.scale === b.scale &&
    a.rotation === b.rotation &&
    a.originX === b.originX &&
    a.originY === b.originY &&
    a.size.width === b.size.width &&
    a.size.height === b.size.height &&
    (a.stretchY ?? 1) === (b.stretchY ?? 1) &&
    (a.intrinsicRotation ?? 0) === (b.intrinsicRotation ?? 0)
  );
}

function within(inner: CssBox, outer: CssBox): boolean {
  return (
    inner.left >= outer.left - 0.5 &&
    inner.top >= outer.top - 0.5 &&
    inner.right <= outer.right + 0.5 &&
    inner.bottom <= outer.bottom + 0.5
  );
}

/**
 * The dry canvases of one page sheet: they cover the visible part of the page (plus
 * `DRY_MARGIN_PX`) in whole device pixels, like the live preview, and exist only while the
 * page holds strokes. Framework-free; `DryInkLayer.tsx` mounts it.
 */
export class DryInkView {
  private readonly key: string;
  private frame: PageFrame;
  private readonly groups = new Map<string, GroupCanvas>();
  /** Each stroke's outline in device pixels of the canvases, for the current placement. */
  private readonly outlines = new Map<DryStroke, Path2D>();
  /** What the canvases cover (CSS px of the sheet) and their device origin; null: nothing. */
  private covered: CssBox | null = null;
  private originX = 0;
  private originY = 0;
  private dpr = 1;
  private readonly scroller: HTMLElement | null;
  private readonly onScroll = () => this.checkCoverage();

  constructor(
    readonly element: HTMLElement,
    readonly source: SourceId,
    readonly pageIndex: number,
    frame: PageFrame,
  ) {
    this.key = pageKey(source, pageIndex);
    this.frame = frame;
    this.scroller = element.closest<HTMLElement>('[data-read-viewport]');
    const set = views.get(this.key) ?? new Set<DryInkView>();
    set.add(this);
    views.set(this.key, set);
    (this.scroller ?? window).addEventListener('scroll', this.onScroll, { passive: true });
    window.addEventListener('resize', this.onScroll, { passive: true });
    this.redraw(true);
  }

  /** The canvases (tests). */
  get canvases(): HTMLCanvasElement[] {
    return [...this.groups.values()].map((g) => g.canvas);
  }

  /**
   * The page's frame changed (zoom, rotation, a page resize): the strokes are drawn again
   * from their user-space geometry, and the page may re-render now.
   */
  setFrame(frame: PageFrame): void {
    if (sameFrame(frame, this.frame)) return;
    this.frame = frame;
    if (!this.strokes().length) return;
    this.redraw(true);
    releasePageRenders(this.source, this.pageIndex);
  }

  /** Draws one more stroke on top (the canvases are placed on the first). */
  add(stroke: DryStroke): void {
    if (!this.covered) {
      this.redraw(true);
      return;
    }
    this.fill(stroke);
    this.mark();
  }

  /** Draws the held strokes again; `recover` re-places the canvases on the visible part. */
  redraw(recover = false): void {
    const strokes = this.strokes();
    if (strokes.length === 0) {
      this.free();
      this.mark();
      return;
    }
    if (recover || !this.covered) {
      if (!this.place()) {
        this.mark();
        return;
      }
    }
    for (const group of this.groups.values()) {
      group.context?.clearRect(0, 0, group.canvas.width, group.canvas.height);
    }
    for (const stroke of strokes) this.fill(stroke);
    for (const stroke of [...this.outlines.keys()]) {
      if (stroke.gone) this.outlines.delete(stroke);
    }
    this.mark();
  }

  destroy(): void {
    const set = views.get(this.key);
    set?.delete(this);
    if (set?.size === 0) views.delete(this.key);
    (this.scroller ?? window).removeEventListener('scroll', this.onScroll);
    window.removeEventListener('resize', this.onScroll);
    for (const group of this.groups.values()) group.canvas.remove();
    this.groups.clear();
    this.outlines.clear();
    this.covered = null;
  }

  private strokes(): readonly DryStroke[] {
    return pages.get(this.key) ?? [];
  }

  /** The visible part of the sheet (CSS px), grown by `margin`; null when off screen. */
  private visible(margin: number): CssBox | null {
    const rect = this.element.getBoundingClientRect();
    const port = this.scroller?.getBoundingClientRect();
    const viewLeft = port?.left ?? 0;
    const viewTop = port?.top ?? 0;
    const viewRight = port?.right ?? (document.documentElement.clientWidth || window.innerWidth);
    const viewBottom =
      port?.bottom ?? (document.documentElement.clientHeight || window.innerHeight);
    const box = {
      left: Math.max(0, viewLeft - rect.left - margin),
      top: Math.max(0, viewTop - rect.top - margin),
      right: Math.min(rect.width, viewRight - rect.left + margin),
      bottom: Math.min(rect.height, viewBottom - rect.top + margin),
    };
    return box.right > box.left && box.bottom > box.top ? box : null;
  }

  /** A scroll or a window resize: beyond the canvases, they move and the page re-renders. */
  private checkCoverage(): void {
    if (this.strokes().length === 0) return;
    const now = this.visible(0);
    if (!now || (this.covered && within(now, this.covered))) return;
    this.redraw(true);
    releasePageRenders(this.source, this.pageIndex);
  }

  /** Sizes and places the canvases on the visible part; false when the page is off screen. */
  private place(): boolean {
    this.outlines.clear();
    const box = this.visible(DRY_MARGIN_PX);
    if (!box) {
      this.free();
      return false;
    }
    const dpr = window.devicePixelRatio || 1;
    const x1 = Math.floor(box.left * dpr);
    const y1 = Math.floor(box.top * dpr);
    const width = Math.max(1, Math.ceil(box.right * dpr) - x1);
    const height = Math.max(1, Math.ceil(box.bottom * dpr) - y1);
    this.dpr = dpr;
    this.originX = x1;
    this.originY = y1;
    this.covered = {
      left: x1 / dpr,
      top: y1 / dpr,
      right: (x1 + width) / dpr,
      bottom: (y1 + height) / dpr,
    };
    for (const group of this.groups.values()) this.size(group.canvas, width, height);
    return true;
  }

  private size(canvas: HTMLCanvasElement, width: number, height: number): void {
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const s = canvas.style;
    s.left = `${this.originX / this.dpr}px`;
    s.top = `${this.originY / this.dpr}px`;
    s.width = `${width / this.dpr}px`;
    s.height = `${height / this.dpr}px`;
    canvas.dataset.originX = String(this.originX);
    canvas.dataset.originY = String(this.originY);
  }

  /** Releases the canvases' memory while the page holds nothing. */
  private free(): void {
    for (const group of this.groups.values()) {
      group.canvas.width = 0;
      group.canvas.height = 0;
    }
    this.outlines.clear();
    this.covered = null;
  }

  private groupOf(stroke: DryStroke): GroupCanvas | null {
    const covered = this.covered;
    if (!covered) return null;
    let group = this.groups.get(stroke.group);
    if (!group) {
      const canvas = document.createElement('canvas');
      canvas.setAttribute('data-dry-ink-group', stroke.group);
      canvas.setAttribute('aria-hidden', 'true');
      const s = canvas.style;
      s.position = 'absolute';
      s.pointerEvents = 'none';
      // Opaque fills, the group's opacity on the canvas (as the live preview).
      if (stroke.init.opacity < 1) s.opacity = String(stroke.init.opacity);
      if (stroke.init.blend === 'multiply') s.mixBlendMode = 'multiply';
      this.element.appendChild(canvas);
      group = { canvas, context: canvas.getContext('2d') };
      this.groups.set(stroke.group, group);
      this.size(
        canvas,
        Math.round((covered.right - covered.left) * this.dpr),
        Math.round((covered.bottom - covered.top) * this.dpr),
      );
    }
    return group;
  }

  private fill(stroke: DryStroke): void {
    const group = this.groupOf(stroke);
    const context = group?.context;
    if (!context) return;
    let outline = this.outlines.get(stroke);
    if (!outline) {
      const { points, widths } = stroke.init;
      const scale = this.frame.scale * this.dpr;
      const device = points.map((p) => {
        const css = userToCss(this.frame, p);
        return { x: css.x * this.dpr - this.originX, y: css.y * this.dpr - this.originY };
      });
      outline = outlinePath(
        inkOutlineOps(
          device,
          widths.map((w) => w * scale),
        ),
      );
      this.outlines.set(stroke, outline);
    }
    context.fillStyle = stroke.init.color;
    context.fill(outline);
  }

  /** `data-strokes` on the layer: how many strokes it shows (tests, e2e). */
  private mark(): void {
    this.element.dataset.strokes = String(this.covered ? this.strokes().length : 0);
  }
}

installDryInk();
