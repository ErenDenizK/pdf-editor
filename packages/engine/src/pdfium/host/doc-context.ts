/**
 * Guarded access to EmbedPDF's private executor and orchestrator state (ADR-0011 §2).
 *
 * `PdfiumNative.cache` (documents and their 5-second page cache) and `PdfEngine.workerQueue`
 * (the orchestrator's task queue) are private in the type definitions but stable in the
 * pinned build. Every access goes through this file and checks the shape it relies on, so an
 * EmbedPDF update that changes the layout fails loudly here (and in `host.test.ts`) instead
 * of corrupting a document.
 */
import type { PdfEngine, PdfiumNative } from '@embedpdf/engines';

import { EngineError } from '../../types';

/**
 * The `@embedpdf/*` version whose private layout this file was written against. The canary
 * test checks it against packages/engine/package.json; bump both together, after the
 * canaries pass on the new version.
 */
export const PINNED_EMBEDPDF_VERSION = '2.15.1';

/** A cached `FPDF_PAGE` (EmbedPDF's `PageContext`). */
export interface RawPageContext {
  readonly pagePtr: number;
  /** The cached `FPDF_TEXTPAGE`; stale after a raw edit (use a fresh `FPDFText_LoadPage`). */
  getTextPage(): number;
  /** Drops this reference; the page stays cached for the executor's TTL. */
  release(): void;
  /** Closes the page (and its text page) now, whatever its reference count. */
  disposeImmediate(): void;
}

/** An open `FPDF_DOCUMENT` (EmbedPDF's `DocumentContext`). */
export interface RawDocContext {
  readonly docPtr: number;
  /** Loads or reuses the cached page; pair with `release()` or `disposeImmediate()`. */
  acquirePage(pageIndex: number): RawPageContext;
}

function layoutError(what: string): EngineError {
  return new EngineError(
    'internal',
    `EmbedPDF private layout changed: ${what}. The PDFium host is written against ` +
      `@embedpdf/engines ${PINNED_EMBEDPDF_VERSION} (pinned); see ADR-0011 and ` +
      'packages/engine/src/pdfium/host/doc-context.ts.',
  );
}

interface CacheLike {
  getContext(docId: string): unknown;
}

function executorCache(native: PdfiumNative): CacheLike {
  const cache = (native as unknown as { cache?: { getContext?: unknown } }).cache;
  if (typeof cache?.getContext !== 'function') {
    throw layoutError('PdfiumNative.cache.getContext is missing');
  }
  return cache as CacheLike;
}

function checkedPage(page: unknown): RawPageContext {
  const p = page as Partial<RawPageContext> | undefined;
  if (
    !p ||
    typeof p.pagePtr !== 'number' ||
    typeof p.getTextPage !== 'function' ||
    typeof p.release !== 'function' ||
    typeof p.disposeImmediate !== 'function'
  ) {
    throw layoutError('PageContext has no pagePtr/getTextPage/release/disposeImmediate');
  }
  return p as RawPageContext;
}

/**
 * The executor's context for `sourceId` (the adapter's `SourceId` is EmbedPDF's document
 * id). Throws `EngineError('internal')` naming the pinned version when the private layout
 * is not what this code expects, and a plain "not open" error when the document is not open.
 */
export function docContext(native: PdfiumNative, sourceId: string): RawDocContext {
  const ctx = executorCache(native).getContext(sourceId) as
    | { docPtr?: unknown; acquirePage?: unknown }
    | undefined;
  if (ctx === undefined) {
    throw new EngineError('internal', `Source ${sourceId} is not open in the PDFium host`);
  }
  if (typeof ctx.docPtr !== 'number' || typeof ctx.acquirePage !== 'function') {
    throw layoutError('DocumentContext has no docPtr/acquirePage');
  }
  const acquire = ctx.acquirePage as (pageIndex: number) => unknown;
  const docPtr = ctx.docPtr;
  return {
    docPtr,
    acquirePage(pageIndex: number): RawPageContext {
      return checkedPage(acquire.call(ctx, pageIndex));
    },
  };
}

/** Whether `sourceId` is open in the executor (no layout check beyond the cache itself). */
export function isOpenInExecutor(native: PdfiumNative, sourceId: string): boolean {
  return executorCache(native).getContext(sourceId) !== undefined;
}

/** What the host uses of the orchestrator's private `WorkerTaskQueue`. */
export interface OrchestratorQueue {
  /** `T` is an EmbedPDF `Task` (the queue only calls `wait`, `onProgress`, `toPromise`). */
  enqueue<T>(
    taskDef: { execute: () => T; meta?: Record<string, unknown> },
    options?: { priority?: number },
  ): T;
  isIdle(): boolean;
}

/**
 * `PdfEngine.workerQueue`: one queue per engine, concurrency 1, every orchestrator call is a
 * task on it (renders, text, annotations, save, open, close).
 */
export function orchestratorQueue(engine: PdfEngine): OrchestratorQueue {
  const queue = (engine as unknown as { workerQueue?: Partial<OrchestratorQueue> }).workerQueue;
  if (typeof queue?.enqueue !== 'function' || typeof queue.isIdle !== 'function') {
    throw layoutError('PdfEngine.workerQueue.enqueue/isIdle is missing');
  }
  return queue as OrchestratorQueue;
}
