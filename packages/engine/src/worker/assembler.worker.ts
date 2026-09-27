/**
 * Assembly worker entry. The app constructs it (bundler-specific), e.g. with Vite:
 * `new Worker(new URL('…/assembler.worker.ts', import.meta.url), { type: 'module' })` or
 * `import AssemblerWorker from '@pdf-editor/engine/assembler.worker?worker'`,
 * and wraps it with `createAssemblerProxy`.
 */

import { expose, transfer } from 'comlink';

import { PdfLibAssembler } from '../pdflib/pdflib-assembler';
import { type AssemblyInput, EngineError, type ProgressCallback } from '../types';
import {
  ABORT_MESSAGE,
  type AssemblerWorkerApi,
  type WireAssemblyOptions,
  type WireResult,
} from './assembler-protocol';

const assembler = new PdfLibAssembler();

const api: AssemblerWorkerApi = {
  async assemble(
    input: AssemblyInput,
    options: WireAssemblyOptions,
    onProgress?: ProgressCallback,
    abortPort?: MessagePort,
  ): Promise<WireResult> {
    const controller = new AbortController();
    if (abortPort) {
      abortPort.onmessage = (event: MessageEvent) => {
        if (event.data === ABORT_MESSAGE) controller.abort();
      };
    }
    try {
      const result = await assembler.assemble(input, {
        ...options,
        signal: controller.signal,
        ...(onProgress
          ? { onProgress: (done: number, total: number) => onProgress(done, total) }
          : {}),
      });
      return transfer({ ok: true, result }, [result.bytes]);
    } catch (error) {
      if (error instanceof EngineError) {
        return { ok: false, code: error.code, message: error.message };
      }
      return {
        ok: false,
        code: 'internal',
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      abortPort?.close();
    }
  },
  inspect(bytes: ArrayBuffer, password?: string) {
    return assembler.inspect(bytes, password === undefined ? {} : { password });
  },
  async finalizeAnnotations(bytes, request) {
    try {
      const out = await assembler.finalizeAnnotations(bytes, request);
      return transfer({ ok: true as const, bytes: out }, [out]);
    } catch (error) {
      return {
        ok: false as const,
        code: error instanceof EngineError ? error.code : 'internal',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  },
  checkAnnotations(bytes, options) {
    return assembler.checkAnnotations(bytes, options);
  },
};

expose(api);
