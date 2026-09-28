/**
 * Test-only helpers for the redaction pipeline (not exported from the package). Produces
 * "engine-redacted" bytes the way docs/research/06-redaction-spike.md §3 step 1 does (a
 * /Redact annotation with no /IC per area, `applyAllRedactions` once per page, then
 * `saveAsCopy`), and wires a `PdfiumAdapter` into `ForensicDeps` for `forensicCheck`.
 *
 * Part b of workstream E2 replaces the engine pass with the private-PDFium host (E1); these
 * helpers stay the reference for tests until then.
 */

import {
  browserImageDataToBlobConverter,
  PdfEngine as OrchestratedEngine,
  PdfiumNative,
} from '@embedpdf/engines/pdfium';
import {
  PdfAnnotationSubtype,
  type PdfDocumentObject,
  type PdfRedactAnnoObject,
} from '@embedpdf/models';
import { init } from '@embedpdf/pdfium';
import type { Rect, SourceId } from '@pdf-editor/document-model';

import { pageGeometry, userToDeviceRect } from '../pdfium/coords';
import { PdfiumAdapter } from '../pdfium/pdfium-adapter';
import type { ForensicDeps, ForensicPixels, RedactionArea } from '../types';

/** A same-thread PDFium shared by the direct engine calls and an adapter. */
export interface RedactionHarness {
  readonly adapter: PdfiumAdapter;
  /**
   * Engine pass of the spike: per page, one /Redact annotation per area with a transparent
   * colour (no /IC, so nothing is painted), `applyAllRedactions` once, then `saveAsCopy`.
   */
  engineRedact(bytes: ArrayBuffer, areas: readonly RedactionArea[]): Promise<ArrayBuffer>;
  /** Opens `bytes` in the adapter and returns forensic dependencies bound to it. */
  open(bytes: ArrayBuffer): Promise<OpenedForCheck>;
  destroy(): Promise<void>;
}

export interface OpenedForCheck {
  readonly deps: ForensicDeps;
  close(): Promise<void>;
}

let counter = 0;

/** Creates the harness; `wasmUrl` is the PDFium binary URL (a Vite `?url` import in tests). */
export async function createRedactionHarness(wasmUrl: string): Promise<RedactionHarness> {
  const wasmBinary = await (await fetch(wasmUrl)).arrayBuffer();
  const module = await init({ wasmBinary });
  const native = new PdfiumNative(module, { fontFallback: null });
  const engine = new OrchestratedEngine(native, {
    imageConverter: browserImageDataToBlobConverter,
  });
  const adapter = new PdfiumAdapter({ wasmUrl, engineFactory: () => engine });

  const engineRedact = async (
    bytes: ArrayBuffer,
    areas: readonly RedactionArea[],
  ): Promise<ArrayBuffer> => {
    const doc: PdfDocumentObject = await engine
      .openDocumentBuffer({ id: `redact-${++counter}`, content: bytes.slice(0) })
      .toPromise();
    try {
      const byPage = new Map<number, Rect[]>();
      for (const a of areas) byPage.set(a.pageIndex, [...(byPage.get(a.pageIndex) ?? []), a.rect]);
      for (const [pageIndex, rects] of byPage) {
        const page = doc.pages[pageIndex];
        if (!page) throw new Error(`no page ${pageIndex}`);
        const g = pageGeometry(page);
        for (const rect of rects) {
          const device = userToDeviceRect(g, rect);
          const annotation: PdfRedactAnnoObject = {
            id: '',
            type: PdfAnnotationSubtype.REDACT,
            pageIndex,
            rect: device,
            segmentRects: [device],
            color: 'transparent',
          };
          await engine.createPageAnnotation(doc, page, annotation).toPromise();
        }
        await engine.applyAllRedactions(doc, page).toPromise();
      }
      return await engine.saveAsCopy(doc).toPromise();
    } finally {
      await engine.closeDocument(doc).toPromise();
    }
  };

  const open = async (bytes: ArrayBuffer): Promise<OpenedForCheck> => {
    const id = `forensic-${++counter}` as SourceId;
    await adapter.open(id, bytes.slice(0));
    const deps: ForensicDeps = {
      getPageText: (pageIndex) => adapter.getPageText(id, pageIndex),
      search: (query) => adapter.search(id, query),
      renderArea: async (pageIndex, rect, scale): Promise<ForensicPixels> => {
        const { bitmap, width, height } = await adapter.renderPage(id, pageIndex, {
          scale,
          clip: rect,
          withAnnotations: true,
          withForms: true,
        });
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('no 2d context');
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        return { width, height, data: ctx.getImageData(0, 0, width, height).data };
      },
    };
    return { deps, close: () => adapter.close(id) };
  };

  return {
    adapter,
    engineRedact,
    open,
    destroy: () => adapter.destroy(),
  };
}
