import { describe, expect, it } from 'vitest';
import { setLabelRanges } from '../labels';
import { movePages } from '../pages';
import { getDocument } from '../selectors';
import type { DocumentId, PageId } from '../types';
import {
  check,
  expectCode,
  labelsOf,
  names,
  open,
  outlineTitles,
  pageIds,
  pageOutline,
  pageTuple,
  must,
} from './fixtures';

describe('movePages within one document', () => {
  const { ws, docs } = open(['A', 6]);
  const [a] = docs as [DocumentId];
  const [a1, a2, a3, a4, , a6] = pageTuple(ws, a, 6);

  it('moves a selection forward using pre-removal indices', () => {
    // Drop before A6 (index 5 as the user sees it).
    const next = check(movePages(ws, { pageIds: [a2, a3], target: { document: a, index: 5 } }));
    expect(names(next, a)).toEqual(['A1', 'A4', 'A5', 'A2', 'A3', 'A6']);
  });

  it('moves a selection to the end', () => {
    const next = check(movePages(ws, { pageIds: [a2, a3], target: { document: a, index: 6 } }));
    expect(names(next, a)).toEqual(['A1', 'A4', 'A5', 'A6', 'A2', 'A3']);
  });

  it('moves a non-contiguous selection backward', () => {
    const next = check(movePages(ws, { pageIds: [a4, a6], target: { document: a, index: 1 } }));
    expect(names(next, a)).toEqual(['A1', 'A4', 'A6', 'A2', 'A3', 'A5']);
  });

  it('moves to the front', () => {
    const next = check(movePages(ws, { pageIds: [a3, a6], target: { document: a, index: 0 } }));
    expect(names(next, a)).toEqual(['A3', 'A6', 'A1', 'A2', 'A4', 'A5']);
  });

  it('preserves document order regardless of selection order', () => {
    const next = movePages(ws, { pageIds: [a6, a4], target: { document: a, index: 1 } });
    expect(names(next, a)).toEqual(['A1', 'A4', 'A6', 'A2', 'A3', 'A5']);
  });

  it('moves a selection that straddles the target', () => {
    // A1 and A4 dropped between A2 and A3 (index 2): A1 is before, A4 after.
    const next = check(movePages(ws, { pageIds: [a1, a4], target: { document: a, index: 2 } }));
    expect(names(next, a)).toEqual(['A2', 'A1', 'A4', 'A3', 'A5', 'A6']);
  });

  it('returns the same workspace when nothing moves', () => {
    for (const index of [1, 2, 3]) {
      expect(movePages(ws, { pageIds: [a2, a3], target: { document: a, index } })).toBe(ws);
    }
  });

  it('shares unchanged objects', () => {
    const next = movePages(ws, { pageIds: [a2], target: { document: a, index: 0 } });
    expect(next.sources).toBe(ws.sources);
    const before = getDocument(ws, a);
    const after = getDocument(next, a);
    expect(after.pages[2]).toBe(before.pages[2]);
    expect(after.clean).toBe(false);
  });
});

describe('movePages across documents', () => {
  const { ws, docs } = open(['A', 3, { outline: pageOutline('A', 3) }], ['B', 3]);
  const [a, b] = docs as [DocumentId, DocumentId];
  const [a1, a2, a3] = pageTuple(ws, a, 3);
  const [b1] = pageTuple(ws, b, 3);

  it('moves pages from A into B at the drop index', () => {
    const next = check(movePages(ws, { pageIds: [a3, a1], target: { document: b, index: 1 } }));
    expect(names(next, a)).toEqual(['A2']);
    expect(names(next, b)).toEqual(['B1', 'A1', 'A3', 'B2', 'B3']);
  });

  it('moves a selection spanning two documents', () => {
    const next = check(movePages(ws, { pageIds: [b1, a2], target: { document: a, index: 0 } }));
    expect(names(next, a)).toEqual(['A2', 'B1', 'A1', 'A3']);
    expect(names(next, b)).toEqual(['B2', 'B3']);
  });

  it('can empty a document without closing it', () => {
    const next = check(movePages(ws, { pageIds: [a1, a2, a3], target: { document: b, index: 3 } }));
    expect(names(next, a)).toEqual([]);
    expect(names(next, b)).toEqual(['B1', 'B2', 'B3', 'A1', 'A2', 'A3']);
    expect(next.documentOrder).toEqual(ws.documentOrder);
  });

  it('marks outline nodes of moved pages unresolved and restores them on return', () => {
    const moved = check(movePages(ws, { pageIds: [a2], target: { document: b, index: 0 } }));
    expect(outlineTitles(moved, a)).toEqual(['A p1', 'A p2 (unresolved)', 'A p3']);
    const back = check(movePages(moved, { pageIds: [a2], target: { document: a, index: 1 } }));
    expect(outlineTitles(back, a)).toEqual(['A p1', 'A p2', 'A p3']);
    expect(getDocument(back, a).outline[1]?.destination).toEqual({ kind: 'page', page: a2 });
  });

  it('rejects invalid input', () => {
    expectCode(
      () => movePages(ws, { pageIds: [], target: { document: a, index: 0 } }),
      'invalid-argument',
    );
    expectCode(
      () => movePages(ws, { pageIds: [a1, a1], target: { document: a, index: 0 } }),
      'duplicate-id',
    );
    expectCode(
      () => movePages(ws, { pageIds: ['nope' as PageId], target: { document: a, index: 0 } }),
      'unknown-page',
    );
    expectCode(
      () => movePages(ws, { pageIds: [a1], target: { document: 'x' as never, index: 0 } }),
      'unknown-document',
    );
    for (const index of [-1, 4, 1.5, Number.NaN]) {
      expectCode(
        () => movePages(ws, { pageIds: [a1], target: { document: a, index } }),
        'invalid-index',
      );
    }
  });
});

describe('movePages and explicit labels', () => {
  const base = open(['A', 6]);
  const a = must(base.docs[0]);
  // i, ii, 1, 2, 3, 4
  const ws = setLabelRanges(base.ws, a, [
    { startIndex: 0, style: 'roman-lower', firstNumber: 1 },
    { startIndex: 2, style: 'decimal', firstNumber: 1 },
  ]);
  const ids = pageIds(ws, a);

  it('keeps the body decimal when its first page moves to the end', () => {
    const next = check(
      movePages(ws, { pageIds: [must(ids[2])], target: { document: a, index: 6 } }),
    );
    expect(labelsOf(next, a)).toEqual(['i', 'ii', '1', '2', '3', '4']);
    expect(names(next, a)).toEqual(['A1', 'A2', 'A4', 'A5', 'A6', 'A3']);
  });

  it('moving a body page into the front matter extends the front matter', () => {
    const next = check(
      movePages(ws, { pageIds: [must(ids[5])], target: { document: a, index: 1 } }),
    );
    expect(labelsOf(next, a)).toEqual(['i', 'ii', 'iii', '1', '2', '3']);
  });
});
