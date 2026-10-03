/**
 * Variable-width stroke processing (experience-redesign spec §6.6, §9): the widths follow
 * the centre line through dedupe, Catmull-Rom and Douglas–Peucker, and the outline is
 * simplified at 0.1 pt.
 */
import { describe, expect, it } from 'vitest';

import {
  catmullRom,
  finishInkStroke,
  finishStroke,
  inkDedupeDistance,
  INK_DEDUPE_PT,
  INK_MOUSE_DEDUPE_CSS_PX,
  INK_OUTLINE_TOLERANCE_PT,
  INK_TOLERANCE_PT,
  InkStrokeModel,
  smoothPiece,
  smoothStroke,
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

/** A cursive-like stroke with uneven spacing and varying width (CSS px, pt widths). */
function cursive(n = 240): WidthPoint[] {
  return Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1);
    const s = t + 0.05 * Math.sin(t * 37);
    return {
      x: 30 + 300 * s + 20 * Math.sin(s * 19),
      y: 100 + 40 * Math.cos(s * 13) + (i % 3) * 0.2,
      w: 1 + Math.abs(Math.sin(t * 5)),
    };
  });
}

describe('one stroke model (craft spec §5.2 item 2)', () => {
  it('dedupes at 0.5 pt, and at 1.5 CSS px or more for a mouse', () => {
    expect(inkDedupeDistance('pen', 2)).toBeCloseTo(INK_DEDUPE_PT * 2, 2);
    expect(inkDedupeDistance('pen', 2)).toBeGreaterThan(INK_DEDUPE_PT * 2);
    expect(inkDedupeDistance('mouse', 4 / 3)).toBe(INK_MOUSE_DEDUPE_CSS_PX);
    expect(inkDedupeDistance('mouse', 8)).toBeCloseTo(INK_DEDUPE_PT * 8, 2);
  });

  it('smooths all but the last two kept points as they arrive; that part never changes', () => {
    const model = new InkStrokeModel(0.7);
    const snapshots: WidthPoint[][] = [];
    for (const p of cursive()) {
      model.add(p);
      snapshots.push([...model.smooth]);
      const m = model.kept.length;
      // The smoothed part ends at the last kept point but one.
      if (m >= 2) expect(model.smooth.at(-1)).toEqual(model.kept[m - 2]);
      // Then the raw tip: the last kept point and the newest sample.
      expect(model.tip()[0]).toEqual(m >= 2 ? model.kept[m - 1] : undefined);
    }
    // Append-only: every earlier frame is a prefix of the last.
    const final = model.smooth;
    for (const snap of snapshots) expect(final.slice(0, snap.length)).toEqual(snap);
    // Four points per segment.
    expect(final.length).toBe(1 + 4 * (model.kept.length - 2));
  });

  it('finish() is what finishInkStroke smooths from the handover, before simplification', () => {
    const model = new InkStrokeModel(inkDedupeDistance('pen', 1));
    for (const p of cursive()) model.add(p);
    const handover = model.handover();
    expect(model.finish()).toEqual(smoothStroke(handover));
    // In points (here 1 CSS px per pt), the commit's own dedupe keeps every handed point...
    const done = finishInkStroke(handover);
    // ...so every committed point lies on the smoothed curve (rounded to 0.01 pt).
    const curve = model.finish();
    for (const p of done.points) {
      const near = curve.some((q) => Math.abs(q.x - p.x) <= 0.006 && Math.abs(q.y - p.y) <= 0.006);
      expect(near).toBe(true);
    }
  });

  it('is the same curve in CSS px and in points (a similarity apart)', () => {
    const css = cursive(120);
    const scale = 4 / 3;
    const inPt = smoothStroke(css.map((p) => ({ x: p.x / scale, y: 800 - p.y / scale, w: p.w })));
    const inCss = smoothStroke(css);
    expect(inPt).toHaveLength(inCss.length);
    inCss.forEach((p, i) => {
      expect(inPt[i]?.x ?? 0).toBeCloseTo(p.x / scale, 9);
      expect(inPt[i]?.y ?? 0).toBeCloseTo(800 - p.y / scale, 9);
      expect(inPt[i]?.w ?? 0).toBeCloseTo(p.w, 9);
    });
  });

  it('centripetal: no loop or overshoot where a short segment meets long ones', () => {
    const kept: WidthPoint[] = [
      { x: 0, y: 0, w: 1 },
      { x: 100, y: 0, w: 1 },
      { x: 101, y: 1, w: 1 },
      { x: 101, y: 100, w: 1 },
    ];
    const curve = smoothPiece(kept, 0, 3, [kept[0] as WidthPoint]);
    // Uniform Catmull-Rom swings well past the corner here; centripetal stays close.
    const most = (ps: readonly { x: number; y: number }[]) => Math.max(...ps.map((p) => p.x));
    expect(most(catmullRom(kept))).toBeGreaterThan(105);
    expect(most(curve)).toBeLessThan(102.5);
    for (const p of curve) expect(p.y).toBeGreaterThan(-2.5);
  });
});
