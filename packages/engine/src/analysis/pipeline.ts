/**
 * The comparison run on the caller's side (spec §2.2): pulls text and renders from two
 * `CompareSource`s (in the app, the PDFium worker's proxy: rendering stays there, at low
 * priority) and pushes them to an `AnalysisBackend` (the analysis worker), page by page, so
 * no message is large and nothing heavy runs on the caller's thread. Order: text of every
 * page → thumbnails of pages without text (best match only) → page map → visual diff per
 * pair (two pairs in flight, `visualOrder` first) → text diff → facts. Progress per phase;
 * the signal aborts at once and releases the worker's state.
 */
import type { Rect, Rotation, SourceId } from '@pdf-editor/document-model';

import {
  type AnalysisRaster,
  type AnalysisRgba,
  type Annotation,
  type CompareFacts,
  type CompareOptions,
  type ComparePageGeometry,
  type ComparePhase,
  type ComparisonResult,
  type EngineCallOptions,
  EngineError,
  type FormField,
  type OpenedDocument,
  type PagePair,
  type PdfEditor,
  type PdfRenderer,
  type TextRun,
} from '../types';
import type { AnalysisBackend, Side } from './backend';
import { factsFromEngine } from './facts';
import { displaySizeOf } from './geometry';
import { abortedError, throwIfAborted } from './scheduler';

/** One side of a comparison, as the caller can read it. */
export interface CompareSource {
  readonly name: string;
  readonly fingerprint?: string;
  readonly pageCount: number;
  geometry(index: number): ComparePageGeometry;
  text(index: number, options: EngineCallOptions): Promise<readonly TextRun[]>;
  /** The page as displayed, at `dpi`, with annotations and form fields drawn. */
  render(
    index: number,
    options: EngineCallOptions & { readonly dpi: number },
  ): Promise<AnalysisRaster>;
  /** Facts for the facts diff; without it (on either side) no facts are compared. */
  facts?(options: EngineCallOptions): Promise<CompareFacts>;
}

export interface PdfiumCompareSourceOptions {
  readonly name: string;
  /** View rotation per page on top of /Rotate (the model's rotation delta). */
  readonly rotations?: readonly Rotation[];
  /** Draw annotations and form fields (default true). */
  readonly withAnnotations?: boolean;
  /**
   * How to read the facts: `engine` (default; annotations and fields through the engine, no
   * XMP or attachments), or a function (e.g. `extractFacts` on the saved bytes).
   */
  readonly facts?: 'engine' | ((options: EngineCallOptions) => Promise<CompareFacts>);
}

type EngineLike = Pick<PdfRenderer, 'renderPage' | 'getPageText'> &
  Pick<PdfEditor, 'listAnnotations' | 'listFormFields'>;

/** A `CompareSource` over an open source of the viewer's engine (e.g. `PdfiumProxy`). */
export function pdfiumCompareSource(
  engine: EngineLike,
  id: SourceId,
  opened: Pick<OpenedDocument, 'pageCount' | 'pages' | 'fingerprint' | 'metadata'>,
  options: PdfiumCompareSourceOptions,
): CompareSource {
  const delta = (index: number): Rotation => options.rotations?.[index] ?? 0;
  const withAnnotations = options.withAnnotations ?? true;
  return {
    name: options.name,
    fingerprint: opened.fingerprint,
    pageCount: opened.pageCount,
    geometry(index) {
      const page = opened.pages[index];
      if (!page) throw new RangeError(`No page ${index}`);
      const crop: Rect | undefined = page.cropBox;
      return {
        size: page.size,
        rotation: ((page.rotation + delta(index)) % 360) as Rotation,
        ...(crop ? { origin: { x: crop.x, y: crop.y } } : {}),
      };
    },
    text(index, callOptions) {
      return engine.getPageText(id, index, callOptions);
    },
    async render(index, { dpi, ...callOptions }) {
      const result = await engine.renderPage(id, index, {
        ...callOptions,
        scale: dpi / 72,
        rotation: delta(index),
        withAnnotations,
        withForms: withAnnotations,
        background: 'white',
      });
      return result.bitmap;
    },
    facts:
      typeof options.facts === 'function'
        ? options.facts
        : async (callOptions) => {
            const annotations: Annotation[][] = [];
            for (let i = 0; i < opened.pageCount; i++) {
              annotations.push([...(await engine.listAnnotations(id, i, callOptions))]);
            }
            const fields: readonly FormField[] = await engine.listFormFields(id, callOptions);
            return factsFromEngine(opened, annotations, fields);
          },
  };
}

/** A finished comparison: the result plus access to its heat maps until released. */
export interface CompareRun {
  readonly job: string;
  readonly result: ComparisonResult;
  heatmap(id: string, color?: readonly [number, number, number]): Promise<AnalysisRgba>;
  /** Frees the worker's copy of the pages and heat maps. */
  release(): Promise<void>;
}

let jobCounter = 0;

/** Runs `tasks` with at most `limit` in flight, stopping at the first failure. */
async function pool<T>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failed: Error | undefined;
  const worker = async () => {
    while (failed === undefined && next < items.length) {
      const item = items[next++] as T;
      try {
        await run(item);
      } catch (error) {
        failed ??=
          error instanceof Error
            ? error
            : new EngineError('internal', 'A comparison step failed', { cause: error });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failed !== undefined) throw failed;
}

function closeRaster(raster: AnalysisRaster | undefined): void {
  if (raster && typeof ImageBitmap !== 'undefined' && raster instanceof ImageBitmap) raster.close();
}

/** Small render for a 32×32 thumbnail: about 64 px on the longer side. */
function thumbnailDpi(geometry: ComparePageGeometry): number {
  const display = displaySizeOf(geometry);
  return Math.max(4, (64 / Math.max(display.width, display.height, 1)) * 72);
}

export async function compareDocuments(
  backend: AnalysisBackend,
  a: CompareSource,
  b: CompareSource,
  options: CompareOptions = {},
): Promise<CompareRun> {
  const { signal } = options;
  throwIfAborted(signal, 'compare');
  const job = `compare-${++jobCounter}-${Date.now().toString(36)}`;
  const dpi = options.dpi ?? 100;
  const threshold = options.threshold ?? 0.1;
  const runVisual = options.visual ?? true;
  const runText = options.text ?? true;
  const call: EngineCallOptions = { ...(signal ? { signal } : {}), priority: 'low' };
  const report = (phase: ComparePhase, done: number, total: number) =>
    options.onProgress?.({ phase, done, total });
  const sources: Record<Side, CompareSource> = { a, b };
  await backend.compareBegin(job, {
    a: {
      name: a.name,
      ...(a.fingerprint ? { fingerprint: a.fingerprint } : {}),
      pageCount: a.pageCount,
    },
    b: {
      name: b.name,
      ...(b.fingerprint ? { fingerprint: b.fingerprint } : {}),
      pageCount: b.pageCount,
    },
    ...(options.locale ? { locale: options.locale } : {}),
    ...(options.joinHyphens === undefined ? {} : { joinHyphens: options.joinHyphens }),
  });
  try {
    // 1. Text (needed for the text diff and for best-match alignment).
    const alignment = options.alignment ?? 'auto';
    // `auto` may still match by content (when positional pairs do not hold): it needs text and
    // thumbnails like `best-match`.
    const byIndex = alignment === 'index';
    const needText = runText || !byIndex;
    const pages = (['a', 'b'] as const).flatMap((side) =>
      Array.from({ length: sources[side].pageCount }, (_, index) => ({ side, index })),
    );
    const thumbs: { side: Side; index: number }[] = [];
    let done = 0;
    report('text', 0, pages.length);
    await pool(pages, 4, async ({ side, index }) => {
      const source = sources[side];
      const runs = needText ? await source.text(index, call) : [];
      throwIfAborted(signal, 'compare');
      const added = await backend.compareAddPage(job, side, index, {
        ...source.geometry(index),
        runs,
      });
      if (added.needsThumbnail) thumbs.push({ side, index });
      report('text', ++done, pages.length);
    });
    // 2. Thumbnails for pages without text, when pages are matched by content.
    if (!byIndex && thumbs.length > 0) {
      done = 0;
      report('thumbnails', 0, thumbs.length);
      await pool(thumbs, 2, async ({ side, index }) => {
        const source = sources[side];
        const raster = await source.render(index, {
          ...call,
          dpi: thumbnailDpi(source.geometry(index)),
        });
        await backend.compareAddThumbnail(job, side, index, raster);
        report('thumbnails', ++done, thumbs.length);
      });
    }
    // 3. Page map.
    report('align', 0, 1);
    const pairs: readonly PagePair[] = await backend.compareAlign(
      job,
      {
        alignment,
        ...(options.minSimilarity === undefined ? {} : { minSimilarity: options.minSimilarity }),
      },
      signal ? { signal } : {},
    );
    report('align', 1, 1);
    // 4. Visual diff per pair.
    if (runVisual) {
      const paired = pairs.flatMap((p, i) => (p.a !== undefined && p.b !== undefined ? [i] : []));
      const first = (options.visualOrder?.(pairs) ?? []).filter((i) => paired.includes(i));
      const order = [...new Set([...first, ...paired])];
      done = 0;
      report('visual', 0, order.length);
      await pool(order, 2, async (index) => {
        const pair = pairs[index] as PagePair & { a: number; b: number };
        // Both renders settle before anything is thrown, so no bitmap is left open.
        const [sa, sb] = await Promise.allSettled([
          a.render(pair.a, { ...call, dpi }),
          b.render(pair.b, { ...call, dpi }),
        ]);
        const ra = sa.status === 'fulfilled' ? sa.value : undefined;
        const rb = sb.status === 'fulfilled' ? sb.value : undefined;
        if (!ra || !rb || signal?.aborted) {
          closeRaster(ra);
          closeRaster(rb);
          throwIfAborted(signal, 'compare');
          const reason: unknown =
            sa.status === 'rejected' ? sa.reason : sb.status === 'rejected' ? sb.reason : undefined;
          throw reason instanceof Error
            ? reason
            : new EngineError('internal', 'A page could not be rendered');
        }
        const visual = await backend.compareVisual(
          job,
          index,
          ra,
          rb,
          { dpi, threshold },
          signal ? { signal } : {},
        );
        options.onPair?.(index, pair, visual);
        report('visual', ++done, order.length);
      });
    }
    // 5. Text diff.
    if (runText) {
      report('text-diff', 0, 1);
      await backend.compareText(job, options.textScope ?? 'document', signal ? { signal } : {});
      report('text-diff', 1, 1);
    }
    // 6. Facts.
    let facts: { a: CompareFacts; b: CompareFacts } | undefined;
    if (a.facts && b.facts) {
      report('facts', 0, 2);
      const fa = await a.facts(call);
      report('facts', 1, 2);
      const fb = await b.facts(call);
      report('facts', 2, 2);
      facts = { a: fa, b: fb };
    }
    throwIfAborted(signal, 'compare');
    const result = await backend.compareFinish(job, {
      ...(facts ? { facts } : {}),
      dpi,
      threshold,
      visual: runVisual,
      text: runText,
    });
    return {
      job,
      result,
      heatmap: (id, color) => backend.compareHeatmap(job, id, color),
      release: () => backend.compareEnd(job),
    };
  } catch (error) {
    await backend.compareEnd(job).catch(() => undefined);
    if (signal?.aborted) throw abortedError('compare', signal.reason);
    throw error;
  }
}
