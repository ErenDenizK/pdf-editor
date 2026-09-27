/** Text runs of source pages for text markup, cached per page (the text never changes). */
import type { SourceId } from '@pdf-editor/document-model';
import type { TextRun } from '@pdf-editor/engine';

import { getEngineService } from '../engine/engine-service';

const cache = new Map<string, Promise<readonly TextRun[]>>();
const MAX_PAGES = 64;

getEngineService().onSourceClosed((source) => {
  for (const key of [...cache.keys()]) if (key.startsWith(`${source}:`)) cache.delete(key);
});

export function pageText(source: SourceId, pageIndex: number): Promise<readonly TextRun[]> {
  const key = `${source}:${pageIndex}`;
  let runs = cache.get(key);
  if (!runs) {
    runs = getEngineService()
      .getPageText(source, pageIndex)
      .then((result) => (result.ok ? result.value : []));
    if (cache.size >= MAX_PAGES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, runs);
  }
  return runs;
}
