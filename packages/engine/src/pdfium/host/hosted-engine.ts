/**
 * The PDFium host (ADR-0011): the raw module from `@embedpdf/pdfium`, EmbedPDF's executor
 * (`PdfiumNative`) and orchestrator (`PdfEngine`) on the calling thread, plus the one sanctioned
 * way to reach the module directly while the orchestrator is live (`withRawAccess`).
 *
 * In the app this runs inside `worker/pdfium.worker.ts`; tests may run it on the page.
 *
 * Why raw edits are tasks on the orchestrator's own queue (and not "await idle + lock"):
 * `PdfEngine` puts every call on one private `WorkerTaskQueue` with concurrency 1, sorted by
 * priority. A task starts synchronously inside `enqueue` when the queue is free, and batch
 * tasks (search, annotation batches) do their PDFium work in a microtask after they start.
 * Waiting for `drain()` and then running leaves a gap in which a newly enqueued task starts
 * first; nothing short of holding the queue's single slot keeps the orchestrator out. So a
 * raw edit is enqueued as a task (priority CRITICAL, like renders) whose completion is the
 * edit's completion: while it runs, no orchestrator task for any document runs, including
 * tasks that callers abandoned (an aborted render keeps running in PDFium until it ends; the
 * edit waits for it). The per-source `SourceLocks` adds what the queue cannot: adapter calls
 * made of several tasks finish before the edit and do not see half of it.
 *
 * Consequence for `fn` passed to `withRawAccess`: it must not await `PdfEngine`/adapter calls
 * (they queue behind the slot `fn` holds, a deadlock). Do the reads it needs with raw calls on
 * a fresh text page, or before/after the raw access.
 */
import {
  browserImageDataToBlobConverter,
  type FontFallbackConfig,
  type ImageDataConverter,
  PdfEngine,
  PdfiumNative,
} from '@embedpdf/engines';
import { type Logger, PdfErrorCode, type PdfErrorReason, Task } from '@embedpdf/models';
import { init, type WrappedPdfiumModule } from '@embedpdf/pdfium';

import { EngineError } from '../../types';
import { abortedError } from '../task-bridge';
import { docContext, orchestratorQueue, type RawDocContext } from './doc-context';
import { PdfiumMemory } from './memory';
import { SourceLocks } from './source-lock';

/** EmbedPDF's `Priority.CRITICAL` (the enum is not exported): the priority of renders. */
const RAW_TASK_PRIORITY = 3;

export interface HostedEngineOptions {
  /** `pdfium.wasm`: a URL (relative URLs resolve against `location`) or its bytes. */
  readonly wasm: string | ArrayBuffer;
  /**
   * Fallback fonts for non-embedded text; `null`/omitted disables fallback (no network
   * requests, as in `PdfiumAdapterOptions.fontFallback`).
   */
  readonly fontFallback?: FontFallbackConfig | null;
  readonly logger?: Logger;
  /** Share an existing lock table (e.g. one created before the engine was initialised). */
  readonly locks?: SourceLocks;
}

/** What `withRawAccess` hands to its callback. Valid only while the callback runs. */
export interface RawAccess {
  readonly module: WrappedPdfiumModule;
  readonly memory: PdfiumMemory;
  readonly native: PdfiumNative;
  readonly sourceId: string;
  /** The source's `FPDF_DOCUMENT` context (guarded private access). */
  readonly doc: RawDocContext;
  readonly docPtr: number;
  /**
   * Closes the executor's cached `FPDF_PAGE`/`FPDF_TEXTPAGE` for `pageIndex` so the next
   * render or text read reloads the page. Call after `FPDFPage_GenerateContent` (and after
   * abandoning uncommitted object edits); any `RawPageContext` of that page is dead afterwards.
   */
  dropPageCache(pageIndex: number): void;
}

export interface RawAccessOptions {
  /**
   * Withdraws the request while it waits for the lock or the queue. Once the callback has
   * started it runs to completion and its result is returned: an edit that happened is never
   * reported as aborted.
   */
  readonly signal?: AbortSignal;
}

export interface HostedEngine {
  /** The orchestrator: pass it to `PdfiumAdapter` as `engineFactory: () => engine`. */
  readonly engine: PdfEngine;
  /** The executor (owns the document and page caches). */
  readonly native: PdfiumNative;
  /** The raw module with every `FPDF_*`/`EPDF_*` function. */
  readonly module: WrappedPdfiumModule;
  readonly memory: PdfiumMemory;
  readonly locks: SourceLocks;
  /** Guarded `docContext` for an open source (see doc-context.ts). */
  docContext(sourceId: string): RawDocContext;
  /**
   * Runs an orchestrated (adapter) operation on `sourceId` under the shared lock, so raw
   * edits never land between its tasks.
   */
  withEngineAccess<R>(
    sourceId: string,
    fn: () => R | Promise<R>,
    options?: RawAccessOptions,
  ): Promise<R>;
  /**
   * Runs `fn` with raw access to `sourceId`: exclusive per source, and as a task on the
   * orchestrator's queue so no EmbedPDF task runs meanwhile. Calls on one source run in order.
   * `fn` must not await engine or adapter calls (see the module comment).
   */
  withRawAccess<R>(
    sourceId: string,
    fn: (raw: RawAccess) => R | Promise<R>,
    options?: RawAccessOptions,
  ): Promise<R>;
  /**
   * Runs `fn` with raw access to `sourceId` as one task on the orchestrator's queue (no
   * EmbedPDF task runs meanwhile) **without** taking the source's lock: for an adapter call
   * that already holds it (shared; the lock is not re-entrant, so `withRawAccess` from there
   * would wait for itself). Only for raw work that leaves the document whole for every other
   * adapter call, whatever task it runs between: reads, or one self-contained annotation write
   * (the adapter's variable-width ink, ADR-0018). Edits made of several steps use
   * `withRawAccess`. `fn` must not await engine or adapter calls.
   */
  withRawTask<R>(
    sourceId: string,
    fn: (raw: RawAccess) => R | Promise<R>,
    options?: RawAccessOptions,
  ): Promise<R>;
  /**
   * The executor's `disposeImmediate` on the page's cached context. Only inside
   * `withRawAccess` (or `raw.dropPageCache`), after a raw edit.
   */
  dropPageCache(sourceId: string, pageIndex: number): void;
}

/** Fetches (for a URL) and instantiates `pdfium.wasm`. Single-threaded, no CDN. */
export async function initPdfiumModule(wasm: string | ArrayBuffer): Promise<WrappedPdfiumModule> {
  let wasmBinary: ArrayBuffer;
  if (typeof wasm === 'string') {
    const base = (globalThis as { location?: { href: string } }).location?.href;
    const url = base === undefined ? wasm : new URL(wasm, base).href;
    const response = await fetch(url);
    if (!response.ok) {
      throw new EngineError('internal', `Could not load pdfium.wasm (HTTP ${response.status})`);
    }
    wasmBinary = await response.arrayBuffer();
  } else {
    wasmBinary = wasm;
  }
  return init({ wasmBinary });
}

/**
 * EmbedPDF's `browserImageDataToBlobConverter` needs `document`, which workers lack. Only
 * encoded renders use the converter (the adapter renders raw), but keep them working in a
 * worker through `OffscreenCanvas`.
 */
export const imageDataToBlobConverter: ImageDataConverter = (
  getImageData,
  imageType = 'image/png',
  quality,
) => {
  if (imageType === 'image/bmp' || typeof OffscreenCanvas === 'undefined') {
    return browserImageDataToBlobConverter(getImageData, imageType, quality);
  }
  const image = getImageData();
  const canvas = new OffscreenCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  if (!context) return Promise.reject(new Error('OffscreenCanvas 2D context is unavailable'));
  context.putImageData(
    new ImageData(new Uint8ClampedArray(image.data), image.width, image.height),
    0,
    0,
  );
  return canvas.convertToBlob(
    quality === undefined ? { type: imageType } : { type: imageType, quality },
  );
};

/**
 * Creates the hosted engine: `init` + `PdfiumNative` + `PdfEngine`, exactly as EmbedPDF's
 * `createPdfiumDirectEngine` does, with font fallback off by default.
 */
export async function createHostedEngine(options: HostedEngineOptions): Promise<HostedEngine> {
  const module = await initPdfiumModule(options.wasm);
  const native = new PdfiumNative(module, {
    fontFallback: options.fontFallback ?? null,
    ...(options.logger ? { logger: options.logger } : {}),
  });
  const engine = new PdfEngine(native, {
    imageConverter: imageDataToBlobConverter,
    ...(options.logger ? { logger: options.logger } : {}),
  });
  // Fail at creation, not at the first edit, if the orchestrator's layout changed.
  const queue = orchestratorQueue(engine);
  const memory = new PdfiumMemory(module);
  const locks = options.locks ?? new SourceLocks();

  const dropPageCache = (sourceId: string, pageIndex: number): void => {
    docContext(native, sourceId).acquirePage(pageIndex).disposeImmediate();
  };

  const runOnQueue = <R>(
    sourceId: string,
    fn: (raw: RawAccess) => R | Promise<R>,
    signal: AbortSignal | undefined,
  ): Promise<R> =>
    new Promise<R>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortedError('raw access', signal.reason));
        return;
      }
      let started = false;
      let onAbort: (() => void) | undefined;
      const slot = queue.enqueue(
        {
          execute: () => {
            started = true;
            if (onAbort) signal?.removeEventListener('abort', onAbort);
            const done = new Task<boolean, PdfErrorReason>();
            void (async () => {
              try {
                const doc = docContext(native, sourceId);
                resolve(
                  await fn({
                    module,
                    memory,
                    native,
                    sourceId,
                    doc,
                    docPtr: doc.docPtr,
                    dropPageCache: (pageIndex) => {
                      dropPageCache(sourceId, pageIndex);
                    },
                  }),
                );
              } catch (error) {
                reject(error instanceof Error ? error : new Error(String(error)));
              } finally {
                done.resolve(true);
              }
            })();
            return done;
          },
          meta: { docId: sourceId, operation: 'rawAccess' },
        },
        { priority: RAW_TASK_PRIORITY },
      );
      if (!started && signal) {
        onAbort = () => {
          if (started) return;
          slot.abort({ code: PdfErrorCode.Cancelled, message: 'raw access aborted by caller' });
          reject(abortedError('raw access', signal.reason));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });

  return {
    engine,
    native,
    module,
    memory,
    locks,
    docContext: (sourceId) => docContext(native, sourceId),
    withEngineAccess: (sourceId, fn, callOptions = {}) =>
      locks.run(sourceId, 'shared', fn, callOptions.signal),
    withRawAccess: (sourceId, fn, callOptions = {}) =>
      locks.run(
        sourceId,
        'exclusive',
        () => runOnQueue(sourceId, fn, callOptions.signal),
        callOptions.signal,
      ),
    withRawTask: (sourceId, fn, callOptions = {}) => runOnQueue(sourceId, fn, callOptions.signal),
    dropPageCache,
  };
}
