// Diagnostic only: an OPFS handle round-trip through IndexedDB, top-level and in an iframe.
import { chromium } from '@playwright/test';

const roundTrip = async () => {
  const log = [];
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle(`d-${crypto.randomUUID()}`, { create: true });
  const w = await handle.createWritable();
  await w.write('hello');
  await w.close();
  log.push('written');
  const open = () =>
    new Promise((res, rej) => {
      const r = indexedDB.open(`db-${Math.random()}`, 1);
      r.onupgradeneeded = () => r.result.createObjectStore('s');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  const db = await open();
  await new Promise((res, rej) => {
    const tx = db.transaction('s', 'readwrite');
    tx.objectStore('s').put({ handle }, 'k');
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
  log.push('put');
  const back = await new Promise((res, rej) => {
    const r = db.transaction('s').objectStore('s').get('k');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  log.push(`read ${back?.handle?.kind}`);
  const file = await back.handle.getFile();
  log.push(`file ${await file.text()}`);
  return log.join(', ');
};

const html = '<!doctype html><title>d</title><iframe src="/frame"></iframe>';
for (const [label, options] of [
  ['headless shell', {}],
  ['full chromium', { channel: 'chromium' }],
]) {
  for (const where of ['top', 'iframe']) {
    const browser = await chromium.launch(options);
    browser.on('disconnected', () => console.log(`  [${label} ${where}] browser disconnected`));
    try {
      const page = await browser.newPage();
      await page.route('https://diag.test/**', (route) =>
        route.fulfill({ contentType: 'text/html', body: route.request().url().endsWith('/frame') ? '<!doctype html><p>f' : html }),
      );
      await page.goto('https://diag.test/');
      const target = where === 'top' ? page : page.frames()[1];
      const result = await target.evaluate(`(${roundTrip.toString()})()`);
      console.log(`  [${label} ${where}] ok: ${result}`);
    } catch (error) {
      console.log(`  [${label} ${where}] FAILED: ${String(error).split('\n')[0]}`);
    } finally {
      await browser.close().catch(() => {});
    }
  }
}
