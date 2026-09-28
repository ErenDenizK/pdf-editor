/**
 * The OCR files served from the app's origin (ADR-0012 §2–§4), for Node: the Vite plugin
 * that serves them in dev and tests and emits them into `dist/ocr/`, and the verification
 * shared with `fetch.ts`.
 *
 *   ocr/tesseract-7.0.0/worker.min.js                 tesseract.js's worker, pnpm-patched
 *   ocr/tesseract-7.0.0/tesseract-core-<v>.{js,wasm}  <v> = lstm, simd-lstm, relaxedsimd-lstm
 *   ocr/lang/<code>.traineddata.gz                     tessdata_fast packs, committed here
 *
 * Worker and cores come from `node_modules` (pnpm pins them with integrity hashes; the
 * worker carries the one-token fix of `patches/tesseract.js@7.0.0.patch`). The packs are
 * committed in `lang/`, fetched by `fetch.ts`. Every file is checked against
 * `langs.lock.json` whenever it is served or emitted, so a changed dependency, a lost patch
 * or a corrupt pack fails the build instead of shipping. The files stay unhashed: the
 * version is the directory, and Emscripten finds the `.wasm` by name next to the worker.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

import type { Plugin } from 'vite';

export const OCR_DIR = fileURLToPath(new URL('.', import.meta.url));
export const LOCK_PATH = join(OCR_DIR, 'langs.lock.json');

/** `worker.min.js` of tesseract.js 7.0.0 joins `l.data` instead of `l.code` (research 07 §1). */
export const WORKER_BUG = 'return"string"==typeof t?t:t.data}';
export const WORKER_FIX = 'return"string"==typeof t?t:t.code}';

export interface LockedFile {
  readonly sha256: string;
  readonly bytes: number;
}

export interface LockedLanguage {
  readonly url: string;
  /** SHA-256 and size of the raw `.traineddata` (what the browser loader checks). */
  readonly sha256: string;
  readonly bytes: number;
  /** SHA-256 and size of the committed gzip file (what goes over the wire). */
  readonly gzSha256: string;
  readonly gzBytes: number;
}

export interface OcrLock {
  readonly $comment?: string;
  readonly tesseract: {
    readonly version: string;
    readonly coreVersion: string;
    /** Directory under `ocr/` holding the worker and the cores. */
    readonly directory: string;
    readonly patch: { readonly file: string; readonly from: string; readonly to: string };
    readonly files: Readonly<Record<string, LockedFile>>;
  };
  readonly tessdata: {
    readonly repository: string;
    readonly commit: string;
    readonly license: string;
  };
  /** In the order of ADR-0012's set. */
  readonly languages: Readonly<Record<string, LockedLanguage>>;
  readonly glyphlessFont: LockedFile & { readonly url: string; readonly license: string };
}

export function readLock(): OcrLock {
  return JSON.parse(readFileSync(LOCK_PATH, 'utf8')) as OcrLock;
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const require = createRequire(import.meta.url);

function packageDir(name: string): string {
  return dirname(require.resolve(`${name}/package.json`));
}

/** The LSTM-only core variants served (ADR-0012 §2), picked in the browser by probes. */
export const CORE_VARIANTS = ['lstm', 'simd-lstm', 'relaxedsimd-lstm'] as const;

/** Engine files: published name → source path in node_modules. */
export function engineSources(): Record<string, string> {
  const out: Record<string, string> = {
    'worker.min.js': join(packageDir('tesseract.js'), 'dist', 'worker.min.js'),
  };
  const core = packageDir('tesseract.js-core');
  for (const variant of CORE_VARIANTS) {
    for (const ext of ['.js', '.wasm']) {
      const name = `tesseract-core-${variant}${ext}`;
      out[name] = join(core, name);
    }
  }
  return out;
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Throws unless `worker.min.js` carries the fix exactly once and the bug nowhere. */
export function assertWorkerPatched(bytes: Uint8Array, where: string): void {
  const text = new TextDecoder().decode(bytes);
  const fixed = count(text, WORKER_FIX);
  const buggy = count(text, WORKER_BUG);
  if (fixed !== 1 || buggy !== 0) {
    throw new Error(
      `${where}: tesseract.js worker patch site not as expected (fix ×${fixed}, bug ×${buggy}); ` +
        'is patches/tesseract.js@7.0.0.patch applied (pnpm install)?',
    );
  }
}

function checkFile(name: string, bytes: Uint8Array, locked: LockedFile | undefined): void {
  if (!locked) throw new Error(`ocr/${name}: not in langs.lock.json`);
  const actual = sha256(bytes);
  if (actual !== locked.sha256 || bytes.length !== locked.bytes) {
    throw new Error(
      `ocr/${name}: SHA-256 ${actual} (${bytes.length} bytes), ` +
        `langs.lock.json says ${locked.sha256} (${locked.bytes} bytes)`,
    );
  }
}

export interface OcrAsset {
  /** Path under `ocr/`, e.g. `tesseract-7.0.0/worker.min.js`. */
  readonly path: string;
  readonly source: string;
}

/** Every file served under `ocr/`, with its source on disk. */
export function ocrAssets(lock: OcrLock = readLock()): OcrAsset[] {
  const dir = lock.tesseract.directory;
  const engine = Object.entries(engineSources()).map(([name, source]) => ({
    path: `${dir}/${name}`,
    source,
  }));
  const packs = Object.keys(lock.languages).map((code) => ({
    path: `lang/${code}.traineddata.gz`,
    source: join(OCR_DIR, 'lang', `${code}.traineddata.gz`),
  }));
  return [...engine, ...packs];
}

/** Reads one served file and checks it against the lock (and the worker's patch site). */
export function readVerified(asset: OcrAsset, lock: OcrLock = readLock()): Uint8Array {
  const bytes = new Uint8Array(readFileSync(asset.source));
  const dir = `${lock.tesseract.directory}/`;
  if (asset.path.startsWith(dir)) {
    const name = asset.path.slice(dir.length);
    if (name === lock.tesseract.patch.file) assertWorkerPatched(bytes, asset.source);
    checkFile(asset.path, bytes, lock.tesseract.files[name]);
    return bytes;
  }
  const code = /^lang\/(.+)\.traineddata\.gz$/.exec(asset.path)?.[1];
  const language = code === undefined ? undefined : lock.languages[code];
  if (!language) throw new Error(`ocr/${asset.path}: not in langs.lock.json`);
  checkFile(asset.path, bytes, { sha256: language.gzSha256, bytes: language.gzBytes });
  checkFile(`${asset.path} (inflated)`, gunzipSync(bytes), language);
  return bytes;
}

/** Verifies every served file; returns their paths and sizes (for reports). */
export function verifyOcrAssets(lock: OcrLock = readLock()): { path: string; bytes: number }[] {
  return ocrAssets(lock).map((asset) => ({
    path: asset.path,
    bytes: readVerified(asset, lock).length,
  }));
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
  // No Content-Encoding: the browser must not inflate the packs itself (research 07 §1 #4;
  // the loader sniffs the gzip magic either way).
  '.gz': 'application/octet-stream',
};

/**
 * Serves `ocr/**` in dev and tests (under Vite's `base`) and emits it into the build output
 * as unhashed assets. Every file is verified against the lock first.
 */
export function ocrAssetsPlugin(): Plugin {
  let base = '/';
  return {
    name: 'pdf-editor-ocr-assets',
    configResolved(config) {
      base = config.base.endsWith('/') ? config.base : `${config.base}/`;
    },
    configureServer(server) {
      const lock = readLock();
      const assets = new Map(ocrAssets(lock).map((a) => [a.path, a]));
      server.middlewares.use((req, res, next) => {
        const pathname = (req.url ?? '').split('?')[0] ?? '';
        const prefix = `${base}ocr/`;
        const asset = pathname.startsWith(prefix)
          ? assets.get(decodeURIComponent(pathname.slice(prefix.length)))
          : undefined;
        if (!asset) {
          next();
          return;
        }
        try {
          const bytes = readVerified(asset, lock);
          const ext = /\.[a-z]+$/.exec(asset.path)?.[0] ?? '';
          res.setHeader('Content-Type', CONTENT_TYPES[ext] ?? 'application/octet-stream');
          res.setHeader('Content-Length', String(bytes.length));
          res.setHeader('Cache-Control', 'no-cache');
          res.end(bytes);
        } catch (error) {
          next(error);
        }
      });
    },
    generateBundle() {
      const lock = readLock();
      for (const asset of ocrAssets(lock)) {
        this.emitFile({
          type: 'asset',
          fileName: `ocr/${asset.path}`,
          source: readVerified(asset, lock),
        });
      }
    },
  };
}
