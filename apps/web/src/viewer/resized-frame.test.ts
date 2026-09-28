/**
 * The frame of a resized page (`resizedPageFrame`): mapping engine geometry (source user
 * space) through it must equal moving the geometry with the export's resize matrix
 * (x' = a·x + e, y' = d·y + f, as page-resize.ts writes it) and mapping that through a
 * plain frame of the new page, for fit, canvas and stretch at every rotation; and the
 * inverse must bring CSS boxes back into source space (drawing annotations on a resized
 * page).
 */
import {
  type PageResize,
  type Rect,
  resizeTransform,
  type Rotation,
} from '@pdf-editor/document-model';
import { describe, expect, it } from 'vitest';

import {
  type Box,
  displayedSize,
  displayRectToUser,
  lineAngle,
  type PageFrame,
  resizedPageFrame,
  userRectToCss,
} from './geometry';

/** annotations.pdf pages: Letter; the square annotation on page 1. */
const LETTER_BOX: Rect = { x: 0, y: 0, width: 612, height: 792 };
const SQUARE: Rect = { x: 72, y: 420, width: 200, height: 150 };
/** cropbox.pdf page 2: an offset CropBox. */
const CROP_BOX: Rect = { x: 150, y: 200, width: 300, height: 300 };
const A4 = { width: 595.28, height: 841.89 };
const ROTATIONS: readonly Rotation[] = [0, 90, 180, 270];

function exportMatrix(box: Rect, resize: PageResize) {
  const t = resizeTransform(box, resize);
  return {
    a: t.scaleX,
    d: t.scaleY,
    e: t.offsetX - t.scaleX * box.x,
    f: t.offsetY - t.scaleY * box.y,
  };
}

function moved(box: Rect, resize: PageResize, r: Rect): Rect {
  const m = exportMatrix(box, resize);
  return { x: m.a * r.x + m.e, y: m.d * r.y + m.f, width: m.a * r.width, height: m.d * r.height };
}

/** The plain frame of the exported (resized) page, as Read mode shows it after a re-open. */
function exportedFrame(resize: PageResize, rotation: Rotation, scale: number): PageFrame {
  return {
    size: { width: resize.width, height: resize.height },
    originX: 0,
    originY: 0,
    rotation,
    scale,
  };
}

function expectBox(actual: Box, expected: Box): void {
  expect(actual.left).toBeCloseTo(expected.left, 6);
  expect(actual.top).toBeCloseTo(expected.top, 6);
  expect(actual.width).toBeCloseTo(expected.width, 6);
  expect(actual.height).toBeCloseTo(expected.height, 6);
}

function expectRect(actual: Rect, expected: Rect): void {
  expect(actual.x).toBeCloseTo(expected.x, 6);
  expect(actual.y).toBeCloseTo(expected.y, 6);
  expect(actual.width).toBeCloseTo(expected.width, 6);
  expect(actual.height).toBeCloseTo(expected.height, 6);
}

const CASES: readonly [string, Rect, PageResize][] = [
  ['A4 fit', LETTER_BOX, { ...A4, mode: 'fit', anchor: 'center' }],
  ['A4 fit, top right', LETTER_BOX, { ...A4, mode: 'fit', anchor: 'top-right' }],
  ['canvas grow', LETTER_BOX, { width: 800, height: 900, mode: 'canvas', anchor: 'bottom-left' }],
  ['canvas shrink', LETTER_BOX, { width: 400, height: 500, mode: 'canvas', anchor: 'center' }],
  ['scale to cover', LETTER_BOX, { width: 400, height: 400, mode: 'scale', anchor: 'top-left' }],
  [
    'stretch',
    LETTER_BOX,
    { width: 419.53, height: 595.28, mode: 'scale', anchor: 'center', stretch: true },
  ],
  ['offset crop, fit', CROP_BOX, { ...A4, mode: 'fit', anchor: 'middle-right' }],
];

describe('resizedPageFrame', () => {
  for (const [name, box, resize] of CASES) {
    for (const rotation of ROTATIONS) {
      it(`${name} at ${rotation}°: overlays land where the export draws them`, () => {
        const cssScale = 1.5;
        const frame = resizedPageFrame({ contentBox: box, resize, rotation, cssScale });
        const plain = exportedFrame(resize, rotation, cssScale);
        // Same displayed page.
        const shown = displayedSize(frame);
        const plainShown = displayedSize(plain);
        expect(shown.width * frame.scale).toBeCloseTo(plainShown.width * cssScale, 6);
        expect(shown.height * frame.scale).toBeCloseTo(plainShown.height * cssScale, 6);
        // A source rect maps where the moved rect maps on the exported page.
        const rect = box === CROP_BOX ? { x: 200, y: 260, width: 60, height: 20 } : SQUARE;
        expectBox(userRectToCss(frame, rect), userRectToCss(plain, moved(box, resize, rect)));
        // The whole content box lands on the content placement.
        expectBox(userRectToCss(frame, box), userRectToCss(plain, moved(box, resize, box)));
        // Back from CSS to source space (drawing on a resized page).
        const css = userRectToCss(frame, rect);
        const s = frame.scale;
        expectRect(
          displayRectToUser(frame, {
            left: css.left / s,
            top: css.top / s,
            width: css.width / s,
            height: css.height / s,
          }),
          rect,
        );
      });
    }
  }

  it('keeps the content scale in `scale` and only stretches y', () => {
    const fit = resizedPageFrame({
      contentBox: LETTER_BOX,
      resize: { ...A4, mode: 'fit', anchor: 'center' },
      rotation: 0,
      cssScale: 2,
    });
    expect(fit.scale).toBeCloseTo(2 * (A4.width / 612), 9);
    expect(fit.stretchY).toBeUndefined();
    const stretch = resizedPageFrame({
      contentBox: LETTER_BOX,
      resize: { width: 306, height: 1584, mode: 'scale', anchor: 'center', stretch: true },
      rotation: 90,
      cssScale: 1,
      intrinsicRotation: 90,
    });
    expect(stretch.scale).toBeCloseTo(0.5, 9);
    expect(stretch.stretchY).toBeCloseTo(4, 9);
    expect(stretch.intrinsicRotation).toBe(90);
  });

  it('reads text in the same direction after a resize', () => {
    const glyphs = [
      { rect: { x: 72, y: 700, width: 8, height: 10 } },
      { rect: { x: 90, y: 700, width: 8, height: 10 } },
    ];
    for (const rotation of ROTATIONS) {
      const frame = resizedPageFrame({
        contentBox: LETTER_BOX,
        resize: { width: 300, height: 900, mode: 'scale', anchor: 'center', stretch: true },
        rotation,
        cssScale: 1,
      });
      expect(lineAngle(frame, glyphs)).toBe(rotation);
    }
  });
});
