/**
 * Document tools end to end (spec document-tools.md §3, §4, §7, §8): edit the title in the
 * Info section, set a password, export and read the output with the password; strip
 * metadata and export a file without the author. Screenshots for the design review with
 * `CAPTURE_SCREENSHOTS=1` (written to docs/design/screenshots/).
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { PDFDocument, PDFName } from '@cantoo/pdf-lib';
import { expect, type Page, test } from '@playwright/test';

import { openFixtures, useFileInputPicker } from './helpers';

const screenshots = new URL('../../../docs/design/screenshots/', import.meta.url);
const capture = Boolean(process.env.CAPTURE_SCREENSHOTS);

test.skip(({ browserName }) => browserName !== 'chromium', 'Download flow is verified on Chromium');
test.use({ viewport: { width: 1440, height: 900 } });

async function start(page: Page, fixture: string): Promise<void> {
  // Force the <a download> path: Playwright cannot drive the native save picker.
  await page.addInitScript({
    content:
      "Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });",
  });
  await useFileInputPicker(page);
  await page.goto('./');
  await expect(page.getByTestId('app-shell')).toBeVisible();
  await openFixtures(page, [fixture]);
}

async function runDocumentCommand(page: Page, name: string): Promise<void> {
  await page.getByTestId('document-menu').click();
  await page.getByRole('menuitem', { name }).click();
}

async function exportAndDownload(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Export document' }).click();
  const dialog = page.getByTestId('export-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(dialog.getByTestId('export-verified')).toBeVisible({ timeout: 30_000 });
  const downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download' }).click();
  const download = await downloadPromise;
  await expect(dialog).toBeHidden();
  return download.path();
}

test('edit the title, set a password, export, and open the output with the password', async ({
  page,
}) => {
  await start(page, 'simple-text.pdf');
  const editor = page.getByTestId('metadata-editor');
  const title = editor.getByLabel('Title');
  await title.fill('Quarterly figures');
  await title.press('Enter');
  await expect(page.getByTestId('metadata-policy')).toContainText('Edited');
  await expect(
    page.getByRole('list', { name: /history/i }).getByRole('button', { name: 'Change Title' }),
  ).toBeVisible();

  await runDocumentCommand(page, 'Set password…');
  const dialog = page.getByTestId('set-password-dialog');
  await dialog.getByLabel('Password to open').fill('e2e-open-secret');
  await dialog.getByLabel('Password to change permissions').fill('e2e-owner-secret');
  await dialog.getByLabel('Copying text and images').uncheck();
  await expect(dialog.getByText(/^Strength: /).first()).toBeVisible();
  if (capture) {
    await page.screenshot({
      path: fileURLToPath(new URL('m3-security-1440.png', screenshots)),
    });
  }
  await dialog.getByRole('button', { name: 'Set password' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('security-outcome')).toContainText('AES-256');

  // The export dialog's Security section shows the outcome; the summary names the algorithm.
  await page.getByRole('button', { name: 'Export document' }).click();
  const exportDialog = page.getByTestId('export-dialog');
  await expect(exportDialog.getByTestId('export-security-outcome')).toContainText(
    'AES-256: a password is needed to open it; restricted: copying text and images.',
  );
  await exportDialog.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(exportDialog.getByTestId('export-verified')).toBeVisible({ timeout: 30_000 });
  await expect(exportDialog.getByText(/Encrypted with AES-256/)).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await exportDialog.getByRole('button', { name: 'Download' }).click();
  const path = await (await downloadPromise).path();

  const bytes = await readFile(path);
  await expect(PDFDocument.load(bytes, { updateMetadata: false })).rejects.toThrow();
  const pdf = await PDFDocument.load(bytes, {
    password: 'e2e-open-secret',
    updateMetadata: false,
  });
  expect(pdf.getTitle()).toBe('Quarterly figures');
  expect(pdf.getPageCount()).toBe(3);
});

test('strip metadata, export: the output has no author', async ({ page }) => {
  await start(page, 'metadata-xmp.pdf');
  await expect(page.getByTestId('metadata-editor').getByLabel('Author')).toHaveValue(
    'Jane Q. Fixture',
  );

  // Diagnostics open lazily under Details.
  const details = page.getByTestId('diagnostics');
  await details.getByText('Details', { exact: true }).click();
  await expect(details.getByTestId('diagnostics-facts')).toContainText('attachment.txt');
  // qpdf's structural check runs on request (it loads the qpdf worker).
  const structural = details.getByTestId('structural-warnings');
  await structural.getByRole('button', { name: 'Run structural check' }).click();
  await expect(structural.getByText('No structural problems found.')).toBeVisible({
    timeout: 30_000,
  });
  if (capture) {
    await details.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: fileURLToPath(new URL('m3-diagnostics-1440.png', screenshots)),
    });
  }

  await runDocumentCommand(page, 'Strip metadata…');
  const dialog = page.getByTestId('strip-dialog');
  await expect(dialog.getByTestId('strip-count-attachments')).toHaveText('1 found');
  await dialog.getByRole('button', { name: 'Strip on export' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('metadata-editor').getByLabel('Author')).toHaveValue('');

  const path = await exportAndDownload(page);
  const pdf = await PDFDocument.load(await readFile(path), { updateMetadata: false });
  expect(pdf.getAuthor()).toBeUndefined();
  expect(pdf.getTitle()).toBeUndefined();
  expect(pdf.catalog.get(PDFName.of('Names'))).toBeUndefined();
  expect(pdf.catalog.get(PDFName.of('Metadata'))).toBeUndefined();
});
