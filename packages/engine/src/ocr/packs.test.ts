/**
 * The pack loader removes what an upgrade left behind (ADR-0012 §4, M5 review finding 9):
 * the first `load` sweeps other engine versions and packs no longer in the lock out of the
 * cache, without the "Keep available offline" toggle. The cache is a throwaway Cache Storage
 * cache of this test (the store takes its name), seeded with entries as an earlier version
 * would have left them.
 */
import { afterAll, expect, test } from 'vitest';

import { OCR_LOCK, OcrPackStore } from './packs';
import { OCR_BASE } from './test-helpers';

const CACHE = `pdf-editor-ocr-test-${Date.now()}`;

afterAll(async () => {
  await caches.delete(CACHE);
});

test('the first pack load deletes the previous version’s core and unknown packs', async () => {
  const store = new OcrPackStore({ baseUrl: OCR_BASE, cacheName: CACHE });
  const cache = await caches.open(CACHE);
  const put = (url: string) => cache.put(url, new Response('old'));
  const oldCore = `${store.baseUrl}tesseract-6.1.2/tesseract-core-simd-lstm.wasm`;
  const oldWorker = `${store.baseUrl}tesseract-6.1.2/worker.min.js`;
  const retiredPack = `${store.baseUrl}lang/xyz.traineddata.gz`;
  const currentCore = store.engineUrl('tesseract-core-simd-lstm.wasm');
  const otherApp = new URL('/elsewhere/tesseract-6.1.2/worker.min.js', location.href).href;
  for (const url of [oldCore, oldWorker, retiredPack, currentCore, otherApp]) await put(url);

  const eng = await store.load('eng');
  expect(eng.length).toBe(OCR_LOCK.languages.eng!.bytes);

  const left = (await cache.keys()).map((r) => r.url).sort();
  expect(left).toEqual([currentCore, otherApp, store.packUrl('eng')].sort());

  // Once per store: an entry that appears later stays until the next store's first load.
  await put(oldWorker);
  await store.load('deu');
  expect((await cache.keys()).map((r) => r.url)).toContain(oldWorker);
  await new OcrPackStore({ baseUrl: OCR_BASE, cacheName: CACHE }).load('eng');
  expect((await cache.keys()).map((r) => r.url)).not.toContain(oldWorker);
}, 60_000);
