import { describe, expect, it } from 'vitest';

import { boxChanged, HANDLES, handlePoint, moveBox, nudgeOffset, resizeBox } from './handles';

const box = { left: 100, top: 50, width: 200, height: 100 };

describe('image selection handles', () => {
  it('moves by the pointer delta', () => {
    expect(moveBox(box, 50, -10)).toEqual({ left: 150, top: 40, width: 200, height: 100 });
  });

  it('each handle moves its own edges and keeps the opposite ones', () => {
    expect(resizeBox(box, 'se', 20, 10)).toEqual({ left: 100, top: 50, width: 220, height: 110 });
    expect(resizeBox(box, 'nw', 20, 10)).toEqual({ left: 120, top: 60, width: 180, height: 90 });
    expect(resizeBox(box, 'ne', 20, 10)).toEqual({ left: 100, top: 60, width: 220, height: 90 });
    expect(resizeBox(box, 'sw', 20, 10)).toEqual({ left: 120, top: 50, width: 180, height: 110 });
    expect(resizeBox(box, 'e', 20, 99)).toEqual({ left: 100, top: 50, width: 220, height: 100 });
    expect(resizeBox(box, 'w', 20, 99)).toEqual({ left: 120, top: 50, width: 180, height: 100 });
    expect(resizeBox(box, 'n', 99, 10)).toEqual({ left: 100, top: 60, width: 200, height: 90 });
    expect(resizeBox(box, 's', 99, 10)).toEqual({ left: 100, top: 50, width: 200, height: 110 });
  });

  it('Shift keeps the aspect ratio: corners follow the larger change, edges drive the other side', () => {
    const corner = resizeBox(box, 'se', 100, 10, { keepAspect: true });
    expect(corner).toEqual({ left: 100, top: 50, width: 300, height: 150 });
    const nw = resizeBox(box, 'nw', -20, -40, { keepAspect: true });
    expect(nw.width / nw.height).toBeCloseTo(2, 10);
    expect([nw.left + nw.width, nw.top + nw.height]).toEqual([300, 150]);
    // An edge handle: the other side follows, centred.
    const east = resizeBox(box, 'e', 100, 0, { keepAspect: true });
    expect(east).toEqual({ left: 100, top: 25, width: 300, height: 150 });
    const south = resizeBox(box, 's', 0, -50, { keepAspect: true });
    expect(south).toEqual({ left: 150, top: 50, width: 100, height: 50 });
  });

  it('Alt resizes from the centre', () => {
    expect(resizeBox(box, 'e', 10, 0, { fromCenter: true })).toEqual({
      left: 90,
      top: 50,
      width: 220,
      height: 100,
    });
    const both = resizeBox(box, 'se', 50, 0, { fromCenter: true, keepAspect: true });
    expect(both).toEqual({ left: 50, top: 25, width: 300, height: 150 });
  });

  it('never flips or goes below the minimum side', () => {
    expect(resizeBox(box, 'e', -500, 0)).toEqual({ left: 100, top: 50, width: 4, height: 100 });
    expect(resizeBox(box, 'w', 500, 0)).toEqual({ left: 296, top: 50, width: 4, height: 100 });
    const tiny = resizeBox(box, 'se', -500, -500, { keepAspect: true });
    expect(tiny.height).toBe(4);
    expect(tiny.width).toBe(8);
  });

  it('handle points sit on the corners and edge midpoints', () => {
    expect(HANDLES.map((h) => handlePoint(box, h))).toEqual([
      { x: 100, y: 50 },
      { x: 200, y: 50 },
      { x: 300, y: 50 },
      { x: 300, y: 100 },
      { x: 300, y: 150 },
      { x: 200, y: 150 },
      { x: 100, y: 150 },
      { x: 100, y: 100 },
    ]);
  });

  it('arrow keys nudge 1 pt, Shift 10 pt, at the page scale', () => {
    expect(nudgeOffset('ArrowRight', false, 1.5)).toEqual({ dx: 1.5, dy: 0 });
    expect(nudgeOffset('ArrowUp', true, 2)).toEqual({ dx: 0, dy: -20 });
    expect(nudgeOffset('Enter', false, 1)).toBeUndefined();
  });

  it('small jitters are not a change', () => {
    expect(boxChanged(box, { ...box, left: 100.3 })).toBe(false);
    expect(boxChanged(box, { ...box, left: 101 })).toBe(true);
  });
});
