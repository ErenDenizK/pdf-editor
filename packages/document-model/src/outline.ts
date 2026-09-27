/**
 * Outline (bookmark) tree helpers. All functions are pure and return the input array or
 * node unchanged (same reference) when nothing changed, so snapshots share structure.
 */
import type { Destination, OutlineNode, PageId } from './types';

export const DEFAULT_UNRESOLVED_REASON = 'Target page is no longer in this document';

/**
 * Maps every node bottom-up. `fn` receives the node with already-mapped children and
 * returns a node or `null` to drop it. Unchanged subtrees keep their identity.
 */
export function mapOutline(
  nodes: readonly OutlineNode[],
  fn: (node: OutlineNode) => OutlineNode | null,
): readonly OutlineNode[] {
  let changed = false;
  const out: OutlineNode[] = [];
  for (const node of nodes) {
    const children = mapOutline(node.children, fn);
    const withChildren = children === node.children ? node : { ...node, children };
    const mapped = fn(withChildren);
    if (mapped !== node) changed = true;
    if (mapped !== null) out.push(mapped);
  }
  return changed ? out : nodes;
}

function withDestination(node: OutlineNode, destination: Destination | undefined): OutlineNode {
  const { destination: _ignored, ...rest } = node;
  return destination === undefined ? rest : { ...rest, destination };
}

function unresolvedFrom(destination: Destination, reason: string): Destination {
  if (destination.kind !== 'page') return destination;
  const previous =
    destination.view === undefined
      ? { page: destination.page }
      : { page: destination.page, view: destination.view };
  return { kind: 'unresolved', reason, previous };
}

/**
 * Marks page destinations whose page is not in `livePageIds` as unresolved (nodes are
 * never deleted here) and restores unresolved destinations whose `previous` page is live
 * again.
 */
export function pruneOutline(
  nodes: readonly OutlineNode[],
  livePageIds: ReadonlySet<PageId>,
  reason: string = DEFAULT_UNRESOLVED_REASON,
): readonly OutlineNode[] {
  return mapOutline(nodes, (node) => {
    const dest = node.destination;
    if (dest?.kind === 'page' && !livePageIds.has(dest.page)) {
      return withDestination(node, unresolvedFrom(dest, reason));
    }
    if (dest?.kind === 'unresolved' && dest.previous && livePageIds.has(dest.previous.page)) {
      const { page, view } = dest.previous;
      return withDestination(
        node,
        view === undefined ? { kind: 'page', page } : { kind: 'page', page, view },
      );
    }
    return node;
  });
}

/**
 * Export-time cleanup: nodes with unresolved destinations are dropped, unless they still
 * have children, in which case they are kept as plain headings without a destination.
 */
export function dropUnresolved(nodes: readonly OutlineNode[]): readonly OutlineNode[] {
  return mapOutline(nodes, (node) => {
    if (node.destination?.kind !== 'unresolved') return node;
    return node.children.length > 0 ? withDestination(node, undefined) : null;
  });
}

/**
 * Keeps the part of an outline that belongs to a subset of pages (used by split).
 * A node survives when its page destination is in `pages`, or when a descendant
 * survives (its own outside destination then becomes unresolved). Nodes without a page
 * destination (URI, heading, unresolved) survive only when `keepNonPageLeaves` is set.
 */
export function restrictOutline(
  nodes: readonly OutlineNode[],
  pages: ReadonlySet<PageId>,
  keepNonPageLeaves: boolean,
): readonly OutlineNode[] {
  return mapOutline(nodes, (node) => {
    const dest = node.destination;
    if (dest?.kind === 'page') {
      if (pages.has(dest.page)) return node;
      return node.children.length > 0
        ? withDestination(node, unresolvedFrom(dest, DEFAULT_UNRESOLVED_REASON))
        : null;
    }
    return node.children.length > 0 || keepNonPageLeaves ? node : null;
  });
}

/** Wraps nodes under a new parent (collapsed by default). */
export function wrapOutline(
  title: string,
  nodes: readonly OutlineNode[],
  options: { readonly destination?: Destination; readonly open?: boolean } = {},
): OutlineNode {
  const base: OutlineNode = { title, open: options.open ?? false, children: nodes };
  return options.destination === undefined ? base : { ...base, destination: options.destination };
}

/** Total number of nodes, recursively. */
export function countNodes(nodes: readonly OutlineNode[]): number {
  let total = 0;
  for (const node of nodes) total += 1 + countNodes(node.children);
  return total;
}

/** Visits every node depth-first, pre-order. */
export function walkOutline(
  nodes: readonly OutlineNode[],
  visit: (node: OutlineNode, depth: number) => void,
  depth = 0,
): void {
  for (const node of nodes) {
    visit(node, depth);
    walkOutline(node.children, visit, depth + 1);
  }
}
