/**
 * Page furniture end to end (document-tools spec §2): add "Page 1 of N" numbers to
 * rotated-pages.pdf from the Document menu with a live preview, export, check the file
 * with pdf-lib (pages, rotations, the embedded Inter subset, one Form XObject per page),
 * then open the exported file in the app and find the numbers through PDFium text.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { PDFDict, PDFDocument, PDFName, PDFStream } from '@cantoo/pdf-lib';
import { expect, type Page, test } from '@playwright/test';

import { openFixtures, useFileInputPicker } from './helpers';

const screenshots = new URL('../../../docs/design/screenshots/', import.meta.url);

test.skip(({ browserName }) => browserName !== 'chromium', 'Download flow is verified on Chromium');

const mod = (page: Page) =>
  page.evaluate(() => (/mac/i.test(navigator.platform) ? 'Meta' : 'Control'));

test('adds page numbers to rotated pages, exports them and reads them back', async ({ page }) => {
  await page.addInitScript({
    content:
      "Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });",
  });
  await useFileInputPicker(page);
  await page.goto('./?lang=en');
  await openFixtures(page, ['rotated-pages.pdf']);

  await page.getByTestId('document-menu').click();
  await page.getByRole('menuitem', { name: 'Page numbers…' }).click();
  const dialog = page.getByTestId('furniture-dialog-page-numbers');
  await expect(dialog).toBeVisible();
  await dialog.locator('label', { has: page.getByTestId('preset-page-of') }).click();
  // Live preview on the page while the dialog is open.
  const preview = page.locator('[data-page-index="0"] [data-furniture-text]');
  await expect(preview).toHaveAttribute('data-furniture-text', 'Page 1 of 4');
  await dialog.getByRole('button', { name: 'Apply' }).click();
  await expect(dialog).toBeHidden();
  await expect(preview).toHaveAttribute('data-furniture-text', 'Page 1 of 4');

  await page.getByRole('button', { name: 'Export document' }).click();
  const exportDialog = page.getByTestId('export-dialog');
  await expect(exportDialog).toBeVisible();
  await exportDialog.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(exportDialog.getByTestId('export-verified')).toBeVisible({ timeout: 30_000 });
  const downloadPromise = page.waitForEvent('download');
  await exportDialog.getByRole('button', { name: 'Download' }).click();
  const download = await downloadPromise;
  const bytes = await readFile(await download.path());

  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  expect(pdf.getPageCount()).toBe(4);
  expect(pdf.getPages().map((p) => p.getRotation().angle)).toEqual([0, 90, 180, 270]);
  const fonts = new Set<string>();
  for (const p of pdf.getPages()) {
    const xobjects = p.node.Resources()?.lookup(PDFName.of('XObject'), PDFDict);
    const forms = (xobjects?.keys() ?? []).filter((key) => key.asString().startsWith('/Fm'));
    expect(forms).toHaveLength(1);
    const form = xobjects?.lookup(forms[0] as PDFName, PDFStream);
    const font = form?.dict
      .lookup(PDFName.of('Resources'), PDFDict)
      .lookup(PDFName.of('Font'), PDFDict);
    for (const key of font?.keys() ?? []) {
      const dict = font?.lookup(key, PDFDict);
      fonts.add(dict?.get(PDFName.of('BaseFont'))?.toString() ?? '');
    }
  }
  // One embedded Inter (a pdf-lib subset, named "/Inter-Regular-<n>") shared by every page.
  expect([...fonts]).toHaveLength(1);
  expect([...fonts][0]).toMatch(/^\/Inter-Regular/);
  // Subset: far smaller than the 177 KB bundled face.
  expect(bytes.byteLength).toBeLessThan(60_000);

  // Round trip: open the exported file and find the numbers through the engine's text.
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open files' }).first().click();
  await (await chooser).setFiles({
    name: 'numbered.pdf',
    mimeType: 'application/pdf',
    buffer: bytes,
  });
  await expect(page.getByRole('tab', { name: 'numbered' })).toBeVisible();
  await page.keyboard.press(`${await mod(page)}+f`);
  const field = page.getByRole('searchbox', { name: 'Find in document' });
  await field.fill('of 4');
  await expect(page.getByTestId('status-search')).toContainText('of 4');
  await expect(page.getByTestId('search-hit')).toHaveCount(4);
  await field.fill('Page 3 of 4');
  await expect(page.getByTestId('search-hit')).toHaveCount(1);
});

test('screenshots of the page numbers and watermark dialogs (design review)', async ({ page }) => {
  test.skip(
    !process.env.CAPTURE_SCREENSHOTS,
    'Set CAPTURE_SCREENSHOTS=1 to write docs/design/screenshots/.',
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await useFileInputPicker(page);
  await page.goto('./?lang=en');
  await openFixtures(page, ['outline-named-dests.pdf']);
  await expect(
    page.locator('[data-read-viewport] canvas[data-state="rendered"]').first(),
  ).toBeVisible({
    timeout: 20_000,
  });
  await page.getByTestId('document-menu').click();
  await page.getByRole('menuitem', { name: 'Page numbers…' }).click();
  const numbers = page.getByTestId('furniture-dialog-page-numbers');
  await numbers.locator('label', { has: page.getByTestId('preset-page-of') }).click();
  await expect(page.locator('[data-page-index="0"] [data-furniture-text]')).toHaveAttribute(
    'data-furniture-text',
    'Page 1 of 6',
  );
  await page.waitForTimeout(400);
  await page.screenshot({ path: fileURLToPath(new URL('m3-page-numbers-1440.png', screenshots)) });
  await page.keyboard.press('Escape');
  await expect(numbers).toBeHidden();

  await page.goto('./?lang=en');
  await openFixtures(page, ['simple-text.pdf']);
  await expect(
    page.locator('[data-read-viewport] canvas[data-state="rendered"]').first(),
  ).toBeVisible({
    timeout: 20_000,
  });
  await page.getByTestId('document-menu').click();
  await page.getByRole('menuitem', { name: 'Watermark…' }).click();
  const watermark = page.getByTestId('furniture-dialog-watermark');
  await watermark.getByTestId('watermark-text').fill('CONFIDENTIAL');
  await watermark.getByText('Tile across the page').click();
  await expect(page.locator('[data-page-index="0"] [data-furniture-text]').first()).toBeAttached();
  await page.waitForTimeout(600);
  await page.screenshot({ path: fileURLToPath(new URL('m3-watermark-1440.png', screenshots)) });
});
