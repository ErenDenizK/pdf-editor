/**
 * Wraps the signature Worker (constructed by the app) as the validator and signer of spec
 * §3.3. Input ArrayBuffers — the PDF bytes and the request's .p12 — are *transferred*
 * (detached in the caller); pass copies when the caller still needs them. Results come back
 * transferred. Call `terminate()` after signing: the worker, and every key it imported, ends.
 */
import { proxy, releaseProxy, transfer, wrap } from 'comlink';

import {
  type EngineCallOptions,
  EngineError,
  type SignatureReport,
  SigningError,
  type SignOptions,
  type SignRequest,
  type SignResult,
  type ValidateSignaturesOptions,
} from '../types';
import {
  SIGNATURE_ABORT_MESSAGE,
  type SignatureWire,
  type SignatureWorkerApi,
} from './signature-protocol';

export interface SignatureProxy {
  /** Every signature's report; empty for unsigned files. `bytes` are transferred. */
  validateSignatures(
    bytes: ArrayBuffer,
    options?: ValidateSignaturesOptions,
  ): Promise<readonly SignatureReport[]>;
  /** The file as saved at `revision` (1-based), for "View signed version". Transferred. */
  revisionBytes(
    bytes: ArrayBuffer,
    revision: number,
    options?: EngineCallOptions,
  ): Promise<ArrayBuffer>;
  /**
   * PAdES-B approval signature as one incremental update (`bytes` and `request.pkcs12` are
   * transferred). Rejects with `SigningError` (see `reason`) on a refusal.
   */
  signPdf(bytes: ArrayBuffer, request: SignRequest, options?: SignOptions): Promise<SignResult>;
  /** Releases the Comlink proxy and terminates the worker (and the keys it held). */
  terminate(): void;
}

function unwrap<T>(reply: SignatureWire<T>): T {
  if (reply.ok) return reply.value;
  if (reply.reason) throw new SigningError(reply.reason, reply.message);
  throw new EngineError(reply.code, reply.message);
}

function checkAborted(options: EngineCallOptions | undefined, what: string): void {
  if (options?.signal?.aborted) {
    throw new EngineError('aborted', `${what} aborted`, { cause: options.signal.reason });
  }
}

/** An abort MessageChannel wired to `signal`; `dispose` detaches and closes it. */
function abortChannel(signal: AbortSignal | undefined): {
  port?: MessagePort;
  dispose: () => void;
} {
  if (!signal) return { dispose: () => undefined };
  const channel = new MessageChannel();
  const onAbort = () => {
    channel.port1.postMessage(SIGNATURE_ABORT_MESSAGE);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  return {
    port: channel.port2,
    dispose: () => {
      signal.removeEventListener('abort', onAbort);
      channel.port1.close();
    },
  };
}

export interface SignatureProxyConfig {
  /**
   * The app's self-hosted `pdfium.wasm` (as for the PDFium worker). When set, validation also
   * renders each signed revision and the whole file and reports `visuallyChangedPages`
   * (spec §3.1 step 6); a per-call `ValidateSignaturesOptions.visual` wins.
   */
  readonly pdfiumWasmUrl?: string;
  /** Resolution of that comparison (default 50 dpi). */
  readonly visualDpi?: number;
}

export function createSignatureProxy(
  worker: Worker,
  config: SignatureProxyConfig = {},
): SignatureProxy {
  const remote = wrap<SignatureWorkerApi>(worker);
  const defaultVisual: ValidateSignaturesOptions['visual'] = config.pdfiumWasmUrl
    ? {
        pdfiumWasm: config.pdfiumWasmUrl,
        ...(config.visualDpi === undefined ? {} : { dpi: config.visualDpi }),
      }
    : undefined;
  return {
    async validateSignatures(bytes, options = {}) {
      checkAborted(options, 'Signature validation');
      const abort = abortChannel(options.signal);
      try {
        const transferables: Transferable[] = [bytes];
        if (abort.port) transferables.push(abort.port);
        return unwrap(
          await remote.validate(
            transfer(bytes, transferables),
            options.password,
            abort.port,
            options.visual ?? defaultVisual,
          ),
        );
      } finally {
        abort.dispose();
      }
    },
    async revisionBytes(bytes, revision, options = {}) {
      checkAborted(options, 'Reading the revision');
      return unwrap(await remote.revisionBytes(transfer(bytes, [bytes]), revision));
    },
    async signPdf(bytes, request, options = {}) {
      checkAborted(options, 'Signing');
      const { onProgress, signal } = options;
      const abort = abortChannel(signal);
      try {
        const transferables: Transferable[] = [bytes, request.pkcs12];
        if (abort.port) transferables.push(abort.port);
        return unwrap(
          await remote.sign(
            transfer(bytes, transferables),
            request,
            onProgress ? proxy(onProgress) : undefined,
            abort.port,
          ),
        );
      } finally {
        abort.dispose();
      }
    },
    terminate() {
      remote[releaseProxy]();
      worker.terminate();
    },
  };
}
