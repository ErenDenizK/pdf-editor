import { describe, expect, it } from 'vitest';

import { correctRotatedRect } from './engine-quirks';
import {
  cssBoxToUser,
  cssPointToUser,
  displayRect,
  dragAnnotation,
  noteIconRect,
  noteRectForIcon,
  type PageFrame,
  rectToCss,
  resizeAnnotation,
  translateAnnotation,
  userToCss,
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

describe('note icons (NoRotate)', () => {
  type Turn = 0 | 90 | 180 | 270;
  const TURNS: readonly Turn[] = [0, 90, 180, 270];
  /** A frame for a page with /Rotate `intrinsic`, turned `view` more in the app. */
  const noteFrame = (intrinsic: Turn, view: Turn = 0, scale = 1.5): PageFrame => ({
    size: A4,
    originX: 10,
    originY: 20,
    rotation: ((intrinsic + view) % 360) as Turn,
    intrinsicRotation: intrinsic,
    scale,
  });
  // Not square, so a swapped width and height would show.
  const rect = { x: 72, y: 580, width: 24, height: 16 };
  const note = { id: 'n', kind: 'text' as const, pageIndex: 0, rect };
  const close = (actual: Record<string, number>, expected: Record<string, number>) => {
    for (const key of Object.keys(expected)) expect(actual[key]).toBeCloseTo(expected[key] ?? 0, 6);
  };

  it('on a /Rotate 90 page the icon hangs right of the /Rect, not on it', () => {
    const f: PageFrame = {
      size: A4,
      originX: 0,
      originY: 0,
      rotation: 90,
      intrinsicRotation: 90,
      scale: 1,
    };
    const r = { x: 72, y: 580, width: 20, height: 20 };
    // The /Rect's own footprint is display x 580–600, y 72–92; PDFium draws at x 600–620.
    expect(rectToCss(f, r)).toEqual({ left: 580, top: 72, width: 20, height: 20 });
    expect(rectToCss(f, noteIconRect(f, r))).toEqual({ left: 600, top: 72, width: 20, height: 20 });
  });

  it('draws the icon upright from the upper-left corner at every /Rotate', () => {
    for (const intrinsic of TURNS) {
      const f = noteFrame(intrinsic);
      const anchor = userToCss(f, { x: rect.x, y: rect.y + rect.height });
      close(
        { ...rectToCss(f, displayRect(f, note)) },
        {
          left: anchor.x,
          top: anchor.y,
          width: rect.width * f.scale,
          height: rect.height * f.scale,
        },
      );
    }
    // /Rotate 0: the icon is the /Rect.
    expect(noteIconRect(noteFrame(0), rect)).toEqual(rect);
  });

  it('turns the icon with the page for the app view rotation', () => {
    for (const intrinsic of TURNS) {
      const upright = rectToCss(
        noteFrame(intrinsic, 0, 1),
        noteIconRect(noteFrame(intrinsic), rect),
      );
      // The displayed page before the view rotation, turned 90° clockwise by it.
      const quarter = intrinsic === 90 || intrinsic === 270;
      const shownHeight = quarter ? A4.width : A4.height;
      const turned = rectToCss(
        noteFrame(intrinsic, 90, 1),
        displayRect(noteFrame(intrinsic, 90), note),
      );
      close(
        { ...turned },
        {
          left: shownHeight - (upright.top + upright.height),
          top: upright.left,
          width: upright.height,
          height: upright.width,
        },
      );
    }
    // Without an intrinsic /Rotate the icon sits on its /Rect however the app turns it.
    for (const view of TURNS) {
      const f = noteFrame(0, view);
      expect(rectToCss(f, displayRect(f, note))).toEqual(rectToCss(f, rect));
    }
  });

  it('recovers the /Rect from the icon', () => {
    for (const intrinsic of TURNS) {
      const f = noteFrame(intrinsic);
      expect(noteRectForIcon(f, noteIconRect(f, rect))).toEqual(rect);
    }
  });

  it('a dragged note lands its icon where it was dropped', () => {
    const from = { x: 300, y: 200 };
    const to = { x: 345, y: 182 };
    for (const intrinsic of TURNS) {
      for (const view of TURNS) {
        const f = noteFrame(intrinsic, view);
        const before = rectToCss(f, displayRect(f, note));
        const moved = dragAnnotation(f, note, from, to);
        const after = rectToCss(f, displayRect(f, moved));
        close(
          { ...after },
          {
            left: before.left + to.x - from.x,
            top: before.top + to.y - from.y,
            width: before.width,
            height: before.height,
          },
        );
        // The /Rect keeps its meaning and size: it moved by the user-space drag.
        const p0 = cssPointToUser(f, from);
        const p1 = cssPointToUser(f, to);
        close({ ...moved.rect }, { ...translateAnnotation(note, p1.x - p0.x, p1.y - p0.y).rect });
        expect(moved.rect.width).toBe(rect.width);
        expect(moved.rect.height).toBe(rect.height);
      }
    }
  });

  it('other annotations keep their rect', () => {
    const square = { id: 's', kind: 'square' as const, pageIndex: 0, rect, strokeWidth: 1 };
    const f = noteFrame(90);
    expect(displayRect(f, square)).toEqual(rect);
    const p0 = cssPointToUser(f, { x: 0, y: 0 });
    const p1 = cssPointToUser(f, { x: 10, y: 4 });
    expect(dragAnnotation(f, square, { x: 0, y: 0 }, { x: 10, y: 4 })).toEqual(
      translateAnnotation(square, p1.x - p0.x, p1.y - p0.y),
    );
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
