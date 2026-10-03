/**
 * The ink outline (ADR-0018 §3; craft spec §5.2 item 4): miters up to a 45° turn, round
 * joins above it (no spikes), bounds that hold the arcs, and the outline version carried by
 * `/PdfEditorInkWidths` (older versions still decode).
 */
import { describe, expect, test } from 'vitest';

import {
  decodeInkWidths,
  encodeInkWidths,
  INK_OUTLINE_VERSION,
  type InkPoint,
  inkOutlineBounds,
  inkOutlineOps,
  ROUND_JOIN_DEG,
} from './ink-outline';

/** The outline as one closed polygon: curves flattened into 16 pieces each. */
function flatten(ops: string): InkPoint[] {
  const out: InkPoint[] = [];
  const args: number[] = [];
  for (const token of ops.split(/\s+/)) {
    if (token === '') continue;
    if (token === 'm' || token === 'l') {
      out.push({ x: args[0] ?? 0, y: args[1] ?? 0 });
    } else if (token === 'c') {
      const p0 = out[out.length - 1] ?? { x: 0, y: 0 };
      const [x1 = 0, y1 = 0, x2 = 0, y2 = 0, x3 = 0, y3 = 0] = args;
      for (let s = 1; s <= 16; s++) {
        const t = s / 16;
        const u = 1 - t;
        out.push({
          x: u * u * u * p0.x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
          y: u * u * u * p0.y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
        });
      }
    } else if (token !== 'h') {
      args.push(Number(token));
      continue;
    }
    args.length = 0;
  }
  return out;
}

/** Nonzero winding number of `p` in the polygon. */
function winding(polygon: readonly InkPoint[], p: InkPoint): number {
  let w = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i] as InkPoint;
    const b = polygon[(i + 1) % polygon.length] as InkPoint;
    const cross = (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y);
    if (a.y <= p.y && b.y > p.y && cross > 0) w++;
    else if (a.y > p.y && b.y <= p.y && cross < 0) w--;
  }
  return w;
}

const filled = (ops: string, p: InkPoint) => winding(flatten(ops), p) !== 0;

function distanceToSegment(p: InkPoint, a: InkPoint, b: InkPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function distanceToPath(p: InkPoint, path: readonly InkPoint[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < path.length; i++) {
    best = Math.min(best, distanceToSegment(p, path[i] as InkPoint, path[i + 1] as InkPoint));
  }
  return best;
}

/** A corner at (50, 50): in from the left, out at `turnDeg` (counter-clockwise positive). */
function corner(turnDeg: number): InkPoint[] {
  const a = (turnDeg * Math.PI) / 180;
  return [
    { x: 0, y: 50 },
    { x: 50, y: 50 },
    { x: 50 + 50 * Math.cos(a), y: 50 + 50 * Math.sin(a) },
  ];
}

const curves = (ops: string) => ops.split('\n').filter((l) => l.endsWith(' c')).length;

describe('inkOutlineOps joins', () => {
  test('a turn of up to 45° is mitred: only the two caps are curves', () => {
    for (const turn of [10, 30, ROUND_JOIN_DEG - 1, -40]) {
      const ops = inkOutlineOps(corner(turn), [4, 4, 4]);
      // Each cap is two quarter circles.
      expect(curves(ops)).toBe(4);
    }
  });

  test('a sharper turn gets a round join on the outer side, both ways round', () => {
    for (const turn of [60, 90, 135, 179, -60, -120]) {
      const path = corner(turn);
      const ops = inkOutlineOps(path, [4, 4, 4]);
      expect(curves(ops)).toBeGreaterThan(4);
      // No edge point reaches past the half width (version 1 reached twice as far).
      for (const p of flatten(ops)) expect(distanceToPath(p, path)).toBeLessThan(2 + 0.02);
      // The corner's outer side is filled within the half width and not beyond it.
      const a = (turn * Math.PI) / 180;
      // The outer bisector: away from both segments.
      const outward = unitOf({ x: 1 - Math.cos(a), y: -Math.sin(a) });
      const at = (d: number) => ({ x: 50 + outward.x * d, y: 50 + outward.y * d });
      expect(filled(ops, at(1.8))).toBe(true);
      expect(filled(ops, at(2.4))).toBe(false);
      // The inner side and the centre are filled.
      expect(filled(ops, { x: 50, y: 50 })).toBe(true);
      expect(filled(ops, at(-1.5))).toBe(true);
    }
  });

  test('a scribble of reversals never spikes', () => {
    const path: InkPoint[] = Array.from({ length: 40 }, (_, i) => ({
      x: 10 + (i % 2) * 8 + i * 0.3,
      y: 10 + i * 1.5,
    }));
    const widths = path.map((_, i) => 2 + (i % 3));
    const ops = inkOutlineOps(path, widths);
    const maxHalf = Math.max(...widths) / 2;
    for (const p of flatten(ops)) expect(distanceToPath(p, path)).toBeLessThan(maxHalf * 1.09);
    // Every centre point is inside.
    for (const p of path) expect(filled(ops, p)).toBe(true);
  });

  test('variable widths: each join uses its own point’s width', () => {
    const path = corner(90);
    const ops = inkOutlineOps(path, [2, 10, 2]);
    // The round join at the corner has radius 5 (a miter would reach 7.07).
    const out = (d: number) => ({ x: 50 + d / Math.SQRT2, y: 50 - d / Math.SQRT2 });
    expect(filled(ops, out(4.5))).toBe(true);
    expect(filled(ops, out(5.5))).toBe(false);
  });

  test('a straight line and a dot are unchanged', () => {
    const line = inkOutlineOps(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      [2, 2],
    );
    expect(line.split('\n')[0]).toBe('0 1 m');
    expect(curves(line)).toBe(4);
    const dot = inkOutlineOps([{ x: 5, y: 5 }], [2]);
    expect(dot.split('\n')[0]).toBe('6 5 m');
  });
});

function unitOf(v: InkPoint): InkPoint {
  const l = Math.hypot(v.x, v.y);
  return { x: v.x / l, y: v.y / l };
}

describe('inkOutlineBounds', () => {
  test('holds every edge point and arc, with 0.5 pt of padding', () => {
    for (const turn of [20, 90, 150, -100]) {
      const path = corner(turn);
      const widths = [3, 6, 3];
      const box = inkOutlineBounds([path], [widths]);
      const outline = flatten(inkOutlineOps(path, widths));
      const xs = outline.map((p) => p.x);
      const ys = outline.map((p) => p.y);
      // The operators are rounded to 0.01 pt.
      expect(box.x).toBeLessThanOrEqual(Math.min(...xs) - 0.5 + 0.01);
      expect(box.y).toBeLessThanOrEqual(Math.min(...ys) - 0.5 + 0.01);
      expect(box.x + box.width).toBeGreaterThanOrEqual(Math.max(...xs) + 0.5 - 0.01);
      expect(box.y + box.height).toBeGreaterThanOrEqual(Math.max(...ys) + 0.5 - 0.01);
      // And not much more (tight to the outline within the padding plus rounding).
      expect(box.x).toBeGreaterThan(Math.min(...xs) - 0.5 - 0.02);
      expect(box.y + box.height).toBeLessThan(Math.max(...ys) + 0.5 + 0.02);
    }
  });
});

describe('outline version', () => {
  const paths = [corner(90), corner(10)];
  const widths = [
    [1, 2, 3],
    [4, 5, 6],
  ];

  test('new widths carry the current outline version', () => {
    expect(INK_OUTLINE_VERSION).toBe(2);
    expect(encodeInkWidths(widths)).toBe('2;1 2 3;4 5 6');
    expect(decodeInkWidths(encodeInkWidths(widths), paths)).toEqual(widths);
  });

  test('widths written by version 1 still decode (the stroke regenerates on its next edit)', () => {
    expect(decodeInkWidths('1;1 2 3;4 5 6', paths)).toEqual(widths);
  });

  test('an unknown version reads as no widths', () => {
    expect(decodeInkWidths('3;1 2 3;4 5 6', paths)).toBeUndefined();
    expect(decodeInkWidths('x;1 2 3;4 5 6', paths)).toBeUndefined();
  });
});
