/**
 * Wraps the compress Worker (constructed by the app) as a `PdfPlumber` plus the
 * compression and PDF → images operations. Input ArrayBuffers are *transferred* (detached
 * in the caller); pass copies when the caller still needs them. Tile bitmaps are
 * transferred too.
 */
import { proxy, releaseProxy, transfer, wrap } from 'comlink';

import type {
  CompressionAnalysis,
  CompressionProgress,
  CompressionResult,
  CompressionSettings,
} from '../compress/types';
import type { PlumberCheckResult } from '../plumber/qpdf-plumber';
import type { RasterPageInput } from '../rasterize/encode-page';
import {
  type EngineCallOptions,
  EngineError,
  type PdfPlumber,
  type PlumberOptions,
  type PlumberResult,
} from '../types';
import {
  COMPRESS_ABORT_MESSAGE,
  type CompressRunWireOptions,
  type CompressWorkerApi,
  type CompressWorkerConfig,
  type RasterFile,
  type Wire,
} from './compress-protocol';

export interface CompressProxy extends PdfPlumber {
  process(
    bytes: ArrayBuffer,
    options?: PlumberOptions & { readonly password?: string },
  ): Promise<PlumberResult>;
  /** `qpdf --check`: structural warnings for diagnostics. Never rejects on damage. */
  check(bytes: ArrayBuffer, password?: string): Promise<PlumberCheckResult>;
  analyze(
    bytes: ArrayBuffer,
    options?: { readonly password?: string },
  ): Promise<CompressionAnalysis>;
  compress(
    bytes: ArrayBuffer,
    settings: CompressionSettings,
    options?: CompressRunWireOptions & {
      readonly signal?: AbortSignal;
      readonly onProgress?: (progress: CompressionProgress) => void;
    },
  ): Promise<CompressionResult>;
  rasterAdd(job: string, page: RasterPageInput): Promise<number>;
  rasterFinish(job: string, zipName: string): Promise<RasterFile>;
  rasterCancel(job: string): void;
  dispose(): void;
}

function unwrap<T>(reply: Wire<T>): T {
  if (!reply.ok) throw new EngineError(reply.code, reply.message);
  return reply.value;
}

function checkAborted(options: EngineCallOptions | undefined, what: string): void {
  if (options?.signal?.aborted) {
    throw new EngineError('aborted', `${what} aborted`, { cause: options.signal.reason });
  }
}

export function createCompressProxy(worker: Worker, config: CompressWorkerConfig): CompressProxy {
  const remote = wrap<CompressWorkerApi>(worker);
  const ready = remote.configure(config);
  return {
    async process(bytes, options = {}) {
      checkAborted(options, 'qpdf');
      const { signal: _signal, priority: _priority, ...wire } = options;
      await ready;
      return unwrap(await remote.plumb(transfer(bytes, [bytes]), wire));
    },
    async check(bytes, password) {
      await ready;
      return unwrap(await remote.check(transfer(bytes, [bytes]), password));
    },
    async analyze(bytes, options = {}) {
      await ready;
      return unwrap(await remote.analyze(transfer(bytes, [bytes]), options.password));
    },
    async compress(bytes, settings, options = {}) {
      const { signal, onProgress, ...wire } = options;
      checkAborted(options, 'Compression');
      await ready;
      let channel: MessageChannel | undefined;
      let onAbort: (() => void) | undefined;
      if (signal) {
        channel = new MessageChannel();
        const port = channel.port1;
        onAbort = () => port.postMessage(COMPRESS_ABORT_MESSAGE);
        signal.addEventListener('abort', onAbort, { once: true });
      }
      try {
        const transferables: Transferable[] = [bytes];
        if (channel) transferables.push(channel.port2);
        return unwrap(
          await remote.compress(
            transfer(bytes, transferables),
            settings,
            wire,
            onProgress ? proxy(onProgress) : undefined,
            channel?.port2,
          ),
        );
      } finally {
        if (onAbort) signal?.removeEventListener('abort', onAbort);
        channel?.port1.close();
      }
    },
    async rasterAdd(job, page) {
      await ready;
      return unwrap(
        await remote.rasterAdd(
          job,
          transfer(
            page,
            page.tiles.map((t) => t.bitmap),
          ),
        ),
      );
    },
    async rasterFinish(job, zipName) {
      await ready;
      return unwrap(await remote.rasterFinish(job, zipName));
    },
    rasterCancel(job) {
      void remote.rasterCancel(job);
    },
    dispose() {
      remote[releaseProxy]();
      worker.terminate();
    },
  };
}
