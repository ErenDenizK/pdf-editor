/**
 * Redaction marks end to end (redaction spec §1.1): on `redact-text-runs.pdf`
 * (test/fixtures/README.md: SECRET-7731 on lines 1–3, innocuous line 4), select the token
 * and press X, drag an area with the Redact tool, check the Redactions panel lists both
 * with the text under them, export, and re-open the export: the /Redact annotations are
 * still there (marks survive save and are not applied). A second test marks every search
 * match and reviews them with J / K.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { type PDFArray, type PDFDict, PDFDocument, PDFName, type PDFNumber } from '@cantoo/pdf-lib';
import { expect, type Page, test } from '@playwright/test';

import { openFixtures, useFileInputPicker } from './helpers';

test.skip(({ browserName }) => browserName !== 'chromium', 'Covered in Chromium');
test.use({ viewport: { width: 1440, height: 900 } });

const TOKEN = 'SECRET-7731';
const screenshots = new URL('../../../docs/design/screenshots/', import.meta.url);
const capture = Boolean(process.env.CAPTURE_SCREENSHOTS);

function layer(page: Page, index = 0) {
  return page.locator(`[data-annotation-layer="${index}"]`);
}

function historyRow(page: Page, label: string | RegExp) {
  return page.getByRole('list', { name: /history/i }).getByRole('button', { name: label });
}

/** Selects the first occurrence of `text` in the page's text layer with a DOM range. */
async function selectText(page: Page, text: string): Promise<void> {
  const textLayer = page.getByTestId('text-layer').first();
  await expect(textLayer.getByText(text).first()).toBeAttached({ timeout: 20_000 });
  await textLayer.evaluate((root, needle) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent?.indexOf(needle) ?? -1;
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return;
    }
    throw new Error(`"${needle}" is not in the text layer`);
  }, text);
}

async function redactAnnotations(bytes: Uint8Array): Promise<PDFDict[]> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  return (pdf.getPage(0).node.Annots()?.asArray() ?? [])
    .map((ref) => pdf.context.lookup(ref) as PDFDict)
    .filter((dict) => String(dict.get(PDFName.of('Subtype'))) === '/Redact');
}

function numbers(dict: PDFDict, key: string): number[] | undefined {
  return (dict.lookup(PDFName.of(key)) as PDFArray | undefined)
    ?.asArray()
    .map((n) => (n as PDFNumber).asNumber());
}

test('mark by selection and by area, list them, export and re-open with the marks', async ({
  page,
}) => {
  await page.addInitScript({
    content:
      "Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });",
  });
  await useFileInputPicker(page);
  await page.goto('./?lang=en');
  await openFixtures(page, ['redact-text-runs.pdf']);
  await expect(page.locator('canvas[data-state="rendered"]').first()).toBeAttached({
    timeout: 20_000,
  });

  // 1. Select the token on line 1 and press X: a mark, not the tool.
  await selectText(page, TOKEN);
  await page.keyboard.press('x');
  await expect(layer(page).locator('[data-annotation-kind="redact"]')).toHaveCount(1);
  await expect(page.locator('[data-redaction-layer="0"] [data-redaction-mark]')).toHaveCount(1);
  await expect(historyRow(page, 'Redaction mark on page 1')).toBeVisible();
  await expect(layer(page)).toHaveAttribute('data-tool', 'select');

  // 2. The Redact tool: drag an area where there is no text.
  await page.keyboard.press('Escape');
  await page.keyboard.press('x');
  const redactLayer = page.locator('[data-redaction-layer="0"]');
  await expect(redactLayer).toHaveAttribute('data-active', 'true');
  const box = await redactLayer.boundingBox();
  if (!box) throw new Error('page not rendered');
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.75);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.85, { steps: 8 });
  await page.mouse.up();
  await expect(layer(page).locator('[data-annotation-kind="redact"]')).toHaveCount(2);
  await page.keyboard.press('Escape');

  // 3. The Redactions panel lists both, with the text under each.
  await page.getByRole('tab', { name: 'Redactions' }).click();
  const panel = page.locator('[data-redactions-panel]');
  await expect(panel.getByRole('note')).toContainText('Marks are only marks');
  await expect(panel.getByTestId('redaction-summary')).toHaveText('2 marks · 2 selected');
  await expect(panel.getByTestId('redaction-snippet')).toHaveText([TOKEN, 'Area without text']);
  await expect(panel.getByTestId('redaction-apply')).toHaveAttribute('aria-disabled', 'true');
  if (capture) {
    await page.screenshot({
      path: fileURLToPath(new URL('m4-redaction-marks-1440.png', screenshots)),
    });
  }
  await panel
    .getByRole('checkbox', { name: /page 1/ })
    .first()
    .uncheck();
  await expect(panel.getByTestId('redaction-summary')).toHaveText('2 marks · 1 selected');

  // 4. Export: the marks are written as /Redact with /IC black; nothing is applied.
  await page.getByRole('button', { name: 'Export document' }).click();
  const exportDialog = page.getByTestId('export-dialog');
  await expect(exportDialog).toBeVisible();
  await exportDialog.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(exportDialog.getByTestId('export-verified')).toBeVisible({ timeout: 30_000 });
  const downloadPromise = page.waitForEvent('download');
  await exportDialog.getByRole('button', { name: 'Download' }).click();
  const bytes = await readFile(await (await downloadPromise).path());
  const marks = await redactAnnotations(bytes);
  expect(marks).toHaveLength(2);
  for (const mark of marks) {
    expect(numbers(mark, 'IC')).toEqual([0, 0, 0]);
    expect(numbers(mark, 'QuadPoints')?.length).toBe(8);
  }
  await page.keyboard.press('Escape');

  // 5. Re-open the export: the marks are still marks, listed in the panel.
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open files' }).first().click();
  await (await chooser).setFiles({
    name: 'marked.pdf',
    mimeType: 'application/pdf',
    buffer: bytes,
  });
  await expect(page.getByRole('tab', { name: 'marked' })).toBeVisible();
  // The panel reads each page's annotations from the engine, so the rows under "marked"
  // are the /Redact annotations of the re-opened file.
  await expect(panel.getByRole('heading', { name: 'marked' })).toBeVisible();
  await expect(panel.getByTestId('redaction-summary')).toHaveText('4 marks · 3 selected');
  // The re-opened marks cover the same text.
  await expect(panel.getByTestId('redaction-snippet')).toHaveText([
    TOKEN,
    'Area without text',
    TOKEN,
    'Area without text',
  ]);
});

test('mark every search match, then review the marks with J and K', async ({ page }) => {
  await useFileInputPicker(page);
  await page.goto('./?lang=en');
  await openFixtures(page, ['redact-text-runs.pdf']);
  await expect(
    page
      .getByTestId('text-layer')
      .first()
      .getByText(/Line 1/),
  ).toBeAttached({
    timeout: 20_000,
  });
  await page.keyboard.press('ControlOrMeta+f');
  const field = page.getByRole('searchbox', { name: 'Find in document' });
  await field.fill(TOKEN);
  await expect(page.getByTestId('search-hit')).toHaveCount(3);
  await page.getByTestId('search-mark-all').click();
  await expect(layer(page).locator('[data-annotation-kind="redact"]')).toHaveCount(3);
  await expect(historyRow(page, 'Mark 3 search matches for redaction')).toBeVisible();

  await page.getByRole('tab', { name: 'Redactions' }).click();
  const panel = page.locator('[data-redactions-panel]');
  await expect(panel.getByTestId('redaction-snippet')).toHaveText([TOKEN, TOKEN, TOKEN]);
  await page.locator('[data-read-viewport]').focus();
  await page.keyboard.press('j');
  await expect(panel.locator('li[aria-current="true"]')).toHaveCount(1);
  await expect(page.getByTestId('annotation-bar')).toBeVisible();
  await page.keyboard.press('j');
  await page.keyboard.press('k');
  await page.keyboard.press('k');
  // Wrapped from the first mark to the last.
  await expect(
    panel.locator('li[aria-current="true"]').getByTestId('redaction-snippet'),
  ).toHaveText(TOKEN);
  const rows = panel.locator('li');
  await expect(rows.nth(2)).toHaveAttribute('aria-current', 'true');

  // Delete from the panel.
  await rows.nth(2).getByRole('button', { name: 'Delete mark' }).click();
  await expect(layer(page).locator('[data-annotation-kind="redact"]')).toHaveCount(2);
});
