/**
 * Search: pure helpers (mapping source hits onto document pages, grouping, navigation
 * order) and a real run over many-pages.pdf in the engine worker (streaming, latency,
 * cancellation).
 */
import type { PageId, SourceId, VirtualDocument, VirtualPage } from '@pdf-editor/document-model';
import type { SearchHit } from '@pdf-editor/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import manyPagesUrl from '../../../../test/fixtures/many-pages.pdf?url';
import { getEngineService } from '../engine/engine-service';
import {
  type DocumentHit,
  firstHitFrom,
  groupHitsByPage,
  mapHits,
  runSearch,
  setSearchOptions,
  setSearchQuery,
  sortHits,
  sourcePageMap,
  splitContext,
  stepHit,
  clearSearch,
  useSearchStore,
} from './search';

const A = 'src-a' as SourceId;
const B = 'src-b' as SourceId;

function page(id: string, source: SourceId, index: number): VirtualPage {
  return { id: id as PageId, ref: { kind: 'source', source, index }, rotation: 0, overlays: [] };
}

function doc(pages: VirtualPage[]): VirtualDocument {
  return { id: 'doc', title: 'Doc', pages, outline: [], labels: [] } as unknown as VirtualDocument;
}

const hit = (pageIndex: number, context = 'ctx'): SearchHit => ({
  pageIndex,
  rects: [{ x: 1, y: 2, width: 3, height: 4 }],
  context,
});

describe('mapping and ordering', () => {
  // Document order: A2, B0, A0 (twice: a duplicated page), A1 was deleted.
  const d = doc([page('p0', A, 2), page('p1', B, 0), page('p2', A, 0), page('p3', A, 0)]);
  const pages = sourcePageMap(d);

  it('maps source hits to every document page that shows the source page', () => {
    const mapped = mapHits(d, pages, A, [hit(0), hit(1), hit(2)], 0);
    expect(mapped.map((h) => [h.pageIndex, h.pageId, h.seq])).toEqual([
      [2, 'p2', 0],
      [3, 'p3', 1],
      [0, 'p0', 2],
    ]);
  });

  it('sorts by document page, keeping the engine order inside a page', () => {
    const fromA = mapHits(d, pages, A, [hit(0, 'a0-first'), hit(0, 'a0-second'), hit(2)], 0);
    const fromB = mapHits(d, pages, B, [hit(0)], fromA.length);
    const sorted = sortHits([...fromA, ...fromB]);
    expect(sorted.map((h) => `${h.pageIndex}:${h.context}`)).toEqual([
      '0:ctx',
      '1:ctx',
      '2:a0-first',
      '2:a0-second',
      '3:a0-first',
      '3:a0-second',
    ]);
    const groups = groupHitsByPage(sorted);
    expect(groups.map((g) => [g.pageIndex, g.hits.map((h) => h.index)])).toEqual([
      [0, [0]],
      [1, [1]],
      [2, [2, 3]],
      [3, [4, 5]],
    ]);
  });

  it('steps forward and back with wrap-around', () => {
    expect(stepHit(-1, 5, 1)).toBe(0);
    expect(stepHit(-1, 5, -1)).toBe(4);
    expect(stepHit(4, 5, 1)).toBe(0);
    expect(stepHit(0, 5, -1)).toBe(4);
    expect(stepHit(2, 5, 1)).toBe(3);
    expect(stepHit(0, 0, 1)).toBe(-1);
  });

  it('starts from the first hit at or after the reader', () => {
    const hits = [0, 0, 3, 7].map((pageIndex, seq) => ({ pageIndex, seq }) as DocumentHit);
    expect(firstHitFrom(hits, 0)).toBe(0);
    expect(firstHitFrom(hits, 1)).toBe(2);
    expect(firstHitFrom(hits, 7)).toBe(3);
    expect(firstHitFrom(hits, 8)).toBe(0);
  });

  it('emphasises the match in its context', () => {
    expect(splitContext({ context: 'Go to   page 4' }, 'PAGE', false)).toEqual({
      before: 'Go to ',
      match: 'page',
      after: ' 4',
    });
    expect(
      splitContext({ context: 'PAGE 2 page', matchStart: 7, matchLength: 4 }, 'page', false),
    ).toEqual({
      before: 'PAGE 2 ',
      match: 'page',
      after: '',
    });
    expect(splitContext({ context: 'abc' }, 'x', true)).toEqual({
      before: 'abc',
      match: '',
      after: '',
    });
  });
});

describe('searching many-pages.pdf in the engine', () => {
  const service = getEngineService();
  let sourceId: SourceId;
  let document: VirtualDocument;

  beforeAll(async () => {
    const bytes = await (await fetch(manyPagesUrl)).arrayBuffer();
    const opened = await service.open(new File([bytes], 'many-pages.pdf'));
    if (!opened.ok) throw new Error(opened.error.message);
    sourceId = opened.value.id;
    document = doc(
      Array.from({ length: opened.value.document.pageCount }, (_, i) => page(`p${i}`, sourceId, i)),
    );
  }, 30_000);

  afterAll(async () => {
    clearSearch();
    await service.close(sourceId);
  });

  it('streams hits page by page and reports first-result latency', async () => {
    const pagesSeen: number[] = [];
    const unsubscribe = useSearchStore.subscribe((s) => pagesSeen.push(s.hits.length));
    setSearchOptions({ matchCase: false, wholeWord: true });
    setSearchQuery('7');
    await runSearch(document, 0);
    unsubscribe();
    const { hits, timing, status, current } = useSearchStore.getState();
    // Whole word "7": only page 7 carries the bare number.
    expect(status).toBe('done');
    expect(hits.map((h) => h.pageIndex)).toEqual([6]);
    expect(current).toBe(0);
    expect(timing.first).toBeDefined();
    console.warn(
      `[search] many-pages.pdf "7" (whole word): first hit ${timing.first?.toFixed(0)} ms, done ${timing.total?.toFixed(0)} ms`,
    );
    expect(timing.first ?? Infinity).toBeLessThan(500);

    setSearchOptions({ wholeWord: false });
    setSearchQuery('1');
    const counts: number[] = [];
    const off = useSearchStore.subscribe((s) => counts.push(s.hits.length));
    await runSearch(document, 50);
    off();
    const all = useSearchStore.getState();
    console.warn(
      `[search] many-pages.pdf "1": ${all.hits.length} hits, first ${all.timing.first?.toFixed(0)} ms, done ${all.timing.total?.toFixed(0)} ms`,
    );
    expect(all.hits.length).toBeGreaterThan(100);
    // A partial result was shown before the search finished: the results streamed.
    expect(counts.some((c) => c > 0 && c < all.hits.length)).toBe(true);
    // Current hit starts at the reader's page (index 50 → page 51 or later).
    expect(all.hits[all.current]?.pageIndex).toBeGreaterThanOrEqual(50);
    expect(sortHits(all.hits)).toEqual(all.hits);
  }, 30_000);

  it('a new search cancels the running one', async () => {
    setSearchQuery('1');
    const first = runSearch(document, 0);
    setSearchQuery('399');
    const second = runSearch(document, 0);
    await Promise.all([first, second]);
    const { hits, status } = useSearchStore.getState();
    expect(status).toBe('done');
    expect(hits.map((h) => h.pageIndex)).toEqual([398]);
  }, 30_000);
});
