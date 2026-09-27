/**
 * Find in document (spec §1): runs `PdfRenderer.search` in the engine worker for every
 * source the active document shows, maps source hits onto the document's pages (a source
 * page may appear several times, or not at all), streams them into the store as they
 * arrive, and keeps a current hit for Enter / F3 navigation. A new query cancels the
 * running search.
 */
import type {
  DocumentId,
  PageId,
  Rect,
  SourceId,
  VirtualDocument,
} from '@pdf-editor/document-model';
import type { SearchHit } from '@pdf-editor/engine';
import { create } from 'zustand';

import { getEngineService } from '../engine/engine-service';
import { type LeftPanelView, useUiStore } from '../state/ui-store';
import { useViewStore } from '../state/view-store';

export interface DocumentHit {
  /** Order of arrival; ties inside a page keep the engine's reading order. */
  readonly seq: number;
  readonly pageIndex: number;
  readonly pageId: PageId;
  readonly sourceId: SourceId;
  readonly rects: readonly Rect[];
  readonly context: string;
  /** Where the match sits in `context`, when the engine reports it. */
  readonly matchStart?: number;
  readonly matchLength?: number;
}

export type SearchStatus = 'idle' | 'searching' | 'done' | 'error';

export interface SearchOptions {
  readonly matchCase: boolean;
  readonly wholeWord: boolean;
}

interface SearchState extends SearchOptions {
  readonly query: string;
  readonly status: SearchStatus;
  readonly hits: readonly DocumentHit[];
  /** Index into `hits`, or -1. */
  readonly current: number;
  readonly documentId: DocumentId | null;
  /** Milliseconds from start to the first hit and to completion (diagnostics, tests). */
  readonly timing: { readonly first?: number; readonly total?: number };
  /** Bumped to ask the search field to take focus (Mod+F). */
  readonly focusSerial: number;
}

const INITIAL: SearchState = {
  query: '',
  matchCase: false,
  wholeWord: false,
  status: 'idle',
  hits: [],
  current: -1,
  documentId: null,
  timing: {},
  focusSerial: 0,
};

export const useSearchStore = create<SearchState>()(() => INITIAL);

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Document page indices per `${sourceId}:${sourceIndex}`. */
export function sourcePageMap(doc: VirtualDocument): Map<string, number[]> {
  const map = new Map<string, number[]>();
  doc.pages.forEach((page, index) => {
    if (page.ref.kind !== 'source') return;
    const key = `${page.ref.source}:${page.ref.index}`;
    const list = map.get(key);
    if (list) list.push(index);
    else map.set(key, [index]);
  });
  return map;
}

/** Maps a source's hits onto document pages. `seq` continues from `firstSeq`. */
export function mapHits(
  doc: VirtualDocument,
  pages: ReadonlyMap<string, readonly number[]>,
  sourceId: SourceId,
  hits: readonly SearchHit[],
  firstSeq: number,
): DocumentHit[] {
  const out: DocumentHit[] = [];
  let seq = firstSeq;
  for (const hit of hits) {
    for (const pageIndex of pages.get(`${sourceId}:${hit.pageIndex}`) ?? []) {
      const page = doc.pages[pageIndex];
      if (!page) continue;
      const { matchStart, matchLength } = hit as SearchHit & {
        readonly matchStart?: number;
        readonly matchLength?: number;
      };
      out.push({
        seq: seq++,
        pageIndex,
        pageId: page.id,
        sourceId,
        rects: hit.rects,
        context: hit.context,
        ...(typeof matchStart === 'number' && typeof matchLength === 'number'
          ? { matchStart, matchLength }
          : {}),
      });
    }
  }
  return out;
}

/** Navigation order: by document page, then as the engine reported them. */
export function sortHits(hits: readonly DocumentHit[]): DocumentHit[] {
  return [...hits].sort((a, b) => a.pageIndex - b.pageIndex || a.seq - b.seq);
}

/** Next (+1) or previous (-1) hit index, wrapping; the first step from none picks an end. */
export function stepHit(current: number, count: number, direction: 1 | -1): number {
  if (count === 0) return -1;
  if (current < 0 || current >= count) return direction > 0 ? 0 : count - 1;
  return (current + direction + count) % count;
}

/** The first hit at or after `pageIndex` (wrapping), for starting from where the reader is. */
export function firstHitFrom(hits: readonly DocumentHit[], pageIndex: number): number {
  if (hits.length === 0) return -1;
  const index = hits.findIndex((hit) => hit.pageIndex >= pageIndex);
  return index < 0 ? 0 : index;
}

export interface HitGroup {
  readonly pageIndex: number;
  readonly pageId: PageId;
  /** `index` is the position in the flat, sorted hit list. */
  readonly hits: readonly { readonly index: number; readonly hit: DocumentHit }[];
}

/** Groups sorted hits by page, preserving order. */
export function groupHitsByPage(hits: readonly DocumentHit[]): HitGroup[] {
  const groups: {
    pageIndex: number;
    pageId: PageId;
    hits: { index: number; hit: DocumentHit }[];
  }[] = [];
  hits.forEach((hit, index) => {
    const last = groups[groups.length - 1];
    if (last?.pageIndex === hit.pageIndex) last.hits.push({ index, hit });
    else groups.push({ pageIndex: hit.pageIndex, pageId: hit.pageId, hits: [{ index, hit }] });
  });
  return groups;
}

/**
 * Splits a context snippet around its match, for emphasis: at the engine's offsets when it
 * reports them, else at the first occurrence of the query. Whitespace runs are collapsed;
 * falls back to the whole snippet when nothing is found.
 */
export function splitContext(
  hit: Pick<DocumentHit, 'context' | 'matchStart' | 'matchLength'>,
  query: string,
  matchCase: boolean,
): { before: string; match: string; after: string } {
  const squash = (text: string) => text.replace(/\s+/g, ' ');
  const { context, matchStart, matchLength } = hit;
  if (
    matchStart !== undefined &&
    matchLength !== undefined &&
    matchStart >= 0 &&
    matchStart + matchLength <= context.length
  ) {
    return {
      before: squash(context.slice(0, matchStart)),
      match: squash(context.slice(matchStart, matchStart + matchLength)),
      after: squash(context.slice(matchStart + matchLength)),
    };
  }
  const text = squash(context);
  const needle = query.trim();
  if (needle === '') return { before: text, match: '', after: '' };
  const at = matchCase
    ? text.indexOf(needle)
    : text.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase());
  if (at < 0) return { before: text, match: '', after: '' };
  return {
    before: text.slice(0, at),
    match: text.slice(at, at + needle.length),
    after: text.slice(at + needle.length),
  };
}

/** Union of a hit's rects (to scroll it into view). */
export function hitBounds(hit: DocumentHit): Rect | undefined {
  if (hit.rects.length === 0) return undefined;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of hit.rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.width);
    y1 = Math.max(y1, r.y + r.height);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

let controller: AbortController | undefined;
/** Streaming results are merged into the store at most this often. */
const PUBLISH_INTERVAL_MS = 50;

function sourcesOf(doc: VirtualDocument): SourceId[] {
  const seen = new Set<SourceId>();
  for (const page of doc.pages) if (page.ref.kind === 'source') seen.add(page.ref.source);
  return [...seen];
}

/**
 * Starts a search of `doc` with the store's query and options, cancelling any running one.
 * `startPage` picks the first current hit (the reader's page). Resolves when done or
 * cancelled.
 */
export async function runSearch(doc: VirtualDocument | undefined, startPage = 0): Promise<void> {
  controller?.abort();
  const { query, matchCase, wholeWord } = useSearchStore.getState();
  const needle = query.trim();
  if (!doc || needle === '') {
    controller = undefined;
    useSearchStore.setState({
      status: 'idle',
      hits: [],
      current: -1,
      documentId: doc?.id ?? null,
      timing: {},
    });
    return;
  }
  const own = new AbortController();
  controller = own;
  const started = performance.now();
  useSearchStore.setState({
    status: 'searching',
    hits: [],
    current: -1,
    documentId: doc.id,
    timing: {},
  });
  const pages = sourcePageMap(doc);
  let seq = 0;
  let lastPublish = 0;
  let collected: DocumentHit[] = [];
  let failed = false;

  const publish = (next: DocumentHit[]) => {
    if (own.signal.aborted) return;
    collected = sortHits(next);
    const state = useSearchStore.getState();
    const timing =
      state.timing.first === undefined && collected.length > 0
        ? { first: performance.now() - started }
        : state.timing;
    // Keep the current hit stable while results stream in; pick one once hits exist.
    const previous = state.hits[state.current];
    let current = previous ? collected.findIndex((h) => h.seq === previous.seq) : -1;
    if (current < 0) current = firstHitFrom(collected, startPage);
    useSearchStore.setState({ hits: collected, current, timing });
  };

  for (const sourceId of sourcesOf(doc)) {
    if (own.signal.aborted) return;
    const streamed: DocumentHit[] = [];
    const base = collected;
    const result = await getEngineService().search(
      sourceId,
      needle,
      { matchCase, wholeWord },
      own.signal,
      (hits) => {
        const mapped = mapHits(doc, pages, sourceId, hits, seq);
        if (mapped.length === 0) return;
        seq += mapped.length;
        streamed.push(...mapped);
        // The first hits show at once; later ones at most every PUBLISH_INTERVAL_MS, so a
        // long document does not re-sort and re-render once per page.
        const now = performance.now();
        if (collected.length === 0 || now - lastPublish >= PUBLISH_INTERVAL_MS) {
          lastPublish = now;
          publish([...base, ...streamed]);
        }
      },
    );
    if (own.signal.aborted) return;
    if (!result.ok) {
      failed = true;
      continue;
    }
    // The complete list is authoritative (a streaming engine may have sent partials).
    const mapped = mapHits(doc, pages, sourceId, result.value, seq);
    seq += mapped.length;
    publish([...base, ...mapped]);
  }
  if (own.signal.aborted) return;
  controller = undefined;
  useSearchStore.setState((s) => ({
    status: failed && collected.length === 0 ? 'error' : 'done',
    timing: { ...s.timing, total: performance.now() - started },
  }));
}

export function setSearchQuery(query: string): void {
  useSearchStore.setState({ query });
}

export function setSearchOptions(options: Partial<SearchOptions>): void {
  useSearchStore.setState(options);
}

/** Moves the current hit; returns the new current hit. */
export function stepSearch(direction: 1 | -1): DocumentHit | undefined {
  const { hits, current } = useSearchStore.getState();
  const next = stepHit(current, hits.length, direction);
  useSearchStore.setState({ current: next });
  return hits[next];
}

export function selectHit(index: number): DocumentHit | undefined {
  const { hits } = useSearchStore.getState();
  if (index < 0 || index >= hits.length) return undefined;
  useSearchStore.setState({ current: index });
  return hits[index];
}

/** Cancels any running search and forgets query and results (Esc). */
export function clearSearch(): void {
  controller?.abort();
  controller = undefined;
  useSearchStore.setState((s) => ({ ...INITIAL, focusSerial: s.focusSerial }));
}

export function requestSearchFocus(): void {
  useSearchStore.setState((s) => ({ focusSerial: s.focusSerial + 1 }));
}

/** Shows a hit: Read mode, its page scrolled so the match is visible. */
export function revealHit(hit: DocumentHit | undefined): void {
  if (!hit) return;
  const ui = useUiStore.getState();
  if (ui.viewMode !== 'read') ui.setViewMode('read');
  const bounds = hitBounds(hit);
  useViewStore
    .getState()
    .scrollToPage(hit.pageId, bounds === undefined ? undefined : { reveal: bounds });
}

// ---------------------------------------------------------------------------
// Panel open / close (Mod+F, Esc)
// ---------------------------------------------------------------------------

/** What the left panel showed before Mod+F, so Esc can put it back. */
let restoreView: { readonly open: boolean; readonly view: LeftPanelView } | null = null;

/** Shows the Search panel in the left rail and focuses its field. */
export function openSearchPanel(): void {
  const ui = useUiStore.getState();
  if (!(ui.leftPanelOpen && ui.leftPanelView === 'search')) {
    restoreView = { open: ui.leftPanelOpen, view: ui.leftPanelView };
    useUiStore.setState({ leftPanelOpen: true, leftPanelView: 'search' });
  }
  requestSearchFocus();
}

/** Clears the search and returns the left panel to what it showed before (Esc). */
export function closeSearchPanel(): void {
  clearSearch();
  const ui = useUiStore.getState();
  if (ui.leftPanelOpen && ui.leftPanelView === 'search') {
    const previous = restoreView;
    useUiStore.setState(
      previous && previous.view !== 'search'
        ? { leftPanelOpen: previous.open, leftPanelView: previous.view }
        : { leftPanelOpen: false },
    );
  }
  restoreView = null;
}

/** Moves to the next / previous hit and shows it. */
export function searchStep(direction: 1 | -1): void {
  revealHit(stepSearch(direction));
}
