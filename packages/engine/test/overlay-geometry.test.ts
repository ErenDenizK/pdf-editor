import { describe, expect, test } from 'vitest';

import {
  displayToUser,
  normalizeRotation,
  placeOverlay,
  tileOrigins,
} from '../src/pdflib/overlay-geometry';
import { labelForIndex, toAlpha, toRoman } from '../src/pdflib/page-labels';

const box = { x: 10, y: 20, width: 200, height: 100 };

describe('displayToUser', () => {
  test('maps the displayed bottom-left corner for every rotation', () => {
    expect(displayToUser({ x: 0, y: 0 }, box, 0)).toEqual({ x: 10, y: 20 });
    // /Rotate 90 (clockwise): the unrotated bottom-right corner is displayed bottom-left.
    expect(displayToUser({ x: 0, y: 0 }, box, 90)).toEqual({ x: 210, y: 20 });
    expect(displayToUser({ x: 0, y: 0 }, box, 180)).toEqual({ x: 210, y: 120 });
    expect(displayToUser({ x: 0, y: 0 }, box, 270)).toEqual({ x: 10, y: 120 });
  });

  test('maps the displayed top-right corner for every rotation', () => {
    expect(displayToUser({ x: 200, y: 100 }, box, 0)).toEqual({ x: 210, y: 120 });
    // Displayed size is 100 x 200 for 90/270.
    expect(displayToUser({ x: 100, y: 200 }, box, 90)).toEqual({ x: 10, y: 120 });
    expect(displayToUser({ x: 200, y: 100 }, box, 180)).toEqual({ x: 10, y: 20 });
    expect(displayToUser({ x: 100, y: 200 }, box, 270)).toEqual({ x: 210, y: 20 });
  });
});

describe('placeOverlay', () => {
  const content = { width: 20, height: 10 };

  test('bottom-center on an unrotated page', () => {
    const p = placeOverlay({
      box,
      rotation: 0,
      anchor: 'bottom-center',
      offset: { x: 0, y: 5 },
      content,
    });
    expect(p).toEqual({ x: 10 + 90, y: 25, angle: 0 });
  });

  test('top-right with inward offset', () => {
    const p = placeOverlay({
      box,
      rotation: 0,
      anchor: 'top-right',
      offset: { x: -5, y: -5 },
      content,
    });
    expect(p).toEqual({ x: 10 + 200 - 20 - 5, y: 20 + 100 - 10 - 5, angle: 0 });
  });

  test('bottom-center on a page rotated 90 draws upward along the right edge', () => {
    // Displayed page is 100 wide, 200 tall; bottom-center lower-left corner is (40, 0).
    const p = placeOverlay({
      box,
      rotation: 90,
      anchor: 'bottom-center',
      offset: { x: 0, y: 0 },
      content,
    });
    expect(p.angle).toBe(90);
    expect(p.x).toBeCloseTo(210);
    expect(p.y).toBeCloseTo(20 + 40);
  });

  test('bottom-center on a page rotated 270', () => {
    const p = placeOverlay({
      box,
      rotation: 270,
      anchor: 'bottom-center',
      offset: { x: 0, y: 0 },
      content,
    });
    expect(p.angle).toBe(270);
    expect(p.x).toBeCloseTo(10);
    expect(p.y).toBeCloseTo(120 - 40);
  });

  test('center with 180 degrees overlay rotation stays centered', () => {
    const p = placeOverlay({
      box,
      rotation: 0,
      anchor: 'center',
      offset: { x: 0, y: 0 },
      content,
      rotate: 180,
    });
    expect(p.angle).toBe(180);
    // Rotating around the box center: the drawing origin is the box's top-right corner.
    expect(p.x).toBeCloseTo(10 + 100 + 10);
    expect(p.y).toBeCloseTo(20 + 50 + 5);
  });
});

test('normalizeRotation wraps and snaps to quarter turns', () => {
  expect(normalizeRotation(450)).toBe(90);
  expect(normalizeRotation(-90)).toBe(270);
  expect(normalizeRotation(360)).toBe(0);
});

test('tileOrigins covers the page and contains the anchored tile', () => {
  const origins = tileOrigins(
    { width: 100, height: 100 },
    { width: 30, height: 30 },
    { x: 35, y: 35 },
    { gapX: 10, gapY: 10 },
  );
  expect(origins).toContainEqual({ x: 35, y: 35 });
  expect(origins.every((o) => o.x < 100 && o.y < 100 && o.x + 30 > 0 && o.y + 30 > 0)).toBe(true);
  expect(origins.length).toBe(9);
});

test('page label formatting', () => {
  expect(toRoman(14)).toBe('xiv');
  expect(toAlpha(1)).toBe('a');
  expect(toAlpha(27)).toBe('aa');
  const ranges = [
    { startIndex: 0, style: 'roman-lower' as const },
    { startIndex: 2, style: 'decimal' as const, prefix: 'P-', firstNumber: 5 },
  ];
  expect(labelForIndex(ranges, 1)).toBe('ii');
  expect(labelForIndex(ranges, 3)).toBe('P-6');
  expect(labelForIndex([], 3)).toBe('4');
});
