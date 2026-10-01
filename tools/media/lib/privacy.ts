/**
 * The privacy check of every scene (spec §2.3): each request the browser context makes,
 * the service worker's included, is appended to `out/requests.log`, and a request to any
 * origin other than the preview server's fails the scene. The log is published with the
 * media, so a reader can see what a full run of the app asked for.
 *
 * `data:` and `blob:` URLs never leave the page; they are logged (shortened) and allowed.
 */
import { appendFileSync } from 'node:fs';

import type { BrowserContext, Request } from '@playwright/test';

import { REQUEST_LOG } from './paths.ts';

export interface RequestWatch {
  /** Requests to another origin, in the order they were made. */
  readonly violations: readonly string[];
  /** Stops logging (the context may stay open for a still's post-process). */
  stop(): void;
}

function logged(url: string): string {
  return url.startsWith('data:') ? `${url.slice(0, 48)}…` : url;
}

export function watchRequests(
  context: BrowserContext,
  sceneId: string,
  allowedOrigin: string,
): RequestWatch {
  const violations: string[] = [];
  const onRequest = (request: Request) => {
    const url = request.url();
    appendFileSync(REQUEST_LOG, `${sceneId}\t${request.method()}\t${logged(url)}\n`);
    if (url.startsWith('data:') || url.startsWith('blob:')) return;
    if (new URL(url).origin !== allowedOrigin) violations.push(url);
  };
  context.on('request', onRequest);
  return {
    violations,
    stop: () => context.off('request', onRequest),
  };
}
