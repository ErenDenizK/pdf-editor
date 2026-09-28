/**
 * The batch runner (spec §5, ADR-0014 §5): a recipe over many files.
 *
 * For each file of the plan: open it privately (private-source.ts; never a tab, the
 * password asked on demand), build a private `Workspace` with that one source, apply the
 * steps in order as model operations (steps.ts), write it through the normal export
 * pipeline (`prepareExport`, with injected dependencies that point at the private
 * workspace, source and blobs), check the verification, and collect the output and every
 * honesty line into a `RecipeRunReport`. Then the source closes and its blobs go.
 *
 * - **Isolation:** a file that fails (password skipped, damaged, a step that cannot apply,
 *   verification) is reported and the batch goes on.
 * - **Concurrency:** the plan's (one file at a time with OCR, else two); one with a
 *   continuous Bates step, whose numbers depend on the files before.
 * - **Cancel:** the signal stops the files in progress and no further file starts; files
 *   not started are reported as skipped (`cancelled`).
 * - **Secrets:** the run-time passwords (the output password asked once per batch, the
 *   passwords of encrypted inputs) live in memory for the run only and never enter the
 *   report.
 * - **Memory:** outputs are Blobs (the browser may keep them on disk) with their CRC-32
 *   computed once for the ZIP; the export's buffers are released as soon as they are.
 *
 * Dependency injection: `BatchRunnerDependencies` names the engine (the PDFium worker
 * proxy, `appBatchEngine`), the assembler, the compressor, the export pipeline and the
 * rasterizer; tests replace any of them.
 */
import {
  type BlobId,
  checkRecipeInputs,
  createRandomIdGenerator,
  addSource,
  createWorkspace,
  doneStatus,
  getDocument,
  type RecipeFailureReason,
  type RecipeFileOutcome,
  type RecipeNotice,
  type RecipeRunPlan,
  type RecipeRunReport,
  recipeRunTotals,
  type RecipeRuntimeValues,
  type RecipeStepKind,
  type SourceId,
} from '@pdf-editor/document-model';
import type { PdfAssembler } from '@pdf-editor/engine';

import { getAssembler } from '../engine/assembler-client';
import { type EngineFailureCode, type EngineResult, toFailure } from '../engine/engine-service';
import {
  type ExportDependencies,
  type ExportOptions,
  type ExportPhase,
  prepareExport,
} from '../export/export-service';
import { summarizeReport } from '../export/summary';
import { m } from '../i18n';
import { compressExport, type ExportCompressor } from '../tools/export-compression';
import { rasterizeWorkspaceDocument } from '../tools/rasterize';
import { pageBoxIn } from '../crop/plan';
import {
  appBatchEngine,
  type BatchEngine,
  openPrivateSource,
  type PrivateSource,
  SourceOpenError,
  type SourcePasswordPrompt,
} from './private-source';
import { applyRecipeStep, DEFAULT_OUTPUT, type StepNote, type StepState, StepError } from './steps';
import { type ZipEntry, zipEntry } from './zip';

export interface BatchRunnerDependencies {
  readonly engine: () => Promise<BatchEngine>;
  readonly assembler: () => Promise<PdfAssembler>;
  readonly compress?: ExportCompressor;
  readonly prepare?: typeof prepareExport;
  readonly rasterize?: typeof rasterizeWorkspaceDocument;
  readonly now?: () => number;
}

export function defaultBatchDependencies(): BatchRunnerDependencies {
  return {
    engine: appBatchEngine,
    assembler: getAssembler,
    compress: compressExport,
    prepare: prepareExport,
    rasterize: rasterizeWorkspaceDocument,
  };
}

/** Where a file is in the run (the progress list). */
export type BatchFilePhase =
  | 'queued'
  | 'opening'
  | 'steps'
  | 'exporting'
  | 'done'
  | 'done-with-notes'
  | 'failed'
  | 'skipped';

export interface BatchFileState {
  /** Position in the plan's files. */
  readonly index: number;
  readonly name: string;
  readonly phase: BatchFilePhase;
  /** `steps`: the step being applied. */
  readonly stepIndex?: number;
  readonly exportPhase?: ExportPhase;
  /** Final phases: the outcome as the report lists it. */
  readonly outcome?: RecipeFileOutcome;
}

/** A finished file's output, ready for the ZIP or a download. */
export interface BatchOutput {
  readonly index: number;
  readonly name: string;
  readonly type: string;
  readonly entry: ZipEntry;
}

export interface BatchRunResult {
  readonly report: RecipeRunReport;
  /** In plan order. */
  readonly outputs: readonly BatchOutput[];
}

export interface BatchRunOptions {
  /** The answers to `plan.inputs` (memory only). */
  readonly values?: RecipeRuntimeValues;
  /** Asks for the password of an encrypted input (serialized: one question at a time). */
  readonly askPassword?: SourcePasswordPrompt;
  readonly signal?: AbortSignal;
  readonly onFile?: (state: BatchFileState) => void;
}

/** Thrown when a run cannot start (a blocked plan, missing answers); per-file problems never throw. */
export class BatchRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BatchRunError';
  }
}

/** Mirrors `planRecipeRun`'s file filter: the files it keeps, in order. */
export function keptFiles(files: readonly File[]): File[] {
  return files.filter((file) => /\.pdf$/i.test(file.name) && file.size > 0);
}

function openFailure(code: EngineFailureCode): {
  readonly reason: RecipeFailureReason;
  readonly message: string;
} {
  switch (code) {
    case 'password-cancelled':
    case 'password-required':
    case 'password-incorrect':
      return { reason: 'password', message: m.batch_failure_password() };
    case 'unsupported-encryption':
      return { reason: 'password', message: m.batch_failure_encryption() };
    case 'corrupt':
    case 'unsupported':
    case 'read-failed':
      return { reason: 'corrupt', message: m.batch_failure_corrupt() };
    case 'aborted':
      return { reason: 'aborted', message: m.batch_failure_cancelled() };
    case 'out-of-memory':
    case 'internal':
      return { reason: 'internal', message: m.batch_failure_engine() };
  }
}

/** One lock: tasks run one after another (password questions). */
function serial(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>) => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
}

const ok = <T>(value: T): EngineResult<T> => ({ ok: true, value });

async function engineCall<T>(call: () => Promise<T>): Promise<EngineResult<T>> {
  try {
    return ok(await call());
  } catch (error) {
    return { ok: false, error: toFailure(error) };
  }
}

/** Kinds of steps an image output cannot carry (they only shape the PDF file). */
const PDF_ONLY: readonly RecipeStepKind[] = [
  'flatten',
  'compress',
  'metadata-strip',
  'metadata-set',
  'security',
  'remove-password',
];

/**
 * Runs `plan` over `files` (the same list the plan was made from). Resolves with the report
 * and the outputs; throws `BatchRunError` only when the run cannot start.
 */
export async function runRecipe(
  plan: RecipeRunPlan,
  files: readonly File[],
  options: BatchRunOptions = {},
  deps: BatchRunnerDependencies = defaultBatchDependencies(),
): Promise<BatchRunResult> {
  if (plan.blocked.length > 0) throw new BatchRunError('The recipe has steps this app cannot run');
  const values: RecipeRuntimeValues = options.values ?? new Map();
  if (checkRecipeInputs(plan, values).length > 0) {
    throw new BatchRunError('The recipe needs a password to run');
  }
  const inputs = keptFiles(files);
  if (inputs.length !== plan.files.length) {
    throw new BatchRunError('The files do not match the plan');
  }
  const now = deps.now ?? Date.now;
  const prepare = deps.prepare ?? prepareExport;
  const rasterize = deps.rasterize ?? rasterizeWorkspaceDocument;
  const { signal, onFile } = options;
  const startedAt = now();
  const engine = await deps.engine();
  const ask = options.askPassword;
  const askInTurn = serial();
  const knownPasswords: string[] = [];
  const continuousBates = plan.files[0]?.steps.some((s) => s.continuesFromPreviousFile) === true;
  const concurrency = continuousBates ? 1 : plan.concurrency;
  let batesNumbered = 0;

  const outcomes: (RecipeFileOutcome | undefined)[] = plan.files.map(() => undefined);
  const outputs: (BatchOutput | undefined)[] = plan.files.map(() => undefined);
  const report = (state: BatchFileState) => onFile?.(state);
  for (const file of plan.files) report({ index: file.index, name: file.name, phase: 'queued' });

  const runFile = async (position: number): Promise<void> => {
    const filePlan = plan.files[position];
    const file = inputs[position];
    if (filePlan === undefined || file === undefined) return;
    const { index, name } = filePlan;
    const started = now();
    const notices: RecipeNotice[] = [];
    const finish = (outcome: RecipeFileOutcome) => {
      outcomes[position] = outcome;
      report({
        index,
        name,
        phase: outcome.status === 'skipped' ? 'skipped' : outcome.status,
        outcome,
      });
    };
    const fail = (reason: RecipeFailureReason, message: string, stepIndex?: number) =>
      finish({
        index,
        name,
        status: 'failed',
        inputBytes: file.size,
        notices,
        failure: { reason, message, ...(stepIndex === undefined ? {} : { stepIndex }) },
        durationMs: now() - started,
      });

    report({ index, name, phase: 'opening' });
    let source: PrivateSource;
    try {
      source = await openPrivateSource(engine, file, {
        ...(ask === undefined
          ? {}
          : {
              ask: (request) =>
                askInTurn(() => (signal?.aborted ? Promise.resolve(null) : ask(request))),
            }),
        knownPasswords,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      const code = error instanceof SourceOpenError ? error.code : toFailure(error).code;
      const failure = openFailure(signal?.aborted ? 'aborted' : code);
      fail(failure.reason, failure.message);
      return;
    }
    if (source.password !== undefined && !knownPasswords.includes(source.password)) {
      knownPasswords.push(source.password);
    }
    const blobs = new Map<BlobId, ArrayBuffer>();
    const ids = createRandomIdGenerator();
    try {
      const added = addSource(createWorkspace(), source.input, ids, { sourceId: source.id });
      const documentId = added.documentId;
      let state: StepState = {
        workspace: added.workspace,
        exportOptions: {},
        output: DEFAULT_OUTPUT,
      };
      const stepNotes: {
        readonly stepIndex: number;
        readonly kind: RecipeStepKind;
        note: StepNote;
      }[] = [];
      for (const planned of filePlan.steps) {
        if (signal?.aborted) {
          fail('aborted', m.batch_failure_cancelled());
          return;
        }
        report({ index, name, phase: 'steps', stepIndex: planned.stepIndex });
        const notes: StepNote[] = [];
        try {
          state = applyRecipeStep(
            state,
            planned.step,
            planned.stepIndex,
            {
              documentId,
              pageBox: pageBoxIn(state.workspace, (sourceId: SourceId, page) =>
                sourceId === source.id ? source.cropBox(page) : undefined,
              ),
              batesNumberedBefore: batesNumbered,
              outputPassword: (stepIndex) => {
                const id = filePlan.steps[stepIndex]?.inputs[0];
                return id === undefined ? undefined : values.get(id);
              },
              addBlob: (bytes) => {
                const id = ids.blob();
                blobs.set(id, bytes);
                return id;
              },
            },
            notes,
          );
        } catch (error) {
          const message =
            error instanceof StepError
              ? error.message
              : m.batch_failure_step({
                  reason: error instanceof Error ? error.message : String(error),
                });
          fail('step', message, planned.stepIndex);
          return;
        }
        for (const note of notes) {
          stepNotes.push({ stepIndex: planned.stepIndex, kind: planned.step.kind, note });
        }
      }
      for (const { stepIndex, kind, note } of stepNotes) {
        notices.push({ stepIndex, kind, code: note.code, message: note.message });
      }

      const workspace = state.workspace;
      const exportDeps: ExportDependencies = {
        engine: {
          sourceBytes: (id) =>
            id === source.id
              ? engineCall(() => source.bytes())
              : Promise.resolve({
                  ok: false,
                  error: { code: 'internal', message: `Source ${id} is not open` },
                }),
          saveSource: (id, saveOptions) => engineCall(() => engine.save(id, saveOptions)),
          verify: (bytes, expectation, verifySignal) =>
            engineCall(() =>
              engine.verify(bytes, expectation, verifySignal ? { signal: verifySignal } : {}),
            ),
        },
        assembler: deps.assembler,
        workspace: () => workspace,
        blobs: (id) => blobs.get(id),
        ...(deps.compress ? { compress: deps.compress } : {}),
        compressionFor: () => undefined,
      };
      const onProgress = (progress: { readonly phase: ExportPhase }) =>
        report({ index, name, phase: 'exporting', exportPhase: progress.phase });
      report({ index, name, phase: 'exporting' });

      const output = state.output;
      if (output.format === 'images') {
        const ignored = [
          ...new Set(filePlan.steps.map((s) => s.step.kind).filter((k) => PDF_ONLY.includes(k))),
        ];
        if (ignored.length > 0) {
          notices.push({ code: 'export.images-ignored', message: m.batch_notice_images_ignored() });
        }
        const doc = getDocument(workspace, documentId);
        const raster = await rasterize(
          workspace,
          documentId,
          {
            format: output.imageFormat,
            dpi: output.dpi,
            quality: output.quality,
            background: output.imageFormat === 'jpeg' ? 'white' : output.background,
            pages: doc.pages.map((_, i) => i),
            template: '{title}-{page}',
          },
          signal ? { signal } : {},
          {
            exportDependencies: exportDeps,
            pageCropBox: (sourceId, page) =>
              sourceId === source.id ? source.cropBox(page) : undefined,
          },
        );
        const bytes = await raster.blob.arrayBuffer();
        const single = !raster.name.toLowerCase().endsWith('.zip');
        const extension = single ? raster.name.slice(raster.name.lastIndexOf('.')) : '.zip';
        const outputName = filePlan.outputName.replace(/\.zip$/i, extension);
        outputs[position] = {
          index,
          name: outputName,
          type: raster.type,
          entry: zipEntry(outputName, bytes, raster.type),
        };
        batesNumbered += doc.pages.length;
        finish({
          index,
          name,
          status: doneStatus(notices),
          inputBytes: file.size,
          outputName,
          outputBytes: bytes.byteLength,
          notices,
          durationMs: now() - started,
        });
        return;
      }
      if (output.format !== 'pdf') {
        fail('unavailable', m.batch_failure_unavailable());
        return;
      }

      const exportOptions: ExportOptions = {
        ...state.exportOptions,
        compression: state.exportOptions.compression ?? null,
        ...(signal ? { signal } : {}),
        onProgress,
      };
      const prepared = await prepare(documentId, exportOptions, exportDeps);
      if (!prepared.ok) {
        if (prepared.error.code === 'aborted' || signal?.aborted) {
          fail('aborted', m.batch_failure_cancelled());
        } else {
          fail('internal', prepared.error.message);
        }
        return;
      }
      const result = prepared.value;
      if (!result.verification.ok) {
        fail(
          'verification',
          m.batch_failure_verification({ problems: result.verification.problems.join('; ') }),
        );
        return;
      }
      const stripRequested = filePlan.steps.some((s) => s.step.kind === 'metadata-strip');
      for (const item of summarizeReport(result.report, result.sourceNotes, result.outcome, {
        ...(result.redaction ? { redaction: result.redaction } : {}),
        ...(result.textEdits ? { textEdits: result.textEdits } : {}),
      })) {
        if (item.tone !== 'changed') continue;
        // Stripping what the recipe asked to strip is the result, not a note.
        if (item.id === 'metadata' && stripRequested) continue;
        const details = item.details?.length ? ` (${item.details.join(', ')})` : '';
        notices.push({ code: `export.${item.id}`, message: `${item.text}${details}` });
      }
      if (result.compression && result.compression.after >= result.compression.before) {
        notices.push({ code: 'compress.not-smaller', message: m.batch_notice_not_smaller() });
      }
      outputs[position] = {
        index,
        name: filePlan.outputName,
        type: 'application/pdf',
        entry: zipEntry(filePlan.outputName, result.bytes, 'application/pdf'),
      };
      batesNumbered += result.pageCount;
      finish({
        index,
        name,
        status: doneStatus(notices),
        inputBytes: file.size,
        outputName: filePlan.outputName,
        outputBytes: result.bytes.byteLength,
        notices,
        durationMs: now() - started,
      });
    } catch (error) {
      if (signal?.aborted) fail('aborted', m.batch_failure_cancelled());
      else fail('internal', m.batch_failure_step({ reason: toFailure(error).message }));
    } finally {
      blobs.clear();
      await source.close();
    }
  };

  let next = 0;
  const worker = async () => {
    for (;;) {
      if (signal?.aborted) return;
      const position = next;
      next += 1;
      if (position >= plan.files.length) return;
      await runFile(position);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, plan.files.length) }, worker));
  } finally {
    knownPasswords.length = 0;
  }

  const listed: RecipeFileOutcome[] = plan.files.map((filePlan, position) => {
    const done = outcomes[position];
    if (done !== undefined) return done;
    const skipped: RecipeFileOutcome = {
      index: filePlan.index,
      name: filePlan.name,
      status: 'skipped',
      inputBytes: filePlan.size,
      notices: [],
      skipReason: 'cancelled',
    };
    report({ index: filePlan.index, name: filePlan.name, phase: 'skipped', outcome: skipped });
    return skipped;
  });
  for (const [i, skipped] of plan.skipped.entries()) {
    listed.push({
      index: plan.files.length + i,
      name: skipped.name,
      status: 'skipped',
      // The plan keeps no size for files it left out.
      inputBytes: 0,
      notices: [],
      skipReason: skipped.reason,
    });
  }
  const delivered = outputs.filter((o): o is BatchOutput => o !== undefined);
  return {
    report: {
      recipeName: plan.recipe.name,
      startedAt,
      finishedAt: now(),
      cancelled: signal?.aborted === true,
      delivery: delivered.length > 1 ? 'zip' : 'files',
      files: listed,
      totals: recipeRunTotals(listed),
    },
    outputs: delivered,
  };
}
