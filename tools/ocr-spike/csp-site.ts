/**
 * SPIKE S1 (M5): not product code. The static site csp-offline.spike.ts serves: an
 * index.html carrying apps/web/index.html's Content-Security-Policy meta verbatim, a page
 * script that drives tesseract.js 7 the way the app would, a same-origin probe worker and a
 * minimal CacheFirst service worker. The page scripts are plain JavaScript (they are served
 * as they are, like the files the app would deploy under `ocr/`).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The exact CSP of the app shell, read from apps/web/index.html. */
export function appCsp(): string {
  const html = readFileSync(
    fileURLToPath(new URL('../../apps/web/index.html', import.meta.url)),
    'utf8',
  );
  const match = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html);
  if (!match?.[1]) throw new Error('No CSP meta in apps/web/index.html');
  return match[1];
}

export function indexHtml(csp: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <title>OCR spike</title>
  </head>
  <body>
    <script type="module" src="./app.js"></script>
  </body>
</html>
`;
}

/** Text drawn on the canvas the CSP scenarios recognise. */
export const CANVAS_TEXT = 'Offline OCR works under a strict policy';

/**
 * The page script. Query parameters:
 *   s       scenario: defaults | no-blob-only | ocr | xorigin | sw-install
 *   core    js (explicit .js, .wasm next to the worker) | wasmjs (single file) | dir
 *           (tesseract.js picks a .wasm.js itself) | split (worker and core in two dirs)
 *   pack    fast | best_int;  lang  eng | tur
 *   inflate worker (gzip bytes handed over, tesseract.js inflates) | main (DecompressionStream)
 *   form    data ({ code, data } objects, our loader) | path (a code string + langPath)
 *   worker  patched (worker.patched.min.js, see assets.ts) | stock
 *   other   origin of the cross-origin probe server
 */
export const APP_JS = String.raw`
const q = new URLSearchParams(location.search);
const violations = [];
document.addEventListener('securitypolicyviolation', (e) => {
  violations.push({ directive: e.effectiveDirective, blocked: e.blockedURI });
});
const base = new URL('./ocr/', location.href).href;
// The same probes as wasm-feature-detect 1.9.0 (bundled in worker.min.js).
const relaxed = WebAssembly.validate(new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,15,1,13,0,65,1,253,15,65,2,253,15,253,128,2,11]));
const simd = WebAssembly.validate(new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11]));
const variant = relaxed ? 'relaxedsimd-lstm' : simd ? 'simd-lstm' : 'lstm';

function corePath(mode) {
  if (mode === 'dir') return base + 'tesseract-7.0.0/';
  if (mode === 'wasmjs') return base + 'tesseract-7.0.0/tesseract-core-' + variant + '.wasm.js';
  if (mode === 'split') return base + 'split/core/tesseract-core-' + variant + '.js';
  return base + 'tesseract-7.0.0/tesseract-core-' + variant + '.js';
}

async function image(text) {
  const canvas = new OffscreenCanvas(1600, 200);
  const g = canvas.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, 1600, 200);
  g.fillStyle = '#000';
  g.font = '56px sans-serif';
  g.fillText(text, 40, 120);
  return canvas.convertToBlob({ type: 'image/png' });
}

async function packBytes(pack, lang, inflate) {
  const response = await fetch(base + 'lang/' + pack + '/' + lang + '.traineddata.gz');
  if (!response.ok) throw new Error('pack HTTP ' + response.status);
  if (inflate === 'main') {
    const raw = response.body.pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(raw).arrayBuffer());
  }
  return new Uint8Array(await response.arrayBuffer());
}

function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('timeout ' + ms + ' ms')), ms));
}

async function ocr(out, mark) {
  const s = q.get('s');
  const { default: Tesseract } = await import('./ocr/tesseract.esm.min.js');
  mark('apiLoaded');
  let langs = 'eng';
  let options = {};
  if (s === 'no-blob-only') options = { workerBlobURL: false };
  if (s === 'ocr' || s === 'sw-install') {
    const lang = q.get('lang') || 'eng';
    const pack = q.get('pack') || 'fast';
    const core = q.get('core') || 'js';
    options = {
      workerBlobURL: false,
      workerPath:
        base +
        (core === 'split' ? 'split/worker/' : 'tesseract-7.0.0/') +
        (q.get('worker') === 'patched' && core !== 'split' ? 'worker.patched.min.js' : 'worker.min.js'),
      corePath: corePath(core),
      cacheMethod: 'none',
    };
    if (q.get('form') === 'path') {
      langs = lang;
      options.langPath = base + 'lang/' + pack;
    } else {
      langs = [{ code: lang, data: await packBytes(pack, lang, q.get('inflate') || 'worker') }];
      mark('packFetched');
    }
  }
  out.errors = [];
  const created = Tesseract.createWorker(langs, 1, {
    ...options,
    errorHandler: (e) => out.errors.push(String(e)),
  });
  const worker = await Promise.race([created, timeout(Number(q.get('timeout') || 30000))]);
  mark('workerReady');
  const { data } = await worker.recognize(await image(${JSON.stringify(CANVAS_TEXT)}));
  mark('recognized');
  out.text = data.text.trim();
  out.confidence = data.confidence;
  out.version = data.version;
  await worker.terminate();
}

async function crossOrigin(out) {
  const other = q.get('other');
  try {
    await fetch(other + '/from-page');
    out.pageFetch = 'allowed';
  } catch (e) {
    out.pageFetch = 'blocked: ' + String(e);
  }
  const probe = new Worker('./probe-worker.js?other=' + encodeURIComponent(other));
  out.workerFetch = await new Promise((resolve) => {
    probe.onmessage = (e) => resolve(e.data);
    probe.onerror = (e) => resolve('worker error: ' + e.message);
  });
  probe.terminate();
}

async function run() {
  const out = { scenario: q.get('s'), simd, relaxed, variant, violations, timings: {} };
  const t0 = performance.now();
  const mark = (key) => { out.timings[key] = Math.round(performance.now() - t0); };
  try {
    if (q.get('s') === 'sw-install') {
      await navigator.serviceWorker.register('./sw.js');
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) {
        await new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
      }
      mark('swControlling');
    }
    if (q.get('s') === 'xorigin') await crossOrigin(out);
    else await ocr(out, mark);
    out.controlled = Boolean(navigator.serviceWorker.controller);
  } catch (e) {
    out.error = String(e && e.message ? e.message : e);
  }
  return out;
}

window.__result = run();
`;

export const PROBE_WORKER_JS = String.raw`
const other = new URLSearchParams(location.search).get('other');
fetch(other + '/from-worker').then(
  (r) => postMessage('allowed: HTTP ' + r.status),
  (e) => postMessage('blocked: ' + String(e)),
);
`;

/**
 * The app shell (here index.html and app.js) is precached, as Workbox does in the app;
 * everything else same-origin is CacheFirst at runtime, navigations matched without query.
 */
export const SW_JS = String.raw`
self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open('spike-ocr').then((c) => c.addAll(['./index.html', './app.js'])));
});
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open('spike-ocr');
    const hit = await cache.match(e.request, { ignoreSearch: e.request.mode === 'navigate' || url.pathname.endsWith('.js') });
    if (hit) return hit;
    const response = await fetch(e.request);
    if (response.ok) await cache.put(e.request, response.clone());
    return response;
  })());
});
`;
