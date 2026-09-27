import { describe, expect, it } from 'vitest';
import { createSequentialIdGenerator } from '../ids';
import { setLabelRanges } from '../labels';
import {
  DEFAULT_PAGE_SIZE,
  deletePages,
  duplicatePages,
  insertBlankPage,
  insertImagePage,
  reversePages,
  rotatePages,
  setDocumentOverlays,
  setPageCropBox,
  setPageOverlays,
} from '../pages';
import { getDocument, getPage, pageDisplaySize } from '../selectors';
import type { BlobId, DocumentId, OverlayOp, PageId } from '../types';
import { newEmptyDocument } from '../workspace';
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

const pageNumbers: OverlayOp = {
  kind: 'text',
  layer: 'over',
  template: '{page} / {pages}',
  anchor: 'bottom-center',
  offset: { x: 0, y: 24 },
  font: { family: 'sans', size: 10 },
  color: { r: 0, g: 0, b: 0 },
  opacity: 1,
};

describe('deletePages', () => {
  const { ws, docs } = open(['A', 4, { outline: pageOutline('A', 4) }], ['B', 2]);
  const [a, b] = docs as [DocumentId, DocumentId];
  const [a1, a2, , a4] = pageTuple(ws, a, 4);
  const [b1] = pageTuple(ws, b, 2);

  it('removes pages from several documents', () => {
    const next = check(deletePages(ws, [a2, b1, a4]));
    expect(names(next, a)).toEqual(['A1', 'A3']);
    expect(names(next, b)).toEqual(['B2']);
  });

  it('marks outline nodes of deleted pages unresolved without deleting them', () => {
    const next = check(deletePages(ws, [a2]));
    expect(outlineTitles(next, a)).toEqual(['A p1', 'A p2 (unresolved)', 'A p3', 'A p4']);
  });

  it('keeps sources and leaves empty documents open', () => {
    const next = check(deletePages(ws, pageIds(ws, b)));
    expect(names(next, b)).toEqual([]);
    expect(next.sources).toBe(ws.sources);
  });

  it('renumbers explicit front matter anchored ranges', () => {
    const labelled = setLabelRanges(ws, a, [
      { startIndex: 0, style: 'roman-lower' },
      { startIndex: 2, style: 'decimal' },
    ]);
    expect(labelsOf(labelled, a)).toEqual(['i', 'ii', '1', '2']);
    expect(labelsOf(check(deletePages(labelled, [a1])), a)).toEqual(['i', '1', '2']);
    // Deleting the anchor of the body range: the next page becomes its anchor.
    const ids = pageIds(labelled, a);
    expect(labelsOf(check(deletePages(labelled, [must(ids[2])])), a)).toEqual(['i', 'ii', '1']);
    // Deleting all front matter: the body range takes over from index 0.
    expect(labelsOf(check(deletePages(labelled, [a1, a2])), a)).toEqual(['1', '2']);
    // Deleting the whole body drops its range.
    const noBody = check(deletePages(labelled, [must(ids[2]), a4]));
    expect(getDocument(noBody, a).labels).toEqual([{ startIndex: 0, style: 'roman-lower' }]);
  });

  it('validates the selection', () => {
    expectCode(() => deletePages(ws, []), 'invalid-argument');
    expectCode(() => deletePages(ws, ['x' as PageId]), 'unknown-page');
  });
});

describe('duplicatePages', () => {
  const { ws, docs, ids } = open(['A', 3], ['B', 1]);
  const [a, b] = docs as [DocumentId, DocumentId];
  const [a1, , a3] = pageTuple(ws, a, 3);

  it('inserts each copy right after its original with a fresh id and the same ref', () => {
    const rotated = rotatePages(ws, [a1], 90);
    const next = check(duplicatePages(rotated, [a3, a1], ids));
    expect(names(next, a)).toEqual(['A1', 'A1', 'A2', 'A3', 'A3']);
    const pages = getDocument(next, a).pages;
    expect(pages[1]?.id).not.toBe(a1);
    expect(pages[1]?.ref).toBe(pages[0]?.ref);
    expect(pages[1]?.rotation).toBe(90);
  });

  it('inserts copies at a target in relative order', () => {
    const next = check(duplicatePages(ws, [a3, a1], ids, { target: { document: b, index: 1 } }));
    expect(names(next, a)).toEqual(['A1', 'A2', 'A3']);
    expect(names(next, b)).toEqual(['B1', 'A1', 'A3']);
  });

  it('keeps explicit labels continuous', () => {
    const labelled = setLabelRanges(ws, a, [
      { startIndex: 0, style: 'roman-lower' },
      { startIndex: 1, style: 'decimal' },
    ]);
    const next = check(duplicatePages(labelled, [a1], createSequentialIdGenerator('d')));
    expect(labelsOf(next, a)).toEqual(['i', 'ii', '1', '2']);
  });

  it('validates the target', () => {
    expectCode(
      () => duplicatePages(ws, [a1], ids, { target: { document: b, index: 5 } }),
      'invalid-index',
    );
  });
});

describe('rotatePages', () => {
  const { ws, docs } = open(['A', 2, { rotations: [90, 0] }]);
  const a = must(docs[0]);
  const [a1, a2] = pageTuple(ws, a, 2);

  it('normalizes deltas, including negative ones', () => {
    let next = rotatePages(ws, [a1, a2], 90);
    expect(getPage(next, a2).rotation).toBe(90);
    next = rotatePages(next, [a2], -180);
    expect(getPage(next, a2).rotation).toBe(270);
    next = rotatePages(next, [a2], 450);
    expect(getPage(next, a2).rotation).toBe(0);
    check(next);
  });

  it('applies intrinsic + delta rotation to the display size', () => {
    expect(pageDisplaySize(ws, getPage(ws, a1))).toEqual({ width: 792, height: 612 });
    const next = rotatePages(ws, [a1], 90);
    expect(pageDisplaySize(next, getPage(next, a1))).toEqual({ width: 612, height: 792 });
  });

  it('is a no-op for full turns and rejects non-right angles', () => {
    expect(rotatePages(ws, [a1], 360)).toBe(ws);
    expectCode(() => rotatePages(ws, [a1], 45), 'invalid-argument');
    expectCode(() => rotatePages(ws, ['x' as PageId], 360), 'unknown-page');
  });
});

describe('reversePages', () => {
  it('reverses order and keeps page ids', () => {
    const { ws, docs } = open(['A', 3]);
    const a = must(docs[0]);
    const next = check(reversePages(ws, a));
    expect(names(next, a)).toEqual(['A3', 'A2', 'A1']);
    expect(pageIds(next, a)).toEqual([...pageIds(ws, a)].reverse());
  });

  it('is a no-op for short documents', () => {
    const { ws, docs } = open(['A', 1]);
    expect(reversePages(ws, must(docs[0]))).toBe(ws);
  });
});

describe('insertBlankPage / insertImagePage', () => {
  const { ws, docs, ids } = open(['A', 2, { rotations: [90, 0] }]);
  const a = must(docs[0]);

  it('inserts a blank page sized like the preceding page as displayed', () => {
    const next = check(insertBlankPage(ws, { document: a, index: 1 }, ids));
    expect(names(next, a)).toEqual(['A1', 'blank', 'A2']);
    const blank = getDocument(next, a).pages[1];
    expect(blank?.ref).toEqual({ kind: 'blank', size: { width: 792, height: 612 } });
  });

  it('uses A4 in an empty document and honours an explicit size', () => {
    const empty = newEmptyDocument(ws, ids);
    const next = check(
      insertBlankPage(empty.workspace, { document: empty.documentId, index: 0 }, ids),
    );
    expect(getDocument(next, empty.documentId).pages[0]?.ref).toEqual({
      kind: 'blank',
      size: DEFAULT_PAGE_SIZE,
    });
    const sized = insertBlankPage(
      ws,
      { document: a, index: 0, size: { width: 100, height: 200 } },
      ids,
    );
    expect(getDocument(sized, a).pages[0]?.ref).toEqual({
      kind: 'blank',
      size: { width: 100, height: 200 },
    });
  });

  it('inserts an image page', () => {
    const next = check(
      insertImagePage(
        ws,
        { document: a, index: 2, blob: 'img-1' as BlobId, size: { width: 300, height: 400 } },
        ids,
      ),
    );
    expect(names(next, a)).toEqual(['A1', 'A2', 'image']);
  });

  it('validates sizes, blobs and indices', () => {
    expectCode(
      () => insertBlankPage(ws, { document: a, index: 0, size: { width: 0, height: 1 } }, ids),
      'invalid-argument',
    );
    expectCode(() => insertBlankPage(ws, { document: a, index: 3 }, ids), 'invalid-index');
    expectCode(
      () =>
        insertImagePage(
          ws,
          { document: a, index: 0, blob: '' as BlobId, size: { width: 1, height: 1 } },
          ids,
        ),
      'invalid-argument',
    );
  });
});

describe('crop boxes and overlays', () => {
  const { ws, docs } = open(['A', 2], ['B', 1]);
  const [a, b] = docs as [DocumentId, DocumentId];
  const [a1, a2] = pageTuple(ws, a, 2);

  it('sets and clears a crop box, affecting the display size', () => {
    const crop = { x: 10, y: 10, width: 300, height: 400 };
    const cropped = check(setPageCropBox(ws, a1, crop));
    expect(getPage(cropped, a1).cropBox).toEqual(crop);
    expect(pageDisplaySize(cropped, getPage(cropped, a1))).toEqual({ width: 300, height: 400 });
    const cleared = setPageCropBox(cropped, a1, undefined);
    expect('cropBox' in getPage(cleared, a1)).toBe(false);
    expect(setPageCropBox(ws, a1, undefined)).toBe(ws);
    expectCode(
      () => setPageCropBox(ws, a1, { x: 0, y: 0, width: -1, height: 5 }),
      'invalid-argument',
    );
  });

  it('sets overlays on selected pages or a whole document', () => {
    const one = check(setPageOverlays(ws, [a2], [pageNumbers]));
    expect(getPage(one, a1).overlays).toEqual([]);
    expect(getPage(one, a2).overlays).toEqual([pageNumbers]);
    const all = check(setDocumentOverlays(ws, a, [pageNumbers]));
    expect(getDocument(all, a).pages.every((p) => p.overlays.length === 1)).toBe(true);
    expect(getDocument(all, b)).toBe(getDocument(ws, b));
    expectCode(
      () => setPageOverlays(ws, [a1], [{ ...pageNumbers, opacity: 2 }]),
      'invalid-argument',
    );
  });
});
