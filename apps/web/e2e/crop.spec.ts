/**
 * Crop pages end to end (M4 §3, crop as CropBox with "crop and discard content"):
 *
 * 1. `simple-text.pdf` (test/fixtures/README.md: three Letter pages, the header "PAGE n OF
 *    simple-text" at y 700 in 24 pt, body lines at y 660 and 640, all from x 72): every
 *    page cropped from the command palette by 72 pt margins, the top one 108 pt so the header
 *    (y ≈ 695–718) lies wholly in the discarded band, with "Also remove the content outside
 *    the crop" on. The result sheet is the redaction one (areas, self-check); the export
 *    has the /CropBox; re-opened in the app the pages have the cropped size, and searching
 *    finds the body text but not the header.
 * 2. "Draw crop area" from the Arrange context menu: the dialog gives way to Read mode, a
 *    rectangle dragged on the page becomes its margins, Esc returns without a change, and
 *    the page shows cropped.
 */
import { readFile } from 'node:fs/promises';

import { PDFDocument } from '@cantoo/pdf-lib';
import { expect, type Page, test } from '@playwright/test';

import { openFixtures, useFileInputPicker } from './helpers';

test.skip(({ browserName }) => browserName !== 'chromium', 'Covered in Chromium');
test.use({ viewport: { width: 1440, height: 900 } });

const CROP = { x: 72, y: 72, width: 468, height: 612 };

async function exportAndDownload(page: Page): Promise<Buffer> {
  await page.getByRole('button', { name: 'Export document' }).click();
  const exportDialog = page.getByTestId('export-dialog');
  await expect(exportDialog).toBeVisible();
  await exportDialog.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(exportDialog.getByTestId('export-verified')).toBeVisible({ timeout: 60_000 });
  const downloadPromise = page.waitForEvent('download');
  await exportDialog.getByRole('button', { name: 'Download' }).click();
  const bytes = await readFile(await (await downloadPromise).path());
  await page.keyboard.press('Escape');
  return bytes;
}

async function aspect(page: Page, index = 0): Promise<number> {
  const box = await page.locator(`[data-page-index="${index}"]`).first().boundingBox();
  if (!box) throw new Error('page not shown');
  return box.width / box.height;
}

test('crop every page with discard, export, re-open: cropped size, header gone, body found', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await page.addInitScript({
    content:
      "Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });",
  });
  await useFileInputPicker(page);
  await page.goto('./?lang=en');
  await openFixtures(page, ['simple-text.pdf']);

  // Read mode, "Crop pages…" from the command palette: no selection, so all pages.
  await expect(page.locator('[data-page-index="0"]').first()).toBeVisible({ timeout: 20_000 });
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByRole('combobox', { name: 'Search commands' }).fill('crop pages');
  await page.keyboard.press('Enter');
  const dialog = page.getByTestId('crop-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('radio', { name: 'All pages of simple-text (3)' })).toBeChecked();

  await dialog.getByTestId('crop-unit').selectOption('pt');
  for (const [side, value] of [
    ['top', '108'],
    ['right', '72'],
    ['bottom', '72'],
    ['left', '72'],
  ] as const) {
    await dialog.getByTestId(`crop-${side}`).fill(value);
  }
  await expect(dialog.getByTestId('crop-summary')).toHaveText(
    '3 pages will be cropped, the first to 468 × 612 pt',
  );
  // Honesty: a plain crop hides; removing is explained and says it is final once exported.
  await expect(dialog).toContainText('any PDF viewer can show it again');
  await dialog.getByRole('checkbox', { name: /Also remove the content outside the crop/ }).check();
  await expect(dialog.getByRole('note')).toContainText('Once the document is exported');
  await dialog.getByRole('button', { name: 'Crop and remove', exact: true }).click();

  // The redaction result sheet: four bands on each page, the self-check passed.
  const result = dialog.getByTestId('redaction-result');
  await expect(result).toBeVisible({ timeout: 60_000 });
  await expect(result.getByTestId('redaction-result-areas')).toHaveText('12 areas on 3 pages');
  await expect(result.getByTestId('redaction-checks-summary')).toHaveText(
    /^Self-check: (\d+) of \1 checks passed$/,
  );
  await dialog.getByRole('button', { name: 'Close' }).last().click();
  await expect(dialog).toBeHidden();
  await expect(
    page
      .getByRole('list', { name: /history/i })
      .getByRole('button', { name: 'Crop 3 pages and remove the content outside' }),
  ).toBeVisible();

  // Export (verified), then read the download: every page has the crop as its /CropBox.
  const bytes = await exportAndDownload(page);
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  expect(pdf.getPageCount()).toBe(3);
  for (const p of pdf.getPages()) {
    const crop = p.getCropBox();
    expect([crop.x, crop.y, crop.width, crop.height]).toEqual([
      CROP.x,
      CROP.y,
      CROP.width,
      CROP.height,
    ]);
  }

  // Re-open the export in the app (Read mode).
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open files' }).first().click();
  await (await chooser).setFiles({
    name: 'cropped.pdf',
    mimeType: 'application/pdf',
    buffer: bytes,
  });
  await expect(page.getByRole('tab', { name: 'cropped', selected: true })).toBeVisible();
  // The pages have the cropped size, 468 × 612 pt (their sheets in the Pages panel).
  const sheet = page
    .getByRole('listbox', { name: 'Pages of cropped' })
    .getByRole('option', { name: 'Page 1' })
    .locator('div > div')
    .first();
  await expect(sheet.locator('canvas')).toBeAttached({ timeout: 20_000 });
  const thumb = await sheet.boundingBox();
  if (!thumb) throw new Error('no thumbnail');
  expect(thumb.width / thumb.height).toBeCloseTo(CROP.width / CROP.height, 1);

  await page.keyboard.press('ControlOrMeta+f');
  const field = page.getByRole('searchbox', { name: 'Find in document' });
  // The body text is there on every page (the search runs on the re-opened file)…
  await field.fill('quick brown fox');
  await expect(page.getByTestId('search-hit')).toHaveCount(3, { timeout: 20_000 });
  // …and the header, which was in the removed top band, is not ("page 1 of" alone would
  // also match the body line "This is page 1 of a three-page…": search ignores case).
  for (const needle of ['PAGE 1 OF simple-text', 'simple-text']) {
    await field.fill(needle);
    await expect(page.getByTestId('search-status')).toHaveText('No results', {
      timeout: 20_000,
    });
    await expect(page.getByTestId('search-hit')).toHaveCount(0);
  }
});

test('draw the crop area on the page in Read mode; Esc goes back unchanged', async ({ page }) => {
  test.setTimeout(90_000);
  await useFileInputPicker(page);
  await page.goto('./?lang=en');
  await openFixtures(page, ['simple-text.pdf']);

  // Arrange: "Crop pages…" from the context menu of page 1.
  await page.keyboard.press('2');
  const cell = page.locator('[role="gridcell"][data-page-id]').first();
  await cell.click();
  await cell.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Crop pages…' }).click();
  const dialog = page.getByTestId('crop-dialog');
  await expect(dialog.getByRole('radio', { name: 'Selected pages (1)' })).toBeChecked();
  await dialog.getByTestId('crop-unit').selectOption('pt');

  // Draw: the dialog makes way, Read mode shows the page, the banner says how to leave.
  await dialog.getByRole('button', { name: 'Draw crop area' }).click();
  await expect(dialog).toBeHidden();
  const banner = page.getByTestId('crop-draw-banner');
  await expect(banner).toContainText('Esc cancels');
  const layer = page.locator('[data-crop-layer="0"]');
  await expect(layer).toBeVisible();

  // Esc: back to the dialog as it was.
  await page.keyboard.press('Escape');
  await expect(banner).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('crop-unit')).toHaveValue('pt');
  await expect(dialog.getByTestId('crop-top')).toHaveValue('0');

  // Draw again, and drag a rectangle from 10% to 90% across and 10% to 60% down.
  await dialog.getByRole('button', { name: 'Draw crop area' }).click();
  await expect(layer).toBeVisible();
  const box = await layer.boundingBox();
  if (!box) throw new Error('no layer');
  const at = (fx: number, fy: number) => ({
    x: box.x + box.width * fx,
    y: box.y + box.height * fy,
  });
  const from = at(0.1, 0.1);
  const to = at(0.9, 0.6);
  // Keep the drag inside the viewport (the page may be taller than the window).
  if (to.y > 880) throw new Error(`page too tall for the drag: ${to.y}`);
  // The dialog's backdrop fades out first: press once the layer is what is under the pointer.
  await expect
    .poll(() =>
      page.evaluate(
        ({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-crop-layer]') != null,
        from,
      ),
    )
    .toBe(true);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await expect(page.getByTestId('crop-drawn')).toBeVisible();
  await page.mouse.up();

  await expect(dialog).toBeVisible();
  await expect(banner).toBeHidden();
  const value = async (side: string) =>
    Number(await dialog.getByTestId(`crop-${side}`).inputValue());
  // Letter: 612 × 792 pt; the drawn rectangle leaves 10% above, 40% below, 10% each side.
  expect(await value('top')).toBeCloseTo(0.1 * 792, -1);
  expect(await value('bottom')).toBeCloseTo(0.4 * 792, -1);
  expect(await value('left')).toBeCloseTo(0.1 * 612, -1);
  expect(await value('right')).toBeCloseTo(0.1 * 612, -1);
  await expect(dialog.getByTestId('crop-summary')).toContainText('1 page will be cropped');
  await dialog.getByRole('button', { name: 'Crop', exact: true }).click();
  await expect(dialog).toBeHidden();

  // Read mode shows the cropped page: 80% of the width, 50% of the height.
  await expect
    .poll(() => aspect(page), { timeout: 10_000 })
    .toBeCloseTo((0.8 * 612) / (0.5 * 792), 1);
  // The text layer follows the crop: the body text is still selectable on the page.
  await expect(page.getByTestId('text-layer').first()).toContainText('quick brown fox');
});
