/**
 * One comparison's state in the analysis worker: the pages' tokens and thumbnails, the page
 * map, the pixel diffs (heat maps kept as bit masks, referenced by id) and the text diff, and
 * the assembly of the JSON-serialisable `ComparisonResult`. Pure computation: pixels and
 * text arrive from the caller (in the app, from the PDFium worker through the proxy).
 */
import type {
  AnalysisRaster,
  AnalysisRgba,
  CompareAlignment,
  CompareFacts,
  ComparePageGeometry,
  ComparePageInput,
  ComparePairResult,
  CompareSideSummary,
  ComparisonResult,
  FactChange,
  PagePair,
  PixelDiffResult,
  TextChange,
  TextComparison,
} from '../types';
import { EngineError } from '../types';
import {
  type AlignPage,
  alignBestMatch,
  alignByIndex,
  DEFAULT_MIN_SIMILARITY,
  type SimilarityMatrix,
  similarityMatrix,
} from './align';
import { diffFacts } from './facts';
import {
  boxesToUser,
  changeBoxes,
  type ChangeMask,
  diffRgba,
  heatmapRgba,
  rasterToRgba,
  rasterToRgbaSliced,
  thumbnailOf,
} from './pixels';
import type { Slicer } from './scheduler';
import { diffText } from './text-diff';
import { type PageTokens, shingles, tokenizePage } from './tokens';

export interface CompareJobHeader {
  readonly a: CompareSideSummary;
  readonly b: CompareSideSummary;
  /** Word segmentation language (default `en`). */
  readonly locale?: string;
  /** Join line-end hyphenation (default true). */
  readonly joinHyphens?: boolean;
}

export interface AlignRequest {
  readonly alignment?: CompareAlignment;
  readonly minSimilarity?: number;
}

export interface VisualRequest {
  readonly dpi: number;
  readonly threshold?: number;
}

export interface FinishRequest {
  readonly facts?: { readonly a: CompareFacts; readonly b: CompareFacts };
  readonly dpi: number;
  readonly threshold: number;
  readonly visual: boolean;
  readonly text: boolean;
}

interface SessionPage extends AlignPage {
  readonly geometry: ComparePageGeometry;
  readonly tokens: PageTokens;
  thumb?: Uint8Array;
}

export type Side = 'a' | 'b';

/** Closes a raster that will not be read (an `ImageBitmap` holds GPU or decoded memory). */
export function closeRaster(raster: AnalysisRaster): void {
  if (typeof ImageBitmap !== 'undefined' && raster instanceof ImageBitmap) raster.close();
}

export const COMPARE_NOTES = (dpi: number): string[] => [
  `The visual diff shows where pages look different at ${dpi} dpi, not why; a pixel diff cannot tell intent.`,
  'The text diff sees only extractable text (scanned pages need OCR first) and depends on the reading order of the text.',
  'Neither sees metadata, hidden annotations, scripts, form values that are not drawn, tags or object changes that render the same, beyond the facts listed.',
  'Export-time additions (page numbers, watermarks, headers and footers) are not part of the comparison.',
];

/**
 * `auto` alignment keeps pages paired by position when the documents have as many pages and
 * every positional pair is plausibly the same page (similarity above τ, or nothing to judge
 * by: no text and no thumbnail on either side); otherwise it matches pages by content.
 */
function indexPairsHold(
  matrix: SimilarityMatrix,
  a: readonly AlignPage[],
  b: readonly AlignPage[],
  minSimilarity: number,
): boolean {
  for (let i = 0; i < a.length; i++) {
    const k = i * matrix.m + i;
    if ((matrix.basis[k] ?? 0) === 0) {
      const pa = a[i];
      const pb = b[i];
      const unknown = pa?.words === 0 && pb?.words === 0 && !pa.thumb && !pb.thumb;
      if (!unknown) return false;
    } else if ((matrix.values[k] ?? 0) <= minSimilarity) return false;
  }
  return true;
}

export class ComparisonSession {
  private readonly pages: Record<Side, (SessionPage | undefined)[]>;
  private pairs: PagePair[] | undefined;
  private alignment: 'index' | 'best-match' = 'index';
  private readonly visual = new Map<number, PixelDiffResult>();
  private readonly masks = new Map<string, ChangeMask>();
  private text: TextComparison | undefined;

  constructor(readonly header: CompareJobHeader) {
    this.pages = {
      a: new Array<SessionPage | undefined>(header.a.pageCount).fill(undefined),
      b: new Array<SessionPage | undefined>(header.b.pageCount).fill(undefined),
    };
  }

  private page(side: Side, index: number): SessionPage {
    const page = this.pages[side][index];
    if (!page) throw new EngineError('internal', `Page ${index + 1} of side ${side} was not added`);
    return page;
  }

  private checkIndex(side: Side, index: number): void {
    const count = this.pages[side].length;
    if (!Number.isInteger(index) || index < 0 || index >= count) {
      throw new EngineError('internal', `Page index ${index} out of range for side ${side}`);
    }
  }

  /** Adds (or replaces) a page's geometry and text. */
  addPage(side: Side, index: number, input: ComparePageInput): void {
    this.checkIndex(side, index);
    const tokens = tokenizePage(input.runs, {
      ...(this.header.locale === undefined ? {} : { locale: this.header.locale }),
      ...(this.header.joinHyphens === undefined ? {} : { joinHyphens: this.header.joinHyphens }),
    });
    const previous = this.pages[side][index];
    this.pages[side][index] = {
      geometry: {
        size: input.size,
        rotation: input.rotation,
        ...(input.origin ? { origin: input.origin } : {}),
      },
      tokens,
      shingles: shingles(tokens.tokens),
      words: tokens.tokens.filter((t) => t.word).length,
      ...(previous?.thumb ? { thumb: previous.thumb } : {}),
    };
  }

  /** Whether the page has no words (its alignment needs a thumbnail). */
  needsThumbnail(side: Side, index: number): boolean {
    const page = this.pages[side][index];
    return page?.words === 0 && page.thumb === undefined;
  }

  addThumbnail(side: Side, index: number, raster: AnalysisRaster): void {
    const page = this.page(side, index);
    page.thumb = thumbnailOf(rasterToRgba(raster));
  }

  async align(request: AlignRequest, slicer: Slicer): Promise<PagePair[]> {
    const a = this.pages.a.map((_, i) => this.page('a', i));
    const b = this.pages.b.map((_, i) => this.page('b', i));
    const matrix = await similarityMatrix(a, b, slicer);
    const mode = request.alignment ?? 'auto';
    const minSimilarity = request.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
    const byIndex =
      mode === 'index' ||
      (mode === 'auto' && a.length === b.length && indexPairsHold(matrix, a, b, minSimilarity));
    this.alignment = byIndex ? 'index' : 'best-match';
    this.pairs = byIndex
      ? alignByIndex(matrix)
      : await alignBestMatch(matrix, minSimilarity, slicer);
    this.visual.clear();
    this.masks.clear();
    this.text = undefined;
    slicer.done('align');
    return this.pairs;
  }

  /** Sets the page map chosen elsewhere (e.g. the user corrected it). */
  setPairs(pairs: readonly PagePair[], alignment: 'index' | 'best-match'): void {
    this.pairs = [...pairs];
    this.alignment = alignment;
    this.visual.clear();
    this.masks.clear();
    this.text = undefined;
  }

  private pairAt(index: number): PagePair {
    const pair = this.pairs?.[index];
    if (!pair) throw new EngineError('internal', `No pair ${index}: align first`);
    return pair;
  }

  async diffVisual(
    pairIndex: number,
    rasterA: AnalysisRaster,
    rasterB: AnalysisRaster,
    request: VisualRequest,
    slicer: Slicer,
  ): Promise<PixelDiffResult> {
    const pair = this.pairAt(pairIndex);
    if (pair.a === undefined || pair.b === undefined) {
      throw new EngineError('internal', `Pair ${pairIndex} has no page on one side`);
    }
    let imageA: AnalysisRgba;
    try {
      imageA = await rasterToRgbaSliced(rasterA, slicer);
    } catch (error) {
      closeRaster(rasterB);
      throw error;
    }
    const imageB = await rasterToRgbaSliced(rasterB, slicer);
    const core = await diffRgba(imageA, imageB, request.threshold ?? 0.1, slicer);
    const boxes = changeBoxes(core);
    const heatmapId = core.changedPixels > 0 ? `pair-${pairIndex}` : undefined;
    const result: PixelDiffResult = {
      dpi: request.dpi,
      width: core.width,
      height: core.height,
      changedPixels: core.changedPixels,
      changedRatio: core.changedPixels / Math.max(1, core.width * core.height),
      regions: boxesToUser(boxes, this.page('b', pair.b).geometry, imageB.width, imageB.height),
      regionsA: boxesToUser(boxes, this.page('a', pair.a).geometry, imageA.width, imageA.height),
      sizeMismatch: core.sizeMismatch,
      ...(heatmapId ? { heatmapId } : {}),
    };
    if (heatmapId) this.masks.set(heatmapId, core.mask);
    else this.masks.delete(`pair-${pairIndex}`);
    this.visual.set(pairIndex, result);
    slicer.done('visual');
    return result;
  }

  async diffText(scope: 'document' | 'page-pairs', slicer: Slicer): Promise<TextComparison> {
    if (!this.pairs) throw new EngineError('internal', 'Align the pages first');
    const tokensOf = (side: Side) => this.pages[side].map((p) => p?.tokens);
    this.text = await diffText(tokensOf('a'), tokensOf('b'), this.pairs, scope, slicer);
    slicer.done('text');
    return this.text;
  }

  heatmap(id: string, color?: readonly [number, number, number]): AnalysisRgba {
    const mask = this.masks.get(id);
    if (!mask) throw new EngineError('internal', `No heat map ${id}`);
    return heatmapRgba(mask, color);
  }

  finish(request: FinishRequest): ComparisonResult {
    const pairs = this.pairs;
    if (!pairs) throw new EngineError('internal', 'Align the pages first');
    const text: TextComparison = this.text ?? {
      scope: 'document',
      changes: [],
      pairsOverBudget: [],
      tokens: { a: 0, b: 0 },
    };
    const facts: FactChange[] = request.facts
      ? diffFacts(request.facts.a, request.facts.b, pairs)
      : [];
    const touches = (change: TextChange, pair: PagePair) =>
      (change.a !== undefined && change.a.page === pair.a) ||
      (change.b !== undefined && change.b.page === pair.b);
    const pages: ComparePairResult[] = pairs.map((pair, index) => {
      if (pair.a === undefined || pair.b === undefined) {
        const side: Side = pair.a === undefined ? 'b' : 'a';
        const page = this.pages[side][(pair.a ?? pair.b) as number];
        const firstLine = page?.tokens.lines[0];
        return {
          pair,
          status: pair.a === undefined ? 'inserted' : 'deleted',
          textChanges: 0,
          words: page?.words ?? 0,
          ...(firstLine === undefined ? {} : { firstLine }),
          geometryChanged: false,
        };
      }
      const ga = this.page('a', pair.a).geometry;
      const gb = this.page('b', pair.b).geometry;
      const geometryChanged =
        ga.rotation !== gb.rotation ||
        Math.abs(ga.size.width - gb.size.width) > 0.5 ||
        Math.abs(ga.size.height - gb.size.height) > 0.5;
      const visual = this.visual.get(index);
      const textChanges = text.changes.filter((c) => touches(c, pair)).length;
      const changed = geometryChanged || textChanges > 0 || (visual?.changedPixels ?? 0) > 0;
      return {
        pair,
        status: changed ? 'changed' : 'identical',
        ...(visual ? { visual } : {}),
        textChanges,
        geometryChanged,
      };
    });
    const count = (status: ComparePairResult['status']) =>
      pages.filter((p) => p.status === status).length;
    const kinds = (kind: TextChange['kind']) => text.changes.filter((c) => c.kind === kind).length;
    return {
      version: 1,
      a: this.header.a,
      b: this.header.b,
      settings: {
        alignment: this.alignment,
        dpi: request.dpi,
        threshold: request.threshold,
        visual: request.visual,
        text: request.text,
      },
      pages,
      text,
      facts,
      counts: {
        identical: count('identical'),
        changed: count('changed'),
        inserted: count('inserted'),
        deleted: count('deleted'),
        textAdded: kinds('added'),
        textRemoved: kinds('removed'),
        textChanged: kinds('changed'),
        visualRegions: pages.reduce((sum, p) => sum + (p.visual?.regions.length ?? 0), 0),
        facts: facts.length,
      },
      notes: COMPARE_NOTES(request.dpi),
    };
  }
}
