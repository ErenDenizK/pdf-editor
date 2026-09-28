/**
 * Image objects end to end (M4 §3) on `images.pdf` (three pages, one 360 × 270 pt image
 * each at 126, 330; page 1 a PNG with a soft mask, 160 × 120 px). Press I, drag the first
 * image 50 px to the right: one history entry, the image located again at its new place;
 * Extract saves a PNG of the image's pixel size; export, re-open the export: the image's
 * rect (as the engine locates it) moved by 50 px in points. From the keyboard: the
 * contextual bar is one Tab stop with arrow keys between its buttons, and Mod+Arrow resizes
 * the selected image keeping its aspect ratio (announced).
 */
import { readFile } from 'node:fs/promises';

import { expect, type Locator, type Page, test } from '@playwright/test';

import { openFixtures, useFileInputPicker } from './helpers';

test.skip(({ browserName }) => browserName !== 'chromium', 'Covered in Chromium');
test.use({ viewport: { width: 1440, height: 900 } });

function historyRow(page: Page, label: string | RegExp) {
  return page.getByRole('list', { name: /history/i }).getByRole('button', { name: label });
}

/** The image targets of the first page (present while the Image tool is active). */
function firstImage(page: Page): Locator {
  return page.locator('[data-image-layer="0"] [data-image-object]').first();
}

async function imageRect(target: Locator): Promise<number[]> {
  const value = await target.getAttribute('data-image-rect');
  return (value ?? '').split(' ').map(Number);
}

/** Width and height from a PNG's IHDR chunk. */
function pngSize(bytes: Buffer): { width: number; height: number } {
  expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function armImageTool(page: Page): Promise<void> {
  await page.locator('[data-read-viewport]').focus();
  await page.keyboard.press('i');
  await expect(page.getByRole('button', { name: 'Image', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
}

test.beforeEach(async ({ page }) => {
  // Force the <a download> path: Playwright cannot drive the native save picker.
  await page.addInitScript({
    content:
      "Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });",
  });
  await useFileInputPicker(page);
  await page.goto('./?lang=en');
});

test('move an image 50 px, extract it as PNG, export and re-open: the image moved', async ({
  page,
}) => {
  await openFixtures(page, ['images.pdf']);
  await expect(page.locator('canvas[data-state="rendered"]').first()).toBeAttached({
    timeout: 20_000,
  });
  await armImageTool(page);

  const target = firstImage(page);
  await expect(target).toBeVisible({ timeout: 20_000 });
  expect(await imageRect(target)).toEqual([126, 330, 360, 270]);
  const box = await target.boundingBox();
  if (!box) throw new Error('image target not laid out');
  const ptPerPx = 360 / box.width;

  // Drag from the middle, 50 px to the right.
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let step = 1; step <= 10; step++) await page.mouse.move(x + 5 * step, y);
  await page.mouse.up();

  await expect(historyRow(page, 'Image moved')).toBeVisible({ timeout: 20_000 });
  const expectedX = 126 + 50 * ptPerPx;
  await expect
    .poll(async () => (await imageRect(firstImage(page)))[0] ?? 0, { timeout: 20_000 })
    .toBeCloseTo(expectedX, 1);
  const moved = await imageRect(firstImage(page));
  expect(moved.slice(1)).toEqual([330, 360, 270]);

  // The moved image is selected again; its bar reads the size and extracts a PNG.
  const bar = page.getByTestId('image-bar');
  await expect(bar).toBeVisible();
  await expect(bar.getByTestId('image-size')).toContainText('360 × 270 pt');
  await expect(bar.getByTestId('image-size')).toContainText('160 × 120 px');
  const extracted = page.waitForEvent('download');
  await bar.getByRole('button', { name: 'Extract' }).click();
  const download = await extracted;
  expect(download.suggestedFilename()).toBe('images-page-1-image.png');
  expect(pngSize(await readFile(await download.path()))).toEqual({ width: 160, height: 120 });

  // Export and download.
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Export document' }).click();
  const exportDialog = page.getByTestId('export-dialog');
  await expect(exportDialog).toBeVisible();
  await exportDialog.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(exportDialog.getByTestId('export-verified')).toBeVisible({ timeout: 30_000 });
  const downloadPromise = page.waitForEvent('download');
  await exportDialog.getByRole('button', { name: 'Download' }).click();
  const bytes = await readFile(await (await downloadPromise).path());
  await page.keyboard.press('Escape');

  // Re-open the export: the engine locates the image at its new place.
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open files' }).first().click();
  await (await chooser).setFiles({ name: 'moved.pdf', mimeType: 'application/pdf', buffer: bytes });
  await expect(page.getByRole('tab', { name: 'moved' })).toBeVisible();
  await expect(page.locator('canvas[data-state="rendered"]').first()).toBeAttached({
    timeout: 20_000,
  });
  // The read view of a document opened right after the export dialog stays empty until
  // something navigates (seen without image edits too): go to page 1 from the navigator.
  await page
    .getByRole('listbox', { name: 'Pages of moved' })
    .getByRole('option', { name: 'Page 1' })
    .click();
  await armImageTool(page);
  const reopened = firstImage(page);
  await expect(reopened).toBeVisible({ timeout: 20_000 });
  const rect = await imageRect(reopened);
  expect(rect[0]).toBeCloseTo(expectedX, 1);
  expect(rect.slice(1)).toEqual([330, 360, 270]);
});

test('keyboard: arrows nudge the selected image, Delete removes it, undo brings it back', async ({
  page,
}) => {
  await openFixtures(page, ['images.pdf']);
  await armImageTool(page);
  const target = firstImage(page);
  await expect(target).toBeVisible({ timeout: 20_000 });
  await target.click();
  const selection = page.getByTestId('image-selection');
  await expect(selection).toBeFocused();

  await page.keyboard.press('Shift+ArrowRight');
  await expect(historyRow(page, 'Image moved')).toBeVisible({ timeout: 20_000 });
  await expect.poll(async () => (await imageRect(firstImage(page)))[0]).toBeCloseTo(136, 1);
  await expect(selection).toBeFocused();

  await page.keyboard.press('Delete');
  await expect(historyRow(page, 'Image deleted')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-image-layer="0"] [data-image-object]')).toHaveCount(0);

  // Undo of a removal reopens the source and replays the move.
  await page.keyboard.press('ControlOrMeta+z');
  await expect(firstImage(page)).toBeVisible({ timeout: 20_000 });
  await expect.poll(async () => (await imageRect(firstImage(page)))[0]).toBeCloseTo(136, 1);
  // Undo of the move applies its inverse.
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await imageRect(firstImage(page)))[0]).toBeCloseTo(126, 1);
});

test('keyboard: the bar is one Tab stop with arrow keys; Mod+Arrow resizes keeping the ratio', async ({
  page,
}) => {
  await openFixtures(page, ['images.pdf']);
  await armImageTool(page);
  const target = firstImage(page);
  await expect(target).toBeVisible({ timeout: 20_000 });
  await target.focus();
  await page.keyboard.press('Enter');
  const selection = page.getByTestId('image-selection');
  await expect(selection).toBeFocused();

  const bar = page.getByTestId('image-bar');
  const replace = bar.getByRole('button', { name: 'Replace…' });
  const extract = bar.getByRole('button', { name: 'Extract' });
  const remove = bar.getByRole('button', { name: 'Delete' });
  await expect
    .poll(() => bar.getByRole('button').evaluateAll((els) => els.map((el) => el.tabIndex)))
    .toEqual([0, -1, -1]);
  await page.keyboard.press('Tab');
  await expect(replace).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(extract).toBeFocused();
  await page.keyboard.press('End');
  await expect(remove).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(replace).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(remove).toBeFocused();
  // One Tab stop that remembers the last button.
  await page.keyboard.press('Shift+Tab');
  await expect(selection).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(remove).toBeFocused();

  // Mod+Right: the longer side (360 pt) grows by 1 pt, the height keeps the ratio.
  await selection.focus();
  const live = page.locator('div[role="status"][aria-live="polite"].visually-hidden');
  await page.keyboard.press('ControlOrMeta+ArrowRight');
  await expect(historyRow(page, 'Image resized')).toBeVisible({ timeout: 20_000 });
  await expect(live).toHaveText(/Image resized to 361 × 270\.[78] pt/);
  await expect.poll(async () => (await imageRect(firstImage(page)))[2]).toBeCloseTo(361, 1);
  await expect.poll(async () => (await imageRect(firstImage(page)))[3]).toBeCloseTo(270.75, 1);
  await expect(selection).toBeFocused();
  // Mod+Shift+Left shrinks it by 10 pt; the top-left corner stays.
  const [x] = await imageRect(firstImage(page));
  await page.keyboard.press('ControlOrMeta+Shift+ArrowLeft');
  await expect(live).toHaveText(/Image resized to 351 × 263\.[23] pt/, { timeout: 20_000 });
  await expect.poll(async () => (await imageRect(firstImage(page)))[2]).toBeCloseTo(351, 1);
  await expect.poll(async () => (await imageRect(firstImage(page)))[3]).toBeCloseTo(263.25, 1);
  expect((await imageRect(firstImage(page)))[0]).toBeCloseTo(x ?? 0, 1);
});
