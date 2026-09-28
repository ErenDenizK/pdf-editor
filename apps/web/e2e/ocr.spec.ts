/**
 * OCR end to end (spec recognize-and-compare §1.5, ADR-0012 §7) on scan-text.pdf, two scanned
 * pages without text (test/fixtures/manifest.json): the dialog proposes both pages and
 * English, the run recognises them with tesseract.js served from our origin, one history
 * entry records it, the right panel's OCR section shows each page's quality and J / K rings a
 * low-confidence word, Find finds words of the manifest, and the export's summary names the
 * run. The exported file carries the words in its invisible layer (read back with pdf-lib);
 * undo removes the text and redo brings it back from the stored words.
 * Throughout, the request log shows no request to any other origin.
 */
import { readFile } from 'node:fs/promises';

import { decodePDFRawStream, PDFDict, PDFDocument, PDFName, PDFRawStream } from '@cantoo/pdf-lib';
import { expect, type Page, test } from '@playwright/test';

import { openFixtures, useFileInputPicker } from './helpers';

test.skip(({ browserName }) => browserName !== 'chromium', 'OCR is verified on Chromium');
test.use({ viewport: { width: 1440, height: 900 } });

const mod = (page: Page) =>
  page.evaluate(() => (/mac/i.test(navigator.platform) ? 'Meta' : 'Control'));

/** The words of every `/PdfEditorOCR` layer of a PDF (UTF-16BE hex strings shown with Tj). */
async function layerWords(bytes: Uint8Array): Promise<string[][]> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  return pdf.getPages().map((page) => {
    const words: string[] = [];
    const xobjects = page.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict);
    for (const [, ref] of xobjects?.entries() ?? []) {
      const stream = pdf.context.lookup(ref);
      if (!(stream instanceof PDFRawStream)) continue;
      if (!stream.dict.has(PDFName.of('PdfEditorOCR'))) continue;
      const content = new TextDecoder('latin1').decode(decodePDFRawStream(stream).decode());
      for (const match of content.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) {
        const hex = match[1] ?? '';
        let text = '';
        for (let i = 0; i + 4 <= hex.length; i += 4) {
          text += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
        }
        words.push(text.trim());
      }
    }
    return words;
  });
}

test('recognise scan-text.pdf offline-first: panel, search, export, no foreign request', async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(240_000);
  const origin = new URL(baseURL ?? 'http://localhost').origin;
  const foreign: string[] = [];
  const ocrFiles: string[] = [];
  context.on('request', (request) => {
    const url = new URL(request.url());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    if (url.origin !== origin) foreign.push(url.href);
    if (url.pathname.includes('/ocr/')) ocrFiles.push(url.pathname);
  });
  await page.addInitScript({
    content:
      "Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });",
  });
  await useFileInputPicker(page);
  await page.goto('./?lang=en');
  await openFixtures(page, ['scan-text.pdf']);
  await expect(page.locator('canvas[data-state="rendered"]').first()).toBeAttached({
    timeout: 20_000,
  });
  // Nothing OCR-related is fetched before the dialog is used (spec §1.1).
  expect(ocrFiles).toEqual([]);

  // 1. Document menu → Recognize text (OCR)…
  await page.getByTestId('document-menu').click();
  await page.getByRole('menuitem', { name: 'Recognize text (OCR)…' }).click();
  const dialog = page.getByTestId('ocr-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('radio', { name: 'Pages without text (2 pages)' })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: /English/ })).toBeChecked();
  await expect(dialog.getByTestId('ocr-languages-key')).toContainText('eng');
  await expect(dialog.getByTestId('ocr-honesty')).toContainText('may contain errors');
  await dialog.getByRole('button', { name: 'Recognize 2 pages' }).click();

  // 2. The run: progress in the dialog and the status bar; then the result.
  await expect(
    dialog.getByTestId('ocr-progress').or(dialog.getByTestId('ocr-result')),
  ).toBeVisible();
  const result = dialog.getByTestId('ocr-result');
  await expect(result).toBeVisible({ timeout: 180_000 });
  await expect(result).toContainText('Recognize text: 2 pages, eng');
  await expect(page.getByTestId('status-ocr')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Show results' }).click();
  await expect(dialog).toHaveCount(0);

  // One history entry for the run.
  await expect(
    page
      .getByRole('list', { name: /history/i })
      .getByRole('button', { name: /Recognize text: 2 pages, eng/ }),
  ).toBeVisible();

  // 3. The OCR section: page 1's quality, languages and resolution; pages by quality.
  const section = page.getByTestId('ocr-section');
  await expect(section).toBeVisible();
  await expect(section.getByTestId('ocr-quality')).toHaveText(/^(Good|Review|Poor) · \d+%$/);
  await expect(section).toContainText('English');
  await expect(section).toContainText('dpi');
  await expect(
    section.getByRole('list', { name: 'Pages by quality' }).getByRole('button'),
  ).toHaveCount(2);
  // Page 2 (skewed, with dust) from the document list: J rings its low-confidence word on the
  // page (a 1px ring; the page is never tinted) and marks the row current.
  await section
    .getByRole('list', { name: 'Pages by quality' })
    .getByRole('button', { name: /^Page 2/ })
    .click();
  await expect(section.getByRole('heading', { name: 'Page 2' })).toBeVisible();
  const lowWords = section.getByTestId('ocr-low-words');
  await expect(lowWords.getByRole('button')).not.toHaveCount(0);
  await page.keyboard.press('j');
  await expect(page.getByTestId('ocr-focus-ring')).toHaveCount(1);
  await expect(lowWords.locator('button[aria-current="true"]')).toHaveCount(1);
  await expect(page.locator('[data-page-index="1"]').getByTestId('ocr-focus-ring')).toBeVisible();

  // 4. Find: words of the manifest are found in the recognised text.
  await page.keyboard.press(`${await mod(page)}+f`);
  const field = page.getByRole('searchbox', { name: 'Find in document' });
  await field.fill('quick');
  await expect(page.getByTestId('status-search')).toContainText(/1 of [12]/, { timeout: 20_000 });
  await field.fill('recognition');
  await expect(page.getByTestId('status-search')).toContainText('1 of', { timeout: 20_000 });
  await field.press('Escape');

  // 5. Export: the summary names the run; the file's layer holds the words.
  await page.getByRole('button', { name: 'Export document' }).click();
  const exportDialog = page.getByTestId('export-dialog');
  await expect(exportDialog).toBeVisible();
  await exportDialog.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(exportDialog.getByTestId('export-verified')).toBeVisible({ timeout: 60_000 });
  await expect(exportDialog.getByRole('list', { name: 'What changed on export' })).toContainText(
    'Recognized text (OCR) on 2 pages: English',
  );
  const downloadPromise = page.waitForEvent('download');
  await exportDialog.getByRole('button', { name: 'Download' }).click();
  const bytes = await readFile(await (await downloadPromise).path());
  const words = await layerWords(bytes);
  expect(words).toHaveLength(2);
  const first = words[0] ?? [];
  for (const word of ['Scanned', 'Document', 'quick', 'brown', 'fox', '2024', '7731']) {
    expect(first).toContain(word);
  }

  await page.keyboard.press('Escape');
  await expect(exportDialog).toHaveCount(0);

  // 6. Undo reopens the original and replays the rest: no recognised text, no section; redo
  // writes the stored words again without recognising anew.
  await page.keyboard.press(`${await mod(page)}+z`);
  await expect(section).toHaveCount(0);
  await page.keyboard.press(`${await mod(page)}+f`);
  await field.fill('quick');
  await expect(page.getByTestId('search-status')).toHaveText('No results', { timeout: 20_000 });
  await field.press('Escape');
  await page.keyboard.press(`${await mod(page)}+Shift+z`);
  await expect(section.getByTestId('ocr-quality')).toBeVisible();
  await page.keyboard.press(`${await mod(page)}+f`);
  await field.fill('quick');
  await expect(page.getByTestId('status-search')).toContainText('1 of', { timeout: 20_000 });
  await field.press('Escape');

  // The engine and the pack came from our origin; nothing left it.
  expect(ocrFiles.some((p) => p.endsWith('/ocr/lang/eng.traineddata.gz'))).toBe(true);
  expect(ocrFiles.some((p) => /\/ocr\/tesseract-[\d.]+\/worker\.min\.js$/.test(p))).toBe(true);
  expect(foreign).toEqual([]);
});

test('after "Keep available offline", OCR works with the network off', async ({
  page,
  context,
}) => {
  test.setTimeout(240_000);
  await useFileInputPicker(page);
  await page.goto('./?lang=en');
  await expect(page.getByTestId('app-shell')).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null), {
      timeout: 30_000,
    })
    .toBe(true);
  // The PDFium wasm is warmed into its runtime cache once the shell is offline-ready.
  await expect
    .poll(
      () => page.evaluate(async () => (await (await caches.open('pdf-editor-wasm')).keys()).length),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);

  // Palette → OCR languages…; keep English available offline.
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByRole('combobox', { name: 'Search commands' }).fill('OCR languages');
  await expect(page.getByRole('option', { name: /OCR languages…/, selected: true })).toBeVisible();
  await page.keyboard.press('Enter');
  const manager = page.getByTestId('ocr-languages');
  await expect(manager).toBeVisible();
  await expect(manager.getByTestId('ocr-pack')).toHaveCount(9);
  const keep = manager.getByRole('switch', { name: 'Keep English available offline' });
  await expect(keep).not.toBeChecked();
  // The switch follows the device state: it turns on once the pack is cached.
  await keep.click();
  await expect(keep).toBeChecked({ timeout: 60_000 });
  await expect(manager.getByTestId('ocr-pack').first()).toContainText('On this device');
  await page.keyboard.press('Escape');

  // Offline: reload, open the scan, recognise the current page.
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByTestId('app-shell')).toBeVisible();
  await openFixtures(page, ['scan-text.pdf']);
  await expect(page.locator('main canvas[data-state="rendered"]').first()).toBeVisible({
    timeout: 20_000,
  });
  await page.getByTestId('document-menu').click();
  await page.getByRole('menuitem', { name: 'Recognize text (OCR)…' }).click();
  const dialog = page.getByTestId('ocr-dialog');
  await expect(dialog.getByRole('checkbox', { name: /English/ })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: /English/ }).locator('..')).toContainText(
    'On this device',
  );
  await dialog.getByRole('radio', { name: 'Current page (1)' }).check();
  await dialog.getByRole('button', { name: 'Recognize 1 page' }).click();
  await expect(dialog.getByTestId('ocr-result')).toContainText('Recognize text: 1 page, eng', {
    timeout: 180_000,
  });
  await dialog.getByRole('button', { name: 'Show results' }).click();
  await page.keyboard.press('ControlOrMeta+f');
  await page.getByRole('searchbox', { name: 'Find in document' }).fill('lazy');
  await expect(page.getByTestId('status-search')).toContainText('1 of', { timeout: 20_000 });
});
