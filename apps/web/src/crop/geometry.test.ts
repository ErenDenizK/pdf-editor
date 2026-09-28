/**
 * Crop maths: displayed margins ↔ the stored crop box (unrotated user space) at all four
 * rotations, checked against the viewer's own mapping (viewer/geometry.ts), pages whose
 * box does not start at the origin and pages with an existing crop, the discard bands, the
 * bitmap placement of a cropped page, preview drags and units.
 */
import type { Rect, Rotation } from '@pdf-editor/document-model';
import { describe, expect, it } from 'vitest';

import { fromUnit, toUnit } from '../stage/ResizeDialog';
import { type PageFrame, userRectToCss } from '../viewer/geometry';
import {
  clampRect,
  composePlacement,
  cropFromMargins,
  cropPlacement,
  discardBands,
  dragMargins,
  isNoCrop,
  type Margins,
  MIN_CROP_SIDE,
  marginsFromCrop,
  marginsFromDisplayRect,
  marginsProblem,
  NO_MARGINS,
  toDisplayedMargins,
  toUnrotatedMargins,
  turned,
  unionRects,
} from './geometry';

const ROTATIONS: readonly Rotation[] = [0, 90, 180, 270];
const LETTER: Rect = { x: 0, y: 0, width: 612, height: 792 };
/** A source page whose own CropBox is offset inside its MediaBox. */
const OFFSET: Rect = { x: 50, y: 60, width: 500, height: 700 };
const M: Margins = { top: 10, right: 20, bottom: 30, left: 40 };

/** The viewer's frame of a page showing `visible` (its crop) at `rotation`, 1 px per pt. */
function frameOf(visible: Rect, rotation: Rotation): PageFrame {
  return {
    size: { width: visible.width, height: visible.height },
    originX: visible.x,
    originY: visible.y,
    rotation,
    scale: 1,
  };
}

function area(r: Rect): number {
  return r.width * r.height;
}

describe('margins between display and unrotated sides', () => {
  it('turns the sides with the page', () => {
    expect(toUnrotatedMargins(M, 0)).toEqual(M);
    // Turned 90° clockwise, the unrotated left edge is on top, the top edge on the right.
    expect(toUnrotatedMargins(M, 90)).toEqual({ left: 10, top: 20, right: 30, bottom: 40 });
    expect(toUnrotatedMargins(M, 180)).toEqual({ bottom: 10, left: 20, top: 30, right: 40 });
    expect(toUnrotatedMargins(M, 270)).toEqual({ right: 10, bottom: 20, left: 30, top: 40 });
  });

  it.each(ROTATIONS)('round-trips at %i°', (rotation) => {
    expect(toDisplayedMargins(toUnrotatedMargins(M, rotation), rotation)).toEqual(M);
    expect(toUnrotatedMargins(toDisplayedMargins(M, rotation), rotation)).toEqual(M);
  });
});

describe('crop box from displayed margins', () => {
  it('stores unrotated user space', () => {
    expect(cropFromMargins(LETTER, M, 0)).toEqual({ x: 40, y: 30, width: 552, height: 752 });
    // At 90° the displayed top margin is taken from the unrotated left edge.
    expect(cropFromMargins(LETTER, M, 90)).toEqual({ x: 10, y: 40, width: 572, height: 732 });
    expect(cropFromMargins(LETTER, M, 180)).toEqual({ x: 20, y: 10, width: 552, height: 752 });
    expect(cropFromMargins(LETTER, M, 270)).toEqual({ x: 30, y: 20, width: 572, height: 732 });
  });

  for (const box of [LETTER, OFFSET]) {
    it.each(ROTATIONS)(
      `shows where the margins say, box at (${box.x}, ${box.y}), %i°`,
      (rotation) => {
        const crop = cropFromMargins(box, M, rotation);
        if (crop === undefined) throw new Error('no crop');
        // The crop inside the whole page as the viewer draws it: margins from each edge.
        const shown = turned(box, rotation);
        const css = userRectToCss(frameOf(box, rotation), crop);
        expect(css.left).toBeCloseTo(M.left, 9);
        expect(css.top).toBeCloseTo(M.top, 9);
        expect(css.width).toBeCloseTo(shown.width - M.left - M.right, 9);
        expect(css.height).toBeCloseTo(shown.height - M.top - M.bottom, 9);
        // …and back.
        const back = marginsFromCrop(box, crop, rotation);
        for (const side of ['top', 'right', 'bottom', 'left'] as const) {
          expect(back[side]).toBeCloseTo(M[side], 9);
        }
      },
    );
  }

  it('reads an existing crop as margins, clamped to the page box', () => {
    // A source CropBox offset at (50, 60) and a model crop 25 pt in from every side.
    const existing = { x: 75, y: 85, width: 450, height: 650 };
    expect(marginsFromCrop(OFFSET, existing, 0)).toEqual({
      top: 25,
      right: 25,
      bottom: 25,
      left: 25,
    });
    expect(marginsFromCrop(OFFSET, { x: 60, y: 60, width: 480, height: 600 }, 90)).toEqual({
      // Unrotated: top 100, right 10, bottom 0, left 10 → displayed at 90°.
      top: 10,
      right: 100,
      bottom: 10,
      left: 0,
    });
    // Past the page box: only the part inside counts.
    expect(marginsFromCrop(OFFSET, { x: 0, y: 0, width: 300, height: 2000 }, 0)).toEqual({
      top: 0,
      right: 250,
      bottom: 0,
      left: 0,
    });
    expect(marginsFromCrop(OFFSET, undefined, 0)).toEqual(NO_MARGINS);
    expect(marginsFromCrop(OFFSET, { x: 0, y: 0, width: 10, height: 10 }, 0)).toEqual(NO_MARGINS);
    // Cropping a cropped page again starts from the page box, not from the earlier crop.
    const again = cropFromMargins(OFFSET, marginsFromCrop(OFFSET, existing, 180), 180);
    expect(again).toEqual(existing);
  });

  it('refuses margins that are negative or leave too little', () => {
    expect(marginsProblem({ ...M, top: -1 }, LETTER)).toBe('invalid');
    expect(marginsProblem({ ...M, left: Number.NaN }, LETTER)).toBe('invalid');
    expect(marginsProblem({ ...NO_MARGINS, left: 300, right: 310 }, LETTER)).toBe('too-small');
    expect(
      marginsProblem({ ...NO_MARGINS, left: 300, right: 612 - 300 - MIN_CROP_SIDE }, LETTER),
    ).toBeUndefined();
    // Too small on a landscape display (90°: the displayed width is 792).
    expect(cropFromMargins(LETTER, { ...NO_MARGINS, top: 300, bottom: 310 }, 90)).toBeUndefined();
    expect(isNoCrop(NO_MARGINS)).toBe(true);
    expect(isNoCrop({ ...NO_MARGINS, top: 0.5 })).toBe(false);
  });
});

describe('discard bands', () => {
  it('covers the page box outside the crop with up to four bands', () => {
    const crop = { x: 72, y: 72, width: 468, height: 648 };
    const bands = discardBands(LETTER, crop);
    expect(bands).toEqual([
      { x: 0, y: 720, width: 612, height: 72 },
      { x: 0, y: 0, width: 612, height: 72 },
      { x: 0, y: 72, width: 72, height: 648 },
      { x: 540, y: 72, width: 72, height: 648 },
    ]);
    const total = bands.reduce((sum, band) => sum + area(band), 0);
    expect(total).toBeCloseTo(area(LETTER) - area(crop), 6);
    // No band overlaps the crop.
    for (const band of bands) expect(clampRect(band, crop)).toBeUndefined();
  });

  it('leaves out empty bands and clamps to the page box', () => {
    expect(discardBands(LETTER, LETTER)).toEqual([]);
    // Crop touching the top and reaching past the right edge: bottom and left only.
    const bands = discardBands(OFFSET, { x: 100, y: 200, width: 1000, height: 1000 });
    expect(bands).toEqual([
      { x: 50, y: 60, width: 500, height: 140 },
      { x: 50, y: 200, width: 50, height: 560 },
    ]);
  });

  it('joins what several pages keep', () => {
    expect(
      unionRects([
        { x: 10, y: 10, width: 10, height: 10 },
        { x: 30, y: 0, width: 5, height: 5 },
      ]),
    ).toEqual({ x: 10, y: 0, width: 25, height: 20 });
    expect(unionRects([])).toBeUndefined();
  });
});

describe('bitmap placement of a cropped page', () => {
  it.each(ROTATIONS)('places the page box relative to the crop at %i°', (rotation) => {
    const crop = { x: 90, y: 110, width: 300, height: 400 };
    const placement = cropPlacement(OFFSET, crop, rotation);
    // Where the viewer draws the page box on a page that shows the crop, in fractions.
    const shown = turned(crop, rotation);
    const css = userRectToCss(frameOf(crop, rotation), OFFSET);
    expect(placement.left).toBeCloseTo(css.left / shown.width, 9);
    expect(placement.top).toBeCloseTo(css.top / shown.height, 9);
    expect(placement.width).toBeCloseTo(css.width / shown.width, 9);
    expect(placement.height).toBeCloseTo(css.height / shown.height, 9);
  });

  it('composes with a resize placement', () => {
    const outer = { left: 0.1, top: 0.2, width: 0.5, height: 0.6 };
    const inner = { left: -0.5, top: 0, width: 2, height: 1 };
    expect(composePlacement(outer, inner)).toEqual({
      left: 0.1 - 0.25,
      top: 0.2,
      width: 1,
      height: 0.6,
    });
  });
});

describe('preview drags and drawn rectangles (display space)', () => {
  const size = { width: 612, height: 792 };

  it('moves one edge, stopping at the page and the minimum size', () => {
    expect(dragMargins(M, 'n', 5, 15, size)).toEqual({ ...M, top: 25 });
    expect(dragMargins(M, 's', 0, -15, size)).toEqual({ ...M, bottom: 45 });
    expect(dragMargins(M, 'se', 10, 10, size)).toEqual({ ...M, right: 10, bottom: 20 });
    expect(dragMargins(M, 'nw', -100, -100, size)).toEqual({ ...M, top: 0, left: 0 });
    expect(dragMargins(M, 'w', 10_000, 0, size).left).toBe(612 - M.right - MIN_CROP_SIDE);
  });

  it('moves the whole rectangle without resizing it', () => {
    expect(dragMargins(M, 'move', 5, -5, size)).toEqual({
      top: 5,
      right: 15,
      bottom: 35,
      left: 45,
    });
    // Clamped at the page edges.
    expect(dragMargins(M, 'move', -1000, 1000, size)).toEqual({
      top: 40,
      right: 60,
      bottom: 0,
      left: 0,
    });
  });

  it('turns a drawn rectangle into margins', () => {
    expect(marginsFromDisplayRect({ left: 40, top: 10, width: 552, height: 752 }, size)).toEqual(M);
    expect(marginsFromDisplayRect({ left: -5, top: 0, width: 700, height: 10 }, size)).toEqual({
      top: 0,
      left: 0,
      right: 0,
      bottom: 782,
    });
  });
});

describe('units', () => {
  it('shows margins in pt, mm and in', () => {
    expect(toUnit(72, 'pt')).toBe(72);
    expect(toUnit(72, 'mm')).toBe(25.4);
    expect(toUnit(72, 'in')).toBe(1);
    expect(fromUnit(10, 'mm')).toBeCloseTo(28.346, 3);
    expect(fromUnit(1.5, 'in')).toBe(108);
  });
});
