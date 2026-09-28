/**
 * Wraps the analysis worker (constructed by the app) as an `AnalysisBackend`, plus the
 * orchestrated `compare` and `convert` runs that feed it from `CompareSource` /
 * `ConvertSource` (see analysis/pipeline.ts, convert/pipeline.ts).
 *
 * - Rasters (`ImageBitmap` or RGBA) and bytes are *transferred* (detached in the caller);
 *   heat maps, report bytes and converted files are transferred back.
 * - Cancellation: when the signal fires, the call rejects at once with
 *   `EngineError('aborted')` and the worker is told on a MessagePort; the orchestrators also
 *   release the job.
 * - `dispose()` terminates the worker; pending calls reject with `EngineError('aborted')`.
 */
import { releaseProxy, transfer, wrap } from 'comlink';

import type { AnalysisBackend } from '../analysis/backend';
import { compareDocuments, type CompareRun, type CompareSource } from '../analysis/pipeline';
import { abortedError } from '../analysis/scheduler';
import { convertDocument, type ConvertSource } from '../convert/pipeline';
import {
  type AnalysisRaster,
  type CompareOptions,
  type ConvertOptions,
  type ConvertPageInput,
  type ConvertResult,
  type EngineCallOptions,
  EngineError,
  type ProgressCallback,
} from '../types';
import { ANALYSIS_ABORT_MESSAGE, type AnalysisWorkerApi, type Wire } from './analysis-protocol';

export interface AnalysisProxy extends AnalysisBackend {
  /** Compares two documents (text, page map, visual and text diffs, facts). */
  compare(a: CompareSource, b: CompareSource, options?: CompareOptions): Promise<CompareRun>;
  /** Converts a document to Markdown or plain text. */
  convert(
    source: ConvertSource,
    options?: ConvertOptions &
      EngineCallOptions & {
        readonly pages?: readonly number[];
        readonly onProgress?: ProgressCallback;
      },
  ): Promise<ConvertResult>;
  /** Releases the Comlink proxy and terminates the worker. */
  dispose(): void;
}

function unwrap<T>(reply: Wire<T>): T {
  if (!reply.ok) throw new EngineError(reply.code, reply.message);
  return reply.value;
}

function rasterTransfer(raster: AnalysisRaster): Transferable {
  return typeof ImageBitmap !== 'undefined' && raster instanceof ImageBitmap
    ? raster
    : ((raster as { data: Uint8ClampedArray }).data.buffer as ArrayBuffer);
}

function pageTransfers(page: ConvertPageInput): Transferable[] {
  const buffers = new Set<ArrayBuffer>();
  for (const image of page.images ?? []) {
    for (const view of [image.png, image.jpeg, image.rgba?.data]) {
      if (view && view.buffer instanceof ArrayBuffer) buffers.add(view.buffer);
    }
  }
  return [...buffers];
}

export function createAnalysisProxy(worker: Worker): AnalysisProxy {
  const remote = wrap<AnalysisWorkerApi>(worker);
  let terminated = false;
  const pending = new Set<(error: EngineError) => void>();

  /** One worker call, rejecting at once when `signal` fires (and telling the worker). */
  function invoke<T>(
    op: string,
    signal: AbortSignal | undefined,
    start: (abortPort: MessagePort | undefined) => Promise<Wire<T>>,
  ): Promise<T> {
    if (terminated) {
      return Promise.reject(new EngineError('internal', `${op}: the analysis worker was disposed`));
    }
    if (signal?.aborted) return Promise.reject(abortedError(op, signal.reason));
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let channel: MessageChannel | undefined;
      let onAbort: (() => void) | undefined;
      const finish = (): boolean => {
        if (settled) return false;
        settled = true;
        pending.delete(kill);
        if (onAbort) signal?.removeEventListener('abort', onAbort);
        channel?.port1.close();
        return true;
      };
      const kill = (error: EngineError): void => {
        if (finish()) reject(error);
      };
      pending.add(kill);
      if (signal) {
        channel = new MessageChannel();
        const port = channel.port1;
        onAbort = () => {
          port.postMessage(ANALYSIS_ABORT_MESSAGE);
          if (finish()) reject(abortedError(op, signal.reason));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
      start(channel?.port2).then(
        (reply) => {
          if (!finish()) return;
          try {
            resolve(unwrap(reply));
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        },
        (error: unknown) => {
          if (finish()) reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  const port = (abortPort: MessagePort | undefined) =>
    abortPort ? transfer(abortPort, [abortPort]) : undefined;

  const backend: AnalysisBackend = {
    compareBegin: (job, header) =>
      invoke('compare', undefined, () => remote.compareBegin(job, header)).then(() => undefined),
    compareAddPage: (job, side, index, page) =>
      invoke('compare', undefined, () => remote.compareAddPage(job, side, index, page)),
    compareAddThumbnail: (job, side, index, raster) =>
      invoke('compare', undefined, () =>
        remote.compareAddThumbnail(job, side, index, transfer(raster, [rasterTransfer(raster)])),
      ).then(() => undefined),
    compareAlign: (job, request, options) =>
      invoke('align', options?.signal, (abortPort) =>
        remote.compareAlign(job, request, port(abortPort)),
      ),
    compareSetPairs: (job, pairs, alignment) =>
      invoke('compare', undefined, () => remote.compareSetPairs(job, pairs, alignment)).then(
        () => undefined,
      ),
    compareVisual: (job, pair, a, b, request, options) =>
      invoke('visual diff', options?.signal, (abortPort) => {
        const transfers = [rasterTransfer(a), rasterTransfer(b), ...(abortPort ? [abortPort] : [])];
        // One transfer list for the whole call: Comlink merges the lists of its arguments.
        return remote.compareVisual(job, pair, transfer(a, transfers), b, request, abortPort);
      }),
    compareText: (job, scope, options) =>
      invoke('text diff', options?.signal, (abortPort) =>
        remote.compareText(job, scope, port(abortPort)),
      ),
    compareFinish: (job, request) =>
      invoke('compare', undefined, () => remote.compareFinish(job, request)),
    compareHeatmap: (job, id, color) =>
      invoke('heat map', undefined, () => remote.compareHeatmap(job, id, color)),
    compareEnd: (job) =>
      invoke('compare', undefined, () => remote.compareEnd(job)).then(() => undefined),
    extractFacts: (bytes, password) =>
      invoke('facts', undefined, () => remote.extractFacts(transfer(bytes, [bytes]), password)),
    buildReport: (bytes, result, options = {}) => {
      const { now, ...rest } = options;
      return invoke('report', undefined, () =>
        remote.buildReport(transfer(bytes, [bytes]), result, {
          ...rest,
          ...(now === undefined ? {} : { now: now.toISOString() }),
        }),
      );
    },
    convertBegin: (job, options) =>
      invoke('convert', undefined, () => remote.convertBegin(job, options)).then(() => undefined),
    convertAddPage: (job, index, page) =>
      invoke('convert', undefined, () =>
        remote.convertAddPage(job, index, transfer(page, pageTransfers(page))),
      ).then(() => undefined),
    convertFinish: (job, options) =>
      invoke('convert', options?.signal, (abortPort) => remote.convertFinish(job, port(abortPort))),
    convertEnd: (job) =>
      invoke('convert', undefined, () => remote.convertEnd(job)).then(() => undefined),
    stats: () => invoke('stats', undefined, () => remote.stats()),
    resetStats: () => invoke('stats', undefined, () => remote.resetStats()).then(() => undefined),
  };

  return {
    ...backend,
    compare: (a, b, options) => compareDocuments(backend, a, b, options),
    convert: (source, options) => convertDocument(backend, source, options),
    dispose() {
      if (terminated) return;
      terminated = true;
      for (const kill of [...pending])
        kill(new EngineError('aborted', 'The analysis worker was disposed'));
      remote[releaseProxy]();
      worker.terminate();
    },
  };
}
