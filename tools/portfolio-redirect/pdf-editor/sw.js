/*
 * Kill switch for the old app's service worker (ADR-0016 decision 5 step 2).
 *
 * Browsers that ran the app at `erendenizk.github.io/pdf-editor/` keep a Workbox worker
 * registered at `/pdf-editor/sw.js` that serves the old app from its precache. A worker
 * script that redirects or 404s cannot update, so this real script answers at the same URL.
 * On the next update check it installs, takes over at once, and:
 *
 * 1. deletes the caches Workbox created for the `/pdf-editor/` scope. workbox-core names
 *    them `${prefix}-${id}-${suffix}` with prefix `workbox`, ids `precache-v2` and
 *    `runtime`, and suffix `registration.scope` (checked in the built
 *    `apps/web/dist/workbox-*.js`: `{precache:"precache-v2",prefix:"workbox",
 *    runtime:"runtime",suffix:registration.scope}`), so for example
 *    `workbox-precache-v2-https://erendenizk.github.io/pdf-editor/`. Older Workbox versions
 *    also left a `…-temp` copy. A successor on the same origin (Recto at `/recto/`) carries
 *    its own scope in its names and is never touched;
 * 2. leaves every other cache alone, in particular the named runtime caches
 *    `pdf-editor-ocr`, `pdf-editor-wasm` and `pdf-editor-fonts` (ADR-0015 §3): Recto on the
 *    same origin reuses them, and deleting another app's data is never this worker's call
 *    (vite-plugin-pwa's `selfDestroying` is not used because it deletes every cache);
 * 3. unregisters itself and reloads every open tab in its scope, which now gets the
 *    redirect page (`index.html` here) from the network.
 *
 * It has no fetch handler: until the tabs reload, requests go to the network.
 */
/* global self */

const sw = /** @type {ServiceWorkerGlobalScope} */ (/** @type {unknown} */ (self));

/** @param {string} name */
function isOldWorkboxCache(name) {
  const scope = sw.registration.scope;
  return (
    name.startsWith('workbox-') && (name.endsWith(`-${scope}`) || name.endsWith(`-${scope}-temp`))
  );
}

async function retire() {
  // Control every window in scope (also ones the old worker never claimed), so that
  // `client.navigate` below is allowed for each of them.
  await sw.clients.claim();
  const names = await sw.caches.keys();
  await Promise.all(names.filter(isOldWorkboxCache).map((name) => sw.caches.delete(name)));
  const windows = await sw.clients.matchAll({ type: 'window' });
  await sw.registration.unregister();
  // An unregistered worker no longer handles navigations, so each tab loads the redirect
  // page from the network. The fragment is dropped so that no engine can treat this as a
  // same-document fragment navigation, which would not reload (Chromium reloads either
  // way); the app never read the fragment.
  await Promise.all(
    windows.map(async (client) => {
      const url = new URL(client.url);
      url.hash = '';
      try {
        await client.navigate(url.href);
      } catch {
        // A tab that closed or navigated away meanwhile.
      }
    }),
  );
}

sw.addEventListener('install', () => {
  void sw.skipWaiting();
});

sw.addEventListener('activate', (event) => {
  event.waitUntil(retire());
});
