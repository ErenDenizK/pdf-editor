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
import type { PlumberCheckOptions, PlumberCheckResult } from '../plumber/qpdf-plumber';
import type { RasterPageSpec, RasterTile } from '../rasterize/encode-page';
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
  /**
   * Structural check for diagnostics (cheap by default, `thorough` = `qpdf --check`).
   * Never rejects on damage.
   */
  check(bytes: ArrayBuffer, options?: PlumberCheckOptions): Promise<PlumberCheckResult>;
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
  rasterBegin(job: string, page: RasterPageSpec): Promise<void>;
  /** The tile's bitmap is transferred (and closed in the worker once drawn). */
  rasterTile(job: string, tile: RasterTile): Promise<void>;
  rasterEnd(job: string): Promise<number>;
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
    async check(bytes, options = {}) {
      await ready;
      return unwrap(await remote.check(transfer(bytes, [bytes]), options));
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
        onAbort = () => {
          port.postMessage(COMPRESS_ABORT_MESSAGE);
        };
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
    async rasterBegin(job, page) {
      await ready;
      unwrap(await remote.rasterBegin(job, page));
    },
    async rasterTile(job, tile) {
      await ready;
      unwrap(await remote.rasterTile(job, transfer(tile, [tile.bitmap])));
    },
    async rasterEnd(job) {
      await ready;
      return unwrap(await remote.rasterEnd(job));
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
