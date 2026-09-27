// page.evaluate callbacks run in the browser.
/**
 * Offline (ADR-0010): after one online visit the service worker serves the app shell from
 * its precache and the engine wasm from its runtime cache, so a reload with the network
 * off still loads the shell and opens a PDF. Also checks that the worker scope and the
 * manifest's scope / start_url / id follow the deployment base path (VITE_BASE_PATH).
 */
import { readFile } from 'node:fs/promises';

import { expect, type Page, test } from '@playwright/test';

const FIXTURE = new URL('../../../test/fixtures/simple-text.pdf', import.meta.url);
const BASE_PATH = process.env.VITE_BASE_PATH ?? '/';

test.skip(
  ({ browserName }) => browserName !== 'chromium',
  'Service worker + offline emulation is verified on Chromium',
);

async function dropFixture(page: Page): Promise<void> {
  const data = [...(await readFile(FIXTURE))];
  await page.evaluate((bytes) => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File([new Uint8Array(bytes)], 'simple-text.pdf', { type: 'application/pdf' }),
    );
    const shell = document.querySelector('[data-testid="app-shell"]');
    for (const type of ['dragenter', 'dragover', 'drop']) {
      shell?.dispatchEvent(
        new DragEvent(type, { dataTransfer: transfer, bubbles: true, cancelable: true }),
      );
    }
  }, data);
}

test('the shell and the engine work offline after one visit', async ({ page, context }) => {
  await page.goto('./');
  await expect(page.getByTestId('app-shell')).toBeVisible();

  // The worker controls the page (clientsClaim) with the scope of the base path.
  const scope = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return registration.scope;
  });
  expect(new URL(scope).pathname).toBe(BASE_PATH);
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true);

  // The manifest follows the base path, too.
  const manifest = await page.evaluate(async () => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
    if (!link) return null;
    return (await (await fetch(link.href)).json()) as Record<string, unknown>;
  });
  expect(manifest).toMatchObject({ scope: BASE_PATH, start_url: BASE_PATH, id: BASE_PATH });

  // The engine wasm is warmed into the runtime cache once the shell is offline-ready.
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const cache = await caches.open('pdf-editor-wasm');
          return (await cache.keys()).length;
        }),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);

  // The privacy popover reports the worker as installed.
  await page.getByTestId('privacy-indicator').click();
  await expect(page.getByTestId('sw-status')).toHaveAttribute('data-status', 'ready');
  await expect(page.getByTestId('sw-status')).toHaveText(/works offline/);
  await page.keyboard.press('Escape');

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByTestId('app-shell')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Drop PDFs to start' })).toBeVisible();
  // Really offline: anything not in a cache fails.
  const reachable = await page.evaluate(() =>
    fetch('./not-cached.txt', { cache: 'no-store' }).then(
      () => true,
      () => false,
    ),
  );
  expect(reachable).toBe(false);

  await dropFixture(page);
  await expect(page.getByRole('tab', { name: 'simple-text', selected: true })).toBeVisible();
  await expect(page.getByTestId('status-pages')).toHaveText('Page 1 of 3');
  // A page actually rendered through PDFium (wasm from the cache).
  await expect(page.locator('main canvas[data-state="rendered"]').first()).toBeVisible();

  // Nothing left the device.
  await expect(page.getByTestId('privacy-indicator')).toContainText('No external requests');
  await context.setOffline(false);
});
