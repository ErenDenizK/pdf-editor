/**
 * One OCR run (spec recognize-and-compare §1.2, §1.3): recognise the chosen pages, then write
 * them as one history entry.
 *
 * 1. A lease on the recognizer (engine/engine-service.ts `OcrRecognizerHost`, kept 60 s after
 *    the run) and the language packs, fetched through `OcrPackStore` from our own origin.
 * 2. Per page: `renderForOcr` in the PDFium worker (8-bit greyscale in display orientation, at
 *    `ocrDpiFor` of the page's facts and the quality), then `recognize`. Two pages are in
 *    flight at once, matching the recognizer pool; the PDFium worker renders one at a time.
 *    A page that fails stops the other lane before the error is passed on.
 * 3. Only when every page is recognised: one `ocr.apply` edit per source inside the edit
 *    runner's queue (`runAction`), committed as one history entry ("Recognize text: 12 pages,
 *    tur+eng"). The payload stores the words, so undo (reopen + replay) and redo never
 *    recognise again. A cancelled run stops before step 3 and commits nothing; a layer that
 *    fails its verification in the worker makes the action throw, and the runner reverts
 *    what it executed.
 *
 * Pages render outside the queue, so edits go on meanwhile. Each page's render records the
 * page's content revision (edit-runner.ts `contentRevision`: its source's and its own); inside
 * the action, a page whose content changed since is not written from what was read. A text
 * edit on another page, or an edit of an image another page draws itself, leaves it alone;
 * one on the page, a redaction, an image inside a Form XObject, a reopen (the undo of such an
 * edit) or the source closing marks it changed.
 * Changed pages are recognised again ("The document changed: recognizing …"), at most
 * `RECHECKS` times, then the run fails and commits nothing. Closing the run's document stops
 * it; a source that left the workspace is not written.
 */
import type { EngineEdit, SourceId } from '@pdf-editor/document-model';
import {
  EngineError,
  ocrApplyEdit,
  ocrDpiFor,
  type OcrLayerPlan,
  type OcrPageResult,
  type OcrRecognizer,
  ocrReportOf,
  type PdfOcrLayer,
} from '@pdf-editor/engine';

import {
  contentChanged,
  contentRevision,
  type ContentRevision,
  executeEdit,
  runAction,
} from '../annotations/edit-runner';
import {
  getEngineService,
  getOcrRecognizers,
  type OcrRecognizerLease,
  toFailure,
} from '../engine/engine-service';
import { formatNumber, m } from '../i18n';
import { announce } from '../shell/announcer';
import { useWorkspaceStore } from '../state/workspace-store';
import { factsOf, languagesKey, type OcrTarget, replaceModeFor } from './ocr-model';
import type { OcrPhase, OcrRunRequest, OcrRunResult } from './ocr-store';

/** Pages recognised at once (the recognizer pool has one or two workers). */
const LANES = 2;

/** Times the pages that changed during the run are recognised again. */
export const RECHECKS = 2;

/** The revision recorded for a page not rendered yet, or without `revisionOf`. */
const UNREAD: ContentRevision = { source: 0, page: 0 };

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

/** Pages recognised, in target order, and how many the 40 MP cap rendered below the asked DPI. */
export interface OcrRecognition {
  readonly results: OcrPageResult[];
  readonly reducedDpi: number;
  /** Per target: `revisionOf` its page, read just before it was rendered (zeros without it). */
  readonly revisions: readonly ContentRevision[];
  /** Per target: whether the 40 MP cap rendered it below the asked DPI. */
  readonly reduced: readonly boolean[];
}

/**
 * Renders and recognises `targets` with a recognizer the caller holds (a lease from
 * `getOcrRecognizers()`, its languages ensured): `LANES` pages in flight, rasters from
 * `layer.renderForOcr` at `dpiOf(target)`. Shared by the OCR dialog's run and the batch
 * runner's OCR step (batch/ocr-step.ts), which opens its sources privately. Throws an
 * `aborted` EngineError once `signal` fires; a page that fails aborts the other lanes and,
 * once they have stopped, its error is thrown. Nothing is written here.
 */
export async function recognizeTargets(
  targets: readonly OcrTarget[],
  options: {
    readonly recognizer: Pick<OcrRecognizer, 'recognize'>;
    readonly layer: Pick<PdfOcrLayer, 'renderForOcr'>;
    readonly languages: readonly string[];
    readonly dpiOf: (target: OcrTarget) => number;
    /** The page's content revision, read before each render (see `OcrRecognition`). */
    readonly revisionOf?: (source: SourceId, pageIndex: number) => ContentRevision;
  },
  { signal, onProgress }: OcrRunCallbacks,
): Promise<OcrRecognition> {
  const { recognizer, layer, languages, dpiOf, revisionOf } = options;
  const results: OcrPageResult[] = new Array<OcrPageResult>(targets.length);
  const revisions: ContentRevision[] = new Array<ContentRevision>(targets.length).fill(UNREAD);
  const reduced: boolean[] = new Array<boolean>(targets.length).fill(false);
  // Aborted by the caller's signal or by the first page that fails.
  const lanes = new AbortController();
  const stop = () => lanes.abort();
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) lanes.abort();
  let failure: { readonly error: unknown } | undefined;
  let next = 0;
  let done = 0;
  const lane = async () => {
    for (;;) {
      throwIfAborted(lanes.signal);
      const at = next;
      next += 1;
      const target = targets[at];
      if (target === undefined) return;
      revisions[at] = revisionOf?.(target.source, target.index) ?? UNREAD;
      const raster = await layer.renderForOcr(target.source, target.index, {
        dpi: dpiOf(target),
        rotation: target.rotation,
        signal: lanes.signal,
      });
      if (raster.requestedDpi !== undefined) reduced[at] = true;
      results[at] = await recognizer.recognize(raster, target.index, languages, {
        signal: lanes.signal,
      });
      done += 1;
      onProgress({ phase: 'recognize', done, total: targets.length });
    }
  };
  onProgress({ phase: 'recognize', done: 0, total: targets.length });
  try {
    await Promise.allSettled(
      Array.from({ length: Math.min(LANES, targets.length) }, () =>
        lane().catch((error: unknown) => {
          failure ??= { error };
          lanes.abort();
        }),
      ),
    );
  } finally {
    signal.removeEventListener('abort', stop);
  }
  throwIfAborted(signal);
  if (failure) throw failure.error;
  return { results, reducedDpi: reduced.filter(Boolean).length, revisions, reduced };
}

/**
 * Downloads (or reads from the device) and checks `codes` through the recognizer's pack
 * loader (`OcrPackStore`, our origin only, ADR-0012 §4), reporting the download and the
 * recognizer's start as run phases.
 */
export async function ensureRunLanguages(
  recognizer: Pick<OcrRecognizer, 'ensureLanguages'>,
  codes: readonly string[],
  { signal, onProgress }: OcrRunCallbacks,
): Promise<void> {
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
 * was cancelled (or its document closed) before anything was written; rejects when
 * recognition or the layer failed, or the document kept changing (nothing is committed then
 * either).
 */
export async function recognizeAndApply(
  request: OcrRunRequest,
  callbacks: OcrRunCallbacks,
): Promise<OcrRunResult | undefined> {
  const { onProgress } = callbacks;
  const started = performance.now();
  const codes = [...request.languages];
  const { targets } = request;
  // The run's own signal: the caller's cancel, or its document closing.
  const run = new AbortController();
  let closed = false;
  const cancel = () => run.abort();
  callbacks.signal.addEventListener('abort', cancel, { once: true });
  if (callbacks.signal.aborted) run.abort();
  const documentOpen = () =>
    useWorkspaceStore.getState().workspace.documents[request.documentId] !== undefined;
  const unsubscribe = useWorkspaceStore.subscribe(() => {
    if (!closed && !documentOpen()) {
      closed = true;
      run.abort();
    }
  });
  const signal = run.signal;
  const own: OcrRunCallbacks = { signal, onProgress };
  let lease: OcrRecognizerLease | undefined;
  try {
    if (!documentOpen()) {
      closed = true;
      run.abort();
    }
    throwIfAborted(signal);
    lease = await getOcrRecognizers().acquire();
    const { recognizer } = lease;
    await ensureRunLanguages(recognizer, codes, own);
    const layer = await getEngineService().ocrLayer();
    const recognition = {
      recognizer,
      layer,
      languages: codes,
      dpiOf: (target: OcrTarget) => ocrDpiFor(factsOf(request.facts, target), request.quality),
      revisionOf: contentRevision,
    };
    const results = new Array<OcrPageResult>(targets.length);
    const revisions = new Array<ContentRevision>(targets.length).fill(UNREAD);
    const reduced = new Array<boolean>(targets.length).fill(false);
    let pending = targets.map((_, i) => i);
    for (let attempt = 0; ; attempt++) {
      const pass = await recognizeTargets(
        pending.map((i) => targets[i] as OcrTarget),
        recognition,
        attempt === 0
          ? own
          : { signal, onProgress: (progress) => onProgress({ ...progress, phase: 'recheck' }) },
      );
      pending.forEach((at, k) => {
        results[at] = pass.results[k] as OcrPageResult;
        revisions[at] = pass.revisions[k] ?? UNREAD;
        reduced[at] = pass.reduced[k] ?? false;
      });
      throwIfAborted(signal);
      onProgress({ phase: 'write' });
      const report = ocrReportOf(results, { totalMs: performance.now() - started });
      const label = m.ocr_history_label({
        count: report.pages,
        languages: languagesKey(codes),
      });
      const plans = plansOf(request, results);
      let stale: number[] = [];
      let gone = false;
      const committed = await runAction(async (ctx) => {
        const ws = useWorkspaceStore.getState().workspace;
        if (ws.documents[request.documentId] === undefined) {
          gone = true;
          return undefined;
        }
        // Pages whose content changed after they were rendered: recognised again.
        stale = targets.flatMap((target, i) =>
          ws.sources[target.source] !== undefined &&
          contentChanged(target.source, target.index, revisions[i] ?? UNREAD)
            ? [i]
            : [],
        );
        if (stale.length > 0) return undefined;
        const edits: EngineEdit[] = [];
        for (const [source, plan] of plans) {
          // A source that left the workspace (its pages removed) is not written.
          if (ws.sources[source] === undefined) continue;
          const executed = await executeEdit(
            ctx,
            ocrApplyEdit(globalThis.crypto.randomUUID(), source, plan),
          );
          edits.push(executed.recorded);
        }
        return edits.length === 0 ? undefined : { edits, label, value: true };
      });
      if (gone) {
        closed = true;
        run.abort();
      }
      throwIfAborted(signal);
      if (committed) {
        announce(label);
        return {
          label,
          pages: report.pages,
          languages: codes,
          byQuality: report.byQuality,
          words: report.words,
          lowConfidence: report.lowConfidence,
          timedOut: report.timedOut,
          reducedDpi: reduced.filter(Boolean).length,
        };
      }
      if (stale.length === 0) throw new Error(m.ocr_not_applied());
      if (attempt >= RECHECKS) throw new Error(m.ocr_changed_during_run());
      announce(m.ocr_recheck({ count: stale.length, countText: formatNumber(stale.length) }));
      pending = stale;
    }
  } catch (error) {
    if (signal.aborted || toFailure(error).code === 'aborted') {
      announce(closed ? m.ocr_document_closed() : m.ocr_cancelled());
      return undefined;
    }
    announce(m.ocr_failed_short());
    throw error;
  } finally {
    unsubscribe();
    callbacks.signal.removeEventListener('abort', cancel);
    lease?.release();
  }
}
