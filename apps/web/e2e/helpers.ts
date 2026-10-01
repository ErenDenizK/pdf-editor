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

/**
 * Call before the first `page.goto`: records the per-point widths of every ink annotation
 * the app sends to the PDFium worker (the create's payload), so a test can read what was
 * committed without a hook in the production build. Read them with `sentInkWidths`.
 */
export async function recordInkWidths(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const found: number[][][] = [];
    (window as unknown as { __inkWidths: number[][][] }).__inkWidths = found;
    const collect = (value: unknown, depth: number): void => {
      if (typeof value !== 'object' || value === null || depth > 8) return;
      if (Array.isArray(value)) {
        for (const item of value) collect(item, depth + 1);
        return;
      }
      if (Object.getPrototypeOf(value) !== Object.prototype) return;
      const record = value as Record<string, unknown>;
      if (record.kind === 'ink' && Array.isArray(record.widths)) {
        found.push(JSON.parse(JSON.stringify(record.widths)) as number[][]);
        return;
      }
      for (const key of Object.keys(record)) collect(record[key], depth + 1);
    };
    const post = Object.getOwnPropertyDescriptor(Worker.prototype, 'postMessage')?.value as (
      this: Worker,
      ...args: unknown[]
    ) => void;
    Worker.prototype.postMessage = function (this: Worker, ...args: unknown[]) {
      try {
        collect(args[0], 0);
      } catch {
        // Recording must never break the message.
      }
      post.apply(this, args);
    } as Worker['postMessage'];
  });
}

/** The widths recorded by `recordInkWidths`, one entry per ink sent (paths × points). */
export async function sentInkWidths(page: Page): Promise<number[][][]> {
  return page.evaluate(
    () => (window as unknown as { __inkWidths?: number[][][] }).__inkWidths ?? [],
  );
}

/**
 * Opens the inspector (Selection, Properties, History, Info), which is closed until the
 * person opens it (experience-redesign §4.2); tests that read the history or a section
 * call this first.
 */
export async function showInspector(page: Page): Promise<void> {
  const inspector = page.locator('#right-panel');
  if (!(await inspector.isVisible())) await page.keyboard.press('ControlOrMeta+Alt+b');
  await expect(inspector).toBeVisible();
}
