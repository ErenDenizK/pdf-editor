/**
 * Analysis worker entry (spec §2.2, §4): comparison (page alignment, pixel and text diffs,
 * facts), the comparison report (pdf-lib) and PDF → Markdown / text. Pure JavaScript, no
 * PDFium: the app's PDFium worker renders and extracts, and the caller forwards pages here
 * (`compareDocuments`, `convertDocument`). Long computations are sliced (analysis/
 * scheduler.ts) so abort messages and new requests are read between slices.
 *
 * The app constructs it (bundler-specific), e.g. with Vite:
 * `import AnalysisWorker from '@pdf-editor/engine/analysis.worker?worker'`, and wraps it with
 * `createAnalysisProxy`. It is loaded only when a comparison or conversion starts.
 */
import { expose, transfer } from 'comlink';

import { AnalysisCore } from '../analysis/backend';
import { resetSliceStats, sliceStats } from '../analysis/scheduler';
import { EngineError, type ConvertResult } from '../types';
import { ANALYSIS_ABORT_MESSAGE, type AnalysisWorkerApi, type Wire } from './analysis-protocol';

const core = new AnalysisCore();

function failure(error: unknown): Wire<never> {
  if (error instanceof EngineError) return { ok: false, code: error.code, message: error.message };
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    code: error instanceof RangeError || /memory/i.test(message) ? 'out-of-memory' : 'internal',
    message,
  };
}

const ok = <T>(value: T): Wire<T> => ({ ok: true, value });

/** Runs one call; `abortPort` aborts it; `transferables` go back with the value. */
async function call<T>(
  abortPort: MessagePort | undefined,
  fn: (signal: AbortSignal | undefined) => T | Promise<T>,
  transferables?: (value: T) => Transferable[],
): Promise<Wire<T>> {
  let signal: AbortSignal | undefined;
  if (abortPort) {
    const controller = new AbortController();
    abortPort.onmessage = (event: MessageEvent) => {
      if (event.data === ANALYSIS_ABORT_MESSAGE) controller.abort();
    };
    signal = controller.signal;
  }
  try {
    const value = await fn(signal);
    return transferables ? transfer(ok(value), transferables(value)) : ok(value);
  } catch (error) {
    return failure(error);
  } finally {
    abortPort?.close();
  }
}

function resultBuffers(result: ConvertResult): Transferable[] {
  const buffers = new Set<ArrayBuffer>();
  for (const f of result.files) buffers.add(f.bytes.buffer as ArrayBuffer);
  if (result.zip) buffers.add(result.zip.buffer as ArrayBuffer);
  return [...buffers];
}

const api: AnalysisWorkerApi = {
  compareBegin: (job, header) =>
    call(undefined, () => {
      core.compareBegin(job, header);
      return null;
    }),
  compareAddPage: (job, side, index, page) =>
    call(undefined, () => core.compareAddPage(job, side, index, page)),
  compareAddThumbnail: (job, side, index, raster) =>
    call(undefined, () => {
      core.compareAddThumbnail(job, side, index, raster);
      return null;
    }),
  compareAlign: (job, request, abortPort) =>
    call(abortPort, (signal) => core.compareAlign(job, request, signal)),
  compareSetPairs: (job, pairs, alignment) =>
    call(undefined, () => {
      core.compareSetPairs(job, pairs, alignment);
      return null;
    }),
  compareVisual: (job, pair, a, b, request, abortPort) =>
    call(abortPort, (signal) => core.compareVisual(job, pair, a, b, request, signal)),
  compareText: (job, scope, abortPort) =>
    call(abortPort, (signal) => core.compareText(job, scope, signal)),
  compareFinish: (job, request) => call(undefined, () => core.compareFinish(job, request)),
  compareHeatmap: (job, id, color) =>
    call(
      undefined,
      () => core.compareHeatmap(job, id, color),
      (image) => [image.data.buffer as ArrayBuffer],
    ),
  compareEnd: (job) =>
    call(undefined, () => {
      core.compareEnd(job);
      return null;
    }),
  extractFacts: (bytes, password) => call(undefined, () => core.extractFacts(bytes, password)),
  buildReport: (bytes, result, options) =>
    call(
      undefined,
      () => {
        const { now, ...rest } = options;
        return core.buildReport(bytes, result, {
          ...rest,
          ...(now === undefined ? {} : { now: new Date(now) }),
        });
      },
      (out) => [out],
    ),
  convertBegin: (job, options) =>
    call(undefined, () => {
      core.convertBegin(job, options);
      return null;
    }),
  convertAddPage: (job, index, page) =>
    call(undefined, () => {
      core.convertAddPage(job, index, page);
      return null;
    }),
  convertFinish: (job, abortPort) =>
    call(abortPort, (signal) => core.convertFinish(job, signal), resultBuffers),
  convertEnd: (job) =>
    call(undefined, () => {
      core.convertEnd(job);
      return null;
    }),
  stats: () => call(undefined, () => sliceStats()),
  resetStats: () =>
    call(undefined, () => {
      resetSliceStats();
      return null;
    }),
};

expose(api);
