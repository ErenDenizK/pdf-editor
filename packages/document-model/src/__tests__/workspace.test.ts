import { describe, expect, it } from 'vitest';
import { createSequentialIdGenerator, createRandomIdGenerator, pageId, sourceId } from '../ids';
import {
  documentsInOrder,
  findPageLocation,
  findSourceByFingerprint,
  getActiveDocument,
  getDocument,
  getPage,
  getSource,
  isSourceReferenced,
  sourceReferences,
  sourcesWithEngineEdits,
} from '../selectors';
import type { DocumentId, EngineEdit, PageId, SourceId } from '../types';
import { wrapOutline } from '../outline';
import {
  addSource,
  appendOutline,
  closeDocument,
  createWorkspace,
  markDocumentClean,
  newEmptyDocument,
  removeSourceIfUnreferenced,
  renameDocument,
  reorderDocuments,
  setActiveDocument,
  type SourceOutlineNode,
} from '../workspace';
import { movePages } from '../pages';
import {
  check,
  expectCode,
  open,
  outlineTitles,
  pageIds,
  pageOutline,
  sourceInput,
  must,
} from './fixtures';

describe('ids', () => {
  it('generates deterministic sequential ids per kind', () => {
    const ids = createSequentialIdGenerator('x');
    expect([ids.page(), ids.page(), ids.document(), ids.source(), ids.blob()]).toEqual([
      'x-page-1',
      'x-page-2',
      'x-doc-1',
      'x-src-1',
      'x-blob-1',
    ]);
  });

  it('generates random ids through an injectable uuid function', () => {
    let n = 0;
    const ids = createRandomIdGenerator(() => `u${++n}`);
    expect(ids.page()).toBe('page_u1');
    expect(ids.document()).toBe('doc_u2');
    const real = createRandomIdGenerator();
    expect(real.page()).not.toBe(real.page());
  });

  it('validates branded constructors', () => {
    expect(pageId('p')).toBe('p');
    expectCode(() => sourceId(''), 'invalid-argument');
  });
});

describe('addSource', () => {
  const outline: SourceOutlineNode[] = [
    {
      title: 'Intro',
      destination: { kind: 'page', pageIndex: 0, view: { fit: 'xyz', top: 700 } },
      open: true,
      children: [
        { title: 'Broken', destination: { kind: 'page', pageIndex: 9 }, open: false, children: [] },
        {
          title: 'Web',
          destination: { kind: 'uri', uri: 'https://example.org' },
          open: false,
          children: [],
        },
        {
          title: 'Named',
          destination: { kind: 'unresolved', reason: 'missing named dest' },
          open: false,
          children: [],
        },
      ],
    },
    { title: 'Heading only', open: false, children: [] },
  ];

  it('registers the source and one document referencing every page in order', () => {
    const ids = createSequentialIdGenerator('t');
    const {
      workspace,
      sourceId: src,
      documentId,
    } = addSource(
      createWorkspace(),
      sourceInput('Report.PDF', 3, { outline, labels: ['i', 'ii', '1'] }),
      ids,
    );
    check(workspace);
    const doc = getDocument(workspace, documentId);
    expect(doc.title).toBe('Report');
    expect(doc.clean).toBe(true);
    expect(doc.labels).toEqual([]);
    expect(doc.metadata.policy).toBe('inherit-first-source');
    expect(doc.metadata.author).toBe('Author');
    expect(doc.pages.map((p) => p.ref)).toEqual(
      [0, 1, 2].map((index) => ({ kind: 'source', source: src, index })),
    );
    expect(getSource(workspace, src).pages[0]?.label).toBe('i');
    expect(workspace.activeDocument).toBe(documentId);
    expect(workspace.documentOrder).toEqual([documentId]);

    const [intro, heading] = doc.outline;
    expect(intro?.destination).toEqual({
      kind: 'page',
      page: doc.pages[0]?.id,
      view: { fit: 'xyz', top: 700 },
    });
    expect(intro?.origin).toEqual({ source: src });
    expect(intro?.children.map((c) => c.destination?.kind)).toEqual([
      'unresolved',
      'uri',
      'unresolved',
    ]);
    expect(heading?.destination).toBeUndefined();
  });

  it('rejects inconsistent input', () => {
    const ids = createSequentialIdGenerator('t');
    const ws = createWorkspace();
    const good = sourceInput('A', 2);
    expectCode(() => addSource(ws, { ...good, pageCount: 3 }, ids), 'invalid-argument');
    expectCode(() => addSource(ws, { ...good, byteLength: -1 }, ids), 'invalid-argument');
    expectCode(
      () =>
        addSource(
          ws,
          {
            ...good,
            pages: [must(good.pages[0]), { ...must(good.pages[0]), rotation: 45 as never }],
          },
          ids,
        ),
      'invalid-argument',
    );
  });

  it('keeps the source creation date but not its modification date', () => {
    const input = sourceInput('Dated', 1);
    const { workspace, documentId } = addSource(
      createWorkspace(),
      {
        ...input,
        metadata: {
          ...input.metadata,
          creationDate: '2001-02-03T04:05:06.000Z',
          modificationDate: '2002-03-04T05:06:07.000Z',
        },
      },
      createSequentialIdGenerator('t'),
    );
    const { metadata } = getDocument(workspace, documentId);
    expect(metadata.creationDate).toBe('2001-02-03T04:05:06.000Z');
    // The export stamps its own time; a stale source date would be written back otherwise.
    expect(metadata).not.toHaveProperty('modificationDate');
  });

  it('uses a caller-provided source id (the engine handle) when given', () => {
    const ids = createSequentialIdGenerator('t');
    const { workspace, sourceId: id } = addSource(createWorkspace(), sourceInput('A', 2), ids, {
      sourceId: sourceId('engine-7'),
    });
    expect(id).toBe('engine-7');
    expect(Object.keys(workspace.sources)).toEqual(['engine-7']);
    check(workspace);
    expectCode(
      () => addSource(workspace, sourceInput('B', 1), ids, { sourceId: sourceId('engine-7') }),
      'duplicate-id',
    );
  });

  it('rejects colliding ids from a misbehaving generator', () => {
    const ids = { ...createSequentialIdGenerator('t'), source: () => sourceId('same') };
    const first = addSource(createWorkspace(), sourceInput('A', 1), ids).workspace;
    expectCode(() => addSource(first, sourceInput('B', 1), ids), 'duplicate-id');
  });
});

describe('document lifecycle', () => {
  const { ws, docs, ids } = open(['A', 2], ['B', 2], ['C', 1]);
  const [a, b, c] = docs as [DocumentId, DocumentId, DocumentId];

  it('closes documents and moves activation to the neighbour', () => {
    const active = setActiveDocument(ws, b);
    const closed = check(closeDocument(active, b));
    expect(closed.documentOrder).toEqual([a, c]);
    expect(closed.activeDocument).toBe(c);
    expect(check(closeDocument(setActiveDocument(ws, c), c)).activeDocument).toBe(b);
    expect(closeDocument(active, a).activeDocument).toBe(b);
    const none = closeDocument(closeDocument(closeDocument(ws, a), b), c);
    expect('activeDocument' in none).toBe(false);
    expectCode(() => closeDocument(ws, 'x' as DocumentId), 'unknown-document');
  });

  it('removes sources only once nothing references them, with their engine edits', () => {
    const src =
      sourceReferences(ws, Object.keys(ws.sources)[0] as SourceId)[0]?.document === a
        ? (Object.keys(ws.sources)[0] as SourceId)
        : ('' as SourceId);
    const edit: EngineEdit = {
      id: 'e1',
      source: src,
      pageIndex: 0,
      kind: 'annotation.create',
      payload: { text: 'hi' },
    };
    const withEdit = { ...ws, engineEdits: [edit] };
    expect(sourcesWithEngineEdits(withEdit)).toEqual(new Set([src]));
    expect(sourcesWithEngineEdits(ws).size).toBe(0);
    expect(removeSourceIfUnreferenced(withEdit, src)).toBe(withEdit);
    // Move A's pages to B: source still referenced (from B).
    const moved = movePages(withEdit, {
      pageIds: pageIds(ws, a),
      target: { document: b, index: 0 },
    });
    expect(isSourceReferenced(moved, src)).toBe(true);
    expect(sourceReferences(moved, src).map((r) => [r.document, r.index])).toEqual([
      [b, 0],
      [b, 1],
    ]);
    const closed = closeDocument(closeDocument(moved, a), b);
    const removed = check(removeSourceIfUnreferenced(closed, src));
    expect(Object.keys(removed.sources)).not.toContain(src);
    expect(removed.engineEdits).toEqual([]);
    expectCode(() => removeSourceIfUnreferenced(removed, src), 'unknown-source');
  });

  it('reorders, renames and activates tabs', () => {
    const reordered = check(reorderDocuments(ws, [c, a, b]));
    expect(documentsInOrder(reordered).map((d) => d.title)).toEqual(['C', 'A', 'B']);
    expect(reorderDocuments(ws, ws.documentOrder)).toBe(ws);
    expectCode(() => reorderDocuments(ws, [a, b]), 'invalid-argument');
    expectCode(() => reorderDocuments(ws, [a, a, b]), 'invalid-argument');

    const renamed = renameDocument(ws, a, '  Annual report ');
    expect(getDocument(renamed, a).title).toBe('Annual report');
    expect(getDocument(renamed, a).clean).toBe(false);
    expect(getDocument(markDocumentClean(renamed, a), a).clean).toBe(true);
    expect(renameDocument(ws, a, 'A')).toBe(ws);
    expectCode(() => renameDocument(ws, a, ''), 'invalid-argument');

    expect(getActiveDocument(setActiveDocument(ws, a))?.id).toBe(a);
    expect(setActiveDocument(ws, c)).toBe(ws);
    expectCode(() => setActiveDocument(ws, 'x' as DocumentId), 'unknown-document');
  });

  it('creates empty documents at a tab position', () => {
    const { workspace, documentId } = newEmptyDocument(ws, ids, { title: 'Scratch', index: 1 });
    check(workspace);
    expect(workspace.documentOrder).toEqual([a, documentId, b, c]);
    expect(getDocument(workspace, documentId).pages).toEqual([]);
    expect(workspace.activeDocument).toBe(documentId);
    expectCode(() => newEmptyDocument(ws, ids, { index: 9 }), 'invalid-index');
  });
});

describe('appendOutline', () => {
  const { ws, docs } = open(
    ['A', 2, { outline: pageOutline('A', 1) }],
    ['B', 2, { outline: pageOutline('B', 2) }],
  );
  const [a, b] = docs as [DocumentId, DocumentId];

  it("appends a file's bookmarks after its pages were moved in (drop into a section)", () => {
    const moved = pageIds(ws, b);
    const carried = getDocument(ws, b).outline;
    const inserted = closeDocument(
      movePages(ws, { pageIds: moved, target: { document: a, index: 1 } }),
      b,
    );
    const first = must(moved[0]);
    const next = check(
      appendOutline(inserted, a, [
        wrapOutline('B.pdf', carried, { destination: { kind: 'page', page: first } }),
      ]),
    );
    expect(outlineTitles(next, a)).toEqual(['A p1', 'B.pdf', '  B p1', '  B p2']);
    expect(getDocument(next, a).outline[1]?.destination).toEqual({ kind: 'page', page: first });
    expect(getDocument(next, a).clean).toBe(false);
  });

  it('keeps nodes whose pages are not in the document as unresolved', () => {
    const next = check(appendOutline(ws, a, getDocument(ws, b).outline));
    expect(outlineTitles(next, a)).toEqual(['A p1', 'B p1 (unresolved)', 'B p2 (unresolved)']);
  });

  it('changes nothing for no nodes and rejects unknown documents', () => {
    expect(appendOutline(ws, a, [])).toBe(ws);
    expectCode(() => appendOutline(ws, 'x' as DocumentId, []), 'unknown-document');
  });
});

describe('selectors', () => {
  const { ws, docs } = open(['A', 2], ['B', 1]);
  const b = must(docs[1]);
  const b1 = must(pageIds(ws, b)[0]);

  it('finds pages and sources', () => {
    expect(findPageLocation(ws, b1)).toEqual({ document: b, index: 0 });
    expect(findPageLocation(ws, 'x' as PageId)).toBeUndefined();
    expect(getPage(ws, b1).id).toBe(b1);
    expectCode(() => getPage(ws, 'x' as PageId), 'unknown-page');
    expectCode(() => getDocument(ws, 'constructor' as DocumentId), 'unknown-document');
    expect(findSourceByFingerprint(ws, 'fp-B')?.name).toBe('B');
    expect(findSourceByFingerprint(ws, 'nope')).toBeUndefined();
  });
});
