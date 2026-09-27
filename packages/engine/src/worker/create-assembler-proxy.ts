/**
 * Wraps an assembly Worker (constructed by the app, keeping bundler-specific code out of
 * this package) as a `PdfAssembler`. Source and blob ArrayBuffers are *transferred* to the
 * worker: they are detached in the caller after `assemble` is called, so pass copies if the
 * caller still needs them. The result bytes are transferred back.
 */

import { proxy, releaseProxy, transfer, wrap } from 'comlink';

import {
  type AssemblyInput,
  type AssemblyOptions,
  type AssemblyResult,
  EngineError,
  type InspectOptions,
  type PdfAssembler,
  type SourceInspection,
  type SourceInspector,
} from '../types';
import {
  ABORT_MESSAGE,
  type AssemblerWorkerApi,
  type WireAssemblyOptions,
} from './assembler-protocol';

export interface AssemblerProxy extends PdfAssembler, SourceInspector {
  /** One label per page, or undefined when the file has no /PageLabels. */
  getPageLabels(
    bytes: ArrayBuffer,
    options?: InspectOptions,
  ): Promise<readonly string[] | undefined>;
  /** Releases the Comlink proxy and terminates the worker. */
  dispose(): void;
}

export function createAssemblerProxy(worker: Worker): AssemblerProxy {
  const remote = wrap<AssemblerWorkerApi>(worker);
  return {
    async assemble(input: AssemblyInput, options: AssemblyOptions = {}): Promise<AssemblyResult> {
      const { signal, onProgress, ...rest } = options;
      if (signal?.aborted) {
        throw new EngineError('aborted', 'assemble aborted', { cause: signal.reason });
      }
      const wire: WireAssemblyOptions = rest;
      const buffers = new Set<ArrayBuffer>([...input.sources.values(), ...input.blobs.values()]);
      let channel: MessageChannel | undefined;
      let onAbort: (() => void) | undefined;
      if (signal) {
        channel = new MessageChannel();
        const port = channel.port1;
        onAbort = () => port.postMessage(ABORT_MESSAGE);
        signal.addEventListener('abort', onAbort, { once: true });
      }
      const transferables: Transferable[] = [...buffers];
      if (channel) transferables.push(channel.port2);
      try {
        const reply = await remote.assemble(
          transfer(input, transferables),
          wire,
          onProgress ? proxy(onProgress) : undefined,
          channel?.port2,
        );
        if (!reply.ok) {
          throw new EngineError(reply.code, reply.message);
        }
        return reply.result;
      } finally {
        if (onAbort) signal?.removeEventListener('abort', onAbort);
        channel?.port1.close();
      }
    },
    /** `bytes` are transferred (detached in the caller). */
    async inspect(bytes: ArrayBuffer, options: InspectOptions = {}): Promise<SourceInspection> {
      if (options.signal?.aborted) {
        throw new EngineError('aborted', 'inspect aborted', { cause: options.signal.reason });
      }
      return remote.inspect(transfer(bytes, [bytes]), options.password);
    },
    async getPageLabels(bytes: ArrayBuffer, options: InspectOptions = {}) {
      return (await this.inspect(bytes, options)).pageLabels;
    },
    dispose(): void {
      remote[releaseProxy]();
      worker.terminate();
    },
  };
}
