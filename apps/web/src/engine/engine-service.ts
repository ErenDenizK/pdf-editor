/**
 * Engine service: the app's single entry point to the PDFium adapter (ADR-0002).
 *
 * - Lazily loads and constructs one `PdfiumAdapter` (its PDFium worker starts on first
 *   use) with a self-hosted wasm URL and font fallback disabled (no CDN; engine README).
 * - Renders through a small priority queue: Read-mode pages > visible thumbnails >
 *   offscreen thumbnails. Requests for the same bitmap share one job; a job is cancelled
 *   (AbortSignal) once every requester has lost interest.
 * - Caches `ImageBitmap`s in a byte-budgeted LRU (`bitmap-cache.ts`).
 * - Never rejects: every public method resolves to an `EngineResult`.
 * - Password-protected files call back into the UI through `setPasswordPrompt`.
 * - Keeps a copy of every open source's original bytes (a Blob, which the browser may page
 *   to disk) because the adapter transfers the buffer to PDFium's worker; export reads it
 *   back with `sourceBytes`. The copy is dropped on `close`.
 * - Page labels and /Lang are read by the assembly worker (`assembler-client.ts`), which
 *   the adapter uses as its inspector.
 *
 * Render timings are recorded in development with `performance.mark`/`measure` only
 * (entries named `render …`, `open …`).
 */
import wasmUrl from '@embedpdf/pdfium/pdfium.wasm?url';
import { createRandomIdGenerator, type Rotation, type SourceId } from '@pdf-editor/document-model';
import type {
  EngineErrorCode,
  OpenedDocument,
  PdfEditor,
  PdfRenderer,
  PdfVerifier,
  SaveOptions,
  TextRun,
  VerificationExpectation,
  VerificationResult,
} from '@pdf-editor/engine';

import { getAssembler } from './assembler-client';

import { BitmapCache, type CachedBitmap, bitmapKey, pageKey } from './bitmap-cache';

export type { CachedBitmap } from './bitmap-cache';

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type EngineFailureCode = EngineErrorCode | 'password-cancelled' | 'read-failed';

export interface EngineFailure {
  readonly code: EngineFailureCode;
  readonly message: string;
}

export type EngineResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: EngineFailure };

const ok = <T>(value: T): EngineResult<T> => ({ ok: true, value });
const fail = <T>(code: EngineFailureCode, message: string): EngineResult<T> => ({
  ok: false,
  error: { code, message },
});

const ENGINE_CODES: readonly string[] = [
  'password-required',
  'password-incorrect',
  'unsupported-encryption',
  'corrupt',
  'unsupported',
  'out-of-memory',
  'aborted',
  'internal',
];

/** Maps anything thrown by an adapter to a typed failure (duck-typed on `code`). */
export function toFailure(error: unknown): EngineFailure {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  if (typeof code === 'string' && ENGINE_CODES.includes(code)) {
    return { code: code as EngineErrorCode, message };
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return { code: 'aborted', message };
  }
  return { code: 'internal', message };
}

// ---------------------------------------------------------------------------
// Scale buckets
// ---------------------------------------------------------------------------

/** Buckets are quarter-octaves (2^(k/4)): at most ~19% oversampling, few cache variants. */
const STEPS_PER_OCTAVE = 4;
const MIN_BUCKET = 1 / 64;
const MAX_BUCKET = 16;
/** Largest bitmap we render in one piece (~64 MB). Beyond this, tiling (M1) is needed. */
export const MAX_BITMAP_PIXELS = 4096 * 4096;

function roundBucket(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** Smallest bucket >= scale. */
export function scaleBucket(scale: number): number {
  const safe = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const k = Math.ceil(Math.log2(safe) * STEPS_PER_OCTAVE - 1e-9);
  return roundBucket(Math.min(MAX_BUCKET, Math.max(MIN_BUCKET, 2 ** (k / STEPS_PER_OCTAVE))));
}

/** Largest bucket <= scale. */
export function scaleBucketBelow(scale: number): number {
  const safe = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const k = Math.floor(Math.log2(safe) * STEPS_PER_OCTAVE + 1e-9);
  return roundBucket(Math.min(MAX_BUCKET, Math.max(MIN_BUCKET, 2 ** (k / STEPS_PER_OCTAVE))));
}

/**
 * The bucket to render a page at: at least `scale` (device pixels per point) for sharpness,
 * but never more than `MAX_BITMAP_PIXELS` for a page of `widthPt` × `heightPt`.
 */
export function chooseBucket(scale: number, widthPt: number, heightPt: number): number {
  const wanted = scaleBucket(scale);
  const area = Math.max(1, widthPt * heightPt);
  const maxScale = Math.sqrt(MAX_BITMAP_PIXELS / area);
  return wanted <= maxScale ? wanted : scaleBucketBelow(maxScale);
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

/** Higher runs first. */
export const RENDER_PRIORITY = { page: 3, visible: 2, offscreen: 1 } as const;

export interface RenderRequest {
  readonly sourceId: SourceId;
  readonly index: number;
  /** Rotation on top of the page's intrinsic /Rotate (VirtualPage.rotation). */
  readonly rotation: Rotation;
  /** A value from `chooseBucket` / `scaleBucket`. */
  readonly bucket: number;
  readonly priority: number;
  readonly signal?: AbortSignal;
}

interface Subscriber {
  readonly priority: number;
  readonly resolve: (result: EngineResult<CachedBitmap>) => void;
}

interface Job {
  readonly key: string;
  readonly page: string;
  readonly request: RenderRequest;
  readonly controller: AbortController;
  readonly subscribers: Set<Subscriber>;
  readonly seq: number;
  running: boolean;
  /** Set by `close`: the source went away, so a late result must not be cached. */
  sourceClosed: boolean;
}

export type PasswordPrompt = (request: {
  readonly fileName: string;
  /** True when a password was already tried and rejected. */
  readonly incorrect: boolean;
}) => Promise<string | null>;

export interface OpenedSource {
  readonly id: SourceId;
  readonly name: string;
  readonly byteLength: number;
  readonly lastModified: number;
  readonly document: OpenedDocument;
}

/** The adapter surface the service needs; tests pass a mock. */
function isEditor(engine: RendererLike): engine is RendererLike & PdfEditor {
  return typeof (engine as Partial<PdfEditor>).createAnnotation === 'function';
}

export type RendererLike = Pick<PdfRenderer, 'open' | 'close' | 'renderPage' | 'getPageText'> &
  Partial<Pick<PdfEditor, 'save'>> &
  Partial<PdfVerifier> & {
    destroy?: () => Promise<void>;
  };

export interface EngineServiceOptions {
  /** Called once, on first use; may load the adapter lazily. */
  readonly createRenderer: () => RendererLike | Promise<RendererLike>;
  readonly cacheBudgetBytes?: number;
  /** Render jobs in flight at once. PDFium has one worker; 2 keeps it busy. */
  readonly concurrency?: number;
  readonly newSourceId?: () => SourceId;
  /** Record `performance` marks for renders (defaults to dev builds). */
  readonly timings?: boolean;
}

export class EngineService {
  private renderer: Promise<RendererLike> | undefined;
  private readonly createRenderer: () => RendererLike | Promise<RendererLike>;
  private readonly cache: BitmapCache;
  private readonly concurrency: number;
  private readonly newSourceId: () => SourceId;
  private readonly timings: boolean;
  private readonly jobs = new Map<string, Job>();
  /** Original bytes of every open source (see the module comment). */
  private readonly retained = new Map<SourceId, Blob>();
  private running = 0;
  private seq = 0;
  private passwordPrompt: PasswordPrompt | undefined;

  constructor(options: EngineServiceOptions) {
    this.createRenderer = options.createRenderer;
    this.cache = new BitmapCache(options.cacheBudgetBytes);
    this.concurrency = Math.max(1, options.concurrency ?? 2);
    const ids = createRandomIdGenerator();
    this.newSourceId = options.newSourceId ?? (() => ids.source());
    this.timings =
      options.timings ?? (import.meta.env.DEV && typeof performance.mark === 'function');
  }

  /** The adapter, created on first use. A failed creation is retried on the next call. */
  private engine(): Promise<RendererLike> {
    if (this.renderer === undefined) {
      const created = Promise.resolve().then(() => this.createRenderer());
      created.catch(() => {
        if (this.renderer === created) this.renderer = undefined;
      });
      this.renderer = created;
    }
    return this.renderer;
  }

  /**
   * The content editor (annotations, forms, redaction) behind the same adapter. Features
   * that edit sources go through this rather than reaching for the adapter directly, so
   * the service keeps a single instance and one lifecycle.
   */
  async editor(): Promise<PdfEditor> {
    const engine = await this.engine();
    if (!isEditor(engine)) throw new Error('The rendering engine has no content editor');
    return engine;
  }

  /** The UI registers how to ask for a password; without one, locked files fail. */
  setPasswordPrompt(prompt: PasswordPrompt | undefined): void {
    this.passwordPrompt = prompt;
  }

  // -------------------------------------------------------------------------
  // Documents
  // -------------------------------------------------------------------------

  /**
   * Opens a file. On `password-required` / `password-incorrect` it asks the registered
   * prompt (again after a wrong password) until the file opens or the user cancels.
   */
  async open(file: File, password?: string): Promise<EngineResult<OpenedSource>> {
    const id = this.newSourceId();
    let attempt = password;
    let tries = 0;
    for (;;) {
      let bytes: ArrayBuffer;
      try {
        // Read per attempt: the adapter transfers the buffer to its worker.
        bytes = await file.arrayBuffer();
      } catch (error) {
        return fail('read-failed', `Could not read ${file.name}: ${toFailure(error).message}`);
      }
      const started = this.mark(`open-start:${id}`);
      // Copy before the adapter detaches the buffer.
      const retained = new Blob([bytes], { type: 'application/pdf' });
      try {
        const document = await (await this.engine()).open(
          id,
          bytes,
          attempt === undefined ? {} : { password: attempt },
        );
        this.retained.set(id, retained);
        this.measure(`open ${file.name}`, started);
        return ok({
          id,
          name: file.name,
          byteLength: file.size,
          lastModified: file.lastModified,
          document,
        });
      } catch (error) {
        const failure = toFailure(error);
        const locked =
          failure.code === 'password-required' || failure.code === 'password-incorrect';
        if (!locked || this.passwordPrompt === undefined) return { ok: false, error: failure };
        let answer: string | null;
        try {
          answer = await this.passwordPrompt({ fileName: file.name, incorrect: tries > 0 });
        } catch {
          answer = null;
        }
        if (answer === null) {
          return fail('password-cancelled', `${file.name} needs a password; skipped`);
        }
        attempt = answer;
        tries += 1;
      }
    }
  }

  /** Closes a source in the engine and drops its cached bitmaps and pending renders. */
  async close(sourceId: SourceId): Promise<EngineResult<void>> {
    const prefix = `${sourceId}:`;
    for (const job of [...this.jobs.values()]) {
      if (!job.key.startsWith(prefix)) continue;
      job.sourceClosed = true;
      this.cancel(job, 'Source closed');
    }
    this.cache.removeSource(sourceId);
    this.retained.delete(sourceId);
    if (this.renderer === undefined) return ok(undefined);
    try {
      await (await this.renderer).close(sourceId);
      return ok(undefined);
    } catch (error) {
      return { ok: false, error: toFailure(error) };
    }
  }

  /** A fresh copy of a source's original bytes (the caller may transfer it). */
  async sourceBytes(sourceId: SourceId): Promise<EngineResult<ArrayBuffer>> {
    const blob = this.retained.get(sourceId);
    if (blob === undefined) return fail('internal', `Source ${sourceId} is not open`);
    try {
      return ok(await blob.arrayBuffer());
    } catch (error) {
      return fail('read-failed', `Could not read the kept copy: ${toFailure(error).message}`);
    }
  }

  /** Serializes a source through the engine (edits applied, e.g. decrypted). */
  async saveSource(
    sourceId: SourceId,
    options: SaveOptions = {},
  ): Promise<EngineResult<ArrayBuffer>> {
    try {
      const engine = await this.engine();
      if (!engine.save) return fail('unsupported', 'The engine cannot save sources');
      return ok(await engine.save(sourceId, options));
    } catch (error) {
      return { ok: false, error: toFailure(error) };
    }
  }

  /** Re-opens `bytes` in PDFium and checks them against `expectation` (export step 5). */
  async verify(
    bytes: ArrayBuffer,
    expectation: VerificationExpectation,
    signal?: AbortSignal,
  ): Promise<EngineResult<VerificationResult>> {
    try {
      const engine = await this.engine();
      if (!engine.verify) return fail('unsupported', 'The engine cannot verify output');
      return ok(await engine.verify(bytes, expectation, signal === undefined ? {} : { signal }));
    } catch (error) {
      return { ok: false, error: toFailure(error) };
    }
  }

  async getPageText(
    sourceId: SourceId,
    index: number,
    signal?: AbortSignal,
  ): Promise<EngineResult<readonly TextRun[]>> {
    try {
      const runs = await (await this.engine()).getPageText(
        sourceId,
        index,
        signal === undefined ? {} : { signal },
      );
      return ok(runs);
    } catch (error) {
      return { ok: false, error: toFailure(error) };
    }
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  /** A cached bitmap for exactly this request, if any (marks it recently used). */
  peek(sourceId: SourceId, index: number, rotation: Rotation, bucket: number) {
    return this.cache.get(bitmapKey(sourceId, index, rotation, bucket));
  }

  /** The best cached bitmap of a page at or below `bucket` (or above, if nothing below). */
  preview(
    sourceId: SourceId,
    index: number,
    rotation: Rotation,
    bucket: number,
  ): CachedBitmap | undefined {
    return this.cache.best(pageKey(sourceId, index, rotation), bucket, true);
  }

  get cacheStats(): { readonly entries: number; readonly bytes: number; readonly budget: number } {
    return {
      entries: this.cache.size,
      bytes: this.cache.usedBytes,
      budget: this.cache.budgetBytes,
    };
  }

  /** Jobs queued or running; for tests and diagnostics. */
  get pendingJobs(): number {
    return this.jobs.size;
  }

  renderPage(request: RenderRequest): Promise<EngineResult<CachedBitmap>> {
    const { sourceId, index, rotation, bucket, signal } = request;
    const key = bitmapKey(sourceId, index, rotation, bucket);
    const hit = this.cache.get(key);
    if (hit !== undefined) return Promise.resolve(ok(hit));
    if (signal?.aborted) return Promise.resolve(fail('aborted', 'Render aborted'));

    return new Promise((resolve) => {
      let job = this.jobs.get(key);
      if (job === undefined) {
        job = {
          key,
          page: pageKey(sourceId, index, rotation),
          request,
          controller: new AbortController(),
          subscribers: new Set(),
          seq: this.seq++,
          running: false,
          sourceClosed: false,
        };
        this.jobs.set(key, job);
      }
      const subscriber: Subscriber = { priority: request.priority, resolve };
      job.subscribers.add(subscriber);
      const current = job;
      signal?.addEventListener(
        'abort',
        () => {
          if (!current.subscribers.delete(subscriber)) return;
          resolve(fail('aborted', 'Render aborted'));
          if (current.subscribers.size === 0) this.cancel(current, 'No longer needed');
        },
        { once: true },
      );
      this.pump();
    });
  }

  private priorityOf(job: Job): number {
    let max = -Infinity;
    for (const s of job.subscribers) max = Math.max(max, s.priority);
    return max;
  }

  private cancel(job: Job, reason: string): void {
    if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
    job.controller.abort(new DOMException(reason, 'AbortError'));
    for (const s of job.subscribers) s.resolve(fail('aborted', reason));
    job.subscribers.clear();
  }

  private next(): Job | undefined {
    let best: Job | undefined;
    let bestPriority = -Infinity;
    for (const job of this.jobs.values()) {
      if (job.running) continue;
      const priority = this.priorityOf(job);
      if (priority > bestPriority || (priority === bestPriority && best && job.seq < best.seq)) {
        best = job;
        bestPriority = priority;
      }
    }
    return best;
  }

  private pump(): void {
    while (this.running < this.concurrency) {
      const job = this.next();
      if (job === undefined) return;
      job.running = true;
      this.running += 1;
      void this.run(job).finally(() => {
        this.running -= 1;
        this.pump();
      });
    }
  }

  private async run(job: Job): Promise<void> {
    const { sourceId, index, rotation, bucket } = job.request;
    const started = this.mark(`render-start:${job.key}`);
    let result: EngineResult<CachedBitmap>;
    try {
      const rendered = await (await this.engine()).renderPage(sourceId, index, {
        scale: bucket,
        rotation,
        signal: job.controller.signal,
      });
      const entry: CachedBitmap = {
        key: job.key,
        bitmap: rendered.bitmap,
        width: rendered.width,
        height: rendered.height,
        bucket,
      };
      if (job.sourceClosed) {
        // The source was closed while PDFium rendered (the adapter finished before it saw
        // the abort): nothing may be cached for it, or the bitmap would outlive it.
        rendered.bitmap.close();
        result = fail('aborted', 'Source closed');
      } else {
        // Cache even when nobody waits any more: scrolling back is common.
        this.cache.set(job.page, entry);
        this.measure(`render ${job.key}`, started);
        result = ok(entry);
      }
    } catch (error) {
      result = { ok: false, error: toFailure(error) };
    }
    if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
    for (const s of job.subscribers) s.resolve(result);
    job.subscribers.clear();
  }

  // -------------------------------------------------------------------------
  // Dev timings
  // -------------------------------------------------------------------------

  private mark(name: string): string | undefined {
    if (!this.timings) return undefined;
    try {
      performance.mark(name);
      return name;
    } catch {
      return undefined;
    }
  }

  private measure(name: string, startMark: string | undefined): void {
    if (startMark === undefined) return;
    try {
      performance.measure(name, startMark);
      performance.clearMarks(startMark);
    } catch {
      // Timing is best effort.
    }
  }

  /** Terminates the worker and drops every cached bitmap. */
  async destroy(): Promise<void> {
    for (const job of [...this.jobs.values()]) this.cancel(job, 'Engine destroyed');
    this.cache.clear();
    this.retained.clear();
    const renderer = this.renderer;
    this.renderer = undefined;
    try {
      await (await renderer)?.destroy?.();
    } catch {
      // Nothing left to clean up.
    }
  }
}

let instance: EngineService | undefined;

/**
 * The app-wide engine service. The adapter code is loaded on first use (its own chunk) and
 * the PDFium worker starts then (ARCHITECTURE.md §2: loaded on first document open).
 */
export function getEngineService(): EngineService {
  instance ??= new EngineService({
    createRenderer: async () => {
      const [{ PdfiumAdapter }, inspector] = await Promise.all([
        import('@pdf-editor/engine'),
        getAssembler(),
      ]);
      return new PdfiumAdapter({ wasmUrl, fontFallback: null, inspector });
    },
  });
  return instance;
}
