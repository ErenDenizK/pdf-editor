/**
 * The app's compress worker: qpdf (repair, lossless rewrite, check), the compression
 * pipeline and the PDF → images encoder. One long-lived worker, created on first use.
 * This module is only ever imported dynamically, so the worker and both wasm files stay
 * out of the entry chunk (they load when a tool first needs them).
 */
import pdfiumWasmUrl from '@embedpdf/pdfium/pdfium.wasm?url';
import CompressWorker from '@pdf-editor/engine/compress.worker?worker';
import qpdfWasmUrl from '@pdf-editor/engine/qpdf.wasm?url';
import type { CompressProxy } from '@pdf-editor/engine';

let shared: Promise<CompressProxy> | undefined;

export function getCompressor(): Promise<CompressProxy> {
  if (shared === undefined) {
    const created = import('@pdf-editor/engine').then(({ createCompressProxy }) =>
      createCompressProxy(new CompressWorker({ name: 'pdf-editor compress' }), {
        qpdfWasmUrl,
        pdfiumWasmUrl,
      }),
    );
    created.catch(() => {
      if (shared === created) shared = undefined;
    });
    shared = created;
  }
  return shared;
}

/** Terminates the worker (tests, teardown). */
export async function disposeCompressor(): Promise<void> {
  const current = shared;
  shared = undefined;
  (await current)?.dispose();
}
