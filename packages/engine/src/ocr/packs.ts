/**
 * Language packs for OCR (ADR-0012 §3–§4): the loader the recognizer takes its model bytes
 * from. Packs on the app's origin (`ocr/lang/<code>.traineddata.gz`, tessdata_fast pinned in
 * `ocr/langs.lock.json`, which is bundled into this module) are fetched on first use and
 * kept in the `pdf-editor-ocr` Cache Storage cache, the same cache the service worker's
 * CacheFirst rule serves them from offline; "Keep available offline" puts them there ahead of
 * time together with the worker and the core. Packs the user imports (`.traineddata` or
 * `.traineddata.gz` files, never URLs) are kept in OPFS.
 *
 * Every pack is checked before use: the gzip magic is sniffed (a host may already have
 * inflated it with `Content-Encoding`), `DecompressionStream` inflates it, and the SHA-256 of
 * the raw file must equal the lock's (imported packs: the hash recorded at import). A cached
 * copy that fails the check is deleted and fetched again once.
 */
import lockJson from '../../ocr/langs.lock.json';
import { EngineError, type ProgressCallback } from '../types';

/** The lock file's shape as the browser needs it. */
interface BrowserLock {
  readonly tesseract: {
    readonly version: string;
    readonly directory: string;
  };
  readonly tessdata: { readonly commit: string };
  readonly languages: Readonly<
    Record<string, { readonly sha256: string; readonly bytes: number; readonly gzBytes: number }>
  >;
}

export const OCR_LOCK: BrowserLock = lockJson;

/** The runtime cache shared with the service worker (apps/web/vite.config.ts). */
export const OCR_CACHE_NAME = 'pdf-editor-ocr';
const OPFS_DIR = 'ocr-packs';

export interface OcrLanguagePack {
  readonly code: string;
  /** `origin`: one of the app's packs; `imported`: a file the user added (overrides). */
  readonly source: 'origin' | 'imported';
  /** Size of the model, bytes (inflated). */
  readonly bytes: number;
  /** What a download costs (gzip bytes); 0 when on the device. */
  readonly downloadBytes: number;
  /** Available without a network (Cache Storage or OPFS). */
  readonly onDevice: boolean;
}

export interface OcrPackLoadOptions {
  readonly signal?: AbortSignal;
  /** Bytes received / expected while downloading. */
  readonly onProgress?: ProgressCallback;
}

export interface OcrPackStoreOptions {
  /** URL of the served `ocr/` directory (e.g. `${import.meta.env.BASE_URL}ocr/`). */
  readonly baseUrl: string;
  /** Cache Storage name; default `OCR_CACHE_NAME`. */
  readonly cacheName?: string;
  /** OPFS directory for imported packs; default `ocr-packs`. */
  readonly importDirectory?: string;
}

const GZIP = [0x1f, 0x8b] as const;

export function isGzip(bytes: Uint8Array): boolean {
  return bytes[0] === GZIP[0] && bytes[1] === GZIP[1];
}

export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Resolves `url` against the page or worker location (absolute URLs pass through). */
export function absoluteUrl(url: string): string {
  const base = (globalThis as { location?: { href: string } }).location?.href;
  return base === undefined ? url : new URL(url, base).href;
}

/**
 * Checks that `bytes` look like a Tesseract `.traineddata` (TessdataManager's table: an
 * int32 entry count, then that many int64 offsets, each -1 or inside the file).
 */
export function looksLikeTraineddata(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = view.getInt32(0, true);
  if (entries < 1 || entries > 64) return false;
  const tableEnd = 4 + entries * 8;
  if (bytes.length < tableEnd) return false;
  let any = false;
  for (let i = 0; i < entries; i++) {
    const offset = Number(view.getBigInt64(4 + i * 8, true));
    if (offset === -1) continue;
    if (offset < tableEnd || offset > bytes.length) return false;
    any = true;
  }
  return any;
}

/** Language code of an imported file name (`tur.traineddata.gz` → `tur`). */
export function codeFromFileName(name: string): string | undefined {
  const code = /^([A-Za-z0-9_-]{2,40})\.traineddata(?:\.gz)?$/.exec(
    name.split(/[\\/]/).pop() ?? '',
  );
  return code?.[1];
}

const VALID_CODE = /^[A-Za-z0-9_-]{2,40}$/;

function aborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new EngineError('aborted', 'Language pack loading was cancelled');
}

async function opfsDir(name: string): Promise<FileSystemDirectoryHandle | undefined> {
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(name, { create: true });
  } catch {
    return undefined;
  }
}

async function readOpfs(dir: FileSystemDirectoryHandle, name: string): Promise<Uint8Array> {
  const file = await (await dir.getFileHandle(name)).getFile();
  return new Uint8Array(await file.arrayBuffer());
}

async function writeOpfs(
  dir: FileSystemDirectoryHandle,
  name: string,
  bytes: Uint8Array | string,
): Promise<void> {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(bytes as Uint8Array<ArrayBuffer> | string);
  await writable.close();
}

interface ImportedMeta {
  readonly code: string;
  readonly sha256: string;
  readonly bytes: number;
}

/** The language pack loader (one per app; it keeps loaded packs in memory). */
export class OcrPackStore {
  readonly baseUrl: string;
  private readonly cacheName: string;
  private readonly importDirectory: string;
  private readonly loaded = new Map<string, Promise<Uint8Array>>();
  /** The one sweep of other versions' entries per store (`sweepOnce`). */
  private swept?: Promise<void>;

  constructor(options: OcrPackStoreOptions) {
    const base = absoluteUrl(options.baseUrl);
    this.baseUrl = base.endsWith('/') ? base : `${base}/`;
    this.cacheName = options.cacheName ?? OCR_CACHE_NAME;
    this.importDirectory = options.importDirectory ?? OPFS_DIR;
  }

  /** Codes of the packs served from the origin, in the lock's order. */
  get originLanguages(): string[] {
    return Object.keys(OCR_LOCK.languages);
  }

  packUrl(code: string): string {
    return `${this.baseUrl}lang/${code}.traineddata.gz`;
  }

  /** URL of an engine file (`worker.min.js`, `tesseract-core-<variant>.js` / `.wasm`). */
  engineUrl(name: string): string {
    return `${this.baseUrl}${OCR_LOCK.tesseract.directory}/${name}`;
  }

  private async cache(): Promise<Cache | undefined> {
    try {
      return typeof caches === 'undefined' ? undefined : await caches.open(this.cacheName);
    } catch {
      return undefined;
    }
  }

  private async imported(): Promise<Map<string, ImportedMeta>> {
    const out = new Map<string, ImportedMeta>();
    const dir = await opfsDir(this.importDirectory);
    if (!dir) return out;
    for await (const [name, handle] of (
      dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }
    ).entries()) {
      if (handle.kind !== 'file' || !name.endsWith('.json')) continue;
      try {
        const meta = JSON.parse(
          new TextDecoder().decode(await readOpfs(dir, name)),
        ) as ImportedMeta;
        if (typeof meta.code === 'string' && typeof meta.sha256 === 'string') {
          out.set(meta.code, meta);
        }
      } catch {
        // A half-written import: ignored (remove() cleans it up).
      }
    }
    return out;
  }

  /** Every available language: the origin's and the imported ones. */
  async list(): Promise<OcrLanguagePack[]> {
    const cache = await this.cache();
    const imported = await this.imported();
    const out: OcrLanguagePack[] = [];
    for (const [code, locked] of Object.entries(OCR_LOCK.languages)) {
      const mine = imported.get(code);
      if (mine) continue;
      const onDevice = cache ? (await cache.match(this.packUrl(code))) !== undefined : false;
      out.push({
        code,
        source: 'origin',
        bytes: locked.bytes,
        downloadBytes: onDevice ? 0 : locked.gzBytes,
        onDevice,
      });
    }
    for (const meta of imported.values()) {
      out.push({
        code: meta.code,
        source: 'imported',
        bytes: meta.bytes,
        downloadBytes: 0,
        onDevice: true,
      });
    }
    return out;
  }

  /** The raw `.traineddata` of `code`, checked (shared: do not transfer or modify it). */
  load(code: string, options: OcrPackLoadOptions = {}): Promise<Uint8Array> {
    let pending = this.loaded.get(code);
    if (!pending) {
      pending = this.read(code, options);
      pending.catch(() => this.loaded.delete(code));
      this.loaded.set(code, pending);
    }
    return pending;
  }

  /**
   * Deletes other engine versions and packs no longer in the lock from the cache, once per
   * store, before the first pack is loaded (ADR-0012 §4: the loader deletes old versions;
   * `cleanupOutdatedCaches` never touches this runtime cache). Without it an upgrade would
   * keep the previous core (≈ 3 MB) on the device until "Keep available offline" ran. Best
   * effort: a failing sweep never stops recognition.
   */
  private sweepOnce(): Promise<void> {
    this.swept ??= this.deleteOldVersions().then(
      () => undefined,
      () => undefined,
    );
    return this.swept;
  }

  private async read(code: string, options: OcrPackLoadOptions): Promise<Uint8Array> {
    aborted(options.signal);
    await this.sweepOnce();
    const imported = (await this.imported()).get(code);
    if (imported) {
      const dir = await opfsDir(this.importDirectory);
      if (!dir) throw new EngineError('internal', `Imported language ${code}: storage unavailable`);
      const raw = await readOpfs(dir, `${code}.traineddata`);
      if ((await sha256Hex(raw)) !== imported.sha256) {
        throw new EngineError('corrupt', `Imported language ${code} is damaged; import it again`);
      }
      return raw;
    }
    const locked = OCR_LOCK.languages[code];
    if (!locked) {
      throw new EngineError('unsupported', `No language pack "${code}" (import one first)`);
    }
    const url = this.packUrl(code);
    const cache = await this.cache();
    for (let attempt = 0; attempt < 2; attempt++) {
      const cached = attempt === 0 ? await cache?.match(url) : undefined;
      const response = cached ?? (await this.download(url, locked.gzBytes, options));
      const body = new Uint8Array(await response.arrayBuffer());
      const raw = isGzip(body) ? await gunzip(body) : body;
      if ((await sha256Hex(raw)) === locked.sha256) {
        if (!cached && cache) {
          // Keep the bytes as served (usually gzip) for offline use.
          await cache.put(
            url,
            new Response(body, { headers: { 'Content-Type': 'application/gzip' } }),
          );
        }
        return raw;
      }
      // A stale or damaged copy: drop it and fetch once more from the network.
      await cache?.delete(url);
      if (!cached) break;
    }
    throw new EngineError('corrupt', `Language pack ${code} does not match its SHA-256`);
  }

  private async download(
    url: string,
    expected: number,
    options: OcrPackLoadOptions,
  ): Promise<Response> {
    aborted(options.signal);
    const response = await fetch(url, {
      cache: 'no-cache',
      ...(options.signal ? { signal: options.signal } : {}),
    }).catch((cause: unknown) => {
      aborted(options.signal);
      throw new EngineError('internal', `Could not download ${url}`, { cause });
    });
    if (!response.ok || !response.body) {
      throw new EngineError('internal', `Could not download ${url} (HTTP ${response.status})`);
    }
    const total = Number(response.headers.get('Content-Length')) || expected;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let done = 0;
    options.onProgress?.(0, total);
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
      done += next.value.length;
      options.onProgress?.(Math.min(done, total), total);
    }
    const out = new Uint8Array(done);
    let at = 0;
    for (const chunk of chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return new Response(out);
  }

  /**
   * "Keep available offline": puts the packs, the worker and the given core files into the
   * cache (downloading what is missing); with `keep: false`, removes the packs from it.
   */
  async keepOffline(
    codes: readonly string[],
    keep: boolean,
    engineFiles: readonly string[],
    options: OcrPackLoadOptions = {},
  ): Promise<void> {
    const cache = await this.cache();
    if (!cache) throw new EngineError('unsupported', 'Offline storage is not available here');
    if (!keep) {
      for (const code of codes) await cache.delete(this.packUrl(code));
      return;
    }
    for (const code of codes) {
      if (OCR_LOCK.languages[code]) await this.load(code, options);
    }
    for (const name of engineFiles) {
      const url = this.engineUrl(name);
      if (!(await cache.match(url))) await cache.add(url);
    }
    await this.deleteOldVersions(cache);
  }

  /** Removes cache entries of other engine versions and packs no longer in the lock. */
  async deleteOldVersions(cache?: Cache): Promise<number> {
    const c = cache ?? (await this.cache());
    if (!c) return 0;
    const current = `${this.baseUrl}${OCR_LOCK.tesseract.directory}/`;
    let removed = 0;
    for (const request of await c.keys()) {
      const url = request.url;
      if (!url.startsWith(this.baseUrl)) continue;
      const rest = url.slice(this.baseUrl.length);
      const stale =
        (rest.startsWith('tesseract-') && !url.startsWith(current)) ||
        (rest.startsWith('lang/') &&
          !Object.keys(OCR_LOCK.languages).some((code) => url === this.packUrl(code)));
      if (stale && (await c.delete(request))) removed++;
    }
    return removed;
  }

  /**
   * Imports a local `.traineddata` or `.traineddata.gz` into OPFS (overriding an origin pack
   * of the same code). The code comes from the file name unless given.
   */
  async importFile(file: Blob, name?: string, code?: string): Promise<OcrLanguagePack> {
    const fileName = name ?? (file as Partial<File>).name ?? '';
    const lang = code ?? codeFromFileName(fileName);
    if (!lang || !VALID_CODE.test(lang)) {
      throw new EngineError(
        'unsupported',
        `"${fileName}" is not named like a language file (e.g. tur.traineddata)`,
      );
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const raw = isGzip(bytes) ? await gunzip(bytes) : bytes;
    if (!looksLikeTraineddata(raw)) {
      throw new EngineError('corrupt', `"${fileName}" is not a Tesseract language file`);
    }
    const dir = await opfsDir(this.importDirectory);
    if (!dir)
      throw new EngineError('unsupported', 'Storage for imported languages is not available');
    const meta: ImportedMeta = { code: lang, sha256: await sha256Hex(raw), bytes: raw.length };
    await writeOpfs(dir, `${lang}.traineddata`, raw);
    await writeOpfs(dir, `${lang}.json`, JSON.stringify(meta));
    this.loaded.delete(lang);
    return { code: lang, source: 'imported', bytes: raw.length, downloadBytes: 0, onDevice: true };
  }

  /** Removes an imported pack, or the device copy of an origin pack. */
  async remove(code: string): Promise<void> {
    this.loaded.delete(code);
    const dir = await opfsDir(this.importDirectory);
    let removedImport = false;
    if (dir) {
      for (const name of [`${code}.json`, `${code}.traineddata`]) {
        try {
          await dir.removeEntry(name);
          removedImport = true;
        } catch {
          // Not there.
        }
      }
    }
    if (!removedImport) await (await this.cache())?.delete(this.packUrl(code));
  }

  /** Drops the in-memory copies (the device copies stay). */
  forget(): void {
    this.loaded.clear();
  }
}
