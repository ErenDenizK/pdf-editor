import {
  addSource,
  assertWorkspaceInvariants,
  createSequentialIdGenerator,
  createWorkspace,
  type DocumentId,
  type IdGenerator,
  type PageId,
  type SourceInput,
  type Workspace,
} from '@pdf-editor/document-model';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { planTransfer } from '../dnd/drop';
import { useSelectionStore } from '../state/selection-store';
import { useUiStore } from '../state/ui-store';
import { resetWorkspace, useWorkspaceStore } from '../state/workspace-store';
import {
  cutPages,
  edgeTarget,
  pagesFromSource,
  parityPages,
  pastePages,
  pasteTarget,
  planPaste,
  reorderDocument,
  reverseOrder,
} from './arrange-actions';

function input(name: string, pageCount: number): SourceInput {
  return {
    name,
    byteLength: 1000,
    pageCount,
    pages: Array.from({ length: pageCount }, () => ({
      size: { width: 612, height: 792 },
      rotation: 0 as const,
    })),
    fingerprint: `fp-${name}`,
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

function open(...specs: [string, number][]): {
  ws: Workspace;
  ids: IdGenerator;
  docs: DocumentId[];
} {
  const ids = createSequentialIdGenerator('t');
  let ws = createWorkspace();
  const docs: DocumentId[] = [];
  for (const [name, count] of specs) {
    const result = addSource(ws, input(name, count), ids);
    ws = result.workspace;
    docs.push(result.documentId);
  }
  return { ws, ids, docs };
}

const pageIds = (ws: Workspace, doc: DocumentId): PageId[] =>
  ws.documents[doc]?.pages.map((p) => p.id) ?? [];

describe('planTransfer (drop and paste semantics)', () => {
  it('moves across documents with a readable label and the landing position', () => {
    const { ws, ids, docs } = open(['report', 4], ['Invoice', 3]);
    const [a, b] = docs as [DocumentId, DocumentId];
    const moving = pageIds(ws, a).slice(1, 3);
    const plan = planTransfer(
      ws,
      { pageIds: moving, target: { document: b, index: 1 }, duplicate: false },
      ids,
    );
    expect(plan).toBeDefined();
    assertWorkspaceInvariants(plan!.workspace);
    expect(pageIds(plan!.workspace, b)).toEqual([
      pageIds(ws, b)[0],
      ...moving,
      ...pageIds(ws, b).slice(1),
    ]);
    expect(plan!.result).toMatchObject({
      pageIds: moving,
      position: 2,
      label: 'Move 2 pages to Invoice',
      announcement: 'Moved 2 pages to position 2 in Invoice',
    });
  });

  it('uses pre-removal gap indices within one document', () => {
    const { ws, ids, docs } = open(['report', 5]);
    const [a] = docs as [DocumentId];
    const [p0, p1, p2, p3, p4] = pageIds(ws, a);
    // Drop p0 into the gap before p3 (index 3) → p1 p2 p0 p3 p4.
    const plan = planTransfer(
      ws,
      { pageIds: [p0!], target: { document: a, index: 3 }, duplicate: false },
      ids,
    );
    expect(pageIds(plan!.workspace, a)).toEqual([p1, p2, p0, p3, p4]);
    expect(plan!.result.label).toBe('Move 1 page to position 3');
  });

  it('returns undefined for a drop back into the same place', () => {
    const { ws, ids, docs } = open(['report', 5]);
    const [a] = docs as [DocumentId];
    const [, p1] = pageIds(ws, a);
    expect(
      planTransfer(
        ws,
        { pageIds: [p1!], target: { document: a, index: 1 }, duplicate: false },
        ids,
      ),
    ).toBeUndefined();
    expect(
      planTransfer(
        ws,
        { pageIds: [p1!], target: { document: a, index: 2 }, duplicate: false },
        ids,
      ),
    ).toBeUndefined();
  });

  it('duplicates at the target with Alt, keeping the originals', () => {
    const { ws, ids, docs } = open(['report', 3], ['Invoice', 2]);
    const [a, b] = docs as [DocumentId, DocumentId];
    const copies = pageIds(ws, a).slice(0, 2);
    const plan = planTransfer(
      ws,
      { pageIds: copies, target: { document: b, index: 2 }, duplicate: true },
      ids,
    );
    assertWorkspaceInvariants(plan!.workspace);
    expect(pageIds(plan!.workspace, a)).toEqual(pageIds(ws, a));
    expect(plan!.workspace.documents[b]?.pages).toHaveLength(4);
    expect(plan!.result.pageIds).toHaveLength(2);
    expect(plan!.result.pageIds).not.toContain(copies[0]);
    expect(plan!.result.label).toBe('Duplicate 2 pages to Invoice');
  });

  it('moves selected pages in document order regardless of selection order', () => {
    const { ws, ids, docs } = open(['a', 3], ['b', 3], ['c', 1]);
    const [a, b, c] = docs as [DocumentId, DocumentId, DocumentId];
    const picked = [pageIds(ws, b)[2]!, pageIds(ws, a)[1]!, pageIds(ws, b)[0]!];
    const plan = planTransfer(
      ws,
      { pageIds: picked, target: { document: c, index: 1 }, duplicate: false },
      ids,
    );
    expect(pageIds(plan!.workspace, c).slice(1)).toEqual([
      pageIds(ws, a)[1],
      pageIds(ws, b)[0],
      pageIds(ws, b)[2],
    ]);
  });
});

describe('cut and paste', () => {
  it('paste lands after the focused page, else at the end of the fallback document', () => {
    const { ws, docs } = open(['a', 3], ['b', 2]);
    const [a, b] = docs as [DocumentId, DocumentId];
    expect(pasteTarget(ws, pageIds(ws, b)[0]!, a)).toEqual({ document: b, index: 1 });
    expect(pasteTarget(ws, null, a)).toEqual({ document: a, index: 3 });
    expect(pasteTarget(ws, null, undefined)).toBeUndefined();
  });

  it('cut moves and is consumed; copy and Mod+Shift+V duplicate and stay', () => {
    const ids = ['x' as PageId];
    expect(planPaste(null, false)).toBeUndefined();
    expect(planPaste({ pageIds: [], mode: 'cut' }, false)).toBeUndefined();
    expect(planPaste({ pageIds: ids, mode: 'cut' }, false)).toEqual({
      duplicate: false,
      consume: true,
    });
    expect(planPaste({ pageIds: ids, mode: 'cut' }, true)).toEqual({
      duplicate: true,
      consume: false,
    });
    expect(planPaste({ pageIds: ids, mode: 'copy' }, false)).toEqual({
      duplicate: true,
      consume: false,
    });
  });

  describe('through the stores', () => {
    beforeEach(() => {
      resetWorkspace();
      useUiStore.setState({ viewMode: 'arrange' });
    });
    afterEach(() => {
      resetWorkspace();
      useSelectionStore.getState().setClipboard(null);
    });

    it('cuts pages from one document and pastes them after the focused page of another', () => {
      const { ws, docs } = open(['report', 3], ['Invoice', 2]);
      useWorkspaceStore.setState({
        workspace: ws,
        history: { past: [], present: { label: 'Start', at: 0, workspace: ws }, future: [] },
      });
      const [a, b] = docs as [DocumentId, DocumentId];
      const cut = pageIds(ws, a)[1]!;
      useSelectionStore.getState().apply({ selected: new Set([cut]), anchor: cut, focused: cut });
      expect(cutPages()).toBe(true);
      expect(useSelectionStore.getState().clipboard).toEqual({ pageIds: [cut], mode: 'cut' });

      const focus = pageIds(ws, b)[0]!;
      useSelectionStore.getState().apply({ selected: new Set(), anchor: null, focused: focus });
      expect(pastePages(false)).toBe(true);

      const after = useWorkspaceStore.getState().workspace;
      expect(pageIds(after, b)).toEqual([focus, cut, pageIds(ws, b)[1]]);
      expect(pageIds(after, a)).not.toContain(cut);
      expect(useWorkspaceStore.getState().history.present.label).toBe('Move 1 page to Invoice');
      expect(useSelectionStore.getState().clipboard).toBeNull();
      expect([...useSelectionStore.getState().selected]).toEqual([cut]);
      expect(after.activeDocument).toBe(b);
    });
  });
});

describe('edge moves, reverse, parity, source', () => {
  it('computes row and section edges', () => {
    const { ws, docs } = open(['a', 10]);
    const doc = ws.documents[docs[0]!]!;
    const pick = new Set([doc.pages[5]!.id, doc.pages[6]!.id]);
    expect(edgeTarget(doc, pick, 'row-start', 4)).toBe(4);
    expect(edgeTarget(doc, pick, 'row-end', 4)).toBe(8);
    expect(edgeTarget(doc, new Set([doc.pages[9]!.id]), 'row-end', 4)).toBe(10);
    expect(edgeTarget(doc, pick, 'section-start', 4)).toBe(0);
    expect(edgeTarget(doc, pick, 'section-end', 4)).toBe(10);
    expect(edgeTarget(doc, new Set(), 'row-end', 4)).toBeUndefined();
  });

  it('reverses selected slots in place and leaves other pages alone', () => {
    const { ws, docs } = open(['a', 6], ['b', 3]);
    const [a, b] = docs as [DocumentId, DocumentId];
    const [p0, p1, p2, p3, p4, p5] = pageIds(ws, a);
    const [q0, q1, q2] = pageIds(ws, b);
    const next = reverseOrder(ws, [p1!, p3!, p4!, q0!, q2!]);
    assertWorkspaceInvariants(next);
    expect(pageIds(next, a)).toEqual([p0, p4, p2, p3, p1, p5]);
    expect(pageIds(next, b)).toEqual([q2, q1, q0]);
    expect(reverseOrder(ws, [p2!])).toBe(ws);
  });

  it('reorders a document into any permutation', () => {
    const { ws, docs } = open(['a', 5]);
    const [a] = docs as [DocumentId];
    const order = [...pageIds(ws, a)].reverse();
    expect(pageIds(reorderDocument(ws, a, order), a)).toEqual(order);
  });

  it('selects odd / even positions and pages from one source', () => {
    const { ws, docs } = open(['a', 5], ['b', 2]);
    const [a, b] = docs as [DocumentId, DocumentId];
    const doc = ws.documents[a]!;
    expect(parityPages(doc, 'odd')).toEqual([0, 2, 4].map((i) => doc.pages[i]!.id));
    expect(parityPages(doc, 'even')).toEqual([1, 3].map((i) => doc.pages[i]!.id));
    const source = doc.pages[0]!.ref.kind === 'source' ? doc.pages[0]!.ref.source : undefined;
    expect(pagesFromSource(ws, [a, b], source!)).toEqual(pageIds(ws, a));
  });
});
