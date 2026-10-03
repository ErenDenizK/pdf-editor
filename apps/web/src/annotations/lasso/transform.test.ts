/**
 * Group resize and rotate (craft spec §5.5, WP P12), kind by kind: scale is affine for ink
 * (widths × √(sx·sy)) and vertex kinds, rect kinds scale their rect, stamps keep their
 * aspect, free text scales its font only under uniform scale, notes and markups translate;
 * rotation is affine for ink and vertex kinds, and everything else orbits unrotated.
 */
import type { Rect } from '@pdf-editor/document-model';
import type {
  Annotation,
  FreeTextAnnotation,
  InkAnnotation,
  MarkupAnnotation,
  NoteAnnotation,
  ShapeAnnotation,
  StampAnnotation,
} from '@pdf-editor/engine';
import { describe, expect, it } from 'vitest';

import { cssPointToUser, type PageFrame, userToCss } from '../geometry';
import {
  applyAffine,
  handleScale,
  invert,
  keyDegrees,
  keyScale,
  lengthScale,
  multiply,
  normalizeDegrees,
  oppositeHandle,
  rotation,
  scaling,
  splitLassoInk,
  transformAnnotation,
  uniformScale,
  userTransform,
} from './transform';

const base = { pageIndex: 0, color: '#1A1A1A' } as const;

const ink: InkAnnotation = {
  ...base,
  id: 'ink',
  kind: 'ink',
  rect: { x: 0, y: 0, width: 1, height: 1 },
  strokeWidth: 2,
  paths: [
    [
      { x: 100, y: 100 },
      { x: 120, y: 110 },
      { x: 140, y: 100 },
    ],
    [
      { x: 100, y: 200 },
      { x: 140, y: 200 },
    ],
  ],
  widths: [
    [2, 3, 2],
    [1, 1],
  ],
};

const arrow: ShapeAnnotation = {
  ...base,
  id: 'arrow',
  kind: 'line',
  rect: { x: 94, y: 94, width: 112, height: 22 },
  strokeWidth: 2,
  vertices: [
    { x: 100, y: 100 },
    { x: 200, y: 110 },
  ],
  lineEndings: { end: 'open-arrow' },
};

const square: ShapeAnnotation = {
  ...base,
  id: 'square',
  kind: 'square',
  rect: { x: 100, y: 100, width: 40, height: 20 },
  strokeWidth: 1,
};

const text: FreeTextAnnotation = {
  ...base,
  id: 'text',
  kind: 'free-text',
  rect: { x: 100, y: 100, width: 80, height: 20 },
  text: 'Hello',
  fontSize: 12,
};

const stamp: StampAnnotation = {
  ...base,
  id: 'stamp',
  kind: 'stamp',
  rect: { x: 100, y: 100, width: 60, height: 20 },
  name: 'Approved',
};

const note: NoteAnnotation = {
  ...base,
  id: 'note',
  kind: 'text',
  rect: { x: 200, y: 300, width: 20, height: 20 },
  icon: 'Comment',
};

const highlight: MarkupAnnotation = {
  ...base,
  id: 'hl',
  kind: 'highlight',
  rect: { x: 100, y: 100, width: 50, height: 30 },
  quads: [
    { x: 100, y: 120, width: 50, height: 10 },
    { x: 100, y: 100, width: 30, height: 10 },
  ],
};

const centreOf = (r: Rect) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

describe('affine helpers', () => {
  it('compose, invert, scale and turn', () => {
    const s = scaling({ x: 10, y: 20 }, 2, 3);
    expect(applyAffine(s, { x: 10, y: 20 })).toEqual({ x: 10, y: 20 });
    expect(applyAffine(s, { x: 11, y: 21 })).toEqual({ x: 12, y: 23 });
    const r = rotation({ x: 0, y: 0 }, 90);
    const p = applyAffine(r, { x: 1, y: 0 });
    // In CSS pixels (y down), +90° turns right into down: clockwise on screen.
    expect(p.x).toBeCloseTo(0, 9);
    expect(p.y).toBeCloseTo(1, 9);
    const back = applyAffine(multiply(invert(s), s), { x: 5, y: 7 });
    expect(back.x).toBeCloseTo(5, 9);
    expect(back.y).toBeCloseTo(7, 9);
    expect(lengthScale(s)).toBeCloseTo(Math.sqrt(6), 9);
    expect(lengthScale(r)).toBeCloseTo(1, 9);
    expect(uniformScale(scaling({ x: 0, y: 0 }, 2, 2))).toBe(true);
    expect(uniformScale(s)).toBe(false);
    expect(uniformScale(r)).toBe(false);
  });

  it('carries a screen transform to user space through the frame (y flips, rotation)', () => {
    const frame: PageFrame = {
      size: { width: 600, height: 800 },
      originX: 0,
      originY: 0,
      rotation: 90,
      scale: 1.5,
    };
    // A 2× horizontal scale on screen of a page shown turned 90° is a vertical one in user space.
    const css = scaling({ x: 100, y: 100 }, 2, 1);
    const user = userTransform(frame, css);
    expect(Math.abs(user.a)).toBeCloseTo(1, 9);
    expect(Math.abs(user.d)).toBeCloseTo(2, 9);
    // It agrees with mapping through CSS for any point.
    const p = { x: 210, y: 340 };
    const expected = cssPointToUser(frame, applyAffine(css, userToCss(frame, p)));
    const got = applyAffine(user, p);
    expect(got.x).toBeCloseTo(expected.x, 6);
    expect(got.y).toBeCloseTo(expected.y, 6);
    // A clockwise turn on screen is clockwise on the page too (negative in user space, y up).
    const turn = userTransform({ ...frame, rotation: 0 }, rotation({ x: 0, y: 0 }, 90));
    const o = applyAffine(turn, { x: 0, y: 0 });
    const q = applyAffine(turn, { x: 1, y: 0 });
    expect(q.x - o.x).toBeCloseTo(0, 6);
    expect(q.y - o.y).toBeCloseTo(-1, 6);
  });
});

describe('scale, kind by kind', () => {
  const double = scaling({ x: 100, y: 100 }, 2, 2);
  const wide = scaling({ x: 100, y: 100 }, 3, 1);

  it('ink: points mapped, widths and the nominal width × √(sx·sy), rect recomputed', () => {
    const out = transformAnnotation(ink, wide) as InkAnnotation;
    expect(out.paths[0]).toEqual([
      { x: 100, y: 100 },
      { x: 160, y: 110 },
      { x: 220, y: 100 },
    ]);
    const k = Math.sqrt(3);
    expect(out.strokeWidth).toBeCloseTo(2 * k, 2);
    expect(out.widths?.[0]?.[1]).toBeCloseTo(3 * k, 2);
    expect(out.widths?.map((w) => w.length)).toEqual([3, 2]);
    // The rect encloses the paths at the widest width.
    expect(out.rect.x).toBeLessThanOrEqual(100 - (3 * k) / 2);
    expect(out.rect.x + out.rect.width).toBeGreaterThanOrEqual(220 + (3 * k) / 2);
  });

  it('line and arrow: vertices mapped, stroke width kept', () => {
    const out = transformAnnotation(arrow, double) as ShapeAnnotation;
    expect(out.vertices).toEqual([
      { x: 100, y: 100 },
      { x: 300, y: 120 },
    ]);
    expect(out.strokeWidth).toBe(2);
    expect(out.lineEndings).toEqual(arrow.lineEndings);
    expect(out.rect.x + out.rect.width).toBeGreaterThan(300);
  });

  it('rectangle: its rect scales about the origin', () => {
    expect(transformAnnotation(square, wide).rect).toEqual({
      x: 100,
      y: 100,
      width: 120,
      height: 20,
    });
  });

  it('free text: font size scales only under uniform scale', () => {
    const uniform = transformAnnotation(text, double) as FreeTextAnnotation;
    expect(uniform.fontSize).toBe(24);
    expect(uniform.rect).toEqual({ x: 100, y: 100, width: 160, height: 40 });
    const stretched = transformAnnotation(text, wide) as FreeTextAnnotation;
    expect(stretched.fontSize).toBe(12);
    expect(stretched.rect.width).toBe(240);
  });

  it('stamp: keeps its aspect (the smaller factor), centred where its centre goes', () => {
    const out = transformAnnotation(stamp, wide) as StampAnnotation;
    expect(out.rect.width / out.rect.height).toBeCloseTo(3, 6);
    expect(out.rect.width).toBe(60);
    const c = centreOf(out.rect);
    expect(c).toEqual(applyAffine(wide, centreOf(stamp.rect)));
    const grown = transformAnnotation(stamp, double).rect;
    expect(grown.width).toBe(120);
    expect(grown.height).toBe(40);
  });

  it('note: moves with the group, icon size kept', () => {
    const out = transformAnnotation(note, double);
    expect(out.rect.width).toBe(20);
    expect(out.rect.height).toBe(20);
    // Its centre (210, 310) goes to (320, 520).
    expect(centreOf(out.rect)).toEqual({ x: 320, y: 520 });
  });

  it('note: on a /Rotate page it follows its icon, not its /Rect', () => {
    const frame: PageFrame = {
      size: { width: 600, height: 800 },
      originX: 0,
      originY: 0,
      rotation: 90,
      intrinsicRotation: 90,
      scale: 1,
    };
    const out = transformAnnotation(note, double, frame);
    expect(out.rect.width).toBe(20);
    // The icon is drawn at (200, 320)–(220, 340): centre (210, 330) → (320, 560).
    expect(out.rect.x - note.rect.x).toBeCloseTo(110, 6);
    expect(out.rect.y - note.rect.y).toBeCloseTo(230, 6);
  });

  it('text markups: quads translated only, never scaled', () => {
    const out = transformAnnotation(highlight, double) as MarkupAnnotation;
    expect(out.quads.map((r) => [r.width, r.height])).toEqual([
      [50, 10],
      [30, 10],
    ]);
    // The quads' centre (125, 115) goes to (150, 130): a translation by (25, 15).
    expect(out.quads[0]).toEqual({ x: 125, y: 135, width: 50, height: 10 });
    expect(out.rect).toEqual({ x: 125, y: 115, width: 50, height: 30 });
  });
});

describe('rotation, kind by kind', () => {
  const centre = { x: 150, y: 150 };
  const quarter = rotation(centre, 90);

  it('ink: points turn, widths stay', () => {
    const out = transformAnnotation(ink, quarter) as InkAnnotation;
    // (100, 100) turns about (150, 150) to (200, 100).
    expect(out.paths[0]?.[0]).toEqual({ x: 200, y: 100 });
    expect(out.widths).toEqual(ink.widths);
    expect(out.strokeWidth).toBe(2);
  });

  it('arrow: vertices turn', () => {
    const out = transformAnnotation(arrow, quarter) as ShapeAnnotation;
    expect(out.vertices?.[0]).toEqual({ x: 200, y: 100 });
    expect(out.vertices?.[1]).toEqual({ x: 190, y: 200 });
  });

  it('rectangle, ellipse, free text and stamp orbit the centre unrotated', () => {
    for (const a of [square, { ...square, kind: 'circle' } as Annotation, text, stamp]) {
      const out = transformAnnotation(a, rotation(centre, 90));
      expect(out.rect.width).toBe(a.rect.width);
      expect(out.rect.height).toBe(a.rect.height);
      const c = applyAffine(quarter, centreOf(a.rect));
      expect(centreOf(out.rect).x).toBeCloseTo(c.x, 1);
      expect(centreOf(out.rect).y).toBeCloseTo(c.y, 1);
    }
    expect((transformAnnotation(text, quarter) as FreeTextAnnotation).fontSize).toBe(12);
  });

  it('note orbits; a text markup translates its quads only', () => {
    const n = transformAnnotation(note, quarter);
    // Its centre (210, 310) turns about (150, 150) to (-10, 210).
    expect(centreOf(n.rect).x).toBeCloseTo(-10, 6);
    expect(centreOf(n.rect).y).toBeCloseTo(210, 6);
    const h = transformAnnotation(highlight, quarter) as MarkupAnnotation;
    expect(h.quads.map((r) => [r.width, r.height])).toEqual([
      [50, 10],
      [30, 10],
    ]);
  });
});

describe('splitLassoInk', () => {
  const double = scaling({ x: 100, y: 100 }, 2, 2);

  it('a whole ink carries the transform in place', () => {
    const out = splitLassoInk(ink, [0, 1], { kind: 'transform', matrix: double }, 'new');
    expect(out.create).toBeUndefined();
    expect(out.update?.id).toBe('ink');
    expect(out.update?.paths[1]?.[1]).toEqual({ x: 180, y: 300 });
    expect(out.update?.widths?.[0]?.[1]).toBe(6);
    expect(out.picks).toEqual({ ink: [0, 1] });
  });

  it('some paths: the rest keeps the id unchanged, the taken ones split off transformed', () => {
    const out = splitLassoInk(ink, [1], { kind: 'transform', matrix: double }, 'new');
    expect(out.update?.paths).toEqual([ink.paths[0]]);
    expect(out.update?.widths).toEqual([ink.widths?.[0]]);
    expect(out.create?.id).toBe('new');
    expect(out.create?.paths).toEqual([
      [
        { x: 100, y: 300 },
        { x: 180, y: 300 },
      ],
    ]);
    expect(out.create?.widths).toEqual([[2, 2]]);
    expect(out.create?.strokeWidth).toBe(4);
    expect(out.picks).toEqual({ new: [0] });
  });

  it('other edits keep the split rule as it was', () => {
    const out = splitLassoInk(ink, [1], { kind: 'move', dx: 5, dy: 0 }, 'new');
    expect(out.create?.paths[0]?.[0]).toEqual({ x: 105, y: 200 });
  });
});

describe('handle arithmetic', () => {
  const box = { left: 100, top: 100, width: 200, height: 100 };

  it('scales about the opposite edge or corner, never below 4 px or flipped', () => {
    expect(oppositeHandle('nw')).toBe('se');
    expect(oppositeHandle('e')).toBe('w');
    expect(handleScale(box, 'se', 100, 50, false)).toEqual({
      sx: 1.5,
      sy: 1.5,
      origin: { x: 100, y: 100 },
    });
    const west = handleScale(box, 'w', -100, 30, false);
    expect(west).toEqual({ sx: 1.5, sy: 1, origin: { x: 300, y: 150 } });
    const flipped = handleScale(box, 'e', -500, 0, false);
    expect(flipped.sx).toBeCloseTo(4 / 200, 9);
  });

  it('Shift on a corner keeps the aspect (the larger factor); edges ignore it', () => {
    const free = handleScale(box, 'ne', 100, 0, false);
    expect(free.sx).toBe(1.5);
    expect(free.sy).toBe(1);
    const locked = handleScale(box, 'ne', 100, 0, true);
    expect(locked.sx).toBe(1.5);
    expect(locked.sy).toBe(1.5);
    expect(locked.origin).toEqual({ x: 100, y: 200 });
    expect(handleScale(box, 'e', 100, 0, true).sy).toBe(1);
  });

  it('keys: Shift+Right grows from the left edge, Up shrinks from the top; Alt turns 1°', () => {
    expect(keyScale(box, 'ArrowRight', 2)).toEqual({ sx: 1.01, sy: 1, origin: { x: 100, y: 100 } });
    expect(keyScale(box, 'ArrowUp', 2)).toEqual({ sx: 1, sy: 0.98, origin: { x: 100, y: 100 } });
    expect(keyScale(box, 'Enter', 2)).toBeUndefined();
    expect(keyDegrees('ArrowRight', 1)).toBe(1);
    expect(keyDegrees('ArrowUp', 1)).toBe(-1);
    expect(normalizeDegrees(190)).toBe(-170);
    expect(normalizeDegrees(-180)).toBe(180);
  });
});
