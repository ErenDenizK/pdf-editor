/**
 * Export end to end: drop two corpus files, rotate a page in Arrange mode, export through
 * the dialog (download path), and parse the downloaded file with pdf-lib.
 */
import { readFile } from 'node:fs/promises';

import { PDFDocument } from '@cantoo/pdf-lib';
import { expect, test } from '@playwright/test';

import { openFixtures, useFileInputPicker } from './helpers';

const EXPECTED: Readonly<Record<string, { pages: number; rotations: readonly number[] }>> = {
  'simple-text': { pages: 3, rotations: [0, 0, 0] },
  'rotated-pages': { pages: 4, rotations: [0, 90, 180, 270] },
};

test.skip(({ browserName }) => browserName !== 'chromium', 'Download flow is verified on Chromium');

test('drop two files, rotate a page, export and download a verified PDF', async ({ page }) => {
  // Force the <a download> path: Playwright cannot drive the native save picker.
  await page.addInitScript({
    content:
      "Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });",
  });
  await useFileInputPicker(page);
  await page.goto('./');
  await expect(page.getByTestId('app-shell')).toBeVisible();

  await openFixtures(
    page,
    Object.keys(EXPECTED).map((name) => `${name}.pdf`),
  );
  const documentTabs = page.getByRole('tablist', { name: 'Open documents' }).getByRole('tab');
  await expect(documentTabs).toHaveCount(2);

  // Arrange mode, select the first page of the active document, rotate it right.
  await page.keyboard.press('3');
  const cell = page.locator('[role="gridcell"][data-page-id]').first();
  await expect(cell).toBeVisible();
  await cell.click();
  await page.keyboard.press('r');

  const title =
    (await documentTabs.and(page.getByRole('tab', { selected: true })).textContent())?.trim() ?? '';
  const expected = EXPECTED[title];
  expect(expected, `active tab "${title}"`).toBeDefined();
  if (!expected) return;

  await page.getByRole('button', { name: 'Export document' }).click();
  const dialog = page.getByTestId('export-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'File name' })).toHaveValue(`${title}.pdf`);
  await dialog.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(dialog.getByTestId('export-verified')).toBeVisible({ timeout: 30_000 });

  const downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(`${title}.pdf`);
  await expect(dialog).toBeHidden();

  const path = await download.path();
  const pdf = await PDFDocument.load(await readFile(path), { updateMetadata: false });
  expect(pdf.getPageCount()).toBe(expected.pages);
  const rotations = pdf.getPages().map((p) => p.getRotation().angle);
  expect(rotations).toEqual(expected.rotations.map((r, i) => (i === 0 ? (r + 90) % 360 : r)));
});
