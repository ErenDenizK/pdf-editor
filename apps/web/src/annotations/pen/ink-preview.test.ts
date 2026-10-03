/**
 * The pen's canvas preview (experience-redesign spec §6.6), on a real canvas: device-pixel
 * sizing, incremental drawing (work proportional to the new points), predicted points shown
 * for one frame only, variable width, and settling to the committed outline.
 */
import { inkOutlineOps } from '@pdf-editor/engine/ink-outline';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InkPreview, outlinePath, type PreviewPath, previewPath } from './ink-preview';

let host: HTMLDivElement;
let preview: InkPreview;

beforeEach(() => {
  host = document.createElement('div');
  Object.assign(host.style, {
    position: 'fixed',
    left: '10px',
    top: '20px',
    width: '400px',
    height: '200px',
  });
  document.body.appendChild(host);
  preview = new InkPreview(host);
});

afterEach(() => {
  preview.destroy();
  host.remove();
});

const dpr = () => window.devicePixelRatio || 1;

/** Alpha of the live canvas at a CSS point of the host. */
function alphaAt(canvas: HTMLCanvasElement, x: number, y: number): number {
  const ctx = canvas.getContext('2d');
  const left = Number.parseFloat(canvas.style.left);
  const top = Number.parseFloat(canvas.style.top);
  const scale = canvas.width / Number.parseFloat(canvas.style.width);
  const data = ctx?.getImageData(
    Math.round((x - left) * scale),
    Math.round((y - top) * scale),
    1,
    1,
  ).data;
  return data?.[3] ?? 0;
}

/** Vertical extent (CSS px) of painted pixels in the column at `x`. */
function thicknessAt(canvas: HTMLCanvasElement, x: number): number {
  let painted = 0;
  for (let y = 0; y < 200; y += 0.5) if (alphaAt(canvas, x, y) > 128) painted += 0.5;
  return painted;
}

/** A growing horizontal stroke at y = 100 from x = 20, one point per 2 px. */
function growing(count: number, width: (i: number) => number = () => 4): PreviewPath {
  return {
    length: count,
    x: (i) => 20 + i * 1.5,
    y: () => 100,
    w: width,
  };
}

describe('ink preview', () => {
  it('sizes the live canvas in whole device pixels over the host', () => {
    preview.begin({ color: '#000000', opacity: 0.5 });
    const canvas = preview.liveCanvas;
    expect(canvas).not.toBeNull();
    expect(canvas?.width).toBe(Math.ceil(400 * dpr()));
    expect(canvas?.height).toBe(Math.ceil(200 * dpr()));
    expect(canvas?.style.opacity).toBe('0.5');
    expect(canvas?.parentElement).toBe(host);
  });

  it('draws incrementally: outline work grows with the new points only', () => {
    preview.begin({ color: '#000000', opacity: 1 });
    const canvas = preview.liveCanvas as HTMLCanvasElement;
    for (let n = 1; n <= 200; n++) preview.draw(growing(n));
    expect(preview.stats.frames).toBe(200);
    expect(preview.stats.pieces).toBeGreaterThan(150);
    // A full redraw each frame would outline 1 + 2 + … + 200 = 20,100 points.
    expect(preview.stats.outlinedPoints).toBeLessThan(200 * 8);
    expect(alphaAt(canvas, 20, 100)).toBe(255);
    expect(alphaAt(canvas, 150, 100)).toBe(255);
    expect(alphaAt(canvas, 20 + 199 * 1.5, 100)).toBe(255);
    expect(alphaAt(canvas, 150, 110)).toBe(0);
    expect(alphaAt(canvas, 380, 100)).toBe(0);
  });

  it('bakes each stable piece once: a frame fills only the tail on the live canvas', () => {
    preview.begin({ color: '#000000', opacity: 1 });
    const canvas = preview.liveCanvas as HTMLCanvasElement;
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    const fills = vi.spyOn(ctx, 'fill');
    const copies = vi.spyOn(ctx, 'drawImage');
    for (let n = 1; n <= 120; n++) preview.draw(growing(n));
    // One fill per frame (the tail); the pieces went to the backing canvas.
    expect(fills).toHaveBeenCalledTimes(120);
    expect(copies.mock.calls.length).toBeGreaterThan(100);
    expect(alphaAt(canvas, 30, 100)).toBe(255);
    expect(alphaAt(canvas, 150, 100)).toBe(255);
    fills.mockRestore();
    copies.mockRestore();
  });

  it('an opaque ink carries no CSS opacity, on the live or the settling canvas', () => {
    preview.begin({ color: '#000000', opacity: 1 });
    expect(preview.liveCanvas?.style.opacity).toBe('');
    for (let n = 1; n <= 20; n++) preview.draw(growing(n));
    const { element, release } = preview.settle();
    expect(element.style.opacity).toBe('');
    release();
  });

  it('bakes only the points the caller says are final', () => {
    preview.begin({ color: '#000000', opacity: 1 });
    const canvas = preview.liveCanvas as HTMLCanvasElement;
    // 60 points, of which the first 10 are final: the rest is redrawn as the tail.
    preview.draw(growing(60), [], false, 10);
    expect(preview.stats.pieces).toBe(1);
    expect(preview.stats.outlinedPoints).toBe(10 + 51);
    // A shorter path with the same final part: the tail's old pixels are gone.
    preview.draw(growing(12), [], false, 10);
    expect(alphaAt(canvas, 20 + 30 * 1.5, 100)).toBe(0);
    expect(alphaAt(canvas, 20 + 5 * 1.5, 100)).toBe(255);
  });

  it('draws predicted points for one frame only', () => {
    preview.begin({ color: '#000000', opacity: 1 });
    const canvas = preview.liveCanvas as HTMLCanvasElement;
    for (let n = 1; n <= 40; n++) preview.draw(growing(n));
    preview.draw(growing(41), [
      { x: 100, y: 100, w: 4 },
      { x: 130, y: 100, w: 4 },
    ]);
    expect(alphaAt(canvas, 125, 100)).toBe(255);
    preview.draw(growing(42));
    expect(alphaAt(canvas, 125, 100)).toBe(0);
    // What was drawn before stays.
    expect(alphaAt(canvas, 40, 100)).toBe(255);
  });

  it('draws the width of each point: thin at a light start, thick at the end', () => {
    preview.begin({ color: '#000000', opacity: 1 });
    const canvas = preview.liveCanvas as HTMLCanvasElement;
    const n = 160;
    for (let k = 1; k <= n; k++) preview.draw(growing(k, (i) => 2 + (10 * i) / (n - 1)));
    const start = thicknessAt(canvas, 30);
    const end = thicknessAt(canvas, 20 + 150 * 1.5);
    expect(start).toBeGreaterThan(1.5);
    expect(start).toBeLessThan(4.5);
    expect(end).toBeGreaterThan(9.5);
    expect(end).toBeGreaterThan(start * 2.5);
  });

  it('a restart rebuilds the outline (Shift straightened the stroke)', () => {
    preview.begin({ color: '#000000', opacity: 1 });
    const canvas = preview.liveCanvas as HTMLCanvasElement;
    const wavy: PreviewPath = {
      length: 30,
      x: (i) => 20 + i * 5,
      y: (i) => 100 + (i % 2 === 0 ? 30 : -30),
      w: () => 3,
    };
    for (let n = 1; n <= 30; n++) preview.draw({ ...wavy, length: n });
    expect(alphaAt(canvas, 20, 130)).toBe(255);
    preview.draw(
      previewPath(
        [
          { x: 20, y: 100 },
          { x: 165, y: 100 },
        ],
        [3, 3],
      ),
      [],
      true,
    );
    expect(alphaAt(canvas, 20, 130)).toBe(0);
    expect(alphaAt(canvas, 90, 100)).toBe(255);
  });

  it('settles to the committed outline on its own canvas and frees the live one', () => {
    preview.begin({ color: '#1e88e5', opacity: 0.8 });
    const live = preview.liveCanvas as HTMLCanvasElement;
    for (let n = 1; n <= 60; n++) preview.draw(growing(n));
    const points = [
      { x: 20, y: 100 },
      { x: 60, y: 90 },
      { x: 108.5, y: 100 },
    ];
    const widths = [3, 5, 7];
    const settled = preview.settle(previewPath(points, widths));
    const element = settled.element;
    expect(element.parentElement).toBe(host);
    expect(element.hasAttribute('data-settling')).toBe(true);
    expect(element.getAttribute('data-testid')).toBe('annotation-preview');
    expect(element.style.opacity).toBe('0.8');
    expect(alphaAt(live, 40, 100)).toBe(0);
    // Pixel for pixel the outline of the same centre line and widths (preview = commit).
    const reference = document.createElement('canvas');
    reference.width = element.width;
    reference.height = element.height;
    const ctx = reference.getContext('2d') as CanvasRenderingContext2D;
    const s = dpr();
    const left = Math.round(Number.parseFloat(element.style.left) * s);
    const top = Math.round(Number.parseFloat(element.style.top) * s);
    ctx.translate(-left, -top);
    ctx.fillStyle = '#1e88e5';
    ctx.fill(
      outlinePath(
        inkOutlineOps(
          points.map((p) => ({ x: p.x * s, y: p.y * s })),
          widths.map((w) => w * s),
        ),
      ),
    );
    const a = element.getContext('2d')?.getImageData(0, 0, element.width, element.height).data;
    const b = ctx.getImageData(0, 0, reference.width, reference.height).data;
    expect(a?.length).toBe(b.length);
    let differing = 0;
    for (let i = 0; i < b.length; i++) if (a?.[i] !== b[i]) differing++;
    expect(differing).toBe(0);
    expect(alphaAt(element, 60, 90)).toBe(255);
    settled.release();
    expect(element.isConnected).toBe(false);
  });

  it('settles without a final shape by keeping what was drawn', () => {
    preview.begin({ color: '#000000', opacity: 1 });
    for (let n = 1; n <= 50; n++) preview.draw(growing(n));
    const { element, release } = preview.settle();
    expect(alphaAt(element, 40, 100)).toBe(255);
    expect(alphaAt(element, 40, 112)).toBe(0);
    release();
    expect(host.querySelectorAll('[data-settling]')).toHaveLength(0);
  });

  it('turns outline operators into a path', () => {
    const path = outlinePath('0 0 m\n10 0 l\n10 10 l\n0 10 l\nh');
    const ctx = document.createElement('canvas').getContext('2d') as CanvasRenderingContext2D;
    expect(ctx.isPointInPath(path, 5, 5)).toBe(true);
    expect(ctx.isPointInPath(path, 15, 5)).toBe(false);
    const curve = outlinePath('0 0 m 0 10 10 10 10 0 c h');
    expect(ctx.isPointInPath(curve, 5, 6)).toBe(true);
  });
});
