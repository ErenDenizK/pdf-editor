/**
 * Clip 7, "Sign, and see what was checked" (spec §6): the agreement, Document menu → "Sign
 * with certificate…" with the test PKI's certificate (`test/fixtures/pki/signer-rsa.p12`,
 * password "test-only", as in `apps/web/e2e/signatures.spec.ts`), the signer read from it,
 * then the export that signs. The downloaded file is dropped back on the window, and its
 * signature checks out as "Intact" under the certificate's name. The scene asserts that.
 */
import { readFile } from 'node:fs/promises';

import { expect } from '@playwright/test';

import { fixturePath, showInspector } from '../../../apps/web/e2e/helpers.ts';
import { scene } from '../lib/scene.ts';

const FIXTURES = ['demo-agreement.pdf'] as const;
const CERTIFICATE = 'pki/signer-rsa.p12';
/** The test certificate's subject (test/fixtures/README.md, "pki"). */
const SIGNER = 'pdf-editor Test Signer';

scene({
  id: '07-sign',
  kind: 'clip',
  // The dialogs in the middle and the inspector's Signatures section on the right.
  crop: { x: 300, y: 0, width: 1140, height: 900 },
  async prepare(stage) {
    const { page } = stage;
    await stage.openFixtures(FIXTURES);
    // The Signatures section is in the inspector, closed by default.
    await showInspector(page);
    await stage.rendered(page.locator('main'), 1);
    // Document menu → Sign with certificate…, with the test certificate and its password,
    // checked: the clip opens on the dialog showing whose certificate it is. (Choosing the
    // file and typing the password took four seconds of an eight-second clip.)
    await page.getByTestId('document-menu').click();
    await page.getByRole('menuitem', { name: 'Sign with certificate…' }).click();
    const sign = page.getByTestId('sign-dialog');
    await sign
      .getByLabel('Certificate file (.p12 or .pfx)')
      .setInputFiles(fixturePath(CERTIFICATE));
    await sign.getByLabel('Password').fill('test-only');
    await sign.getByRole('button', { name: 'Check certificate' }).click();
    await expect(sign.getByTestId('signer-name')).toHaveText(SIGNER, { timeout: 20_000 });
    // The dialog is taller than the window: show the signer and the way on.
    await sign
      .getByRole('button', { name: /^(Continue to export|Use for export)$/ })
      .scrollIntoViewIfNeeded();
    await stage.cursor.place(1060, 700);
  },
  async run(stage) {
    const { page, cursor } = stage;
    const sign = page.getByTestId('sign-dialog');
    await stage.hold(700);

    // 1. On to the export, which signs the file it writes.
    await cursor.click(
      sign.getByRole('button', { name: /^(Continue to export|Use for export)$/ }),
      380,
    );
    const dialog = page.getByTestId('export-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('export-sign-identity')).toContainText(SIGNER);
    await cursor.click(dialog.getByRole('button', { name: 'Export', exact: true }), 380);
    await expect(dialog.getByTestId('export-verified')).toBeVisible({ timeout: 60_000 });
    await expect(dialog.locator('[data-summary-item="signature"]')).toContainText(
      `Signed by ${SIGNER}`,
    );
    const download = page.waitForEvent('download');
    await cursor.click(dialog.getByRole('button', { name: 'Download' }), 380);
    const file = await download;
    const bytes = await readFile(await file.path());
    await expect(dialog).toBeHidden();

    // 2. Re-open the signed file: dropped on the window, as from the downloads folder.
    const view = await page.locator('main').boundingBox();
    if (!view) throw new Error('the page view is not laid out');
    await stage.dropFiles(
      [{ name: 'demo-agreement-signed.pdf', bytes }],
      { x: view.x + view.width * 0.5, y: view.y + view.height * 0.5 },
      { x: 1440 + 8, y: 620 },
      480,
    );
    await expect(
      page.getByRole('tab', { name: 'demo-agreement-signed', selected: true }),
    ).toBeVisible();
    const section = page.getByTestId('signatures-section');
    await expect(section.getByTestId('signature-status')).toHaveText('Intact', { timeout: 20_000 });
    await expect(section).toContainText(SIGNER);
    // The drop left the pointer on the page, clear of the inspector's result.
  },
});
