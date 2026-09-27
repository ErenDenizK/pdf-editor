import { describe, expect, it } from 'vitest';

import {
  LEFT_PANEL_WIDTH,
  MAX_ZOOM,
  MIN_ZOOM,
  nextZoomLevel,
  parseLayout,
  RIGHT_PANEL_WIDTH,
} from './ui-store';

describe('parseLayout', () => {
  it('falls back to defaults for garbage', () => {
    for (const value of [undefined, null, 42, 'x', []]) {
      expect(parseLayout(value)).toMatchObject({
        leftPanelOpen: true,
        leftPanelView: 'pages',
        leftPanelWidth: LEFT_PANEL_WIDTH.default,
      });
    }
  });

  it('keeps valid fields, clamps widths, and rejects unknown views', () => {
    expect(
      parseLayout({
        leftPanelOpen: false,
        leftPanelView: 'files',
        leftPanelWidth: 10_000,
        rightPanelOpen: false,
        rightPanelWidth: 1,
      }),
    ).toEqual({
      leftPanelOpen: false,
      leftPanelView: 'files',
      leftPanelWidth: LEFT_PANEL_WIDTH.max,
      rightPanelOpen: false,
      rightPanelWidth: RIGHT_PANEL_WIDTH.min,
    });
    expect(parseLayout({ leftPanelView: 'bogus' }).leftPanelView).toBe('pages');
  });
});

describe('nextZoomLevel', () => {
  it('steps through discrete levels and clamps at the ends', () => {
    expect(nextZoomLevel(1, 1)).toBe(1.1);
    expect(nextZoomLevel(1, -1)).toBe(0.9);
    expect(nextZoomLevel(1.03, 1)).toBe(1.1);
    expect(nextZoomLevel(1.03, -1)).toBe(1);
    expect(nextZoomLevel(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
    expect(nextZoomLevel(MIN_ZOOM, -1)).toBe(MIN_ZOOM);
  });
});
