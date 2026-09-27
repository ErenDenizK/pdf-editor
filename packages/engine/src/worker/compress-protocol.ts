/**
 * Wire protocol between `createCompressProxy` (caller thread) and `compress.worker.ts`:
 * qpdf (PdfPlumber), the compression pipeline and the PDF → images encoder/ZIP builder.
 * As in the assembler protocol, failures travel as values (Comlink drops
 * `EngineError.code`), progress as a Comlink proxy and cancellation on a MessagePort.
 */
import type { SecurityPolicy } from '@pdf-editor/document-model';

import type {
  CompressionAnalysis,
  CompressionProgress,
  CompressionResult,
  CompressionSettings,
} from '../compress/types';
import type { PlumberCheckResult } from '../plumber/qpdf-plumber';
import type { RasterPageInput } from '../rasterize/encode-page';
import type { EngineErrorCode, PlumberOptions, PlumberResult } from '../types';

export interface CompressWorkerConfig {
  /** URL of qpdf.wasm (packages/engine/qpdf/dist). */
  readonly qpdfWasmUrl: string;
  /** URL of pdfium.wasm (the same file the viewer uses). */
  readonly pdfiumWasmUrl: string;
}

export type WirePlumberOptions = Omit<PlumberOptions, 'signal' | 'priority'> & {
  readonly password?: string;
};

export type Wire<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: EngineErrorCode; readonly message: string };

export interface CompressRunWireOptions {
  readonly password?: string;
  readonly encrypt?: SecurityPolicy;
}

export interface RasterFile {
  readonly bytes: ArrayBuffer;
  /** File name (ZIP name for several pages). */
  readonly name: string;
  readonly type: string;
}

export interface CompressWorkerApi {
  configure(config: CompressWorkerConfig): void;
  plumb(bytes: ArrayBuffer, options: WirePlumberOptions): Promise<Wire<PlumberResult>>;
  check(bytes: ArrayBuffer, password?: string): Promise<Wire<PlumberCheckResult>>;
  analyze(bytes: ArrayBuffer, password?: string): Promise<Wire<CompressionAnalysis>>;
  compress(
    bytes: ArrayBuffer,
    settings: CompressionSettings,
    options: CompressRunWireOptions,
    onProgress?: (progress: CompressionProgress) => void,
    abortPort?: MessagePort,
  ): Promise<Wire<CompressionResult>>;
  /** Encodes one page into raster job `job`; resolves to the encoded size. */
  rasterAdd(job: string, page: RasterPageInput): Promise<Wire<number>>;
  /**
   * Finishes job `job`: one page comes back as is, several as a ZIP named `zipName`.
   * The job's buffers are released either way.
   */
  rasterFinish(job: string, zipName: string): Promise<Wire<RasterFile>>;
  rasterCancel(job: string): void;
}

export const COMPRESS_ABORT_MESSAGE = 'abort';
