/**
 * State of the Redactions panel: which marks are ticked for a later "apply selected"
 * (all by default, so the set holds the unticked ones), the mark under keyboard review
 * (J / K), and the sensitive-data finder's results with their own ticks.
 *
 * The marks themselves live in the engine as /Redact annotations and are read through the
 * annotation store; `collectMarks` lists them across the workspace in tab and page order.
 */
import type { DocumentId, PageId, Rect, SourceId, Workspace } from '@pdf-editor/document-model';
import type { Annotation } from '@pdf-editor/engine';
import { create } from 'zustand';

import { pageKey } from '../annotations/annotation-store';
import { isRedactMark, type RedactMark } from './marks';
import type { PatternId } from './patterns';

/** One mark as the panel lists it: a /Redact annotation shown on a document page. */
export interface MarkEntry {
  /** Unique per listed row: the page showing the mark and its id. */
  readonly key: string;
  /** Tick identity: the source annotation (a page shown twice lists it twice). */
  readonly markKey: string;
  readonly documentId: DocumentId;
  readonly documentTitle: string;
  readonly pageId: PageId;
  /** 1-based position in its document. */
  readonly position: number;
  readonly source: SourceId;
  readonly sourceIndex: number;
  readonly mark: RedactMark;
}

export function markKeyOf(source: SourceId, id: string): string {
  return `${source}\u0000${id}`;
}

interface PageEntryLike {
  readonly annotations: readonly Annotation[];
}

export interface CollectedMarks {
  readonly entries: readonly MarkEntry[];
  /** Some pages of the workspace have not been read yet. */
  readonly loading: boolean;
}

/** Every visible mark of every document, in tab order, then page order, then engine order. */
export function collectMarks(
  workspace: Workspace,
  pages: Readonly<Record<string, PageEntryLike | undefined>>,
): CollectedMarks {
  const entries: MarkEntry[] = [];
  let loading = false;
  for (const documentId of workspace.documentOrder) {
    const doc = workspace.documents[documentId];
    if (!doc) continue;
    doc.pages.forEach((page, i) => {
      if (page.ref.kind !== 'source') return;
      const { source, index } = page.ref;
      const entry = pages[pageKey(source, index)];
      if (!entry) {
        loading = true;
        return;
      }
      for (const a of entry.annotations) {
        if (!isRedactMark(a) || a.flags?.hidden) continue;
        entries.push({
          key: `${page.id}\u0000${a.id}`,
          markKey: markKeyOf(source, a.id),
          documentId,
          documentTitle: doc.title,
          pageId: page.id,
          position: i + 1,
          source,
          sourceIndex: index,
          mark: a,
        });
      }
    });
  }
  return { entries, loading };
}

/** Next (+1) or previous (-1) row key, wrapping; from none, the first or the last. */
export function stepKey(
  keys: readonly string[],
  current: string | null,
  direction: 1 | -1,
): string | null {
  if (keys.length === 0) return null;
  const at = current === null ? -1 : keys.indexOf(current);
  if (at < 0) return (direction > 0 ? keys[0] : keys[keys.length - 1]) ?? null;
  return keys[(at + direction + keys.length) % keys.length] ?? null;
}

// ---------------------------------------------------------------------------
// Finder results
// ---------------------------------------------------------------------------

export interface FinderMatch {
  readonly id: string;
  readonly pattern: PatternId;
  readonly text: string;
  readonly pageId: PageId;
  readonly position: number;
  readonly source: SourceId;
  readonly sourceIndex: number;
  readonly quads: readonly Rect[];
  /** The page's text version when found (`pageTextKey`): a later text edit makes it stale. */
  readonly textKey: string;
}

export type FinderStatus = 'idle' | 'running' | 'done' | 'error';

export interface FinderState {
  readonly status: FinderStatus;
  readonly documentId: DocumentId | null;
  readonly matches: readonly FinderMatch[];
  /** Ids of matches ticked for "Mark selected". */
  readonly checked: ReadonlySet<string>;
  readonly progress: { readonly done: number; readonly total: number };
}

const IDLE_FINDER: FinderState = {
  status: 'idle',
  documentId: null,
  matches: [],
  checked: new Set(),
  progress: { done: 0, total: 0 },
};

/** Patterns whose matches start unticked: dates are rarely what one wants to hide. */
export const UNTICKED_BY_DEFAULT: ReadonlySet<PatternId> = new Set<PatternId>(['date']);

interface RedactionState {
  /** Marks (markKey) left out of "apply selected". */
  readonly excluded: ReadonlySet<string>;
  /** Row key of the mark under review. */
  readonly current: string | null;
  readonly finder: FinderState;

  setIncluded: (markKeys: readonly string[], included: boolean) => void;
  setCurrent: (key: string | null) => void;
  setFinder: (patch: Partial<FinderState>) => void;
  setMatchesChecked: (ids: readonly string[], checked: boolean) => void;
  clearFinder: () => void;
}

export const useRedactionStore = create<RedactionState>()((set) => ({
  excluded: new Set(),
  current: null,
  finder: IDLE_FINDER,

  setIncluded: (markKeys, included) =>
    set((s) => {
      const excluded = new Set(s.excluded);
      for (const key of markKeys) {
        if (included) excluded.delete(key);
        else excluded.add(key);
      }
      return { excluded };
    }),
  setCurrent: (current) => set((s) => (s.current === current ? s : { current })),
  setFinder: (patch) => set((s) => ({ finder: { ...s.finder, ...patch } })),
  setMatchesChecked: (ids, checked) =>
    set((s) => {
      const next = new Set(s.finder.checked);
      for (const id of ids) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return { finder: { ...s.finder, checked: next } };
    }),
  clearFinder: () => set({ finder: IDLE_FINDER }),
}));

/** Tests: back to the initial state. */
export function resetRedactionStore(): void {
  useRedactionStore.setState({ excluded: new Set(), current: null, finder: IDLE_FINDER });
}
