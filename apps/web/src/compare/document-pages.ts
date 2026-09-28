/**
 * An open tab's pages as the analysis worker reads them (compare, spec §2.1; convert, §4):
 * each page of the tab mapped to a page the PDFium worker has open, with the view rotation
 * on top of its /Rotate and its CropBox.
 *
 * - A tab whose pages are all plain source pages (no crop or resize set in the app, no blank
 *   or image pages) reads its sources directly: renders include annotation and form edits
 *   (they live in the engine), and export-time additions (page numbers, watermarks, headers
 *   and footers) are left out, as the comparison's honesty note says.
 * - Any other tab is assembled first exactly as it would be exported, without compression or
 *   password (tools/tool-source.ts), and read from that copy (a scratch document); there the
 *   export-time additions are part of the pages.
 */
import type {
  DocumentId,
  DocumentMetadata,
  SourceId,
  VirtualDocument,
  Workspace,
} from '@pdf-editor/document-model';
import type {
  Annotation,
  CompareFacts,
  ComparePageGeometry,
  ConvertImageInput,
  ConvertLinkInput,
  EngineCallOptions,
  FormField,
  PdfEditor,
  PdfImageEditor,
  PdfRenderer,
  TextRun,
} from '@pdf-editor/engine';

import { getEngineService } from '../engine/engine-service';
import { useWorkspaceStore } from '../state/workspace-store';
import { openScratch, type ScratchDocument } from '../tools/engine-access';
import { toolSourceBytes } from '../tools/tool-source';
import { type SidePage, totalRotation } from './side-page';

export { displayedPageSize, type SidePage, totalRotation } from './side-page';

export interface DocumentPages {
  readonly documentId: DocumentId;
  readonly name: string;
  readonly pages: readonly SidePage[];
  /** True when the pages come from the assembled document (export-time additions included). */
  readonly assembled: boolean;
  readonly metadata: DocumentMetadata;
  readonly fingerprint?: string;
  /** The sources behind the pages (plain tabs) or the assembled bytes' scratch id. */
  readonly sourceIds: readonly SourceId[];
  /** Bytes for facts read with pdf-lib (XMP, attachments): the sources, or the assembled copy. */
  bytes(): Promise<readonly { readonly bytes: ArrayBuffer; readonly password?: string }[]>;
  /** Closes the scratch document of an assembled tab (idempotent). */
  dispose(): Promise<void>;
}

/** What the tab readers need from the PDFium proxy. */
export type PageEngine = Pick<PdfRenderer, 'renderPage' | 'getPageText'> &
  Pick<PdfEditor, 'listAnnotations' | 'listFormFields'> &
  Partial<Pick<PdfImageEditor, 'locateImages' | 'extractImage'>>;

export async function pageEngine(): Promise<PageEngine> {
  return (await getEngineService().editor()) as unknown as PageEngine;
}

export function isPlainDocument(doc: VirtualDocument): boolean {
  return doc.pages.every(
    (page) => page.ref.kind === 'source' && page.cropBox === undefined && page.resize === undefined,
  );
}

/** The pages of a plain tab (see `isPlainDocument`), from the workspace's source facts. */
export function plainPages(
  ws: Workspace,
  doc: VirtualDocument,
  cropBox: (sourceId: SourceId, index: number) => { x: number; y: number } | undefined,
): SidePage[] {
  return doc.pages.map((page) => {
    if (page.ref.kind !== 'source') throw new Error('Not a source page');
    const { source, index } = page.ref;
    const info = ws.sources[source]?.pages[index];
    if (!info) throw new Error(`Unknown page ${index} of ${source}`);
    const crop = cropBox(source, index);
    return {
      sourceId: source,
      index,
      delta: page.rotation,
      intrinsic: info.rotation,
      size: info.size,
      origin: { x: crop?.x ?? 0, y: crop?.y ?? 0 },
    };
  });
}

/** Reads an open tab for the analysis worker; `dispose()` it when done. */
export async function documentPages(
  documentId: DocumentId,
  options: { readonly signal?: AbortSignal } = {},
): Promise<DocumentPages> {
  const state = useWorkspaceStore.getState();
  const ws = state.workspace;
  const doc = ws.documents[documentId];
  if (!doc) throw new Error('The document was closed');
  const service = getEngineService();
  if (isPlainDocument(doc)) {
    const pages = plainPages(ws, doc, (s, i) => service.pageCropBox(s, i));
    const sourceIds = [...new Set(pages.map((p) => p.sourceId))];
    const only = sourceIds.length === 1 ? ws.sources[sourceIds[0] as SourceId] : undefined;
    return {
      documentId,
      name: doc.title,
      pages,
      assembled: false,
      metadata: doc.metadata,
      ...(only ? { fingerprint: only.fingerprint } : {}),
      sourceIds,
      async bytes() {
        const out: { bytes: ArrayBuffer; password?: string }[] = [];
        for (const id of sourceIds) {
          const read = await service.sourceBytes(id);
          if (!read.ok) continue;
          const password = service.sourcePassword(id);
          out.push({ bytes: read.value, ...(password === undefined ? {} : { password }) });
        }
        return out;
      },
      dispose: () => Promise.resolve(),
    };
  }
  const bytes = await toolSourceBytes(documentId, options.signal);
  const kept = bytes.slice(0);
  let scratch: ScratchDocument | undefined = await openScratch(bytes);
  const opened = scratch.document;
  return {
    documentId,
    name: doc.title,
    pages: opened.pages.map((page, index) => ({
      sourceId: opened.id,
      index,
      delta: 0,
      intrinsic: page.rotation,
      size: page.size,
      origin: { x: page.cropBox?.x ?? 0, y: page.cropBox?.y ?? 0 },
    })),
    assembled: true,
    metadata: doc.metadata,
    fingerprint: opened.fingerprint,
    sourceIds: [opened.id],
    bytes: () => Promise.resolve([{ bytes: kept.slice(0) }]),
    async dispose() {
      const current = scratch;
      scratch = undefined;
      await current?.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Readers for the analysis pipelines (engine CompareSource / ConvertSource shapes)
// ---------------------------------------------------------------------------

export function pageGeometry(page: SidePage): ComparePageGeometry {
  return { size: page.size, rotation: totalRotation(page), origin: page.origin };
}

export function pageAt(side: DocumentPages, index: number): SidePage {
  const page = side.pages[index];
  if (!page) throw new RangeError(`No page ${index}`);
  return page;
}

/** Text runs of a page (the engine service's cache for workspace sources). */
export async function pageText(
  engine: PageEngine,
  side: DocumentPages,
  index: number,
  options: EngineCallOptions,
): Promise<readonly TextRun[]> {
  const page = pageAt(side, index);
  if (!side.assembled) {
    const result = await getEngineService().getPageText(page.sourceId, page.index, options.signal);
    if (result.ok) return result.value;
    // Failed or aborted: ask the engine, which rejects with the right error.
  }
  return engine.getPageText(page.sourceId, page.index, options);
}

/** Facts of a tab: annotation counts per tab page, fields of its sources, the tab's metadata. */
export async function documentFacts(
  engine: PageEngine,
  side: DocumentPages,
  options: EngineCallOptions,
  extract: (bytes: ArrayBuffer, password?: string) => Promise<CompareFacts>,
): Promise<CompareFacts> {
  const { factsFromEngine } = await import('@pdf-editor/engine');
  const annotations: Annotation[][] = [];
  for (const page of side.pages) {
    annotations.push([...(await engine.listAnnotations(page.sourceId, page.index, options))]);
  }
  const fields: FormField[] = [];
  for (const id of side.sourceIds) fields.push(...(await engine.listFormFields(id, options)));
  // XMP and attachments are read from the bytes (pdf-lib); best effort.
  let xmp: CompareFacts['xmp'];
  const attachments: string[] = [];
  try {
    for (const { bytes, password } of await side.bytes()) {
      const facts = await extract(bytes, password);
      xmp ??= facts.xmp;
      attachments.push(...facts.attachments);
    }
  } catch {
    // Facts from the engine only.
  }
  return factsFromEngine(
    {
      pages: side.pages.map((p) => ({ size: p.size, rotation: totalRotation(p) })),
      metadata: side.metadata,
    },
    annotations,
    fields,
    { ...(xmp ? { xmp } : {}), attachments },
  );
}

/** URI links of a page, for the Markdown converter. */
export async function pageLinks(
  engine: PageEngine,
  page: SidePage,
  options: EngineCallOptions,
): Promise<readonly ConvertLinkInput[]> {
  const annotations = await engine.listAnnotations(page.sourceId, page.index, options);
  return annotations.flatMap((a) =>
    a.kind === 'link' && a.uri !== undefined ? [{ rect: a.rect, uri: a.uri }] : [],
  );
}

/** Images of a page with their pixels (JPEG passed through), for the Markdown converter. */
export async function pageImages(
  engine: PageEngine,
  page: SidePage,
  options: EngineCallOptions,
): Promise<readonly ConvertImageInput[]> {
  const { locateImages, extractImage } = engine;
  if (!locateImages || !extractImage) return [];
  const located = await locateImages.call(engine, page.sourceId, page.index, options);
  const out: ConvertImageInput[] = [];
  for (const image of located) {
    const pixels = await extractImage.call(engine, image, options);
    out.push(
      pixels.original
        ? { rect: image.bounds, jpeg: pixels.original.bytes }
        : {
            rect: image.bounds,
            rgba: { width: pixels.width, height: pixels.height, data: pixels.rgba },
          },
    );
  }
  return out;
}
