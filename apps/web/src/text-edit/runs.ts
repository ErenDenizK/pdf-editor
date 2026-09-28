/**
 * Located runs per source page for the Edit text tool (`PdfTextEditor.locateRuns`), cached
 * per page *revision*: every edit (text or annotation, applied, undone or replayed) bumps
 * the page's revision in the engine service, and run references go stale after any change
 * to the page (spec §2.5), so a new revision always locates again. Failures are not cached.
 */
import type { SourceId } from '@pdf-editor/document-model';
import type { LocatedRun } from '@pdf-editor/engine';
import { useEffect, useState, useSyncExternalStore } from 'react';

import { getEngineService } from '../engine/engine-service';

const cache = new Map<string, Promise<readonly LocatedRun[]>>();
const MAX_PAGES = 32;

getEngineService().onSourceClosed((source) => {
  for (const key of [...cache.keys()]) if (key.startsWith(`${source}:`)) cache.delete(key);
});

/** The page's current content revision (changes after every edit of the page). */
export function pageRevision(source: SourceId, pageIndex: number): number {
  return getEngineService().pageRevision(source, pageIndex);
}

/** Runs of a source page at its current revision. Rejects when the engine fails. */
export function locatedRuns(source: SourceId, pageIndex: number): Promise<readonly LocatedRun[]> {
  const service = getEngineService();
  const key = `${source}:${pageIndex}:${service.pageRevision(source, pageIndex)}`;
  let runs = cache.get(key);
  if (!runs) {
    const pending = service.textEditor().then((editor) => editor.locateRuns(source, pageIndex));
    runs = pending;
    cache.set(key, pending);
    pending.catch(() => {
      if (cache.get(key) === pending) cache.delete(key);
    });
    // Older revisions of the page are useless now.
    const prefix = `${source}:${pageIndex}:`;
    for (const old of [...cache.keys()])
      if (old.startsWith(prefix) && old !== key) cache.delete(old);
    while (cache.size > MAX_PAGES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }
  return runs;
}

/** The page's revision as React state. */
export function usePageRevision(source: SourceId | undefined, pageIndex: number): number {
  const service = getEngineService();
  return useSyncExternalStore(service.subscribeRevisions, () =>
    source === undefined ? 0 : service.pageRevision(source, pageIndex),
  );
}

/**
 * Runs of a source page while `source` is given, re-located on every revision. Null while
 * loading (or when the engine failed: the tool then offers nothing on the page).
 */
export function usePageRuns(
  source: SourceId | undefined,
  pageIndex: number,
  revision: number,
): readonly LocatedRun[] | null {
  const key = source === undefined ? '' : `${source}:${pageIndex}:${revision}`;
  const [state, setState] = useState<{ key: string; runs: readonly LocatedRun[] } | null>(null);
  useEffect(() => {
    if (source === undefined) return;
    let live = true;
    locatedRuns(source, pageIndex).then(
      (runs) => {
        if (live) setState({ key, runs });
      },
      (error: unknown) => {
        console.warn('Locating the text runs failed', error);
      },
    );
    return () => {
      live = false;
    };
  }, [source, pageIndex, key]);
  return state?.key === key ? state.runs : null;
}
