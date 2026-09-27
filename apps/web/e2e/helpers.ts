/**
 * Shared end-to-end helpers.
 *
 * Files are opened through the Open button and Playwright's file chooser rather than a
 * synthetic drop: WebKit does not accept a script-constructed `dataTransfer` on a
 * dispatched `DragEvent`, so drop-based helpers only ever worked in Chromium and Firefox.
 * The file-chooser path is the one a Safari user takes (no `showOpenFilePicker`), and it
 * works in all three engines. Drag-and-drop itself is still covered by the light-table
 * spec and by the browser-mode unit tests.
 */
import { fileURLToPath } from 'node:url';

import { expect, type Page } from '@playwright/test';

export const FIXTURES = new URL('../../../test/fixtures/', import.meta.url);

export function fixturePath(name: string): string {
  return fileURLToPath(new URL(name, FIXTURES));
}

/**
 * Call before the first `page.goto`: hides `showOpenFilePicker` so the app falls back to
 * the `<input type=file>` path, which Playwright can serve in every browser (the native
 * Chromium picker cannot be driven from a test).
 */
export async function useFileInputPicker(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showOpenFilePicker', { value: undefined, configurable: true });
  });
}

/** Opens corpus files through the Open button and waits for their tabs. */
export async function openFixtures(page: Page, names: readonly string[]): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page
    .getByRole('button', { name: /^(Open files|Dosya aç)$/ })
    .first()
    .click();
  await (await chooser).setFiles(names.map(fixturePath));
  for (const name of names) {
    await expect(page.getByRole('tab', { name: name.replace(/\.pdf$/, '') })).toBeVisible();
  }
}
