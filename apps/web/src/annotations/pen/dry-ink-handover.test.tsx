/**
 * The dry ink hand-over with real PDFium (craft spec §5.3 item 7, §10 "dry-layer swap"): a
 * page canvas, the dry ink layer and the annotation layer stacked like a Read page. A pen
 * stroke is on the dry layer in its pointer-up task; the page re-renders once the pen is
 * up and idle; when the bitmap with the stroke is drawn, the dry stroke goes in that same
 * task. Sampled every animation frame across the hand-over, the stroke's pixel is never
 * missing and never drawn by both layers, also when a burst's next stroke repaints only its
 * box into the cached bitmap (a clipped repaint). An undo before the hand-over removes the
 * strokes and re-renders at once.
 */
import '../../styles/tokens.css';
import '../../styles/reset.css';
import '../../styles/global.css';
import '../index';

import {
  getActiveDocument,
  pageTotalRotation,
  type SourceId,
  type VirtualDocument,
  type VirtualPage,
} from '@pdf-editor/document-model';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';

import simpleUrl from '../../../../../test/fixtures/simple-text.pdf?url';
import { enterEditMode, fixtureFile } from '../../../test/store-harness';
import { getEngineService, RENDER_PRIORITY } from '../../engine/engine-service';
import { displaySize } from '../../pages/page-geometry';
import { PageCanvas } from '../../pages/PageCanvas';
import { resetWorkspace, useWorkspaceStore } from '../../state/workspace-store';
import {
  heldPageRenders,
  onPageBitmap,
  resetPaintLedger,
  resetRenderDeferral,
} from '../../viewer/read-controller';
import { useToolStore } from '../../viewer/tool-store';
import { AnnotationLayer } from '../AnnotationLayer';
import {
  resetAnnotationStore,
  TOOL_STYLES_STORAGE_KEY,
  useAnnotationStore,
} from '../annotation-store';
import { resetEditRunner, whenIdle } from '../edit-runner';
import { closeBurst } from './bursts';
import { dryStrokes, resetDryInk } from './dry-ink';
import { DryInkLayer } from './DryInkLayer';
import { resetPenSession } from './ink-input';
import { PEN_PRESETS_STORAGE_KEY } from './presets';

const model = () => useWorkspaceStore.getState();

interface Mounted {
  readonly layer: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly dry: HTMLElement;
  readonly source: SourceId;
  readonly first: VirtualPage;
}

async function mountPage(): Promise<Mounted> {
  const report = await model().openFiles([await fixtureFile(simpleUrl, 'simple.pdf')]);
  enterEditMode();
  expect(report.skipped).toEqual([]);
  const ws = model().workspace;
  const doc = getActiveDocument(ws) as VirtualDocument;
  const first = doc.pages[0];
  if (first?.ref.kind !== 'source') throw new Error('no source page');
  const sizePt = displaySize(ws, first);
  const style = document.createElement('style');
  style.textContent =
    '[data-test-overlays], [data-test-overlays] > * { position: absolute; inset: 0; }';
  document.head.appendChild(style);
  const props = {
    page: first,
    pageId: first.id,
    pageIndex: 0,
    sourceId: first.ref.source,
    sourceIndex: first.ref.index,
    sizePt,
    cssScale: 1,
    rotation: pageTotalRotation(ws, first),
    visible: true,
  };
  render(
    <div
      data-read-viewport=""
      style={{ position: 'fixed', inset: 0, overflow: 'auto', background: '#ddd' }}
    >
      <div
        style={{
          position: 'relative',
          width: sizePt.width,
          height: sizePt.height,
          background: '#fff',
        }}
      >
        <PageCanvas
          sourceId={first.ref.source}
          index={first.ref.index}
          rotation={first.rotation}
          widthPt={sizePt.width}
          heightPt={sizePt.height}
          cssWidth={sizePt.width}
          exact
          priority={RENDER_PRIORITY.page}
        />
        <div data-test-overlays="">
          <DryInkLayer {...props} />
          <AnnotationLayer {...props} />
        </div>
      </div>
    </div>,
  );
  const layer = await waitFor(() => {
    const l = document.querySelector<HTMLElement>('[data-annotation-layer="0"]');
    if (!l) throw new Error('no annotation layer');
    return l;
  });
  const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-state]');
  const dry = document.querySelector<HTMLElement>('[data-dry-ink]');
  if (!canvas || !dry) throw new Error('page not mounted');
  await waitFor(() => expect(canvas.dataset.state).toBe('rendered'), { timeout: 20_000 });
  return { layer, canvas, dry, source: first.ref.source, first };
}

function pen(type: string, x: number, y: number, pointerId = 9): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: type === 'pointermove' ? -1 : 0,
    buttons: type === 'pointerup' ? 0 : 1,
    pointerId,
    pointerType: 'pen',
    isPrimary: true,
    pressure: 0.5,
  });
}

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Draws a straight pen stroke at sheet y `y` from x `x0` to `x1` (sheet CSS px). */
async function stroke(layer: HTMLElement, x0: number, x1: number, y: number): Promise<void> {
  const box = layer.getBoundingClientRect();
  const at = (x: number) => [box.left + x, box.top + y] as const;
  layer.dispatchEvent(pen('pointerdown', ...at(x0)));
  for (let i = 1; i <= 24; i++) {
    layer.dispatchEvent(pen('pointermove', ...at(x0 + ((x1 - x0) * i) / 24)));
    if (i % 6 === 0) await frame();
  }
  layer.dispatchEvent(pen('pointerup', ...at(x1)));
}

/** The page bitmap is dark at sheet point (x, y). */
function pageDark(canvas: HTMLCanvasElement, x: number, y: number): boolean {
  const dpr = window.devicePixelRatio || 1;
  const [r = 255, g = 255, b = 255] =
    canvas.getContext('2d')?.getImageData(Math.floor(x * dpr), Math.floor(y * dpr), 1, 1).data ??
    [];
  return r + g + b < 300;
}

/** The dry layer covers sheet point (x, y). */
function dryDrawn(dry: HTMLElement, x: number, y: number): boolean {
  const dpr = window.devicePixelRatio || 1;
  for (const canvas of dry.querySelectorAll<HTMLCanvasElement>('canvas')) {
    if (canvas.width === 0) continue;
    const px = Math.floor(x * dpr - Number(canvas.dataset.originX));
    const py = Math.floor(y * dpr - Number(canvas.dataset.originY));
    if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) continue;
    if ((canvas.getContext('2d')?.getImageData(px, py, 1, 1).data[3] ?? 0) > 200) return true;
  }
  return false;
}

interface Sample {
  readonly page: boolean;
  readonly dry: boolean;
}

/** Samples (x, y) in every animation frame until stopped. */
function sampleFrames(canvas: HTMLCanvasElement, dry: HTMLElement, x: number, y: number) {
  const samples: Sample[] = [];
  let running = true;
  const tick = () => {
    if (!running) return;
    samples.push({ page: pageDark(canvas, x, y), dry: dryDrawn(dry, x, y) });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return {
    samples,
    stop: () => {
      running = false;
    },
  };
}

describe('dry ink hand-over (real PDFium)', () => {
  beforeEach(async () => {
    await page.viewport(1280, 900);
    localStorage.removeItem(TOOL_STYLES_STORAGE_KEY);
    localStorage.removeItem(PEN_PRESETS_STORAGE_KEY);
    resetWorkspace();
    resetEditRunner();
    resetAnnotationStore();
    resetPenSession();
    resetDryInk();
    resetRenderDeferral();
    resetPaintLedger();
  });
  afterEach(async () => {
    await whenIdle();
    cleanup();
    useToolStore.getState().setMode('select');
    localStorage.removeItem(TOOL_STYLES_STORAGE_KEY);
    localStorage.removeItem(PEN_PRESETS_STORAGE_KEY);
    resetAnnotationStore();
    resetWorkspace();
    resetPenSession();
    resetDryInk();
    resetRenderDeferral();
  });

  async function armPen(mounted: Mounted): Promise<void> {
    useToolStore.getState().setMode('ink');
    await waitFor(() => expect(mounted.layer).toHaveAttribute('data-tool', 'ink'));
    // A wide opaque pen, so the sampled centre pixel is fully covered in both layers.
    const store = useAnnotationStore.getState();
    store.editPreset(store.pen.active, { width: 6, opacity: 1 });
    await waitFor(() => expect(useAnnotationStore.getState().pages).not.toEqual({}));
    await whenIdle();
    await frame();
    await frame();
  }

  it('no frame without the stroke or with it twice, and the swap is in one task', async () => {
    const mounted = await mountPage();
    const { layer, canvas, dry, source } = mounted;
    await armPen(mounted);
    // A blank band near the bottom of the page.
    const y = Math.round(mounted.layer.getBoundingClientRect().height * 0.9) + 0.5;
    const x = 300.5;
    expect(pageDark(canvas, x, y)).toBe(false);

    // In the task that hands over: the bitmap shows the stroke and the dry layer no longer.
    const swaps: Sample[] = [];
    const off = onPageBitmap(() =>
      swaps.push({ page: pageDark(canvas, x, y), dry: dryDrawn(dry, x, y) }),
    );
    let sampler: ReturnType<typeof sampleFrames> | undefined;
    try {
      await stroke(layer, 150, 450, y);
      // From the pointer-up on (before it, the wet canvas shows the stroke).
      sampler = sampleFrames(canvas, dry, x, y);
      // Drawn in the pointer-up task, before any frame.
      expect(dryDrawn(dry, x, y)).toBe(true);
      expect(pageDark(canvas, x, y)).toBe(false);
      expect(dry.dataset.strokes).toBe('1');
      await waitFor(
        () => {
          expect(pageDark(canvas, x, y)).toBe(true);
          expect(dryStrokes(source, 0)).toHaveLength(0);
        },
        { timeout: 15_000 },
      );
      await frame();
      await frame();
    } finally {
      sampler?.stop();
      off();
    }
    const after = sampler?.samples ?? [];
    expect(after.length).toBeGreaterThan(2);
    // Never missing, never doubled.
    expect(after.filter((s) => !s.page && !s.dry)).toEqual([]);
    expect(after.filter((s) => s.page && s.dry)).toEqual([]);
    // Both sides of the swap were on screen.
    expect(after.some((s) => s.dry && !s.page)).toBe(true);
    expect(after.at(-1)).toEqual({ page: true, dry: false });
    // The swap's task: the bitmap with the stroke drawn and the dry stroke gone together.
    expect(swaps.some((s) => s.page && !s.dry)).toBe(true);
    expect(swaps.filter((s) => s.page && s.dry)).toEqual([]);
    expect(dry.dataset.strokes).toBe('0');
  }, 40_000);

  // Review F5: a burst's second stroke repaints only its box into the cached bitmap. While
  // that patch runs, the bitmap still shows the old content and must not stand for the new
  // revision, or the dry layer drops the stroke before any bitmap shows it.
  it('the clipped repaint of a burst append: no frame without the stroke or with it twice', async () => {
    // A long burst pause, so the second stroke joins the first after its hand-over.
    localStorage.setItem(
      PEN_PRESETS_STORAGE_KEY,
      JSON.stringify({ ...useAnnotationStore.getState().pen, burstPauseMs: 5000 }),
    );
    resetAnnotationStore();
    const mounted = await mountPage();
    const { layer, canvas, dry, source } = mounted;
    await armPen(mounted);
    const y = Math.round(layer.getBoundingClientRect().height * 0.9) + 0.5;
    const service = getEngineService();
    // Calls through: counts the clipped repaints.
    const clipped = vi.spyOn(service, 'requestClippedRepaint');
    let clippedCalls: number | undefined;
    const swaps: Sample[] = [];
    let off: (() => void) | undefined;
    let sampler: ReturnType<typeof sampleFrames> | undefined;
    try {
      // The burst's first stroke (a create), handed over to a whole-page bitmap.
      await stroke(layer, 150, 250, y);
      await waitFor(
        () => {
          expect(pageDark(canvas, 200.5, y)).toBe(true);
          expect(dryStrokes(source, 0)).toHaveLength(0);
        },
        { timeout: 4_000 },
      );
      expect(clipped).not.toHaveBeenCalled();

      // The second stroke joins it (an append): only its box is repainted.
      const x = 320.5;
      expect(pageDark(canvas, x, y)).toBe(false);
      off = onPageBitmap(() =>
        swaps.push({ page: pageDark(canvas, x, y), dry: dryDrawn(dry, x, y) }),
      );
      await stroke(layer, 270, 370, y);
      sampler = sampleFrames(canvas, dry, x, y);
      expect(dryDrawn(dry, x, y)).toBe(true);
      expect(pageDark(canvas, x, y)).toBe(false);
      await waitFor(
        () => {
          expect(pageDark(canvas, x, y)).toBe(true);
          expect(dryStrokes(source, 0)).toHaveLength(0);
        },
        { timeout: 15_000 },
      );
      await frame();
      await frame();
    } finally {
      sampler?.stop();
      off?.();
      clippedCalls = clipped.mock.calls.length;
      clipped.mockRestore();
      closeBurst();
    }
    expect(clippedCalls).toBe(1);
    const after = sampler?.samples ?? [];
    expect(after.length).toBeGreaterThan(2);
    expect(after.filter((s) => !s.page && !s.dry)).toEqual([]);
    expect(after.filter((s) => s.page && s.dry)).toEqual([]);
    expect(after.some((s) => s.dry && !s.page)).toBe(true);
    expect(after.at(-1)).toEqual({ page: true, dry: false });
    // Every bitmap reported while the stroke was held either lacked it with the dry layer
    // still drawing it, or showed it with the dry layer empty.
    expect(swaps.filter((s) => !s.page && !s.dry)).toEqual([]);
    expect(swaps.filter((s) => s.page && s.dry)).toEqual([]);
    expect(swaps.some((s) => s.page && !s.dry)).toBe(true);
  }, 40_000);

  it('the re-render waits while a pointer is down; an undo removes the strokes at once', async () => {
    const mounted = await mountPage();
    const { layer, canvas, dry, source } = mounted;
    await armPen(mounted);
    const y = Math.round(layer.getBoundingClientRect().height * 0.9) + 0.5;
    // Another pointer stays down: idle time cannot release the render.
    window.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 31 }));
    try {
      await stroke(layer, 150, 250, y);
      await stroke(layer, 270, 370, y);
      await waitFor(() => {
        const strokes = dryStrokes(source, 0);
        expect(strokes).toHaveLength(2);
        expect(strokes.every((s) => s.revision !== null)).toBe(true);
      });
      await waitFor(() => expect(heldPageRenders()).toBeGreaterThan(0));
      // Committed and waiting: the bitmap does not show them, the dry layer does.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(pageDark(canvas, 200.5, y)).toBe(false);
      expect(dryDrawn(dry, 200.5, y)).toBe(true);
      expect(dryDrawn(dry, 320.5, y)).toBe(true);

      // Undo (the burst's one entry): both strokes go without waiting for the pointer.
      // Sampled every frame from the undo: once gone, the strokes never come back.
      const sampler = sampleFrames(canvas, dry, 200.5, y);
      model().undo();
      await waitFor(() => expect(dryStrokes(source, 0)).toHaveLength(0), { timeout: 5_000 });
      expect(dryDrawn(dry, 200.5, y)).toBe(false);
      expect(dryDrawn(dry, 320.5, y)).toBe(false);
      await waitFor(() => expect(heldPageRenders()).toBe(0));
      await frame();
      await frame();
      sampler.stop();
      expect(pageDark(canvas, 200.5, y)).toBe(false);
      expect(pageDark(canvas, 320.5, y)).toBe(false);
      const first = sampler.samples.findIndex((s) => !s.page && !s.dry);
      expect(first).toBeGreaterThanOrEqual(0);
      expect(sampler.samples.slice(first).filter((s) => s.page || s.dry)).toEqual([]);
    } finally {
      window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 31 }));
    }
  }, 40_000);
});
