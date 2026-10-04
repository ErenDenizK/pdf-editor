/**
 * The full-bleed stage's arithmetic (craft spec §7): which scroll bars the page column needs,
 * and the free rectangle measured against the shell.
 */
import { describe, expect, it } from 'vitest';

import { measureStageBleed, scrollbarsNeeded } from './stage-bleed';

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
