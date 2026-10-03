/**
 * The full-bleed stage's arithmetic (craft spec §7): which scroll bars the page column needs,
 * the glass gate, and how the gate reaches the shell.
 */
import { describe, expect, it } from 'vitest';

import {
  type Box,
  GLASS_GATE_PX,
  type Insets,
  measureStageBleed,
  scrollbarsNeeded,
  surfacesNearPages,
  writeGlassNear,
} from './stage-bleed';

describe('scrollbarsNeeded', () => {
  const view = { width: 800, height: 600 };

  it('shows no bar when the content fits', () => {
    expect(scrollbarsNeeded({ width: 800, height: 600 }, view, 11)).toEqual({
      vertical: false,
      horizontal: false,
    });
  });

  it('lets the vertical bar take width, which can call for the horizontal one', () => {
    expect(scrollbarsNeeded({ width: 795, height: 2000 }, view, 11)).toEqual({
      vertical: true,
      horizontal: true,
    });
    expect(scrollbarsNeeded({ width: 789, height: 2000 }, view, 11)).toEqual({
      vertical: true,
      horizontal: false,
    });
  });

  it('lets the horizontal bar take height, which can call for the vertical one', () => {
    expect(scrollbarsNeeded({ width: 2000, height: 595 }, view, 11)).toEqual({
      vertical: true,
      horizontal: true,
    });
    expect(scrollbarsNeeded({ width: 2000, height: 580 }, view, 11)).toEqual({
      vertical: false,
      horizontal: true,
    });
  });

  it('never trades space for overlay bars', () => {
    expect(scrollbarsNeeded({ width: 800, height: 2000 }, view, 0)).toEqual({
      vertical: true,
      horizontal: false,
    });
  });
});

describe('surfacesNearPages (the glass gate)', () => {
  const area = { width: 1440, height: 900 };
  // Title bar 40, navigator 312, inspector 300, status bar 28.
  const frame: Insets = { top: 40, left: 312, right: 300, bottom: 28 };
  const page = (left: number, top: number, width = 600, height = 800): Box => ({
    left,
    top,
    width,
    height,
  });

  it('blurs nothing without a page', () => {
    expect(surfacesNearPages([], area, frame)).toEqual([]);
  });

  it('opens a surface for a page under it or within 80 px of it, not beyond', () => {
    // Centred in the free column, 120 px from both panels, from 300 px down to the bottom.
    const centred = page(312 + 120, 300, 1440 - 312 - 300 - 240);
    expect(surfacesNearPages([centred], area, frame)).toEqual(['status']);
    // 80 px from the navigator: the gate is inclusive of the blur's reach, exclusive past it.
    expect(surfacesNearPages([page(312 + GLASS_GATE_PX - 1, 300)], area, frame)).toContain('left');
    expect(surfacesNearPages([page(312 + GLASS_GATE_PX, 300)], area, frame)).not.toContain('left');
    // Under the title bar while scrolling.
    expect(surfacesNearPages([page(500, -200, 400)], area, frame)).toEqual(['title']);
    // Zoomed in: under both panels.
    expect(surfacesNearPages([page(100, 100, 1300, 300)], area, frame)).toEqual([
      'title',
      'left',
      'right',
    ]);
  });

  it('skips surfaces that are not there (inspector closed)', () => {
    expect(surfacesNearPages([page(1300, 200, 400)], area, { ...frame, right: 0 })).not.toContain(
      'right',
    );
  });

  it('ignores pages scrolled far away from a surface', () => {
    expect(surfacesNearPages([page(500, 2000)], area, frame)).toEqual([]);
  });
});

describe('writeGlassNear', () => {
  it('writes the list on the shell only when it changes, and clears it', () => {
    const shell = document.createElement('div');
    writeGlassNear(shell, ['title', 'left']);
    expect(shell.getAttribute('data-glass-near')).toBe('title left');
    writeGlassNear(shell, ['title', 'left']);
    expect(shell.getAttribute('data-glass-near')).toBe('title left');
    writeGlassNear(shell, []);
    expect(shell.hasAttribute('data-glass-near')).toBe(false);
    expect(() => writeGlassNear(null, ['title'])).not.toThrow();
  });
});

describe('measureStageBleed', () => {
  it('measures the free rectangle against the shell, and the frame against the stage', () => {
    const shell = document.createElement('div');
    shell.setAttribute('data-stage-bleed', '');
    shell.style.cssText =
      'position:fixed;left:0;top:0;width:1000px;height:700px;display:grid;' +
      'grid-template:40px 1fr 28px / 200px 1fr 150px;';
    const stage = document.createElement('main');
    stage.style.cssText = 'grid-area:2/2;display:flex;flex-direction:column;min-height:0;';
    const header = document.createElement('div');
    header.style.cssText = 'flex:none;height:48px;';
    const free = document.createElement('div');
    free.style.cssText = 'flex:1;min-height:0;';
    stage.append(header, free);
    shell.append(stage);
    document.body.append(shell);
    try {
      const bleed = measureStageBleed(free);
      expect(bleed.element).toBe(shell);
      expect(bleed.insets).toEqual({ top: 88, right: 150, bottom: 28, left: 200 });
      expect(bleed.frame).toEqual({ top: 40, right: 150, bottom: 28, left: 200 });
      expect(bleed.width).toBe(650);
      expect(bleed.height).toBe(700 - 88 - 28);
    } finally {
      shell.remove();
    }
  });

  it('has no insets outside a shell', () => {
    const free = document.createElement('div');
    free.style.cssText = 'width:300px;height:200px;';
    document.body.append(free);
    try {
      const bleed = measureStageBleed(free);
      expect(bleed.element).toBeNull();
      expect(bleed.insets).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
      expect([bleed.width, bleed.height]).toEqual([300, 200]);
    } finally {
      free.remove();
    }
  });
});
