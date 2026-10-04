/**
 * Edit text end to end (craft spec §4.2, §4.5, §4.7, §13 #9; redaction-and-text-editing spec
 * §2.5) on `text-edit-fonts.pdf` (test/fixtures/README.md: the same sentence in Helvetica on
 * y = 700, then in an Identity-H Inter subset on y = 650, and in other fonts below). Each
 * line is a detected paragraph, so a click opens the paragraph editor; the line editor stays
 * only as the fallback for paragraphs that refuse paragraph mode.
 *
 * - Press E, click "fox" in the Helvetica line, replace it with "cat", Esc commits one history
 *   entry; export, re-open the export and search: "cat" is on the edited line and the edited
 *   line no longer has "fox".
 * - A character the Inter subset lacks shows the honesty line naming the substitute; undo
 *   restores the line.
 * - From the keyboard (one target per paragraph, craft spec §9), the focus returns to the
 *   paragraph after Esc and after a commit. Enter inserts a line break in the paragraph editor
 *   (spec §4.2), so Esc is the keyboard's way out.
 * - On a /Rotate 90 page the editor turns with the line, and an upright line is edited in
 *   place.
 * - A paragraph inside a form XObject refuses paragraph mode: the line editor opens instead.
 *
 * Screenshots for the design review with `CAPTURE_SCREENSHOTS=1` (docs/design/screenshots/).
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { expect, type Locator, type Page, test } from '@playwright/test';

import { openFixtures, showInspector, useFileInputPicker } from './helpers';

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

/** The keyboard targets of the paragraphs reading `text` (one per line of the fixture). */
function paragraph(page: Page, text: string) {
  return page.locator(
    `[data-text-edit-layer="0"] [data-text-paragraph][aria-label="Edit paragraph “${text}”"]`,
  );
}

/** The paragraph editor's mirror: the focus target, keys and assistive technology. */
function paragraphEditor(page: Page) {
  return page.getByRole('textbox', { name: 'Paragraph on page 1' });
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

/** The caret (or selection) in the mirror, as UTF-16 offsets in the paragraph's text. */
function caretOf(editor: Locator): Promise<[number, number]> {
  return editor.evaluate(() => {
    const selection = window.getSelection();
    return [selection?.anchorOffset ?? -1, selection?.focusOffset ?? -1] as [number, number];
  });
}

/** Selects `length` characters from `start` of a one-line paragraph with the keyboard. */
async function selectRange(page: Page, start: number, length: number): Promise<void> {
  await page.keyboard.press('Home');
  for (let i = 0; i < start; i++) await page.keyboard.press('ArrowRight');
  for (let i = 0; i < length; i++) await page.keyboard.press('Shift+ArrowRight');
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
  await showInspector(page);
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

  // E arms the tool (in Read it switches to Edit first) and shows its group, Text (craft spec
  // §3.4); the page's runs become targets.
  await page.keyboard.press('e');
  await expect(page.getByRole('button', { name: 'Edit text' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('button', { name: 'Text: back to all groups' })).toBeVisible();
  await clickWord(page, 0, 'fox');

  // The line is a paragraph: the paragraph editor opens with its mirror focused.
  const editor = paragraphEditor(page);
  await expect(editor).toBeFocused({ timeout: 20_000 });
  await expect(editor).toHaveText(FOX);
  // The caret is at the click (craft spec §4.2), inside or next to "fox"; nothing is selected.
  const caret = await caretOf(editor);
  expect(caret[1]).toBe(caret[0]);
  expect(Math.abs(caret[0] - FOX.indexOf('fox') - 1)).toBeLessThanOrEqual(1);

  await selectRange(page, FOX.indexOf('fox'), 3);
  await page.keyboard.type('cat');
  await expect(editor).toHaveText(FOX.replace('fox', 'cat'));
  // The settled preview: the engine's dry run of the edit, rendered over the line.
  await expect(page.locator('[data-paragraph-editor]')).toHaveAttribute('data-preview', '', {
    timeout: 20_000,
  });
  await expect(page.getByTestId('paragraph-error')).toHaveCount(0);
  if (capture) {
    await page.screenshot({ path: fileURLToPath(new URL('m4-text-edit-1440.png', screenshots)) });
  }
  // Leaving commits the change as one history entry (decision §13 #9).
  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0, { timeout: 20_000 });
  await expect(historyRow(page, /^Paragraph edited \(same font/)).toHaveCount(1, {
    timeout: 20_000,
  });
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

test('keyboard: the focus returns to the paragraph after Esc and after a commit', async ({
  page,
}) => {
  await openFonts(page);
  await page.locator('[data-read-viewport]').focus();
  await page.keyboard.press('e');
  // With Edit text armed the keyboard works by paragraph (craft spec §9): each line of the
  // fixture is one, so its target stands for its run.
  const first = paragraph(page, FOX).first();
  await expect(first).toBeAttached({ timeout: 20_000 });
  const lineBox = await first.boundingBox();
  if (!lineBox) throw new Error('line not laid out');
  await first.focus();
  await page.keyboard.press('Enter');
  const editor = paragraphEditor(page);
  await expect(editor).toBeFocused({ timeout: 20_000 });

  // Esc with no change: nothing is applied, back on the same target; the tool stays armed.
  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);
  await expect(first).toBeFocused();
  await expect(historyRow(page, /^Paragraph edited/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Edit text' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // In the paragraph editor Enter inserts a line break (spec §4.2) and keeps the editor open.
  await page.keyboard.press('Enter');
  await expect(editor).toBeFocused({ timeout: 20_000 });
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  await expect(editor).toBeFocused();
  await expect(editor).toHaveText(`${FOX}\n`);
  await page.keyboard.press('Backspace');
  for (let i = 0; i < 3; i++) await page.keyboard.press('Backspace');
  await page.keyboard.type('cat');
  await expect(editor).toHaveText(FOX.replace('dog', 'cat'));

  // Esc commits; the line is new runs and a new paragraph, the focus goes to its target.
  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0, { timeout: 20_000 });
  await expect(historyRow(page, /^Paragraph edited/)).toHaveCount(1, { timeout: 20_000 });
  const focused = page.locator('[data-text-edit-layer="0"] [data-text-paragraph]:focus');
  await expect(focused).toHaveAttribute('aria-label', /^Edit paragraph “The quick brown fox/, {
    timeout: 20_000,
  });
  const focusedBox = await focused.boundingBox();
  expect(Math.abs((focusedBox?.y ?? 0) - lineBox.y)).toBeLessThan(2);
  expect(Math.abs((focusedBox?.x ?? 0) - lineBox.x)).toBeLessThan(2);
  // The keyboard continues from there.
  await page.keyboard.press('Enter');
  await expect(editor).toBeFocused({ timeout: 20_000 });
  await expect(editor).toHaveText(FOX.replace('dog', 'cat'));
});

test('a character the Identity-H subset lacks shows the honesty line naming the substitute', async ({
  page,
}) => {
  await openFonts(page);
  await page.locator('[data-read-viewport]').focus();
  await page.keyboard.press('e');
  const lines = page.locator(`[data-text-edit-layer="0"] [data-text-run="${FOX}"]`);
  await expect(lines.nth(1)).toBeVisible({ timeout: 20_000 });
  const count = await lines.count();
  await clickWord(page, 1, 'fox');
  const editor = paragraphEditor(page);
  await expect(editor).toBeFocused({ timeout: 20_000 });
  await expect(page.getByTestId('paragraph-honesty')).toHaveCount(0);

  // "F" is not in the subset (only the glyphs of the sentence are): set in the bundled face.
  await selectRange(page, FOX.indexOf('fox'), 1);
  await page.keyboard.type('F');
  await expect(editor).toHaveText(FOX.replace('fox', 'Fox'));
  await expect(page.getByTestId('paragraph-honesty')).toHaveText(
    '‘F’ uses Inter because the original font in this file does not include it.',
  );
  await expect(page.locator('[data-paragraph-editor]')).toHaveAttribute('data-preview', '', {
    timeout: 20_000,
  });
  if (capture) {
    await page.screenshot({
      path: fileURLToPath(new URL('m4-text-edit-substituted-1440.png', screenshots)),
    });
  }
  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0, { timeout: 20_000 });
  await expect(historyRow(page, 'Paragraph edited (some characters in Inter)')).toBeVisible({
    timeout: 20_000,
  });

  // Undo reopens the source and replays nothing: the line reads "fox" again.
  await expect(lines).toHaveCount(count - 1);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(lines).toHaveCount(count);
  await expect(page.locator('[data-text-edit-layer="0"] [data-text-run*="Fox"]')).toHaveCount(0);
});

test('rotated page: the editor turns with the line; an upright line is edited in place', async ({
  page,
}) => {
  const upright = 'Page 1 rotate 90 line 2 reads upright';
  const sideways = 'Page 1 rotate 90 line 1: The quick brown fox jumps over the lazy dog';
  await openFixtures(page, ['text-edit-rotated.pdf']);
  await showInspector(page);
  await page.locator('[data-read-viewport]').focus();
  await page.keyboard.press('e');
  const runs = page.locator('[data-text-edit-layer="0"]');
  const editor = paragraphEditor(page);
  const overlay = page.locator('[data-paragraph-editor]');

  // Horizontal in user space on a /Rotate 90 page: it runs top to bottom on screen, and the
  // editor's canvas turns with it.
  await expect(runs.locator(`[data-text-run="${sideways}"]`)).toBeVisible({ timeout: 20_000 });
  await runs.locator(`[data-text-run="${sideways}"]`).click();
  await expect(editor).toBeFocused({ timeout: 20_000 });
  await expect(editor).toHaveText(sideways);
  await expect(overlay).toHaveAttribute('data-angle', '90');
  if (capture) {
    await page.screenshot({
      path: fileURLToPath(new URL('m4-text-edit-rotated-1440.png', screenshots)),
    });
  }
  // Esc without a change: the editor closes, nothing is applied, the tool stays armed.
  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);
  await expect(historyRow(page, /^Paragraph edited/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Edit text' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // Counter-rotated by its text matrix, the second line reads upright: no rotation.
  await runs.locator(`[data-text-run="${upright}"]`).click();
  await expect(editor).toBeFocused({ timeout: 20_000 });
  await expect(overlay).toHaveAttribute('data-angle', '0');
  await selectRange(page, upright.indexOf('reads'), 'reads'.length);
  await page.keyboard.type('looks');
  await expect(editor).toHaveText(upright.replace('reads', 'looks'));
  await expect(overlay).toHaveAttribute('data-preview', '', { timeout: 20_000 });
  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0, { timeout: 20_000 });
  await expect(historyRow(page, /^Paragraph edited/)).toHaveCount(1, { timeout: 20_000 });
  await expect(runs.locator('[data-text-run*="looks"]')).toBeAttached();
});

test('a paragraph that refuses paragraph mode opens the line editor instead', async ({ page }) => {
  // The text of a form XObject stays tier 1 per line (craft spec §4.9): paragraph mode is
  // refused, the clicked run opens in the line editor with the reason announced.
  const inForm = 'Outer form: SECRET-7731 stays';
  await openFixtures(page, ['redact-form-xobject.pdf']);
  await showInspector(page);
  await page.locator('[data-read-viewport]').focus();
  await page.keyboard.press('e');
  const run = page.locator(`[data-text-edit-layer="0"] [data-text-run="${inForm}"]`);
  await expect(run).toBeVisible({ timeout: 20_000 });
  await run.click();

  const lineEditor = page.getByRole('textbox', { name: 'Line text' });
  await expect(lineEditor).toBeFocused({ timeout: 20_000 });
  await expect(lineEditor).toHaveValue(inForm);
  await expect(paragraphEditor(page)).toHaveCount(0);
  await expect(
    page.getByRole('status').filter({ hasText: 'Paragraph editing is not available here' }),
  ).toHaveText(/Paragraph editing is not available here: the text is inside a form/);
  await page.keyboard.press('Escape');
  await expect(lineEditor).toHaveCount(0);
  // The focus goes to the paragraph's keyboard target (the run is a pointer target only);
  // Enter there reaches the same line editor, as the keyboard's way in.
  const target = page.locator('[data-text-edit-layer="0"] [data-text-paragraph]:focus');
  await expect(target).toHaveAttribute('aria-label', new RegExp(inForm.slice(0, 12)));
  await page.keyboard.press('Enter');
  await expect(lineEditor).toBeFocused({ timeout: 20_000 });
  await page.keyboard.press('Escape');
  await expect(target).toHaveCount(1);
});
