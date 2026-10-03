/**
 * Redaction marks end to end (redaction spec §1.1): on `redact-text-runs.pdf`
 * (test/fixtures/README.md: SECRET-7731 on lines 1–3, innocuous line 4), select the token
 * and press X, drag an area with the Redact tool, check the Review tab's Marks lists both
 * with the text under them, export, and re-open the export: the /Redact annotations are
 * still there (marks survive save and are not applied). A second test marks every search
 * match and reviews them with J / K.
 *
 * Applying (spec §1.2, §5.3): marks by selection, search and area are applied through the
 * confirmation dialog, the result sheet lists the self-check, the export's summary shows
 * the check on the final file, and the export re-opened in the app has no trace of the
 * token. Keeping attachments on `redact-metadata.pdf` is stopped by the self-check (the
 * attachment still holds the token), and nothing changes until attachments are removed.
 * While applying, Esc and a click on the backdrop do not close the dialog: the blocked
 * outcome is shown there and announced in the live region; the mark checkboxes have
 * unique accessible names.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { type PDFArray, type PDFDict, PDFDocument, PDFName, type PDFNumber } from '@cantoo/pdf-lib';
import { expect, type Locator, type Page, test } from '@playwright/test';

import { enterEdit, openFixtures, showInspector, useFileInputPicker } from './helpers';

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

/** The navigator's Review tab on its Marks filter (experience-redesign §4.1). */
async function showMarks(page: Page): Promise<Locator> {
  const review = page.getByRole('tab', { name: /^Review/ });
  if ((await review.getAttribute('aria-selected')) !== 'true') await review.click();
  await page.getByRole('radio', { name: /^Marks/ }).click();
  const panel = page.locator('[data-review-panel]');
  await expect(panel).toHaveAttribute('data-filter', 'redactions');
  return panel;
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
  await enterEdit(page);
  await showInspector(page);
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
  // A new mark never selects itself: no contextual bar over the line above (spec §5.2).
  await expect(page.getByTestId('annotation-bar')).toHaveCount(0);

  // 2. The Redact tool: drag an area where there is no text.
  await page.keyboard.press('Escape');
  await page.keyboard.press('x');
  const redactLayer = page.locator('[data-redaction-layer="0"]');
  await expect(redactLayer).toHaveAttribute('data-active', 'true');
  const box = await redactLayer.boundingBox();
  if (!box) throw new Error('page not rendered');
  // Clear of the floating tool bar at the bottom of the stage.
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.55);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.65, { steps: 8 });
  await page.mouse.up();
  await expect(layer(page).locator('[data-annotation-kind="redact"]')).toHaveCount(2);
  await expect(page.getByTestId('annotation-bar')).toHaveCount(0);
  await page.keyboard.press('Escape');

  // 3. The Review tab's Marks filter lists both, with the text under each.
  const panel = await showMarks(page);
  await expect(panel.getByRole('note')).toContainText('Marks are only marks');
  await expect(panel.getByTestId('redaction-summary')).toHaveText('2 marks · 2 selected');
  await expect(panel.getByTestId('redaction-snippet')).toHaveText([TOKEN, 'Area without text']);
  // Ticked marks: "Apply redactions" is available.
  await expect(panel.getByTestId('redaction-apply')).not.toHaveAttribute('aria-disabled');
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
  await enterEdit(page);
  await showInspector(page);
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

  const panel = await showMarks(page);
  await expect(panel.getByTestId('redaction-snippet')).toHaveText([TOKEN, TOKEN, TOKEN]);
  // Three marks with the same text: each checkbox still has its own name.
  for (const n of [1, 2, 3]) {
    await expect(
      panel.getByRole('checkbox', {
        name: `Include mark ${n} on page 1 (“${TOKEN}”) when applying`,
        exact: true,
      }),
    ).toHaveCount(1);
  }
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

async function exportAndDownload(page: Page): Promise<{ bytes: Buffer; summary: string[] }> {
  await page.getByRole('button', { name: 'Export document' }).click();
  const exportDialog = page.getByTestId('export-dialog');
  await expect(exportDialog).toBeVisible();
  await exportDialog.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(exportDialog.getByTestId('export-verified')).toBeVisible({ timeout: 60_000 });
  const summary = await exportDialog
    .getByRole('list', { name: 'What changed on export' })
    .locator(':scope > li')
    .allTextContents();
  const downloadPromise = page.waitForEvent('download');
  await exportDialog.getByRole('button', { name: 'Download' }).click();
  const bytes = await readFile(await (await downloadPromise).path());
  await page.keyboard.press('Escape');
  return { bytes, summary };
}

test('apply marks made by selection, search and area; export; the re-opened export has no token', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.addInitScript({
    content:
      "Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });",
  });
  await useFileInputPicker(page);
  await page.goto('./?lang=en');
  await openFixtures(page, ['redact-text-runs.pdf']);
  await enterEdit(page);
  await showInspector(page);
  await expect(page.locator('canvas[data-state="rendered"]').first()).toBeAttached({
    timeout: 20_000,
  });

  // 1. By selection (line 1).
  await selectText(page, TOKEN);
  await page.keyboard.press('x');
  await expect(layer(page).locator('[data-annotation-kind="redact"]')).toHaveCount(1);

  // 2. By search: every match (lines 2 and 3 are new; line 1 is already marked).
  await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+f');
  await page.getByRole('searchbox', { name: 'Find in document' }).fill(TOKEN);
  await expect(page.getByTestId('search-hit')).toHaveCount(3);
  await page.getByTestId('search-mark-all').click();
  await expect(layer(page).locator('[data-annotation-kind="redact"]')).toHaveCount(3);

  // 3. By area, below the text.
  await page.locator('[data-read-viewport]').focus();
  await page.keyboard.press('x');
  const redactLayer = page.locator('[data-redaction-layer="0"]');
  await expect(redactLayer).toHaveAttribute('data-active', 'true');
  const box = await redactLayer.boundingBox();
  if (!box) throw new Error('page not rendered');
  // Clear of the floating tool bar at the bottom of the stage.
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.55);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.65, { steps: 8 });
  await page.mouse.up();
  await expect(layer(page).locator('[data-annotation-kind="redact"]')).toHaveCount(4);
  await page.keyboard.press('Escape');

  // 4. Apply from the Marks filter: the dialog says what happens, then the result.
  const panel = await showMarks(page);
  await expect(panel.getByTestId('redaction-summary')).toHaveText('4 marks · 4 selected');
  await panel.getByTestId('redaction-apply').click();
  const dialog = page.getByTestId('redaction-apply-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('4 ticked marks become permanent removals.');
  await expect(dialog.getByRole('note')).toContainText('cannot be undone');
  await expect(dialog.getByRole('checkbox', { name: /Keep attachments/ })).not.toBeChecked();
  await dialog.getByRole('textbox', { name: 'Overlay text (optional)' }).fill('REDACTED');
  await dialog.getByTestId('redaction-apply-confirm').click();
  const result = dialog.getByTestId('redaction-result');
  await expect(result).toBeVisible({ timeout: 30_000 });
  await expect(result.getByTestId('redaction-result-areas')).toHaveText('4 areas on 1 page');
  await expect(result.getByTestId('redaction-checks-summary')).toHaveText(
    'Self-check: 9 of 9 checks passed',
  );
  await expect(result.locator('[data-testid="redaction-check"][data-passed="true"]')).toHaveCount(
    9,
  );
  if (capture) {
    await page.screenshot({
      path: fileURLToPath(new URL('m4-redaction-applied-1440.png', screenshots)),
    });
  }
  await dialog.getByRole('button', { name: 'Close' }).last().click();
  await expect(dialog).toBeHidden();
  await expect(historyRow(page, 'Redactions applied (4 areas)')).toBeVisible();
  await expect(layer(page).locator('[data-annotation-kind="redact"]')).toHaveCount(0);
  await expect(panel.getByTestId('redaction-summary')).toHaveCount(0);
  await expect(page.getByTestId('text-layer').first()).not.toContainText(TOKEN);

  // 5. Export: the summary reports the self-check on the final file.
  const { bytes, summary } = await exportAndDownload(page);
  expect(summary[0]).toContain('Redaction: 4 areas on 1 page, self-check passed (9 checks).');
  expect(bytes.toString('latin1')).not.toContain(TOKEN);
  expect(await redactAnnotations(bytes)).toHaveLength(0);

  // 6. Re-open the export in the app and search for the token: nothing.
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open files' }).first().click();
  await (await chooser).setFiles({
    name: 'redacted.pdf',
    mimeType: 'application/pdf',
    buffer: bytes,
  });
  await expect(page.getByRole('tab', { name: 'redacted', selected: true })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+f');
  const field = page.getByRole('searchbox', { name: 'Find in document' });
  // The rest of the text is there (the search runs on the re-opened file)…
  await field.fill('quick brown fox');
  await expect(page.getByTestId('search-hit')).toHaveCount(1, { timeout: 20_000 });
  // …and the token is not.
  await field.fill(TOKEN);
  await expect(page.getByTestId('search-status')).toHaveText('No results', { timeout: 20_000 });
  await expect(page.getByTestId('search-hit')).toHaveCount(0);
});

test('keeping attachments: the self-check sees the token in the attachment and nothing is applied', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.addInitScript({
    content:
      "Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });",
  });
  await useFileInputPicker(page);
  await page.goto('./?lang=en');
  await openFixtures(page, ['redact-metadata.pdf']);
  await enterEdit(page);
  await showInspector(page);
  await selectText(page, TOKEN);
  await page.keyboard.press('x');
  await expect(layer(page).locator('[data-annotation-kind="redact"]')).toHaveCount(1);
  await page.keyboard.press('Escape');

  const panel = await showMarks(page);
  await panel.getByTestId('redaction-apply').click();
  const dialog = page.getByTestId('redaction-apply-dialog');
  await dialog.getByRole('checkbox', { name: /Keep attachments/ }).check();
  await dialog.getByTestId('redaction-apply-confirm').click();

  // Blocked by the self-check: the kept attachment still holds the token.
  const blocked = dialog.getByTestId('redaction-blocked');
  await expect(blocked).toBeVisible({ timeout: 30_000 });
  await expect(blocked.getByRole('alert')).toHaveAttribute('data-stage', 'forensic');
  await expect(blocked.getByRole('alert')).toContainText('The document is unchanged.');
  await expect(blocked).toContainText('Kept attachments still contain the redacted text.');
  await expect(blocked.locator('[data-check="byte-grep"]')).toHaveAttribute('data-passed', 'false');
  await expect(blocked.locator('[data-check="object-strings"]')).toHaveAttribute(
    'data-passed',
    'false',
  );
  await expect(blocked.getByTestId('redaction-findings')).toContainText('Redacted text absent');
  // Nothing happened: the mark is still a mark, no history entry.
  await expect(layer(page).locator('[data-annotation-kind="redact"]')).toHaveCount(1);
  await expect(historyRow(page, /Redactions applied/)).toHaveCount(0);

  // Back: apply without keeping attachments. It passes, and so does the export.
  await dialog.getByRole('button', { name: 'Back' }).click();
  await dialog.getByRole('checkbox', { name: /Keep attachments/ }).uncheck();
  await dialog.getByTestId('redaction-apply-confirm').click();
  const result = dialog.getByTestId('redaction-result');
  await expect(result).toBeVisible({ timeout: 30_000 });
  await expect(result).toContainText('Attachments removed');
  await dialog.getByRole('button', { name: 'Close' }).last().click();
  await expect(historyRow(page, 'Redactions applied (1 area)')).toBeVisible();
  const { bytes, summary } = await exportAndDownload(page);
  expect(summary[0]).toContain('Redaction: 1 area on 1 page, self-check passed (9 checks).');
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  expect(pdf.catalog.lookup(PDFName.of('Names'))).toBeUndefined();
  expect(bytes.toString('latin1')).not.toContain(TOKEN);
});

test('Esc and the backdrop while applying: the dialog stays and the blocked outcome is shown and announced', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await useFileInputPicker(page);
  await page.goto('./?lang=en');
  await openFixtures(page, ['redact-metadata.pdf']);
  await enterEdit(page);
  await showInspector(page);
  await selectText(page, TOKEN);
  await page.keyboard.press('x');
  await expect(layer(page).locator('[data-annotation-kind="redact"]')).toHaveCount(1);
  await page.keyboard.press('Escape');
  const panel = await showMarks(page);
  // The mark's checkbox names the mark (its number on the page and the text under it).
  await expect(panel.getByRole('checkbox', { name: /Include mark 1 on page 1/ })).toBeVisible();
  await expect(panel.getByRole('checkbox', { name: new RegExp(TOKEN) })).toBeVisible();

  await panel.getByTestId('redaction-apply').click();
  const dialog = page.getByTestId('redaction-apply-dialog');
  await dialog.getByRole('checkbox', { name: /Keep attachments/ }).check();
  await dialog.getByTestId('redaction-apply-confirm').click();
  await expect(dialog.getByRole('status')).toContainText(/Removing content/);
  await expect(dialog.getByRole('button', { name: 'Close' })).toBeDisabled();
  // Neither Esc nor a click outside the dialog closes it while it works.
  await page.keyboard.press('Escape');
  await page.mouse.click(10, 450);
  await expect(dialog).toBeVisible();

  // Blocked (the kept attachment holds the token): shown in the dialog and announced.
  const blocked = dialog.getByTestId('redaction-blocked');
  await expect(blocked).toBeVisible({ timeout: 30_000 });
  await expect(blocked.getByRole('alert')).toHaveAttribute('data-stage', 'forensic');
  const announced =
    'The self-check found redacted content in the result, so nothing was applied. The document is unchanged.';
  await expect(
    page.locator('[role="status"][aria-live="polite"]').filter({ hasText: announced }),
  ).toHaveCount(1);
  await expect(historyRow(page, /Redactions applied/)).toHaveCount(0);

  // Once finished, Esc closes it; opened again, the form starts afresh.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await panel.getByTestId('redaction-apply').click();
  await expect(dialog.getByTestId('redaction-apply-confirm')).toBeVisible();
  await expect(dialog.getByTestId('redaction-blocked')).toHaveCount(0);
});
