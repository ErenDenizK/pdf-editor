/**
 * The open text editor (one at a time): which run of which page, at which page revision,
 * and the selection when it opens (a caret at the click). When Enter or Esc closes it,
 * `focusReturn` asks the page's layer to put the keyboard focus back on the run (or, after a
 * commit, on its line once the page's runs are located again).
 *
 * `runAnalysis` keeps the engine's one-off analysis of each opened run per page revision
 * (craft spec §4.8), so reopening a run at the same revision asks the engine nothing.
 *
 * The paragraph editor (craft spec §4.7, `ParagraphEditor.tsx`) has its own session: the
 * open paragraph, its draft (the typed change, what leaving commits) and the settled preview
 * of that draft. Opening one closes the other. The page's paragraphs, each paragraph's layout
 * analysis and the glyph outlines of the page's fonts are cached per page revision.
 */
import type { SourceId } from '@pdf-editor/document-model';
import type {
  LocatedRun,
  ParagraphBlock,
  ParagraphEditResult,
  ParagraphLayoutAnalysis,
  TextRunAnalysis,
} from '@pdf-editor/engine';
import { create } from 'zustand';

import type { PageTarget } from '../annotations/annotation-store';
import { getEngineService } from '../engine/engine-service';
import { GlyphCache } from './glyph-canvas';

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

/**
 * The open paragraph editor (craft spec §4.2, §4.7): which detected paragraph of which page,
 * at which page revision, and where it was clicked.
 */
export interface ParagraphSession {
  readonly target: PageTarget;
  readonly block: ParagraphBlock;
  /** The page revision the paragraph was detected at; a newer one makes it stale. */
  readonly revision: number;
  /** Caret offset in `block.text` when it opens (refined from `point` once laid out). */
  readonly caret: number;
  /** The click, user space, when it opened from a click. */
  readonly point?: { readonly x: number; readonly y: number };
  /** The run the Edit text tool clicked: its line editor opens if the paragraph is refused. */
  readonly fallback?: TextEditSession;
}

/** The open paragraph's typed text as last laid out (what leaving commits). */
export interface ParagraphDraft {
  readonly text: string;
  /** The replaced range of the original text and the inserted text's style. */
  readonly caretSpan: { readonly start: number; readonly end: number };
  readonly style?: string;
}

/** The engine's settled preview of a draft (spec §4.7: the dry run rendered). */
export interface ParagraphPreviewState {
  readonly text: string;
  readonly bitmap: ImageBitmap;
  /** The rendered area, unrotated user space. */
  readonly clip: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly result: ParagraphEditResult;
}

interface TextEditState {
  readonly session: TextEditSession | null;
  readonly focusReturn: FocusReturn | null;
  readonly paragraph: ParagraphSession | null;
  /** The open paragraph's change, null while its text is unchanged. */
  readonly paragraphDraft: ParagraphDraft | null;
  readonly paragraphPreview: ParagraphPreviewState | null;
  /** Opens the paragraph editor (closing a line editor). */
  openParagraph: (session: ParagraphSession) => void;
  setParagraphDraft: (draft: ParagraphDraft | null) => void;
  setParagraphPreview: (preview: ParagraphPreviewState | null) => void;
  /** Closes the paragraph editor; nothing is applied (leaving commits: text-edit/actions.ts). */
  closeParagraph: () => void;
  /**
   * Closes the paragraph editor after Esc (or a commit) and, when it opened from a run, asks
   * for the focus to return to that run as the line editor does (`committed`: once the page's
   * runs are located again).
   */
  finishParagraph: (committed: boolean) => void;
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

const NO_PARAGRAPH = { paragraph: null, paragraphDraft: null, paragraphPreview: null } as const;

export const useTextEditStore = create<TextEditState>()((set) => ({
  session: null,
  focusReturn: null,
  ...NO_PARAGRAPH,
  openParagraph: (paragraph) =>
    set({ ...NO_PARAGRAPH, paragraph, session: null, focusReturn: null }),
  setParagraphDraft: (paragraphDraft) =>
    set((s) => (s.paragraph === null ? s : { paragraphDraft, paragraphPreview: null })),
  setParagraphPreview: (paragraphPreview) =>
    set((s) => (s.paragraph === null ? s : { paragraphPreview })),
  closeParagraph: () => set((s) => (s.paragraph === null ? s : NO_PARAGRAPH)),
  finishParagraph: (committed) =>
    set((s) => {
      const { paragraph } = s;
      if (paragraph === null) return s;
      const run = paragraph.fallback?.run;
      return {
        ...NO_PARAGRAPH,
        focusReturn: run
          ? {
              pageId: paragraph.target.pageId,
              run,
              ...(committed ? { staleRevision: paragraph.revision } : {}),
            }
          : null,
      };
    }),
  open: (session) => set({ ...NO_PARAGRAPH, session, focusReturn: null }),
  close: () =>
    set((s) =>
      s.session === null && s.focusReturn === null && s.paragraph === null
        ? s
        : { session: null, focusReturn: null, ...NO_PARAGRAPH },
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

// ---------------------------------------------------------------------------
// Paragraphs and their layout analyses, per page revision (craft spec §4.1, §4.8)
// ---------------------------------------------------------------------------

const paragraphs = new Map<string, Promise<readonly ParagraphBlock[]>>();
const layouts = new Map<string, Promise<ParagraphLayoutAnalysis>>();
const glyphCaches = new Map<string, GlyphCache>();
const MAX_PARAGRAPH_PAGES = 16;

getEngineService().onSourceClosed((source) => {
  for (const map of [paragraphs, layouts, glyphCaches]) {
    for (const key of [...map.keys()]) if (key.startsWith(`${source}:`)) map.delete(key);
  }
});

/** Keeps `map` to the current revision of the page and a bounded size. */
function prune<V>(map: Map<string, V>, page: string, current: string, max: number): void {
  for (const old of [...map.keys()]) {
    if (old.startsWith(page) && !old.startsWith(current)) map.delete(old);
  }
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function cached<V>(map: Map<string, Promise<V>>, key: string, load: () => Promise<V>): Promise<V> {
  let value = map.get(key);
  if (!value) {
    const pending = load();
    value = pending;
    map.set(key, pending);
    pending.catch(() => {
      if (map.get(key) === pending) map.delete(key);
    });
  }
  return value;
}

/** The page's detected paragraphs at its current revision. */
export function pageParagraphs(
  source: SourceId,
  pageIndex: number,
): Promise<readonly ParagraphBlock[]> {
  const service = getEngineService();
  const page = `${source}:${pageIndex}:`;
  const current = `${page}${service.pageRevision(source, pageIndex)}`;
  const value = cached(paragraphs, current, () => service.analyzeParagraphs(source, pageIndex));
  prune(paragraphs, page, current, MAX_PARAGRAPH_PAGES);
  return value;
}

/** The layout analysis of an open paragraph (once per paragraph and page revision). */
export function paragraphLayoutAnalysis(
  session: ParagraphSession,
): Promise<ParagraphLayoutAnalysis> {
  const { ref } = session.block;
  const page = `${ref.source}:${ref.pageIndex}:`;
  const current = `${page}${session.revision}:`;
  const value = cached(layouts, `${current}${ref.index}`, () =>
    getEngineService().analyzeParagraphLayout(ref),
  );
  prune(layouts, page, current, 4 * MAX_PARAGRAPH_PAGES);
  return value;
}

/** The glyph outlines of a page's fonts (font ids are numbered per page state). */
export function glyphCacheFor(source: SourceId, pageIndex: number, revision: number): GlyphCache {
  const page = `${source}:${pageIndex}:`;
  const key = `${page}${revision}`;
  let cache = glyphCaches.get(key);
  if (!cache) {
    cache = new GlyphCache();
    glyphCaches.set(key, cache);
    prune(glyphCaches, page, key, 4);
  }
  return cache;
}
