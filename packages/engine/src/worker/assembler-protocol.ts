/**
 * Wire protocol between `createAssemblerProxy` (caller thread) and `assembler.worker.ts`.
 * Functions and AbortSignals cannot be structured-cloned, so progress travels as a Comlink
 * proxy and cancellation as a message on a transferred MessagePort.
 */

import type {
  AnnotationConformanceReport,
  AnnotationFinalizeRequest,
  AssemblyInput,
  AssemblyOptions,
  AssemblyResult,
  EngineErrorCode,
  ProgressCallback,
  SourceInspection,
} from '../types';

/** AssemblyOptions minus the parts that cannot cross a thread boundary. */
export type WireAssemblyOptions = Omit<AssemblyOptions, 'signal' | 'onProgress'>;

export interface AssemblerWorkerApi {
  assemble(
    input: AssemblyInput,
    options: WireAssemblyOptions,
    onProgress?: ProgressCallback,
    abortPort?: MessagePort,
  ): Promise<WireResult>;
  /** Reads page labels and /Lang from (transferred) bytes. Never rejects. */
  inspect(bytes: ArrayBuffer, password?: string): Promise<SourceInspection>;
  /** Annotation post-pass of `PdfEditor.save()` on (transferred) bytes. */
  finalizeAnnotations(
    bytes: ArrayBuffer,
    request: AnnotationFinalizeRequest,
  ): Promise<{ readonly ok: true; readonly bytes: ArrayBuffer } | WireFailure>;
  /** `checkAnnotationConformance` on (transferred) bytes. */
  checkAnnotations(
    bytes: ArrayBuffer,
    options: { readonly ids?: readonly string[]; readonly password?: string },
  ): Promise<AnnotationConformanceReport>;
}

export interface WireFailure {
  readonly ok: false;
  readonly code: EngineErrorCode;
  readonly message: string;
}

/**
 * Comlink serializes thrown errors as { name, message, stack } only, losing
 * `EngineError.code`; failures therefore travel as values.
 */
export type WireResult =
  | { readonly ok: true; readonly result: AssemblyResult }
  | { readonly ok: false; readonly code: EngineErrorCode; readonly message: string };

/** Message posted on the abort port. */
export const ABORT_MESSAGE = 'abort';
