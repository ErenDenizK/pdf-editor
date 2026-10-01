/**
 * Variable-width stroke processing (experience-redesign spec §6.6, §9): the widths follow
 * the centre line through dedupe, Catmull-Rom and Douglas–Peucker, and the outline is
 * simplified at 0.1 pt.
 */
import { describe, expect, it } from 'vitest';

import {
  finishInkStroke,
  finishStroke,
  INK_OUTLINE_TOLERANCE_PT,
  INK_TOLERANCE_PT,
  type WidthPoint,
} from './ink';

/** Linear interpolation of the input widths at `x` (inputs along the x axis). */
function widthAt(points: readonly WidthPoint[], x: number): number {
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i] as WidthPoint;
    const b = points[i + 1] as WidthPoint;
    if (x >= a.x && x <= b.x) return a.w + ((b.w - a.w) * (x - a.x)) / (b.x - a.x || 1);
  }
  return points[points.length - 1]?.w ?? 0;
}

describe('finishInkStroke', () => {
  it('keeps one width per point and resamples them to the points it keeps', () => {
    // A gentle curve whose width grows from 1 pt to 3 pt.
    const raw: WidthPoint[] = Array.from({ length: 200 }, (_, i) => ({
      x: i,
      y: Math.sin(i / 25) * 20,
      w: 1 + (2 * i) / 199,
    }));
    const done = finishInkStroke(raw);
    expect(done.widths).toHaveLength(done.points.length);
    expect(done.points.length).toBeLessThan(raw.length / 2);
    expect(done.points[0]).toEqual({ x: 0, y: 0 });
    expect(done.widths[0]).toBeCloseTo(1, 2);
    expect(done.widths[done.widths.length - 1]).toBeCloseTo(3, 2);
    // Each kept width is the input's width where the point lies, and they rise.
    for (const [i, p] of done.points.entries()) {
      expect(Math.abs((done.widths[i] ?? 0) - widthAt(raw, p.x))).toBeLessThan(0.02);
      if (i > 0) expect(done.widths[i]).toBeGreaterThanOrEqual(done.widths[i - 1] ?? 0);
    }
  });

  it('with constant widths writes the same centre line as finishStroke', () => {
    const raw = Array.from({ length: 150 }, (_, i) => ({
      x: i * 0.8,
      y: Math.cos(i / 15) * 12,
    }));
    const done = finishInkStroke(raw.map((p) => ({ ...p, w: 2 })));
    expect(done.points).toEqual(finishStroke(raw));
    expect(new Set(done.widths)).toEqual(new Set([2]));
  });

  it('keeps the points the outline needs within 0.1 pt', () => {
    // A straight line: the centre line alone simplifies to its two ends, but the width
    // swells in the middle.
    const raw: WidthPoint[] = Array.from({ length: 101 }, (_, i) => ({
      x: i,
      y: 0,
      w: 1 + 2 * Math.sin((Math.PI * i) / 100),
    }));
    expect(finishStroke(raw)).toHaveLength(2);
    const done = finishInkStroke(raw);
    expect(done.points.length).toBeGreaterThan(4);
    // Between kept points, the interpolated half width stays within the tolerance.
    for (const p of raw) {
      const k = done.points.findIndex((q) => q.x >= p.x);
      const b = done.points[k] as { x: number };
      const a = done.points[Math.max(0, k - 1)] as { x: number };
      const wa = done.widths[Math.max(0, k - 1)] ?? 0;
      const wb = done.widths[k] ?? 0;
      const t = b.x === a.x ? 0 : (p.x - a.x) / (b.x - a.x);
      const half = (wa + (wb - wa) * t) / 2;
      expect(Math.abs(half - p.w / 2)).toBeLessThan(INK_OUTLINE_TOLERANCE_PT + 0.02);
    }
    expect(INK_TOLERANCE_PT).toBe(0.3);
  });

  it('drops jitter with its widths and keeps the last point', () => {
    const raw: WidthPoint[] = [
      { x: 0, y: 0, w: 1 },
      { x: 0.1, y: 0, w: 5 },
      { x: 0.2, y: 0.1, w: 5 },
      { x: 10, y: 0, w: 2 },
      { x: 10.1, y: 0, w: 4 },
    ];
    const done = finishInkStroke(raw);
    expect(done.points[0]).toEqual({ x: 0, y: 0 });
    expect(done.widths[0]).toBe(1);
    expect(done.points[done.points.length - 1]).toEqual({ x: 10.1, y: 0 });
    expect(done.widths[done.widths.length - 1]).toBe(4);
    expect(done.widths.every((w) => w >= 0.01)).toBe(true);
  });
});
