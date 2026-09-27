/**
 * Transient navigation state shared between the stage and the chrome: the page Read mode
 * currently shows (for the status bar and the Pages panel) and scroll-to-page requests.
 */
import type { PageId } from '@pdf-editor/document-model';
import { create } from 'zustand';

interface ViewState {
  /** Index of the page at the centre of the Read viewport, in the active document. */
  readonly currentPage: number;
  /** A request for the stage to bring a page into view; `serial` makes repeats distinct. */
  readonly scrollRequest: { readonly pageId: PageId; readonly serial: number } | null;
  setCurrentPage: (index: number) => void;
  scrollToPage: (pageId: PageId) => void;
}

export const useViewStore = create<ViewState>()((set) => ({
  currentPage: 0,
  scrollRequest: null,
  setCurrentPage: (currentPage) =>
    set((s) => (s.currentPage === currentPage ? s : { currentPage })),
  scrollToPage: (pageId) =>
    set((s) => ({ scrollRequest: { pageId, serial: (s.scrollRequest?.serial ?? 0) + 1 } })),
}));
