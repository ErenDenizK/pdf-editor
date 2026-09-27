/**
 * `PdfPlumber` on qpdf compiled to WebAssembly from source (ADR-0008,
 * packages/engine/qpdf/build.sh). Runs in whatever thread constructs it: the app uses it
 * inside the compress worker (`compress.worker.ts`), never on the main thread.
 *
 * - The wasm is compiled once (`WebAssembly.compileStreaming`) and a fresh instance is
 *   created per job, so no global C++ state (and no MEMFS file) leaks between jobs.
 * - Input and output live in MEMFS; `callMain` runs the qpdf CLI with the flags from
 *   `qpdfArgs`. stderr lines are collected as warnings, and warnings that describe a
 *   recovery (see `indicatesRepair`) set `repaired`.
 * - Inputs above `MAX_PLUMBER_INPUT_BYTES` are refused (`out-of-memory`) before loading.
 */
import type { QpdfModule, QpdfModuleOverrides } from '../../qpdf/dist/qpdf.mjs';
import { EngineError, type PdfPlumber, type PlumberResult } from '../types';
import {
  cleanWarning,
  indicatesRepair,
  MAX_PLUMBER_INPUT_BYTES,
  QPDF_EXIT,
  QPDF_INPUT,
  QPDF_OUTPUT,
  type QpdfJobOptions,
  qpdfArgs,
  qpdfCheckArgs,
  qpdfFailure,
} from './qpdf-args';
import { patchClassicTrailerSize, trailerState } from './trailer';

export type QpdfFactory = (overrides?: QpdfModuleOverrides) => Promise<QpdfModule>;

export interface QpdfPlumberOptions {
  /** URL of `qpdf.wasm` (injected by the app, like PDFium's). */
  readonly wasmUrl: string;
  /** Loads the Emscripten factory; defaults to the bundled `qpdf.mjs`. */
  readonly loadFactory?: () => Promise<QpdfFactory>;
}

export interface PlumberCheckOptions {
  /**
   * Password of an encrypted file. The cheap read often works without it (the xref and a
   * page tree outside object streams are not encrypted); pass it when known.
   */
  readonly password?: string;
  /** Decode every stream (`qpdf --check`); default is the cheap structural read. */
  readonly thorough?: boolean;
}

/** Result of `QpdfPlumber.check`. */
export interface PlumberCheckResult {
  /** No errors and no warnings. */
  readonly ok: boolean;
  /** qpdf could not read the file at all. */
  readonly unreadable: boolean;
  /** The file needed recovery to be read (damaged xref, bad offsets, …). */
  readonly repaired: boolean;
  readonly encrypted: boolean;
  readonly linearized: boolean;
  /** Structural warnings, cleaned for display (English, from qpdf). */
  readonly warnings: readonly string[];
  /** PDF version from the header, e.g. "1.7". */
  readonly version?: string;
}

interface RunOutput {
  readonly status: number;
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
  readonly output?: Uint8Array;
}

function omit<T extends object, K extends keyof T>(value: T, keys: readonly K[]): Omit<T, K> {
  const drop = new Set<PropertyKey>(keys);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !drop.has(key))) as Omit<T, K>;
}

interface Instance {
  readonly qpdf: QpdfModule;
  /** Where the instance's stdout/stderr lines go; replaced per job. */
  sink: { stdout: string[]; stderr: string[] };
}

function removeFiles(fs: QpdfModule['FS']): void {
  for (const path of [QPDF_INPUT, QPDF_OUTPUT]) {
    if (fs.analyzePath(path).exists) fs.unlink(path);
  }
}

const defaultFactory = async (): Promise<QpdfFactory> =>
  (await import('../../qpdf/dist/qpdf.mjs')).default;

export class QpdfPlumber implements PdfPlumber {
  private readonly wasmUrl: string;
  private readonly loadFactory: () => Promise<QpdfFactory>;
  private compiled: Promise<{ module: WebAssembly.Module; factory: QpdfFactory }> | undefined;
  private batchDepth = 0;
  private shared: Promise<Instance> | undefined;

  constructor(options: QpdfPlumberOptions) {
    this.wasmUrl = options.wasmUrl;
    this.loadFactory = options.loadFactory ?? defaultFactory;
  }

  private prepare(): Promise<{ module: WebAssembly.Module; factory: QpdfFactory }> {
    if (this.compiled === undefined) {
      const base = (globalThis as { location?: { href: string } }).location?.href;
      const url = base === undefined ? this.wasmUrl : new URL(this.wasmUrl, base).href;
      const compiled = Promise.all([
        fetch(url).then(async (response) => {
          if (!response.ok) throw new Error(`qpdf.wasm: HTTP ${response.status}`);
          // compileStreaming needs application/wasm; fall back to bytes otherwise.
          return response.headers.get('content-type')?.includes('application/wasm')
            ? WebAssembly.compileStreaming(response)
            : WebAssembly.compile(await response.arrayBuffer());
        }),
        this.loadFactory(),
      ]).then(([module, factory]) => ({ module, factory }));
      compiled.catch(() => {
        if (this.compiled === compiled) this.compiled = undefined;
      });
      this.compiled = compiled;
    }
    return this.compiled;
  }

  private async instantiate(): Promise<Instance> {
    const { module, factory } = await this.prepare();
    const sink: Instance['sink'] = { stdout: [], stderr: [] };
    const qpdf = await factory({
      print: (line) => sink.stdout.push(line),
      printErr: (line) => sink.stderr.push(line),
      instantiateWasm: (imports, receive) => {
        void WebAssembly.instantiate(module, imports).then((inst) => {
          receive(inst, module);
        });
        return {};
      },
    });
    const fs = qpdf.FS as QpdfModule['FS'] & { mkdir?: (path: string) => void };
    fs.mkdir?.('/work');
    return { qpdf, sink };
  }

  /**
   * Runs `task` with one qpdf instance shared by every job it starts (and by concurrent
   * batches), instead of a fresh instance per job; the instance, and the wasm memory it
   * grew, is dropped when the last batch ends. Each job's MEMFS files are removed after
   * it. Safe because a job (write input, `callMain`, read output) is synchronous.
   */
  async batch<T>(task: () => Promise<T>): Promise<T> {
    this.batchDepth += 1;
    try {
      return await task();
    } finally {
      this.batchDepth -= 1;
      if (this.batchDepth === 0) this.shared = undefined;
    }
  }

  /** Runs qpdf once with `input` at QPDF_INPUT (in the batch's instance, if any). */
  private async run(input: Uint8Array, args: readonly string[]): Promise<RunOutput> {
    let pending: Promise<Instance>;
    if (this.batchDepth > 0) {
      this.shared ??= this.instantiate();
      pending = this.shared;
    } else {
      pending = this.instantiate();
    }
    const { qpdf: instance, sink } = await pending;
    const fs = instance.FS;
    // From here to the end the job is synchronous: no other job can interleave.
    sink.stdout = [];
    sink.stderr = [];
    fs.writeFile(QPDF_INPUT, input);
    let status: number;
    try {
      status = instance.callMain([...args]);
    } catch (error) {
      removeFiles(fs);
      if (this.shared === pending) this.shared = undefined;
      // An abort (e.g. out of memory) throws out of callMain.
      const message = error instanceof Error ? error.message : String(error);
      if (/memory/i.test(message)) {
        throw new EngineError('out-of-memory', `qpdf ran out of memory: ${message}`, {
          cause: error,
        });
      }
      throw new EngineError('internal', `qpdf failed: ${message}`, { cause: error });
    }
    const output = fs.analyzePath(QPDF_OUTPUT).exists ? fs.readFile(QPDF_OUTPUT) : undefined;
    removeFiles(fs);
    const { stdout, stderr } = sink;
    return output === undefined ? { status, stdout, stderr } : { status, stdout, stderr, output };
  }

  private static guard(bytes: ArrayBuffer): Uint8Array {
    if (bytes.byteLength > MAX_PLUMBER_INPUT_BYTES) {
      throw new EngineError(
        'out-of-memory',
        `File is ${Math.round(bytes.byteLength / 2 ** 20)} MB; the limit for this operation is ${MAX_PLUMBER_INPUT_BYTES / 2 ** 20} MB`,
      );
    }
    return new Uint8Array(bytes);
  }

  async process(bytes: ArrayBuffer, options: QpdfJobOptions = {}): Promise<PlumberResult> {
    const input = QpdfPlumber.guard(bytes);
    return await this.batch(() => this.processInBatch(input, options));
  }

  private async processInBatch(input: Uint8Array, options: QpdfJobOptions): Promise<PlumberResult> {
    const first = await this.rewrite(input, options);
    const state = trailerState(first.bytes);
    if (state === 'ok') return QpdfPlumber.result(first);
    // qpdf lost /Size (see trailer.ts): rewrite with a classic trailer, patch it, and run
    // the requested job on the patched copy, which qpdf now reads without recovery.
    const plain = await this.rewrite(input, {
      ...omit(options, ['encrypt', 'linearize']),
      objectStreams: 'disable',
    });
    const patched = patchClassicTrailerSize(plain.bytes);
    const decrypted = options.decrypt !== undefined;
    const needsSecond =
      options.objectStreams === 'generate' || options.linearize === true || options.encrypt;
    if (!needsSecond) {
      return QpdfPlumber.result({ ...plain, bytes: patched });
    }
    const second = await this.rewrite(patched, decrypted ? omit(options, ['decrypt']) : options);
    return QpdfPlumber.result({
      bytes: second.bytes,
      repaired: true,
      warnings: [...plain.warnings, ...second.warnings],
    });
  }

  private static result(run: {
    readonly bytes: Uint8Array;
    readonly repaired: boolean;
    readonly warnings: readonly string[];
  }): PlumberResult {
    const out = run.bytes;
    return {
      bytes: out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer,
      repaired: run.repaired,
      warnings: run.warnings,
    };
  }

  private async rewrite(
    input: Uint8Array,
    options: QpdfJobOptions,
  ): Promise<{ bytes: Uint8Array; repaired: boolean; warnings: string[] }> {
    if (options.signal?.aborted) throw new EngineError('aborted', 'qpdf aborted');
    const result = await this.run(input, qpdfArgs(options));
    if (options.signal?.aborted) throw new EngineError('aborted', 'qpdf aborted');
    const warnings = result.stderr
      .map(cleanWarning)
      .filter((line) => line !== '' && !line.includes('operation succeeded with warnings'));
    if (result.status === QPDF_EXIT.error || result.output === undefined) {
      const text = warnings.join('; ') || `qpdf exited with status ${result.status}`;
      throw qpdfFailure(text, options);
    }
    return { bytes: result.output, repaired: indicatesRepair(result.stderr), warnings };
  }

  /**
   * Structural check for a diagnostics panel. Never rejects for damaged input; reports
   * `unreadable` instead.
   * - Default (cheap): qpdf reads the xref, trailer, page tree and encryption dictionary
   *   (`--show-encryption --show-npages`), so recovery warnings and encryption show, but
   *   no stream is decoded. `linearized` then comes from the header's /Linearized dict.
   * - `thorough`: `qpdf --check`, which also decodes every stream (slow on large files).
   */
  async check(bytes: ArrayBuffer, options: PlumberCheckOptions = {}): Promise<PlumberCheckResult> {
    const input = QpdfPlumber.guard(bytes);
    const head = new TextDecoder('latin1').decode(input.subarray(0, 1024));
    const version = /%PDF-(\d\.\d)/.exec(head)?.[1];
    const result = await this.run(input, qpdfCheckArgs(options));
    const warnings = result.stderr
      .map(cleanWarning)
      .filter((line) => line !== '' && !line.includes('operation succeeded with warnings'));
    const text = result.stdout.join('\n');
    const encrypted = result.status !== QPDF_EXIT.error && !/File is not encrypted/i.test(text);
    const linearized = options.thorough
      ? /File is linearized/i.test(text) && !/File is not linearized/i.test(text)
      : /\/Linearized\s+1/.test(head);
    const unreadable =
      result.status === QPDF_EXIT.error && (options.thorough ? !/checking/i.test(text) : true);
    return {
      ok: result.status === QPDF_EXIT.ok && warnings.length === 0,
      unreadable,
      repaired: indicatesRepair(result.stderr),
      encrypted: unreadable ? /invalid password/i.test(warnings.join(' ')) : encrypted,
      linearized,
      warnings:
        result.status === QPDF_EXIT.error && warnings.length === 0
          ? [`qpdf exited with status ${result.status}`]
          : warnings,
      ...(version === undefined ? {} : { version }),
    };
  }
}
