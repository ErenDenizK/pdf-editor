/**
 * One OCR run (spec recognize-and-compare §1.2, §1.3): recognise the chosen pages, then write
 * them as one history entry.
 *
 * 1. A lease on the recognizer (engine/engine-service.ts `OcrRecognizerHost`, kept 60 s after
 *    the run) and the language packs, fetched through `OcrPackStore` from our own origin.
 * 2. Per page: `renderForOcr` in the PDFium worker (8-bit greyscale in display orientation, at
 *    `ocrDpiFor` of the page's facts and the quality), then `recognize`. Two pages are in
 *    flight at once, matching the recognizer pool; the PDFium worker renders one at a time.
 * 3. Only when every page is recognised: one `ocr.apply` edit per source inside the edit
 *    runner's queue (`runAction`), committed as one history entry ("Recognize text: 12 pages,
 *    tur+eng"). The payload stores the words, so undo (reopen + replay) and redo never
 *    recognise again. A cancelled run stops before step 3 and commits nothing; a layer that
 *    fails its verification in the worker makes the action throw, and the runner reverts
 *    what it executed.
 */
import type { EngineEdit, SourceId } from '@pdf-editor/document-model';
import {
  EngineError,
  ocrApplyEdit,
  ocrDpiFor,
  type OcrLayerPlan,
  type OcrPageResult,
  ocrReportOf,
  type PdfOcrLayer,
} from '@pdf-editor/engine';

import { executeEdit, runAction } from '../annotations/edit-runner';
import { getEngineService, getOcrRecognizers, toFailure } from '../engine/engine-service';
import { m } from '../i18n';
import { announce } from '../shell/announcer';
import { factsOf, languagesKey, type OcrTarget, replaceModeFor } from './ocr-model';
import type { OcrPhase, OcrRunRequest, OcrRunResult } from './ocr-store';

/** Pages recognised at once (the recognizer pool has one or two workers). */
const LANES = 2;

export interface OcrRunProgress {
  readonly phase: OcrPhase;
  readonly done?: number;
  readonly total?: number;
  readonly download?: { readonly done: number; readonly total: number };
}

export interface OcrRunCallbacks {
  readonly signal: AbortSignal;
  readonly onProgress: (progress: OcrRunProgress) => void;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new EngineError('aborted', 'OCR was cancelled');
}

/** Recognises every target; results in target order. */
async function recognizeAll(
  request: OcrRunRequest,
  layer: PdfOcrLayer,
  recognize: (
    raster: Awaited<ReturnType<PdfOcrLayer['renderForOcr']>>,
    target: OcrTarget,
  ) => Promise<OcrPageResult>,
  { signal, onProgress }: OcrRunCallbacks,
): Promise<{ results: OcrPageResult[]; reducedDpi: number }> {
  const { targets } = request;
  const results: OcrPageResult[] = new Array<OcrPageResult>(targets.length);
  let next = 0;
  let done = 0;
  let reducedDpi = 0;
  const lane = async () => {
    for (;;) {
      throwIfAborted(signal);
      const at = next;
      next += 1;
      const target = targets[at];
      if (target === undefined) return;
      const raster = await layer.renderForOcr(target.source, target.index, {
        dpi: ocrDpiFor(factsOf(request.facts, target), request.quality),
        rotation: target.rotation,
        signal,
      });
      if (raster.requestedDpi !== undefined) reducedDpi += 1;
      results[at] = await recognize(raster, target);
      done += 1;
      onProgress({ phase: 'recognize', done, total: targets.length });
    }
  };
  onProgress({ phase: 'recognize', done: 0, total: targets.length });
  await Promise.all(Array.from({ length: Math.min(LANES, targets.length) }, lane));
  throwIfAborted(signal);
  return { results, reducedDpi };
}

/** The layer plans of a run, one per source, pages in source order. */
export function plansOf(
  request: OcrRunRequest,
  results: readonly OcrPageResult[],
): Map<SourceId, OcrLayerPlan> {
  const bySource = new Map<SourceId, { targets: OcrTarget[]; pages: OcrPageResult[] }>();
  request.targets.forEach((target, i) => {
    const result = results[i];
    if (!result) return;
    const entry = bySource.get(target.source) ?? { targets: [], pages: [] };
    entry.targets.push(target);
    entry.pages.push(result);
    bySource.set(target.source, entry);
  });
  const plans = new Map<SourceId, OcrLayerPlan>();
  for (const [source, { targets, pages }] of bySource) {
    plans.set(source, {
      pages: [...pages].sort((a, b) => a.pageIndex - b.pageIndex),
      replace: replaceModeFor(request.replace, targets, request.facts),
    });
  }
  return plans;
}

/**
 * Runs `request` (see the module comment). Resolves to the result, or undefined when the run
 * was cancelled before anything was written; rejects when recognition or the layer failed
 * (nothing is committed then either).
 */
export async function recognizeAndApply(
  request: OcrRunRequest,
  callbacks: OcrRunCallbacks,
): Promise<OcrRunResult | undefined> {
  const { signal, onProgress } = callbacks;
  const started = performance.now();
  const codes = [...request.languages];
  const lease = await getOcrRecognizers().acquire();
  try {
    const { recognizer } = lease;
    onProgress({ phase: 'download' });
    await recognizer.ensureLanguages(codes, {
      signal,
      onProgress: (progress) => {
        if (progress.phase === 'download') {
          onProgress({
            phase: 'download',
            download: { done: progress.done, total: progress.total },
          });
        } else onProgress({ phase: 'start' });
      },
    });
    const layer = await getEngineService().ocrLayer();
    const { results, reducedDpi } = await recognizeAll(
      request,
      layer,
      (raster, target) => recognizer.recognize(raster, target.index, codes, { signal }),
      callbacks,
    );
    throwIfAborted(signal);
    onProgress({ phase: 'write' });
    const report = ocrReportOf(results, { totalMs: performance.now() - started });
    const label = m.ocr_history_label({
      count: report.pages,
      languages: languagesKey(codes),
    });
    const plans = plansOf(request, results);
    const committed = await runAction(async (ctx) => {
      const edits: EngineEdit[] = [];
      for (const [source, plan] of plans) {
        const executed = await executeEdit(
          ctx,
          ocrApplyEdit(globalThis.crypto.randomUUID(), source, plan),
        );
        edits.push(executed.recorded);
      }
      return { edits, label, value: true };
    });
    if (!committed) throw new Error(m.ocr_not_applied());
    announce(label);
    return {
      label,
      pages: report.pages,
      languages: codes,
      byQuality: report.byQuality,
      words: report.words,
      lowConfidence: report.lowConfidence,
      timedOut: report.timedOut,
      reducedDpi,
    };
  } catch (error) {
    if (signal.aborted || toFailure(error).code === 'aborted') {
      announce(m.ocr_cancelled());
      return undefined;
    }
    announce(m.ocr_failed_short());
    throw error;
  } finally {
    lease.release();
  }
}
