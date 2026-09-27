/**
 * Test helpers: PDFs are generated at runtime with @cantoo/pdf-lib so the suite does not
 * depend on repository fixtures.
 */

import { degrees, PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
// Vite resolves this to a URL served from node_modules (see vitest.config.ts fs.allow).
import wasmUrl from '@embedpdf/pdfium/pdfium.wasm?url';
import type {
  BlobId,
  DocumentId,
  OverlayOp,
  PageId,
  PageRef,
  Rotation,
  SourceId,
  VirtualDocument,
  VirtualPage,
} from '@pdf-editor/document-model';

export { wasmUrl };

export interface PageSpec {
  readonly size: [number, number];
  readonly text?: string;
  readonly rotation?: Rotation;
  /** Where to draw `text` (user space); defaults to (20, 40). */
  readonly at?: [number, number];
}

export async function makePdf(
  pages: readonly PageSpec[],
  init?: (doc: PDFDocument) => void | Promise<void>,
): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const spec of pages) {
    const page = doc.addPage(spec.size);
    if (spec.text) {
      const [x, y] = spec.at ?? [20, 40];
      page.drawText(spec.text, { x, y, size: 14, font });
    }
    if (spec.rotation) page.setRotation(degrees(spec.rotation));
  }
  await init?.(doc);
  return toBuffer(await doc.save());
}

export function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

export const sid = (s: string) => s as SourceId;
export const pid = (s: string) => s as PageId;
export const bid = (s: string) => s as BlobId;

let pageCounter = 0;

export function vpage(ref: PageRef, extra: Partial<Omit<VirtualPage, 'ref'>> = {}): VirtualPage {
  return {
    id: extra.id ?? pid(`p${++pageCounter}`),
    ref,
    rotation: extra.rotation ?? 0,
    overlays: extra.overlays ?? [],
    ...(extra.cropBox ? { cropBox: extra.cropBox } : {}),
  };
}

export function vdoc(pages: VirtualPage[], extra: Partial<VirtualDocument> = {}): VirtualDocument {
  return {
    id: 'doc' as DocumentId,
    title: 'Test document',
    pages,
    outline: [],
    labels: [],
    metadata: { policy: 'inherit-first-source' },
    formMergePolicy: 'namespace-by-source',
    clean: false,
    ...extra,
  };
}

export const pageNumberOverlay: OverlayOp = {
  kind: 'text',
  layer: 'over',
  template: '{page}/{pages}',
  anchor: 'bottom-center',
  offset: { x: 0, y: 10 },
  font: { family: 'Helvetica', size: 10 },
  color: { r: 0, g: 0, b: 0 },
  opacity: 1,
};

/** Prints a timing line to the Vitest output (visible with --silent=false). */
export function logTiming(label: string, startedAt: number): void {
  // eslint-disable-next-line no-console -- intentional benchmark output
  console.info(`[timing] ${label}: ${(performance.now() - startedAt).toFixed(1)} ms`);
}
