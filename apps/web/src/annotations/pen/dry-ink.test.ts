/**
 * The dry ink layer (craft spec §5.3 item 7): strokes drawn in the task that holds them, in
 * the committed geometry and colour, grouped by opacity and blend; the hand-over when a
 * bitmap of the stroke's revision is drawn (same task); the render deferral it drives
 * (`deferPageRender`, `whenPenUp`); and consistency through undo, eraser and lasso edits,
 * zoom and page resize, and scrolls beyond the layer.
 */
import type { SourceId } from '@pdf-editor/document-model';
import type { InkAnnotation } from '@pdf-editor/engine';
import { inkOutlineOps } from '@pdf-editor/engine/ink-outline';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getEngineService } from '../../engine/engine-service';
import { resetWorkspace, useWorkspaceStore } from '../../state/workspace-store';
import {
  deferPageRender,
  heldPageRenders,
  notePageBitmap,
  notePagePainted,
  notePenDown,
  resetPaintLedger,
  resetRenderDeferral,
  whenPenUp,
} from '../../viewer/read-controller';
import { pageKey, resetAnnotationStore, useAnnotationStore } from '../annotation-store';
import { cssPointToUser, type PageFrame, userToCss } from '../geometry';
import type { Point } from '../ink';
import {
  commitDryStroke,
  type DryStroke,
  type DryStrokeInit,
  DryInkView,
  drySettle,
  dryStrokes,
  holdDryStroke,
  inkCommitted,
  resetDryInk,
} from './dry-ink';
import { InkPreview, outlinePath, previewPath } from './ink-preview';
import { disableInkStats, enableInkStats } from './ink-stats';

const source = 'src_dry' as SourceId;
const FRAME: PageFrame = {
  size: { width: 400, height: 300 },
  originX: 0,
  originY: 0,
  rotation: 0,
  scale: 1,
};

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const idle = () => new Promise<void>((resolve) => requestIdleCallback(() => resolve()));

let sheet: HTMLElement;
let views: DryInkView[] = [];

function mountView(pageIndex = 0, frameOf: PageFrame = FRAME): DryInkView {
  const element = document.createElement('div');
  element.style.cssText = 'position:absolute;inset:0';
  sheet.appendChild(element);
  const view = new DryInkView(element, source, pageIndex, frameOf);
  views.push(view);
  return view;
}

/** A horizontal stroke at CSS y `y` from x 40 to 200, as committed (user space). */
function stroke(y = 100, overrides: Partial<DryStrokeInit> = {}): DryStrokeInit {
  const css = [40, 80, 120, 160, 200].map((x) => ({ x, y }));
  return {
    source,
    pageIndex: 0,
    points: css.map((p) => cssPointToUser(FRAME, p)),
    widths: css.map(() => 4),
    color: '#202020',
    opacity: 1,
    blend: 'normal',
    ...overrides,
  };
}

/** The group canvas of a view and the alpha of its pixel at sheet CSS point (x, y). */
function alphaAt(view: DryInkView, x: number, y: number, group = 'normal:1'): number {
  const canvas = view.canvases.find((c) => c.dataset.dryInkGroup === group);
  if (!canvas || canvas.width === 0) return 0;
  const dpr = window.devicePixelRatio || 1;
  const px = Math.floor(x * dpr - Number(canvas.dataset.originX));
  const py = Math.floor(y * dpr - Number(canvas.dataset.originY));
  return canvas.getContext('2d')?.getImageData(px, py, 1, 1).data[3] ?? 0;
}

function inkWith(paths: readonly (readonly Point[])[]): InkAnnotation {
  return {
    id: 'ink-1',
    kind: 'ink',
    pageIndex: 0,
    rect: { x: 0, y: 0, width: 400, height: 300 },
    color: '#202020',
    strokeWidth: 4,
    paths: paths.map((p) => p.map(({ x, y }) => ({ x, y }))),
  };
}

function setStoreInks(paths: readonly (readonly Point[])[]): void {
  useAnnotationStore.setState({
    pages: { [pageKey(source, 0)]: { annotations: [inkWith(paths)], loaded: true } },
  });
}

beforeEach(() => {
  sheet = document.createElement('div');
  sheet.style.cssText = 'position:relative;width:400px;height:300px';
  document.body.appendChild(sheet);
});

afterEach(() => {
  for (const view of views) view.destroy();
  views = [];
  sheet.remove();
  resetDryInk();
  resetRenderDeferral();
  resetPaintLedger();
  resetAnnotationStore();
  disableInkStats();
  vi.restoreAllMocks();
});

describe('drawing', () => {
  it('draws a held stroke in the same task, in the committed outline and colour', () => {
    const view = mountView();
    expect(view.element.dataset.strokes).toBe('0');
    holdDryStroke(stroke());
    // No frame in between: the pixels are there now.
    expect(alphaAt(view, 120, 100)).toBe(255);
    expect(alphaAt(view, 120, 120)).toBe(0);
    expect(view.element.dataset.strokes).toBe('1');
    // The outline is the engine's: the same fill on a scratch canvas matches pixel for pixel.
    const canvas = view.canvases[0];
    if (!canvas) throw new Error('no canvas');
    const dpr = window.devicePixelRatio || 1;
    const scratch = document.createElement('canvas');
    scratch.width = canvas.width;
    scratch.height = canvas.height;
    const ctx = scratch.getContext('2d');
    if (!ctx) throw new Error('no context');
    const ox = Number(canvas.dataset.originX);
    const oy = Number(canvas.dataset.originY);
    const device = [40, 80, 120, 160, 200].map((x) => ({ x: x * dpr - ox, y: 100 * dpr - oy }));
    ctx.fillStyle = '#202020';
    ctx.fill(
      outlinePath(
        inkOutlineOps(
          device,
          device.map(() => 4 * dpr),
        ),
      ),
    );
    const a = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data;
    const b = ctx.getImageData(0, 0, scratch.width, scratch.height).data;
    expect(a && [...a].every((v, i) => v === b[i])).toBe(true);
  });

  it('groups by opacity and blend: CSS opacity on translucent ink, Multiply for the Highlighter', () => {
    const view = mountView();
    holdDryStroke(stroke(60));
    holdDryStroke(stroke(100, { opacity: 0.5, color: '#3355ff' }));
    holdDryStroke(
      stroke(140, { blend: 'multiply', color: '#ffd400', widths: [12, 12, 12, 12, 12] }),
    );
    const groups = new Map(view.canvases.map((c) => [c.dataset.dryInkGroup, c]));
    expect([...groups.keys()]).toEqual(['normal:1', 'normal:0.5', 'multiply:1']);
    expect(groups.get('normal:1')?.style.opacity).toBe('');
    expect(groups.get('normal:0.5')?.style.opacity).toBe('0.5');
    // Filled opaque: the opacity is the canvas's, so overlaps do not darken.
    expect(alphaAt(view, 120, 100, 'normal:0.5')).toBe(255);
    expect(groups.get('multiply:1')?.style.mixBlendMode).toBe('multiply');
    // The layer is not a stacking context, so the blend reaches the page bitmap.
    expect(getComputedStyle(view.element).zIndex).toBe('auto');
    expect(getComputedStyle(view.element).isolation).toBe('auto');
  });

  it('frees the canvases when the page holds nothing', () => {
    const view = mountView();
    const held = holdDryStroke(stroke());
    commitDryStroke(held, 1);
    notePageBitmap(source, 0, 1);
    expect(view.canvases.every((c) => c.width === 0 && c.height === 0)).toBe(true);
    expect(view.element.dataset.strokes).toBe('0');
  });
});

describe('the hand-over', () => {
  it('a bitmap of the stroke revision clears it in the same task; older bitmaps do not', () => {
    const view = mountView();
    const held = holdDryStroke(stroke());
    commitDryStroke(held, 3);
    notePageBitmap(source, 0, 2);
    expect(alphaAt(view, 120, 100)).toBe(255);
    // Another page's bitmap does not touch it.
    notePagePainted(source, 1, 9);
    expect(dryStrokes(source, 0)).toHaveLength(1);
    notePagePainted(source, 0, 3);
    expect(alphaAt(view, 120, 100)).toBe(0);
    expect(dryStrokes(source, 0)).toHaveLength(0);
  });

  it('keeps strokes newer than the bitmap and those still being committed', () => {
    const view = mountView();
    const first = holdDryStroke(stroke(60));
    const second = holdDryStroke(stroke(100));
    const third = holdDryStroke(stroke(140));
    commitDryStroke(first, 4);
    commitDryStroke(second, 5);
    notePageBitmap(source, 0, 4);
    expect(alphaAt(view, 120, 60)).toBe(0);
    expect(alphaAt(view, 120, 100)).toBe(255);
    // Pending: no revision yet, no bitmap can contain it.
    notePageBitmap(source, 0, 99);
    expect(dryStrokes(source, 0)).toEqual([third]);
    expect(alphaAt(view, 120, 140)).toBe(255);
  });

  it('a commit landing after a bitmap of its revision is on screen clears at once', () => {
    mountView();
    const held = holdDryStroke(stroke());
    notePageBitmap(source, 0, 7);
    commitDryStroke(held, 7);
    expect(dryStrokes(source, 0)).toHaveLength(0);
  });

  it('a page shown twice draws the stroke on both sheets', () => {
    const a = mountView();
    const b = mountView();
    holdDryStroke(stroke());
    expect(alphaAt(a, 120, 100)).toBe(255);
    expect(alphaAt(b, 120, 100)).toBe(255);
  });
});

describe('drySettle and inkCommitted', () => {
  function fakePreview(): InkPreview & { multiply: boolean; cancelled: number } {
    const host = document.createElement('div');
    sheet.appendChild(host);
    const preview = new InkPreview(host) as InkPreview & { multiply: boolean; cancelled: number };
    preview.multiply = false;
    preview.cancelled = 0;
    const cancel = preview.cancel.bind(preview);
    preview.cancel = () => {
      preview.cancelled++;
      cancel();
    };
    return preview;
  }

  const final = previewPath(
    [40, 120, 200].map((x) => ({ x, y: 100 })),
    [4, 4, 4],
  );
  const style = () => ({ color: '#123456', opacity: 0.8 });

  it('without a dry layer for the page, the preview settles on its own canvas', () => {
    const preview = fakePreview();
    const settle = vi.fn(() => vi.fn());
    const release = drySettle(settle, preview, { source, pageIndex: 0 }, FRAME, style)(final);
    expect(settle).toHaveBeenCalledWith(final);
    expect(dryStrokes(source, 0)).toHaveLength(0);
    release();
  });

  it('holds the committed shape in user space, ends the live stroke, drops on failure', () => {
    const view = mountView();
    const preview = fakePreview();
    const settle = vi.fn(() => vi.fn());
    const release = drySettle(settle, preview, { source, pageIndex: 0 }, FRAME, style)(final);
    expect(settle).not.toHaveBeenCalled();
    expect(preview.cancelled).toBe(1);
    const [held] = dryStrokes(source, 0);
    expect(held?.init.color).toBe('#123456');
    expect(held?.init.opacity).toBe(0.8);
    expect(held?.init.blend).toBe('normal');
    expect(held?.init.points[1]?.x).toBeCloseTo(120, 9);
    expect(held?.init.points[1]?.y).toBeCloseTo(200, 9);
    expect(held?.init.widths).toEqual([4, 4, 4]);
    expect(alphaAt(view, 120, 100, 'normal:0.8')).toBe(255);
    // The commit failed: released without `inkCommitted`, the stroke goes now.
    release();
    expect(dryStrokes(source, 0)).toHaveLength(0);
  });

  it('a live Highlighter stroke is held opaque with Multiply', () => {
    mountView();
    const preview = fakePreview();
    preview.multiply = true;
    drySettle(vi.fn(), preview, { source, pageIndex: 0 }, FRAME, style)(final);
    expect(dryStrokes(source, 0)[0]?.init).toMatchObject({ opacity: 1, blend: 'multiply' });
  });

  it('inkCommitted tags the stroke with the page revision; the release then keeps it', async () => {
    mountView();
    const service = getEngineService();
    const release = drySettle(
      vi.fn(),
      fakePreview(),
      { source, pageIndex: 0 },
      FRAME,
      style,
    )(final);
    service.invalidatePage(source, 0);
    const revision = service.pageRevision(source, 0);
    await inkCommitted(release, source, 0);
    release();
    const [held] = dryStrokes(source, 0);
    expect(held?.revision).toBe(revision);
    notePagePainted(source, 0, revision);
    expect(dryStrokes(source, 0)).toHaveLength(0);
  });

  it('statistics: committed visible in the frame after the dry draw, settled at the hand-over', async () => {
    mountView();
    const stats = enableInkStats({ observeLongTasks: false });
    stats.strokeBegin('pen', performance.now());
    stats.strokeEnd(performance.now(), 0, 0, 3);
    const release = drySettle(
      vi.fn(),
      fakePreview(),
      { source, pageIndex: 0 },
      FRAME,
      style,
    )(final);
    // Taken: the pipeline's "not settled" path no longer cancels it.
    stats.strokeCancel();
    expect(stats.summary().pending).toBe(1);
    await frame();
    expect(stats.summary().pending).toBe(0);
    expect(stats.summary().unsettled).toBe(1);
    expect(stats.summary().commitVisibleMs.p95).toBeLessThan(100);
    await inkCommitted(release, source, 0);
    notePagePainted(source, 0, getEngineService().pageRevision(source, 0));
    await frame();
    const summary = stats.summary();
    expect(summary.unsettled).toBe(0);
    expect(summary.bitmapSettledMs.count).toBe(1);
    expect(summary.cancelled).toBe(0);
  });
});

describe('render deferral', () => {
  it('runs at once when the page holds no dry ink', () => {
    const run = vi.fn();
    deferPageRender(source, 0, run);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('waits while the page holds fresh ink, until idle time with no pointer down', async () => {
    mountView();
    const held = holdDryStroke(stroke());
    commitDryStroke(held, 1);
    const run = vi.fn();
    deferPageRender(source, 0, run);
    expect(run).not.toHaveBeenCalled();
    expect(heldPageRenders()).toBe(1);
    await idle();
    await frame();
    expect(run).toHaveBeenCalledTimes(1);
    expect(heldPageRenders()).toBe(0);
  });

  it('never while a pointer is down, nor while a stroke is still being committed', async () => {
    mountView();
    const committed = holdDryStroke(stroke(60));
    commitDryStroke(committed, 1);
    const run = vi.fn();
    window.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 41 }));
    deferPageRender(source, 0, run);
    await idle();
    await frame();
    await frame();
    expect(run).not.toHaveBeenCalled();
    // A second stroke is held before the pointer goes up; its commit has not landed.
    const pending: DryStroke = holdDryStroke(stroke(140));
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 41 }));
    await idle();
    await frame();
    await frame();
    expect(run).not.toHaveBeenCalled();
    commitDryStroke(pending, 2);
    await frame();
    await frame();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a cancelled deferral never runs', async () => {
    mountView();
    commitDryStroke(holdDryStroke(stroke()), 1);
    const run = vi.fn();
    const cancel = deferPageRender(source, 0, run);
    cancel();
    expect(heldPageRenders()).toBe(0);
    await idle();
    await frame();
    expect(run).not.toHaveBeenCalled();
  });

  it('thumbnails and other pages wait while a pen is down; the pen page does not', async () => {
    notePenDown(source, 0, 77);
    const thumbnail = vi.fn();
    const neighbour = vi.fn();
    const own = vi.fn();
    whenPenUp(thumbnail);
    deferPageRender(source, 1, neighbour);
    whenPenUp(own, source, 0);
    expect(own).toHaveBeenCalledTimes(1);
    expect(thumbnail).not.toHaveBeenCalled();
    expect(neighbour).not.toHaveBeenCalled();
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 77 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(thumbnail).toHaveBeenCalledTimes(1);
    expect(neighbour).toHaveBeenCalledTimes(1);
  });
});

describe('edits, zoom, resize and scroll', () => {
  it('an undone, erased or moved stroke leaves the layer as the store loses its path', () => {
    const view = mountView();
    const kept = holdDryStroke(stroke(60));
    const undone = holdDryStroke(stroke(140));
    commitDryStroke(kept, 1);
    commitDryStroke(undone, 2);
    const run = vi.fn();
    window.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 42 }));
    deferPageRender(source, 0, run);
    // The store shows both paths, then (undo, eraser, lasso move) only the first.
    setStoreInks([kept.init.points, undone.init.points]);
    expect(dryStrokes(source, 0)).toHaveLength(2);
    setStoreInks([kept.init.points.map((p) => ({ x: p.x + 0.001, y: p.y }))]);
    // Immediately: no render needed for it to go, and the other stays.
    expect(dryStrokes(source, 0)).toEqual([kept]);
    expect(alphaAt(view, 120, 140)).toBe(0);
    expect(alphaAt(view, 120, 60)).toBe(255);
    // The page re-renders through the normal path at once, pointer down or not.
    expect(run).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 42 }));
  });

  it('a stroke the store has not shown yet is kept (the store lags the commit)', () => {
    mountView();
    const held = holdDryStroke(stroke(60));
    commitDryStroke(held, 1);
    setStoreInks([]);
    expect(dryStrokes(source, 0)).toHaveLength(1);
  });

  it('after a history move that is not a stroke (undo), its revision re-renders at once', async () => {
    resetWorkspace();
    mountView();
    const service = getEngineService();
    commitDryStroke(holdDryStroke(stroke()), service.pageRevision(source, 0));
    const run = vi.fn();
    window.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 44 }));
    deferPageRender(source, 0, run);
    const history = useWorkspaceStore.getState().history;
    useWorkspaceStore.setState({
      history: { ...history, future: [history.present, ...history.future] },
    });
    // Not yet: the engine has not undone anything, a render now would show the old page.
    expect(run).not.toHaveBeenCalled();
    // The undo lands: the page's next revision renders without waiting, pointer down or not.
    service.invalidatePage(source, 0);
    const next = vi.fn();
    deferPageRender(source, 0, next);
    expect(next).toHaveBeenCalledTimes(1);
    await frame();
    await frame();
    expect(run).toHaveBeenCalledTimes(1);
    // Its bitmap takes the older strokes over.
    notePagePainted(source, 0, service.pageRevision(source, 0));
    expect(dryStrokes(source, 0)).toHaveLength(0);
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 44 }));
    resetWorkspace();
  });

  it('a stroke joining its burst entry does not end the wait', () => {
    resetWorkspace();
    mountView();
    commitDryStroke(holdDryStroke(stroke()), 1);
    const run = vi.fn();
    window.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 47 }));
    deferPageRender(source, 0, run);
    const history = useWorkspaceStore.getState().history;
    useWorkspaceStore.setState({
      history: { ...history, present: { ...history.present, coalesceKey: 'ink-burst:x' } },
    });
    expect(run).not.toHaveBeenCalled();
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 47 }));
    resetWorkspace();
  });

  it('a zoom or a page resize redraws from user space and ends the wait', () => {
    const view = mountView();
    const held = holdDryStroke(stroke(100));
    commitDryStroke(held, 1);
    const run = vi.fn();
    window.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 45 }));
    deferPageRender(source, 0, run);
    // 1.5× zoom: the stroke at CSS y 100 moves to 150 (user y 200 → (300 − 200) × 1.5).
    view.setFrame({ ...FRAME, scale: 1.5 });
    expect(alphaAt(view, 180, 150)).toBe(255);
    expect(alphaAt(view, 180, 100)).toBe(0);
    expect(run).toHaveBeenCalledTimes(1);
    // A resized page stretched vertically: drawn where the frame now maps the stroke.
    const stretched: PageFrame = { ...FRAME, stretchY: 0.5 };
    view.setFrame(stretched);
    const middle = held.init.points[2];
    if (!middle) throw new Error('no point');
    const at = userToCss(stretched, middle);
    expect(at.y).not.toBeCloseTo(100, 0);
    expect(alphaAt(view, at.x, at.y)).toBe(255);
    expect(alphaAt(view, 120, 100)).toBe(0);
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 45 }));
  });

  it('a scroll beyond the canvases moves them and ends the wait', () => {
    const scroller = document.createElement('div');
    scroller.setAttribute('data-read-viewport', '');
    scroller.style.cssText = 'position:relative;width:300px;height:200px;overflow:auto';
    document.body.appendChild(scroller);
    const tall = document.createElement('div');
    tall.style.cssText = 'position:relative;width:300px;height:3000px';
    scroller.appendChild(tall);
    sheet.remove();
    sheet = tall;
    const tallFrame: PageFrame = { ...FRAME, size: { width: 300, height: 3000 } };
    const view = mountView(0, tallFrame);
    const css = [20, 150, 280].map((x) => ({ x, y: 2500 }));
    const far = holdDryStroke({
      ...stroke(),
      points: css.map((p) => cssPointToUser(tallFrame, p)),
      widths: [4, 4, 4],
    });
    commitDryStroke(far, 1);
    // Off the covered part: nothing drawn there yet.
    const before = view.canvases[0];
    expect(Number(before?.dataset.originY ?? 0) + (before?.height ?? 0)).toBeLessThan(2500);
    const run = vi.fn();
    window.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 46 }));
    deferPageRender(source, 0, run);
    // A small scroll stays within the margin: nothing moves, the wait goes on.
    scroller.scrollTop = 40;
    scroller.dispatchEvent(new Event('scroll'));
    expect(view.canvases[0]?.dataset.originY).toBe(before?.dataset.originY);
    expect(run).not.toHaveBeenCalled();
    scroller.scrollTop = 2400;
    scroller.dispatchEvent(new Event('scroll'));
    expect(alphaAt(view, 150, 2500)).toBe(255);
    expect(run).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 46 }));
    scroller.remove();
  });
});
