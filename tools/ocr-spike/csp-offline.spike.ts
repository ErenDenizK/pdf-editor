/**
 * SPIKE S1 (M5): not product code. Question 1 and 5 of docs/research/07-ocr-spike.md:
 * tesseract.js 7 served entirely from our origin, under apps/web/index.html's exact CSP,
 * with `workerBlobURL: false`, and fully offline behind a CacheFirst service worker.
 *
 *   pnpm --filter @pdf-editor/ocr-spike spike csp-offline
 *
 * Runs in Node: a tiny static server (assets.ts PUBLIC_DIR plus the pages in csp-site.ts) and
 * Playwright Chromium, one fresh context per scenario. Every request is logged twice (by
 * Playwright, which in Chromium also reports dedicated-worker requests, and by our server),
 * and every request to another origin is aborted and counted. A second server on another
 * port is the "foreign origin" for the cross-origin probe. Chromium only: Firefox and
 * WebKit are not installed in the environment the spike ran in.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize } from 'node:path';

import { type Browser, type BrowserContext, chromium } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { chromiumLaunchOptions } from '../../tooling/playwright-chromium.ts';
import { PUBLIC_DIR, SPIKE_ROOT } from './assets.ts';
import { APP_JS, appCsp, CANVAS_TEXT, indexHtml, PROBE_WORKER_JS, SW_JS } from './csp-site.ts';

interface Hit {
  readonly path: string;
  readonly status: number;
  readonly bytes: number;
}

interface PageResult {
  scenario: string;
  variant: string;
  relaxed: boolean;
  simd: boolean;
  violations: { directive: string; blocked: string }[];
  timings: Record<string, number>;
  errors?: string[];
  error?: string;
  text?: string;
  confidence?: number;
  version?: string;
  controlled?: boolean;
  pageFetch?: string;
  workerFetch?: string;
}

interface ScenarioRecord {
  readonly name: string;
  readonly query: string;
  readonly result: PageResult;
  readonly hits: readonly Hit[];
  readonly nonSelf: readonly string[];
  readonly playwrightUrls: readonly string[];
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
  '.gz': 'application/gzip',
  '.ttf': 'font/ttf',
};

const csp = appCsp();
const pages: Record<string, string> = {
  '/index.html': indexHtml(csp),
  '/app.js': APP_JS,
  '/probe-worker.js': PROBE_WORKER_JS,
  '/sw.js': SW_JS,
};

let hits: Hit[] = [];
let foreignHits: string[] = [];
let server: Server;
let foreign: Server;
let origin = '';
let foreignOrigin = '';
let browser: Browser;
const records: ScenarioRecord[] = [];

function listen(s: Server): Promise<string> {
  return new Promise((resolve) => {
    s.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(s.address() as AddressInfo).port}`);
    });
  });
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    const inline = pages[path];
    if (inline !== undefined) {
      const body = Buffer.from(inline);
      res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'text/plain' });
      res.end(body);
      hits.push({ path, status: 200, bytes: body.length });
      return;
    }
    const file = normalize(join(PUBLIC_DIR, path));
    try {
      if (!file.startsWith(PUBLIC_DIR) || !statSync(file).isFile()) throw new Error('404');
      const body = readFileSync(file);
      res.writeHead(200, {
        'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      });
      res.end(body);
      hits.push({ path, status: 200, bytes: body.length });
    } catch {
      res.writeHead(404).end();
      hits.push({ path, status: 404, bytes: 0 });
    }
  });
  foreign = createServer((req, res) => {
    foreignHits.push(req.url ?? '');
    res.writeHead(200, { 'access-control-allow-origin': '*' }).end('foreign');
  });
  origin = await listen(server);
  foreignOrigin = await listen(foreign);
  browser = await chromium.launch(chromiumLaunchOptions());
}, 60_000);

afterAll(async () => {
  await browser.close();
  server.close();
  foreign.close();
  const dir = join(SPIKE_ROOT, 'results');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'csp-offline.json'),
    `${JSON.stringify({ csp, chromium: browser.version(), records }, null, 2)}\n`,
  );
});

async function scenario(
  name: string,
  query: string,
  context?: BrowserContext,
  intercept = true,
): Promise<ScenarioRecord> {
  const ctx = context ?? (await browser.newContext());
  hits = [];
  foreignHits = [];
  const playwrightUrls: string[] = [];
  const nonSelf: string[] = [];
  ctx.on('request', (request) => {
    const url = request.url();
    playwrightUrls.push(url);
    if (!intercept && !url.startsWith(origin) && !/^(blob|data):/.test(url)) nonSelf.push(url);
  });
  // Chromium bypasses service workers while request interception is on, so the offline
  // scenario runs without it and relies on the request events and the server logs.
  if (intercept)
    await ctx.route(
      (url) => url.origin !== origin,
      async (route) => {
        const url = route.request().url();
        nonSelf.push(url);
        // The cross-origin probe server is allowed through so that the test can see whether
        // CSP (not the network) stopped a request; everything else is refused.
        if (url.startsWith(foreignOrigin)) await route.continue();
        else await route.abort();
      },
    );
  const page = await ctx.newPage();
  await page.goto(`${origin}/index.html?${query}&other=${encodeURIComponent(foreignOrigin)}`);
  const result = await page.evaluate<PageResult>('window.__result');
  await page.close();
  if (!context) await ctx.close();
  const record = {
    name,
    query,
    result,
    hits: [...hits],
    nonSelf: [...nonSelf, ...foreignHits.map((p) => `${foreignOrigin}${p} (served)`)],
    playwrightUrls: playwrightUrls.map((u) => u.replace(origin, '')),
  };
  records.push(record);
  return record;
}

const served = (r: ScenarioRecord, suffix: string): Hit | undefined =>
  r.hits.find((h) => h.path.endsWith(suffix));

describe('tesseract.js 7 under the app CSP (Chromium)', () => {
  test('defaults: the blob: worker is refused by worker-src', async () => {
    const r = await scenario('defaults', 's=defaults&timeout=5000');
    expect(r.result.text).toBeUndefined();
    expect(r.result.violations.some((v) => v.directive === 'worker-src')).toBe(true);
    expect(r.nonSelf).toEqual([]);
  });

  test('workerBlobURL false alone: the CDN worker URL never loads', async () => {
    const r = await scenario('no-blob-only', 's=no-blob-only&timeout=5000');
    expect(r.result.text).toBeUndefined();
    expect(r.nonSelf.every((u) => !u.startsWith(foreignOrigin))).toBe(true);
  });

  test('stock worker.min.js: { code, data } languages never initialise (upstream bug)', async () => {
    const r = await scenario(
      'stock worker, { code, data }',
      's=ocr&core=js&pack=fast&lang=eng&timeout=15000',
    );
    expect(r.result.text).toBeUndefined();
    expect(r.result.errors).toContain('initialization failed');
    expect(r.nonSelf).toEqual([]);
  });

  const P = 's=ocr&worker=patched';
  test.each([
    ['js+wasm, fast eng, gzip inflated by tesseract.js', `${P}&core=js&pack=fast&lang=eng`],
    ['js+wasm again in the same context (warm)', `${P}&core=js&pack=fast&lang=eng`],
    ['single-file wasm.js', `${P}&core=wasmjs&pack=fast&lang=eng`],
    ['directory corePath (tesseract.js picks)', `${P}&core=dir&pack=fast&lang=eng`],
    ['best_int eng', `${P}&core=js&pack=best_int&lang=eng`],
    ['fast tur', `${P}&core=js&pack=fast&lang=tur`],
    ['best_int tur', `${P}&core=js&pack=best_int&lang=tur`],
    ['fast eng inflated on the main thread', `${P}&core=js&pack=fast&lang=eng&inflate=main`],
    [
      'stock worker, fast eng by langPath (worker fetches)',
      's=ocr&core=js&pack=fast&lang=eng&form=path',
    ],
  ])('offline from our origin: %s', async (name, query) => {
    const warm = name.includes('warm');
    const shared = warm ? await browser.newContext() : undefined;
    if (shared) await scenario(`${name} (cold run)`, query, shared);
    const r = await scenario(name, query, shared);
    if (shared) await shared.close();
    expect(r.result.error).toBeUndefined();
    expect(r.nonSelf).toEqual([]);
    expect(r.result.violations).toEqual([]);
    if (query.includes('lang=eng')) expect(r.result.text).toBe(CANVAS_TEXT);
    expect(r.result.text?.length ?? 0).toBeGreaterThan(0);
  });

  test('the explicit .js core finds its .wasm next to the worker, not next to itself', async () => {
    const ok = records.find((r) => r.query === `${P}&core=js&pack=fast&lang=eng`);
    expect(
      ok && served(ok, `tesseract-7.0.0/tesseract-core-${ok.result.variant}.wasm`),
    ).toBeTruthy();
    const r = await scenario(
      'split directories',
      's=ocr&core=split&pack=fast&lang=eng&timeout=10000',
    );
    expect(r.result.text).toBeUndefined();
    const wasm = r.hits.find((h) => h.path.endsWith('.wasm'));
    expect(wasm?.path).toBe(`/ocr/split/worker/tesseract-core-${r.result.variant}.wasm`);
    expect(wasm?.status).toBe(404);
  });

  test('the meta CSP binds the page but not a same-origin dedicated worker', async () => {
    const r = await scenario('cross-origin probe', 's=xorigin');
    expect(r.result.pageFetch).toMatch(/^blocked/);
    expect(r.result.violations.some((v) => v.directive === 'connect-src')).toBe(true);
    expect(r.result.workerFetch).toMatch(/^allowed/);
  });

  test('after first use, OCR runs with the network off (service worker CacheFirst)', async () => {
    const ctx = await browser.newContext();
    const first = await scenario(
      'sw first use (online)',
      's=sw-install&worker=patched&core=js&pack=fast&lang=eng',
      ctx,
      false,
    );
    expect(first.result.text).toBe(CANVAS_TEXT);
    await ctx.setOffline(true);
    const second = await scenario(
      'sw second use (offline)',
      `${P}&core=js&pack=fast&lang=eng`,
      ctx,
      false,
    );
    await ctx.close();
    expect(second.result.error).toBeUndefined();
    expect(second.result.controlled).toBe(true);
    expect(second.result.text).toBe(CANVAS_TEXT);
    expect(second.hits).toEqual([]);
    expect(second.nonSelf).toEqual([]);
  });
});
