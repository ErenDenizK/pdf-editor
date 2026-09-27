/**
 * Forms end to end (spec document-tools §1): open forms-a.pdf, fill the name field in
 * place, export with and without "Flatten form fields", and parse the download with
 * pdf-lib.
 */
import { readFile } from 'node:fs/promises';

import { PDFDict, PDFDocument, PDFName } from '@cantoo/pdf-lib';
import { expect, type Page, test } from '@playwright/test';

import { openFixtures, useFileInputPicker } from './helpers';

test.skip(({ browserName }) => browserName !== 'chromium', 'Download flow is verified on Chromium');

async function fillName(page: Page, value: string): Promise<void> {
  await page.addInitScript({
    content:
      "Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });",
  });
  await useFileInputPicker(page);
  await page.goto('./');
  await expect(page.getByTestId('app-shell')).toBeVisible();
  await openFixtures(page, ['forms-a.pdf']);

  const target = page.locator('[data-form-layer="0"] [data-field-name="name"]');
  await expect(target).toBeVisible({ timeout: 20_000 });
  await target.click();
  const editor = page.locator('[data-form-editor="name"]');
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue('Alice Example');
  await editor.fill(value);
  await editor.press('Enter');
  await expect(editor).toBeHidden();
  await page.getByRole('tab', { name: 'Forms', exact: true }).click();
  await expect(page.locator('[data-field-row="name"]')).toContainText(value);
}

async function exportDocument(page: Page, flatten: boolean): Promise<PDFDocument> {
  await page.getByRole('button', { name: 'Export document' }).click();
  const dialog = page.getByTestId('export-dialog');
  await expect(dialog).toBeVisible();
  const flattenBox = dialog.getByRole('checkbox', { name: 'Flatten form fields' });
  await expect(flattenBox).toBeVisible();
  await flattenBox.setChecked(flatten);
  await dialog.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(dialog.getByTestId('export-verified')).toBeVisible({ timeout: 30_000 });
  const downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download' }).click();
  const download = await downloadPromise;
  return PDFDocument.load(await readFile(await download.path()), { updateMetadata: false });
}

test('fill a field and export flattened: no fields remain, pages unchanged', async ({ page }) => {
  await fillName(page, 'Grace Hopper');
  const pdf = await exportDocument(page, true);
  expect(pdf.getPageCount()).toBe(2);
  expect(pdf.getForm().getFields()).toHaveLength(0);
  for (const p of pdf.getPages()) {
    const annots = p.node.Annots()?.asArray() ?? [];
    const widgets = annots.filter(
      (ref) =>
        pdf.context.lookupMaybe(ref, PDFDict)?.get(PDFName.of('Subtype')) === PDFName.of('Widget'),
    );
    expect(widgets).toHaveLength(0);
  }
});

test('fill a field and export without flattening: the value is in the form', async ({ page }) => {
  await fillName(page, 'Grace Hopper');
  const pdf = await exportDocument(page, false);
  expect(pdf.getPageCount()).toBe(2);
  const fields = pdf.getForm().getFields();
  expect(fields.length).toBeGreaterThan(0);
  const name = fields.find((f) => f.getName() === 'name' || f.getName().endsWith('.name'));
  expect(name?.getName()).toBeDefined();
  expect(
    pdf
      .getForm()
      .getTextField(name?.getName() ?? 'name')
      .getText(),
  ).toBe('Grace Hopper');
});
