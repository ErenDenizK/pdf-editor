/**
 * PageCanvas against the real engine service (PDFium in its worker): Read-mode pages
 * render at the exact device scale of their snapped sheet and are drawn 1:1, and a zoom
 * gesture renders only the settled zoom. An edit (a revision) repaints at once, never behind
 * the zoom debounce; a thumbnail keeps its pixels and repaints when idle (craft spec §5.2
 * item 6).
 */
import type { SourceId } from '@pdf-editor/document-model';
import { act, render, waitFor } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import fixtureUrl from '../../../../test/fixtures/simple-text.pdf?url';
import {
  chooseBucket,
  chooseScale,
  exactScale,
  getEngineService,
  RENDER_PRIORITY,
  sheetSize,
} from '../engine/engine-service';
import { onPageBitmap } from '../viewer/read-controller';
import { PageCanvas } from './PageCanvas';

const WIDTH_PT = 612;
const HEIGHT_PT = 792;

let source: SourceId;

beforeAll(async () => {
  const bytes = await (await fetch(fixtureUrl)).arrayBuffer();
  const opened = await getEngineService().open(
    new File([bytes], 'simple-text.pdf', { type: 'application/pdf' }),
  );
  if (!opened.ok) throw new Error(opened.error.message);
  source = opened.value.id;
}, 30_000);

afterAll(async () => {
  await getEngineService().close(source);
});

function Sheet({ zoom, delayMs }: { readonly zoom: number; readonly delayMs?: number }) {
  const dpr = window.devicePixelRatio || 1;
  const { width, height } = sheetSize(WIDTH_PT, HEIGHT_PT, zoom * (96 / 72), dpr);
  return (
    <div data-testid="sheet" style={{ position: 'relative', width, height }}>
      <PageCanvas
        sourceId={source}
        index={0}
        rotation={0}
        widthPt={WIDTH_PT}
        heightPt={HEIGHT_PT}
        cssWidth={width}
        exact
        priority={RENDER_PRIORITY.page}
        {...(delayMs === undefined ? {} : { delayMs })}
      />
    </div>
  );
}

function canvasOf(container: HTMLElement): HTMLCanvasElement {
  const canvas = container.querySelector('canvas');
  if (!canvas) throw new Error('no canvas');
  return canvas;
}

function expectedScale(zoom: number): number {
  const dpr = window.devicePixelRatio || 1;
  const { width } = sheetSize(WIDTH_PT, HEIGHT_PT, zoom * (96 / 72), dpr);
  return chooseScale(exactScale(width, WIDTH_PT, dpr), WIDTH_PT, HEIGHT_PT);
}

describe('PageCanvas (exact)', () => {
  it('renders at the exact device scale and fills the sheet 1:1', async () => {
    const { container } = render(<Sheet zoom={1.33} />);
    const canvas = canvasOf(container);
    await waitFor(() => expect(canvas.dataset.state).toBe('rendered'), { timeout: 20_000 });
    const dpr = window.devicePixelRatio || 1;
    const box = canvas.getBoundingClientRect();
    expect(canvas.width).toBe(Math.round(box.width * dpr));
    expect(canvas.height).toBe(Math.round(box.height * dpr));
    expect(Math.abs(box.width * dpr - canvas.width)).toBeLessThan(1e-3);
    expect(Math.abs(box.height * dpr - canvas.height)).toBeLessThan(1e-3);
    expect(Number(canvas.dataset.bucket)).toBe(expectedScale(1.33));
    // Default filtering: nearest-neighbour is unsafe at fractional on-screen origins.
    expect(getComputedStyle(canvas).imageRendering).toBe('auto');
  }, 30_000);

  it('while zooming shows a stretched preview and renders only the settled zoom', async () => {
    const service = getEngineService();
    const { container, rerender } = render(<Sheet zoom={1} delayMs={120} />);
    const canvas = canvasOf(container);
    await waitFor(() => expect(canvas.dataset.state).toBe('rendered'), { timeout: 20_000 });
    const spy = vi.spyOn(service, 'renderPage');
    try {
      for (const zoom of [1.07, 1.13, 1.21, 1.29]) rerender(<Sheet zoom={zoom} delayMs={120} />);
      // The 100% bitmap stays up, stretched, and no longer counts as rendered.
      expect(canvas.dataset.state).toBe('preview');
      expect(Number(canvas.dataset.bucket)).toBe(expectedScale(1));
      await waitFor(
        () => {
          expect(canvas.dataset.state).toBe('rendered');
          expect(Number(canvas.dataset.bucket)).toBe(expectedScale(1.29));
        },
        { timeout: 20_000 },
      );
      expect(spy.mock.calls.map(([request]) => request.bucket)).toEqual([expectedScale(1.29)]);
      // Back to 100%: an exact cache hit, drawn at once without a render.
      rerender(<Sheet zoom={1} delayMs={120} />);
      expect(canvas.dataset.state).toBe('rendered');
      expect(Number(canvas.dataset.bucket)).toBe(expectedScale(1));
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  }, 30_000);
});

describe('PageCanvas (edits)', () => {
  it('an edit requests the repaint at once, not after the zoom debounce', async () => {
    const service = getEngineService();
    const { container } = render(<Sheet zoom={1} delayMs={160} />);
    const canvas = canvasOf(container);
    await waitFor(() => expect(canvas.dataset.state).toBe('rendered'), { timeout: 20_000 });
    const spy = vi.spyOn(service, 'renderPage');
    try {
      act(() => service.invalidatePage(source, 0));
      // Requested in the same task as the revision change, at the same scale.
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.[0].bucket).toBe(expectedScale(1));
      // The old pixels stay up until the fresh render arrives.
      expect(canvas.width).toBeGreaterThan(0);
      await waitFor(() => expect(canvas.dataset.state).toBe('rendered'), { timeout: 20_000 });
    } finally {
      spy.mockRestore();
    }
  }, 30_000);

  it('a zoom still debounces, and an edit during it does not cut the debounce short', async () => {
    const service = getEngineService();
    const { container, rerender } = render(<Sheet zoom={1} delayMs={160} />);
    const canvas = canvasOf(container);
    await waitFor(() => expect(canvas.dataset.state).toBe('rendered'), { timeout: 20_000 });
    const spy = vi.spyOn(service, 'renderPage');
    try {
      rerender(<Sheet zoom={1.17} delayMs={160} />);
      act(() => service.invalidatePage(source, 0));
      expect(spy).not.toHaveBeenCalled();
      await waitFor(() => expect(spy).toHaveBeenCalledTimes(1), { timeout: 5_000 });
      expect(spy.mock.calls[0]?.[0].bucket).toBe(expectedScale(1.17));
      await waitFor(() => expect(canvas.dataset.state).toBe('rendered'), { timeout: 20_000 });
    } finally {
      spy.mockRestore();
    }
  }, 30_000);

  // Review F5: a bitmap is reported under the revision whose content it shows, so the dry ink
  // layer never takes a bitmap that a clipped repaint has not patched yet for the new revision.
  it('reports every bitmap it draws under the bitmap’s own revision', async () => {
    const service = getEngineService();
    const { container } = render(<Sheet zoom={1} />);
    const canvas = canvasOf(container);
    await waitFor(() => expect(canvas.dataset.state).toBe('rendered'), { timeout: 20_000 });
    const before = service.pageRevision(source, 0);
    const old = service.peek(source, 0, 0, expectedScale(1));
    expect(old?.revision).toBe(before);
    const reported: number[] = [];
    const off = onPageBitmap((id, index, generation) => {
      if (id === source && index === 0) reported.push(generation);
    });
    // While the patch runs the service offers nothing of the old content (it passes over the
    // bitmap being repainted); a cache that still offered it would carry its old revision.
    const preview = vi.spyOn(service, 'preview').mockImplementationOnce(() => old);
    try {
      act(() =>
        service.requestClippedRepaint(source, 0, { x: 100, y: 600, width: 20, height: 20 }),
      );
      const after = service.pageRevision(source, 0);
      expect(after).toBe(before + 1);
      expect(preview).toHaveBeenCalled();
      // The old bitmap was drawn as a preview and reported as what it is.
      expect(reported).toEqual([before]);
      await waitFor(() => expect(canvas.dataset.state).toBe('rendered'), { timeout: 20_000 });
      expect(reported).toEqual([before, after]);
      expect(service.peek(source, 0, 0, expectedScale(1))?.revision).toBe(after);
    } finally {
      off();
      preview.mockRestore();
    }
  }, 30_000);

  it('a thumbnail keeps its pixels after an edit and repaints when idle', async () => {
    const service = getEngineService();
    const cssWidth = 120;
    const { container } = render(
      <div style={{ position: 'relative', width: cssWidth, height: 155 }}>
        <PageCanvas
          sourceId={source}
          index={2}
          rotation={0}
          widthPt={WIDTH_PT}
          heightPt={HEIGHT_PT}
          cssWidth={cssWidth}
          priority={RENDER_PRIORITY.visible}
        />
      </div>,
    );
    const canvas = canvasOf(container);
    await waitFor(() => expect(canvas.dataset.state).toBe('rendered'), { timeout: 20_000 });
    const width = canvas.width;
    const spy = vi.spyOn(service, 'renderPage');
    try {
      act(() => service.invalidatePage(source, 2));
      expect(spy).not.toHaveBeenCalled();
      expect(canvas.width).toBe(width);
      expect(canvas.dataset.state).toBe('preview');
      await waitFor(() => expect(spy).toHaveBeenCalledTimes(1), { timeout: 5_000 });
      await waitFor(() => expect(canvas.dataset.state).toBe('rendered'), { timeout: 20_000 });
    } finally {
      spy.mockRestore();
    }
  }, 30_000);
});

describe('PageCanvas (thumbnail)', () => {
  it('renders at a shared quarter-octave bucket', async () => {
    const cssWidth = 120;
    const { container } = render(
      <div style={{ position: 'relative', width: cssWidth, height: 155 }}>
        <PageCanvas
          sourceId={source}
          index={1}
          rotation={0}
          widthPt={WIDTH_PT}
          heightPt={HEIGHT_PT}
          cssWidth={cssWidth}
          priority={RENDER_PRIORITY.visible}
        />
      </div>,
    );
    const canvas = canvasOf(container);
    await waitFor(() => expect(canvas.dataset.state).toBe('rendered'), { timeout: 20_000 });
    const dpr = window.devicePixelRatio || 1;
    expect(Number(canvas.dataset.bucket)).toBe(
      chooseBucket((cssWidth * dpr) / WIDTH_PT, WIDTH_PT, HEIGHT_PT),
    );
  }, 30_000);
});
