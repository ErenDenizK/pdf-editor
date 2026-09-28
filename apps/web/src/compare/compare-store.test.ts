/**
 * Stale comparison results (spec recognize-and-compare §2.2): a run records what it read of
 * the two documents; a later change to either (a page command, an engine edit, undo / redo)
 * marks the result stale, going back to the compared state (undo) makes it fresh again, and
 * a change to another document never does. The Compare segment shows only while a
 * comparison is open.
 */
import {
  addSource,
  createSequentialIdGenerator,
  createWorkspace,
  type DocumentId,
  type EngineEdit,
  getDocument,
  rotatePages,
  type SourceId,
  type SourceInput,
  type Workspace,
} from '@pdf-editor/document-model';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearCompareResults,
  comparisonOpen,
  recordCompareBasis,
  refreshCompareStale,
  resetCompareStore,
  useCompareStore,
} from './compare-store';

function input(name: string): SourceInput {
  return {
    name,
    byteLength: 1000,
    pageCount: 2,
    pages: [0, 1].map(() => ({ size: { width: 612, height: 792 }, rotation: 0 as const })),
    fingerprint: name,
    flags: {
      encrypted: false,
      repaired: false,
      hasAcroForm: false,
      hasXfa: false,
      hasSignatures: false,
      tagged: false,
      linearized: false,
    },
    metadata: { policy: 'inherit-first-source' },
    outline: [],
  };
}

interface Opened {
  readonly ws: Workspace;
  readonly a: DocumentId;
  readonly b: DocumentId;
  readonly other: DocumentId;
  readonly sourceOf: Record<'a' | 'b' | 'other', SourceId>;
}

function openThree(): Opened {
  const ids = createSequentialIdGenerator('cmp');
  const first = addSource(createWorkspace(), input('a.pdf'), ids);
  const second = addSource(first.workspace, input('b.pdf'), ids);
  const third = addSource(second.workspace, input('other.pdf'), ids);
  return {
    ws: third.workspace,
    a: first.documentId,
    b: second.documentId,
    other: third.documentId,
    sourceOf: { a: first.sourceId, b: second.sourceId, other: third.sourceId },
  };
}

function rotateFirst(ws: Workspace, id: DocumentId): Workspace {
  const page = getDocument(ws, id).pages[0];
  if (!page) throw new Error('no page');
  return rotatePages(ws, [page.id], 90);
}

function withEdit(ws: Workspace, source: SourceId, id: string): Workspace {
  const edit = { id, source, pageIndex: 0, kind: 'annotation.create' } as unknown as EngineEdit;
  return { ...ws, engineEdits: [...ws.engineEdits, edit] };
}

beforeEach(() => resetCompareStore());

describe('stale comparison results', () => {
  it('marks the result stale when a compared document changes, and fresh again on undo', () => {
    const { ws, a, b } = openThree();
    recordCompareBasis(ws, a, b);
    expect(useCompareStore.getState().basis).not.toBeNull();
    refreshCompareStale(ws);
    expect(useCompareStore.getState().stale).toBe(false);

    // A page command on B (as in Arrange, or through the palette while comparing).
    const rotated = rotateFirst(ws, b);
    refreshCompareStale(rotated);
    expect(useCompareStore.getState().stale).toBe(true);

    // Undo restores the workspace the run read: the result describes it again.
    refreshCompareStale(ws);
    expect(useCompareStore.getState().stale).toBe(false);

    // A page command on A counts the same.
    refreshCompareStale(rotateFirst(ws, a));
    expect(useCompareStore.getState().stale).toBe(true);
  });

  it('counts engine edits on a compared source, and ignores other documents', () => {
    const { ws, a, b, other, sourceOf } = openThree();
    recordCompareBasis(ws, a, b);

    // Another tab changing (pages or engine edits) leaves the result as it is.
    const elsewhere = withEdit(rotateFirst(ws, other), sourceOf.other, 'e1');
    refreshCompareStale(elsewhere);
    expect(useCompareStore.getState().stale).toBe(false);

    // An annotation (engine edit) on B's source: stale; undone (the edit list as compared).
    const annotated = withEdit(elsewhere, sourceOf.b, 'e2');
    refreshCompareStale(annotated);
    expect(useCompareStore.getState().stale).toBe(true);
    refreshCompareStale(elsewhere);
    expect(useCompareStore.getState().stale).toBe(false);

    // A metadata change on A (the facts compare it).
    const doc = getDocument(ws, a);
    const retitled: Workspace = {
      ...ws,
      documents: { ...ws.documents, [a]: { ...doc, metadata: { ...doc.metadata, title: 'New' } } },
    };
    refreshCompareStale(retitled);
    expect(useCompareStore.getState().stale).toBe(true);

    // A compared document closed: stale until the comparison is released.
    const { [b]: _closed, ...rest } = ws.documents;
    refreshCompareStale({ ...ws, documents: rest });
    expect(useCompareStore.getState().stale).toBe(true);

    clearCompareResults();
    expect(useCompareStore.getState()).toMatchObject({ basis: null, stale: false });
    // Without a run nothing is stale, whatever changes.
    refreshCompareStale(annotated);
    expect(useCompareStore.getState().stale).toBe(false);
  });
});

describe('the Compare segment', () => {
  it('shows while a comparison is open: in the view, running or finished', () => {
    expect(comparisonOpen(false, 'setup')).toBe(false);
    expect(comparisonOpen(false, 'failed')).toBe(false);
    expect(comparisonOpen(true, 'setup')).toBe(true);
    expect(comparisonOpen(false, 'preparing')).toBe(true);
    expect(comparisonOpen(false, 'running')).toBe(true);
    expect(comparisonOpen(false, 'done')).toBe(true);
  });
});
