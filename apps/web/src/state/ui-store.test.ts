import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_LAYOUT,
  isNavigatorShowing,
  LAYOUT_STORAGE_KEY,
  LEFT_PANEL_WIDTH,
  LEGACY_LAYOUT_STORAGE_KEY,
  loadLayout,
  MAX_ZOOM,
  migrateLayout,
  MIN_ZOOM,
  nextZoomLevel,
  parseLayout,
  RIGHT_PANEL_WIDTH,
  useUiStore,
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
        pagesView: 'bookmarks',
        reviewFilter: 'fields',
        leftPanelWidth: 10_000,
        rightPanelOpen: true,
        rightPanelWidth: 1,
      }),
    ).toEqual({
      leftPanelOpen: false,
      leftPanelView: 'files',
      pagesView: 'bookmarks',
      reviewFilter: 'fields',
      leftPanelWidth: LEFT_PANEL_WIDTH.max,
      rightPanelOpen: true,
      rightPanelWidth: RIGHT_PANEL_WIDTH.min,
    });
    expect(parseLayout({ leftPanelView: 'bogus' }).leftPanelView).toBe('pages');
    // v1 views are not v2 values; Changes lives only as long as a comparison.
    expect(parseLayout({ leftPanelView: 'outline' }).leftPanelView).toBe('pages');
    expect(parseLayout({ leftPanelView: 'changes' }).leftPanelView).toBe('pages');
    expect(parseLayout({ pagesView: 'x', reviewFilter: 'y' })).toMatchObject({
      pagesView: 'thumbnails',
      reviewFilter: 'all',
    });
  });

  it('keeps the inspector closed by default (experience-redesign decision 4)', () => {
    expect(DEFAULT_LAYOUT.rightPanelOpen).toBe(false);
    expect(parseLayout(undefined).rightPanelOpen).toBe(false);
    expect(parseLayout({}).rightPanelOpen).toBe(false);
  });
});

describe('ui:v1 → ui:v2 migration', () => {
  const v1 = (leftPanelView: string) => ({
    leftPanelOpen: true,
    leftPanelView,
    leftPanelWidth: 300,
    rightPanelOpen: true,
    rightPanelWidth: 320,
  });

  it.each([
    ['pages', { leftPanelView: 'pages', pagesView: 'thumbnails', reviewFilter: 'all' }],
    ['outline', { leftPanelView: 'pages', pagesView: 'bookmarks', reviewFilter: 'all' }],
    ['search', { leftPanelView: 'find', pagesView: 'thumbnails', reviewFilter: 'all' }],
    ['comments', { leftPanelView: 'review', pagesView: 'thumbnails', reviewFilter: 'comments' }],
    [
      'redactions',
      { leftPanelView: 'review', pagesView: 'thumbnails', reviewFilter: 'redactions' },
    ],
    ['forms', { leftPanelView: 'review', pagesView: 'thumbnails', reviewFilter: 'fields' }],
    ['files', { leftPanelView: 'files', pagesView: 'thumbnails', reviewFilter: 'all' }],
    ['changes', { leftPanelView: 'pages', pagesView: 'thumbnails', reviewFilter: 'all' }],
    ['bogus', { leftPanelView: 'pages', pagesView: 'thumbnails', reviewFilter: 'all' }],
  ])('maps the v1 view %s', (view, expected) => {
    expect(migrateLayout(v1(view))).toEqual({
      ...expected,
      leftPanelOpen: true,
      leftPanelWidth: 300,
      // v1 stored the inspector open for everyone; v2 starts it closed.
      rightPanelOpen: false,
      rightPanelWidth: 320,
    });
  });

  it('carries the navigator state and clamps widths; garbage gives the defaults', () => {
    expect(
      migrateLayout({ leftPanelOpen: false, leftPanelWidth: 1, rightPanelWidth: 10_000 }),
    ).toMatchObject({
      leftPanelOpen: false,
      leftPanelWidth: LEFT_PANEL_WIDTH.min,
      rightPanelWidth: RIGHT_PANEL_WIDTH.max,
    });
    for (const value of [undefined, null, 42, 'x']) {
      expect(migrateLayout(value)).toEqual(DEFAULT_LAYOUT);
    }
  });

  describe('loadLayout', () => {
    const clear = () => {
      localStorage.removeItem(LAYOUT_STORAGE_KEY);
      localStorage.removeItem(LEGACY_LAYOUT_STORAGE_KEY);
    };
    beforeEach(clear);
    afterEach(clear);

    it('starts a new install with the defaults, inspector closed', () => {
      expect(loadLayout()).toEqual(DEFAULT_LAYOUT);
      expect(loadLayout().rightPanelOpen).toBe(false);
    });

    it('migrates v1 once and then reads v2', () => {
      localStorage.setItem(LEGACY_LAYOUT_STORAGE_KEY, JSON.stringify(v1('redactions')));
      expect(loadLayout()).toMatchObject({ leftPanelView: 'review', reviewFilter: 'redactions' });
      expect(JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY) ?? 'null')).toMatchObject({
        leftPanelView: 'review',
        reviewFilter: 'redactions',
      });
      // A later v1 write (an old tab) does not migrate again.
      localStorage.setItem(LEGACY_LAYOUT_STORAGE_KEY, JSON.stringify(v1('outline')));
      expect(loadLayout()).toMatchObject({ leftPanelView: 'review', reviewFilter: 'redactions' });
    });
  });
});

describe('navigator state', () => {
  afterEach(() => {
    useUiStore.setState({ ...DEFAULT_LAYOUT });
  });

  it('maps a v1 view set by a command to its tab and filter', () => {
    useUiStore.setState({ leftPanelOpen: true, leftPanelView: 'comments' });
    expect(useUiStore.getState()).toMatchObject({
      leftPanelView: 'review',
      reviewFilter: 'comments',
    });
    useUiStore.setState(() => ({ leftPanelView: 'outline' }));
    expect(useUiStore.getState()).toMatchObject({ leftPanelView: 'pages', pagesView: 'bookmarks' });
    useUiStore.getState().showNavigator('search');
    expect(useUiStore.getState().leftPanelView).toBe('find');
  });

  it('says whether a view is showing; a filter shows under All too', () => {
    const state = {
      ...DEFAULT_LAYOUT,
      leftPanelView: 'review' as const,
      reviewFilter: 'all' as const,
    };
    expect(isNavigatorShowing(state, 'redactions')).toBe(true);
    expect(isNavigatorShowing({ ...state, reviewFilter: 'fields' }, 'redactions')).toBe(false);
    expect(isNavigatorShowing({ ...state, leftPanelOpen: false }, 'review')).toBe(false);
    expect(isNavigatorShowing({ ...DEFAULT_LAYOUT }, 'outline')).toBe(false);
    expect(isNavigatorShowing({ ...DEFAULT_LAYOUT, pagesView: 'bookmarks' }, 'outline')).toBe(true);
  });

  it('persists the layout under ui:v2', () => {
    useUiStore.getState().setReviewFilter('fields');
    expect(JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY) ?? 'null')).toMatchObject({
      reviewFilter: 'fields',
    });
    localStorage.removeItem(LAYOUT_STORAGE_KEY);
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
