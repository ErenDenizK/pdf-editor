/**
 * PDF → Markdown end to end (spec recognize-and-compare §4): markdown-source.pdf through the
 * Document menu's "Export as Markdown / text…"; the downloaded ZIP's document.md equals the
 * manifest's golden, and the plain-text download reads in column order.
 */
import { readFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';

import { expect, type Page, test } from '@playwright/test';

import { fixturePath, openFixtures, useFileInputPicker } from './helpers';

test.skip(({ browserName }) => browserName !== 'chromium', 'Downloads are verified on Chromium');

interface Manifest {
  readonly fixtures: readonly {
    readonly file: string;
    readonly expect: { readonly markdown?: { readonly golden: string } };
  }[];
}

async function golden(): Promise<string> {
  const manifest = JSON.parse(await readFile(fixturePath('manifest.json'), 'utf8')) as Manifest;
  const value = manifest.fixtures.find((f) => f.file === 'markdown-source.pdf')?.expect.markdown;
  if (!value) throw new Error('no golden in the manifest');
  return value.golden;
}

/** The files of a ZIP (stored or deflated entries, read from the central directory). */
function unzip(zip: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extra = zip.readUInt16LE(at + 30);
    const comment = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + size);
    files.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    at += 46 + nameLength + extra + comment;
  }
  return files;
}

async function openDialog(page: Page) {
  await page.getByTestId('document-menu').click();
  await page.getByRole('menuitem', { name: 'Export as Markdown / text…' }).click();
  const dialog = page.getByTestId('convert-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('convert-preview')).toHaveAttribute('data-state', 'ready', {
    timeout: 30_000,
  });
  return dialog;
}

test('markdown-source.pdf exports the golden Markdown with its image', async ({ page }) => {
  await page.addInitScript({
    content:
      "Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });",
  });
  await useFileInputPicker(page);
  await page.goto('./');
  await expect(page.getByTestId('app-shell')).toBeVisible();
  await openFixtures(page, ['markdown-source.pdf']);

  const dialog = await openDialog(page);
  await expect(dialog.getByTestId('convert-preview')).toContainText('# Working with PDF Fixtures');
  await expect(dialog.getByTestId('convert-notes')).toContainText(
    'Reading order and headings are reconstructed',
  );
  await expect(dialog.getByTestId('convert-output')).toHaveText('Downloads markdown-source.zip');

  const downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('markdown-source.zip');
  const files = unzip(await readFile(await download.path()));
  expect([...files.keys()].sort()).toEqual(['document.md', 'images/p1-1.png']);
  expect(files.get('document.md')?.toString('utf8')).toBe(await golden());
  expect([...(files.get('images/p1-1.png') ?? Buffer.alloc(0)).subarray(0, 4)]).toEqual([
    137, 80, 78, 71,
  ]);
  await expect(dialog).toBeHidden();

  // Plain text, whole document: the left column before the right one.
  const again = await openDialog(page);
  await again.getByText('Plain text', { exact: true }).click();
  await expect(again.getByTestId('convert-output')).toHaveText('Downloads markdown-source.txt', {
    timeout: 30_000,
  });
  await expect(again.getByTestId('convert-preview')).toHaveAttribute('data-state', 'ready');
  const textDownload = page.waitForEvent('download');
  await again.getByRole('button', { name: 'Download' }).click();
  const text = (await readFile(await (await textDownload).path())).toString('utf8');
  expect(text.indexOf('The left column is read first')).toBeLessThan(
    text.indexOf('The right column comes second'),
  );
  expect(text).not.toContain('](');
});
