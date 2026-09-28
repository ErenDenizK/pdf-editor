/**
 * The OCR recognizer (spec §1.1, §1.4; ADR-0012): tesseract.js 7 served from the app's own
 * origin, on the main thread only as a message poster (the API is a lazy chunk; recognition
 * runs in tesseract's own classic worker).
 *
 * Always explicit, because a meta CSP does not bind the worker (research 07 §1 #3):
 * `workerPath` and `corePath` on our origin (the core variant picked with the two
 * `WebAssembly.validate` probes of wasm-feature-detect; worker and cores share one
 * directory, since Emscripten finds the `.wasm` next to the worker), `workerBlobURL: false`
 * (the CSP refuses `blob:` workers), `cacheMethod: 'none'` (no IndexedDB copy), and the packs
 * as `{ code, data }` bytes from `OcrPackStore` (which needs the carried one-token worker
 * patch). LSTM only (`oem 1`), no `rotateAuto`.
 *
 * A pool of one or two recognizers (two when `hardwareConcurrency ≥ 4`: 1.65× on 4 vCPU,
 * ~+100 MiB), reused across pages and terminated after 60 s idle. tesseract.js cannot abort
 * a job, so a page that exceeds its time budget (30 s) or a cancelled call terminates its
 * recognizer; the next call starts a fresh one. A timed-out page is `poor` with no words.
 */
import type Tesseract from 'tesseract.js';

import {
  EngineError,
  OCR_MIN_WORD_CONFIDENCE,
  type OcrPageResult,
  type OcrProgress,
  type OcrRaster,
  type OcrRecognizeOptions,
  type OcrRecognizer,
} from '../types';
import { wordsFromBlocks } from './geometry';
import { OCR_LOCK, OcrPackStore } from './packs';
import { meanConfidence, ocrQuality } from './quality';

/** tesseract.js's `OEM.LSTM_ONLY`. */
const OEM_LSTM_ONLY = 1;

/** Per-page recognition budget (research 07 §7). */
export const OCR_PAGE_TIMEOUT_MS = 30_000;
/** Idle recognizers are terminated after this long (spec §1.1). */
export const OCR_IDLE_MS = 60_000;

// The two probes of wasm-feature-detect 1.8 (relaxed SIMD, SIMD), inlined (research 07 §1 #5).
const RELAXED_SIMD = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 15, 1, 13, 0, 65, 1, 253, 15,
  65, 2, 253, 15, 253, 128, 2, 11,
]);
const SIMD = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15,
  253, 98, 11,
]);

export type OcrCoreVariant = 'relaxedsimd-lstm' | 'simd-lstm' | 'lstm';

/** The core this browser gets. */
export function ocrCoreVariant(): OcrCoreVariant {
  if (WebAssembly.validate(RELAXED_SIMD)) return 'relaxedsimd-lstm';
  if (WebAssembly.validate(SIMD)) return 'simd-lstm';
  return 'lstm';
}

/** Engine files a browser needs (for "Keep available offline"). */
export function ocrEngineFiles(variant: OcrCoreVariant = ocrCoreVariant()): string[] {
  return ['worker.min.js', `tesseract-core-${variant}.js`, `tesseract-core-${variant}.wasm`];
}

export interface TesseractRecognizerOptions {
  /** URL of the served `ocr/` directory (e.g. `${import.meta.env.BASE_URL}ocr/`). */
  readonly baseUrl: string;
  /** The pack loader; default a new `OcrPackStore` on `baseUrl`. */
  readonly packs?: OcrPackStore;
  /** Recognizers run in parallel: default 2 when `hardwareConcurrency ≥ 4`, else 1. */
  readonly poolSize?: number;
  readonly pageTimeoutMs?: number;
  readonly idleMs?: number;
  /** Words below this confidence are dropped (default `OCR_MIN_WORD_CONFIDENCE`). */
  readonly minWordConfidence?: number;
}

type TesseractApi = typeof Tesseract;

/**
 * `Worker.recognize` as called here: tesseract.js takes the bytes of an encoded image (here
 * PGM) as a `Uint8Array` and passes them through untouched, but its `ImageLike` omits that
 * and names Node's `Buffer`, which does not resolve in this browser-only program (so the
 * whole parameter would be an error type).
 */
type RecognizeBytes = (
  image: Uint8Array,
  options: Partial<Tesseract.RecognizeOptions>,
  output: Partial<Tesseract.OutputFormats>,
) => Promise<Tesseract.RecognizeResult>;

let tesseractModule: Promise<TesseractApi> | undefined;

/** The tesseract.js API, loaded on first use (a lazy chunk in the app). */
function loadTesseract(): Promise<TesseractApi> {
  if (!tesseractModule) {
    tesseractModule = import('tesseract.js').then(
      (mod) => (mod as unknown as { default?: TesseractApi }).default ?? (mod as TesseractApi),
    );
    tesseractModule.catch(() => {
      tesseractModule = undefined;
    });
  }
  return tesseractModule;
}

interface Slot {
  readonly languages: string;
  readonly worker: Tesseract.Worker;
  busy: boolean;
  dpi: number;
  /** Progress of the job running on this slot. */
  progress: ((progress: OcrProgress) => void) | undefined;
  dead: boolean;
}

type Waiter = () => void;

class TesseractRecognizer implements OcrRecognizer {
  readonly engine: string;
  readonly packs: OcrPackStore;
  private readonly variant = ocrCoreVariant();
  private readonly poolSize: number;
  private readonly pageTimeoutMs: number;
  private readonly idleMs: number;
  private readonly minWordConfidence: number;
  private readonly slots: Slot[] = [];
  private starting = 0;
  private waiters: Waiter[] = [];
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(options: TesseractRecognizerOptions) {
    this.packs = options.packs ?? new OcrPackStore({ baseUrl: options.baseUrl });
    const cores = (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator
      ?.hardwareConcurrency;
    this.poolSize = Math.max(1, Math.min(2, options.poolSize ?? ((cores ?? 1) >= 4 ? 2 : 1)));
    this.pageTimeoutMs = options.pageTimeoutMs ?? OCR_PAGE_TIMEOUT_MS;
    this.idleMs = options.idleMs ?? OCR_IDLE_MS;
    this.minWordConfidence = options.minWordConfidence ?? OCR_MIN_WORD_CONFIDENCE;
    this.engine =
      `tesseract.js ${OCR_LOCK.tesseract.version} ${this.variant}, ` +
      `tessdata_fast ${OCR_LOCK.tessdata.commit.slice(0, 8)}`;
  }

  /** Recognizers alive (for tests and diagnostics). */
  get alive(): number {
    return this.slots.length;
  }

  async ensureLanguages(codes: readonly string[], options: OcrRecognizeOptions = {}) {
    const key = languageKey(codes);
    const { signal, onProgress } = options;
    for (const code of codes) {
      await this.packs.load(code, {
        ...(signal ? { signal } : {}),
        ...(onProgress
          ? {
              onProgress: (done: number, total: number) => {
                onProgress({ phase: 'download', done, total, language: code });
              },
            }
          : {}),
      });
    }
    const slot = await this.acquire(key, options);
    this.release(slot);
  }

  async recognize(
    raster: OcrRaster,
    pageIndex: number,
    codes: readonly string[],
    options: OcrRecognizeOptions = {},
  ): Promise<OcrPageResult> {
    const { signal, onProgress } = options;
    if (signal?.aborted) throw new EngineError('aborted', 'OCR was cancelled');
    const key = languageKey(codes);
    const slot = await this.acquire(key, options);
    const started = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      if (slot.dpi !== raster.dpi) {
        await slot.worker.setParameters({ user_defined_dpi: String(raster.dpi) });
        slot.dpi = raster.dpi;
      }
      slot.progress = onProgress;
      const outcome = await new Promise<
        { kind: 'done'; page: Tesseract.Page } | { kind: 'timeout' }
      >((resolve, reject) => {
        timer = setTimeout(() => {
          resolve({ kind: 'timeout' });
        }, this.pageTimeoutMs);
        if (signal) {
          onAbort = () => {
            reject(new EngineError('aborted', 'OCR was cancelled'));
          };
          signal.addEventListener('abort', onAbort, { once: true });
        }
        const recognize = slot.worker.recognize.bind(slot.worker) as unknown as RecognizeBytes;
        recognize(new Uint8Array(raster.bytes), {}, { blocks: true, text: false }).then(
          (result) => {
            resolve({ kind: 'done', page: result.data });
          },
          (error: unknown) => {
            reject(
              error instanceof EngineError
                ? error
                : new EngineError('internal', `Recognition failed: ${String(error)}`),
            );
          },
        );
      });
      const durationMs = Math.round(performance.now() - started);
      if (outcome.kind === 'timeout') {
        await this.kill(slot);
        return {
          pageIndex,
          dpi: raster.dpi,
          languages: [...codes],
          words: [],
          lines: [],
          meanConfidence: 0,
          quality: 'poor',
          engine: this.engine,
          dropped: 0,
          lowConfidence: 0,
          durationMs,
          timedOut: true,
        };
      }
      const { words, lines, dropped } = wordsFromBlocks(
        outcome.page.blocks ?? [],
        raster.toUser,
        this.minWordConfidence,
      );
      const mean = meanConfidence(words);
      return {
        pageIndex,
        dpi: raster.dpi,
        languages: [...codes],
        words,
        lines,
        meanConfidence: mean,
        quality: ocrQuality(mean, words.length),
        engine: this.engine,
        dropped,
        lowConfidence: words.filter((w) => w.lowConfidence).length,
        durationMs,
      };
    } catch (error) {
      // The job may still be running: the recognizer cannot be reused.
      await this.kill(slot);
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      slot.progress = undefined;
      this.release(slot);
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    const all = this.slots.splice(0);
    for (const slot of all) {
      slot.dead = true;
      await slot.worker.terminate().catch(() => undefined);
    }
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
    this.packs.forget();
    // Usable again after dispose (a new session starts new recognizers).
    this.disposed = false;
  }

  // --- Pool ---

  private async acquire(key: string, options: OcrRecognizeOptions): Promise<Slot> {
    const { signal } = options;
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    for (;;) {
      if (signal?.aborted) throw new EngineError('aborted', 'OCR was cancelled');
      if (this.disposed) throw new EngineError('aborted', 'The recognizer was disposed');
      const idle = this.slots.find((s) => !s.busy && s.languages === key);
      if (idle) {
        idle.busy = true;
        return idle;
      }
      if (this.slots.length + this.starting < this.poolSize) {
        return this.start(key, options);
      }
      const other = this.slots.find((s) => !s.busy);
      if (other) {
        // Another language set: replace that recognizer.
        await this.kill(other);
        continue;
      }
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        const onAbort = () => {
          this.waiters = this.waiters.filter((w) => w !== wake);
          reject(new EngineError('aborted', 'OCR was cancelled'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        this.waiters.push(wake);
      });
    }
  }

  private async start(key: string, options: OcrRecognizeOptions): Promise<Slot> {
    this.starting++;
    try {
      const codes = key.split('+');
      const { signal, onProgress } = options;
      const langs = await Promise.all(
        codes.map(async (code) => ({
          code,
          data: await this.packs.load(code, signal ? { signal } : {}),
        })),
      );
      const api = await loadTesseract();
      const holder: { slot?: Slot } = {};
      const worker = await api.createWorker(langs, OEM_LSTM_ONLY, {
        workerBlobURL: false,
        workerPath: this.packs.engineUrl('worker.min.js'),
        corePath: this.packs.engineUrl(`tesseract-core-${this.variant}.js`),
        // Never used (the packs are handed over as bytes), but never the CDN either.
        langPath: `${this.packs.baseUrl}lang`,
        cacheMethod: 'none',
        gzip: false,
        logger: (message) => {
          const report = holder.slot?.progress ?? onProgress;
          if (!report) return;
          const recognizing = message.status === 'recognizing text';
          report({
            phase: recognizing ? 'recognize' : 'start',
            done: message.progress,
            total: 1,
          });
        },
        // Without a handler tesseract.js rethrows worker errors from its message handler.
        errorHandler: () => undefined,
      });
      const slot: Slot = {
        languages: key,
        worker,
        busy: true,
        dpi: 0,
        progress: undefined,
        dead: false,
      };
      holder.slot = slot;
      if (this.disposed || signal?.aborted) {
        await worker.terminate().catch(() => undefined);
        throw new EngineError('aborted', 'OCR was cancelled');
      }
      this.slots.push(slot);
      return slot;
    } catch (error) {
      if (error instanceof EngineError) throw error;
      throw new EngineError(
        'internal',
        `The OCR engine could not start: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    } finally {
      this.starting--;
    }
  }

  private release(slot: Slot): void {
    slot.busy = false;
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
    if (this.slots.length > 0 && this.slots.every((s) => !s.busy)) {
      if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => {
        this.idleTimer = undefined;
        for (const s of [...this.slots]) if (!s.busy) void this.kill(s);
      }, this.idleMs);
    }
  }

  private async kill(slot: Slot): Promise<void> {
    if (slot.dead) return;
    slot.dead = true;
    const index = this.slots.indexOf(slot);
    if (index !== -1) this.slots.splice(index, 1);
    await slot.worker.terminate().catch(() => undefined);
  }
}

function languageKey(codes: readonly string[]): string {
  if (codes.length === 0) throw new EngineError('unsupported', 'Choose at least one language');
  return codes.join('+');
}

/** A recognizer over tesseract.js served from `options.baseUrl`. */
export function createOcrRecognizer(
  options: TesseractRecognizerOptions,
): OcrRecognizer & { readonly packs: OcrPackStore; readonly alive: number } {
  return new TesseractRecognizer(options);
}
