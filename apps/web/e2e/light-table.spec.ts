/**
 * Light table end to end: real native drag and drop driven by mouse events (Playwright
 * intercepts HTML5 drags in Chromium), tab context menu pinning, merging every open
 * document and exporting the result, and screenshots for the design review
 * (`CAPTURE_SCREENSHOTS=1`, written to docs/design/screenshots/).
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { PDFDocument } from '@cantoo/pdf-lib';
import { expect, type Page, test } from '@playwright/test';

import { openFixtures, useFileInputPicker } from './helpers';

const screenshots = new URL('../../../docs/design/screenshots/', import.meta.url);
const capture = Boolean(process.env.CAPTURE_SCREENSHOTS);

/** Shows every open document in Arrange through the tab context menu. */
async function showBothInArrange(page: Page, second: string): Promise<void> {
  await page.getByRole('tab', { name: second }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Show in Arrange' }).click();
  await expect(page.getByRole('grid')).toHaveCount(2);
}

/** Waits until at least `count` light-table thumbnails have rendered. */
async function rendered(page: Page, count: number): Promise<void> {
  await expect(
    page.locator('[role="gridcell"] canvas[data-state="rendered"]').nth(count - 1),
  ).toBeAttached({ timeout: 20_000 });
}

function grid(page: Page, name: string) {
  return page.getByRole('grid', { name });
}

test.describe('light table', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test.beforeEach(async ({ page }) => {
    await useFileInputPicker(page);
  });

  test('drags a page from one document into another', async ({ page }) => {
    await page.goto('./');
    await openFixtures(page, ['simple-text.pdf', 'rotated-pages.pdf']);
    await showBothInArrange(page, 'rotated-pages');

    const source = grid(page, 'simple-text').getByRole('gridcell').nth(0);
    const target = grid(page, 'rotated-pages').getByRole('gridcell').nth(1);
    await expect(grid(page, 'rotated-pages').getByRole('gridcell')).toHaveCount(4);

    await source.hover();
    await page.mouse.down();
    const box = await target.boundingBox();
    if (!box) throw new Error('target cell not rendered');
    // Right part of the second cell → the gap after it (index 2).
    await page.mouse.move(box.x + box.width * 0.85, box.y + box.height * 0.4, { steps: 12 });
    await expect(page.getByTestId('insertion-bar')).toBeVisible();
    await expect(page.getByTestId('insertion-bar')).toHaveAttribute('data-index', '2');
    await expect(page.getByTestId('contextual-bar')).toHaveCount(0);
    await page.mouse.up();

    await expect(grid(page, 'rotated-pages').getByRole('gridcell')).toHaveCount(5);
    await expect(grid(page, 'simple-text').getByRole('gridcell')).toHaveCount(2);
    await expect(grid(page, 'rotated-pages').getByRole('gridcell').nth(2)).toHaveAccessibleName(
      'Page 3 of 5, from simple-text.pdf',
    );
    await expect(page.getByTestId('insertion-bar')).toHaveCount(0);

    // One undo step brings it back.
    await page.keyboard.press('ControlOrMeta+z');
    await expect(grid(page, 'simple-text').getByRole('gridcell')).toHaveCount(3);
  });

  test('marquee selects across sections', async ({ page }) => {
    await page.goto('./');
    await openFixtures(page, ['simple-text.pdf', 'rotated-pages.pdf']);
    await showBothInArrange(page, 'rotated-pages');
    const last = grid(page, 'simple-text').getByRole('gridcell').nth(2);
    const first = grid(page, 'rotated-pages').getByRole('gridcell').nth(0);
    const from = await last.boundingBox();
    const to = await first.boundingBox();
    if (!from || !to) throw new Error('cells not rendered');
    // Start in the empty space right of the last cell of the first section.
    await page.mouse.move(from.x + from.width + 60, from.y + 10);
    await page.mouse.down();
    await page.mouse.move(to.x + 10, to.y + 20, { steps: 8 });
    await expect(page.getByTestId('marquee')).toBeVisible();
    await page.mouse.up();
    await expect(page.getByText(/^\d+ selected in 2 documents$/)).toBeVisible();
  });

  test('merges all open documents and exports the combined file', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Download flow is verified on Chromium');
    // Force the <a download> path: Playwright cannot drive the native save picker.
    await page.addInitScript({
      content:
        "Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });",
    });
    await page.goto('./?lang=en');
    await openFixtures(page, ['simple-text.pdf', 'rotated-pages.pdf']);

    await page.keyboard.press('ControlOrMeta+k');
    await page.getByRole('combobox', { name: 'Search commands' }).fill('merge all');
    await page.keyboard.press('Enter');
    const dialog = page.getByTestId('merge-all-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('merge-row')).toHaveCount(2);
    await expect(dialog.getByRole('status')).toHaveText(
      'Creates one document from 2 documents with 7 pages.',
    );
    await dialog.getByRole('button', { name: 'Merge', exact: true }).click();
    await expect(dialog).toBeHidden();

    const tabs = page.getByRole('tablist', { name: 'Open documents' }).getByRole('tab');
    await expect(tabs).toHaveCount(1);
    await expect(tabs.first()).toHaveAccessibleName('simple-text');

    await page.getByRole('button', { name: 'Export document' }).click();
    const exportDialog = page.getByTestId('export-dialog');
    await exportDialog.getByRole('button', { name: 'Export', exact: true }).click();
    await expect(exportDialog.getByTestId('export-verified')).toBeVisible({ timeout: 30_000 });
    const downloadPromise = page.waitForEvent('download');
    await exportDialog.getByRole('button', { name: 'Download' }).click();
    const download = await downloadPromise;
    const pdf = await PDFDocument.load(await readFile(await download.path()), {
      updateMetadata: false,
    });
    expect(pdf.getPageCount()).toBe(7);
  });

  test('screenshots for design review', async ({ page }) => {
    test.skip(!capture, 'Set CAPTURE_SCREENSHOTS=1 to write docs/design/screenshots/.');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('./');
    await openFixtures(page, ['outline-named-dests.pdf', 'forms-a.pdf']);
    await showBothInArrange(page, 'forms-a');
    await rendered(page, 8);
    const cells = grid(page, 'outline-named-dests').getByRole('gridcell');
    await cells.nth(1).click();
    await cells.nth(2).click({ modifiers: ['Shift'] });
    await expect(page.getByTestId('contextual-bar')).toBeVisible();
    await page.mouse.move(700, 880);
    await page.screenshot({
      path: fileURLToPath(new URL('m1-light-table-two-sections-1440.png', screenshots)),
    });

    const target = grid(page, 'forms-a').getByRole('gridcell').nth(0);
    await cells.nth(1).hover();
    await page.mouse.down();
    const box = await target.boundingBox();
    if (!box) throw new Error('target cell not rendered');
    await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.4, { steps: 12 });
    await expect(page.getByTestId('insertion-bar')).toBeVisible();
    await page.screenshot({
      path: fileURLToPath(new URL('m1-light-table-drag-1440.png', screenshots)),
    });
    await page.mouse.up();
  });

  test('screenshots of the operation dialogs (English and Turkish)', async ({ page }) => {
    test.skip(!capture, 'Set CAPTURE_SCREENSHOTS=1 to write docs/design/screenshots/.');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('./?lang=en');
    await openFixtures(page, ['outline-named-dests.pdf', 'forms-a.pdf', 'simple-text.pdf']);
    await showBothInArrange(page, 'forms-a');
    await page.getByRole('tab', { name: 'outline-named-dests' }).click();
    await page.keyboard.press('2');
    await rendered(page, 6);

    await page.getByRole('button', { name: 'outline-named-dests actions' }).click();
    await page.getByRole('menuitem', { name: 'Split…' }).click();
    const split = page.getByTestId('split-dialog');
    await split.getByRole('radio', { name: /Page ranges/ }).click();
    await split.getByTestId('split-ranges').fill('1-2, 4-9');
    await expect(split.getByTestId('split-range-errors')).toBeVisible();
    await page.screenshot({
      path: fileURLToPath(new URL('m1-split-dialog-errors-1440.png', screenshots)),
    });
    await split.getByTestId('split-ranges').fill('1-2, 4-5');
    await expect(split.getByTestId('split-preview')).toContainText('Creates 2 documents');
    await page.screenshot({
      path: fileURLToPath(new URL('m1-split-dialog-1440.png', screenshots)),
    });
    await page.keyboard.press('Escape');

    await page.keyboard.press('ControlOrMeta+k');
    await page.getByRole('combobox', { name: 'Search commands' }).fill('merge all');
    await page.keyboard.press('Enter');
    const merge = page.getByTestId('merge-all-dialog');
    await merge.getByRole('button', { name: 'Move simple-text up' }).click();
    await page.screenshot({
      path: fileURLToPath(new URL('m1-merge-dialog-1440.png', screenshots)),
    });
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'outline-named-dests actions' }).click();
    await page.getByRole('menuitem', { name: 'Interleave with…' }).click();
    const interleave = page.getByTestId('interleave-dialog');
    await interleave.getByRole('radio', { name: /Duplex scan/ }).click();
    await page.screenshot({
      path: fileURLToPath(new URL('m1-interleave-dialog-1440.png', screenshots)),
    });
    await page.keyboard.press('Escape');

    // Turkish: the light table with its section menu open, then the split dialog.
    await page.goto('./?lang=tr');
    await openFixtures(page, ['outline-named-dests.pdf', 'forms-a.pdf']);
    await page.getByRole('tab', { name: 'forms-a' }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Sıralama’da göster' }).click();
    await expect(page.getByRole('grid')).toHaveCount(2);
    await rendered(page, 8);
    await page.getByRole('button', { name: 'outline-named-dests işlemleri' }).click();
    await page.getByRole('menuitem', { name: /Başka belgeye ekle/ }).hover();
    await expect(page.getByRole('menuitem', { name: 'forms-a' })).toBeVisible();
    await page.screenshot({
      path: fileURLToPath(new URL('m1-light-table-tr-1440.png', screenshots)),
    });
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'outline-named-dests işlemleri' }).click();
    await page.getByRole('menuitem', { name: 'Böl…' }).click();
    await expect(page.getByTestId('split-dialog')).toBeVisible();
    await page.screenshot({
      path: fileURLToPath(new URL('m1-split-dialog-tr-1440.png', screenshots)),
    });
  });
});
