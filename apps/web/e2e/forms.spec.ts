/**
 * Forms end to end (spec document-tools §1): open forms-a.pdf, fill the name field in
 * place, export with and without "Flatten form fields", and parse the download with
 * pdf-lib. Field creation (M4): add a text field and a checkbox from the Forms panel by
 * dragging on a page, fill them, export (the app's verification re-opens the output and
 * checks the created fields) and parse the download. From the keyboard: arming a field
 * (palette or panel) focuses the page, arrows move the field, Enter places it, Esc cancels
 * and returns the focus to the control that armed it.
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

test('keyboard: place a field from the palette, cancel from the Forms panel', async ({ page }) => {
  await useFileInputPicker(page);
  await page.goto('./?lang=en');
  await expect(page.getByTestId('app-shell')).toBeVisible();
  await openFixtures(page, ['simple-text.pdf']);
  const pageBox = page.locator('[data-page-index="0"]');
  await expect(pageBox).toBeVisible({ timeout: 20_000 });
  const layer = page.locator('[data-page-index="0"] [data-created-field-layer]');

  // From the palette: the page's layer takes the focus and shows the field to place.
  await page.locator('[data-read-viewport]').focus();
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByRole('combobox', { name: 'Search commands' }).fill('Add form field: Text field');
  await expect(page.getByRole('option', { name: /Add form field: Text field/ })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(layer).toHaveAttribute('data-placing', 'true');
  await expect(layer).toBeFocused();
  await expect(layer).toHaveAccessibleName('Place the Text field on page 1');
  const pending = layer.locator('[data-created-pending]');
  await expect(pending).toBeVisible();
  const before = await pending.boundingBox();
  const size = await pageBox.boundingBox();
  if (!before || !size) throw new Error('not laid out');
  const scale = size.width / 612;
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('ArrowDown');
  await expect
    .poll(async () => (await pending.boundingBox())?.x)
    .toBeCloseTo(before.x + 10 * scale, 0);
  const moved = await pending.boundingBox();
  expect(moved?.y).toBeCloseTo(before.y + scale, 0);
  await page.keyboard.press('Enter');
  // The new field is selected in Edit fields and has the focus, where the preview was.
  const created = page.locator('[data-created-design="Text1"]');
  await expect(created).toBeFocused();
  const placed = await created.boundingBox();
  expect(placed?.x).toBeCloseTo(moved?.x ?? 0, 0);
  expect(placed?.y).toBeCloseTo(moved?.y ?? 0, 0);

  // From the Forms panel's menu: Esc cancels and returns to "Add field".
  await page.getByRole('tab', { name: 'Forms', exact: true }).click();
  await expect(page.locator('[data-edit-fields]')).toHaveAttribute('aria-pressed', 'true');
  const addField = page.locator('[data-add-field]');
  await addField.focus();
  await page.keyboard.press('Enter');
  const checkbox = page.getByRole('menuitem', { name: 'Checkbox', exact: true });
  await expect(checkbox).toBeVisible();
  await checkbox.focus();
  await page.keyboard.press('Enter');
  await expect(layer).toHaveAttribute('data-placing', 'true');
  await expect(layer).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(layer).not.toHaveAttribute('data-placing', 'true');
  await expect(addField).toBeFocused();
  await expect(page.locator('[data-created-look]')).toHaveCount(1);

  // Space places it at once.
  await page.keyboard.press('Enter');
  await expect(checkbox).toBeVisible();
  await checkbox.focus();
  await page.keyboard.press('Enter');
  await expect(layer).toBeFocused();
  await page.keyboard.press(' ');
  await expect(page.locator('[data-created-design="CheckBox1"]')).toBeFocused();
});
