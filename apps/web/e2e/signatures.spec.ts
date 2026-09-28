/**
 * Signatures end to end (spec recognize-and-compare §3, ADR-0013): validation on open shows
 * the status and the honesty line in the Inspector; signing through the export dialog with
 * the test PKI's .p12 produces a download that re-opens as Intact, with the summary line;
 * a legacy 3DES .p12 is refused with the re-export command.
 */
import { readFile } from 'node:fs/promises';

import { expect, type Page, test } from '@playwright/test';

import { fixturePath, openFixtures, useFileInputPicker } from './helpers';

const HONESTY =
  'Checked on this device against the certificates in the file. Signer identity, trust and revocation are not verified.';

test.skip(({ browserName }) => browserName !== 'chromium', 'Download flow is verified on Chromium');
test.use({ viewport: { width: 1440, height: 900 } });

async function start(page: Page, fixtures: readonly string[]): Promise<void> {
  // Force the <a download> path: Playwright cannot drive the native save picker.
  await page.addInitScript({
    content:
      "Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });",
  });
  await useFileInputPicker(page);
  await page.goto('./');
  await expect(page.getByTestId('app-shell')).toBeVisible();
  await openFixtures(page, fixtures);
}

test('signed-then-modified: Intact, changed later with the honesty line', async ({ page }) => {
  await start(page, ['signed-then-modified.pdf']);
  const section = page.getByTestId('signatures-section');
  await expect(section.getByTestId('signature-status')).toHaveText('Intact, changed later', {
    timeout: 20_000,
  });
  await expect(section.getByTestId('signature-honesty')).toHaveText(HONESTY);
  await expect(section.getByTestId('signature-changes')).toContainText(
    'Revision 3: annotations, page 1',
  );
  await expect(page.getByTestId('status-signatures')).toContainText('Intact, changed later');
  await expect(section).not.toContainText(/\bvalid\b/i);
});

test('signed-tampered: Broken', async ({ page }) => {
  await start(page, ['signed-tampered.pdf']);
  const section = page.getByTestId('signatures-section');
  await expect(section.getByTestId('signature-status')).toHaveText('Broken', { timeout: 20_000 });
  await expect(section.getByTestId('signature-honesty')).toHaveText(HONESTY);
  await expect(page.getByTestId('status-signatures')).toContainText('Broken');
});

test('sign simple-text.pdf through the export dialog; the download re-opens as Intact', async ({
  page,
}) => {
  await start(page, ['simple-text.pdf']);
  await page.getByRole('button', { name: 'Export document' }).click();
  const dialog = page.getByTestId('export-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('export-sign').check();

  const sign = page.getByTestId('sign-dialog');
  await expect(sign).toBeVisible();
  await sign
    .getByLabel('Certificate file (.p12 or .pfx)')
    .setInputFiles(fixturePath('pki/signer-rsa.p12'));
  await sign.getByLabel('Password').fill('test-only');
  await sign.getByRole('button', { name: 'Check certificate' }).click();
  await expect(sign.getByTestId('signer-name')).toHaveText('pdf-editor Test Signer', {
    timeout: 20_000,
  });
  await sign.getByRole('button', { name: 'Use for export' }).click();
  await expect(sign).toBeHidden();
  await expect(dialog.getByTestId('export-sign-identity')).toContainText(
    'pdf-editor Test Signer (signer-rsa.p12)',
  );

  await dialog.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(dialog.getByTestId('export-verified')).toBeVisible({ timeout: 30_000 });
  await expect(dialog.locator('[data-summary-item="signature"]')).toHaveText(
    'Signed by pdf-editor Test Signer (RSASSA-PKCS1-v1_5 with SHA-256), field “Signature1”: approval signature; identity and trust not verified.',
  );
  const downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download' }).click();
  const download = await downloadPromise;
  await expect(dialog).toBeHidden();
  const bytes = await readFile(await download.path());
  expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');

  // Re-open the download: the new signature checks out as Intact.
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open files' }).first().click();
  await (await chooser).setFiles({
    name: 'signed-download.pdf',
    mimeType: 'application/pdf',
    buffer: bytes,
  });
  await expect(page.getByRole('tab', { name: 'signed-download' })).toBeVisible();
  const section = page.getByTestId('signatures-section');
  await expect(section.getByTestId('signature-status')).toHaveText('Intact', { timeout: 20_000 });
  await expect(section.getByTestId('signature-honesty')).toHaveText(HONESTY);
  await expect(section).toContainText('pdf-editor Test Signer');
});

test('a legacy 3DES .p12 is refused with the re-export command', async ({ page }) => {
  await start(page, ['simple-text.pdf']);
  await page.getByTestId('document-menu').click();
  await page.getByRole('menuitem', { name: 'Sign…' }).click();
  const sign = page.getByTestId('sign-dialog');
  await expect(sign).toBeVisible();
  await sign
    .getByLabel('Certificate file (.p12 or .pfx)')
    .setInputFiles(fixturePath('pki/signer-rsa-legacy-3des.p12'));
  await sign.getByLabel('Password').fill('test-only');
  await sign.getByRole('button', { name: 'Check certificate' }).click();
  await expect(sign.getByRole('alert')).toContainText(
    'This certificate file uses legacy encryption (3DES or RC2)',
    { timeout: 20_000 },
  );
  await expect(sign.getByTestId('sign-reexport-command')).toContainText(
    'openssl pkcs12 -export -keypbe AES-256-CBC -certpbe AES-256-CBC',
  );
  // Nothing was chosen: the dialog still offers the check, not export.
  await expect(sign.getByRole('button', { name: 'Check certificate' })).toBeVisible();
});
