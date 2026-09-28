/**
 * Outline (bookmark) tree helpers. All functions are pure and return the input array or
 * node unchanged (same reference) when nothing changed, so snapshots share structure.
 */
import { DocumentModelError } from './errors';
import { isArrayValue, putDocuments, requireDocument, withWorkspace } from './internal';
import type { Destination, DocumentId, OutlineNode, PageId, Workspace } from './types';

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

// ---------------------------------------------------------------------------
// Editing (the Outline panel). Nodes carry no ids: they are addressed by index path,
// and every edit reports where paths go (`remapOutlinePath`) so a UI can follow them.
// Destinations reference pages by PageId, so page moves never touch the outline and page
// deletions turn targets into `unresolved` ones (`pruneOutline`, run by the page ops).
// ---------------------------------------------------------------------------

/** Index path from the top level: `[1, 0]` is the first child of the second top-level node. */
export type OutlinePath = readonly number[];

/**
 * A gap among the children of `parent` (`[]` = top level): the position before child
 * `index`, 0 … children.length. Gaps are given in the coordinates of the tree the edit
 * applies to.
 */
export interface OutlineGap {
  readonly parent: OutlinePath;
  readonly index: number;
}

/**
 * One outline edit. Every edit has an exact inverse (`editOutline` returns it). `move`
 * takes the gap in the tree *before* the move; gaps right before or after the node itself
 * leave the tree unchanged, and a gap inside the moved subtree is refused (no cycles).
 * `set-destination` with `null` removes the destination (a plain heading).
 */
export type OutlineEdit =
  | { readonly kind: 'insert'; readonly at: OutlineGap; readonly node: OutlineNode }
  | { readonly kind: 'remove'; readonly path: OutlinePath }
  | { readonly kind: 'rename'; readonly path: OutlinePath; readonly title: string }
  | {
      readonly kind: 'set-destination';
      readonly path: OutlinePath;
      readonly destination: Destination | null;
    }
  | { readonly kind: 'set-open'; readonly path: OutlinePath; readonly open: boolean }
  | { readonly kind: 'move'; readonly from: OutlinePath; readonly to: OutlineGap };

export interface OutlineEditResult {
  /** The input workspace (same reference) when the edit changed nothing. */
  readonly workspace: Workspace;
  /** Applying this to `workspace` restores the previous outline exactly. */
  readonly inverse: OutlineEdit;
  /**
   * Where the edited node is afterwards (insert: the new node; move: its new place;
   * remove: where it was).
   */
  readonly path: OutlinePath;
}

/** Deepest nesting accepted by edits (the serializer reads at most 256 levels). */
export const MAX_OUTLINE_DEPTH = 256;

function invalid(message: string): never {
  throw new DocumentModelError('invalid-argument', message);
}

function samePath(a: OutlinePath, b: OutlinePath): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** True when `prefix` is `path` or one of its ancestors. */
export function isOutlinePathPrefix(prefix: OutlinePath, path: OutlinePath): boolean {
  return prefix.length <= path.length && prefix.every((v, i) => v === path[i]);
}

function assertPathShape(path: OutlinePath, what: string): void {
  if (!isArrayValue(path) || !path.every((i) => Number.isInteger(i) && i >= 0)) {
    throw new DocumentModelError('invalid-index', `${what} must be a list of indices`);
  }
}

/** The node at `path`, or undefined when there is none (`[]` has no node). */
export function outlineNodeAt(
  nodes: readonly OutlineNode[],
  path: OutlinePath,
): OutlineNode | undefined {
  let list = nodes;
  let node: OutlineNode | undefined;
  for (const index of path) {
    node = list[index];
    if (node === undefined) return undefined;
    list = node.children;
  }
  return node;
}

/** The children list a gap's `parent` names (`[]`: the top level), or undefined. */
function childrenAt(
  nodes: readonly OutlineNode[],
  parent: OutlinePath,
): readonly OutlineNode[] | undefined {
  if (parent.length === 0) return nodes;
  return outlineNodeAt(nodes, parent)?.children;
}

function requireNode(nodes: readonly OutlineNode[], path: OutlinePath): OutlineNode {
  assertPathShape(path, 'Outline path');
  const node = path.length === 0 ? undefined : outlineNodeAt(nodes, path);
  if (node === undefined) {
    throw new DocumentModelError('invalid-index', `No outline node at [${path.join(', ')}]`);
  }
  return node;
}

function requireGap(nodes: readonly OutlineNode[], gap: OutlineGap): void {
  if (typeof gap !== 'object' || gap === null) invalid('Outline gap must be an object');
  assertPathShape(gap.parent, 'Outline gap parent');
  const children = childrenAt(nodes, gap.parent);
  if (children === undefined) {
    throw new DocumentModelError(
      'invalid-index',
      `No outline node at [${gap.parent.join(', ')}] to insert into`,
    );
  }
  if (!Number.isInteger(gap.index) || gap.index < 0 || gap.index > children.length) {
    throw new DocumentModelError(
      'invalid-index',
      `Outline gap ${gap.index} outside 0…${children.length}`,
    );
  }
}

/** Replaces the children of `parent` (`[]`: the top level). */
function withChildrenAt(
  nodes: readonly OutlineNode[],
  parent: OutlinePath,
  fn: (children: readonly OutlineNode[]) => readonly OutlineNode[],
): readonly OutlineNode[] {
  if (parent.length === 0) return fn(nodes);
  return withNodeAt(nodes, parent, (node) => ({ ...node, children: fn(node.children) }));
}

/** Replaces the node at `path` (which must exist). */
function withNodeAt(
  nodes: readonly OutlineNode[],
  path: OutlinePath,
  fn: (node: OutlineNode) => OutlineNode,
): readonly OutlineNode[] {
  const [head, ...rest] = path;
  const node = head === undefined ? undefined : nodes[head];
  if (head === undefined || node === undefined) return nodes;
  const next =
    rest.length === 0 ? fn(node) : { ...node, children: withNodeAt(node.children, rest, fn) };
  if (next === node) return nodes;
  const out = [...nodes];
  out[head] = next;
  return out;
}

/** Where `path` is after the node at `removed` (and its subtree) is taken out. */
function afterRemoval(path: OutlinePath, removed: OutlinePath): OutlinePath | undefined {
  if (isOutlinePathPrefix(removed, path)) return undefined;
  const d = removed.length - 1;
  const at = path[d];
  const gone = removed[d];
  if (at === undefined || gone === undefined || !isOutlinePathPrefix(removed.slice(0, d), path)) {
    return path;
  }
  if (at < gone) return path;
  const out = [...path];
  out[d] = at - 1;
  return out;
}

/** Where `path` is after a node is inserted so that it sits at `inserted`. */
function afterInsertion(path: OutlinePath, inserted: OutlinePath): OutlinePath {
  const d = inserted.length - 1;
  const at = path[d];
  const index = inserted[d];
  if (at === undefined || index === undefined || !isOutlinePathPrefix(inserted.slice(0, d), path)) {
    return path;
  }
  if (at < index) return path;
  const out = [...path];
  out[d] = at + 1;
  return out;
}

function isNoopMove(from: OutlinePath, to: OutlineGap): boolean {
  const last = from[from.length - 1] ?? -1;
  return samePath(from.slice(0, -1), to.parent) && (to.index === last || to.index === last + 1);
}

/**
 * Where the node at `from` ends up when moved to the gap `to` (both in the tree before the
 * move). Does not validate; `editOutline` does.
 */
export function movedOutlinePath(from: OutlinePath, to: OutlineGap): OutlinePath {
  if (isNoopMove(from, to)) return from;
  const parent = afterRemoval(to.parent, from) ?? to.parent;
  const last = from[from.length - 1] ?? 0;
  const index = samePath(from.slice(0, -1), to.parent) && to.index > last ? to.index - 1 : to.index;
  return [...parent, index];
}

/**
 * Where a node that was at `path` is after `edit` (applied to the tree the path belongs
 * to), or undefined when the edit removed it. For UIs that key state (expansion, focus)
 * by path.
 */
export function remapOutlinePath(path: OutlinePath, edit: OutlineEdit): OutlinePath | undefined {
  switch (edit.kind) {
    case 'insert':
      return afterInsertion(path, [...edit.at.parent, edit.at.index]);
    case 'remove':
      return afterRemoval(path, edit.path);
    case 'move': {
      if (isNoopMove(edit.from, edit.to)) return path;
      const target = movedOutlinePath(edit.from, edit.to);
      if (isOutlinePathPrefix(edit.from, path)) {
        return [...target, ...path.slice(edit.from.length)];
      }
      const without = afterRemoval(path, edit.from);
      return without === undefined ? undefined : afterInsertion(without, target);
    }
    default:
      return path;
  }
}

/** Checks a destination against the document's pages (the workspace invariants). */
function assertDestination(destination: Destination, live: ReadonlySet<PageId>): void {
  if (typeof destination !== 'object' || destination === null) invalid('Invalid destination');
  switch (destination.kind) {
    case 'page':
      if (!live.has(destination.page)) {
        throw new DocumentModelError(
          'unknown-page',
          `Outline destination targets page ${String(destination.page)} outside the document`,
        );
      }
      return;
    case 'uri':
      if (typeof destination.uri !== 'string') invalid('Outline link must be a string');
      return;
    case 'unresolved':
      if (typeof destination.reason !== 'string') invalid('Unresolved destination needs a reason');
      if (destination.previous !== undefined && live.has(destination.previous.page)) {
        invalid('An unresolved destination cannot remember a page that is still present');
      }
      return;
    default:
      invalid('Unknown destination kind');
  }
}

/** Structural check of a subtree being inserted: shape, depth and page targets. */
function assertSubtree(node: OutlineNode, live: ReadonlySet<PageId>, depth: number): void {
  if (depth > MAX_OUTLINE_DEPTH) invalid(`Outline nested deeper than ${MAX_OUTLINE_DEPTH}`);
  if (typeof node !== 'object' || node === null) invalid('Outline node must be an object');
  if (typeof node.title !== 'string') invalid('Outline title must be a string');
  if (typeof node.open !== 'boolean') invalid('Outline open flag must be a boolean');
  if (!isArrayValue(node.children)) invalid('Outline children must be an array');
  if (node.destination !== undefined) assertDestination(node.destination, live);
  for (const child of node.children) assertSubtree(child, live, depth + 1);
}

/** Trims a title for an edit and refuses a blank one. */
function assertOutlineTitle(title: string): string {
  if (typeof title !== 'string' || title.trim().length === 0) {
    invalid('Outline title must not be empty');
  }
  return title.trim();
}

/**
 * A new outline item (collapsed, no children). The title is trimmed and must not be blank.
 * `destination` omitted makes a heading without a target.
 */
export function outlineItem(
  title: string,
  destination?: Destination,
  options: { readonly open?: boolean } = {},
): OutlineNode {
  const base: OutlineNode = {
    title: assertOutlineTitle(title),
    open: options.open ?? false,
    children: [],
  };
  return destination === undefined ? base : { ...base, destination };
}

function applyToTree(
  nodes: readonly OutlineNode[],
  edit: OutlineEdit,
  live: ReadonlySet<PageId>,
): {
  readonly nodes: readonly OutlineNode[];
  readonly inverse: OutlineEdit;
  readonly path: OutlinePath;
} {
  switch (edit.kind) {
    case 'insert': {
      requireGap(nodes, edit.at);
      const depth = edit.at.parent.length;
      assertSubtree(edit.node, live, depth);
      const path = [...edit.at.parent, edit.at.index];
      const next = withChildrenAt(nodes, edit.at.parent, (children) => [
        ...children.slice(0, edit.at.index),
        edit.node,
        ...children.slice(edit.at.index),
      ]);
      return { nodes: next, inverse: { kind: 'remove', path }, path };
    }
    case 'remove': {
      const node = requireNode(nodes, edit.path);
      const parent = edit.path.slice(0, -1);
      const index = edit.path[edit.path.length - 1] ?? 0;
      const next = withChildrenAt(nodes, parent, (children) =>
        children.filter((_, i) => i !== index),
      );
      return {
        nodes: next,
        inverse: { kind: 'insert', at: { parent, index }, node },
        path: edit.path,
      };
    }
    case 'rename': {
      const node = requireNode(nodes, edit.path);
      if (typeof edit.title !== 'string') invalid('Outline title must be a string');
      const next =
        node.title === edit.title
          ? nodes
          : withNodeAt(nodes, edit.path, (n) => ({ ...n, title: edit.title }));
      return {
        nodes: next,
        inverse: { kind: 'rename', path: edit.path, title: node.title },
        path: edit.path,
      };
    }
    case 'set-destination': {
      const node = requireNode(nodes, edit.path);
      if (edit.destination !== null) assertDestination(edit.destination, live);
      const next = withNodeAt(nodes, edit.path, (n) =>
        withDestination(n, edit.destination ?? undefined),
      );
      return {
        nodes: next,
        inverse: {
          kind: 'set-destination',
          path: edit.path,
          destination: node.destination ?? null,
        },
        path: edit.path,
      };
    }
    case 'set-open': {
      const node = requireNode(nodes, edit.path);
      if (typeof edit.open !== 'boolean') invalid('Outline open flag must be a boolean');
      const next =
        node.open === edit.open
          ? nodes
          : withNodeAt(nodes, edit.path, (n) => ({ ...n, open: edit.open }));
      return {
        nodes: next,
        inverse: { kind: 'set-open', path: edit.path, open: node.open },
        path: edit.path,
      };
    }
    case 'move': {
      const node = requireNode(nodes, edit.from);
      requireGap(nodes, edit.to);
      if (isOutlinePathPrefix(edit.from, edit.to.parent)) {
        invalid('An outline item cannot be moved into itself');
      }
      if (isNoopMove(edit.from, edit.to)) {
        return { nodes, inverse: edit, path: edit.from };
      }
      if (edit.to.parent.length + outlineHeight(node) > MAX_OUTLINE_DEPTH) {
        invalid(`Outline nested deeper than ${MAX_OUTLINE_DEPTH}`);
      }
      const from = edit.from;
      const oldParent = from.slice(0, -1);
      const oldIndex = from[from.length - 1] ?? 0;
      const target = movedOutlinePath(from, edit.to);
      const without = withChildrenAt(nodes, oldParent, (children) =>
        children.filter((_, i) => i !== oldIndex),
      );
      const newParent = target.slice(0, -1);
      const newIndex = target[target.length - 1] ?? 0;
      const next = withChildrenAt(without, newParent, (children) => [
        ...children.slice(0, newIndex),
        node,
        ...children.slice(newIndex),
      ]);
      // The old place, as a gap in the tree without the node, then with it at `target`.
      const backParent = afterInsertion(oldParent, target);
      const backIndex =
        samePath(oldParent, newParent) && oldIndex > newIndex ? oldIndex + 1 : oldIndex;
      return {
        nodes: next,
        inverse: { kind: 'move', from: target, to: { parent: backParent, index: backIndex } },
        path: target,
      };
    }
    default:
      invalid('Unknown outline edit');
  }
}

/** Levels in a subtree: 1 for a leaf. */
function outlineHeight(node: OutlineNode): number {
  let height = 0;
  for (const child of node.children) height = Math.max(height, outlineHeight(child));
  return height + 1;
}

/**
 * Applies one edit to a document's outline and returns the new workspace, the edit that
 * undoes it and where the edited node is. Edits are structural: `insert` keeps the node as
 * given (it may be a subtree removed earlier, whose titles came from the file); use
 * `outlineItem` for new items and `renameOutlineNode` for user renames, which refuse blank
 * titles. Page destinations must target pages of the document. Marks the document
 * modified; returns the workspace unchanged when nothing changes. Throws `invalid-index`
 * for a path or gap that does not exist and `invalid-argument` for a move into itself.
 */
export function editOutline(
  ws: Workspace,
  documentId: DocumentId,
  edit: OutlineEdit,
): OutlineEditResult {
  const doc = requireDocument(ws, documentId);
  if (typeof edit !== 'object' || edit === null) invalid('Outline edit must be an object');
  const live = new Set(doc.pages.map((p) => p.id));
  const { nodes, inverse, path } = applyToTree(doc.outline, edit, live);
  if (nodes === doc.outline) return { workspace: ws, inverse, path };
  const workspace = withWorkspace(ws, {
    documents: putDocuments(ws.documents, [{ ...doc, outline: nodes, clean: false }]),
  });
  return { workspace, inverse, path };
}

/** Inserts a node (see `outlineItem`) at a gap. */
export function insertOutlineNode(
  ws: Workspace,
  documentId: DocumentId,
  at: OutlineGap,
  node: OutlineNode,
): Workspace {
  return editOutline(ws, documentId, { kind: 'insert', at, node }).workspace;
}

/** Deletes a node together with its children. */
export function removeOutlineNode(
  ws: Workspace,
  documentId: DocumentId,
  path: OutlinePath,
): Workspace {
  return editOutline(ws, documentId, { kind: 'remove', path }).workspace;
}

/** Renames a node; the title is trimmed and must not be blank. */
export function renameOutlineNode(
  ws: Workspace,
  documentId: DocumentId,
  path: OutlinePath,
  title: string,
): Workspace {
  return editOutline(ws, documentId, { kind: 'rename', path, title: assertOutlineTitle(title) })
    .workspace;
}

/** Sets (or, with `null`, removes) a node's destination. */
export function setOutlineDestination(
  ws: Workspace,
  documentId: DocumentId,
  path: OutlinePath,
  destination: Destination | null,
): Workspace {
  return editOutline(ws, documentId, { kind: 'set-destination', path, destination }).workspace;
}

/** Sets whether a node is shown expanded when the exported file is opened (/Count sign). */
export function setOutlineOpen(
  ws: Workspace,
  documentId: DocumentId,
  path: OutlinePath,
  open: boolean,
): Workspace {
  return editOutline(ws, documentId, { kind: 'set-open', path, open }).workspace;
}

/** Moves a node (with its children) to a gap given in the tree before the move. */
export function moveOutlineNode(
  ws: Workspace,
  documentId: DocumentId,
  from: OutlinePath,
  to: OutlineGap,
): Workspace {
  return editOutline(ws, documentId, { kind: 'move', from, to }).workspace;
}

/**
 * Removes the dead links of a document's outline: nodes whose page left the document.
 * An unresolved node that still has live children stays as a heading without a target
 * (as the export does, `dropUnresolved`).
 */
export function removeDeadOutlineLinks(ws: Workspace, documentId: DocumentId): Workspace {
  const doc = requireDocument(ws, documentId);
  const outline = dropUnresolved(doc.outline);
  if (outline === doc.outline) return ws;
  return withWorkspace(ws, {
    documents: putDocuments(ws.documents, [{ ...doc, outline, clean: false }]),
  });
}

/** Number of nodes with an unresolved destination (dead links). */
export function countDeadOutlineLinks(nodes: readonly OutlineNode[]): number {
  let count = 0;
  walkOutline(nodes, (node) => {
    if (node.destination?.kind === 'unresolved') count += 1;
  });
  return count;
}

export type OutlineMoveDirection = 'up' | 'down' | 'indent' | 'outdent';

/**
 * The gap for a keyboard move of the node at `path`: `up` / `down` swap with the previous
 * / next sibling, `indent` makes it the last child of its previous sibling, `outdent`
 * places it right after its parent. Undefined when the move is not possible (first or last
 * sibling, top level, missing node).
 */
export function outlineMoveGap(
  nodes: readonly OutlineNode[],
  path: OutlinePath,
  direction: OutlineMoveDirection,
): OutlineGap | undefined {
  if (path.length === 0 || outlineNodeAt(nodes, path) === undefined) return undefined;
  const parent = path.slice(0, -1);
  const index = path[path.length - 1] ?? 0;
  const siblings = childrenAt(nodes, parent) ?? [];
  switch (direction) {
    case 'up':
      return index > 0 ? { parent, index: index - 1 } : undefined;
    case 'down':
      return index < siblings.length - 1 ? { parent, index: index + 2 } : undefined;
    case 'indent': {
      const previous = siblings[index - 1];
      return previous === undefined
        ? undefined
        : { parent: [...parent, index - 1], index: previous.children.length };
    }
    case 'outdent': {
      if (parent.length === 0) return undefined;
      const parentIndex = parent[parent.length - 1] ?? 0;
      return { parent: parent.slice(0, -1), index: parentIndex + 1 };
    }
  }
}
