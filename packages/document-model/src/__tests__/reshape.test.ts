import { describe, expect, it } from 'vitest';
import { setLabelRanges } from '../labels';
import { interleave, mergeDocuments, movePages, splitDocument } from '../pages';
import { documentsInOrder, getDocument } from '../selectors';
import type { DocumentId } from '../types';
import type { SourceOutlineNode } from '../workspace';
import {
  check,
  expectCode,
  labelsOf,
  names,
  open,
  outlineTitles,
  pageIds,
  pageOutline,
  must,
} from './fixtures';

describe('interleave', () => {
  const { ws, docs, ids } = open(['F', 3], ['K', 3], ['C', 1]);
  const [f, k, c] = docs as [DocumentId, DocumentId, DocumentId];

  it('alternates pages into a new document that replaces both inputs', () => {
    const next = check(interleave(ws, { a: f, b: k, mode: 'alternate' }, ids));
    const created = must(next.activeDocument);
    expect(names(next, created)).toEqual(['F1', 'K1', 'F2', 'K2', 'F3', 'K3']);
    expect(next.documentOrder).toEqual([created, c]);
    expect(getDocument(next, created).title).toBe('F + K');
  });

  it('reverses b in duplex mode (scanner back sides)', () => {
    const next = check(
      interleave(ws, { a: f, b: k, mode: 'duplex-reverse-b', title: 'Scan' }, ids),
    );
    const created = must(next.activeDocument);
    expect(names(next, created)).toEqual(['F1', 'K3', 'F2', 'K2', 'F3', 'K1']);
    expect(getDocument(next, created).title).toBe('Scan');
  });

  it('appends leftovers of the longer document', () => {
    const next = check(interleave(ws, { a: c, b: k, mode: 'alternate' }, ids));
    expect(names(next, must(next.activeDocument))).toEqual(['C1', 'K1', 'K2', 'K3']);
  });

  it('restarts labels when inputs carried authored labels', () => {
    const labelled = open(['F', 2, { labels: ['i', 'ii'] }], ['K', 2]);
    const [lf, lk] = labelled.docs as [DocumentId, DocumentId];
    const next = check(interleave(labelled.ws, { a: lf, b: lk, mode: 'alternate' }, labelled.ids));
    expect(labelsOf(next, must(next.activeDocument))).toEqual(['1', '2', '3', '4']);
  });

  it('rejects self-interleave and unknown modes', () => {
    expectCode(() => interleave(ws, { a: f, b: f, mode: 'alternate' }, ids), 'invalid-argument');
    expectCode(() => interleave(ws, { a: f, b: k, mode: 'zip' as never }, ids), 'invalid-argument');
    expectCode(
      () => interleave(ws, { a: f, b: 'x' as DocumentId, mode: 'alternate' }, ids),
      'unknown-document',
    );
  });
});

const chapters: SourceOutlineNode[] = [
  {
    title: 'Chapter 1',
    destination: { kind: 'page', pageIndex: 0 },
    open: true,
    children: [
      { title: '1.1', destination: { kind: 'page', pageIndex: 1 }, open: false, children: [] },
    ],
  },
  {
    title: 'Chapter 2',
    destination: { kind: 'page', pageIndex: 2 },
    open: true,
    children: [
      { title: '2.1', destination: { kind: 'page', pageIndex: 3 }, open: false, children: [] },
      { title: '2.2', destination: { kind: 'page', pageIndex: 5 }, open: false, children: [] },
    ],
  },
  {
    title: 'Website',
    destination: { kind: 'uri', uri: 'https://example.org' },
    open: false,
    children: [],
  },
];

describe('splitDocument', () => {
  const { ws, docs, ids } = open(['A', 6, { outline: chapters }], ['Z', 1]);
  const [a, z] = docs as [DocumentId, DocumentId];

  it('splits every n pages, replacing the original in the tab order', () => {
    const next = check(splitDocument(ws, a, { mode: 'every', n: 2 }, ids));
    const parts = documentsInOrder(next);
    expect(parts.map((d) => d.title)).toEqual(['A (1 of 3)', 'A (2 of 3)', 'A (3 of 3)', 'Z']);
    expect(parts.map((d) => names(next, d.id))).toEqual([
      ['A1', 'A2'],
      ['A3', 'A4'],
      ['A5', 'A6'],
      ['Z1'],
    ]);
    expect(next.activeDocument).toBe(parts[0]?.id);
    expect(next.documentOrder).not.toContain(a);
  });

  it('keeps the outline nodes that land in each part', () => {
    const next = check(
      splitDocument(ws, a, { mode: 'at-pages', pageIds: [must(pageIds(ws, a)[2])] }, ids),
    );
    const [first, second] = next.documentOrder as [DocumentId, DocumentId];
    expect(outlineTitles(next, first)).toEqual(['Chapter 1', '  1.1', 'Website']);
    expect(outlineTitles(next, second)).toEqual(['Chapter 2', '  2.1', '  2.2']);
  });

  it('keeps a parent as unresolved container when only its children land in a part', () => {
    const next = check(splitDocument(ws, a, { mode: 'every', n: 3 }, ids));
    const second = must(next.documentOrder[1]);
    // Pages 4–6: Chapter 2 (page 3) is elsewhere; 2.1 (page 4) and 2.2 (page 6) are here.
    expect(outlineTitles(next, second)).toEqual(['Chapter 2 (unresolved)', '  2.1', '  2.2']);
  });

  it('extracts ranges and leaves uncovered pages in the original', () => {
    const next = check(
      splitDocument(
        ws,
        a,
        {
          mode: 'ranges',
          ranges: [
            [4, 5],
            [0, 1],
          ],
        },
        ids,
      ),
    );
    const order = next.documentOrder;
    expect(order[0]).toBe(a);
    expect(names(next, a)).toEqual(['A3', 'A4']);
    expect(names(next, must(order[1]))).toEqual(['A5', 'A6']);
    expect(names(next, must(order[2]))).toEqual(['A1', 'A2']);
    expect(getDocument(next, must(order[1])).title).toBe('A (1 of 2)');
    expect(order[3]).toBe(z);
    // The original keeps non-page nodes and marks extracted targets unresolved.
    expect(outlineTitles(next, a)).toContain('Website');
    expect(outlineTitles(next, a)).toContain('Chapter 1 (unresolved)');
  });

  it('preserves label strings in each part', () => {
    const labelled = setLabelRanges(ws, a, [
      { startIndex: 0, style: 'roman-lower' },
      { startIndex: 2, style: 'decimal' },
    ]);
    const next = check(splitDocument(labelled, a, { mode: 'every', n: 3 }, ids));
    const [p1, p2] = next.documentOrder as [DocumentId, DocumentId];
    expect(labelsOf(next, p1)).toEqual(['i', 'ii', '1']);
    expect(labelsOf(next, p2)).toEqual(['2', '3', '4']);
  });

  it('validates the spec', () => {
    expectCode(() => splitDocument(ws, a, { mode: 'every', n: 0 }, ids), 'invalid-argument');
    expectCode(() => splitDocument(ws, a, { mode: 'every', n: 6 }, ids), 'invalid-argument');
    expectCode(() => splitDocument(ws, a, { mode: 'ranges', ranges: [] }, ids), 'invalid-range');
    expectCode(
      () => splitDocument(ws, a, { mode: 'ranges', ranges: [[0, 6]] }, ids),
      'invalid-range',
    );
    expectCode(
      () => splitDocument(ws, a, { mode: 'ranges', ranges: [[3, 2]] }, ids),
      'invalid-range',
    );
    expectCode(
      () =>
        splitDocument(
          ws,
          a,
          {
            mode: 'ranges',
            ranges: [
              [0, 2],
              [2, 3],
            ],
          },
          ids,
        ),
      'invalid-range',
    );
    expectCode(
      () => splitDocument(ws, a, { mode: 'at-pages', pageIds: [must(pageIds(ws, a)[0])] }, ids),
      'invalid-argument',
    );
    expectCode(
      () => splitDocument(ws, a, { mode: 'at-pages', pageIds: pageIds(ws, z) }, ids),
      'unknown-page',
    );
    expectCode(() => splitDocument(ws, a, { mode: 'halves' } as never, ids), 'invalid-argument');
  });
});

describe('mergeDocuments', () => {
  const { ws, docs, ids } = open(
    ['A', 2, { outline: pageOutline('A', 2) }],
    ['B', 2, { labels: ['A-1', 'A-2'] }],
    ['C', 1],
  );
  const [a, b, c] = docs as [DocumentId, DocumentId, DocumentId];

  it('concatenates pages in the given order and wraps outlines per input', () => {
    const next = check(mergeDocuments(ws, { documentIds: [b, a], title: 'Merged' }, ids));
    const merged = must(next.activeDocument);
    expect(names(next, merged)).toEqual(['B1', 'B2', 'A1', 'A2']);
    expect(outlineTitles(next, merged)).toEqual(['B', 'A', '  A p1', '  A p2']);
    const wrapper = getDocument(next, merged).outline[1];
    expect(wrapper?.destination).toEqual({ kind: 'page', page: pageIds(ws, a)[0] });
    expect(next.documentOrder).toEqual([merged, c]);
    expect(getDocument(next, merged).metadata).toEqual(getDocument(ws, b).metadata);
  });

  it('lets authored labels flow through when no input has explicit ranges', () => {
    const next = check(mergeDocuments(ws, { documentIds: [a, b, c], title: 'M' }, ids));
    const merged = must(next.activeDocument);
    expect(getDocument(next, merged).labels).toEqual([]);
    expect(labelsOf(next, merged)).toEqual(['1', '2', 'A-1', 'A-2', '5']);
  });

  it('freezes each input’s labels when any input has explicit ranges', () => {
    const labelled = setLabelRanges(ws, a, [{ startIndex: 0, style: 'roman-lower' }]);
    const next = check(mergeDocuments(labelled, { documentIds: [a, b, c], title: 'M' }, ids));
    expect(labelsOf(next, must(next.activeDocument))).toEqual(['i', 'ii', 'A-1', 'A-2', '1']);
  });

  it('restores outline targets that moved between the merged inputs', () => {
    const a2 = must(pageIds(ws, a)[1]);
    const moved = movePages(ws, { pageIds: [a2], target: { document: b, index: 0 } });
    expect(outlineTitles(moved, a)).toEqual(['A p1', 'A p2 (unresolved)']);
    const next = check(mergeDocuments(moved, { documentIds: [a, b], title: 'M' }, ids));
    expect(outlineTitles(next, must(next.activeDocument))).toEqual(['A', '  A p1', '  A p2', 'B']);
  });

  it('validates input', () => {
    expectCode(() => mergeDocuments(ws, { documentIds: [a], title: 'M' }, ids), 'invalid-argument');
    expectCode(() => mergeDocuments(ws, { documentIds: [a, a], title: 'M' }, ids), 'duplicate-id');
    expectCode(
      () => mergeDocuments(ws, { documentIds: [a, b], title: '  ' }, ids),
      'invalid-argument',
    );
    expectCode(
      () => mergeDocuments(ws, { documentIds: [a, 'x' as DocumentId], title: 'M' }, ids),
      'unknown-document',
    );
  });
});
