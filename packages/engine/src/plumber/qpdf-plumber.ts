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
} from './qpdf-args';
import { patchClassicTrailerSize, trailerState } from './trailer';

export type QpdfFactory = (overrides?: QpdfModuleOverrides) => Promise<QpdfModule>;

export interface QpdfPlumberOptions {
  /** URL of `qpdf.wasm` (injected by the app, like PDFium's). */
  readonly wasmUrl: string;
  /** Loads the Emscripten factory; defaults to the bundled `qpdf.mjs`. */
  readonly loadFactory?: () => Promise<QpdfFactory>;
}

/** Result of `QpdfPlumber.check` (`qpdf --check`). */
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

const defaultFactory = async (): Promise<QpdfFactory> =>
  (await import('../../qpdf/dist/qpdf.mjs')).default;

export class QpdfPlumber implements PdfPlumber {
  private readonly wasmUrl: string;
  private readonly loadFactory: () => Promise<QpdfFactory>;
  private compiled: Promise<{ module: WebAssembly.Module; factory: QpdfFactory }> | undefined;

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

  /** Runs qpdf once in a fresh instance with `input` at QPDF_INPUT. */
  private async run(input: Uint8Array, args: readonly string[]): Promise<RunOutput> {
    const { module, factory } = await this.prepare();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const instance = await factory({
      print: (line) => stdout.push(line),
      printErr: (line) => stderr.push(line),
      instantiateWasm: (imports, receive) => {
        void WebAssembly.instantiate(module, imports).then((inst) => receive(inst, module));
        return {};
      },
    });
    const fs = instance.FS as QpdfModule['FS'] & { mkdir?: (path: string) => void };
    fs.mkdir?.('/work');
    fs.writeFile(QPDF_INPUT, input);
    let status: number;
    try {
      status = instance.callMain([...args]);
    } catch (error) {
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
      if (/invalid password/i.test(text)) {
        throw new EngineError(
          options.password === undefined && options.decrypt?.password === undefined
            ? 'password-required'
            : 'password-incorrect',
          text,
        );
      }
      throw new EngineError('corrupt', text);
    }
    return { bytes: result.output, repaired: indicatesRepair(result.stderr), warnings };
  }

  /**
   * Structural check (`qpdf --check`): what a diagnostics panel lists as structural
   * warnings. Never rejects for damaged input; reports `unreadable` instead.
   */
  async check(bytes: ArrayBuffer, password?: string): Promise<PlumberCheckResult> {
    const input = QpdfPlumber.guard(bytes);
    const head = new TextDecoder('latin1').decode(input.subarray(0, 1024));
    const version = /%PDF-(\d\.\d)/.exec(head)?.[1];
    const result = await this.run(input, qpdfCheckArgs(password));
    const warnings = result.stderr.map(cleanWarning).filter((line) => line !== '');
    const text = result.stdout.join('\n');
    const encrypted =
      /File is (?!not encrypted)/i.test(text) && !/File is not encrypted/i.test(text);
    const linearized = /File is linearized/i.test(text) && !/File is not linearized/i.test(text);
    const unreadable = result.status === QPDF_EXIT.error && !/checking/i.test(text);
    return {
      ok: result.status === QPDF_EXIT.ok && warnings.length === 0,
      unreadable,
      repaired: indicatesRepair(result.stderr),
      encrypted,
      linearized,
      warnings:
        result.status === QPDF_EXIT.error && warnings.length === 0
          ? [`qpdf exited with status ${result.status}`]
          : warnings,
      ...(version === undefined ? {} : { version }),
    };
  }
}
