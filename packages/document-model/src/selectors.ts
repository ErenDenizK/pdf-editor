/**
 * Read-only queries over a Workspace. `get*` throw a DocumentModelError for unknown ids;
 * `find*` return undefined.
 */
import { DocumentModelError } from './errors';
import { lookup, pageIndex, requireDocument, requireSource, type PageLocation } from './internal';
import type {
  DocumentId,
  PageId,
  Rotation,
  Size,
  SourceDocument,
  SourceId,
  VirtualDocument,
  VirtualPage,
  Workspace,
} from './types';

export type { PageLocation } from './internal';

export function getDocument(ws: Workspace, id: DocumentId): VirtualDocument {
  return requireDocument(ws, id);
}

export function findDocument(ws: Workspace, id: DocumentId): VirtualDocument | undefined {
  return lookup(ws.documents, id);
}

export function getSource(ws: Workspace, id: SourceId): SourceDocument {
  return requireSource(ws, id);
}

/** Documents in tab order. */
export function documentsInOrder(ws: Workspace): VirtualDocument[] {
  return ws.documentOrder.map((id) => requireDocument(ws, id));
}

export function getActiveDocument(ws: Workspace): VirtualDocument | undefined {
  return ws.activeDocument === undefined ? undefined : lookup(ws.documents, ws.activeDocument);
}

export function findPageLocation(ws: Workspace, id: PageId): PageLocation | undefined {
  return pageIndex(ws).get(id);
}

export function getPage(ws: Workspace, id: PageId): VirtualPage {
  const location = findPageLocation(ws, id);
  const page =
    location === undefined
      ? undefined
      : lookup(ws.documents, location.document)?.pages[location.index];
  if (page === undefined) {
    throw new DocumentModelError('unknown-page', `Unknown page: ${String(id)}`);
  }
  return page;
}

export function documentPageCount(ws: Workspace, id: DocumentId): number {
  return requireDocument(ws, id).pages.length;
}

/** Intrinsic rotation plus the page's delta, normalized. */
export function pageTotalRotation(ws: Workspace, page: VirtualPage): Rotation {
  const intrinsic =
    page.ref.kind === 'source'
      ? (requireSource(ws, page.ref.source).pages[page.ref.index]?.rotation ?? 0)
      : 0;
  return ((intrinsic + page.rotation) % 360) as Rotation;
}

/** Unrotated size: crop box override, else the source page / blank / image size. */
export function pageUnrotatedSize(ws: Workspace, page: VirtualPage): Size {
  if (page.cropBox !== undefined) {
    return { width: page.cropBox.width, height: page.cropBox.height };
  }
  if (page.ref.kind !== 'source') return page.ref.size;
  const info = requireSource(ws, page.ref.source).pages[page.ref.index];
  if (info === undefined) {
    throw new DocumentModelError('invalid-index', `Source page ${page.ref.index} does not exist`);
  }
  return info.size;
}

/** Size as displayed: unrotated size with width/height swapped for 90/270 rotations. */
export function pageDisplaySize(ws: Workspace, page: VirtualPage): Size {
  const size = pageUnrotatedSize(ws, page);
  const rotation = pageTotalRotation(ws, page);
  return rotation === 90 || rotation === 270 ? { width: size.height, height: size.width } : size;
}

export interface SourceReference {
  readonly document: DocumentId;
  readonly page: PageId;
  readonly index: number;
}

/** Every virtual page that references `sourceId`, in tab order. */
export function sourceReferences(ws: Workspace, sourceId: SourceId): SourceReference[] {
  const out: SourceReference[] = [];
  for (const docId of ws.documentOrder) {
    const doc = lookup(ws.documents, docId);
    doc?.pages.forEach((page, index) => {
      if (page.ref.kind === 'source' && page.ref.source === sourceId) {
        out.push({ document: doc.id, page: page.id, index });
      }
    });
  }
  return out;
}

export function isSourceReferenced(ws: Workspace, sourceId: SourceId): boolean {
  return Object.values<VirtualDocument>(ws.documents).some((doc) =>
    doc.pages.some((page) => page.ref.kind === 'source' && page.ref.source === sourceId),
  );
}

/** Finds an already-open source with the same fingerprint (dedupe on open). */
export function findSourceByFingerprint(
  ws: Workspace,
  fingerprint: string,
): SourceDocument | undefined {
  return Object.values<SourceDocument>(ws.sources).find((s) => s.fingerprint === fingerprint);
}

/**
 * Sources with recorded engine edits (annotations, form values). Export serializes these
 * through the engine (`PdfEditor.save()`) instead of using their original bytes.
 */
export function sourcesWithEngineEdits(ws: Workspace): Set<SourceId> {
  return new Set(ws.engineEdits.map((edit) => edit.source));
}
