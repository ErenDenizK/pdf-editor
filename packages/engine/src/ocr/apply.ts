/**
 * Writing an OCR run as invisible text on the hosted engine (spec §1.2, the redaction
 * pattern of ADR-0011 §3): the caller saves the source as it is; foreign invisible text is
 * removed through the raw API in a private scratch document when the plan asks for it; the
 * layer is added with pdf-lib; the result is verified on fresh scratch copies (every word
 * where it was written, the 150 dpi render pixel-identical to the input). Fails closed:
 * `EngineError('internal')` with the problems, never unverified bytes.
 */
import { runTask } from '../pdfium/task-bridge';
import { openScratch, type RedactionHost } from '../redaction/engine-session';
import {
  EngineError,
  type OcrApplyResult,
  type OcrLayerPlan,
  type OcrLayerVerification,
} from '../types';
import { writeOcrLayer } from './layer';
import { removeInvisibleText } from './raw';
import { verifyOcrLayer } from './verify';

/** The part of `HostedEngine` the pipeline uses (the redaction pipeline's). */
export type OcrHost = RedactionHost;

export interface ApplyOcrLayerOptions {
  readonly signal?: AbortSignal;
  /** Written into the layer's `/PdfEditorOCR /Engine` when a page has none. */
  readonly engine?: string;
}

/** A layer that failed its verification: the problems, and the checks. */
export class OcrLayerFailedError extends EngineError {
  constructor(
    message: string,
    readonly verification: OcrLayerVerification,
  ) {
    super('internal', message);
    this.name = 'OcrLayerFailedError';
  }
}

/**
 * Applies `plan` to `input` (unencrypted PDF bytes) and returns the verified layered bytes.
 * `decrypted` is left to the caller (it knows whether the source was encrypted).
 */
export async function applyOcrLayerToBytes(
  host: OcrHost,
  input: ArrayBuffer,
  plan: OcrLayerPlan,
  options: ApplyOcrLayerOptions = {},
): Promise<Omit<OcrApplyResult, 'decrypted'>> {
  const started = performance.now();
  const { signal } = options;
  const scratchOptions = signal ? { signal } : {};
  let bytes = new Uint8Array(input.slice(0));
  let invisibleTextObjects = 0;
  const removalProblems: string[] = [];
  if (plan.replace === 'all-invisible') {
    const scratch = await openScratch(host, bytes, scratchOptions);
    try {
      const pages = plan.pages.map((p) => p.pageIndex);
      const outcome = await host.withRawAccess(
        scratch.id,
        (raw) => pages.map((pageIndex) => ({ pageIndex, ...removeInvisibleText(raw, pageIndex) })),
        scratchOptions,
      );
      for (const { pageIndex, removed, remaining } of outcome) {
        invisibleTextObjects += removed;
        if (remaining > 0) {
          removalProblems.push(
            `Page ${pageIndex + 1}: ${remaining} invisible character(s) could not be removed`,
          );
        }
      }
      if (invisibleTextObjects > 0) {
        bytes = new Uint8Array(
          await runTask(host.engine.saveAsCopy(scratch.doc), signal, { op: 'save' }),
        );
      }
    } finally {
      await scratch.close();
    }
  }
  const written = await writeOcrLayer(
    bytes,
    plan,
    options.engine ? { engine: options.engine } : {},
  );
  const before = await openScratch(host, input, scratchOptions);
  let verification: OcrLayerVerification;
  try {
    const after = await openScratch(host, written.bytes, scratchOptions);
    try {
      verification = await verifyOcrLayer(before, after, plan);
    } finally {
      await after.close();
    }
  } finally {
    await before.close();
  }
  if (removalProblems.length > 0) {
    verification = {
      ...verification,
      problems: [...removalProblems, ...verification.problems],
    };
  }
  if (!verification.ok) {
    throw new OcrLayerFailedError(
      `The OCR layer failed its check: ${verification.problems.join('; ')}`,
      verification,
    );
  }
  const out = written.bytes;
  return {
    bytes:
      out.buffer.byteLength === out.byteLength ? (out.buffer as ArrayBuffer) : out.slice().buffer,
    pages: written.pages,
    wordsWritten: written.wordsWritten,
    wordsSkipped: written.wordsSkipped,
    removed: { ourLayers: written.ourLayersRemoved, invisibleTextObjects },
    verification,
    durationMs: Math.round(performance.now() - started),
  };
}
