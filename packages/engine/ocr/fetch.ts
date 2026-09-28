/**
 * Fetches, pins and verifies the OCR files (ADR-0012 §3), like qpdf/build.sh for qpdf:
 *
 *   node packages/engine/ocr/fetch.ts           # download missing packs, then verify all
 *   node packages/engine/ocr/fetch.ts --verify  # verify only (no network; CI runs it as
 *                                               # `pnpm --filter @pdf-editor/engine ocr:verify`)
 *   node packages/engine/ocr/fetch.ts --pin     # re-pin: rewrite langs.lock.json from the
 *                                               # pinned tessdata commit and node_modules
 *
 * Packs: tessdata_fast at `TESSDATA_COMMIT`, downloaded with curl from GitHub (raw), checked
 * against the lock's raw SHA-256, gzipped here (level 9, no name, mtime 0: reproducible) and
 * committed as `lang/<code>.traineddata.gz`. Engine files (worker, cores) are not committed:
 * they come from node_modules and are only checked (`assets.ts`). `pdf.ttf` (Tesseract's
 * glyphless font, 572 bytes) is embedded in src/ocr/glyphless-font.ts and pinned here; the
 * engine tests check the embedded copy against the pin.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import {
  engineSources,
  LOCK_PATH,
  type LockedFile,
  type LockedLanguage,
  OCR_DIR,
  type OcrLock,
  readLock,
  sha256,
  verifyOcrAssets,
  WORKER_BUG,
  WORKER_FIX,
} from './assets.ts';

/** tesseract-ocr/tessdata_fast `main` on 2026-09-28 (research 07). */
const TESSDATA_COMMIT = '87416418657359cb625c412a48b6e1d6d41c29bd';
/** tesseract-ocr/tessconfigs `main` on 2026-09-28: `pdf.ttf`. */
const TESSCONFIGS_COMMIT = '3decf1c8252ba6dbeef0bf908f4b0aab7f18d113';
/** ADR-0012 §3 and spec §8.7: eng and tur first, then the rest. */
const LANGUAGES = ['eng', 'tur', 'deu', 'fra', 'spa', 'ita', 'por', 'nld', 'rus'] as const;

const packUrl = (code: string) =>
  `https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/${TESSDATA_COMMIT}/${code}.traineddata`;
const FONT_URL = `https://raw.githubusercontent.com/tesseract-ocr/tessconfigs/${TESSCONFIGS_COMMIT}/pdf.ttf`;

const downloads = join(tmpdir(), 'pdf-editor-ocr-downloads');

function download(url: string, name: string): Uint8Array {
  mkdirSync(downloads, { recursive: true });
  const path = join(downloads, name);
  if (!existsSync(path)) execFileSync('curl', ['-sSfL', '--retry', '3', '-o', path, url]);
  return new Uint8Array(readFileSync(path));
}

/** gzip -9 with an empty header (no name, mtime 0): the same bytes on every run. */
function gzip(raw: Uint8Array): Uint8Array {
  return new Uint8Array(gzipSync(raw, { level: 9 }));
}

const packPath = (code: string) => join(OCR_DIR, 'lang', `${code}.traineddata.gz`);

function writePack(code: string, raw: Uint8Array): Uint8Array {
  const gz = gzip(raw);
  mkdirSync(join(OCR_DIR, 'lang'), { recursive: true });
  writeFileSync(packPath(code), gz);
  return gz;
}

function pin(): void {
  const languages: Record<string, LockedLanguage> = {};
  for (const code of LANGUAGES) {
    const raw = download(packUrl(code), `${code}.traineddata`);
    const gz = writePack(code, raw);
    languages[code] = {
      url: packUrl(code),
      sha256: sha256(raw),
      bytes: raw.length,
      gzSha256: sha256(gz),
      gzBytes: gz.length,
    };
  }
  const files: Record<string, LockedFile> = {};
  for (const [name, source] of Object.entries(engineSources())) {
    const bytes = new Uint8Array(readFileSync(source));
    files[name] = { sha256: sha256(bytes), bytes: bytes.length };
  }
  const font = download(FONT_URL, 'pdf.ttf');
  const lock: OcrLock = {
    $comment:
      'Pinned OCR files (ADR-0012). Written by `node packages/engine/ocr/fetch.ts --pin`; ' +
      'checked by `--verify`, the build (assets.ts) and the engine tests.',
    tesseract: {
      version: '7.0.0',
      coreVersion: '7.0.0',
      directory: 'tesseract-7.0.0',
      patch: { file: 'worker.min.js', from: WORKER_BUG, to: WORKER_FIX },
      files,
    },
    tessdata: {
      repository: 'https://github.com/tesseract-ocr/tessdata_fast',
      commit: TESSDATA_COMMIT,
      license: 'Apache-2.0',
    },
    languages,
    glyphlessFont: {
      url: FONT_URL,
      sha256: sha256(font),
      bytes: font.length,
      license: 'Apache-2.0',
    },
  };
  writeFileSync(LOCK_PATH, `${JSON.stringify(lock, null, 2)}\n`);
}

/** Downloads (and gzips) packs that are missing, checking the lock's raw SHA-256. */
function fetchMissing(lock: OcrLock): void {
  for (const [code, locked] of Object.entries(lock.languages)) {
    if (existsSync(packPath(code))) continue;
    const raw = download(locked.url, `${code}.traineddata`);
    if (sha256(raw) !== locked.sha256) {
      throw new Error(`${code}: SHA-256 ${sha256(raw)}, langs.lock.json says ${locked.sha256}`);
    }
    writePack(code, raw);
  }
}

const mode = process.argv[2];
if (mode === '--pin') pin();
else if (mode !== '--verify') fetchMissing(readLock());

const verified = verifyOcrAssets();
let total = 0;
for (const { path, bytes } of verified) {
  total += bytes;
  console.log(`ok  ocr/${path}  ${bytes.toLocaleString('en')} bytes`);
}
console.log(`${verified.length} files, ${total.toLocaleString('en')} bytes, match langs.lock.json`);
