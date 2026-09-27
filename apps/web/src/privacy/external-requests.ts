/**
 * Live count of network requests to origins other than our own, for the status bar's
 * privacy indicator (ARCHITECTURE.md §7). Source: Resource Timing via PerformanceObserver.
 *
 * Coverage: scripts, styles, fonts, images, fetch/XHR, workers, WASM. Not covered:
 * WebSocket frames and requests the CSP blocked (those never leave the browser, which is
 * the point of the CSP). data: and blob: URLs are local and never count.
 */
import { useSyncExternalStore } from 'react';

const NETWORK_PROTOCOLS = new Set(['http:', 'https:', 'ws:', 'wss:']);

/** Pure predicate: does `url` leave `origin`? Invalid URLs are not counted. */
export function isExternalRequest(url: string, origin: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url, origin);
  } catch {
    return false;
  }
  if (!NETWORK_PROTOCOLS.has(parsed.protocol)) return false;
  return parsed.origin !== origin;
}

export interface ExternalRequestSnapshot {
  readonly count: number;
  /** Distinct external origins, in order of first request. */
  readonly origins: readonly string[];
}

const EMPTY: ExternalRequestSnapshot = { count: 0, origins: [] };
let snapshot: ExternalRequestSnapshot = EMPTY;
const listeners = new Set<() => void>();
let started = false;

function record(entries: readonly PerformanceEntry[]): void {
  const origin = location.origin;
  let count = snapshot.count;
  const origins = [...snapshot.origins];
  for (const entry of entries) {
    if (!isExternalRequest(entry.name, origin)) continue;
    count += 1;
    const entryOrigin = new URL(entry.name).origin;
    if (!origins.includes(entryOrigin)) origins.push(entryOrigin);
  }
  if (count !== snapshot.count) {
    snapshot = { count, origins };
    for (const listener of listeners) listener();
  }
}

function start(): void {
  if (started || typeof PerformanceObserver === 'undefined') return;
  started = true;
  try {
    // `buffered: true` replays entries recorded before the observer existed.
    new PerformanceObserver((list) => {
      record(list.getEntries());
    }).observe({ type: 'resource', buffered: true });
  } catch {
    // Old engines without `type` support: count what is already recorded.
    record(performance.getEntriesByType('resource'));
  }
}

function subscribe(listener: () => void): () => void {
  start();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useExternalRequests(): ExternalRequestSnapshot {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => EMPTY,
  );
}
