/**
 * Wire protocol between `createSignatureProxy` (caller thread) and `signature.worker.ts`.
 * As in the assembler and compress protocols, failures travel as values (Comlink drops
 * `EngineError.code` and `SigningError.reason`), progress as a Comlink proxy (released by the
 * worker after the call) and cancellation as a message on a transferred MessagePort.
 */
import type {
  EngineErrorCode,
  ProgressCallback,
  SignatureReport,
  SigningFailureReason,
  SignRequest,
  SignResult,
} from '../types';

export type SignatureWire<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly code: EngineErrorCode;
      readonly message: string;
      /** Present for `SigningError`s. */
      readonly reason?: SigningFailureReason;
    };

export interface SignatureWorkerApi {
  /** Validates (transferred) bytes. Never fails for damaged files; only on abort. */
  validate(
    bytes: ArrayBuffer,
    password: string | undefined,
    abortPort?: MessagePort,
  ): Promise<SignatureWire<readonly SignatureReport[]>>;
  /** The file cut at the end of `revision` (1-based), transferred back. */
  revisionBytes(bytes: ArrayBuffer, revision: number): Promise<SignatureWire<ArrayBuffer>>;
  /** Signs (transferred) bytes; the request's .p12 buffer is transferred too and wiped. */
  sign(
    bytes: ArrayBuffer,
    request: SignRequest,
    onProgress?: ProgressCallback,
    abortPort?: MessagePort,
  ): Promise<SignatureWire<SignResult>>;
}

/** Message posted on the abort port. */
export const SIGNATURE_ABORT_MESSAGE = 'abort';
