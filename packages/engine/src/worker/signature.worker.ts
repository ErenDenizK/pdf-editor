/**
 * Signature worker entry (spec §3, ADR-0013): validation on open and PAdES-B signing. pkijs,
 * asn1js and pdf-lib load only here; a private PDFium (signatures/visual.ts) is instantiated
 * only when a validation asks for the visual comparison of signed revisions. Private keys are imported non-extractable inside this
 * worker and never leave it; the app terminates the worker after signing
 * (`SignatureProxy.terminate`). Construct with Vite's `?worker` import (or
 * `new Worker(new URL(…), { type: 'module' })`) and wrap with `createSignatureProxy`.
 */
import { expose, releaseProxy, type Remote, transfer } from 'comlink';

import { signPdf } from '../signatures/sign';
import { revisionBytes, validateSignatures } from '../signatures/validate';
import { EngineError, SigningError } from '../types';
import {
  SIGNATURE_ABORT_MESSAGE,
  type SignatureWire,
  type SignatureWorkerApi,
} from './signature-protocol';

function failure(error: unknown): SignatureWire<never> {
  if (error instanceof SigningError) {
    return { ok: false, code: error.code, message: error.message, reason: error.reason };
  }
  if (error instanceof EngineError) return { ok: false, code: error.code, message: error.message };
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    code: error instanceof RangeError || /memory/i.test(message) ? 'out-of-memory' : 'internal',
    message,
  };
}

function abortSignal(port: MessagePort | undefined): AbortSignal | undefined {
  if (!port) return undefined;
  const controller = new AbortController();
  port.onmessage = (event: MessageEvent) => {
    if (event.data === SIGNATURE_ABORT_MESSAGE) controller.abort();
  };
  return controller.signal;
}

const api: SignatureWorkerApi = {
  async validate(bytes, password, abortPort, visual) {
    const signal = abortSignal(abortPort);
    try {
      const reports = await validateSignatures(bytes, {
        ...(password === undefined ? {} : { password }),
        ...(signal ? { signal } : {}),
        ...(visual ? { visual } : {}),
      });
      return { ok: true, value: reports };
    } catch (error) {
      return failure(error);
    } finally {
      abortPort?.close();
    }
  },
  revisionBytes(bytes, revision) {
    try {
      const out = revisionBytes(bytes, revision);
      return Promise.resolve(transfer({ ok: true as const, value: out }, [out]));
    } catch (error) {
      return Promise.resolve(failure(error));
    }
  },
  async sign(bytes, request, onProgress, abortPort) {
    const signal = abortSignal(abortPort);
    try {
      const result = await signPdf(bytes, request, {
        ...(signal ? { signal } : {}),
        ...(onProgress
          ? { onProgress: (done: number, total: number) => onProgress(done, total) }
          : {}),
      });
      return transfer({ ok: true as const, value: result }, [result.bytes]);
    } catch (error) {
      return failure(error);
    } finally {
      // The .p12 bytes were transferred here: wipe them (the key itself is non-extractable).
      new Uint8Array(request.pkcs12).fill(0);
      abortPort?.close();
      (onProgress as Remote<(done: number, total: number) => void> | undefined)?.[releaseProxy]();
    }
  },
};

expose(api);
