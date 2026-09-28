/**
 * SPIKE S1 (M5): not product code. Evidence for docs/research/07-ocr-spike.md.
 *
 * Prepares `node_modules/.spike-downloads/public/` (ignored by git, ESLint and Biome), the static root both spike runners serve, in the layout
 * the spike proposes for the deployed site:
 *
 *   ocr/tesseract-7.0.0/   worker.min.js + every LSTM-only core variant (.js + .wasm and
 *                          the single-file .wasm.js), side by side (Emscripten looks for the
 *                          .wasm next to the *worker*, see csp-offline.spike.ts)
 *   ocr/split/             the same files split into worker/ and core/ (negative case)
 *   ocr/lang/fast/         tessdata_fast eng + tur at a pinned commit, gzip -9 by us
 *   ocr/lang/best_int/     tesseract.js's default `4.0.0_best_int` (from @tesseract.js-data)
 *   ocr/pdf.ttf            Tesseract's glyphless font (tessconfigs, pinned commit)
 *   ocr/tesseract.esm.min.js  the API (the app would bundle it as a lazy chunk)
 *
 * Remote files are fetched with curl at pinned commits and checked against SHA-256 values,
 * a prototype of the `langs.lock.json` idea in spec recognize-and-compare.md §1.1.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

export const SPIKE_ROOT = fileURLToPath(new URL('.', import.meta.url));
export const PUBLIC_DIR = join(SPIKE_ROOT, 'node_modules', '.spike-downloads', 'public');
const REMOTE_DIR = join(SPIKE_ROOT, 'node_modules', '.spike-downloads', 'remote');
const MODULES = join(SPIKE_ROOT, 'node_modules');

/** tesseract-ocr/tessdata_fast `main` on 2026-09-28. */
export const TESSDATA_FAST_COMMIT = '87416418657359cb625c412a48b6e1d6d41c29bd';
/** tesseract-ocr/tessconfigs `main` on 2026-09-28 (pdf.ttf, identical in tesseract/tessdata). */
export const TESSCONFIGS_COMMIT = '3decf1c8252ba6dbeef0bf908f4b0aab7f18d113';

interface LockedFile {
  readonly url: string;
  readonly sha256: string;
  readonly name: string;
}

export const LOCK: readonly LockedFile[] = [
  {
    name: 'fast-eng.traineddata',
    url: `https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/${TESSDATA_FAST_COMMIT}/eng.traineddata`,
    sha256: '7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2',
  },
  {
    name: 'fast-tur.traineddata',
    url: `https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/${TESSDATA_FAST_COMMIT}/tur.traineddata`,
    sha256: '7393381111e1152420fc4092cb44eef4237580d21b92bf30d7d221aad192c6b7',
  },
  {
    name: 'pdf.ttf',
    url: `https://raw.githubusercontent.com/tesseract-ocr/tessconfigs/${TESSCONFIGS_COMMIT}/pdf.ttf`,
    sha256: 'c7845420925a23d88ed830a63957b8af85a66a8daf8d9fc90e843673b2ef1a59',
  },
];

export const CORE_VARIANTS = ['lstm', 'simd-lstm', 'relaxedsimd-lstm'] as const;
export const LANGS = ['eng', 'tur'] as const;

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function copy(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  if (!existsSync(to)) copyFileSync(from, to);
}

/**
 * tesseract.js 7.0.0 (and master on 2026-09-28) initialises the API with `l.data` instead of
 * `l.code` for `{ code, data }` languages (src/worker-script/index.js, `initialize`), so
 * handing over our own bytes always ends in "initialization failed". This one-token patch
 * of the shipped worker is what the spike recommends carrying until upstream fixes it.
 */
export const WORKER_BUG = 'return"string"==typeof t?t:t.data}';
export const WORKER_FIX = 'return"string"==typeof t?t:t.code}';

function writePatchedWorker(from: string, to: string): void {
  const source = readFileSync(from, 'utf8');
  if (source.split(WORKER_BUG).length !== 2)
    throw new Error('worker.min.js: patch site not unique');
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, source.replace(WORKER_BUG, WORKER_FIX));
}

/** Downloads (once) and verifies the pinned files, then lays out PUBLIC_DIR. Idempotent. */
export function ensureAssets(): void {
  mkdirSync(REMOTE_DIR, { recursive: true });
  for (const file of LOCK) {
    const path = join(REMOTE_DIR, file.name);
    if (!existsSync(path)) {
      execFileSync('curl', ['-sSfL', '--retry', '3', '-o', path, file.url]);
    }
    const actual = sha256(readFileSync(path));
    if (actual !== file.sha256) {
      throw new Error(`${file.name}: SHA-256 ${actual}, expected ${file.sha256}`);
    }
  }

  const ocr = join(PUBLIC_DIR, 'ocr');
  const worker = join(MODULES, 'tesseract.js', 'dist', 'worker.min.js');
  copy(worker, join(ocr, 'tesseract-7.0.0', 'worker.min.js'));
  copy(worker, join(ocr, 'split', 'worker', 'worker.min.js'));
  writePatchedWorker(worker, join(ocr, 'tesseract-7.0.0', 'worker.patched.min.js'));
  for (const variant of CORE_VARIANTS) {
    for (const ext of ['.js', '.wasm', '.wasm.js']) {
      const name = `tesseract-core-${variant}${ext}`;
      copy(join(MODULES, 'tesseract.js-core', name), join(ocr, 'tesseract-7.0.0', name));
      if (ext !== '.wasm.js') {
        copy(join(MODULES, 'tesseract.js-core', name), join(ocr, 'split', 'core', name));
      }
    }
  }
  copy(
    join(MODULES, 'tesseract.js', 'dist', 'tesseract.esm.min.js'),
    join(ocr, 'tesseract.esm.min.js'),
  );
  copy(join(REMOTE_DIR, 'pdf.ttf'), join(ocr, 'pdf.ttf'));
  for (const lang of LANGS) {
    const fastGz = join(ocr, 'lang', 'fast', `${lang}.traineddata.gz`);
    if (!existsSync(fastGz)) {
      mkdirSync(dirname(fastGz), { recursive: true });
      const raw = readFileSync(join(REMOTE_DIR, `fast-${lang}.traineddata`));
      writeFileSync(fastGz, gzipSync(raw, { level: 9 }));
    }
    copy(
      join(MODULES, '@tesseract.js-data', lang, '4.0.0_best_int', `${lang}.traineddata.gz`),
      join(ocr, 'lang', 'best_int', `${lang}.traineddata.gz`),
    );
  }
}
