/**
 * Batch recipes end to end (spec recognize-and-compare §5): open "Batch…" from the command
 * palette with no document open, choose the built-in "Number pages", add two corpus files,
 * run, download the ZIP, and check with pdf-lib that it holds two PDFs whose first page
 * carries the page-number furniture (a Form XObject drawing with the embedded Inter
 * subset). No tab opens along the way.
 */
import { readFile } from 'node:fs/promises';

import { PDFDict, PDFDocument, PDFName, PDFStream } from '@cantoo/pdf-lib';
import { expect, test } from '@playwright/test';

import { fixturePath, useFileInputPicker } from './helpers';

test.skip(({ browserName }) => browserName !== 'chromium', 'Download flow is verified on Chromium');

/** The entries of a ZIP whose entries are stored (the batch writes no compression). */
function storedEntries(zip: Buffer): { name: string; data: Buffer }[] {
  const entries: { name: string; data: Buffer }[] = [];
  let offset = 0;
  while (offset + 30 <= zip.length && zip.readUInt32LE(offset) === 0x04034b50) {
    expect(zip.readUInt16LE(offset + 8)).toBe(0); // stored
    const size = zip.readUInt32LE(offset + 18);
    const nameLength = zip.readUInt16LE(offset + 26);
    const extraLength = zip.readUInt16LE(offset + 28);
    const name = zip.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const start = offset + 30 + nameLength + extraLength;
    entries.push({ name, data: zip.subarray(start, start + size) });
    offset = start + size;
  }
  return entries;
}

/** Fonts of the Form XObjects (page furniture) drawn on the page. */
function furnitureFonts(pdf: PDFDocument, pageIndex: number): string[] {
  const page = pdf.getPage(pageIndex);
  const xobjects = page.node.Resources()?.lookup(PDFName.of('XObject'), PDFDict);
  const fonts: string[] = [];
  for (const key of xobjects?.keys() ?? []) {
    if (!key.asString().startsWith('/Fm')) continue;
    const form = xobjects?.lookup(key, PDFStream);
    const font = form?.dict
      .lookup(PDFName.of('Resources'), PDFDict)
      .lookup(PDFName.of('Font'), PDFDict);
    for (const name of font?.keys() ?? []) {
      fonts.push(font?.lookup(name, PDFDict).get(PDFName.of('BaseFont'))?.toString() ?? '');
    }
  }
  return fonts;
}

test('runs "Number pages" over two files and downloads a ZIP of numbered PDFs', async ({
  page,
}) => {
  await page.addInitScript({
    content:
      "Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });",
  });
  await useFileInputPicker(page);
  await page.goto('./?lang=en');
  await expect(page.getByRole('heading', { name: 'Drop PDFs to start' })).toBeVisible();

  await page.keyboard.press('ControlOrMeta+k');
  await page.getByRole('combobox', { name: 'Search commands' }).fill('batch');
  await expect(page.getByRole('option', { name: /Batch…/, selected: true })).toBeVisible();
  await page.keyboard.press('Enter');
  const dialog = page.getByTestId('batch-dialog');
  await expect(dialog).toBeVisible();

  await dialog.getByRole('button', { name: /^Number pages/ }).click();
  await expect(dialog.getByRole('button', { name: /^Number pages/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(dialog.getByTestId('batch-recipe-steps')).toContainText('Page numbers');

  const chooser = page.waitForEvent('filechooser');
  await dialog.getByRole('button', { name: 'Add files…' }).click();
  await (await chooser).setFiles([fixturePath('simple-text.pdf'), fixturePath('forms-a.pdf')]);
  await expect(dialog.getByTestId('batch-files').getByRole('listitem')).toHaveCount(2);
  await expect(dialog.getByTestId('batch-plan')).toContainText('2 files');

  await dialog.getByTestId('batch-run').click();
  await expect(dialog.getByTestId('batch-run-status')).toContainText('Finished: 2 done', {
    timeout: 60_000,
  });
  await expect(dialog.getByTestId('batch-file-row')).toHaveCount(2);

  const downloadPromise = page.waitForEvent('download');
  await dialog.getByTestId('batch-download-zip').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('Number pages.zip');
  const zip = await readFile(await download.path());

  const entries = storedEntries(zip);
  expect(entries.map((e) => e.name)).toEqual([
    'simple-text-Number pages.pdf',
    'forms-a-Number pages.pdf',
  ]);
  for (const [entry, pages] of [
    [entries[0], 3],
    [entries[1], 2],
  ] as const) {
    const pdf = await PDFDocument.load(entry?.data ?? Buffer.alloc(0), { updateMetadata: false });
    expect(pdf.getPageCount()).toBe(pages);
    // Page 1 carries the page number: furniture drawn in the bundled Inter face.
    const fonts = furnitureFonts(pdf, 0);
    expect(fonts).toHaveLength(1);
    expect(fonts[0]).toMatch(/^\/Inter-Regular/);
  }

  // Files never became tabs.
  await dialog.getByRole('button', { name: 'Close' }).first().click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Drop PDFs to start' })).toBeVisible();
});
