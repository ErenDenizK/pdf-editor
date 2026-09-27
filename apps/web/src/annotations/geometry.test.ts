import { describe, expect, it } from 'vitest';

import { correctRotatedRect } from './engine-quirks';
import {
  cssBoxToUser,
  cssPointToUser,
  rectToCss,
  resizeAnnotation,
  translateAnnotation,
} from './geometry';
import { catmullRom, finishStroke, simplify, snapAngle, snapSquare } from './ink';
import { glyphIndexAt, mergeLineQuads, quadPoints, quadsForRange } from './quads';

const A4 = { width: 595.28, height: 841.89 };
const frame = (rotation: 0 | 90 | 180 | 270, scale = 2) => ({
  size: A4,
  originX: 0,
  originY: 0,
  rotation,
  scale,
});

describe('page geometry', () => {
  it('maps CSS points to unrotated user space for every rotation', () => {
    // The top-left corner of the displayed page.
    expect(cssPointToUser(frame(0), { x: 0, y: 0 })).toEqual({ x: 0, y: A4.height });
    expect(cssPointToUser(frame(90), { x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
    expect(cssPointToUser(frame(180), { x: 0, y: 0 })).toEqual({ x: A4.width, y: 0 });
    expect(cssPointToUser(frame(270), { x: 0, y: 0 })).toEqual({ x: A4.width, y: A4.height });
  });

  it('round-trips rectangles through CSS on rotated pages', () => {
    const rect = { x: 100, y: 200, width: 50, height: 30 };
    for (const rotation of [0, 90, 180, 270] as const) {
      const f = frame(rotation, 1.5);
      const back = cssBoxToUser(f, rectToCss(f, rect));
      expect(back.x).toBeCloseTo(rect.x, 6);
      expect(back.y).toBeCloseTo(rect.y, 6);
      expect(back.width).toBeCloseTo(rect.width, 6);
      expect(back.height).toBeCloseTo(rect.height, 6);
    }
  });

  it('on a /Rotate 90 page a CSS box maps with axes swapped', () => {
    // Displayed 841.89 × 595.28; CSS x runs along user y, CSS y along user x.
    const rect = cssBoxToUser(frame(90, 1), { left: 200, top: 100, width: 80, height: 40 });
    expect(rect).toEqual({ x: 100, y: 200, width: 40, height: 80 });
  });

  it('moves and resizes annotations with their geometry', () => {
    const ink = {
      id: 'a',
      kind: 'ink' as const,
      pageIndex: 0,
      rect: { x: 0, y: 0, width: 10, height: 10 },
      strokeWidth: 1,
      paths: [
        [
          { x: 0, y: 0 },
          { x: 10, y: 10 },
        ],
      ],
    };
    const moved = translateAnnotation(ink, 5, -2);
    expect(moved.kind === 'ink' && moved.paths[0]).toEqual([
      { x: 5, y: -2 },
      { x: 15, y: 8 },
    ]);
    const big = resizeAnnotation(ink, ink.rect, { x: 0, y: 0, width: 20, height: 20 });
    expect(big.rect).toEqual({ x: 0, y: 0, width: 20, height: 20 });
    expect(big.kind === 'ink' && big.paths[0]?.[1]).toEqual({ x: 20, y: 20 });
  });

  it('inverts the EmbedPDF rotated /Rect read-back', () => {
    // Square written at {100, 200, 50, 30} on /Rotate 90, read back as {100, 230, 30, 50}.
    expect(correctRotatedRect({ x: 100, y: 230, width: 30, height: 50 }, 1)).toEqual({
      x: 100,
      y: 200,
      width: 50,
      height: 30,
    });
    expect(correctRotatedRect({ x: 50, y: 230, width: 50, height: 30 }, 2)).toEqual({
      x: 100,
      y: 200,
      width: 50,
      height: 30,
    });
    expect(correctRotatedRect({ x: 70, y: 180, width: 30, height: 50 }, 3)).toEqual({
      x: 100,
      y: 200,
      width: 50,
      height: 30,
    });
  });
});

describe('ink', () => {
  it('Douglas–Peucker drops points within the tolerance', () => {
    const line = Array.from({ length: 50 }, (_, i) => ({ x: i, y: i % 2 === 0 ? 0 : 0.1 }));
    expect(simplify(line, 0.3)).toEqual([line[0], line[49]]);
    const corner = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ];
    expect(simplify(corner, 0.3)).toEqual(corner);
  });

  it('Catmull-Rom passes through the input points', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 5 },
      { x: 20, y: 0 },
    ];
    const smooth = catmullRom(points, 4);
    expect(smooth).toHaveLength(9);
    expect(smooth[4]).toEqual({ x: 10, y: 5 });
    expect(smooth[8]).toEqual({ x: 20, y: 0 });
  });

  it('finishes strokes smooth and simplified', () => {
    const raw = Array.from({ length: 200 }, (_, i) => ({
      x: i,
      y: Math.sin(i / 20) * 30,
    }));
    const stroke = finishStroke(raw);
    expect(stroke.length).toBeLessThan(80);
    expect(stroke[0]).toEqual({ x: 0, y: 0 });
  });

  it('Shift constrains lines to 45° and shapes to squares', () => {
    const end = snapAngle({ x: 0, y: 0 }, { x: 10, y: 1 });
    expect(end.x).toBeCloseTo(Math.hypot(10, 1));
    expect(end.y).toBeCloseTo(0);
    expect(snapSquare({ x: 0, y: 0 }, { x: 10, y: -4 })).toEqual({ x: 10, y: -10 });
  });
});

describe('text markup quads', () => {
  const glyphs = (text: string, x: number, y: number) =>
    Array.from(text, (ch, i) => ({
      text: ch,
      rect: { x: x + i * 6, y, width: ch === ' ' ? 0 : 5, height: 10 },
      fontSize: 10,
    }));
  const runs = [
    {
      text: 'Hello',
      rect: { x: 72, y: 700, width: 29, height: 10 },
      glyphs: glyphs('Hello', 72, 700),
    },
    {
      text: 'world',
      rect: { x: 104, y: 700, width: 29, height: 10 },
      glyphs: glyphs('world', 104, 700),
    },
    {
      text: 'Second',
      rect: { x: 72, y: 680, width: 35, height: 10 },
      glyphs: glyphs('Second', 72, 680),
    },
  ];

  it('finds the glyph under a point', () => {
    expect(glyphIndexAt(runs, { x: 73, y: 705 })).toBe(0);
    expect(glyphIndexAt(runs, { x: 105, y: 705 })).toBe(5);
    expect(glyphIndexAt(runs, { x: 500, y: 100 })).toBe(-1);
  });

  it('merges runs on one line into one quad per line', () => {
    const quads = quadsForRange(runs, 1, 12);
    expect(quads).toHaveLength(2);
    expect(quads[0]).toEqual({ x: 78, y: 700, width: 55, height: 10 });
    expect(quads[1]).toEqual({ x: 72, y: 680, width: 17, height: 10 });
  });

  it('keeps lines that do not touch apart', () => {
    const merged = mergeLineQuads([
      { rect: { x: 0, y: 0, width: 10, height: 10 }, dir: 'h' },
      { rect: { x: 200, y: 0, width: 10, height: 10 }, dir: 'h' },
    ]);
    expect(merged).toHaveLength(2);
  });

  it('writes QuadPoints upper-left, upper-right, lower-left, lower-right', () => {
    expect(quadPoints({ x: 10, y: 20, width: 30, height: 5 })).toEqual([
      10, 25, 40, 25, 10, 20, 40, 20,
    ]);
  });
});
