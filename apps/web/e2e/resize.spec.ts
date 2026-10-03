/**
 * Page resize end to end: open a corpus file with mixed page sizes, resize every page to
 * A4 (Fit) from the section menu in Arrange mode, export through the dialog (download
 * path) and re-open the download with pdf-lib: every page is A4, in the orientation it
 * was shown in, and the /Rotate of the rotated page is kept.
 */
import { readFile } from 'node:fs/promises';

import { PDFDocument } from '@cantoo/pdf-lib';
import { expect, type Page, test } from '@playwright/test';

import { enterEdit, openFixtures, useFileInputPicker } from './helpers';

test.skip(({ browserName }) => browserName !== 'chromium', 'Download flow is verified on Chromium');

const A4 = { width: 595.28, height: 841.89 };

test('resize all pages to A4 (fit), export and download a verified PDF', async ({ page }) => {
  await page.addInitScript({
    content:
      "Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });",
  });
  await useFileInputPicker(page);
  await page.goto('./');
  await expect(page.getByTestId('app-shell')).toBeVisible();
  await openFixtures(page, ['mixed-sizes.pdf']);

  // Arrange mode, then "Resize pages…" from the section menu.
  await page.keyboard.press('3');
  await expect(page.locator('[role="gridcell"][data-page-id]').first()).toBeVisible();
  await page.getByRole('button', { name: 'mixed-sizes actions' }).click();
  await page.getByRole('menuitem', { name: 'Resize pages…' }).click();

  const dialog = page.getByTestId('resize-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('resize-preset')).toHaveValue('a4');
  await expect(dialog.getByRole('radio', { name: /^Fit/ })).toBeChecked();
  await expect(dialog.getByRole('radio', { name: 'All pages of mixed-sizes (5)' })).toBeChecked();
  await expect(dialog.getByTestId('resize-summary')).toHaveText(
    '5 pages will become A4 (210 × 297 mm)',
  );
  // Keyboard path: the anchor grid moves with the arrow keys.
  await dialog.getByRole('radio', { name: 'Center', exact: true }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(dialog.getByRole('radio', { name: 'Bottom', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await dialog.getByRole('button', { name: 'Resize', exact: true }).click();
  await expect(dialog).toBeHidden();

  await page.getByRole('button', { name: 'Export document' }).click();
  const exportDialog = page.getByTestId('export-dialog');
  await expect(exportDialog).toBeVisible();
  await exportDialog.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(exportDialog.getByTestId('export-verified')).toBeVisible({ timeout: 30_000 });
  const downloadPromise = page.waitForEvent('download');
  await exportDialog.getByRole('button', { name: 'Download' }).click();
  const download = await downloadPromise;

  const pdf = await PDFDocument.load(await readFile(await download.path()), {
    updateMetadata: false,
  });
  expect(pdf.getPageCount()).toBe(5);
  // Displayed sizes: A4 portrait, Letter portrait, A4 landscape via /Rotate 90, A4
  // landscape via MediaBox, square: each keeps its orientation (a square counts as
  // portrait).
  const shown = pdf.getPages().map((p) => {
    const quarter = p.getRotation().angle % 180 !== 0;
    const { width, height } = p.getMediaBox();
    return quarter ? [height, width] : [width, height];
  });
  const expected = [
    [A4.width, A4.height],
    [A4.width, A4.height],
    [A4.height, A4.width],
    [A4.height, A4.width],
    [A4.width, A4.height],
  ];
  shown.forEach(([w, h], i) => {
    expect(w, `page ${i + 1} width`).toBeCloseTo(expected[i]?.[0] ?? 0, 1);
    expect(h, `page ${i + 1} height`).toBeCloseTo(expected[i]?.[1] ?? 0, 1);
  });
  expect(pdf.getPages().map((p) => p.getRotation().angle)).toEqual([0, 0, 90, 0, 0]);
});

/** Share of yellow pixels (the fixture's highlight) in a screen region. */
async function yellowShare(
  page: Page,
  clip: { x: number; y: number; width: number; height: number },
): Promise<number> {
  const png = await page.screenshot({ clip });
  return page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    if (!context) return 0;
    context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let yellow = 0;
    for (let i = 0; i < data.length; i += 4) {
      if ((data[i] ?? 0) > 200 && (data[i + 1] ?? 0) > 190 && (data[i + 2] ?? 255) < 140) yellow++;
    }
    return yellow / (data.length / 4);
  }, png.toString('base64'));
}

test('a rotated, resized page lines up in Read mode: text selects, annotations click', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await useFileInputPicker(page);
  await page.goto('./?lang=en');
  await openFixtures(page, ['annotations.pdf']);

  // Arrange: turn page 1 a quarter, then resize it to A4 (Fit), anchored top-left.
  await page.keyboard.press('3');
  const cell = page.locator('[role="gridcell"][data-page-id]').first();
  await cell.click();
  await page.keyboard.press('r');
  await cell.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Resize pages…' }).click();
  const dialog = page.getByTestId('resize-dialog');
  await expect(dialog.getByRole('radio', { name: 'Selected pages (1)' })).toBeChecked();
  // The page shows landscape, so the dialog proposes A4 landscape.
  await expect(dialog.getByTestId('resize-summary')).toHaveText(
    '1 page will become A4 (297 × 210 mm)',
  );
  await dialog.getByRole('radio', { name: 'Top left', exact: true }).click();
  await dialog.getByRole('button', { name: 'Resize', exact: true }).click();
  await expect(dialog).toBeHidden();

  // Read mode.
  await page.keyboard.press('1');
  const sheet = page.locator('[data-page-index="0"][data-resized]');
  await expect(sheet).toBeVisible();
  const box = await sheet.boundingBox();
  if (!box) throw new Error('page not laid out');
  expect(box.width / box.height).toBeCloseTo(841.89 / 595.28, 2);
  await expect(sheet.locator('canvas[data-state="rendered"]')).toBeAttached({ timeout: 20_000 });

  // The highlight's hit target sits on the yellow the renderer drew.
  const highlight = sheet.locator('[data-annotation-id="fixture-annot-highlight-1"]');
  const hit = await highlight.boundingBox();
  if (!hit) throw new Error('highlight hit target not rendered');
  await expect.poll(() => yellowShare(page, hit), { timeout: 10_000 }).toBeGreaterThan(0.3);
  // Off by its own width it would be on paper.
  expect(await yellowShare(page, { ...hit, x: hit.x - hit.width - 4 })).toBeLessThan(0.05);

  // Text selection on the resized page.
  const line = sheet.locator('[data-text-layer="0"] [data-row]').first();
  await expect(line).toHaveText('PAGE 1 OF annotations');
  const lineBox = await line.boundingBox();
  if (!lineBox) throw new Error('text layer not laid out');
  // The page is turned 90°: the line runs top to bottom.
  expect(lineBox.height).toBeGreaterThan(lineBox.width);
  await page.mouse.move(lineBox.x + lineBox.width / 2, lineBox.y + 1);
  await page.mouse.down();
  await page.mouse.move(lineBox.x + lineBox.width / 2, lineBox.y + lineBox.height - 1, {
    steps: 8,
  });
  await page.mouse.up();
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toContain(
    'PAGE 1 OF annotations',
  );

  // Clicking the square selects it (in Edit: Read is locked, ADR-0019 §3).
  await enterEdit(page);
  await page.mouse.click(0, 0);
  const square = sheet.locator('[data-annotation-id="fixture-annot-square-1"]');
  const squareBox = await square.boundingBox();
  if (!squareBox) throw new Error('square hit target not rendered');
  await page.mouse.click(squareBox.x + 4, squareBox.y + squareBox.height / 2);
  await expect(page.getByTestId('annotation-bar')).toBeVisible();
  await expect(sheet.locator('[data-selected-annotation]')).toHaveCount(1);
});
