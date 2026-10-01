/** Lasso geometry (experience-redesign spec §6.5): containment, crossings, path matching. */
import type { Annotation, InkAnnotation } from '@pdf-editor/engine';
import { describe, expect, it } from 'vitest';

import type { PageFrame } from '../geometry';
import {
  lassoPicks,
  pathTouchesPolygon,
  pickCount,
  pickedCssBounds,
  pickedPaths,
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

  it('picks paths per ink, skipping locked, hidden and other kinds', () => {
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
    expect(picks).toEqual({ a: [0, 2] });
    expect(pickCount(picks)).toBe(2);
    expect(pickedPaths(annotations, picks).map((p) => p.index)).toEqual([0, 2]);
  });

  it('takes nothing with a degenerate lasso', () => {
    expect(lassoPicks([ink('a', [[{ x: 1, y: 1 }]])], square.slice(0, 2))).toEqual({});
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
