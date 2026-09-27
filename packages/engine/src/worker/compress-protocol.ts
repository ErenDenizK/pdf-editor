/**
 * Wire protocol between `createCompressProxy` (caller thread) and `compress.worker.ts`:
 * qpdf (PdfPlumber), the compression pipeline and the PDF → images encoder/ZIP builder.
 * As in the assembler protocol, failures travel as values (Comlink drops
 * `EngineError.code`), progress as a Comlink proxy (released by the worker after the run)
 * and cancellation on a MessagePort.
 */
import type { SecurityPolicy } from '@pdf-editor/document-model';

import type {
  CompressionAnalysis,
  CompressionProgress,
  CompressionResult,
  CompressionSettings,
} from '../compress/types';
import type { PlumberCheckOptions, PlumberCheckResult } from '../plumber/qpdf-plumber';
import type { RasterPageSpec, RasterTile } from '../rasterize/encode-page';
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
  /** PDF 1.4-compatible output: no object streams (the export's compatibility mode). */
  readonly compatibility?: boolean;
}

export interface RasterFile {
  /** A Blob, so a large ZIP can live on disk rather than in memory. */
  readonly blob: Blob;
  /** File name (the ZIP name for several pages). */
  readonly name: string;
  readonly type: string;
}

export interface CompressWorkerApi {
  configure(config: CompressWorkerConfig): void;
  plumb(bytes: ArrayBuffer, options: WirePlumberOptions): Promise<Wire<PlumberResult>>;
  check(bytes: ArrayBuffer, options: PlumberCheckOptions): Promise<Wire<PlumberCheckResult>>;
  analyze(bytes: ArrayBuffer, password?: string): Promise<Wire<CompressionAnalysis>>;
  compress(
    bytes: ArrayBuffer,
    settings: CompressionSettings,
    options: CompressRunWireOptions,
    onProgress?: (progress: CompressionProgress) => void,
    abortPort?: MessagePort,
  ): Promise<Wire<CompressionResult>>;
  /** Starts the next page of raster job `job` (creates its canvas). */
  rasterBegin(job: string, page: RasterPageSpec): Promise<Wire<null>>;
  /** Draws one rendered tile into the current page; the bitmap is transferred and closed. */
  rasterTile(job: string, tile: RasterTile): Promise<Wire<null>>;
  /** Encodes the current page into the job's output; resolves to its encoded size. */
  rasterEnd(job: string): Promise<Wire<number>>;
  /**
   * Finishes job `job`: one page comes back as is, several as a ZIP named `zipName`. The
   * job is released either way.
   */
  rasterFinish(job: string, zipName: string): Promise<Wire<RasterFile>>;
  rasterCancel(job: string): void;
}

export const COMPRESS_ABORT_MESSAGE = 'abort';
