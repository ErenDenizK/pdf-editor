/**
 * Resolves which Chromium binary Vitest browser mode and Playwright should launch.
 *
 * In CI the tests run inside the Playwright container image, whose browsers match the
 * installed `@playwright/test` version, so nothing is overridden and this returns
 * `undefined`. Some development sandboxes ship an older, preinstalled browser build and
 * forbid `playwright install`; for those:
 *
 * 1. `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` wins when set.
 * 2. Otherwise, if the expected binary is missing, the newest `chromium-<revision>` under
 *    `PLAYWRIGHT_BROWSERS_PATH` is used (Linux layout only) and a warning is printed.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { chromium } from '@playwright/test';

let warned = false;

export function chromiumExecutablePath(): string | undefined {
  const explicit = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (explicit) {
    return explicit;
  }
  if (existsSync(chromium.executablePath())) {
    return undefined;
  }
  const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!browsersPath || !existsSync(browsersPath)) {
    return undefined;
  }
  const revisions = readdirSync(browsersPath)
    .map((name) => /^chromium-(\d+)$/.exec(name)?.[1])
    .filter((revision): revision is string => revision !== undefined)
    .map(Number)
    .sort((a, b) => b - a);
  for (const revision of revisions) {
    const candidate = join(browsersPath, `chromium-${revision}`, 'chrome-linux', 'chrome');
    if (existsSync(candidate)) {
      if (!warned) {
        warned = true;
        console.warn(
          `[tooling] Expected Chromium is not installed; falling back to ${candidate}. ` +
            'Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to silence this warning.',
        );
      }
      return candidate;
    }
  }
  return undefined;
}

/** Playwright `launchOptions` for Chromium, empty unless an override is needed. */
export function chromiumLaunchOptions(): { executablePath?: string } {
  const executablePath = chromiumExecutablePath();
  return executablePath ? { executablePath } : {};
}
