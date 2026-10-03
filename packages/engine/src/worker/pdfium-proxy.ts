/**
 * Wraps the PDFium worker (constructed by the app, keeping bundler-specific code out of this
 * package) as the viewer's `PdfRenderer` + `PdfEditor` + `PdfVerifier`: a drop-in for a
 * `PdfiumAdapter` on the caller's thread (ADR-0011 §1), plus the worker's `PdfTextEditor`
 * and `PdfImageEditor`.
 *
 * - `open` *transfers* its ArrayBuffer (detached in the caller), as `PdfRenderer` documents;
 *   `verify` copies. Render bitmaps and saved bytes are transferred back.
 * - Cancellation mirrors the adapter: when the signal fires, the call rejects at once with
 *   `EngineError('aborted')` and the worker is told on a MessagePort; a bitmap that still
 *   arrives for an aborted render is closed.
 * - `applyRedactionPlan` rejects with a `RedactionFailedError` (stage and reports rebuilt
 *   from the wire) when the gate or the self-check stops it; its result bytes are
 *   transferred. `verifyRedactedOutput` copies its bytes, as `verify` does.
 * - `destroy()`/`dispose()` terminate the worker; calls still pending reject with
 *   `EngineError('aborted')`, later calls with `EngineError('internal')`.
 */
import type { FontFallbackConfig } from '@embedpdf/engines';
import type { SourceId } from '@pdf-editor/document-model';
import { proxy, releaseProxy, transfer, wrap } from 'comlink';

import { abortedError } from '../pdfium/task-bridge';
import { RedactionFailedError } from '../redaction/apply';
import {
  type EngineCallOptions,
  EngineError,
  type PdfEditor,
  type PdfRedactor,
  type PdfRenderer,
  type PdfImageEditor,
  type PdfOcrLayer,
  type PdfTextEditor,
  type PdfVerifier,
  type RenderResult,
  type SourceInspector,
} from '../types';
import {
  type InspectorBridge,
  PDFIUM_ABORT_MESSAGE,
  type PdfiumWorkerApi,
  type Wire,
} from './pdfium-protocol';

export interface PdfiumProxyOptions {
  /**
   * URL of `pdfium.wasm` (e.g. Vite `?url` import of `@embedpdf/pdfium/pdfium.wasm`).
   * Relative URLs are resolved against `location` here, before they reach the worker.
   */
  readonly wasmUrl: string;
  /** As `PdfiumAdapterOptions.fontFallback`; must be cloneable (no `fontLoader`). */
  readonly fontFallback?: FontFallbackConfig | null;
  /**
   * Reads page labels and /Lang and runs the annotation post-pass (in the app: the assembly
   * worker's `AssemblerProxy`). The PDFium worker reaches it through this thread; bytes are
   * transferred on both hops.
   */
  readonly inspector?: SourceInspector;
}

export interface PdfiumProxy
  extends PdfRenderer,
    PdfEditor,
    PdfVerifier,
    PdfTextEditor,
    PdfImageEditor,
    PdfRedactor,
    PdfOcrLayer {
  getAnnotationAppearance(
    id: SourceId,
    pageIndex: number,
    annotationId: string,
    options?: EngineCallOptions,
  ): Promise<Blob>;
  /** Terminates the worker (the adapter's `destroy`, for `EngineService`). */
  destroy(): Promise<void>;
  /** Releases the Comlink proxy and terminates the worker. */
  dispose(): void;
}

const ok = <T>(value: T): Wire<T> => ({ ok: true, value });

function failure(error: unknown): Wire<never> {
  if (error instanceof EngineError) return { ok: false, code: error.code, message: error.message };
  return {
    ok: false,
    code: 'internal',
    message: error instanceof Error ? error.message : String(error),
  };
}

function unwrap<T>(reply: Wire<T>): T {
  if (!reply.ok) {
    if (reply.redaction) {
      throw new RedactionFailedError(reply.redaction.stage, reply.message, reply.redaction.failure);
    }
    throw new EngineError(reply.code, reply.message);
  }
  return reply.value;
}

/** Splits the non-cloneable signal off call options. */
function split<O extends EngineCallOptions>(
  options: O | undefined,
): { signal: AbortSignal | undefined; wire: Omit<O, 'signal'> } {
  const { signal, ...wire } = options ?? ({} as O);
  return { signal, wire };
}

function resolveUrl(url: string): string {
  const base = (globalThis as { location?: { href: string } }).location?.href;
  return base === undefined ? url : new URL(url, base).href;
}

function inspectorBridge(inspector: SourceInspector): InspectorBridge {
  return {
    async inspect(bytes, password) {
      try {
        return ok(await inspector.inspect(bytes, password === undefined ? {} : { password }));
      } catch (error) {
        return failure(error);
      }
    },
    async finalizeAnnotations(bytes, request) {
      try {
        if (!inspector.finalizeAnnotations) {
          throw new EngineError('internal', 'The inspector has no annotation post-pass');
        }
        const out = await inspector.finalizeAnnotations(bytes, request);
        return transfer(ok(out), [out]);
      } catch (error) {
        return failure(error);
      }
    },
    async checkAnnotations(bytes, options) {
      try {
        if (!inspector.checkAnnotations) {
          throw new EngineError('internal', 'The inspector has no conformance check');
        }
        return ok(await inspector.checkAnnotations(bytes, options));
      } catch (error) {
        return failure(error);
      }
    },
  };
}

export function createPdfiumProxy(worker: Worker, options: PdfiumProxyOptions): PdfiumProxy {
  const remote = wrap<PdfiumWorkerApi>(worker);
  const { inspector } = options;
  const ready = remote.configure(
    {
      wasmUrl: resolveUrl(options.wasmUrl),
      ...(options.fontFallback === undefined ? {} : { fontFallback: options.fontFallback }),
    },
    inspector ? proxy(inspectorBridge(inspector)) : undefined,
    {
      finalizeAnnotations: typeof inspector?.finalizeAnnotations === 'function',
      checkAnnotations: typeof inspector?.checkAnnotations === 'function',
    },
  );
  // Surfaced by the first call that awaits it.
  ready.catch(() => undefined);

  let terminated = false;
  const pending = new Set<(error: EngineError) => void>();

  /**
   * One worker call: rejects at once when `signal` fires (and tells the worker), otherwise
   * settles with the worker's reply. `discard` releases a value that arrives too late.
   */
  function invoke<T>(
    op: string,
    signal: AbortSignal | undefined,
    start: (abortPort: MessagePort | undefined) => Promise<Wire<T>>,
    discard?: (value: T) => void,
  ): Promise<T> {
    if (terminated) {
      return Promise.reject(new EngineError('internal', `${op}: the PDFium worker was destroyed`));
    }
    if (signal?.aborted) return Promise.reject(abortedError(op, signal.reason));
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let channel: MessageChannel | undefined;
      let onAbort: (() => void) | undefined;
      const finish = (): boolean => {
        if (settled) return false;
        settled = true;
        pending.delete(kill);
        if (onAbort) signal?.removeEventListener('abort', onAbort);
        return true;
      };
      const kill = (error: EngineError): void => {
        if (finish()) reject(error);
      };
      pending.add(kill);
      if (signal) {
        channel = new MessageChannel();
        const port = channel.port1;
        onAbort = () => {
          port.postMessage(PDFIUM_ABORT_MESSAGE);
          if (finish()) reject(abortedError(op, signal.reason));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
      ready
        .then(() => start(channel?.port2))
        .then(
          (reply) => {
            if (!finish()) {
              if (reply.ok) discard?.(reply.value);
              return;
            }
            try {
              resolve(unwrap(reply));
            } catch (error) {
              reject(error instanceof Error ? error : new Error(String(error)));
            }
          },
          (error: unknown) => {
            if (finish()) {
              reject(
                error instanceof EngineError
                  ? error
                  : new EngineError(
                      'internal',
                      `${op} failed: ${error instanceof Error ? error.message : String(error)}`,
                      { cause: error },
                    ),
              );
            }
          },
        )
        .finally(() => channel?.port1.close());
    });
  }

  /** `port` goes in the transfer list when there is one. */
  const withPort = <T>(value: T, port: MessagePort | undefined, more: Transferable[] = []): T =>
    port || more.length > 0 ? transfer(value, port ? [...more, port] : more) : value;

  const terminate = (): void => {
    if (terminated) return;
    terminated = true;
    for (const kill of [...pending]) {
      kill(new EngineError('aborted', 'The PDFium worker was destroyed'));
    }
    remote[releaseProxy]();
    worker.terminate();
  };

  return {
    open(id, bytes, callOptions) {
      const { signal, wire } = split(callOptions);
      return invoke('open', signal, (port) =>
        remote.open(id, withPort(bytes, port, [bytes]), wire, port),
      );
    },
    close(id) {
      return invoke('close', undefined, async () => remote.close(id)).then(() => undefined);
    },
    renderPage(id, pageIndex, renderOptions) {
      const { signal, wire } = split(renderOptions);
      return invoke<RenderResult>(
        'renderPage',
        signal,
        (port) => remote.renderPage(id, pageIndex, wire, withPort(port, port)),
        (late) => {
          late.bitmap.close();
        },
      );
    },
    getPageText(id, pageIndex, callOptions) {
      const { signal, wire } = split(callOptions);
      return invoke('getPageText', signal, (port) =>
        remote.getPageText(id, pageIndex, wire, withPort(port, port)),
      );
    },
    search(id, query, searchOptions) {
      const { signal, wire } = split(searchOptions);
      const { onProgress, ...rest } = wire;
      return invoke('search', signal, (port) =>
        remote.search(
          id,
          query,
          rest,
          onProgress ? proxy(onProgress) : undefined,
          withPort(port, port),
        ),
      );
    },
    listAnnotations(id, pageIndex, callOptions) {
      const { signal, wire } = split(callOptions);
      return invoke('listAnnotations', signal, (port) =>
        remote.listAnnotations(id, pageIndex, wire, withPort(port, port)),
      );
    },
    createAnnotation(id, annotation, callOptions) {
      const { signal, wire } = split(callOptions);
      return invoke('createAnnotation', signal, (port) =>
        remote.createAnnotation(id, annotation, wire, withPort(port, port)),
      );
    },
    updateAnnotation(id, annotation, callOptions) {
      const { signal, wire } = split(callOptions);
      return invoke('updateAnnotation', signal, (port) =>
        remote.updateAnnotation(id, annotation, wire, withPort(port, port)),
      );
    },
    deleteAnnotation(id, pageIndex, annotationId, callOptions) {
      const { signal, wire } = split(callOptions);
      return invoke('deleteAnnotation', signal, (port) =>
        remote.deleteAnnotation(id, pageIndex, annotationId, wire, withPort(port, port)),
      ).then(() => undefined);
    },
    getAnnotationAppearance(id, pageIndex, annotationId, callOptions) {
      const { signal, wire } = split(callOptions);
      return invoke('getAnnotationAppearance', signal, (port) =>
        remote.getAnnotationAppearance(id, pageIndex, annotationId, wire, withPort(port, port)),
      );
    },
    listFormFields(id, callOptions) {
      const { signal, wire } = split(callOptions);
      return invoke('listFormFields', signal, (port) =>
        remote.listFormFields(id, wire, withPort(port, port)),
      );
    },
    setFormFieldValue(id, name, value, callOptions) {
      const { signal, wire } = split(callOptions);
      return invoke('setFormFieldValue', signal, (port) =>
        remote.setFormFieldValue(id, name, value, wire, withPort(port, port)),
      ).then(() => undefined);
    },
    applyRedactions(id, callOptions) {
      const { signal, wire } = split(callOptions);
      return invoke('applyRedactions', signal, (port) =>
        remote.applyRedactions(id, wire, withPort(port, port)),
      ).then(() => undefined);
    },
    save(id, saveOptions) {
      const { signal, wire } = split(saveOptions);
      return invoke('save', signal, (port) => remote.save(id, wire, withPort(port, port)));
    },
    verify(bytes, expectation, callOptions) {
      const { signal, wire } = split(callOptions);
      return invoke('verify', signal, (port) =>
        remote.verify(bytes, expectation, wire, withPort(port, port)),
      );
    },
    locateRuns(id, pageIndex, callOptions) {
      const { signal, wire } = split(callOptions);
      return invoke('locateRuns', signal, (port) =>
        remote.locateRuns(id, pageIndex, wire, withPort(port, port)),
      );
    },
    analyzeRun(run, callOptions) {
      const { signal, wire } = split(callOptions);
      return invoke('analyzeRun', signal, (port) =>
        remote.analyzeRun(run, wire, withPort(port, port)),
      );
    },
    analyzeParagraphs(id, pageIndex, callOptions) {
      const { signal, wire } = split(callOptions);
      return invoke('analyzeParagraphs', signal, (port) =>
        remote.analyzeParagraphs(id, pageIndex, wire, withPort(port, port)),
      );
    },
    checkEditability(query, callOptions) {
      const { signal, wire } = split(callOptions);
      return invoke('checkEditability', signal, (port) =>
        remote.checkEditability(query, wire, withPort(port, port)),
      );
    },
    applyTextEdit(request, callOptions) {
      const { signal, wire } = split(callOptions);
      return invoke('applyTextEdit', signal, (port) =>
        remote.applyTextEdit(request, wire, withPort(port, port)),
      );
    },
    locateImages(id, pageIndex, callOptions) {
      const { signal, ...wire } = callOptions ?? {};
      return invoke('locateImages', signal, (port) =>
        remote.locateImages(id, pageIndex, wire, withPort(port, port)),
      );
    },
    extractImage(ref, callOptions) {
      const { signal, ...wire } = callOptions ?? {};
      return invoke('extractImage', signal, (port) =>
        remote.extractImage(ref, wire, withPort(port, port)),
      );
    },
    transformImage(ref, target, callOptions) {
      const { signal, ...wire } = callOptions ?? {};
      return invoke('transformImage', signal, (port) =>
        remote.transformImage(ref, target, wire, withPort(port, port)),
      );
    },
    removeImage(ref, callOptions) {
      const { signal, ...wire } = callOptions ?? {};
      return invoke('removeImage', signal, (port) =>
        remote.removeImage(ref, wire, withPort(port, port)),
      );
    },
    replaceImage(ref, replacement, callOptions) {
      const { signal, ...wire } = callOptions ?? {};
      // Copied to the worker (structured clone); the caller keeps its bytes.
      return invoke('replaceImage', signal, (port) =>
        remote.replaceImage(ref, replacement, wire, withPort(port, port)),
      );
    },
    applyRedactionPlan(id, plan, callOptions) {
      const { signal, wire } = split(callOptions);
      return invoke('applyRedactionPlan', signal, (port) =>
        remote.applyRedactionPlan(id, plan, wire, withPort(port, port)),
      );
    },
    verifyRedactedOutput(bytes, plans, callOptions) {
      const { signal, wire } = split(callOptions);
      return invoke('verifyRedactedOutput', signal, (port) =>
        remote.verifyRedactedOutput(bytes, plans, wire, withPort(port, port)),
      );
    },
    ocrPageFacts(id, callOptions) {
      const { signal, wire } = split(callOptions);
      return invoke('ocrPageFacts', signal, (port) =>
        remote.ocrPageFacts(id, wire, withPort(port, port)),
      );
    },
    renderForOcr(id, pageIndex, renderOptions) {
      const { signal, wire } = split(renderOptions);
      return invoke('renderForOcr', signal, (port) =>
        remote.renderForOcr(id, pageIndex, wire, withPort(port, port)),
      );
    },
    applyOcrLayer(id, plan, callOptions) {
      const { signal, wire } = split(callOptions);
      return invoke('applyOcrLayer', signal, (port) =>
        remote.applyOcrLayer(id, plan, wire, withPort(port, port)),
      );
    },
    destroy() {
      terminate();
      return Promise.resolve();
    },
    dispose() {
      terminate();
    },
  };
}
