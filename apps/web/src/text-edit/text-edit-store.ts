/**
 * The open text editor (one at a time): which run of which page, at which page revision,
 * and the characters to select when it opens (the clicked glyph).
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

interface TextEditState {
  readonly session: TextEditSession | null;
  open: (session: TextEditSession) => void;
  close: () => void;
}

export const useTextEditStore = create<TextEditState>()((set) => ({
  session: null,
  open: (session) => set({ session }),
  close: () => set((s) => (s.session === null ? s : { session: null })),
}));
