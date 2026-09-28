/**
 * Compare two documents end to end (spec recognize-and-compare §2): open compare-a.pdf and
 * compare-b.pdf, switch to the Compare view (3), run, check the Changes panel lists the
 * seeded changes, toggle the heat map, export the report and read it back with pdf-lib;
 * the Compare segment shows only while a comparison is open, leaving keeps the result, a
 * page command on a compared document marks it out of date (undo clears that).
 */
import { readFile } from 'node:fs/promises';

import { PDFArray, PDFDict, PDFDocument, PDFName } from '@cantoo/pdf-lib';
import { expect, type Page, test } from '@playwright/test';

import { openFixtures, useFileInputPicker } from './helpers';

test.skip(({ browserName }) => browserName !== 'chromium', 'Compare is verified on Chromium');

async function setUp(page: Page): Promise<void> {
  // Force the <a download> path: Playwright cannot drive the native save picker.
  await page.addInitScript({
    content:
      "Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });",
  });
  await useFileInputPicker(page);
  await page.goto('./');
  await expect(page.getByTestId('app-shell')).toBeVisible();
  await openFixtures(page, ['compare-a.pdf', 'compare-b.pdf']);
}

/** Annotation subtypes per page of a PDF, e.g. `[{}, { Highlight: 1, Square: 2 }]`. */
async function annotationCounts(bytes: Uint8Array): Promise<Record<string, number>[]> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  return pdf.getPages().map((p) => {
    const counts: Record<string, number> = {};
    const annots = p.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    for (let i = 0; i < (annots?.size() ?? 0); i++) {
      const annot = annots?.lookupMaybe(i, PDFDict);
      const subtype = annot?.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText() ?? '?';
      counts[subtype] = (counts[subtype] ?? 0) + 1;
    }
    return counts;
  });
}

test('compare-a against compare-b: the seeded changes, the heat map and the report', async ({
  page,
}) => {
  await setUp(page);
  // No comparison open: the view switch has no Compare segment and its arrows skip it.
  const compareSegment = page.getByRole('radio', { name: 'Compare', exact: true });
  await expect(page.getByRole('radio', { name: 'Read', exact: true })).toBeChecked();
  await expect(compareSegment).toHaveCount(0);
  await page.getByRole('radio', { name: 'Read', exact: true }).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('radio', { name: 'Arrange', exact: true })).toBeChecked();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('radio', { name: 'Read', exact: true })).toBeChecked();
  // 3 switches to the Compare view; the Changes panel opens in the left rail.
  await page.keyboard.press('3');
  await expect(compareSegment).toBeChecked();
  const setup = page.getByTestId('compare-setup');
  await expect(setup).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Changes' })).toHaveAttribute('aria-selected', 'true');

  await setup.getByLabel('Original (A)').selectOption({ label: 'compare-a' });
  await setup.getByLabel('Revised (B)').selectOption({ label: 'compare-b' });
  await setup.getByRole('button', { name: 'Compare', exact: true }).click();

  const view = page.getByTestId('compare-view');
  await expect(view).toHaveAttribute('data-status', 'done', { timeout: 60_000 });

  // The Changes panel lists exactly the seeded changes.
  const panel = page.getByTestId('changes-panel');
  await expect(panel.getByTestId('changes-summary')).toHaveText(
    'Pages: 2 changed · 1 inserted · 1 deleted · 1 unchanged',
  );
  await expect(panel.getByTestId('changes-honesty')).toContainText('Pixel differences at 100 dpi');
  const items = panel.locator('[data-change]');
  await expect(items).toHaveCount(6);
  await expect(panel.getByRole('button', { name: /Document info: Title/ })).toContainText(
    '“Quarterly report” → “Quarterly report (revised)”',
  );
  await expect(panel.getByRole('button', { name: /“Monday” → “Tuesday”/ })).toBeVisible();
  await expect(
    panel.getByRole('region', { name: 'Page 2 ↔ 2' }).getByRole('button', { name: /changed area/ }),
  ).toBeVisible();
  await expect(panel.getByRole('button', { name: /Page 3 deleted/ })).toContainText(
    'Appendix to be removed',
  );
  await expect(panel.getByRole('button', { name: /Page 4 inserted/ })).toContainText(
    'Added in revision',
  );
  // The page map strip: ~ ~ − = +.
  await expect(page.getByTestId('compare-page-map').getByRole('button')).toHaveText([
    '~',
    '~',
    '−',
    '=',
    '+',
  ]);

  // Clicking a change reveals it: the word is marked current on the page.
  await panel.getByRole('button', { name: /“Monday” → “Tuesday”/ }).click();
  await expect(view.locator('[data-change="text:0"][data-current]')).toHaveCount(2);

  // Heat map over B.
  const toggle = page.getByTestId('compare-heatmap-toggle');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(
    view.locator('[data-testid="compare-heatmap"][data-state="rendered"]').first(),
  ).toBeVisible();

  // The report: summary page(s), then compare-b's four pages with the change annotations.
  const downloadPromise = page.waitForEvent('download');
  await panel.getByRole('button', { name: 'Export report' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('compare-b-comparison.pdf');
  const bytes = new Uint8Array(await readFile(await download.path()));
  const counts = await annotationCounts(bytes);
  const pages = counts.slice(counts.length - 4);
  const summary = counts.slice(0, counts.length - 4);
  expect(summary.length).toBeGreaterThanOrEqual(1);
  expect(summary.every((c) => Object.keys(c).length === 0)).toBe(true);
  // Page 1: the new word highlighted; its changed pixels boxed.
  expect(pages[0]?.Highlight).toBe(1);
  expect(pages[0]?.Square ?? 0).toBeGreaterThanOrEqual(1);
  // Page 2: the moved image boxed, no text change.
  expect(pages[1]?.Square ?? 0).toBeGreaterThanOrEqual(1);
  expect(pages[1]?.Highlight ?? 0).toBe(0);
  // Page 3 (A's page 4, identical) has no box; page 4 is inserted: boxed whole.
  expect(pages[2]?.Square ?? 0).toBe(0);
  expect(pages[2]?.Highlight ?? 0).toBe(0);
  expect(pages[3]?.Square).toBe(1);
  // The deleted page is noted where it stood.
  expect(pages.reduce((n, c) => n + (c.Text ?? 0), 0)).toBe(1);

  // Esc leaves the view; the (read-only) result is kept and its segment returns to it.
  await page.locator('[data-compare-viewport]').focus();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('radio', { name: 'Read', exact: true })).toBeChecked();
  await expect(compareSegment).toBeVisible();

  // A page command on a compared document: the result is marked out of date.
  await page.keyboard.press('2');
  const cell = page.locator('[role="gridcell"][data-page-id]').first();
  await expect(cell).toBeVisible();
  await cell.click();
  await page.keyboard.press('r');
  await compareSegment.click();
  await expect(view).toHaveAttribute('data-status', 'done');
  await expect(view).toHaveAttribute('data-stale', '');
  await expect(page.getByTestId('compare-stale')).toContainText(
    'The documents changed since this comparison',
  );
  await expect(panel.getByTestId('changes-stale')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Export report' })).toBeDisabled();
  // Undo puts the documents back as compared.
  await page.locator('[data-compare-viewport]').focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.getByTestId('compare-stale')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Export report' })).toBeEnabled();

  // New comparison releases it: once the view is left, the segment is gone.
  await view.getByRole('button', { name: 'New comparison' }).click();
  await expect(page.getByTestId('compare-setup')).toBeVisible();
  await page.getByRole('radio', { name: 'Read', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'Read', exact: true })).toBeChecked();
  await expect(compareSegment).toHaveCount(0);
});
