/**
 * Edit text end to end (redaction-and-text-editing spec §2.2, §2.5) on `text-edit-fonts.pdf`
 * (test/fixtures/README.md: the same sentence in Helvetica on y = 700, then in an
 * Identity-H Inter subset on y = 650, and in other fonts below). Press E, click the
 * Helvetica line, replace "fox" with "cat", Enter; export, re-open the export and search:
 * "cat" is on the edited line and the edited line no longer has "fox". A second test types
 * a character the Inter subset lacks and sees the "font substituted" badge. From the
 * keyboard, the focus returns to the line after Esc and after Enter. Screenshots for
 * the design review with `CAPTURE_SCREENSHOTS=1` (docs/design/screenshots/).
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { expect, type Page, test } from '@playwright/test';

import { openFixtures, useFileInputPicker } from './helpers';

test.skip(({ browserName }) => browserName !== 'chromium', 'Covered in Chromium');
test.use({ viewport: { width: 1440, height: 900 } });

const FOX = 'The quick brown fox jumps over the lazy dog';
const screenshots = new URL('../../../docs/design/screenshots/', import.meta.url);
const capture = Boolean(process.env.CAPTURE_SCREENSHOTS);

function historyRow(page: Page, label: string | RegExp) {
  return page.getByRole('list', { name: /history/i }).getByRole('button', { name: label });
}

/** The run targets of a line of the fixture, in reading order (0 = Helvetica, 1 = subset). */
function line(page: Page, index: number) {
  return page.locator(`[data-text-edit-layer="0"] [data-text-run="${FOX}"]`).nth(index);
}

/** Clicks a line of the fixture on the word `word` (its characters are evenly spaced enough). */
async function clickWord(page: Page, index: number, word: string): Promise<void> {
  const target = line(page, index);
  await expect(target).toBeVisible({ timeout: 20_000 });
  const box = await target.boundingBox();
  if (!box) throw new Error('line not laid out');
  const at = (FOX.indexOf(word) + 1) / FOX.length;
  await page.mouse.click(box.x + box.width * at, box.y + box.height / 2);
}

/** Searches the active document (opens the Search panel when needed). */
async function search(page: Page, query: string) {
  const field = page.getByRole('searchbox', { name: 'Find in document' });
  if (!(await field.isVisible())) await page.keyboard.press('ControlOrMeta+f');
  await field.fill(query);
  return page.getByTestId('search-hit');
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

async function openFonts(page: Page): Promise<void> {
  await openFixtures(page, ['text-edit-fonts.pdf']);
  await expect(page.locator('canvas[data-state="rendered"]').first()).toBeAttached({
    timeout: 20_000,
  });
}

test('replace a word in the Helvetica line, export, re-open: the edited line reads "cat"', async ({
  page,
}) => {
  await openFonts(page);
  const before = await search(page, 'fox');
  await expect(page.getByTestId('status-search')).toContainText(/of \d+/);
  const foxBefore = await before.count();
  expect(foxBefore).toBeGreaterThan(1);
  await page.keyboard.press('Escape');
  await page.locator('[data-read-viewport]').focus();

  // E arms the tool; the page's runs become targets.
  await page.keyboard.press('e');
  await expect(page.getByRole('button', { name: 'Edit text' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await clickWord(page, 0, 'fox');

  const editor = page.getByRole('textbox', { name: 'Line text' });
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue(FOX);
  // The clicked character is selected.
  expect(
    await editor.evaluate((el: HTMLInputElement) => el.selectionEnd! - el.selectionStart!),
  ).toBe(1);
  const badge = page.getByTestId('text-edit-badge');
  await expect(page.getByTestId('text-edit-font')).toHaveText('Helvetica · not embedded');
  await expect(badge).toHaveText('Same font (not embedded)');

  await editor.fill(FOX.replace('fox', 'cat'));
  await expect(badge).toHaveText('Same font (not embedded)');
  if (capture) {
    await page.screenshot({ path: fileURLToPath(new URL('m4-text-edit-1440.png', screenshots)) });
  }
  await editor.press('Enter');
  await expect(editor).toHaveCount(0);
  await expect(historyRow(page, 'Text edited (same font, not embedded)')).toBeVisible();
  // The runs are located again and the edited line now reads with the new word (the engine
  // keeps the line in as few text objects as possible, so "cat" may share a run).
  await expect(page.locator('[data-text-edit-layer="0"] [data-text-run*="cat"]')).toBeAttached();

  // Export and download.
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

  // Re-open the export and search it.
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open files' }).first().click();
  await (await chooser).setFiles({
    name: 'edited.pdf',
    mimeType: 'application/pdf',
    buffer: bytes,
  });
  await expect(page.getByRole('tab', { name: 'edited' })).toBeVisible();
  await expect(page.locator('canvas[data-state="rendered"]').first()).toBeAttached({
    timeout: 20_000,
  });
  const cat = await search(page, 'cat');
  await expect(cat).toHaveCount(1);
  await expect(cat.first()).toContainText('brown cat jumps');
  // One "fox" fewer: the edited line lost it, the other lines keep theirs.
  await expect(await search(page, 'fox')).toHaveCount(foxBefore - 1);
});

test('keyboard: the focus returns to the line after Esc and after Enter', async ({ page }) => {
  await openFonts(page);
  await page.locator('[data-read-viewport]').focus();
  await page.keyboard.press('e');
  const first = line(page, 0);
  await expect(first).toBeVisible({ timeout: 20_000 });
  const lineBox = await first.boundingBox();
  if (!lineBox) throw new Error('line not laid out');
  await first.focus();
  await page.keyboard.press('Enter');
  const editor = page.getByRole('textbox', { name: 'Line text' });
  await expect(editor).toBeFocused();

  // Esc: back on the same run; the tool stays armed.
  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);
  await expect(first).toBeFocused();
  await expect(page.getByRole('button', { name: 'Edit text' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // Enter commits: the line is new runs, the focus goes to the one where the edit started.
  await page.keyboard.press('Enter');
  await expect(editor).toBeFocused();
  await editor.fill(FOX.replace('dog', 'cat'));
  await editor.press('Enter');
  await expect(editor).toHaveCount(0, { timeout: 20_000 });
  await expect(historyRow(page, /^Text edited/)).toBeVisible({ timeout: 20_000 });
  const focused = page.locator('[data-text-edit-layer="0"] [data-text-run]:focus');
  await expect(focused).toHaveAttribute('data-text-run', /^The quick brown fox/, {
    timeout: 20_000,
  });
  const focusedBox = await focused.boundingBox();
  expect(Math.abs((focusedBox?.y ?? 0) - lineBox.y)).toBeLessThan(2);
  expect(Math.abs((focusedBox?.x ?? 0) - lineBox.x)).toBeLessThan(2);
  // The keyboard continues from there.
  await page.keyboard.press('Enter');
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue(/^The quick brown fox/);
});

test('a character the Identity-H subset lacks switches the badge to the substitute font', async ({
  page,
}) => {
  await openFonts(page);
  await page.locator('[data-read-viewport]').focus();
  await page.keyboard.press('e');
  const lines = page.locator(`[data-text-edit-layer="0"] [data-text-run="${FOX}"]`);
  await expect(lines.nth(1)).toBeVisible({ timeout: 20_000 });
  const count = await lines.count();
  await clickWord(page, 1, 'fox');
  const editor = page.getByRole('textbox', { name: 'Line text' });
  await expect(editor).toBeFocused();
  await expect(page.getByTestId('text-edit-font')).toHaveText('Inter-Regular · embedded');
  const badge = page.getByTestId('text-edit-badge');
  await expect(badge).toHaveText('Same font');

  // "F" is not in the subset (only the glyphs of the sentence are).
  await editor.fill(FOX.replace('fox', 'Fox'));
  await expect(badge).toHaveText('Font substituted: Inter');
  await expect(page.getByTestId('text-edit-fell-back')).toContainText('no glyph for “F”');
  if (capture) {
    await page.screenshot({
      path: fileURLToPath(new URL('m4-text-edit-substituted-1440.png', screenshots)),
    });
  }

  // Wider than the free space: the editor asks how to fit before it applies.
  const fit = page.getByTestId('text-edit-fit');
  if (await fit.isVisible()) {
    await editor.press('Enter');
    await expect(editor).toBeFocused();
    await fit.getByRole('button', { name: 'Allow overflow' }).click();
  }
  await editor.press('Enter');
  await expect(editor).toHaveCount(0);
  await expect(historyRow(page, 'Text edited (font substituted: Inter)')).toBeVisible();

  // Undo reopens the source and replays nothing: the line reads "fox" again.
  await expect(lines).toHaveCount(count - 1);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(lines).toHaveCount(count);
  await expect(page.locator('[data-text-edit-layer="0"] [data-text-run="Fox"]')).toHaveCount(0);
});

test('rotated page: the editor turns with the line; an upright line is edited in place', async ({
  page,
}) => {
  const upright = 'Page 1 rotate 90 line 2 reads upright';
  const sideways = 'Page 1 rotate 90 line 1: The quick brown fox jumps over the lazy dog';
  await openFixtures(page, ['text-edit-rotated.pdf']);
  await page.locator('[data-read-viewport]').focus();
  await page.keyboard.press('e');
  const runs = page.locator('[data-text-edit-layer="0"]');
  const editor = page.getByRole('textbox', { name: 'Line text' });

  // Horizontal in user space on a /Rotate 90 page: it runs top to bottom on screen.
  await expect(runs.locator(`[data-text-run="${sideways}"]`)).toBeVisible({ timeout: 20_000 });
  await runs.locator(`[data-text-run="${sideways}"]`).click();
  await expect(editor).toBeFocused();
  expect(await editor.evaluate((el) => el.style.transform)).toContain('rotate(90deg)');
  if (capture) {
    await page.screenshot({
      path: fileURLToPath(new URL('m4-text-edit-rotated-1440.png', screenshots)),
    });
  }
  // Esc cancels: the editor closes, the tool stays armed.
  await editor.press('Escape');
  await expect(editor).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Edit text' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // Counter-rotated by its text matrix, the second line reads upright: no rotation.
  await runs.locator(`[data-text-run="${upright}"]`).click();
  await expect(editor).toBeFocused();
  expect(await editor.evaluate((el) => el.style.transform)).not.toContain('rotate');
  await editor.fill(upright.replace('reads', 'looks'));
  await expect(page.getByTestId('text-edit-badge')).toHaveText(/^Same font/);
  const fit = page.getByTestId('text-edit-fit');
  if (await fit.isVisible()) await fit.getByRole('button', { name: 'Allow overflow' }).click();
  await editor.press('Enter');
  await expect(editor).toHaveCount(0);
  await expect(historyRow(page, /^Text edited/)).toBeVisible();
  await expect(runs.locator('[data-text-run*="looks"]')).toBeAttached();
});
