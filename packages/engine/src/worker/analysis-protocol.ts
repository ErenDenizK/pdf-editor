/**
 * Wire protocol between `createAnalysisProxy` (caller thread) and `analysis.worker.ts`: the
 * analysis worker (spec §2.2, §4) for comparison, the comparison report and PDF → text /
 * Markdown. Pure computation: it hosts no PDFium; page text, renders and images come from
 * the caller (in the app, from the PDFium worker's proxy) as structured clones and
 * transferables. As in the other protocols, failures travel as values (Comlink drops
 * `EngineError.code`) and cancellation as a message on a transferred MessagePort.
 */
import type {
  AlignRequest,
  CompareJobHeader,
  FinishRequest,
  Side,
  VisualRequest,
} from '../analysis/backend';
import type { SliceStats } from '../analysis/scheduler';
import type { ComparisonReportOptions } from '../pdflib/compare-report';
import type {
  AnalysisRaster,
  AnalysisRgba,
  CompareFacts,
  ComparePageInput,
  ComparisonResult,
  ConvertOptions,
  ConvertPageInput,
  ConvertResult,
  EngineErrorCode,
  PagePair,
  PixelDiffResult,
  TextComparison,
} from '../types';

export type Wire<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: EngineErrorCode; readonly message: string };

/** One method per `AnalysisBackend` method; `abortPort` receives `ANALYSIS_ABORT_MESSAGE`. */
export interface AnalysisWorkerApi {
  compareBegin(job: string, header: CompareJobHeader): Promise<Wire<null>>;
  compareAddPage(
    job: string,
    side: Side,
    index: number,
    page: ComparePageInput,
  ): Promise<Wire<{ readonly needsThumbnail: boolean }>>;
  /** The raster is transferred. */
  compareAddThumbnail(
    job: string,
    side: Side,
    index: number,
    raster: AnalysisRaster,
  ): Promise<Wire<null>>;
  compareAlign(
    job: string,
    request: AlignRequest,
    abortPort?: MessagePort,
  ): Promise<Wire<readonly PagePair[]>>;
  compareSetPairs(
    job: string,
    pairs: readonly PagePair[],
    alignment: 'index' | 'best-match',
  ): Promise<Wire<null>>;
  /** Both rasters are transferred. */
  compareVisual(
    job: string,
    pair: number,
    a: AnalysisRaster,
    b: AnalysisRaster,
    request: VisualRequest,
    abortPort?: MessagePort,
  ): Promise<Wire<PixelDiffResult>>;
  compareText(
    job: string,
    scope: 'document' | 'page-pairs',
    abortPort?: MessagePort,
  ): Promise<Wire<TextComparison>>;
  compareFinish(job: string, request: FinishRequest): Promise<Wire<ComparisonResult>>;
  /** The pixels are transferred to the caller. */
  compareHeatmap(
    job: string,
    id: string,
    color?: readonly [number, number, number],
  ): Promise<Wire<AnalysisRgba>>;
  compareEnd(job: string): Promise<Wire<null>>;
  /** The bytes are transferred to the worker. */
  extractFacts(bytes: ArrayBuffer, password?: string): Promise<Wire<CompareFacts>>;
  /** The bytes are transferred both ways. */
  buildReport(
    bytes: ArrayBuffer,
    result: ComparisonResult,
    options: Omit<ComparisonReportOptions, 'now'> & { readonly now?: string },
  ): Promise<Wire<ArrayBuffer>>;
  convertBegin(job: string, options: ConvertOptions): Promise<Wire<null>>;
  /** Image bytes are transferred. */
  convertAddPage(job: string, index: number, page: ConvertPageInput): Promise<Wire<null>>;
  /** File bytes and the ZIP are transferred to the caller. */
  convertFinish(job: string, abortPort?: MessagePort): Promise<Wire<ConvertResult>>;
  convertEnd(job: string): Promise<Wire<null>>;
  stats(): Promise<Wire<SliceStats>>;
  resetStats(): Promise<Wire<null>>;
}

export const ANALYSIS_ABORT_MESSAGE = 'abort';
