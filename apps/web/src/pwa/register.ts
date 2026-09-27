/**
 * Service worker lifecycle (ARCHITECTURE.md §7, ADR-0010).
 *
 * - `registerType: 'prompt'`: a new version installs in the background and waits. The
 *   shell shows "Update available"; only its Reload button activates the new worker
 *   (`updateSW(true)`), because reloading closes open documents.
 * - Update checks run on window focus (throttled) in addition to the browser's own checks.
 * - Once the app shell is cached, the engine wasm is fetched in idle time so the runtime
 *   cache holds it (CacheFirst) and the first offline session can open files. Skipped
 *   when the user asked the browser to save data.
 *
 * Status feeds the privacy popover; nothing here contacts another origin.
 */
import wasmUrl from '@embedpdf/pdfium/pdfium.wasm?url';
import { registerSW } from 'virtual:pwa-register';
import { create } from 'zustand';

export type ServiceWorkerStatus =
  /** No service worker support (or blocked, e.g. some private modes). */
  | 'unsupported'
  /** `vite dev`: the plugin does not generate a worker. */
  | 'development'
  | 'installing'
  /** App shell cached; works offline. */
  | 'ready'
  | 'error';

interface PwaState {
  readonly status: ServiceWorkerStatus;
  /** A new version is installed and waiting for the user. */
  readonly updateAvailable: boolean;
}

export const usePwaStore = create<PwaState>()(() => ({
  status: 'installing',
  updateAvailable: false,
}));

/** Minimum time between focus-triggered update checks. */
const UPDATE_CHECK_INTERVAL_MS = 60_000;

let started = false;
let updateServiceWorker: ((reloadPage?: boolean) => Promise<void>) | undefined;

/** Activates the waiting worker and reloads the page (the user pressed Reload). */
export async function applyUpdate(): Promise<void> {
  if (updateServiceWorker) await updateServiceWorker(true);
  else location.reload();
}

/** Hides the update notice for this session; the worker keeps waiting. */
export function dismissUpdate(): void {
  usePwaStore.setState({ updateAvailable: false });
}

function saveData(): boolean {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return connection?.saveData === true;
}

/** Fetches the engine wasm through the service worker so it lands in the runtime cache. */
function warmEngineCache(): void {
  if (saveData()) return;
  const run = () => {
    fetch(wasmUrl, { credentials: 'same-origin' })
      .then((response) => response.arrayBuffer())
      .catch(() => {
        // Offline or evicted: the engine fetches it on first use instead.
      });
  };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 10_000 });
  else setTimeout(run, 2_000);
}

function watchForUpdates(registration: ServiceWorkerRegistration): void {
  let lastCheck = Date.now();
  const check = () => {
    if (document.visibilityState !== 'visible' || !navigator.onLine) return;
    if (registration.installing || Date.now() - lastCheck < UPDATE_CHECK_INTERVAL_MS) return;
    lastCheck = Date.now();
    registration.update().catch(() => {
      // Network hiccup: the next focus retries.
    });
  };
  window.addEventListener('focus', check);
  document.addEventListener('visibilitychange', check);
}

/** Registers the service worker once. Safe to call more than once. */
export function startServiceWorker(): void {
  if (started) return;
  started = true;
  if (import.meta.env.DEV) {
    usePwaStore.setState({ status: 'development' });
    return;
  }
  if (!('serviceWorker' in navigator)) {
    usePwaStore.setState({ status: 'unsupported' });
    return;
  }
  const ready = () => {
    if (usePwaStore.getState().status === 'ready') return;
    usePwaStore.setState({ status: 'ready' });
    warmEngineCache();
  };
  updateServiceWorker = registerSW({
    immediate: true,
    onNeedRefresh: () => usePwaStore.setState({ updateAvailable: true }),
    onOfflineReady: ready,
    onRegisteredSW: (_url, registration) => {
      if (!registration) return;
      // Installed on an earlier visit: onOfflineReady does not fire again.
      if (registration.active) ready();
      watchForUpdates(registration);
    },
    onRegisterError: () => usePwaStore.setState({ status: 'error' }),
  });
}
