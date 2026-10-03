/**
 * The open text editor (one at a time): which run of which page, at which page revision,
 * and the selection when it opens (a caret at the click). When Enter or Esc closes it,
 * `focusReturn` asks the page's layer to put the keyboard focus back on the run (or, after a
 * commit, on its line once the page's runs are located again).
 *
 * `runAnalysis` keeps the engine's one-off analysis of each opened run per page revision
 * (craft spec §4.8), so reopening a run at the same revision asks the engine nothing.
 */
import type { LocatedRun, TextRunAnalysis } from '@pdf-editor/engine';
import { create } from 'zustand';

import type { PageTarget } from '../annotations/annotation-store';
import { getEngineService } from '../engine/engine-service';

export interface TextEditSession {
  readonly target: PageTarget;
  readonly run: LocatedRun;
  /** The page revision the run was located at; a newer one makes the run stale. */
  readonly revision: number;
  /** Selection in the editor when it opens (UTF-16 offsets in `run.text`; a caret when empty). */
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

// ---------------------------------------------------------------------------
// Run analyses, per page revision
// ---------------------------------------------------------------------------

const analyses = new Map<string, Promise<TextRunAnalysis>>();
const MAX_ANALYSES = 32;

getEngineService().onSourceClosed((source) => {
  for (const key of [...analyses.keys()]) if (key.startsWith(`${source}:`)) analyses.delete(key);
});

/**
 * The engine's analysis of the session's run (`PdfTextEditor.analyzeRun`), once per run and
 * page revision: older revisions of the page are dropped, failures are not kept.
 */
export function runAnalysis(session: TextEditSession): Promise<TextRunAnalysis> {
  const { run } = session;
  const page = `${run.source}:${run.pageIndex}:`;
  const key = `${page}${session.revision}:${run.objectPath.join('.')}:${run.charStart}`;
  let analysis = analyses.get(key);
  if (!analysis) {
    const pending = getEngineService()
      .textEditor()
      .then((editor) => editor.analyzeRun(run));
    analysis = pending;
    analyses.set(key, pending);
    pending.catch(() => {
      if (analyses.get(key) === pending) analyses.delete(key);
    });
    const current = `${page}${session.revision}:`;
    for (const old of [...analyses.keys()]) {
      if (old.startsWith(page) && !old.startsWith(current)) analyses.delete(old);
    }
    while (analyses.size > MAX_ANALYSES) {
      const oldest = analyses.keys().next().value;
      if (oldest === undefined) break;
      analyses.delete(oldest);
    }
  }
  return analysis;
}
