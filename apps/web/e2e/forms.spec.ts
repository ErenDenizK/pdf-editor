/**
 * Forms end to end (spec document-tools §1): open forms-a.pdf, fill the name field in
 * place, export with and without "Flatten form fields", and parse the download with
 * pdf-lib. Field creation (M4): add a text field and a checkbox from the Forms panel by
 * dragging on a page, fill them, export (the app's verification re-opens the output and
 * checks the created fields) and parse the download.
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

test('add a text field and a checkbox by drag, fill them, export: the fields exist with the values', async ({
  page,
}) => {
  await page.addInitScript({
    content:
      "Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });",
  });
  await useFileInputPicker(page);
  await page.goto('./');
  await expect(page.getByTestId('app-shell')).toBeVisible();
  await openFixtures(page, ['simple-text.pdf']);
  await page.getByRole('tab', { name: 'Forms', exact: true }).click();

  const layer = page.locator('[data-page-index="0"] [data-created-field-layer]');
  const pageBox = page.locator('[data-page-index="0"]');
  await expect(pageBox).toBeVisible({ timeout: 20_000 });

  const addByDrag = async (kind: string, from: [number, number], to: [number, number]) => {
    await page.locator('[data-add-field]').click();
    await page.getByRole('menuitem', { name: kind, exact: true }).click();
    await expect(layer).toHaveAttribute('data-placing');
    const box = await pageBox.boundingBox();
    if (!box) throw new Error('no page box');
    await page.mouse.move(box.x + from[0], box.y + from[1]);
    await page.mouse.down();
    await page.mouse.move(box.x + (from[0] + to[0]) / 2, box.y + (from[1] + to[1]) / 2);
    await page.mouse.move(box.x + to[0], box.y + to[1]);
    await page.mouse.up();
  };

  await addByDrag('Text field', [80, 120], [320, 150]);
  await expect(page.locator('[data-created-row="Text1"]')).toBeVisible();
  await addByDrag('Checkbox', [80, 200], [100, 220]);
  await expect(page.locator('[data-created-row="CheckBox1"]')).toBeVisible();

  // Leave "Edit fields" and fill them like any field.
  const editFields = page.locator('[data-edit-fields]');
  await expect(editFields).toHaveAttribute('aria-pressed', 'true');
  await editFields.click();
  await expect(editFields).toHaveAttribute('aria-pressed', 'false');

  await page.locator('[data-page-index="0"] [data-field-name="Text1"]').click();
  const editor = page.locator('[data-form-editor="Text1"]');
  await expect(editor).toBeFocused();
  await editor.fill('Created by e2e');
  await editor.press('Enter');
  await expect(editor).toBeHidden();
  await page.locator('[data-page-index="0"] [data-field-name="CheckBox1"]').click();
  await expect(page.locator('[data-created-row="Text1"]')).toContainText('Created by e2e');
  await expect(page.locator('[data-created-row="CheckBox1"]')).toContainText('Checked');

  await page.getByRole('button', { name: 'Export document' }).click();
  const dialog = page.getByTestId('export-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(dialog.getByTestId('export-verified')).toBeVisible({ timeout: 30_000 });
  const downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download' }).click();
  const download = await downloadPromise;
  const pdf = await PDFDocument.load(await readFile(await download.path()), {
    updateMetadata: false,
  });
  const form = pdf.getForm();
  expect(form.getFields().map((f) => f.getName())).toEqual(['Text1', 'CheckBox1']);
  expect(form.getTextField('Text1').getText()).toBe('Created by e2e');
  expect(form.getCheckBox('CheckBox1').isChecked()).toBe(true);
  const widget = form.getTextField('Text1').acroField.getWidgets()[0];
  const rect = widget?.getRectangle();
  expect(rect?.width).toBeGreaterThan(100);
  expect(pdf.getPage(0).node.Annots()?.size()).toBe(2);
});
