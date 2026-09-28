import { describe, expect, it } from 'vitest';

import { createHistory, pushHistory, redo, undo } from '../history';
import {
  countDeadOutlineLinks,
  countNodes,
  editOutline,
  insertOutlineNode,
  isOutlinePathPrefix,
  moveOutlineNode,
  movedOutlinePath,
  type OutlineEdit,
  type OutlineGap,
  outlineItem,
  outlineMoveGap,
  outlineNodeAt,
  type OutlinePath,
  remapOutlinePath,
  removeDeadOutlineLinks,
  removeOutlineNode,
  renameOutlineNode,
  setOutlineDestination,
  setOutlineOpen,
  walkOutline,
} from '../outline';
import { deletePages, movePages } from '../pages';
import { getDocument } from '../selectors';
import { deserializeWorkspace, serializeWorkspace } from '../serialize';
import type { DocumentId, OutlineNode, PageId, Workspace } from '../types';
import type { SourceOutlineNode } from '../workspace';
import { check, expectCode, open, outlineTitles, pageTuple } from './fixtures';

const leaf = (title: string, pageIndex: number): SourceOutlineNode => ({
  title,
  open: false,
  children: [],
  destination: { kind: 'page', pageIndex },
});

/**
 * A: 1 · B: 2 (open) [B1: 3, B2: 4 [B2a: 4]] · C: link · D: heading [D1: 5] · E: 6
 */
const OUTLINE: SourceOutlineNode[] = [
  leaf('A', 0),
  {
    title: 'B',
    open: true,
    destination: { kind: 'page', pageIndex: 1 },
    children: [leaf('B1', 2), { ...leaf('B2', 3), children: [leaf('B2a', 3)] }],
  },
  {
    title: 'C',
    open: false,
    children: [],
    destination: { kind: 'uri', uri: 'https://example.org' },
  },
  { title: 'D', open: false, children: [leaf('D1', 4)] },
  leaf('E', 5),
];

function book(): { ws: Workspace; doc: DocumentId; pages: PageId[] } {
  const { ws, docs } = open(['book', 6, { outline: OUTLINE }]);
  const doc = docs[0] as DocumentId;
  return { ws, doc, pages: [...pageTuple(ws, doc, 6)] };
}

const outlineOf = (ws: Workspace, doc: DocumentId) => getDocument(ws, doc).outline;

/** Every node path of a tree, pre-order. */
function allPaths(nodes: readonly OutlineNode[], prefix: OutlinePath = []): OutlinePath[] {
  return nodes.flatMap((node, i) => {
    const path = [...prefix, i];
    return [path, ...allPaths(node.children, path)];
  });
}

/** Every gap of a tree: each children list (and the top level) at every index. */
function allGaps(nodes: readonly OutlineNode[]): OutlineGap[] {
  const gaps: OutlineGap[] = [];
  const visit = (list: readonly OutlineNode[], parent: OutlinePath) => {
    for (let index = 0; index <= list.length; index++) gaps.push({ parent, index });
    list.forEach((node, i) => visit(node.children, [...parent, i]));
  };
  visit(nodes, []);
  return gaps;
}

/** Applies an edit, checks invariants and that its inverse restores the outline. */
function roundTrip(ws: Workspace, doc: DocumentId, edit: OutlineEdit) {
  const result = editOutline(ws, doc, edit);
  check(result.workspace);
  const back = editOutline(result.workspace, doc, result.inverse);
  check(back.workspace);
  expect(outlineOf(back.workspace, doc)).toEqual(outlineOf(ws, doc));
  return result;
}

describe('outlineItem', () => {
  it('trims the title, starts collapsed, and refuses blank titles', () => {
    expect(outlineItem('  Intro ')).toEqual({ title: 'Intro', open: false, children: [] });
    const dest = { kind: 'page' as const, page: 'p1' as PageId };
    expect(outlineItem('X', dest, { open: true })).toEqual({
      title: 'X',
      open: true,
      children: [],
      destination: dest,
    });
    expectCode(() => outlineItem('   '), 'invalid-argument');
    expectCode(() => outlineItem(''), 'invalid-argument');
  });
});

describe('insert', () => {
  it('adds an item at a gap (top level, first child, last child) with an exact inverse', () => {
    const { ws, doc, pages } = book();
    const item = outlineItem('New', {
      kind: 'page',
      page: pages[1] as PageId,
      view: { fit: 'xyz', top: 500 },
    });
    for (const at of [
      { parent: [], index: 0 },
      { parent: [], index: 5 },
      { parent: [1], index: 0 },
      { parent: [1, 1], index: 1 },
      { parent: [2], index: 0 },
    ] satisfies OutlineGap[]) {
      const result = roundTrip(ws, doc, { kind: 'insert', at, node: item });
      expect(result.path).toEqual([...at.parent, at.index]);
      expect(outlineNodeAt(outlineOf(result.workspace, doc), result.path)).toBe(item);
      expect(result.inverse).toEqual({ kind: 'remove', path: result.path });
      expect(getDocument(result.workspace, doc).clean).toBe(false);
    }
  });

  it('shares untouched subtrees', () => {
    const { ws, doc } = book();
    const before = outlineOf(ws, doc);
    const next = outlineOf(
      insertOutlineNode(ws, doc, { parent: [1], index: 0 }, outlineItem('N')),
      doc,
    );
    expect(next[0]).toBe(before[0]);
    expect(next[1]).not.toBe(before[1]);
    expect(next[1]?.children[1]).toBe(before[1]?.children[0]);
    expect(next[3]).toBe(before[3]);
  });

  it('refuses gaps that do not exist and targets outside the document', () => {
    const { ws, doc } = book();
    const foreign = 'elsewhere' as PageId;
    expectCode(
      () => insertOutlineNode(ws, doc, { parent: [], index: 6 }, outlineItem('x')),
      'invalid-index',
    );
    expectCode(
      () => insertOutlineNode(ws, doc, { parent: [9], index: 0 }, outlineItem('x')),
      'invalid-index',
    );
    expectCode(
      () => insertOutlineNode(ws, doc, { parent: [0], index: -1 }, outlineItem('x')),
      'invalid-index',
    );
    expectCode(
      () =>
        insertOutlineNode(
          ws,
          doc,
          { parent: [], index: 0 },
          outlineItem('x', { kind: 'page', page: foreign }),
        ),
      'unknown-page',
    );
    expectCode(
      () => insertOutlineNode(ws, 'nope' as DocumentId, { parent: [], index: 0 }, outlineItem('x')),
      'unknown-document',
    );
  });
});

describe('remove', () => {
  it('deletes a node with its children; the inverse puts the same subtree back', () => {
    const { ws, doc } = book();
    const b = outlineNodeAt(outlineOf(ws, doc), [1]);
    const result = roundTrip(ws, doc, { kind: 'remove', path: [1] });
    expect(outlineTitles(result.workspace, doc)).toEqual(['A', 'C', 'D', '  D1', 'E']);
    expect(result.inverse).toEqual({ kind: 'insert', at: { parent: [], index: 1 }, node: b });
    const nested = roundTrip(ws, doc, { kind: 'remove', path: [1, 1, 0] });
    expect(countNodes(outlineOf(nested.workspace, doc))).toBe(8);
    expectCode(() => removeOutlineNode(ws, doc, []), 'invalid-index');
    expectCode(() => removeOutlineNode(ws, doc, [7]), 'invalid-index');
    expectCode(() => removeOutlineNode(ws, doc, [0.5]), 'invalid-index');
  });
});

describe('rename', () => {
  it('renames with a trimmed title; blank titles are refused; the inverse restores', () => {
    const { ws, doc } = book();
    const renamed = renameOutlineNode(ws, doc, [1, 0], '  Setup  ');
    expect(outlineNodeAt(outlineOf(renamed, doc), [1, 0])?.title).toBe('Setup');
    check(renamed);
    const result = roundTrip(ws, doc, { kind: 'rename', path: [1, 0], title: 'Setup' });
    expect(result.inverse).toEqual({ kind: 'rename', path: [1, 0], title: 'B1' });
    expectCode(() => renameOutlineNode(ws, doc, [0], ' \t'), 'invalid-argument');
    expect(renameOutlineNode(ws, doc, [0], 'A')).toBe(ws);
  });
});

describe('set destination', () => {
  it('points an item at a page (xyz, fit), removes it, refuses foreign pages', () => {
    const { ws, doc, pages } = book();
    const xyz = {
      kind: 'page' as const,
      page: pages[4] as PageId,
      view: { fit: 'xyz' as const, top: 320, left: 0 },
    };
    const r1 = roundTrip(ws, doc, { kind: 'set-destination', path: [2], destination: xyz });
    expect(outlineNodeAt(outlineOf(r1.workspace, doc), [2])?.destination).toEqual(xyz);
    expect(r1.inverse).toEqual({
      kind: 'set-destination',
      path: [2],
      destination: { kind: 'uri', uri: 'https://example.org' },
    });
    const fit = { kind: 'page' as const, page: pages[0] as PageId, view: { fit: 'fit' as const } };
    roundTrip(ws, doc, { kind: 'set-destination', path: [3], destination: fit });
    const cleared = roundTrip(ws, doc, { kind: 'set-destination', path: [0], destination: null });
    expect('destination' in (outlineNodeAt(outlineOf(cleared.workspace, doc), [0]) ?? {})).toBe(
      false,
    );
    expectCode(
      () => setOutlineDestination(ws, doc, [0], { kind: 'page', page: 'elsewhere' as PageId }),
      'unknown-page',
    );
    expectCode(
      () =>
        setOutlineDestination(ws, doc, [0], {
          kind: 'unresolved',
          reason: 'x',
          previous: { page: pages[0] as PageId },
        }),
      'invalid-argument',
    );
  });
});

describe('set open', () => {
  it('sets the exported expansion state; unchanged is a no-op', () => {
    const { ws, doc } = book();
    const result = roundTrip(ws, doc, { kind: 'set-open', path: [1], open: false });
    expect(outlineNodeAt(outlineOf(result.workspace, doc), [1])?.open).toBe(false);
    expect(result.inverse).toEqual({ kind: 'set-open', path: [1], open: true });
    expect(setOutlineOpen(ws, doc, [1], true)).toBe(ws);
  });
});

describe('move', () => {
  it('round-trips every move of every node to every gap, and refuses cycles', () => {
    const { ws, doc } = book();
    const tree = outlineOf(ws, doc);
    const total = countNodes(tree);
    let moves = 0;
    let refused = 0;
    for (const from of allPaths(tree)) {
      const node = outlineNodeAt(tree, from);
      for (const to of allGaps(tree)) {
        const edit: OutlineEdit = { kind: 'move', from, to };
        if (isOutlinePathPrefix(from, to.parent)) {
          expectCode(() => editOutline(ws, doc, edit), 'invalid-argument');
          refused += 1;
          continue;
        }
        const result = roundTrip(ws, doc, edit);
        const after = outlineOf(result.workspace, doc);
        expect(countNodes(after)).toBe(total);
        // The node (same object: moves never rebuild the moved subtree) is where reported.
        expect(outlineNodeAt(after, result.path)).toBe(node);
        expect(result.path).toEqual(movedOutlinePath(from, to));
        // Every other node is where remapOutlinePath says.
        for (const path of allPaths(tree)) {
          const mapped = remapOutlinePath(path, edit);
          expect(mapped).toBeDefined();
          expect(outlineNodeAt(after, mapped ?? [])?.title).toBe(outlineNodeAt(tree, path)?.title);
        }
        moves += 1;
      }
    }
    expect(moves).toBeGreaterThan(80);
    expect(refused).toBeGreaterThan(0);
  });

  it('reorders among siblings, reparents, and treats its own gaps as no-ops', () => {
    const { ws, doc } = book();
    const down = moveOutlineNode(ws, doc, [0], { parent: [], index: 2 });
    expect(outlineTitles(down, doc).filter((t) => !t.startsWith(' '))).toEqual([
      'B',
      'A',
      'C',
      'D',
      'E',
    ]);
    const under = moveOutlineNode(ws, doc, [4], { parent: [1, 1], index: 0 });
    expect(outlineTitles(under, doc)).toEqual([
      'A',
      'B',
      '  B1',
      '  B2',
      '    E',
      '    B2a',
      'C',
      'D',
      '  D1',
    ]);
    expect(moveOutlineNode(ws, doc, [1], { parent: [], index: 1 })).toBe(ws);
    expect(moveOutlineNode(ws, doc, [1], { parent: [], index: 2 })).toBe(ws);
    expectCode(
      () => moveOutlineNode(ws, doc, [1], { parent: [1, 1], index: 0 }),
      'invalid-argument',
    );
    expectCode(() => moveOutlineNode(ws, doc, [1], { parent: [1], index: 0 }), 'invalid-argument');
    expectCode(() => moveOutlineNode(ws, doc, [1], { parent: [], index: 9 }), 'invalid-index');
  });
});

describe('remapOutlinePath', () => {
  it('follows inserts and removals', () => {
    const insert: OutlineEdit = {
      kind: 'insert',
      at: { parent: [1], index: 0 },
      node: outlineItem('n'),
    };
    expect(remapOutlinePath([1, 0], insert)).toEqual([1, 1]);
    expect(remapOutlinePath([1, 1, 0], insert)).toEqual([1, 2, 0]);
    expect(remapOutlinePath([1], insert)).toEqual([1]);
    expect(remapOutlinePath([2, 0], insert)).toEqual([2, 0]);
    const remove: OutlineEdit = { kind: 'remove', path: [1] };
    expect(remapOutlinePath([1], remove)).toBeUndefined();
    expect(remapOutlinePath([1, 1], remove)).toBeUndefined();
    expect(remapOutlinePath([3, 0], remove)).toEqual([2, 0]);
    expect(remapOutlinePath([0], remove)).toEqual([0]);
    expect(remapOutlinePath([2], { kind: 'rename', path: [2], title: 'x' })).toEqual([2]);
  });
});

describe('outlineMoveGap (keyboard moves)', () => {
  it('computes up, down, indent and outdent, and nothing at the edges', () => {
    const { ws, doc } = book();
    const tree = outlineOf(ws, doc);
    expect(outlineMoveGap(tree, [0], 'up')).toBeUndefined();
    expect(outlineMoveGap(tree, [1], 'up')).toEqual({ parent: [], index: 0 });
    expect(outlineMoveGap(tree, [4], 'down')).toBeUndefined();
    expect(outlineMoveGap(tree, [0], 'down')).toEqual({ parent: [], index: 2 });
    expect(outlineMoveGap(tree, [0], 'indent')).toBeUndefined();
    expect(outlineMoveGap(tree, [2], 'indent')).toEqual({ parent: [1], index: 2 });
    expect(outlineMoveGap(tree, [0], 'outdent')).toBeUndefined();
    expect(outlineMoveGap(tree, [1, 1, 0], 'outdent')).toEqual({ parent: [1], index: 2 });
    expect(outlineMoveGap(tree, [9], 'up')).toBeUndefined();

    let next = ws;
    const apply = (path: OutlinePath, direction: Parameters<typeof outlineMoveGap>[2]) => {
      const gap = outlineMoveGap(outlineOf(next, doc), path, direction);
      if (!gap) throw new Error(`no ${direction} gap`);
      const result = editOutline(next, doc, { kind: 'move', from: path, to: gap });
      next = check(result.workspace);
      return result.path;
    };
    // C: indent under B (last child), outdent back after B, then down past D.
    expect(apply([2], 'indent')).toEqual([1, 2]);
    expect(apply([1, 2], 'outdent')).toEqual([2]);
    expect(apply([2], 'down')).toEqual([3]);
    expect(apply([3], 'up')).toEqual([2]);
    expect(outlineOf(next, doc)).toEqual(tree);
  });
});

describe('pages and history', () => {
  it('destinations follow moved pages by id and become dead links when pages go', () => {
    const { ws, doc, pages } = book();
    const withNew = insertOutlineNode(
      ws,
      doc,
      { parent: [], index: 5 },
      outlineItem('On page 2', {
        kind: 'page',
        page: pages[1] as PageId,
        view: { fit: 'xyz', top: 400 },
      }),
    );
    const moved = check(
      movePages(withNew, { pageIds: [pages[1] as PageId], target: { document: doc, index: 6 } }),
    );
    expect(outlineNodeAt(outlineOf(moved, doc), [5])?.destination).toEqual({
      kind: 'page',
      page: pages[1],
      view: { fit: 'xyz', top: 400 },
    });

    const deleted = check(deletePages(withNew, [pages[1] as PageId]));
    const dead = outlineNodeAt(outlineOf(deleted, doc), [5]);
    expect(dead?.destination).toMatchObject({ kind: 'unresolved', previous: { page: pages[1] } });
    // "B" (page 2) is dead too, with live children.
    expect(countDeadOutlineLinks(outlineOf(deleted, doc))).toBe(2);
    const cleaned = check(removeDeadOutlineLinks(deleted, doc));
    expect(outlineTitles(cleaned, doc)).toEqual([
      'A',
      'B',
      '  B1',
      '  B2',
      '    B2a',
      'C',
      'D',
      '  D1',
      'E',
    ]);
    expect(outlineNodeAt(outlineOf(cleaned, doc), [1])?.destination).toBeUndefined();
    expect(countDeadOutlineLinks(outlineOf(cleaned, doc))).toBe(0);
    expect(removeDeadOutlineLinks(cleaned, doc)).toBe(cleaned);
  });

  it('every edit is one history step; undo and redo restore snapshots', () => {
    const { ws, doc, pages } = book();
    let history = createHistory(ws);
    const steps: OutlineEdit[] = [
      {
        kind: 'insert',
        at: { parent: [], index: 0 },
        node: outlineItem('First', { kind: 'page', page: pages[1] as PageId }),
      },
      { kind: 'rename', path: [0], title: 'Renamed' },
      { kind: 'move', from: [0], to: { parent: [2], index: 0 } },
      { kind: 'set-open', path: [1], open: false },
      { kind: 'remove', path: [3] },
    ];
    const snapshots = [ws];
    for (const [i, edit] of steps.entries()) {
      const next = editOutline(history.present.workspace, doc, edit).workspace;
      history = pushHistory(history, next, `step ${i}`, { now: i });
      snapshots.push(next);
    }
    expect(history.past).toHaveLength(steps.length);
    for (let i = steps.length - 1; i >= 0; i--) {
      history = undo(history);
      expect(history.present.workspace).toBe(snapshots[i]);
    }
    history = redo(history);
    expect(outlineOf(history.present.workspace, doc)[0]?.title).toBe('First');
  });

  it('edited outlines survive serialization', () => {
    const { ws, doc, pages } = book();
    let next = insertOutlineNode(
      ws,
      doc,
      { parent: [3], index: 1 },
      outlineItem('Deep', {
        kind: 'page',
        page: pages[5] as PageId,
        view: { fit: 'xyz', top: 10, zoom: 2 },
      }),
    );
    next = moveOutlineNode(next, doc, [0], { parent: [3, 1], index: 0 });
    const restored = deserializeWorkspace(JSON.parse(JSON.stringify(serializeWorkspace(next))));
    expect(outlineOf(restored, doc)).toEqual(outlineOf(next, doc));
    const titles: string[] = [];
    walkOutline(outlineOf(restored, doc), (n, depth) => titles.push(`${depth}:${n.title}`));
    expect(titles).toContain('2:A');
  });
});
