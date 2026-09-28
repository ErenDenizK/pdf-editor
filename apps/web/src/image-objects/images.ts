/**
 * Located images per source page for the Image tool (`PdfImageEditor.locateImages`), cached
 * per page *revision*, like the Edit text tool's runs (text-edit/runs.ts): every edit bumps
 * the page's revision, and object paths go stale after any change to the page, so a new
 * revision always locates again. Failures are not cached.
 */
import type { SourceId } from '@pdf-editor/document-model';
import type { LocatedImage } from '@pdf-editor/engine';
import { useEffect, useState } from 'react';

import { getEngineService } from '../engine/engine-service';

const cache = new Map<string, Promise<readonly LocatedImage[]>>();
const MAX_PAGES = 32;

getEngineService().onSourceClosed((source) => {
  for (const key of [...cache.keys()]) if (key.startsWith(`${source}:`)) cache.delete(key);
});

/** Images of a source page at its current revision. Rejects when the engine fails. */
export function locatedImages(
  source: SourceId,
  pageIndex: number,
): Promise<readonly LocatedImage[]> {
  const service = getEngineService();
  const key = `${source}:${pageIndex}:${service.pageRevision(source, pageIndex)}`;
  let images = cache.get(key);
  if (!images) {
    const pending = service.imageEditor().then((editor) => editor.locateImages(source, pageIndex));
    images = pending;
    cache.set(key, pending);
    pending.catch(() => {
      if (cache.get(key) === pending) cache.delete(key);
    });
    const prefix = `${source}:${pageIndex}:`;
    for (const old of [...cache.keys()]) {
      if (old.startsWith(prefix) && old !== key) cache.delete(old);
    }
    while (cache.size > MAX_PAGES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }
  return images;
}

/**
 * Images of a source page while `source` is given, located again on every revision. Null
 * while loading (or when the engine failed: the tool then offers nothing on the page).
 */
export function usePageImages(
  source: SourceId | undefined,
  pageIndex: number,
  revision: number,
): readonly LocatedImage[] | null {
  const key = source === undefined ? '' : `${source}:${pageIndex}:${revision}`;
  const [state, setState] = useState<{
    key: string;
    images: readonly LocatedImage[];
  } | null>(null);
  useEffect(() => {
    if (source === undefined) return;
    let live = true;
    locatedImages(source, pageIndex).then(
      (images) => {
        if (live) setState({ key, images });
      },
      (error: unknown) => {
        console.warn('Locating the images failed', error);
      },
    );
    return () => {
      live = false;
    };
  }, [source, pageIndex, key]);
  return state?.key === key ? state.images : null;
}
