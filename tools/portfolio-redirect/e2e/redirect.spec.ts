/**
 * The `/pdf-editor/` redirect folder (ADR-0016 decision 5 step 2, presentation spec §8
 * "Migration"): a browser that has the old app's worker registered gets the kill switch on
 * its next update check, loses only the old scope's Workbox caches, keeps the named runtime
 * caches, and lands on the redirect page, which keeps the path, `?lang=tr` and the hash.
 *
 * The new address `https://erendenizk.github.io/recto/` is never reached over the network:
 * `context.route` answers it (a stand-in Recto page) or aborts it (the new site is not up).
 * The folder's files are served unmodified.
 */
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type BrowserContext, expect, type Page, test } from '@playwright/test';

import { type Site, startSite } from './site.ts';

const FOLDER = fileURLToPath(new URL('../pdf-editor/', import.meta.url));
const TARGET = 'https://erendenizk.github.io/recto/';
const NAMED_CACHES = ['pdf-editor-ocr', 'pdf-editor-wasm', 'pdf-editor-fonts'];

/** The old app, reduced to what matters here: it registers `/pdf-editor/sw.js`. */
const OLD_APP_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>pdf-editor (old app)</title></head>
  <body>
    <h1>Old app</h1>
    <script>
      window.oldApp = true;
      void navigator.serviceWorker.register('./sw.js', { scope: './' });
    </script>
  </body>
</html>
`;

/**
 * The old app's worker, reduced to Workbox's footprint: a precache named after its scope
 * that serves navigations (like \`navigateFallback\`), a runtime cache, the three named
 * runtime caches with one entry each, and a successor's precache under \`/recto/\` that the
 * kill switch must not mistake for its own.
 */
const OLD_WORKER_JS = `
const scope = self.registration.scope;
const precache = 'workbox-precache-v2-' + scope;
const seeds = [
  ['pdf-editor-ocr', 'ocr/lang/eng.traineddata.gz'],
  ['pdf-editor-wasm', 'assets/pdfium-0123abcd.wasm'],
  ['pdf-editor-fonts', 'assets/NotoSans-0123abcd.woff2'],
  ['workbox-runtime-' + scope, 'assets/runtime.json'],
  ['workbox-precache-v2-' + new URL('/recto/', scope).href, '/recto/index.html'],
];
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    await (await caches.open(precache)).add(new URL('index.html', scope).href);
    for (const [name, path] of seeds) {
      const cache = await caches.open(name);
      await cache.put(new URL(path, scope).href, new Response(name));
    }
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith((async () => {
    const cached = await (await caches.open(precache)).match(new URL('index.html', scope).href);
    return cached ?? fetch(event.request);
  })());
});
`;

const RECTO_HTML = '<!doctype html><title>Recto</title><h1>Recto stand-in</h1>';

/** A recipe exactly as the app stores and exports it (`writeRecipe`). */
function recipeText(name: string): string {
  const recipe = {
    format: 'pdf-editor-recipe',
    version: 1,
    name,
    steps: [{ kind: 'rotate', options: { quarterTurns: 1, pages: 'odd' } }],
  };
  return `${JSON.stringify(recipe, null, 2)}\n`;
}

let site: Site;

test.beforeEach(async () => {
  site = await startSite();
  // A placeholder portfolio home, so tests can open the origin without the folder.
  await writeFile(join(site.root, 'index.html'), '<!doctype html><title>Portfolio</title>');
});

test.afterEach(async () => {
  await site.close();
});

/** Serves the folder's files at `/pdf-editor/`, replacing whatever was there. */
async function installFolder(): Promise<void> {
  const target = join(site.root, 'pdf-editor');
  await rm(target, { recursive: true, force: true });
  await cp(FOLDER, target, { recursive: true });
  // GitHub Pages serves only the site root's 404.html; README.md tells the owner to copy it.
  await cp(join(FOLDER, '404.html'), join(site.root, '404.html'));
}

async function installOldApp(): Promise<void> {
  const target = join(site.root, 'pdf-editor');
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await writeFile(join(target, 'index.html'), OLD_APP_HTML);
  await writeFile(join(target, 'sw.js'), OLD_WORKER_JS);
}

/** The new address answers with a stand-in Recto page, or not at all. */
async function routeTarget(context: BrowserContext, up: boolean): Promise<void> {
  await context.route(`${TARGET}**`, (route) =>
    up
      ? route.fulfill({ status: 200, contentType: 'text/html', body: RECTO_HTML })
      : route.abort('connectionrefused'),
  );
}

/** Cache names with their entry counts, read without creating any cache. */
function cacheContents(page: Page): Promise<Record<string, number>> {
  return page.evaluate(async () => {
    const contents: Record<string, number> = {};
    for (const name of await caches.keys()) {
      contents[name] = (await (await caches.open(name)).keys()).length;
    }
    return contents;
  });
}

test('index.html and 404.html are the same page', async () => {
  const names = await readdir(FOLDER);
  expect(names.sort()).toEqual(['404.html', 'index.html', 'redirect.js', 'sw.js']);
  expect(await readFile(join(FOLDER, '404.html'), 'utf8')).toBe(
    await readFile(join(FOLDER, 'index.html'), 'utf8'),
  );
});

test('the kill switch retires the old worker and keeps the named runtime caches', async ({
  context,
  page,
}) => {
  // The new site is not up yet, so the redirect page must stay and say so.
  await routeTarget(context, false);
  await installOldApp();
  const oldApp = `${site.origin}/pdf-editor/?lang=tr`;
  // The tab sits at a fragment: the kill switch must still reload it, not just scroll.
  await page.goto(`${oldApp}#page=2`);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (navigator.serviceWorker.controller === null) {
      await new Promise((resolve) => {
        navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true });
      });
    }
  });
  const scope = `${site.origin}/pdf-editor/`;
  const oldPrecache = `workbox-precache-v2-${scope}`;
  const oldRuntime = `workbox-runtime-${scope}`;
  const successorPrecache = `workbox-precache-v2-${site.origin}/recto/`;
  expect(await cacheContents(page)).toEqual({
    [oldPrecache]: 1,
    [oldRuntime]: 1,
    [successorPrecache]: 1,
    'pdf-editor-ocr': 1,
    'pdf-editor-wasm': 1,
    'pdf-editor-fonts': 1,
  });
  // The old worker serves the old app from its precache, as Workbox does: no network.
  const beforeReload = site.requests.length;
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Old app' })).toBeVisible();
  expect(site.requests.slice(beforeReload)).not.toContain('/pdf-editor/');

  // The repository is renamed: /pdf-editor/ now comes from the portfolio's folder.
  await installFolder();
  const before = site.requests.length;
  // Not awaited in the page: the kill switch navigates it away while this runs.
  await page.evaluate(() => {
    void navigator.serviceWorker.getRegistration().then((registration) => registration?.update());
  });

  // The kill switch reloaded the tab itself; the redirect page came from the network.
  await expect(page.getByRole('heading', { name: 'Recto has moved' })).toBeVisible();
  // Same address, query kept; the kill switch drops the fragment (see sw.js).
  expect(page.url()).toBe(oldApp);
  expect(await page.evaluate(() => 'oldApp' in window)).toBe(false);
  expect(site.requests.slice(before)).toEqual(
    expect.arrayContaining(['/pdf-editor/sw.js', '/pdf-editor/', '/pdf-editor/redirect.js']),
  );

  // Unregistered, and nothing controls the page any more.
  await expect
    .poll(() =>
      page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length),
    )
    .toBe(0);
  expect(await page.evaluate(() => navigator.serviceWorker.controller)).toBeNull();

  // Only the old scope's Workbox caches are gone.
  expect(await cacheContents(page)).toEqual({
    [successorPrecache]: 1,
    'pdf-editor-ocr': 1,
    'pdf-editor-wasm': 1,
    'pdf-editor-fonts': 1,
  });
  // Their entries are intact, not just their names.
  for (const name of NAMED_CACHES) {
    const body = await page.evaluate(async (cacheName) => {
      const [request] = await (await caches.open(cacheName)).keys();
      return request === undefined ? undefined : (await caches.match(request))?.text();
    }, name);
    expect(body).toBe(name);
  }

  // The probe failed: the page says so in English and Turkish and keeps the link.
  await expect(page.locator('#status')).toHaveText('Recto has moved. Try again in a few minutes.');
  await expect(page.locator('#status-tr')).toHaveText(
    'Recto taşındı. Birkaç dakika sonra yeniden deneyin.',
  );
  await expect(page.getByRole('link', { name: 'Open Recto at its new address' })).toHaveAttribute(
    'href',
    `${TARGET}?lang=tr`,
  );
  // Nothing was created in the old app's recipe storage by looking for it.
  expect(
    await page.evaluate(async () => {
      const databases = await indexedDB.databases();
      return databases.map((database) => database.name);
    }),
  ).not.toContain('pdf-editor-recipes');
});

test('the redirect keeps the path, ?lang=tr and the hash', async ({ context, page }) => {
  await routeTarget(context, true);
  await installFolder();

  // index.html: the old entry, with the query and a hash.
  await page.goto(`${site.origin}/pdf-editor/?lang=tr#page=3`);
  await page.waitForURL(`${TARGET}?lang=tr#page=3`);
  await expect(page.getByRole('heading', { name: 'Recto stand-in' })).toBeVisible();

  // 404.html: a deeper path that the old site never had keeps its remainder.
  await page.goto(`${site.origin}/pdf-editor/about/?lang=tr#privacy`);
  await page.waitForURL(`${TARGET}about/?lang=tr#privacy`);

  // The old entry file name maps to the new site's entry.
  await page.goto(`${site.origin}/pdf-editor/index.html?lang=tr`);
  await page.waitForURL(`${TARGET}?lang=tr`);

  // A path-relative trick cannot leave the new site.
  await page.goto(`${site.origin}/pdf-editor//example.com/x`);
  await page.waitForURL(`${TARGET}example.com/x`);
});

test('the root 404 copy leaves other portfolio paths alone', async ({ context, page }) => {
  await routeTarget(context, true);
  await installFolder();
  const response = await page.goto(`${site.origin}/some-other-project/?lang=tr`);
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Go to the home page' })).toHaveAttribute(
    'href',
    '/',
  );
  expect(page.url()).toBe(`${site.origin}/some-other-project/?lang=tr`);
});

test('saved recipes are offered for download before moving to another origin', async ({
  context,
  page,
}) => {
  await routeTarget(context, true);
  await installFolder();
  const fromOpfs = recipeText('Rotate odd pages');
  const fromIndexedDb = recipeText('Stamp: draft');
  // The old app's storage on the old origin: one recipe in each backend.
  await page.goto(`${site.origin}/`);
  await page.evaluate(
    async ([opfsText, idbText]) => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('recipes', { create: true });
      const write = async (name: string, text: string) => {
        const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
        await writable.write(text);
        await writable.close();
      };
      await write('a1b2c3.json', opfsText);
      await write('a1b2c3.meta.json', JSON.stringify({ savedAt: 1 }));
      await write('notes.txt', 'not a recipe');
      await new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('pdf-editor-recipes', 1);
        open.onupgradeneeded = () => open.result.createObjectStore('recipes', { keyPath: 'id' });
        open.onerror = () => reject(open.error ?? new Error('open failed'));
        open.onsuccess = () => {
          const tx = open.result.transaction('recipes', 'readwrite');
          tx.objectStore('recipes').put({ id: 'd4e5f6', text: idbText, savedAt: 2 });
          tx.oncomplete = () => {
            open.result.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error ?? new Error('write failed'));
        };
      });
    },
    [fromOpfs, fromIndexedDb] as const,
  );

  await page.goto(`${site.origin}/pdf-editor/?lang=tr`);
  const button = page.getByRole('button', { name: /Download your saved recipes/ });
  await expect(button).toBeVisible();
  await expect(page.locator('#recipes-text')).toContainText('2 saved recipes stay');
  await expect(page.locator('#recipes-text-tr')).toBeVisible();
  // The page waits for the user instead of moving on.
  expect(page.url()).toBe(`${site.origin}/pdf-editor/?lang=tr`);

  const downloads: { name: string; text: string }[] = [];
  page.on('download', (download) => {
    void download.path().then(async (path) => {
      downloads.push({ name: download.suggestedFilename(), text: await readFile(path, 'utf8') });
    });
  });
  await button.click();
  await expect.poll(() => downloads.length).toBe(2);
  expect(downloads.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
    { name: 'Rotate odd pages.pdfrecipe.json', text: fromOpfs },
    { name: 'Stamp_ draft.pdfrecipe.json', text: fromIndexedDb },
  ]);

  await page.getByRole('link', { name: 'Open Recto at its new address' }).click();
  await page.waitForURL(`${TARGET}?lang=tr`);
});
