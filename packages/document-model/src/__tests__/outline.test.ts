import { describe, expect, it } from 'vitest';
import { countNodes, dropUnresolved, pruneOutline, restrictOutline, wrapOutline } from '../outline';
import type { OutlineNode, PageId } from '../types';

const p = (id: string): PageId => id as PageId;

const tree: readonly OutlineNode[] = [
  {
    title: 'One',
    open: true,
    destination: { kind: 'page', page: p('p1'), view: { fit: 'xyz', top: 700 } },
    children: [
      { title: 'One.a', open: false, destination: { kind: 'page', page: p('p2') }, children: [] },
    ],
  },
  {
    title: 'Link',
    open: false,
    destination: { kind: 'uri', uri: 'https://example.org' },
    children: [],
  },
  { title: 'Heading', open: false, children: [] },
];

describe('pruneOutline', () => {
  it('returns the same array when every target is live', () => {
    expect(pruneOutline(tree, new Set([p('p1'), p('p2')]))).toBe(tree);
  });

  it('marks dead targets unresolved, keeping nodes and remembering the target', () => {
    const pruned = pruneOutline(tree, new Set([p('p2')]));
    expect(countNodes(pruned)).toBe(countNodes(tree));
    expect(pruned[0]?.destination).toEqual({
      kind: 'unresolved',
      reason: 'Target page is no longer in this document',
      previous: { page: 'p1', view: { fit: 'xyz', top: 700 } },
    });
    expect(pruned[0]?.children).toBe(tree[0]?.children);
    expect(pruned[1]).toBe(tree[1]);
  });

  it('restores targets when their page is back', () => {
    const pruned = pruneOutline(tree, new Set<PageId>());
    const restored = pruneOutline(pruned, new Set([p('p1'), p('p2')]));
    expect(restored).toEqual(tree);
  });
});

describe('dropUnresolved', () => {
  it('drops unresolved leaves and turns unresolved parents into headings', () => {
    const pruned = pruneOutline(tree, new Set([p('p2')]));
    const exported = dropUnresolved(pruned);
    expect(exported[0]?.title).toBe('One');
    expect(exported[0]?.destination).toBeUndefined();
    expect(exported[0]?.children).toHaveLength(1);

    const allGone = dropUnresolved(pruneOutline(tree, new Set<PageId>()));
    expect(allGone.map((n) => n.title)).toEqual(['Link', 'Heading']);
  });

  it('is identity when nothing is unresolved', () => {
    expect(dropUnresolved(tree)).toBe(tree);
  });
});

describe('restrictOutline, wrapOutline, countNodes', () => {
  it('restricts to a page subset', () => {
    expect(restrictOutline(tree, new Set([p('p1')]), false).map((n) => n.title)).toEqual(['One']);
    expect(restrictOutline(tree, new Set<PageId>(), true).map((n) => n.title)).toEqual([
      'Link',
      'Heading',
    ]);
  });

  it('wraps nodes and counts recursively', () => {
    const wrapped = wrapOutline('Doc', tree, { destination: { kind: 'page', page: p('p1') } });
    expect(wrapped.open).toBe(false);
    expect(wrapped.children).toBe(tree);
    expect(countNodes([wrapped])).toBe(5);
    expect(countNodes([])).toBe(0);
    expect('destination' in wrapOutline('Doc', [])).toBe(false);
  });
});
