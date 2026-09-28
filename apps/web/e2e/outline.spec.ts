/**
 * Outline editing end to end: on a real file with named destinations, add a bookmark to
 * page 2, rename one, drag one under another, export (verified), re-open the export and
 * check the tree in the Outline panel (PDFium reads it back: titles, nesting, target
 * pages) and, with pdf-lib, the written /Outlines.
 */
import { copyFile, readFile } from 'node:fs/promises';

import type { PDFNumber } from '@cantoo/pdf-lib';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRef } from '@cantoo/pdf-lib';
import { expect, test } from '@playwright/test';

import { openFixtures, useFileInputPicker } from './helpers';

test.skip(({ browserName }) => browserName !== 'chromium', 'Download flow is verified on Chromium');

/** Pre-order titles with depth and 1-based target page, read with pdf-lib. */
function outlineOf(doc: PDFDocument): string[] {
  const pages = doc.getPages();
  const out: string[] = [];
  const walk = (first: PDFDict | undefined, depth: number) => {
    for (let item = first; item; item = item.lookupMaybe(PDFName.of('Next'), PDFDict)) {
      const title = item.lookup(PDFName.of('Title'), PDFHexString).decodeText();
      const dest = item.lookupMaybe(PDFName.of('Dest'), PDFArray);
      const ref = dest?.get(0);
      const index = ref instanceof PDFRef ? pages.findIndex((p) => p.ref === ref) : -1;
      out.push(`${'  '.repeat(depth)}${title} → ${index + 1}`);
      walk(item.lookupMaybe(PDFName.of('First'), PDFDict), depth + 1);
    }
  };
  const root = doc.catalog.lookupMaybe(PDFName.of('Outlines'), PDFDict);
  walk(root?.lookupMaybe(PDFName.of('First'), PDFDict), 0);
  return out;
}

test('edit the outline, export, and read the new tree back', async ({ page }, testInfo) => {
  // Force the <a download> path: Playwright cannot drive the native save picker.
  await page.addInitScript({
    content:
      "Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });",
  });
  await useFileInputPicker(page);
  await page.goto('./?lang=en');
  await openFixtures(page, ['outline-named-dests.pdf']);
  const status = page.getByTestId('status-pages');
  await expect(status).toHaveText('Page 1 of 6');

  await page.keyboard.press(']');
  await expect(status).toHaveText('Page 2 of 6');
  // Scroll a little into page 2: the bookmark remembers the position (/XYZ top).
  const page2 = page.locator('[data-page-index="1"]');
  const box = await page2.boundingBox();
  if (!box) throw new Error('page 2 is not rendered');
  await page.mouse.move(box.x + box.width / 2, box.y + 100);
  await page.mouse.wheel(0, 150);
  await expect.poll(async () => (await page2.boundingBox())?.y ?? 0).toBeLessThan(box.y - 100);
  await expect(status).toHaveText('Page 2 of 6');

  await page.getByRole('tab', { name: 'Outline', exact: true }).click();
  const tree = page.getByRole('tree', { name: /Outline of/ });
  await expect(tree.getByRole('treeitem')).toHaveCount(5);

  // 1. Add a bookmark to page 2 (the page in view), renamed as it is created.
  await page.getByRole('button', { name: 'Add bookmark' }).click();
  const input = page.getByRole('textbox', { name: 'Bookmark title' });
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('Page 2');
  await input.fill('Methods overview');
  await input.press('Enter');
  const added = tree.getByRole('treeitem', { name: 'Methods overview' });
  await expect(added).toBeFocused();
  await expect(added).toHaveAttribute('aria-level', '1');

  // 2. Rename "Appendix" with F2.
  const appendix = tree.getByRole('treeitem', { name: 'Appendix' });
  await appendix.focus();
  await page.keyboard.press('F2');
  await input.fill('Appendix A');
  await input.press('Enter');
  await expect(tree.getByRole('treeitem', { name: 'Appendix A' })).toBeFocused();

  // 3. Drag "Appendix A" onto the middle of "Chapter 1: Introduction": it becomes its child.
  const chapter1 = tree.getByRole('treeitem', { name: 'Chapter 1: Introduction' });
  await tree.getByRole('treeitem', { name: 'Appendix A' }).dragTo(chapter1);
  await expect(chapter1).toHaveAttribute('aria-expanded', 'true');
  await expect(tree.getByRole('treeitem', { name: 'Appendix A' })).toHaveAttribute(
    'aria-level',
    '2',
  );
  // Clicking the bookmark still navigates to its page.
  await added.click();
  await expect(status).toHaveText('Page 2 of 6');

  // 4. Export under a new name, verified by the PDFium pass, and download.
  await page.getByRole('button', { name: 'Export document' }).click();
  const dialog = page.getByTestId('export-dialog');
  await dialog.getByRole('textbox', { name: 'File name' }).fill('outline-edited.pdf');
  await dialog.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(dialog.getByTestId('export-verified')).toBeVisible({ timeout: 30_000 });
  const downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('outline-edited.pdf');
  const saved = testInfo.outputPath('outline-edited.pdf');
  await copyFile(await download.path(), saved);

  const expected = [
    'Chapter 1: Introduction → 1',
    '  Appendix A → 6',
    'Chapter 2 – Methods → 3',
    '  2.1 Setup → 4',
    '  2.2 Results → 5',
    '    2.2.1 Details → 5',
    'Methods overview → 2',
  ];
  const written = await PDFDocument.load(await readFile(saved), { updateMetadata: false });
  expect(outlineOf(written)).toEqual(expected);
  // The new bookmark is the last top-level item: /XYZ with the scrolled-to position.
  const last = written.catalog
    .lookup(PDFName.of('Outlines'), PDFDict)
    .lookup(PDFName.of('Last'), PDFDict)
    .lookup(PDFName.of('Dest'), PDFArray);
  expect(last.get(1)).toBe(PDFName.of('XYZ'));
  const top = (last.get(3) as PDFNumber).asNumber();
  const height = written.getPage(1).getHeight();
  expect(top).toBeGreaterThan(height / 3);
  expect(top).toBeLessThan(height - 20);

  // 5. Re-open the export: the Outline panel shows the new tree, read back by PDFium.
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open files' }).first().click();
  await (await chooser).setFiles(saved);
  await expect(page.getByRole('tab', { name: 'outline-edited' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'outline-edited' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const reopened = page.getByRole('tree', { name: 'Outline of outline-edited' });
  const reChapter1 = reopened.getByRole('treeitem', { name: 'Chapter 1: Introduction' });
  // Chapter 1 was authored closed, so its new child starts hidden.
  await expect(reChapter1).toHaveAttribute('aria-expanded', 'false');
  await reChapter1.focus();
  await page.keyboard.press('ArrowRight');
  // "2.2 Results" keeps its authored closed state.
  const results = reopened.getByRole('treeitem', { name: '2.2 Results' });
  await expect(results).toHaveAttribute('aria-expanded', 'false');
  await results.focus();
  await page.keyboard.press('ArrowRight');
  const rows = reopened.getByRole('treeitem');
  await expect(rows).toHaveCount(7);
  const levels = await rows.evaluateAll((items) =>
    items.map(
      (el) =>
        `${'  '.repeat(Number(el.getAttribute('aria-level')) - 1)}${el.querySelector('[class*="title"]')?.textContent} → ${el.querySelector('[hidden]')?.textContent?.replace('Page ', '')}`,
    ),
  );
  expect(levels).toEqual(expected);
  await reopened.getByRole('treeitem', { name: 'Appendix A' }).click();
  await expect(status).toHaveText('Page 6 of 6');
  await reopened.getByRole('treeitem', { name: 'Methods overview' }).click();
  await expect(status).toHaveText('Page 2 of 6');
});
