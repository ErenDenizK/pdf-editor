/**
 * PageCanvas against the real engine service (PDFium in its worker): Read-mode pages
 * render at the exact device scale of their snapped sheet and are drawn 1:1, and a zoom
 * gesture renders only the settled zoom.
 */
import type { SourceId } from '@pdf-editor/document-model';
import { render, waitFor } from '@testing-library/react';
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
