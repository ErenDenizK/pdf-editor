/**
 * Transient navigation state shared between the stage and the chrome: the page Read mode
 * currently shows (for the status bar and the Pages panel), the pages in view (for lazy
 * overlays), the Read layout, and scroll-to-page requests.
 */
import type { PageId, Rect } from '@pdf-editor/document-model';
import { create } from 'zustand';

/** Read-mode page layouts (spec §1). */
export type ReadLayout = 'continuous' | 'single' | 'two-up';
export const READ_LAYOUTS: readonly ReadLayout[] = ['continuous', 'single', 'two-up'];

export interface ScrollRequest {
  readonly pageId: PageId;
  readonly serial: number;
  /**
   * A region of the page (unrotated user space) to bring into view instead of the page top,
   * e.g. a search hit. Scrolling is minimal when it is already visible.
   */
  readonly reveal?: Rect;
}

interface ViewState {
  /** Index of the page at the centre of the Read viewport, in the active document. */
  readonly currentPage: number;
  /** First and last page index intersecting the Read viewport (inclusive). */
  readonly visibleRange: { readonly first: number; readonly last: number };
  readonly layout: ReadLayout;
  /** A request for the stage to bring a page into view; `serial` makes repeats distinct. */
  readonly scrollRequest: ScrollRequest | null;
  /**
   * Page index a programmatic scroll is heading to, until it settles or the user scrolls.
   * Relative navigation (`[` `]`, PageUp / PageDown, Space) steps from here rather than
   * from `currentPage`, which lags behind a scroll in flight.
   */
  readonly navTarget: number | null;
  setCurrentPage: (index: number) => void;
  setVisibleRange: (first: number, last: number) => void;
  setLayout: (layout: ReadLayout) => void;
  scrollToPage: (pageId: PageId, options?: { readonly reveal?: Rect }) => void;
  setNavTarget: (index: number | null) => void;
}

export const useViewStore = create<ViewState>()((set) => ({
  currentPage: 0,
  visibleRange: { first: 0, last: 0 },
  layout: 'continuous',
  scrollRequest: null,
  navTarget: null,
  setCurrentPage: (currentPage) =>
    set((s) => (s.currentPage === currentPage ? s : { currentPage })),
  setVisibleRange: (first, last) =>
    set((s) =>
      s.visibleRange.first === first && s.visibleRange.last === last
        ? s
        : { visibleRange: { first, last } },
    ),
  setLayout: (layout) => set((s) => (s.layout === layout ? s : { layout })),
  scrollToPage: (pageId, options) =>
    set((s) => ({
      scrollRequest: {
        pageId,
        serial: (s.scrollRequest?.serial ?? 0) + 1,
        ...(options?.reveal === undefined ? {} : { reveal: options.reveal }),
      },
    })),
  setNavTarget: (navTarget) => set((s) => (s.navTarget === navTarget ? s : { navTarget })),
}));

/** Pages from the viewport: 0 inside the visible range, else the distance to its nearest end. */
export function distanceFromView(index: number, range: ViewState['visibleRange']): number {
  if (index < range.first) return range.first - index;
  if (index > range.last) return index - range.last;
  return 0;
}
