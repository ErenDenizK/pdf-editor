/**
 * Bridges EmbedPDF `Task`s to Promises with AbortSignal support and maps EmbedPDF error
 * reasons to our `EngineError` codes.
 */

import {
  PdfErrorCode,
  type PdfErrorReason,
  type Task,
  TaskAbortedError,
  TaskRejectedError,
} from '@embedpdf/models';

import { EngineError, type EngineErrorCode } from '../types';

export interface ErrorContext {
  /** Operation name used in messages. */
  readonly op: string;
  /** For `open`: whether the caller supplied a password (distinguishes required/incorrect). */
  readonly passwordProvided?: boolean;
}

export function abortedError(op: string, cause?: unknown): EngineError {
  return new EngineError('aborted', `${op} aborted`, cause === undefined ? undefined : { cause });
}

export function throwIfAborted(signal: AbortSignal | undefined, op: string): void {
  if (signal?.aborted) {
    throw abortedError(op, signal.reason);
  }
}

function codeFor(reason: PdfErrorReason, ctx: ErrorContext): EngineErrorCode {
  switch (reason.code) {
    case PdfErrorCode.Password:
      return ctx.passwordProvided ? 'password-incorrect' : 'password-required';
    case PdfErrorCode.Security:
      return 'unsupported-encryption';
    case PdfErrorCode.WrongFormat:
    case PdfErrorCode.NotFound:
    case PdfErrorCode.PageError:
    case PdfErrorCode.LoadDoc:
      return 'corrupt';
    case PdfErrorCode.XFALoad:
    case PdfErrorCode.XFALayout:
    case PdfErrorCode.NotSupport:
      return 'unsupported';
    case PdfErrorCode.Cancelled:
      return 'aborted';
    default:
      return 'internal';
  }
}

function isErrorReason(value: unknown): value is PdfErrorReason {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { code?: unknown }).code === 'number'
  );
}

/** Converts anything an EmbedPDF task can reject with into an EngineError. */
export function toEngineError(error: unknown, ctx: ErrorContext): EngineError {
  if (error instanceof EngineError) {
    return error;
  }
  // Duck-typed as well as instanceof: bundlers may load @embedpdf/models twice (once
  // inlined in @embedpdf/engines, once as our dependency), breaking class identity.
  const name = error instanceof Error ? error.name : undefined;
  if (error instanceof TaskAbortedError || name === 'TaskAbortedError') {
    return abortedError(ctx.op, error);
  }
  const wrapped = (error as { reason?: unknown } | null)?.reason;
  const reason =
    error instanceof TaskRejectedError || isErrorReason(wrapped)
      ? wrapped
      : isErrorReason(error)
        ? error
        : undefined;
  if (isErrorReason(reason)) {
    const code = codeFor(reason, ctx);
    return new EngineError(
      code,
      `${ctx.op} failed: ${reason.message} (pdfium code ${reason.code})`,
      {
        cause: error,
      },
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return new EngineError('internal', `${ctx.op} failed: ${message}`, { cause: error });
}

/**
 * Awaits an EmbedPDF task. When `signal` fires, the task is aborted (EmbedPDF removes it from
 * its queue if it has not started) and the promise rejects with `EngineError('aborted')`
 * immediately, even if the worker is still busy with it.
 */
export function runTask<R>(
  task: Task<R, PdfErrorReason>,
  signal: AbortSignal | undefined,
  ctx: ErrorContext,
): Promise<R> {
  if (signal?.aborted) {
    task.abort({ code: PdfErrorCode.Cancelled, message: 'aborted by caller' });
    return Promise.reject(abortedError(ctx.op, signal.reason));
  }
  return new Promise<R>((resolve, reject) => {
    const onAbort = (): void => {
      task.abort({ code: PdfErrorCode.Cancelled, message: 'aborted by caller' });
      reject(abortedError(ctx.op, signal?.reason));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    task.toPromise().then(
      (value) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal?.removeEventListener('abort', onAbort);
        reject(signal?.aborted ? abortedError(ctx.op, error) : toEngineError(error, ctx));
      },
    );
  });
}
