/**
 * The analysis operations as one interface (`AnalysisBackend`), implemented twice: by the
 * analysis worker's proxy (`createAnalysisProxy`, the app's path) and on the calling thread
 * (`createLocalAnalysisBackend`: tests, tools). Both run the same `AnalysisCore`. The
 * orchestrators (`compareDocuments`, `convertDocument`) only talk to this interface, so the
 * data can come from anywhere: the PDFium worker's proxy, an adapter, or files.
 */
import { buildComparisonReport, type ComparisonReportOptions } from '../pdflib/compare-report';
import { ConvertSession } from '../convert/convert';
import {
  type AnalysisRaster,
  type AnalysisRgba,
  type CompareFacts,
  type ComparePageInput,
  type ComparisonResult,
  type ConvertOptions,
  type ConvertPageInput,
  type ConvertResult,
  type EngineCallOptions,
  EngineError,
  type PagePair,
  type PixelDiffResult,
  type TextComparison,
} from '../types';
import {
  type AlignRequest,
  type CompareJobHeader,
  ComparisonSession,
  type FinishRequest,
  type Side,
  type VisualRequest,
} from './comparison';
import { extractCompareFacts } from './facts';
import { resetSliceStats, type SliceStats, Slicer, sliceStats } from './scheduler';

export type { AlignRequest, CompareJobHeader, FinishRequest, Side, VisualRequest };

export interface AnalysisBackend {
  compareBegin(job: string, header: CompareJobHeader): Promise<void>;
  /** Adds a page's geometry and text; says whether alignment will need its thumbnail. */
  compareAddPage(
    job: string,
    side: Side,
    index: number,
    page: ComparePageInput,
  ): Promise<{ readonly needsThumbnail: boolean }>;
  /** The raster (any size; reduced to 32×32 grey) is transferred. */
  compareAddThumbnail(
    job: string,
    side: Side,
    index: number,
    raster: AnalysisRaster,
  ): Promise<void>;
  compareAlign(
    job: string,
    request: AlignRequest,
    options?: EngineCallOptions,
  ): Promise<readonly PagePair[]>;
  /** Replaces the page map (e.g. corrected by the user); clears diffs made on the old one. */
  compareSetPairs(
    job: string,
    pairs: readonly PagePair[],
    alignment: 'index' | 'best-match',
  ): Promise<void>;
  /** Both rasters are transferred (bitmaps closed in the worker). */
  compareVisual(
    job: string,
    pair: number,
    a: AnalysisRaster,
    b: AnalysisRaster,
    request: VisualRequest,
    options?: EngineCallOptions,
  ): Promise<PixelDiffResult>;
  compareText(
    job: string,
    scope: 'document' | 'page-pairs',
    options?: EngineCallOptions,
  ): Promise<TextComparison>;
  compareFinish(job: string, request: FinishRequest): Promise<ComparisonResult>;
  /** A heat map's RGBA (changed pixels opaque in `color`, others transparent), transferred. */
  compareHeatmap(
    job: string,
    id: string,
    color?: readonly [number, number, number],
  ): Promise<AnalysisRgba>;
  /** Releases a comparison (its pages and heat maps). */
  compareEnd(job: string): Promise<void>;
  /** Facts of a file read with pdf-lib (Info, XMP, pages, annotations, fields, attachments). */
  extractFacts(bytes: ArrayBuffer, password?: string): Promise<CompareFacts>;
  /** The comparison report: the second document with change annotations and a summary page. */
  buildReport(
    bytes: ArrayBuffer,
    result: ComparisonResult,
    options?: ComparisonReportOptions,
  ): Promise<ArrayBuffer>;
  convertBegin(job: string, options: ConvertOptions): Promise<void>;
  /** Image bytes in `page.images` are transferred. */
  convertAddPage(job: string, index: number, page: ConvertPageInput): Promise<void>;
  convertFinish(job: string, options?: EngineCallOptions): Promise<ConvertResult>;
  convertEnd(job: string): Promise<void>;
  /** Longest synchronous slice so far (the worker's responsiveness), for measurements. */
  stats(): Promise<SliceStats>;
  resetStats(): Promise<void>;
}

/** Sessions and the synchronous-ish implementation behind both backends. */
export class AnalysisCore {
  private readonly compares = new Map<string, ComparisonSession>();
  private readonly converts = new Map<string, ConvertSession>();

  private compare(job: string): ComparisonSession {
    const session = this.compares.get(job);
    if (!session) throw new EngineError('internal', `Unknown comparison ${job}`);
    return session;
  }

  private convert(job: string): ConvertSession {
    const session = this.converts.get(job);
    if (!session) throw new EngineError('internal', `Unknown conversion ${job}`);
    return session;
  }

  compareBegin(job: string, header: CompareJobHeader): void {
    this.compares.set(job, new ComparisonSession(header));
  }

  compareAddPage(
    job: string,
    side: Side,
    index: number,
    page: ComparePageInput,
  ): { needsThumbnail: boolean } {
    const session = this.compare(job);
    session.addPage(side, index, page);
    return { needsThumbnail: session.needsThumbnail(side, index) };
  }

  compareAddThumbnail(job: string, side: Side, index: number, raster: AnalysisRaster): void {
    this.compare(job).addThumbnail(side, index, raster);
  }

  compareAlign(job: string, request: AlignRequest, signal?: AbortSignal): Promise<PagePair[]> {
    return this.compare(job).align(request, new Slicer('align', signal));
  }

  compareSetPairs(
    job: string,
    pairs: readonly PagePair[],
    alignment: 'index' | 'best-match',
  ): void {
    this.compare(job).setPairs(pairs, alignment);
  }

  compareVisual(
    job: string,
    pair: number,
    a: AnalysisRaster,
    b: AnalysisRaster,
    request: VisualRequest,
    signal?: AbortSignal,
  ): Promise<PixelDiffResult> {
    return this.compare(job).diffVisual(pair, a, b, request, new Slicer('visual diff', signal));
  }

  compareText(
    job: string,
    scope: 'document' | 'page-pairs',
    signal?: AbortSignal,
  ): Promise<TextComparison> {
    return this.compare(job).diffText(scope, new Slicer('text diff', signal));
  }

  compareFinish(job: string, request: FinishRequest): ComparisonResult {
    return this.compare(job).finish(request);
  }

  compareHeatmap(job: string, id: string, color?: readonly [number, number, number]): AnalysisRgba {
    return this.compare(job).heatmap(id, color);
  }

  compareEnd(job: string): void {
    this.compares.delete(job);
  }

  extractFacts(bytes: ArrayBuffer, password?: string): Promise<CompareFacts> {
    return extractCompareFacts(bytes, password);
  }

  async buildReport(
    bytes: ArrayBuffer,
    result: ComparisonResult,
    options?: ComparisonReportOptions,
  ): Promise<ArrayBuffer> {
    const out = await buildComparisonReport(bytes, result, options);
    return out.byteOffset === 0 && out.byteLength === out.buffer.byteLength
      ? (out.buffer as ArrayBuffer)
      : out.slice().buffer;
  }

  convertBegin(job: string, options: ConvertOptions): void {
    this.converts.set(job, new ConvertSession(options));
  }

  convertAddPage(job: string, index: number, page: ConvertPageInput): void {
    this.convert(job).addPage(index, page);
  }

  convertFinish(job: string, signal?: AbortSignal): Promise<ConvertResult> {
    return this.convert(job).finish(signal);
  }

  convertEnd(job: string): void {
    this.converts.delete(job);
  }
}

/** The analysis operations on the calling thread (no worker). */
export function createLocalAnalysisBackend(): AnalysisBackend {
  const core = new AnalysisCore();
  const run = <T>(fn: () => T): Promise<T> => {
    try {
      return Promise.resolve(fn());
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  };
  return {
    compareBegin: (job, header) => run(() => core.compareBegin(job, header)),
    compareAddPage: (job, side, index, page) =>
      run(() => core.compareAddPage(job, side, index, page)),
    compareAddThumbnail: (job, side, index, raster) =>
      run(() => core.compareAddThumbnail(job, side, index, raster)),
    compareAlign: (job, request, options) => core.compareAlign(job, request, options?.signal),
    compareSetPairs: (job, pairs, alignment) =>
      run(() => core.compareSetPairs(job, pairs, alignment)),
    compareVisual: (job, pair, a, b, request, options) =>
      core.compareVisual(job, pair, a, b, request, options?.signal),
    compareText: (job, scope, options) => core.compareText(job, scope, options?.signal),
    compareFinish: (job, request) => run(() => core.compareFinish(job, request)),
    compareHeatmap: (job, id, color) => run(() => core.compareHeatmap(job, id, color)),
    compareEnd: (job) => run(() => core.compareEnd(job)),
    extractFacts: (bytes, password) => core.extractFacts(bytes, password),
    buildReport: (bytes, result, options) => core.buildReport(bytes, result, options),
    convertBegin: (job, options) => run(() => core.convertBegin(job, options)),
    convertAddPage: (job, index, page) => run(() => core.convertAddPage(job, index, page)),
    convertFinish: (job, options) => core.convertFinish(job, options?.signal),
    convertEnd: (job) => run(() => core.convertEnd(job)),
    stats: () => run(() => sliceStats()),
    resetStats: () => run(() => resetSliceStats()),
  };
}
