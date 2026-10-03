/**
 * Panel and command actions on marks: reveal one (J / K review), delete one, find
 * sensitive data with the pattern helpers, mark the ticked finds, and mark every search
 * hit. Everything creates or removes marks only; nothing is applied.
 */
import type {
  PageId,
  Rect,
  SourceId,
  VirtualDocument,
  Workspace,
} from '@pdf-editor/document-model';

import { deleteAnnotations } from '../annotations/actions';
import { type PageTarget, useAnnotationStore } from '../annotations/annotation-store';
import { pageText } from '../annotations/page-text';
import { m } from '../i18n';
import { announce } from '../shell/announcer';
import { canEdit, isPageView, useUiStore } from '../state/ui-store';
import { useViewStore } from '../state/view-store';
import { useWorkspaceStore } from '../state/workspace-store';
import { useSearchStore } from '../viewer/search';
import { createMarks, markBounds, type MarkRequest } from './marks';
import { findPatterns, PATTERN_IDS, type PatternId } from './patterns';
import {
  collectMarks,
  type FinderMatch,
  type MarkEntry,
  stepKey,
  UNTICKED_BY_DEFAULT,
  useRedactionStore,
} from './redaction-store';
import { indexPageText, quadsForTextRange } from './text-index';

function targetOf(entry: {
  readonly source: SourceId;
  readonly sourceIndex: number;
  readonly pageId: PageId;
  readonly position: number;
}): PageTarget {
  return {
    source: entry.source,
    pageIndex: entry.sourceIndex,
    pageId: entry.pageId,
    position: entry.position,
  };
}

/** Every mark of the workspace as the panel lists it (from the loaded pages). */
export function currentMarks(): readonly MarkEntry[] {
  return collectMarks(useWorkspaceStore.getState().workspace, useAnnotationStore.getState().pages)
    .entries;
}

/** Shows a mark: its document and page in Read mode, scrolled to it, and selected. */
export function revealMark(entry: MarkEntry): void {
  const workspace = useWorkspaceStore.getState();
  if (workspace.workspace.activeDocument !== entry.documentId) {
    workspace.setActive(entry.documentId);
  }
  const ui = useUiStore.getState();
  if (!isPageView(ui)) ui.setViewMode('read');
  useViewStore.getState().scrollToPage(entry.pageId, { reveal: markBounds(entry.mark.quads) });
  useAnnotationStore.getState().select({ ...targetOf(entry), ids: [entry.mark.id] });
  useRedactionStore.getState().setCurrent(entry.key);
}

/** J / K: the next or previous mark in panel order. Returns whether there was one. */
export function stepMark(direction: 1 | -1): boolean {
  const marks = currentMarks();
  const key = stepKey(
    marks.map((e) => e.key),
    useRedactionStore.getState().current,
    direction,
  );
  const entry = marks.find((e) => e.key === key);
  if (!entry) {
    announce(m.redaction_none());
    return false;
  }
  revealMark(entry);
  const index = marks.indexOf(entry) + 1;
  announce(m.redaction_reviewing({ index, total: marks.length, page: entry.position }));
  return true;
}

export function deleteMark(entry: MarkEntry): Promise<number | undefined> {
  return deleteAnnotations(targetOf(entry), [entry.mark.id]);
}

// ---------------------------------------------------------------------------
// Sensitive data finder
// ---------------------------------------------------------------------------

let finderRun = 0;

/**
 * Which version of a source page's text the model holds: the ids of the engine edits that
 * change it (text edits on the page, applied redactions anywhere in the source). Unlike
 * the page's render revision it does not move when a mark is added, so finder results
 * survive "Mark selected" and come back when a text edit is undone.
 */
export function pageTextKey(ws: Workspace, source: SourceId, pageIndex: number): string {
  return ws.engineEdits
    .filter(
      (e) =>
        e.source === source &&
        (e.kind === 'redaction.apply' || (e.kind === 'text.edit' && e.pageIndex === pageIndex)),
    )
    .map((e) => e.id)
    .join(',');
}

/** Whether the text of a finder match's page changed since it was found. */
export function isStaleMatch(ws: Workspace, match: FinderMatch): boolean {
  return pageTextKey(ws, match.source, match.sourceIndex) !== match.textKey;
}

/**
 * Runs the pattern helpers over every page of `doc` (each source page once) and lists the
 * matches for review. A new run cancels the previous one.
 */
export async function findSensitiveData(
  doc: VirtualDocument,
  patterns: readonly PatternId[] = PATTERN_IDS,
): Promise<void> {
  const run = ++finderRun;
  const store = useRedactionStore.getState();
  const pages: { pageId: PageId; position: number; source: SourceId; sourceIndex: number }[] = [];
  const seen = new Set<string>();
  doc.pages.forEach((page, i) => {
    if (page.ref.kind !== 'source') return;
    const key = `${page.ref.source}:${page.ref.index}`;
    if (seen.has(key)) return;
    seen.add(key);
    pages.push({
      pageId: page.id,
      position: i + 1,
      source: page.ref.source,
      sourceIndex: page.ref.index,
    });
  });
  store.setFinder({
    status: 'running',
    documentId: doc.id,
    matches: [],
    checked: new Set(),
    progress: { done: 0, total: pages.length },
  });
  const matches: FinderMatch[] = [];
  const checked = new Set<string>();
  try {
    for (const [n, page] of pages.entries()) {
      const runs = await pageText(page.source, page.sourceIndex);
      if (run !== finderRun) return;
      const textKey = pageTextKey(
        useWorkspaceStore.getState().workspace,
        page.source,
        page.sourceIndex,
      );
      const index = indexPageText(runs);
      for (const found of findPatterns(index.text, patterns)) {
        const quads = quadsForTextRange(runs, index, found.start, found.end);
        if (quads.length === 0) continue;
        const id = `${page.pageId}:${found.start}:${found.pattern}`;
        matches.push({
          id,
          pattern: found.pattern,
          text: found.text.replace(/\s+/g, ' '),
          quads,
          textKey,
          ...page,
        });
        if (!UNTICKED_BY_DEFAULT.has(found.pattern)) checked.add(id);
      }
      useRedactionStore.getState().setFinder({ progress: { done: n + 1, total: pages.length } });
    }
  } catch (error) {
    console.warn('Finding sensitive data failed', error);
    if (run === finderRun) useRedactionStore.getState().setFinder({ status: 'error' });
    return;
  }
  if (run !== finderRun) return;
  useRedactionStore.getState().setFinder({ status: 'done', matches, checked });
  announce(m.redaction_find_done({ count: matches.length }));
}

/** Cancels a running search for sensitive data and forgets its results. */
export function clearFinder(): void {
  finderRun += 1;
  useRedactionStore.getState().clearFinder();
}

function groupByPage<T extends { source: SourceId; sourceIndex: number }>(
  items: readonly T[],
  target: (item: T) => PageTarget,
  quads: (item: T) => MarkRequest['marks'][number],
): MarkRequest[] {
  const byPage = new Map<string, { target: PageTarget; marks: MarkRequest['marks'][number][] }>();
  for (const item of items) {
    const key = `${item.source}:${item.sourceIndex}`;
    const entry = byPage.get(key) ?? { target: target(item), marks: [] };
    entry.marks.push(quads(item));
    byPage.set(key, entry);
  }
  return [...byPage.values()];
}

/** Creates marks for the ticked finds (one history entry); they leave the review list. */
export async function markCheckedFinds(): Promise<number> {
  const { finder } = useRedactionStore.getState();
  const ws = useWorkspaceStore.getState().workspace;
  const chosen = finder.matches.filter(
    (match) => finder.checked.has(match.id) && !isStaleMatch(ws, match),
  );
  if (chosen.length === 0) return 0;
  const done = await createMarks(
    groupByPage(chosen, targetOf, (match) => match.quads),
    { label: (count) => m.history_redaction_finds({ count }), select: false },
  );
  const marked = new Set(chosen.map((match) => match.id));
  const current = useRedactionStore.getState().finder;
  useRedactionStore.getState().setFinder({
    matches: current.matches.filter((match) => !marked.has(match.id)),
    checked: new Set([...current.checked].filter((id) => !marked.has(id))),
  });
  return done?.length ?? 0;
}

// ---------------------------------------------------------------------------
// Search integration
// ---------------------------------------------------------------------------

/**
 * Creates a mark over every hit of the current search (one history entry). Marks are page
 * edits: nothing in Read (ADR-0019 §3).
 */
export async function markSearchHits(): Promise<number> {
  const { hits, documentId } = useSearchStore.getState();
  const workspace = useWorkspaceStore.getState().workspace;
  const doc = documentId === null ? undefined : workspace.documents[documentId];
  if (!doc || hits.length === 0 || !canEdit(doc.id)) return 0;
  // A source page shown twice has its hits twice; one mark covers both.
  const seen = new Set<string>();
  const items: {
    source: SourceId;
    sourceIndex: number;
    pageId: PageId;
    position: number;
    rects: readonly Rect[];
  }[] = [];
  for (const hit of hits) {
    const page = doc.pages[hit.pageIndex];
    if (page?.ref.kind !== 'source' || hit.rects.length === 0) continue;
    const key = `${hit.sourceId}:${page.ref.index}:${JSON.stringify(hit.rects)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      source: hit.sourceId,
      sourceIndex: page.ref.index,
      pageId: page.id,
      position: hit.pageIndex + 1,
      rects: hit.rects,
    });
  }
  const done = await createMarks(
    groupByPage(items, targetOf, (item) => item.rects),
    { label: (count) => m.history_redaction_matches({ count }), select: false },
  );
  return done?.length ?? 0;
}
