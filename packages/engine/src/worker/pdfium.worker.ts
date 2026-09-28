/**
 * PDFium worker entry (ADR-0011 §1): the viewer's engine in our own module worker. It hosts
 * `init` + `PdfiumNative` + `PdfEngine` (pdfium/host), a `PdfiumAdapter` built on that
 * engine, and the M4 editors that need raw access (`PdfTextEditor`, text-edit/;
 * `PdfImageEditor`, image-objects/). WASM is
 * single-threaded and fetched from the app's own origin (no COOP/COEP, no CDN; ADR-0004).
 *
 * The app constructs it (bundler-specific), e.g. with Vite:
 * `new Worker(new URL('…/pdfium.worker.ts', import.meta.url), { type: 'module' })` or
 * `import PdfiumWorker from '@pdf-editor/engine/pdfium.worker?worker'`, and wraps it with
 * `createPdfiumProxy`. The engine (wasm fetch + init) starts as soon as the proxy configures it.
 *
 * Redaction (`PdfRedactor`, ADR-0011 §3) runs here too: `applyRedactionPlan` saves the open
 * source, runs `applyRedactions` in private scratch documents and replaces the open document
 * with the verified bytes, all under the source's exclusive lock; `verifyRedactedOutput`
 * checks export bytes in a scratch document. A `RedactionFailedError` keeps its stage and
 * reports across the boundary (`Wire.redaction`).
 *
 * Every adapter call on a source runs under that source's shared lock, so raw edits
 * (`HostedEngine.withRawAccess`, exclusive) never land between the tasks of one call.
 */
import { expose, releaseProxy, type Remote, transfer } from 'comlink';
import type { SourceId } from '@pdf-editor/document-model';

import { createHostedEngine, type HostedEngine } from '../pdfium/host/hosted-engine';
import { SourceLocks } from '../pdfium/host/source-lock';
import { PdfiumAdapter } from '../pdfium/pdfium-adapter';
import { applyRedactions, RedactionFailedError } from '../redaction/apply';
import { withForensicDeps } from '../redaction/engine-session';
import { verifyRedactedOutput } from '../redaction/verify-output';
import { createImageEditor, type HostedImageEditor } from '../image-objects/editor';
import { createTextEditor, type HostedTextEditor } from '../text-edit/editor';
import { throwIfAborted } from '../pdfium/task-bridge';
import { EngineError, type SearchHit, type SourceInspector } from '../types';
import {
  type InspectorBridge,
  type InspectorCapabilities,
  PDFIUM_ABORT_MESSAGE,
  type PdfiumWorkerApi,
  type PdfiumWorkerConfig,
  type Wire,
} from './pdfium-protocol';

let config: PdfiumWorkerConfig | undefined;
let inspector: SourceInspector | undefined;
let hostPromise: Promise<HostedEngine> | undefined;
let adapter: PdfiumAdapter | undefined;
let textEditor: Promise<HostedTextEditor> | undefined;
let imageEditor: Promise<HostedImageEditor> | undefined;
/** Created before the engine so calls can queue on a source while the WASM loads. */
const locks = new SourceLocks();

function configured(): PdfiumWorkerConfig {
  if (!config) throw new EngineError('internal', 'PDFium worker is not configured');
  return config;
}

/** The hosted engine, created on first use; a failed start is retried on the next call. */
function host(): Promise<HostedEngine> {
  if (!hostPromise) {
    const { wasmUrl, fontFallback } = configured();
    const created = createHostedEngine({
      wasm: wasmUrl,
      fontFallback: fontFallback ?? null,
      locks,
    });
    created.catch(() => {
      if (hostPromise === created) hostPromise = undefined;
    });
    hostPromise = created;
  }
  return hostPromise;
}

function getAdapter(): PdfiumAdapter {
  if (!adapter) {
    const { wasmUrl, fontFallback } = configured();
    adapter = new PdfiumAdapter({
      wasmUrl,
      fontFallback: fontFallback ?? null,
      engineFactory: () => host().then((hosted) => hosted.engine),
      ...(inspector ? { inspector } : {}),
    });
  }
  return adapter;
}

/**
 * The text editor on the hosted engine. Its calls take the source's lock exclusively
 * (`withRawAccess`), so they are not wrapped in `onSource` (the lock is not re-entrant).
 */
function getTextEditor(): Promise<HostedTextEditor> {
  if (!textEditor) {
    const created = host().then((hosted) => createTextEditor(hosted));
    created.catch(() => {
      if (textEditor === created) textEditor = undefined;
    });
    textEditor = created;
  }
  return textEditor;
}

/** The image editor on the hosted engine; like the text editor, not wrapped in `onSource`. */
function getImageEditor(): Promise<HostedImageEditor> {
  if (!imageEditor) {
    const created = host().then((hosted) => createImageEditor(hosted));
    created.catch(() => {
      if (imageEditor === created) imageEditor = undefined;
    });
    imageEditor = created;
  }
  return imageEditor;
}

function failure(error: unknown): Wire<never> {
  if (error instanceof RedactionFailedError) {
    return {
      ok: false,
      code: error.code,
      message: error.message,
      redaction: { stage: error.stage, failure: error.failure },
    };
  }
  if (error instanceof EngineError) return { ok: false, code: error.code, message: error.message };
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    code: error instanceof RangeError || /memory/i.test(message) ? 'out-of-memory' : 'internal',
    message,
  };
}

const ok = <T>(value: T): Wire<T> => ({ ok: true, value });

/** Resolves in a later task, after the messages already queued for this worker. */
function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function unwrap<T>(reply: Wire<T>): T {
  if (!reply.ok) throw new EngineError(reply.code, reply.message);
  return reply.value;
}

/**
 * Runs one call: listens on `abortPort` for cancellation (the signal is passed on only when
 * the caller has one), and turns the result into a `Wire` value, transferring `transferables`.
 */
async function call<T>(
  abortPort: MessagePort | undefined,
  fn: (signal: AbortSignal | undefined) => Promise<T>,
  transferables?: (value: T) => Transferable[],
): Promise<Wire<T>> {
  let signal: AbortSignal | undefined;
  if (abortPort) {
    const controller = new AbortController();
    abortPort.onmessage = (event: MessageEvent) => {
      if (event.data === PDFIUM_ABORT_MESSAGE) controller.abort();
    };
    signal = controller.signal;
  }
  try {
    // Yield once before touching the engine: PDFium work is synchronous and EmbedPDF's queue
    // drains in microtasks, so without this a call already posted runs before the abort
    // message that follows it is even read.
    if (signal) await nextTask();
    const value = await fn(signal);
    return transferables ? transfer(ok(value), transferables(value)) : ok(value);
  } catch (error) {
    return failure(error);
  } finally {
    abortPort?.close();
  }
}

/** An adapter call on `id` under the source's shared lock. */
function onSource<T>(
  id: SourceId,
  signal: AbortSignal | undefined,
  fn: (adapter: PdfiumAdapter) => Promise<T>,
): Promise<T> {
  return locks.run(id, 'shared', () => fn(getAdapter()), signal);
}

const withSignal = <O extends object>(options: O, signal: AbortSignal | undefined) =>
  signal ? { ...options, signal } : options;

/** The caller's inspector behind the bridge, as the adapter's `SourceInspector`. */
function bridgedInspector(
  remote: Remote<InspectorBridge>,
  capabilities: InspectorCapabilities,
): SourceInspector {
  return {
    async inspect(bytes, options = {}) {
      throwIfAborted(options.signal, 'inspect');
      return unwrap(await remote.inspect(transfer(bytes, [bytes]), options.password));
    },
    ...(capabilities.finalizeAnnotations
      ? {
          async finalizeAnnotations(bytes, request, options = {}) {
            throwIfAborted(options.signal, 'save');
            return unwrap(await remote.finalizeAnnotations(transfer(bytes, [bytes]), request));
          },
        }
      : {}),
    ...(capabilities.checkAnnotations
      ? {
          async checkAnnotations(bytes, options = {}, callOptions = {}) {
            throwIfAborted(callOptions.signal, 'verify');
            return unwrap(await remote.checkAnnotations(transfer(bytes, [bytes]), options));
          },
        }
      : {}),
  } satisfies SourceInspector;
}

const api: PdfiumWorkerApi = {
  configure(next, bridge, capabilities) {
    if (adapter) throw new EngineError('internal', 'PDFium worker is already running');
    config = next;
    // The proxy is created on first document open: start fetching and compiling the wasm now,
    // while the caller still reads the file. A failure resurfaces on the first call.
    host().catch(() => undefined);
    inspector = bridge
      ? bridgedInspector(
          bridge as Remote<InspectorBridge>,
          capabilities ?? { finalizeAnnotations: false, checkAnnotations: false },
        )
      : undefined;
  },
  open(id, bytes, options, abortPort) {
    return call(abortPort, (signal) =>
      onSource(id, signal, (a) => a.open(id, bytes, withSignal(options, signal))),
    );
  },
  close(id) {
    return call(undefined, async () => {
      await onSource(id, undefined, (a) => a.close(id));
      return null;
    });
  },
  renderPage(id, pageIndex, options, abortPort) {
    return call(
      abortPort,
      (signal) =>
        onSource(id, signal, (a) => a.renderPage(id, pageIndex, withSignal(options, signal))),
      (result) => [result.bitmap],
    );
  },
  getPageText(id, pageIndex, options, abortPort) {
    return call(abortPort, (signal) =>
      onSource(id, signal, (a) => a.getPageText(id, pageIndex, withSignal(options, signal))),
    );
  },
  search(id, query, options, onProgress, abortPort) {
    type Progress = (hits: readonly SearchHit[], pageIndex: number) => void;
    const remote = onProgress as Remote<Progress> | undefined;
    const delivered: Promise<unknown>[] = [];
    return call(abortPort, async (signal) => {
      try {
        const hits = await onSource(id, signal, (a) =>
          a.search(id, query, {
            ...withSignal(options, signal),
            ...(remote
              ? {
                  onProgress: (pageHits: readonly SearchHit[], pageIndex: number) => {
                    delivered.push(remote(pageHits, pageIndex).catch(() => undefined));
                  },
                }
              : {}),
          }),
        );
        // Progress reaches the caller before the result does.
        await Promise.all(delivered);
        return hits;
      } finally {
        remote?.[releaseProxy]();
      }
    });
  },
  listAnnotations(id, pageIndex, options, abortPort) {
    return call(abortPort, (signal) =>
      onSource(id, signal, (a) => a.listAnnotations(id, pageIndex, withSignal(options, signal))),
    );
  },
  createAnnotation(id, annotation, options, abortPort) {
    return call(abortPort, (signal) =>
      onSource(id, signal, (a) => a.createAnnotation(id, annotation, withSignal(options, signal))),
    );
  },
  updateAnnotation(id, annotation, options, abortPort) {
    return call(abortPort, (signal) =>
      onSource(id, signal, (a) => a.updateAnnotation(id, annotation, withSignal(options, signal))),
    );
  },
  deleteAnnotation(id, pageIndex, annotationId, options, abortPort) {
    return call(abortPort, async (signal) => {
      await onSource(id, signal, (a) =>
        a.deleteAnnotation(id, pageIndex, annotationId, withSignal(options, signal)),
      );
      return null;
    });
  },
  getAnnotationAppearance(id, pageIndex, annotationId, options, abortPort) {
    return call(abortPort, (signal) =>
      onSource(id, signal, (a) =>
        a.getAnnotationAppearance(id, pageIndex, annotationId, withSignal(options, signal)),
      ),
    );
  },
  listFormFields(id, options, abortPort) {
    return call(abortPort, (signal) =>
      onSource(id, signal, (a) => a.listFormFields(id, withSignal(options, signal))),
    );
  },
  setFormFieldValue(id, name, value, options, abortPort) {
    return call(abortPort, async (signal) => {
      await onSource(id, signal, (a) =>
        a.setFormFieldValue(id, name, value, withSignal(options, signal)),
      );
      return null;
    });
  },
  applyRedactions(id, options, abortPort) {
    return call(abortPort, async (signal) => {
      await onSource(id, signal, (a) => a.applyRedactions(id, withSignal(options, signal)));
      return null;
    });
  },
  save(id, options, abortPort) {
    return call(
      abortPort,
      (signal) => onSource(id, signal, (a) => a.save(id, withSignal(options, signal))),
      (bytes) => [bytes],
    );
  },
  verify(bytes, expectation, options, abortPort) {
    // Scratch documents only: no source lock.
    return call(abortPort, (signal) =>
      getAdapter().verify(bytes, expectation, withSignal(options, signal)),
    );
  },
  locateRuns(id, pageIndex, options, abortPort) {
    return call(abortPort, async (signal) =>
      (await getTextEditor()).locateRuns(id, pageIndex, withSignal(options, signal)),
    );
  },
  checkEditability(query, options, abortPort) {
    return call(abortPort, async (signal) =>
      (await getTextEditor()).checkEditability(query, withSignal(options, signal)),
    );
  },
  applyTextEdit(request, options, abortPort) {
    return call(abortPort, async (signal) =>
      (await getTextEditor()).applyTextEdit(request, withSignal(options, signal)),
    );
  },
  locateImages(id, pageIndex, options, abortPort) {
    return call(abortPort, async (signal) =>
      (await getImageEditor()).locateImages(id, pageIndex, withSignal(options, signal)),
    );
  },
  extractImage(ref, options, abortPort) {
    return call(
      abortPort,
      async (signal) => (await getImageEditor()).extractImage(ref, withSignal(options, signal)),
      (image) => [
        image.rgba.buffer as ArrayBuffer,
        ...(image.original ? [image.original.bytes.buffer as ArrayBuffer] : []),
      ],
    );
  },
  transformImage(ref, target, options, abortPort) {
    return call(abortPort, async (signal) =>
      (await getImageEditor()).transformImage(ref, target, withSignal(options, signal)),
    );
  },
  removeImage(ref, options, abortPort) {
    return call(abortPort, async (signal) =>
      (await getImageEditor()).removeImage(ref, withSignal(options, signal)),
    );
  },
  replaceImage(ref, replacement, options, abortPort) {
    return call(abortPort, async (signal) =>
      (await getImageEditor()).replaceImage(ref, replacement, withSignal(options, signal)),
    );
  },
  applyRedactionPlan(id, plan, options, abortPort) {
    return call(
      abortPort,
      async (signal) => {
        const hosted = await host();
        const a = getAdapter();
        // Exclusive: no render, save or edit of this source runs between the save and the
        // swap. The pipeline itself works on scratch ids, which have their own locks.
        return locks.run(
          id,
          'exclusive',
          async () => {
            // The source as it is now (edits included). Security is removed: the redacted
            // output is never encrypted, and pdf-lib's post-pass cannot write encryption.
            const input = await a.save(id, withSignal({ removeSecurity: true }, signal));
            const result = await applyRedactions(hosted, input, plan, withSignal(options, signal));
            // Verified: the open document becomes the redacted one, under the same id. Not
            // abortable from here on (a half-swapped source would be closed).
            await a.close(id);
            await a.open(id, result.bytes.slice(0), {});
            return result;
          },
          signal,
        );
      },
      (result) => [result.bytes],
    );
  },
  verifyRedactedOutput(bytes, plans, options, abortPort) {
    // A scratch document only: no source lock.
    return call(abortPort, async (signal) => {
      const hosted = await host();
      const { password } = options;
      return withForensicDeps(
        hosted,
        bytes,
        (deps) =>
          verifyRedactedOutput(bytes, plans, deps, password === undefined ? {} : { password }),
        withSignal(password === undefined ? {} : { password }, signal),
      );
    });
  },
  async destroy() {
    const current = adapter;
    adapter = undefined;
    hostPromise = undefined;
    textEditor = undefined;
    imageEditor = undefined;
    await current?.destroy();
  },
};

expose(api);
