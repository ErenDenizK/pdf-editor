/**
 * Lasso geometry (craft spec §5.5, after experience-redesign spec §6.5): containment,
 * crossings, path matching, and the hit test of every kind (inside, crossing, missed).
 */
import type { Rect } from '@pdf-editor/document-model';
import type { Annotation, InkAnnotation } from '@pdf-editor/engine';
import { describe, expect, it } from 'vitest';

import type { PageFrame } from '../geometry';
import {
  annotationTouchesPolygon,
  ellipseOutline,
  hitOutlines,
  lassoCount,
  lassoPicks,
  pathTouchesPolygon,
  pickCount,
  pickedCssBounds,
  pickedPaths,
  picksOfSelection,
  pointInPolygon,
  segmentsIntersect,
  thinTrail,
  translatePath,
} from './geometry';

const square = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 0, y: 10 },
];

function ink(id: string, paths: { x: number; y: number }[][], extra: Partial<InkAnnotation> = {}) {
  return {
    id,
    kind: 'ink',
    pageIndex: 0,
    rect: { x: 0, y: 0, width: 1, height: 1 },
    paths,
    strokeWidth: 2,
    ...extra,
  } as InkAnnotation;
}

describe('pointInPolygon', () => {
  it('tells inside from outside', () => {
    expect(pointInPolygon({ x: 5, y: 5 }, square)).toBe(true);
    expect(pointInPolygon({ x: 15, y: 5 }, square)).toBe(false);
    expect(pointInPolygon({ x: 5, y: -1 }, square)).toBe(false);
  });

  it('handles a concave lasso (a U shape)', () => {
    const u = [
      { x: 0, y: 0 },
      { x: 3, y: 0 },
      { x: 3, y: 7 },
      { x: 7, y: 7 },
      { x: 7, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    expect(pointInPolygon({ x: 5, y: 3 }, u)).toBe(false);
    expect(pointInPolygon({ x: 1, y: 3 }, u)).toBe(true);
    expect(pointInPolygon({ x: 5, y: 9 }, u)).toBe(true);
  });

  it('needs three points', () => {
    expect(pointInPolygon({ x: 0, y: 0 }, square.slice(0, 2))).toBe(false);
  });
});

describe('segmentsIntersect', () => {
  it('finds a proper crossing', () => {
    expect(
      segmentsIntersect({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 }),
    ).toBe(true);
  });

  it('finds touching ends and collinear overlap', () => {
    expect(segmentsIntersect({ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 })).toBe(
      true,
    );
    expect(segmentsIntersect({ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 3, y: 0 }, { x: 8, y: 0 })).toBe(
      true,
    );
  });

  it('rejects parallel, collinear-apart and near misses', () => {
    expect(
      segmentsIntersect({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 1 }, { x: 10, y: 1 }),
    ).toBe(false);
    expect(segmentsIntersect({ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }, { x: 5, y: 0 })).toBe(
      false,
    );
    expect(segmentsIntersect({ x: 0, y: 0 }, { x: 4, y: 4 }, { x: 5, y: 0 }, { x: 5, y: 10 })).toBe(
      false,
    );
  });
});

describe('path matching', () => {
  it('takes a path wholly inside, and one the lasso line crosses', () => {
    expect(
      pathTouchesPolygon(
        [
          { x: 2, y: 2 },
          { x: 8, y: 8 },
        ],
        square,
      ),
    ).toBe(true);
    // Both ends outside, the segment passes through the lasso.
    expect(
      pathTouchesPolygon(
        [
          { x: -5, y: 5 },
          { x: 15, y: 5 },
        ],
        square,
      ),
    ).toBe(true);
    // One point inside is enough.
    expect(
      pathTouchesPolygon(
        [
          { x: 5, y: 5 },
          { x: 50, y: 50 },
        ],
        square,
      ),
    ).toBe(true);
  });

  it('leaves a path that does not touch the region', () => {
    expect(
      pathTouchesPolygon(
        [
          { x: 12, y: 0 },
          { x: 12, y: 10 },
        ],
        square,
      ),
    ).toBe(false);
    // Inside the lasso's box but outside a triangle.
    const triangle = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 0, y: 10 },
    ];
    expect(
      pathTouchesPolygon(
        [
          { x: 8, y: 8 },
          { x: 9, y: 9 },
        ],
        triangle,
      ),
    ).toBe(false);
    expect(pathTouchesPolygon([], square)).toBe(false);
  });

  it('a dot (one point) matches by containment', () => {
    expect(pathTouchesPolygon([{ x: 5, y: 5 }], square)).toBe(true);
    expect(pathTouchesPolygon([{ x: 50, y: 5 }], square)).toBe(false);
  });

  it('picks paths per ink, skipping locked and hidden; other kinds are taken whole', () => {
    const annotations: Annotation[] = [
      ink('a', [
        [
          { x: 1, y: 1 },
          { x: 2, y: 2 },
        ],
        [
          { x: 30, y: 30 },
          { x: 31, y: 31 },
        ],
        [
          { x: -1, y: 5 },
          { x: 4, y: 5 },
        ],
      ]),
      ink('b', [
        [
          { x: 40, y: 40 },
          { x: 41, y: 41 },
        ],
      ]),
      ink(
        'locked',
        [
          [
            { x: 5, y: 5 },
            { x: 6, y: 6 },
          ],
        ],
        { flags: { locked: true } },
      ),
      ink(
        'hidden',
        [
          [
            { x: 5, y: 5 },
            { x: 6, y: 6 },
          ],
        ],
        { flags: { hidden: true } },
      ),
      {
        id: 'square',
        kind: 'square',
        pageIndex: 0,
        rect: { x: 2, y: 2, width: 2, height: 2 },
        color: '#000000',
        strokeWidth: 1,
      },
    ];
    const picks = lassoPicks(annotations, square);
    expect(picks).toEqual({ paths: { a: [0, 2] }, whole: ['square'] });
    expect(pickCount(picks.paths)).toBe(2);
    expect(lassoCount(picks)).toBe(3);
    expect(pickedPaths(annotations, picks.paths).map((p) => p.index)).toEqual([0, 2]);
    // The selection's lasso picks: its inks by path, every other one whole.
    expect(
      picksOfSelection(annotations.slice(0, 1).concat(annotations.slice(4)), picks.paths),
    ).toEqual(picks);
  });

  it('takes nothing with a degenerate lasso', () => {
    expect(lassoPicks([ink('a', [[{ x: 1, y: 1 }]])], square.slice(0, 2))).toEqual({
      paths: {},
      whole: [],
    });
  });

  it('bounds the picked paths in CSS pixels, grown by half the stroke', () => {
    const frame: PageFrame = {
      size: { width: 100, height: 100 },
      originX: 0,
      originY: 0,
      rotation: 0,
      scale: 2,
    };
    const a = ink('a', [
      [
        { x: 10, y: 90 },
        { x: 20, y: 80 },
      ],
      [
        { x: 60, y: 10 },
        { x: 70, y: 20 },
      ],
    ]);
    const box = pickedCssBounds(frame, [a], { a: [0] });
    // y flips: user y 90 is CSS 20 at scale 2; half the stroke is 2 CSS px.
    expect(box).toEqual({ left: 18, top: 18, width: 24, height: 24 });
    expect(pickedCssBounds(frame, [a], { b: [0] })).toBeNull();
  });
});

describe('helpers', () => {
  it('translates a path and thins a trail', () => {
    expect(translatePath([{ x: 1, y: 2 }], 3, -4)).toEqual([{ x: 4, y: -2 }]);
    expect(
      thinTrail(
        [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 2, y: 0 },
          { x: 5, y: 0 },
        ],
        2,
      ),
    ).toEqual([
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 5, y: 0 },
    ]);
  });
});

/** The lasso of the per-kind tests: a 100 pt square from the origin. */
const box = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 100 },
  { x: 0, y: 100 },
];

const pt = (x: number, y: number) => ({ x, y });

function shape(
  kind: 'line' | 'polyline' | 'polygon' | 'square' | 'circle',
  extra: Record<string, unknown>,
): Annotation {
  return {
    id: kind,
    kind,
    pageIndex: 0,
    rect: { x: 0, y: 0, width: 1, height: 1 },
    color: '#000000',
    strokeWidth: 2,
    ...extra,
  };
}

function boxed(kind: 'free-text' | 'stamp' | 'text', rect: Rect): Annotation {
  const extra =
    kind === 'free-text'
      ? { text: 'Hello', fontSize: 12 }
      : kind === 'stamp'
        ? { name: 'Draft' }
        : {};
  return { id: kind, kind, pageIndex: 0, rect, ...extra } as Annotation;
}

function markup(
  kind: 'highlight' | 'underline' | 'strikeout' | 'squiggly' | 'redact',
  quads: Rect[],
) {
  return { id: kind, kind, pageIndex: 0, rect: quads[0], quads, color: '#FFEA00' } as Annotation;
}

const rect = (x: number, y: number, width: number, height: number): Rect => ({
  x,
  y,
  width,
  height,
});

const hits = (a: Annotation, frame?: PageFrame) => annotationTouchesPolygon(a, box, frame);

describe('hit test per kind (craft spec §5.5)', () => {
  it('line and arrow: by vertices and segments', () => {
    const arrow = { lineEndings: { end: 'open-arrow' } };
    for (const extra of [{}, arrow]) {
      expect(hits(shape('line', { ...extra, vertices: [pt(10, 10), pt(20, 20)] }))).toBe(true);
      expect(hits(shape('line', { ...extra, vertices: [pt(-10, 50), pt(110, 50)] }))).toBe(true);
      expect(hits(shape('line', { ...extra, vertices: [pt(120, 0), pt(130, 10)] }))).toBe(false);
    }
  });

  it('polyline is open, polygon closed: only the closing edge crosses the lasso', () => {
    const vertices = [pt(110, 50), pt(150, 50), pt(150, -50), pt(-50, -50)];
    expect(hits(shape('polyline', { vertices }))).toBe(false);
    expect(hits(shape('polygon', { vertices }))).toBe(true);
    expect(hits(shape('polyline', { vertices: [pt(20, 20), pt(30, 40), pt(50, 20)] }))).toBe(true);
    expect(hits(shape('polygon', { vertices: [pt(200, 200), pt(300, 200), pt(250, 300)] }))).toBe(
      false,
    );
  });

  it('rectangle: by its edges (a rectangle around the lasso is not taken)', () => {
    expect(hits(shape('square', { rect: rect(20, 20, 10, 10) }))).toBe(true);
    expect(hits(shape('square', { rect: rect(50, 50, 100, 100) }))).toBe(true);
    expect(hits(shape('square', { rect: rect(-10, -10, 120, 120) }))).toBe(false);
    expect(hits(shape('square', { rect: rect(150, 150, 10, 10) }))).toBe(false);
  });

  it('ellipse: by 32 points on it, not its rect corners', () => {
    expect(ellipseOutline(rect(0, 0, 20, 10))).toHaveLength(33);
    expect(hits(shape('circle', { rect: rect(20, 20, 30, 20) }))).toBe(true);
    expect(hits(shape('circle', { rect: rect(80, 40, 40, 20) }))).toBe(true);
    // The rect's corner (95, 95) is inside the lasso; the ellipse itself stays outside.
    expect(hits(shape('circle', { rect: rect(95, 95, 40, 40) }))).toBe(false);
    expect(hits(shape('square', { rect: rect(95, 95, 40, 40) }))).toBe(true);
    // An ellipse around the whole lasso.
    expect(hits(shape('circle', { rect: rect(-50, -50, 200, 200) }))).toBe(false);
  });

  it('free text and stamp: a corner inside or an edge crossing', () => {
    for (const kind of ['free-text', 'stamp'] as const) {
      expect(hits(boxed(kind, rect(90, 90, 30, 20)))).toBe(true);
      expect(hits(boxed(kind, rect(-10, 40, 120, 10)))).toBe(true);
      expect(hits(boxed(kind, rect(-10, -10, 120, 120)))).toBe(false);
      expect(hits(boxed(kind, rect(200, 40, 20, 10)))).toBe(false);
    }
  });

  it('note: by its icon rect, placed for NoRotate on a /Rotate page', () => {
    const frame: PageFrame = {
      size: { width: 600, height: 800 },
      originX: 0,
      originY: 0,
      rotation: 180,
      intrinsicRotation: 180,
      scale: 1,
    };
    // On a 180° page the icon is drawn to the left of /Rect's corner: (85, 60).
    const note = boxed('text', rect(105, 40, 20, 20));
    expect(hits(note)).toBe(false);
    expect(hits(note, frame)).toBe(true);
    expect(hitOutlines(note, frame)[0]?.[0]).toEqual({ x: 85, y: 60 });
    expect(hits(boxed('text', rect(40, 40, 20, 20)))).toBe(true);
    expect(hits(boxed('text', rect(140, 40, 20, 20)))).toBe(false);
  });

  it('text markups: any quad touched, also by a lasso drawn inside a quad', () => {
    for (const kind of ['highlight', 'underline', 'strikeout', 'squiggly'] as const) {
      expect(hits(markup(kind, [rect(200, 0, 50, 10), rect(50, 50, 20, 10)]))).toBe(true);
      expect(hits(markup(kind, [rect(90, 50, 40, 10)]))).toBe(true);
      expect(hits(markup(kind, [rect(-10, -10, 120, 120)]))).toBe(true);
      expect(hits(markup(kind, [rect(200, 0, 50, 10), rect(200, 20, 50, 10)]))).toBe(false);
    }
  });

  it('never links, redaction marks, locked or hidden annotations', () => {
    expect(hits(markup('redact', [rect(10, 10, 20, 10)]))).toBe(false);
    const link = { id: 'l', kind: 'link', pageIndex: 0, rect: rect(10, 10, 20, 10) } as Annotation;
    expect(hits(link)).toBe(false);
    const locked = { ...boxed('free-text', rect(10, 10, 20, 10)), flags: { locked: true } };
    const hidden = { ...boxed('stamp', rect(10, 10, 20, 10)), flags: { hidden: true } };
    expect(hits(locked as Annotation)).toBe(false);
    expect(hits(hidden as Annotation)).toBe(false);
    expect(lassoPicks([link, locked as Annotation, hidden as Annotation], box)).toEqual({
      paths: {},
      whole: [],
    });
  });

  it('a mixed lasso: ink paths and whole annotations in page order', () => {
    const annotations: Annotation[] = [
      boxed('text', rect(40, 40, 20, 20)),
      ink('ink', [
        [pt(10, 10), pt(20, 20)],
        [pt(300, 300), pt(310, 310)],
      ]),
      shape('line', {
        id: 'arrow',
        vertices: [pt(-10, 50), pt(110, 50)],
        lineEndings: { end: 'open-arrow' },
      }),
      shape('square', { id: 'far', rect: rect(300, 300, 10, 10) }),
    ];
    expect(lassoPicks(annotations, box)).toEqual({
      paths: { ink: [0] },
      whole: ['text', 'arrow'],
    });
  });

  it('bounds the whole annotations too', () => {
    const frame: PageFrame = {
      size: { width: 100, height: 100 },
      originX: 0,
      originY: 0,
      rotation: 0,
      scale: 1,
    };
    const note = boxed('text', rect(10, 70, 20, 20));
    expect(pickedCssBounds(frame, [note], {}, ['text'])).toEqual({
      left: 10,
      top: 10,
      width: 20,
      height: 20,
    });
  });
});
