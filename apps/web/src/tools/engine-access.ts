/**
 * Direct access to the PDFium adapter for the document tools: full-resolution renders for
 * PDF → images and the compression "Compare" view, and scratch documents (bytes that are
 * not workspace sources). The engine service's bitmap cache is for the viewer; these
 * renders bypass it so large bitmaps never evict viewer pages.
 */
import type { SourceId } from '@pdf-editor/document-model';
import type { OpenedDocument, PdfRenderer } from '@pdf-editor/engine';

import { getEngineService } from '../engine/engine-service';

export type ToolRenderer = Pick<PdfRenderer, 'open' | 'close' | 'renderPage'>;

export async function toolRenderer(): Promise<ToolRenderer> {
  const engine = (await getEngineService().editor()) as unknown as Partial<ToolRenderer>;
  if (
    typeof engine.renderPage !== 'function' ||
    typeof engine.open !== 'function' ||
    typeof engine.close !== 'function'
  ) {
    throw new Error('The rendering engine cannot render for tools');
  }
  return engine as ToolRenderer;
}

let scratchCounter = 0;

/** A document opened from bytes for the tools; close it when done. */
export interface ScratchDocument {
  readonly id: SourceId;
  readonly document: OpenedDocument;
  close(): Promise<void>;
}

/** Opens `bytes` (transferred to the engine) as a scratch document. */
export async function openScratch(bytes: ArrayBuffer, password?: string): Promise<ScratchDocument> {
  const renderer = await toolRenderer();
  const id = `__tools:${++scratchCounter}` as SourceId;
  const document = await renderer.open(id, bytes, password === undefined ? {} : { password });
  let closed = false;
  return {
    id,
    document,
    close: async () => {
      if (closed) return;
      closed = true;
      await renderer.close(id).catch(() => undefined);
    },
  };
}
