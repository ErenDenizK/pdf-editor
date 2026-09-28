/**
 * The open text editor (one at a time): which run of which page, at which page revision,
 * and the characters to select when it opens (the clicked glyph). When Enter or Esc closes
 * it, `focusReturn` asks the page's layer to put the keyboard focus back on the run (or,
 * after a commit, on its line once the page's runs are located again).
 */
import type { LocatedRun } from '@pdf-editor/engine';
import { create } from 'zustand';

import type { PageTarget } from '../annotations/annotation-store';

export interface TextEditSession {
  readonly target: PageTarget;
  readonly run: LocatedRun;
  /** The page revision the run was located at; a newer one makes the run stale. */
  readonly revision: number;
  /** Selection in the editor when it opens (UTF-16 offsets in `run.text`). */
  readonly selection: { readonly start: number; readonly end: number };
}

/** Where the focus goes after the editor closed from the keyboard. */
export interface FocusReturn {
  readonly pageId: TextEditSession['target']['pageId'];
  /** The run that was edited (its key, line and position on the page). */
  readonly run: LocatedRun;
  /** Runs located at this revision are stale: wait for a newer one (after a commit). */
  readonly staleRevision?: number;
}

interface TextEditState {
  readonly session: TextEditSession | null;
  readonly focusReturn: FocusReturn | null;
  open: (session: TextEditSession) => void;
  /** Closes the editor (nothing is applied); the focus is left where it is. */
  close: () => void;
  /**
   * Closes the editor after Enter or Esc and asks for the focus to return to the run;
   * `committed`: the page changed, so its runs are located again first.
   */
  finish: (committed: boolean) => void;
  clearFocusReturn: () => void;
}

export const useTextEditStore = create<TextEditState>()((set) => ({
  session: null,
  focusReturn: null,
  open: (session) => set({ session, focusReturn: null }),
  close: () =>
    set((s) =>
      s.session === null && s.focusReturn === null ? s : { session: null, focusReturn: null },
    ),
  finish: (committed) =>
    set((s) =>
      s.session === null
        ? s
        : {
            session: null,
            focusReturn: {
              pageId: s.session.target.pageId,
              run: s.session.run,
              ...(committed ? { staleRevision: s.session.revision } : {}),
            },
          },
    ),
  clearFocusReturn: () => set((s) => (s.focusReturn === null ? s : { focusReturn: null })),
}));
