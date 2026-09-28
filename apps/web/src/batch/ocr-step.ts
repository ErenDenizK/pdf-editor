/**
 * The OCR step of batch recipes (spec recognize-and-compare §5 and §1, ADR-0014): the same
 * recognition as the OCR dialog (ocr/ocr-run.ts `recognizeTargets`), on the runner's
 * private source instead of a tab.
 *
 * - **Once per batch** (`openBatchOcr`): one lease on the app's recognizer
 *   (`getOcrRecognizers()`, the pool the dialog uses) and the recipe's languages ensured
 *   through its `OcrPackStore`, from our origin only (ADR-0012 §4). A pack missing on the
 *   device is downloaded once for the whole batch, never per file; one that cannot be
 *   fetched (offline, no cache) fails the batch before the first file (`BatchOcrError`).
 * - **Per file** (`runOcrStep`): `ocrPageFacts` of the private source, the pages the step's
 *   scope picks among the document's pages as the earlier steps left them (deleted pages
 *   are not recognised; rotated ones are read upright), render + recognise, then one
 *   `ocr.apply` edit applied to the private source in the PDFium worker (the layered
 *   document replaces it under the same id, verified there) and recorded in the private
 *   workspace's `engineEdits`, so the export saves the source through the engine, runs
 *   `finalizeContentEdits` and names the run in its summary, exactly as for a tab.
 * - **Cancel:** the signal aborts rendering and recognition; the edit is applied only when
 *   every page is recognised, so a cancelled file carries no layer (and its output is not
 *   written: the runner fails it as cancelled).
 *
 * Notes per file: the pages recognised with their languages and quality counts, pages that
 * produced no text, pages rendered below the recipe's resolution (40 MP cap), invisible text
 * kept next to the new layer, and a scope that found nothing to recognise.
 */
import {
  type DocumentId,
  getDocument,
  RECIPE_DEFAULT_OCR_REPLACE,
  type RecipeOcrOptions,
  type RecipeOcrReplace,
  type SourceId,
  type VirtualDocument,
  type Workspace,
} from '@pdf-editor/document-model';
import type {
  OcrLayerPlan,
  OcrPageFacts,
  OcrPageResult,
  OcrQuality,
  OcrRecognizer,
  PdfOcrLayer,
} from '@pdf-editor/engine';

import {
  getEngineService,
  getOcrRecognizers,
  type OcrRecognizerLease,
  toFailure,
} from '../engine/engine-service';
import { m } from '../i18n';
import {
  documentTargets,
  type FactsBySource,
  factsOf,
  languagesKey,
  type OcrTarget,
  scopeTargets,
} from '../ocr/ocr-model';
import { ensureRunLanguages, type OcrRunProgress, recognizeTargets } from '../ocr/ocr-run';
import type { StepNote } from './steps';

/** What the runner needs for OCR: the PDFium worker's layer and the recognizer pool. */
export interface BatchOcr {
  readonly layer: Pick<PdfOcrLayer, 'ocrPageFacts' | 'renderForOcr' | 'applyOcrLayer'>;
  readonly acquire: () => Promise<OcrRecognizerLease>;
}

/**
 * The app's OCR: the PDFium worker the private sources are open in (the engine service's
 * adapter, as `appBatchEngine`) and the app-wide recognizer host.
 */
export async function appBatchOcr(): Promise<BatchOcr> {
  return {
    layer: await getEngineService().ocrLayer(),
    acquire: () => getOcrRecognizers().acquire(),
  };
}

/** The languages could not be made ready: the batch does not start. */
export class BatchOcrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BatchOcrError';
  }
}

/** A batch's hold on the recognizer, its languages ready. Release it when the run ends. */
export interface BatchOcrSession {
  readonly recognizer: Pick<OcrRecognizer, 'recognize'>;
  readonly layer: BatchOcr['layer'];
  /** Idempotent. */
  release(): void;
}

/** Every language of the recipe's OCR steps, first-seen order (ensured once per batch). */
export function recipeOcrLanguages(steps: readonly { readonly options: RecipeOcrOptions }[]) {
  const out: string[] = [];
  for (const step of steps) {
    for (const code of step.options.languages) if (!out.includes(code)) out.push(code);
  }
  return out;
}

/**
 * Takes the recognizer lease and ensures `languages` (downloading what the device lacks,
 * once). Throws `BatchOcrError` when that fails, an `aborted` failure when `signal` fired;
 * the lease is released on any failure.
 */
export async function openBatchOcr(
  ocr: BatchOcr,
  languages: readonly string[],
  control: {
    readonly signal?: AbortSignal;
    readonly onProgress?: (progress: OcrRunProgress) => void;
  } = {},
): Promise<BatchOcrSession> {
  const signal = control.signal ?? new AbortController().signal;
  let lease: OcrRecognizerLease;
  try {
    lease = await ocr.acquire();
  } catch (error) {
    throw new BatchOcrError(
      m.batch_error_ocr_start({ reason: toFailure(error).message || String(error) }),
    );
  }
  try {
    await ensureRunLanguages(lease.recognizer, languages, {
      signal,
      onProgress: control.onProgress ?? (() => undefined),
    });
  } catch (error) {
    lease.release();
    if (signal.aborted || toFailure(error).code === 'aborted') throw error;
    throw new BatchOcrError(
      m.batch_error_ocr_languages({
        languages: languagesKey(languages),
        reason: toFailure(error).message,
      }),
    );
  }
  return { recognizer: lease.recognizer, layer: ocr.layer, release: () => lease.release() };
}

// ---------------------------------------------------------------------------
// Pure parts
// ---------------------------------------------------------------------------

/**
 * The pages of `doc` (one source, the private one) the step recognises: the document's
 * source pages (a page shown twice counts once, blank and image pages have no PDF page to
 * write on) that the scope picks, in document order.
 */
export function ocrStepTargets(
  doc: VirtualDocument,
  facts: FactsBySource,
  scope: RecipeOcrOptions['scope'],
): OcrTarget[] {
  return scopeTargets(documentTargets(doc), scope, { facts, currentPage: 0, range: null }) ?? [];
}

/** The layer plan of one file: its recognised pages in page order and the replace mode. */
export function ocrStepPlan(
  results: readonly OcrPageResult[],
  replace: RecipeOcrReplace,
): OcrLayerPlan {
  return { pages: [...results].sort((a, b) => a.pageIndex - b.pageIndex), replace };
}

/**
 * Recognised pages whose earlier invisible text stays next to the new layer (their words
 * may then be found twice): another tool's text unless all invisible text is replaced, and
 * this app's own layer only when the step keeps everything.
 */
export function keptInvisiblePages(
  targets: readonly OcrTarget[],
  facts: FactsBySource,
  replace: RecipeOcrReplace,
): number {
  if (replace === 'all-invisible') return 0;
  return targets.filter((target) => {
    const f = factsOf(facts, target);
    if (!f) return false;
    if (f.invisibleText === 'foreign') return true;
    return replace === 'none' && (f.ourLayer || f.invisibleText === 'ours');
  }).length;
}

/** 1-based page numbers as a list ("1, 2, 5"). */
export function pageList(indices: readonly number[]): string {
  return [...indices]
    .sort((a, b) => a - b)
    .map((i) => String(i + 1))
    .join(', ');
}

const QUALITIES: readonly OcrQuality[] = ['good', 'review', 'poor', 'no-text'];

function qualityLabel(quality: OcrQuality): string {
  switch (quality) {
    case 'good':
      return m.ocr_quality_good();
    case 'review':
      return m.ocr_quality_review();
    case 'poor':
      return m.ocr_quality_poor();
    case 'no-text':
      return m.ocr_quality_no_text();
  }
}

/** What one file's OCR step did, for its notes. */
export interface OcrStepOutcome {
  /** Source page indices recognised. */
  readonly pages: readonly number[];
  readonly languages: readonly string[];
  readonly byQuality: Readonly<Record<OcrQuality, number>>;
  /** Source page indices where no word was kept (blank, another language, timed out). */
  readonly withoutText: readonly number[];
  /** Pages the 40 MP cap rendered below the recipe's resolution. */
  readonly reducedDpi: number;
  /** Recognised pages that keep earlier invisible text next to the new layer. */
  readonly keptInvisible: number;
}

/** The per-file notes of an OCR step (every run gets the first one). */
export function ocrStepNotes(outcome: OcrStepOutcome): StepNote[] {
  if (outcome.pages.length === 0) {
    return [{ code: 'ocr.nothing', message: m.batch_notice_ocr_nothing() }];
  }
  const quality = QUALITIES.filter((q) => outcome.byQuality[q] > 0)
    .map((q) => `${qualityLabel(q)} ${String(outcome.byQuality[q])}`)
    .join(', ');
  const notes: StepNote[] = [
    {
      code: 'ocr.pages',
      message: m.batch_notice_ocr_pages({
        count: outcome.pages.length,
        pages: pageList(outcome.pages),
        languages: languagesKey(outcome.languages),
        quality,
      }),
    },
  ];
  if (outcome.withoutText.length > 0) {
    notes.push({
      code: 'ocr.without-text',
      message: m.batch_notice_ocr_without_text({ pages: pageList(outcome.withoutText) }),
    });
  }
  if (outcome.reducedDpi > 0) {
    notes.push({
      code: 'ocr.reduced-dpi',
      message: m.batch_notice_ocr_reduced_dpi({ count: outcome.reducedDpi }),
    });
  }
  if (outcome.keptInvisible > 0) {
    notes.push({
      code: 'ocr.kept-invisible',
      message: m.batch_notice_ocr_kept_invisible({ count: outcome.keptInvisible }),
    });
  }
  return notes;
}

// ---------------------------------------------------------------------------
// One file
// ---------------------------------------------------------------------------

export interface OcrStepInput {
  readonly workspace: Workspace;
  readonly documentId: DocumentId;
  /** The private source (the file's only source). */
  readonly source: SourceId;
  readonly options: RecipeOcrOptions;
}

/**
 * Recognises the file's pages and writes the layer (see the module comment). Resolves to
 * the workspace with the recorded `ocr.apply` edit (unchanged when no page needed OCR) and
 * the notes; throws an `aborted` failure when cancelled (nothing applied) and the engine's
 * error when the layer could not be written or verified.
 */
export async function runOcrStep(
  session: BatchOcrSession,
  input: OcrStepInput,
  control: {
    readonly signal?: AbortSignal;
    readonly onProgress?: (done: number, total: number) => void;
  } = {},
): Promise<{ readonly workspace: Workspace; readonly notes: StepNote[] }> {
  const { workspace, documentId, source, options } = input;
  const signal = control.signal ?? new AbortController().signal;
  const replace = options.replace ?? RECIPE_DEFAULT_OCR_REPLACE;
  const facts: FactsBySource = new Map<SourceId, readonly OcrPageFacts[]>([
    [source, await session.layer.ocrPageFacts(source, { signal })],
  ]);
  const doc = getDocument(workspace, documentId);
  const targets = ocrStepTargets(doc, facts, options.scope).filter((t) => t.source === source);
  const outcome = (results: readonly OcrPageResult[], reducedDpi: number): OcrStepOutcome => {
    const byQuality: Record<OcrQuality, number> = { good: 0, review: 0, poor: 0, 'no-text': 0 };
    for (const result of results) byQuality[result.quality] += 1;
    return {
      pages: results.map((r) => r.pageIndex),
      languages: options.languages,
      byQuality,
      withoutText: results.filter((r) => r.words.length === 0).map((r) => r.pageIndex),
      reducedDpi,
      keptInvisible: keptInvisiblePages(targets, facts, replace),
    };
  };
  if (targets.length === 0) return { workspace, notes: ocrStepNotes(outcome([], 0)) };

  const { results, reducedDpi } = await recognizeTargets(
    targets,
    {
      recognizer: session.recognizer,
      layer: session.layer,
      languages: options.languages,
      dpiOf: () => options.dpi,
    },
    {
      signal,
      onProgress: (progress) => {
        if (progress.phase === 'recognize' && progress.total !== undefined) {
          control.onProgress?.(progress.done ?? 0, progress.total);
        }
      },
    },
  );
  const { applyOcrEdit, ocrApplyEdit } = await import('@pdf-editor/engine');
  const edit = ocrApplyEdit(globalThis.crypto.randomUUID(), source, ocrStepPlan(results, replace));
  // The layered document replaces the private source in the worker (verified there first);
  // the recorded payload is the rounded one the engine wrote, as the edit runner keeps it.
  const { payload } = await applyOcrEdit(session.layer, edit, { signal });
  return {
    workspace: { ...workspace, engineEdits: [...workspace.engineEdits, { ...edit, payload }] },
    notes: ocrStepNotes(outcome(results, reducedDpi)),
  };
}
