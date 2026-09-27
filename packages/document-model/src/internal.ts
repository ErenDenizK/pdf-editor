/**
 * Internal helpers shared by the operation modules. Not part of the public API.
 */
import { DocumentModelError } from './errors';
import type {
  DocumentId,
  PageId,
  Rect,
  Rotation,
  Size,
  SourceDocument,
  SourceId,
  VirtualDocument,
  Workspace,
} from './types';

/** Own-property lookup; never returns inherited members such as `constructor`. */
export function lookup<K extends string, V>(record: Readonly<Record<K, V>>, key: K): V | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

export function requireDocument(ws: Workspace, id: DocumentId): VirtualDocument {
  const doc = lookup(ws.documents, id);
  if (doc === undefined) {
    throw new DocumentModelError('unknown-document', `Unknown document: ${String(id)}`);
  }
  return doc;
}

export function requireSource(ws: Workspace, id: SourceId): SourceDocument {
  const source = lookup(ws.sources, id);
  if (source === undefined) {
    throw new DocumentModelError('unknown-source', `Unknown source: ${String(id)}`);
  }
  return source;
}

export interface WorkspacePatch {
  readonly sources?: Workspace['sources'];
  readonly documents?: Workspace['documents'];
  readonly documentOrder?: Workspace['documentOrder'];
  /** `null` clears the active document; omitted keeps it. */
  readonly activeDocument?: DocumentId | null;
  readonly engineEdits?: Workspace['engineEdits'];
}

/** Returns a new workspace with the patch applied; unchanged fields are shared. */
export function withWorkspace(ws: Workspace, patch: WorkspacePatch): Workspace {
  const active =
    patch.activeDocument === undefined ? ws.activeDocument : (patch.activeDocument ?? undefined);
  const base = {
    sources: patch.sources ?? ws.sources,
    documents: patch.documents ?? ws.documents,
    documentOrder: patch.documentOrder ?? ws.documentOrder,
    engineEdits: patch.engineEdits ?? ws.engineEdits,
  };
  return active === undefined ? base : { ...base, activeDocument: active };
}

/** Replaces or adds documents by id, sharing every other document. */
export function putDocuments(
  documents: Workspace['documents'],
  updated: readonly VirtualDocument[],
): Workspace['documents'] {
  if (updated.length === 0) return documents;
  const next: Record<DocumentId, VirtualDocument> = { ...documents };
  for (const doc of updated) next[doc.id] = doc;
  return next;
}

export function omitKeys<K extends string, V>(
  record: Readonly<Record<K, V>>,
  keys: ReadonlySet<K>,
): Readonly<Record<K, V>> {
  const next = {} as Record<K, V>;
  for (const key of Object.keys(record) as K[]) {
    if (!keys.has(key)) next[key] = record[key];
  }
  return next;
}

// ---------------------------------------------------------------------------
// Page index (memoized per documents record; the record is replaced on every change)
// ---------------------------------------------------------------------------

export interface PageLocation {
  readonly document: DocumentId;
  readonly index: number;
}

const pageIndexCache = new WeakMap<object, ReadonlyMap<PageId, PageLocation>>();

export function pageIndex(ws: Workspace): ReadonlyMap<PageId, PageLocation> {
  const cached = pageIndexCache.get(ws.documents);
  if (cached !== undefined) return cached;
  const map = new Map<PageId, PageLocation>();
  for (const doc of Object.values<VirtualDocument>(ws.documents)) {
    doc.pages.forEach((page, index) => {
      map.set(page.id, { document: doc.id, index });
    });
  }
  pageIndexCache.set(ws.documents, map);
  return map;
}

export interface LocatedPage extends PageLocation {
  readonly id: PageId;
}

/**
 * Validates a page selection (non-empty, no duplicates, all known) and returns it sorted
 * by tab order, then page index — the "relative order" every operation preserves.
 */
export function locatePages(ws: Workspace, pageIds: readonly PageId[]): LocatedPage[] {
  if (!isArrayValue(pageIds) || pageIds.length === 0) {
    throw new DocumentModelError('invalid-argument', 'Page selection must not be empty');
  }
  const index = pageIndex(ws);
  const seen = new Set<PageId>();
  const located: LocatedPage[] = [];
  for (const id of pageIds) {
    if (seen.has(id)) {
      throw new DocumentModelError('duplicate-id', `Page selected twice: ${String(id)}`);
    }
    seen.add(id);
    const location = index.get(id);
    if (location === undefined) {
      throw new DocumentModelError('unknown-page', `Unknown page: ${String(id)}`);
    }
    located.push({ id, ...location });
  }
  const tabPosition = new Map(ws.documentOrder.map((id, i) => [id, i] as const));
  located.sort(
    (a, b) =>
      (tabPosition.get(a.document) ?? 0) - (tabPosition.get(b.document) ?? 0) || a.index - b.index,
  );
  return located;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Runtime array check that does not narrow typed parameters to `any[]`. */
export function isArrayValue(value: unknown): boolean {
  return Array.isArray(value);
}

export function isRotation(value: unknown): value is Rotation {
  return value === 0 || value === 90 || value === 180 || value === 270;
}

/** Normalizes any multiple of 90 (including negatives) to 0/90/180/270. */
export function normalizeRotation(degrees: number): Rotation {
  if (!Number.isInteger(degrees) || degrees % 90 !== 0) {
    throw new DocumentModelError(
      'invalid-argument',
      `Rotation must be a multiple of 90: ${degrees}`,
    );
  }
  return (((degrees % 360) + 360) % 360) as Rotation;
}

export function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function assertSize(size: Size, what: string): void {
  if (
    typeof size !== 'object' ||
    size === null ||
    !isPositiveFinite(size.width) ||
    !isPositiveFinite(size.height)
  ) {
    throw new DocumentModelError(
      'invalid-argument',
      `${what} must have positive finite width and height`,
    );
  }
}

export function assertRect(rect: Rect, what: string): void {
  if (
    typeof rect !== 'object' ||
    rect === null ||
    !Number.isFinite(rect.x) ||
    !Number.isFinite(rect.y) ||
    !isPositiveFinite(rect.width) ||
    !isPositiveFinite(rect.height)
  ) {
    throw new DocumentModelError('invalid-argument', `${what} must be finite with positive size`);
  }
}

export function assertTitle(title: string): string {
  if (typeof title !== 'string' || title.trim().length === 0) {
    throw new DocumentModelError('invalid-argument', 'Title must be a non-empty string');
  }
  return title.trim();
}

/** An insertion index is a gap position: 0 … length inclusive. */
export function assertInsertIndex(index: number, length: number): void {
  if (!Number.isInteger(index) || index < 0 || index > length) {
    throw new DocumentModelError('invalid-index', `Insertion index ${index} outside 0…${length}`);
  }
}

export function sameElements<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
