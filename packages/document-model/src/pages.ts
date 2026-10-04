/**
 * Structural operations. Each takes a Workspace and returns a new one (or the same one
 * when the operation is a no-op), validates its inputs, and throws DocumentModelError on
 * misuse. Page ids are stable: moving a page keeps its id, so outline destinations follow
 * it; duplicates get fresh ids.
 *
 * Operations that build a new document from existing ones (interleave, split, merge)
 * consume their inputs: the pages move into the result, which keeps the invariant that
 * every PageId lives in exactly one document. The result becomes the active document.
 */
import { DocumentModelError } from './errors';
import type { IdGenerator } from './ids';
import {
  assertInsertIndex,
  assertRect,
  assertSize,
  assertTitle,
  isArrayValue,
  locatePages,
  normalizeRotation,
  omitKeys,
  putDocuments,
  requireDocument,
  sameElements,
  withWorkspace,
  type LocatedPage,
} from './internal';
import {
  deriveRangesFromLabels,
  effectiveLabels,
  shiftLabelsForInsertion,
  shiftLabelsForRemoval,
  sliceLabels,
} from './labels';
import { fieldsWithin, joinFields, pruneFields, withDocumentFields } from './fields';
import { mapOutline, pruneOutline, restrictOutline, wrapOutline } from './outline';
import { assertResize, type ResizeRequest, resizeForPage, resizeProblem } from './resize';
import { pageDisplaySize } from './selectors';
import type {
  BatesConfig,
  BlobId,
  CreatedField,
  DocumentId,
  OutlineNode,
  OverlayOp,
  PageId,
  PageLabelRange,
  PageResize,
  Rect,
  Size,
  VirtualDocument,
  VirtualPage,
  Workspace,
} from './types';

/** A gap position in a document: insert before the page currently at `index`. */
export interface PageTarget {
  readonly document: DocumentId;
  readonly index: number;
}

/** ISO A4 in points; used for blank pages when there is no neighbour to copy. */
export const DEFAULT_PAGE_SIZE: Size = { width: 595.28, height: 841.89 };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Rebuilds a document after its page list changed; prunes/restores outline targets and
 * drops created form fields whose pages left (fields.ts; undo restores them).
 */
function withPages(
  doc: VirtualDocument,
  pages: readonly VirtualPage[],
  labels: readonly PageLabelRange[],
): VirtualDocument {
  const live = new Set(pages.map((p) => p.id));
  return withDocumentFields(
    {
      ...doc,
      pages,
      labels: pages.length === 0 ? [] : labels,
      outline: pruneOutline(doc.outline, live),
      clean: false,
    },
    pruneFields(doc.fields, live),
  );
}

function groupByDocument(located: readonly LocatedPage[]): Map<DocumentId, Set<number>> {
  const groups = new Map<DocumentId, Set<number>>();
  for (const page of located) {
    let set = groups.get(page.document);
    if (set === undefined) {
      set = new Set();
      groups.set(page.document, set);
    }
    set.add(page.index);
  }
  return groups;
}

function pagesOf(ws: Workspace, located: readonly LocatedPage[]): VirtualPage[] {
  return located.map((loc) => {
    const page = requireDocument(ws, loc.document).pages[loc.index];
    if (page === undefined) throw new DocumentModelError('unknown-page', String(loc.id));
    return page;
  });
}

function insertAt<T>(items: readonly T[], index: number, inserted: readonly T[]): T[] {
  return [...items.slice(0, index), ...inserted, ...items.slice(index)];
}

/** Applies `fn` to the selected pages; documents with no actual change are shared. */
function updatePages(
  ws: Workspace,
  pageIds: readonly PageId[],
  fn: (page: VirtualPage) => VirtualPage,
): Workspace {
  const groups = groupByDocument(locatePages(ws, pageIds));
  const updated: VirtualDocument[] = [];
  for (const [docId, indices] of groups) {
    const doc = requireDocument(ws, docId);
    const pages = doc.pages.map((page, i) => (indices.has(i) ? fn(page) : page));
    if (!sameElements(pages, doc.pages)) updated.push({ ...doc, pages, clean: false });
  }
  return updated.length === 0
    ? ws
    : withWorkspace(ws, { documents: putDocuments(ws.documents, updated) });
}

/**
 * Replaces `removed` documents with `added` ones. The added documents take the tab
 * position of `anchor` (defaults to the first removed document), in the given order.
 */
function replaceDocumentsInOrder(
  ws: Workspace,
  removed: readonly DocumentId[],
  added: readonly VirtualDocument[],
  anchor: DocumentId,
  keepAnchor = false,
): Workspace {
  const removedSet = new Set(removed);
  const order: DocumentId[] = [];
  for (const id of ws.documentOrder) {
    if (id === anchor) {
      if (keepAnchor) order.push(id);
      order.push(...added.map((d) => d.id));
    }
    if (!removedSet.has(id) && !(id === anchor && keepAnchor)) order.push(id);
  }
  const documents = putDocuments(omitKeys(ws.documents, removedSet), added);
  return withWorkspace(ws, {
    documents,
    documentOrder: order,
    activeDocument: added[0]?.id ?? null,
  });
}

function assertOverlays(overlays: readonly OverlayOp[]): void {
  if (!isArrayValue(overlays)) {
    throw new DocumentModelError('invalid-argument', 'Overlays must be an array');
  }
  for (const overlay of overlays) {
    if (overlay.kind !== 'text' && overlay.kind !== 'image') {
      throw new DocumentModelError('invalid-argument', 'Unknown overlay kind');
    }
    if (!(overlay.opacity >= 0 && overlay.opacity <= 1)) {
      throw new DocumentModelError('invalid-argument', 'Overlay opacity must be within 0…1');
    }
    if (overlay.kind === 'image' && !(overlay.scale > 0 && Number.isFinite(overlay.scale))) {
      throw new DocumentModelError('invalid-argument', 'Image overlay scale must be positive');
    }
    if (overlay.kind === 'text' && !(overlay.font.size > 0 && Number.isFinite(overlay.font.size))) {
      throw new DocumentModelError('invalid-argument', 'Text overlay font size must be positive');
    }
    const range = overlay.pages;
    if (range !== undefined) {
      const bad = (n: number | undefined) =>
        n !== undefined && !(Number.isSafeInteger(n) && n >= 1);
      if (bad(range.from) || bad(range.to)) {
        throw new DocumentModelError('invalid-argument', 'Overlay page range must be 1-based');
      }
    }
    if (overlay.tile !== undefined && !(overlay.tile.gapX >= 0 && overlay.tile.gapY >= 0)) {
      throw new DocumentModelError('invalid-argument', 'Overlay tile gaps must not be negative');
    }
  }
}

function assertBates(bates: BatesConfig): void {
  if (bates.run !== undefined && (bates.run.id === '' || !isArrayValue(bates.run.documents))) {
    throw new DocumentModelError('invalid-argument', 'A Bates run needs an id and documents');
  }
  if (
    !(Number.isSafeInteger(bates.start) && bates.start >= 0) ||
    !(Number.isSafeInteger(bates.width) && bates.width >= 1 && bates.width <= 12)
  ) {
    throw new DocumentModelError('invalid-argument', 'Bates start must be ≥ 0, width 1…12');
  }
}

// ---------------------------------------------------------------------------
// Move, delete, duplicate
// ---------------------------------------------------------------------------

/**
 * Moves pages to `target`, within one document or across documents. `target.index` is a
 * gap position in the target document *before* the moved pages are removed, i.e. what
 * the user sees when dropping. Moved pages keep their relative order (tab order, then
 * page order) regardless of the order of `pageIds`.
 */
export function movePages(
  ws: Workspace,
  args: { readonly pageIds: readonly PageId[]; readonly target: PageTarget },
): Workspace {
  const { target } = args;
  const targetDoc = requireDocument(ws, target.document);
  assertInsertIndex(target.index, targetDoc.pages.length);
  const located = locatePages(ws, args.pageIds);
  const moved = pagesOf(ws, located);
  const removedBeforeTarget = located.filter(
    (loc) => loc.document === target.document && loc.index < target.index,
  ).length;
  const insertIndex = target.index - removedBeforeTarget;

  const updated: VirtualDocument[] = [];
  let targetPages = targetDoc.pages;
  let targetLabels = targetDoc.labels;
  // Created form fields whose widgets all move follow their pages into the target.
  let adopted = targetDoc.fields;
  const movedIds = new Set(moved.map((p) => p.id));
  for (const [docId, removed] of groupByDocument(located)) {
    const doc = requireDocument(ws, docId);
    const pages = doc.pages.filter((_, i) => !removed.has(i));
    const labels = shiftLabelsForRemoval(doc.labels, removed, pages.length);
    if (docId === target.document) {
      targetPages = pages;
      targetLabels = labels;
    } else {
      adopted = joinFields(adopted, fieldsWithin(doc, movedIds));
      updated.push(withPages(doc, pages, labels));
    }
  }
  const finalPages = insertAt(targetPages, insertIndex, moved);
  if (updated.length === 0 && sameElements(finalPages, targetDoc.pages)) return ws;
  const finalLabels = shiftLabelsForInsertion(targetLabels, insertIndex, moved.length);
  updated.push(withPages(withDocumentFields(targetDoc, adopted), finalPages, finalLabels));
  return withWorkspace(ws, { documents: putDocuments(ws.documents, updated) });
}

/** Removes pages. Documents may become empty; they are not closed. */
export function deletePages(ws: Workspace, pageIds: readonly PageId[]): Workspace {
  const groups = groupByDocument(locatePages(ws, pageIds));
  const updated: VirtualDocument[] = [];
  for (const [docId, removed] of groups) {
    const doc = requireDocument(ws, docId);
    const pages = doc.pages.filter((_, i) => !removed.has(i));
    updated.push(withPages(doc, pages, shiftLabelsForRemoval(doc.labels, removed, pages.length)));
  }
  return withWorkspace(ws, { documents: putDocuments(ws.documents, updated) });
}

/**
 * Duplicates pages with fresh ids and the same reference, rotation, crop, resize and
 * overlays. Without a target each copy goes right after its original; with a target all
 * copies are inserted there in relative order. Created form fields stay on the original
 * pages (copies get none: field names must stay unique, and ADR-0005 leaves the policy
 * for duplicated widgets open).
 */
export function duplicatePages(
  ws: Workspace,
  pageIds: readonly PageId[],
  ids: IdGenerator,
  options: { readonly target?: PageTarget } = {},
): Workspace {
  const located = locatePages(ws, pageIds);
  const copy = (page: VirtualPage): VirtualPage => ({ ...page, id: ids.page() });

  if (options.target !== undefined) {
    const { target } = options;
    const targetDoc = requireDocument(ws, target.document);
    assertInsertIndex(target.index, targetDoc.pages.length);
    const copies = pagesOf(ws, located).map(copy);
    const pages = insertAt(targetDoc.pages, target.index, copies);
    const labels = shiftLabelsForInsertion(targetDoc.labels, target.index, copies.length);
    return withWorkspace(ws, {
      documents: putDocuments(ws.documents, [withPages(targetDoc, pages, labels)]),
    });
  }

  const updated: VirtualDocument[] = [];
  for (const [docId, indices] of groupByDocument(located)) {
    const doc = requireDocument(ws, docId);
    const pages = doc.pages.flatMap((page, i) => (indices.has(i) ? [page, copy(page)] : [page]));
    let labels = doc.labels;
    const descending = [...indices].sort((a, b) => b - a);
    for (const index of descending) labels = shiftLabelsForInsertion(labels, index + 1, 1);
    updated.push(withPages(doc, pages, labels));
  }
  return withWorkspace(ws, { documents: putDocuments(ws.documents, updated) });
}

// ---------------------------------------------------------------------------
// Page properties
// ---------------------------------------------------------------------------

/** Adds `delta` degrees (any multiple of 90, negative allowed) to each page's rotation. */
export function rotatePages(ws: Workspace, pageIds: readonly PageId[], delta: number): Workspace {
  const normalizedDelta = normalizeRotation(delta);
  locatePages(ws, pageIds);
  if (normalizedDelta === 0) return ws;
  return updatePages(ws, pageIds, (page) => ({
    ...page,
    rotation: normalizeRotation(page.rotation + normalizedDelta),
  }));
}

/** Sets (or clears, with undefined) the CropBox override, in unrotated user space. */
export function setPageCropBox(
  ws: Workspace,
  pageId: PageId,
  cropBox: Rect | undefined,
): Workspace {
  if (cropBox !== undefined) assertRect(cropBox, 'Crop box');
  return updatePages(ws, [pageId], (page) => {
    if (cropBox === undefined) {
      if (page.cropBox === undefined) return page;
      const { cropBox: _removed, ...rest } = page;
      return rest;
    }
    return { ...page, cropBox };
  });
}

function sameResize(a: PageResize, b: PageResize): boolean {
  return (
    a.width === b.width &&
    a.height === b.height &&
    a.mode === b.mode &&
    a.anchor === b.anchor &&
    (a.stretch === true) === (b.stretch === true)
  );
}

function withResize(page: VirtualPage, resize: PageResize | undefined): VirtualPage {
  if (resize === undefined) {
    if (page.resize === undefined) return page;
    const { resize: _removed, ...rest } = page;
    return rest;
  }
  if (page.resize !== undefined && sameResize(page.resize, resize)) return page;
  return { ...page, resize };
}

/**
 * Resizes pages (resize.ts). `request` is what the user sees: the displayed size and
 * anchor, converted per page to the stored unrotated form, so pages in different rotations
 * all come out as asked. A request replaces any earlier resize (it maps the content box,
 * not the previous result); a request that matches a page's content size clears its
 * resize, and `undefined` clears every selected page's resize ("Original size"). Pages
 * whose resize does not change keep their identity; undo restores the previous snapshot.
 */
export function resizePages(
  ws: Workspace,
  pageIds: readonly PageId[],
  request: ResizeRequest | undefined,
): Workspace {
  if (request !== undefined) {
    assertResize(request, 'Resize');
    if (request.matchOrientation !== undefined && typeof request.matchOrientation !== 'boolean') {
      throw new DocumentModelError('invalid-argument', 'Resize matchOrientation must be a boolean');
    }
  }
  return updatePages(ws, pageIds, (page) =>
    withResize(page, request === undefined ? undefined : resizeForPage(ws, page, request)),
  );
}

/**
 * Sets (or clears, with undefined) a page's stored resize as is, in unrotated user space
 * (restoring a saved value, tests). Prefer `resizePages`, which speaks in displayed terms.
 */
export function setPageResize(
  ws: Workspace,
  pageId: PageId,
  resize: PageResize | undefined,
): Workspace {
  if (resize !== undefined) {
    const problem = resizeProblem(resize);
    if (problem !== undefined) throw new DocumentModelError('invalid-argument', problem);
  }
  return updatePages(ws, [pageId], (page) => withResize(page, resize));
}

/** Replaces the overlays of the selected pages. */
export function setPageOverlays(
  ws: Workspace,
  pageIds: readonly PageId[],
  overlays: readonly OverlayOp[],
): Workspace {
  assertOverlays(overlays);
  return updatePages(ws, pageIds, (page) => ({ ...page, overlays }));
}

/** Replaces the overlays of every page of a document (page numbers, watermark, …). */
export function setDocumentOverlays(
  ws: Workspace,
  documentId: DocumentId,
  overlays: readonly OverlayOp[],
): Workspace {
  assertOverlays(overlays);
  const doc = requireDocument(ws, documentId);
  if (doc.pages.length === 0) return ws;
  return setPageOverlays(
    ws,
    doc.pages.map((p) => p.id),
    overlays,
  );
}

/**
 * Rewrites the overlays of every page of a document with `fn(overlays, page, index)`, in
 * one step (page furniture: replace the page numbers, keep the watermark). Pages whose
 * overlays come back unchanged (same array) keep their identity.
 */
export function updateDocumentOverlays(
  ws: Workspace,
  documentId: DocumentId,
  fn: (overlays: readonly OverlayOp[], page: VirtualPage, index: number) => readonly OverlayOp[],
): Workspace {
  const doc = requireDocument(ws, documentId);
  let changed = false;
  const pages = doc.pages.map((page, index) => {
    const overlays = fn(page.overlays, page, index);
    if (overlays === page.overlays) return page;
    assertOverlays(overlays);
    changed = true;
    return { ...page, overlays };
  });
  if (!changed) return ws;
  return withWorkspace(ws, {
    documents: putDocuments(ws.documents, [{ ...doc, pages, clean: false }]),
  });
}

/**
 * Sets (or clears, with an empty list or undefined) the document-level furniture: overlays
 * drawn on every page, including pages added later.
 */
export function setDocumentFurniture(
  ws: Workspace,
  documentId: DocumentId,
  overlays: readonly OverlayOp[] | undefined,
): Workspace {
  const doc = requireDocument(ws, documentId);
  if (overlays === undefined || overlays.length === 0) {
    if (doc.furniture === undefined) return ws;
    const { furniture: _removed, ...rest } = doc;
    return withWorkspace(ws, {
      documents: putDocuments(ws.documents, [{ ...rest, clean: false }]),
    });
  }
  assertOverlays(overlays);
  return withWorkspace(ws, {
    documents: putDocuments(ws.documents, [{ ...doc, furniture: overlays, clean: false }]),
  });
}

/**
 * The Bates numbering in effect for a document, with `start` resolved to the number of
 * its first page and no run: in a run, the run's start plus the current page counts of
 * the run members before this document (members that were closed or no longer carry
 * this run are skipped). Undefined when the document has no Bates numbering.
 */
export function effectiveBates(ws: Workspace, documentId: DocumentId): BatesConfig | undefined {
  const doc = ws.documents[documentId];
  const bates = doc?.bates;
  if (bates === undefined) return undefined;
  const { run, ...config } = bates;
  if (run === undefined) return config;
  let start = bates.start;
  for (const id of run.documents) {
    if (id === documentId) return { ...config, start };
    const member = ws.documents[id];
    if (member?.bates?.run?.id === run.id) start += member.pages.length;
  }
  // Not listed in its own run (e.g. copied by a structural operation): numbered alone.
  return config;
}

/** Sets (or clears, with undefined) the document's Bates numbering. */
export function setDocumentBates(
  ws: Workspace,
  documentId: DocumentId,
  bates: BatesConfig | undefined,
): Workspace {
  const doc = requireDocument(ws, documentId);
  if (bates === undefined) {
    if (doc.bates === undefined) return ws;
    const { bates: _removed, ...rest } = doc;
    return withWorkspace(ws, {
      documents: putDocuments(ws.documents, [{ ...rest, clean: false }]),
    });
  }
  assertBates(bates);
  return withWorkspace(ws, {
    documents: putDocuments(ws.documents, [{ ...doc, bates, clean: false }]),
  });
}

// ---------------------------------------------------------------------------
// Insertion
// ---------------------------------------------------------------------------

function insertNewPage(ws: Workspace, target: PageTarget, page: VirtualPage): Workspace {
  const doc = requireDocument(ws, target.document);
  const pages = insertAt(doc.pages, target.index, [page]);
  const labels = shiftLabelsForInsertion(doc.labels, target.index, 1);
  return withWorkspace(ws, {
    documents: putDocuments(ws.documents, [withPages(doc, pages, labels)]),
  });
}

function neighbourSize(ws: Workspace, target: PageTarget): Size {
  const doc = requireDocument(ws, target.document);
  const neighbour = doc.pages[target.index - 1] ?? doc.pages[target.index];
  return neighbour === undefined ? DEFAULT_PAGE_SIZE : pageDisplaySize(ws, neighbour);
}

/** Inserts a blank page. Size defaults to the displayed size of the preceding page. */
export function insertBlankPage(
  ws: Workspace,
  args: PageTarget & { readonly size?: Size },
  ids: IdGenerator,
): Workspace {
  const doc = requireDocument(ws, args.document);
  assertInsertIndex(args.index, doc.pages.length);
  const size = args.size ?? neighbourSize(ws, args);
  assertSize(size, 'Blank page size');
  return insertNewPage(ws, args, {
    id: ids.page(),
    ref: { kind: 'blank', size },
    rotation: 0,
    overlays: [],
  });
}

/** Inserts a page showing an image blob (stored by the app, referenced by BlobId). */
export function insertImagePage(
  ws: Workspace,
  args: PageTarget & { readonly blob: BlobId; readonly size: Size },
  ids: IdGenerator,
): Workspace {
  const doc = requireDocument(ws, args.document);
  assertInsertIndex(args.index, doc.pages.length);
  assertSize(args.size, 'Image page size');
  if (typeof args.blob !== 'string' || args.blob.length === 0) {
    throw new DocumentModelError('invalid-argument', 'Image page needs a blob id');
  }
  return insertNewPage(ws, args, {
    id: ids.page(),
    ref: { kind: 'image', blob: args.blob, size: args.size },
    rotation: 0,
    overlays: [],
  });
}

// ---------------------------------------------------------------------------
// Whole-document reshaping
// ---------------------------------------------------------------------------

/** Reverses page order. Explicit label ranges are positional and stay where they are. */
export function reversePages(ws: Workspace, documentId: DocumentId): Workspace {
  const doc = requireDocument(ws, documentId);
  if (doc.pages.length < 2) return ws;
  const next: VirtualDocument = { ...doc, pages: [...doc.pages].reverse(), clean: false };
  return withWorkspace(ws, { documents: putDocuments(ws.documents, [next]) });
}

export type InterleaveMode = 'alternate' | 'duplex-reverse-b';

/**
 * Interleaves two documents into a new one (a1, b1, a2, b2, …; leftovers appended).
 * 'duplex-reverse-b' reverses b first — the order a scanner produces when the stack is
 * flipped to scan back sides. Both inputs are consumed; the result takes a's tab slot.
 */
export function interleave(
  ws: Workspace,
  args: {
    readonly a: DocumentId;
    readonly b: DocumentId;
    readonly mode: InterleaveMode;
    readonly title?: string;
  },
  ids: IdGenerator,
): Workspace {
  if (args.mode !== 'alternate' && args.mode !== 'duplex-reverse-b') {
    throw new DocumentModelError(
      'invalid-argument',
      `Unknown interleave mode: ${String(args.mode)}`,
    );
  }
  if (args.a === args.b) {
    throw new DocumentModelError('invalid-argument', 'Cannot interleave a document with itself');
  }
  const a = requireDocument(ws, args.a);
  const b = requireDocument(ws, args.b);
  const title = assertTitle(args.title ?? `${a.title} + ${b.title}`);
  const bPages = args.mode === 'duplex-reverse-b' ? [...b.pages].reverse() : b.pages;
  const pages: VirtualPage[] = [];
  for (let i = 0; i < Math.max(a.pages.length, bPages.length); i++) {
    const fromA = a.pages[i];
    const fromB = bPages[i];
    if (fromA !== undefined) pages.push(fromA);
    if (fromB !== undefined) pages.push(fromB);
  }
  // Interleaved pages come from unrelated sequences; any existing labels would read as
  // "1, 1, 2, 2", so labels restart as plain decimal when either input carried any.
  const hadLabels =
    a.labels.length > 0 ||
    b.labels.length > 0 ||
    [a, b].some((doc) => effectiveLabels(ws, doc).some((label, i) => label !== String(i + 1)));
  const live = new Set(pages.map((p) => p.id));
  const doc: VirtualDocument = withDocumentFields(
    {
      ...a,
      id: ids.document(),
      title,
      pages,
      outline: pruneOutline([...a.outline, ...b.outline], live),
      labels:
        hadLabels && pages.length > 0 ? [{ startIndex: 0, style: 'decimal', firstNumber: 1 }] : [],
      clean: false,
    },
    pruneFields(joinFields(a.fields, b.fields), live),
  );
  return replaceDocumentsInOrder(ws, [a.id, b.id], [doc], a.id);
}

export type SplitSpec =
  /** 0-based inclusive [start, end] ranges; each becomes a document. Must not overlap. */
  | { readonly mode: 'ranges'; readonly ranges: readonly (readonly [number, number])[] }
  /** Chunks of n pages. */
  | { readonly mode: 'every'; readonly n: number }
  /** Each listed page starts a new part. */
  | { readonly mode: 'at-pages'; readonly pageIds: readonly PageId[] };

function splitParts(doc: VirtualDocument, spec: SplitSpec): (readonly [number, number])[] {
  const length = doc.pages.length;
  switch (spec.mode) {
    case 'ranges': {
      if (!isArrayValue(spec.ranges) || spec.ranges.length === 0) {
        throw new DocumentModelError('invalid-range', 'At least one range is required');
      }
      const parts = spec.ranges.map(([start, end]) => {
        if (
          !Number.isInteger(start) ||
          !Number.isInteger(end) ||
          start < 0 ||
          end < start ||
          end >= length
        ) {
          throw new DocumentModelError(
            'invalid-range',
            `Invalid range [${start}, ${end}] for ${length} pages`,
          );
        }
        return [start, end + 1] as const;
      });
      const sorted = [...parts].sort((x, y) => x[0] - y[0]);
      for (let i = 1; i < sorted.length; i++) {
        if ((sorted[i]?.[0] ?? 0) < (sorted[i - 1]?.[1] ?? 0)) {
          throw new DocumentModelError('invalid-range', 'Split ranges must not overlap');
        }
      }
      return parts;
    }
    case 'every': {
      if (!Number.isInteger(spec.n) || spec.n < 1) {
        throw new DocumentModelError('invalid-argument', 'Split size must be a positive integer');
      }
      const parts: (readonly [number, number])[] = [];
      for (let start = 0; start < length; start += spec.n) {
        parts.push([start, Math.min(start + spec.n, length)]);
      }
      if (parts.length < 2) {
        throw new DocumentModelError('invalid-argument', 'Split would produce a single part');
      }
      return parts;
    }
    case 'at-pages': {
      const indexOf = new Map(doc.pages.map((p, i) => [p.id, i] as const));
      const cuts = new Set<number>();
      for (const id of spec.pageIds) {
        const index = indexOf.get(id);
        if (index === undefined) {
          throw new DocumentModelError(
            'unknown-page',
            `Page ${String(id)} is not in this document`,
          );
        }
        if (index > 0) cuts.add(index);
      }
      if (cuts.size === 0) {
        throw new DocumentModelError('invalid-argument', 'Split would produce a single part');
      }
      const bounds = [0, ...[...cuts].sort((x, y) => x - y), length];
      return bounds.slice(1).map((end, i) => [bounds[i] ?? 0, end] as const);
    }
    default:
      throw new DocumentModelError('invalid-argument', 'Unknown split mode');
  }
}

/** Number of parts `splitDocument` would create; throws like it for invalid specs. */
export function splitPartSizes(
  ws: Workspace,
  documentId: DocumentId,
  spec: SplitSpec,
): readonly number[] {
  const doc = requireDocument(ws, documentId);
  if (doc.pages.length === 0) {
    throw new DocumentModelError('invalid-argument', 'Cannot split an empty document');
  }
  return splitParts(doc, spec).map(([start, end]) => end - start);
}

export interface SplitOptions {
  /**
   * Titles for the parts, in order (e.g. localized "Report (1 of 3)", or bookmark titles).
   * Missing or blank entries fall back to "<title> (k of n)".
   */
  readonly titles?: readonly string[];
}

/**
 * Splits a document into new documents titled "<title> (k of n)" (or `options.titles`).
 * Each part keeps the outline nodes that land in it and its label strings. With 'ranges',
 * pages outside all ranges stay in the original document (which then keeps its tab, parts
 * follow it); otherwise the original is replaced by the parts. The first part becomes
 * active.
 */
export function splitDocument(
  ws: Workspace,
  documentId: DocumentId,
  spec: SplitSpec,
  ids: IdGenerator,
  options: SplitOptions = {},
): Workspace {
  const doc = requireDocument(ws, documentId);
  if (doc.pages.length === 0) {
    throw new DocumentModelError('invalid-argument', 'Cannot split an empty document');
  }
  if (options.titles !== undefined && !isArrayValue(options.titles)) {
    throw new DocumentModelError('invalid-argument', 'Split titles must be an array');
  }
  const parts = splitParts(doc, spec);
  const titleOf = (k: number): string => {
    const custom = options.titles?.[k];
    return typeof custom === 'string' && custom.trim().length > 0
      ? custom.trim()
      : `${doc.title} (${k + 1} of ${parts.length})`;
  };
  const covered = new Set<number>();
  for (const [start, end] of parts) for (let i = start; i < end; i++) covered.add(i);
  const hasLeftovers = covered.size < doc.pages.length;

  const newDocs = parts.map(([start, end], k): VirtualDocument => {
    const pages = doc.pages.slice(start, end);
    const pageSet = new Set(pages.map((p) => p.id));
    const outline = restrictOutline(doc.outline, pageSet, k === 0 && !hasLeftovers);
    return withDocumentFields(
      {
        ...doc,
        id: ids.document(),
        title: titleOf(k),
        pages,
        labels: sliceLabels(doc.labels, start, end),
        outline: pruneOutline(outline, pageSet),
        clean: false,
      },
      // A field belongs to the part with its first widget (ids stay unique).
      pruneFields(
        doc.fields?.filter((f) => pageSet.has(f.widgets[0]?.page as PageId)),
        pageSet,
      ),
    );
  });

  if (!hasLeftovers) return replaceDocumentsInOrder(ws, [doc.id], newDocs, doc.id);

  const remaining = doc.pages.filter((_, i) => !covered.has(i));
  const remainingIds = new Set(remaining.map((p) => p.id));
  const rest = withPages(
    withDocumentFields(
      doc,
      doc.fields?.filter((f) => remainingIds.has(f.widgets[0]?.page as PageId)),
    ),
    remaining,
    shiftLabelsForRemoval(doc.labels, covered, remaining.length),
  );
  const withRest = withWorkspace(ws, { documents: putDocuments(ws.documents, [rest]) });
  return replaceDocumentsInOrder(withRest, [], newDocs, doc.id, true);
}

/**
 * Concatenates documents (in the given order) into a new one. Each input's outline is
 * wrapped under a node titled with the input's title and pointing at its first page.
 * Labels: if no input has explicit ranges, none are set (authored labels and positions
 * flow through); otherwise each input's effective labels are frozen into ranges so every
 * page keeps the label it showed before. Inputs are consumed; the result takes the first
 * input's tab slot and its metadata, security and form policy.
 *
 * With `keepSources` the inputs stay open, untouched: the result is made of copies of their
 * pages (fresh ids, the same references, rotation, crop, resize and overlays, as
 * `duplicatePages` makes them), its outline points at the copies, and it goes in a new tab
 * right after the last input in tab order. Created form fields stay with the inputs (field
 * names must stay unique, as for duplicated pages).
 */
export function mergeDocuments(
  ws: Workspace,
  args: {
    readonly documentIds: readonly DocumentId[];
    readonly title: string;
    readonly keepSources?: boolean;
  },
  ids: IdGenerator,
): Workspace {
  const title = assertTitle(args.title);
  if (!isArrayValue(args.documentIds) || args.documentIds.length < 2) {
    throw new DocumentModelError('invalid-argument', 'Merge needs at least two documents');
  }
  if (new Set(args.documentIds).size !== args.documentIds.length) {
    throw new DocumentModelError('duplicate-id', 'A document is listed twice');
  }
  const docs = args.documentIds.map((id) => requireDocument(ws, id));
  const first = docs[0];
  if (first === undefined) throw new DocumentModelError('invalid-argument', 'Nothing to merge');

  const keep = args.keepSources === true;
  // Kept inputs lend copies of their pages; `copied` maps each original id to its copy.
  const copied = new Map<PageId, PageId>();
  const pages = docs.flatMap((d) =>
    keep
      ? d.pages.map((page) => {
          const copy: VirtualPage = { ...page, id: ids.page() };
          copied.set(page.id, copy.id);
          return copy;
        })
      : d.pages,
  );
  const outline: OutlineNode[] = [];
  for (const d of docs) {
    const firstPage = d.pages[0];
    if (firstPage === undefined && d.outline.length === 0) continue;
    const firstId =
      firstPage === undefined ? undefined : (copied.get(firstPage.id) ?? firstPage.id);
    outline.push(
      wrapOutline(
        d.title,
        keep ? retargetOutline(d.outline, copied) : d.outline,
        firstId === undefined ? {} : { destination: { kind: 'page', page: firstId } },
      ),
    );
  }
  const labels: PageLabelRange[] = [];
  if (docs.some((d) => d.labels.length > 0)) {
    let offset = 0;
    for (const d of docs) {
      for (const range of deriveRangesFromLabels(effectiveLabels(ws, d))) {
        labels.push({ ...range, startIndex: range.startIndex + offset });
      }
      offset += d.pages.length;
    }
  }
  const live = new Set(pages.map((p) => p.id));
  const merged: VirtualDocument = withDocumentFields(
    {
      ...first,
      id: ids.document(),
      title,
      pages,
      // Nodes that went unresolved when pages left one input may point into another.
      outline: pruneOutline(outline, live),
      labels,
      clean: false,
    },
    keep
      ? undefined
      : pruneFields(
          docs.reduce<readonly CreatedField[] | undefined>(
            (all, d) => joinFields(all, d.fields),
            undefined,
          ),
          live,
        ),
  );
  if (keep) {
    const inputs = new Set(docs.map((d) => d.id));
    const last = [...ws.documentOrder].reverse().find((id) => inputs.has(id)) ?? first.id;
    return replaceDocumentsInOrder(ws, [], [merged], last, true);
  }
  return replaceDocumentsInOrder(
    ws,
    docs.map((d) => d.id),
    [merged],
    first.id,
  );
}

/** Points an outline's page destinations (and remembered ones) at the pages' copies. */
function retargetOutline(
  nodes: readonly OutlineNode[],
  copied: ReadonlyMap<PageId, PageId>,
): readonly OutlineNode[] {
  return mapOutline(nodes, (node) => {
    const dest = node.destination;
    if (dest?.kind === 'page') {
      const page = copied.get(dest.page);
      return page === undefined ? node : { ...node, destination: { ...dest, page } };
    }
    if (dest?.kind === 'unresolved' && dest.previous !== undefined) {
      const page = copied.get(dest.previous.page);
      return page === undefined
        ? node
        : { ...node, destination: { ...dest, previous: { ...dest.previous, page } } };
    }
    return node;
  });
}
