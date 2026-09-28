/**
 * The Image tool's selection (one image at a time): which image of which page, at which
 * page revision. After an edit the page is located again; `expect` names the bounds the
 * edited image should have then, so the layer selects it again (a move keeps the image
 * selected, a removal clears the selection).
 */
import type { Rect } from '@pdf-editor/document-model';
import type { LocatedImage } from '@pdf-editor/engine';
import { create } from 'zustand';

import type { PageTarget } from '../annotations/annotation-store';

export interface ImageSelection {
  readonly target: PageTarget;
  readonly image: LocatedImage;
  /** The page revision the image was located at; a newer one makes it stale. */
  readonly revision: number;
}

/** What to select once the page is located again after an edit. */
export interface ExpectedImage {
  readonly target: PageTarget;
  readonly bounds: Rect;
}

interface ImageState {
  readonly selection: ImageSelection | null;
  /** An edit is running (the selection box stays where the user put it). */
  readonly busy: boolean;
  readonly expect: ExpectedImage | null;
  select: (selection: ImageSelection | null) => void;
  setBusy: (busy: boolean) => void;
  setExpect: (expect: ExpectedImage | null) => void;
  clear: () => void;
}

export const useImageStore = create<ImageState>()((set) => ({
  selection: null,
  busy: false,
  expect: null,
  select: (selection) => set({ selection }),
  setBusy: (busy) => set({ busy }),
  setExpect: (expect) => set({ expect }),
  clear: () =>
    set((s) => (s.selection === null && s.expect === null ? s : { selection: null, expect: null })),
}));
