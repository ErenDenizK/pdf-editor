/**
 * Workspace lifecycle: creating it, opening sources, and tab-level document operations.
 */
import { DocumentModelError } from './errors';
import type { IdGenerator } from './ids';
import {
  assertSize,
  assertTitle,
  isArrayValue,
  isRotation,
  lookup,
  omitKeys,
  putDocuments,
  requireDocument,
  requireSource,
  withWorkspace,
} from './internal';
import { isSourceReferenced } from './selectors';
import type {
  Destination,
  DestinationView,
  DocumentId,
  DocumentMetadata,
  OutlineNode,
  PageId,
  SourceDocument,
  SourceFlags,
  SourceId,
  SourcePageInfo,
  VirtualDocument,
  VirtualPage,
  Workspace,
} from './types';

export function createWorkspace(): Workspace {
  return { sources: {}, documents: {}, documentOrder: [], engineEdits: [] };
}

/** Outline as reported by the engine: destinations are page indices in the source. */
export interface SourceOutlineNode {
  readonly title: string;
  readonly destination?:
    | { readonly kind: 'page'; readonly pageIndex: number; readonly view?: DestinationView }
    | { readonly kind: 'uri'; readonly uri: string }
    | { readonly kind: 'unresolved'; readonly reason: string };
  readonly open: boolean;
  readonly children: readonly SourceOutlineNode[];
}

/** What the engine reports after opening a file (structurally compatible with OpenedDocument). */
export interface SourceInput {
  readonly name: string;
  readonly byteLength: number;
  readonly pageCount: number;
  readonly pages: readonly SourcePageInfo[];
  readonly fingerprint: string;
  readonly flags: SourceFlags;
  readonly metadata: DocumentMetadata;
  readonly outline: readonly SourceOutlineNode[];
}

export interface AddSourceResult {
  readonly workspace: Workspace;
  readonly sourceId: SourceId;
  readonly documentId: DocumentId;
}

function assertSourceInput(input: SourceInput): void {
  const fail = (message: string): never => {
    throw new DocumentModelError('invalid-argument', `Source input: ${message}`);
  };
  if (typeof input.name !== 'string') fail('name must be a string');
  if (!Number.isSafeInteger(input.byteLength) || input.byteLength < 0) fail('invalid byteLength');
  if (!Number.isSafeInteger(input.pageCount) || input.pageCount < 0) fail('invalid pageCount');
  if (!isArrayValue(input.pages) || input.pages.length !== input.pageCount) {
    fail('pages.length must equal pageCount');
  }
  input.pages.forEach((page, i) => {
    assertSize(page.size, `Source page ${i}`);
    if (!isRotation(page.rotation)) fail(`page ${i} has invalid rotation`);
    if (page.label !== undefined && typeof page.label !== 'string') fail(`page ${i} label`);
  });
  if (typeof input.fingerprint !== 'string') fail('fingerprint must be a string');
  if (!isArrayValue(input.outline)) fail('outline must be an array');
}

export function documentTitleFromName(name: string): string {
  const stripped = name.replace(/\.pdf$/i, '').trim();
  return stripped.length > 0 ? stripped : 'Untitled';
}

function convertOutline(
  nodes: readonly SourceOutlineNode[],
  pageIds: readonly PageId[],
  source: SourceId,
): OutlineNode[] {
  return nodes.map((node) => {
    const base: OutlineNode = {
      title: node.title,
      open: node.open,
      children: convertOutline(node.children, pageIds, source),
      origin: { source },
    };
    const dest = node.destination;
    if (dest === undefined) return base;
    let destination: Destination;
    if (dest.kind === 'page') {
      const page = Number.isInteger(dest.pageIndex) ? pageIds[dest.pageIndex] : undefined;
      if (page === undefined) {
        destination = {
          kind: 'unresolved',
          reason: `Page index ${dest.pageIndex} is outside the source (${pageIds.length} pages)`,
        };
      } else {
        destination =
          dest.view === undefined
            ? { kind: 'page', page }
            : { kind: 'page', page, view: dest.view };
      }
    } else if (dest.kind === 'uri') {
      destination = { kind: 'uri', uri: dest.uri };
    } else {
      destination = { kind: 'unresolved', reason: dest.reason };
    }
    return { ...base, destination };
  });
}

/**
 * Registers an opened file and creates one document showing all of its pages in order.
 * Outline destinations are mapped to the new page ids; authored page labels stay on the
 * source (the document starts without explicit ranges; see labels.ts). The new document is
 * appended to the tab order and activated.
 */
export function addSource(
  ws: Workspace,
  input: SourceInput,
  ids: IdGenerator,
  options: { readonly title?: string } = {},
): AddSourceResult {
  assertSourceInput(input);
  const sourceId = ids.source();
  const documentId = ids.document();
  if (lookup(ws.sources, sourceId) !== undefined) {
    throw new DocumentModelError('duplicate-id', `Source id already in use: ${sourceId}`);
  }
  if (lookup(ws.documents, documentId) !== undefined) {
    throw new DocumentModelError('duplicate-id', `Document id already in use: ${documentId}`);
  }
  const source: SourceDocument = {
    id: sourceId,
    name: input.name,
    byteLength: input.byteLength,
    pageCount: input.pageCount,
    pages: input.pages,
    fingerprint: input.fingerprint,
    flags: input.flags,
  };
  const pages: VirtualPage[] = input.pages.map((_, index) => ({
    id: ids.page(),
    ref: { kind: 'source', source: sourceId, index },
    rotation: 0,
    overlays: [],
  }));
  const document: VirtualDocument = {
    id: documentId,
    title: assertTitle(options.title ?? documentTitleFromName(input.name)),
    pages,
    outline: convertOutline(
      input.outline,
      pages.map((p) => p.id),
      sourceId,
    ),
    labels: [],
    metadata: { ...input.metadata, policy: 'inherit-first-source' },
    formMergePolicy: 'namespace-by-source',
    clean: true,
  };
  const workspace = withWorkspace(ws, {
    sources: { ...ws.sources, [sourceId]: source },
    documents: putDocuments(ws.documents, [document]),
    documentOrder: [...ws.documentOrder, documentId],
    activeDocument: documentId,
  });
  return { workspace, sourceId, documentId };
}

/** Creates an empty document (e.g. a target for dragging pages into). */
export function newEmptyDocument(
  ws: Workspace,
  ids: IdGenerator,
  options: { readonly title?: string; readonly index?: number } = {},
): { readonly workspace: Workspace; readonly documentId: DocumentId } {
  const title = assertTitle(options.title ?? 'Untitled');
  const index = options.index ?? ws.documentOrder.length;
  if (!Number.isInteger(index) || index < 0 || index > ws.documentOrder.length) {
    throw new DocumentModelError('invalid-index', `Tab index ${index} out of range`);
  }
  const documentId = ids.document();
  if (lookup(ws.documents, documentId) !== undefined) {
    throw new DocumentModelError('duplicate-id', `Document id already in use: ${documentId}`);
  }
  const document: VirtualDocument = {
    id: documentId,
    title,
    pages: [],
    outline: [],
    labels: [],
    metadata: { policy: 'inherit-first-source' },
    formMergePolicy: 'namespace-by-source',
    clean: true,
  };
  const order = [...ws.documentOrder];
  order.splice(index, 0, documentId);
  const workspace = withWorkspace(ws, {
    documents: putDocuments(ws.documents, [document]),
    documentOrder: order,
    activeDocument: documentId,
  });
  return { workspace, documentId };
}

/**
 * Closes a tab. Sources stay registered (call removeSourceIfUnreferenced to release them).
 * When the active document closes, the tab that takes its place becomes active (the next
 * one, else the previous one).
 */
export function closeDocument(ws: Workspace, documentId: DocumentId): Workspace {
  requireDocument(ws, documentId);
  const position = ws.documentOrder.indexOf(documentId);
  const order = ws.documentOrder.filter((id) => id !== documentId);
  let active: DocumentId | null | undefined;
  if (ws.activeDocument === documentId) {
    active = order[Math.min(position, order.length - 1)] ?? null;
  }
  return withWorkspace(ws, {
    documents: omitKeys(ws.documents, new Set([documentId])),
    documentOrder: order,
    ...(active === undefined ? {} : { activeDocument: active }),
  });
}

/**
 * Removes a source (and its engine edits) when no page references it; otherwise returns
 * the workspace unchanged. Throws for unknown sources.
 */
export function removeSourceIfUnreferenced(ws: Workspace, sourceId: SourceId): Workspace {
  requireSource(ws, sourceId);
  if (isSourceReferenced(ws, sourceId)) return ws;
  const engineEdits = ws.engineEdits.some((e) => e.source === sourceId)
    ? ws.engineEdits.filter((e) => e.source !== sourceId)
    : ws.engineEdits;
  return withWorkspace(ws, {
    sources: omitKeys(ws.sources, new Set([sourceId])),
    engineEdits,
  });
}

export function setActiveDocument(ws: Workspace, documentId: DocumentId): Workspace {
  requireDocument(ws, documentId);
  return ws.activeDocument === documentId ? ws : withWorkspace(ws, { activeDocument: documentId });
}

/** Sets the tab order; `order` must be a permutation of the open documents. */
export function reorderDocuments(ws: Workspace, order: readonly DocumentId[]): Workspace {
  const unique = new Set(order);
  if (
    order.length !== ws.documentOrder.length ||
    unique.size !== order.length ||
    !ws.documentOrder.every((id) => unique.has(id))
  ) {
    throw new DocumentModelError(
      'invalid-argument',
      'Order must be a permutation of open documents',
    );
  }
  if (order.every((id, i) => ws.documentOrder[i] === id)) return ws;
  return withWorkspace(ws, { documentOrder: [...order] });
}

export function renameDocument(ws: Workspace, documentId: DocumentId, title: string): Workspace {
  const doc = requireDocument(ws, documentId);
  const trimmed = assertTitle(title);
  if (trimmed === doc.title) return ws;
  return withWorkspace(ws, {
    documents: putDocuments(ws.documents, [{ ...doc, title: trimmed, clean: false }]),
  });
}

/** Marks a document clean (after a successful export). */
export function markDocumentClean(ws: Workspace, documentId: DocumentId): Workspace {
  const doc = requireDocument(ws, documentId);
  if (doc.clean) return ws;
  return withWorkspace(ws, { documents: putDocuments(ws.documents, [{ ...doc, clean: true }]) });
}
