/**
 * Read-mode viewer (spec viewer-annotations §1): text selection and copy, find in document,
 * internal and external links, go to page, and the two-up layout, on outline-named-dests.pdf.
 */
import { expect, type Page, test } from '@playwright/test';

import { openFixtures, useFileInputPicker } from './helpers';

test.beforeEach(async ({ page, context, browserName }) => {
  await useFileInputPicker(page);
  if (browserName === 'chromium') {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  }
  await page.goto('./?lang=en');
  await openFixtures(page, ['outline-named-dests.pdf']);
  await expect(page.getByTestId('status-pages')).toHaveText('Page 1 of 6');
});

const mod = (page: Page) =>
  page.evaluate(() => (/mac/i.test(navigator.platform) ? 'Meta' : 'Control'));

test('selects page text with the mouse and copies it with lines kept', async ({
  page,
  browserName,
}) => {
  const layer = page.locator('[data-text-layer="0"]');
  const lines = layer.locator('span');
  await expect(lines.first()).toHaveText('PAGE 1 OF outline-named-dests');
  await expect(page.locator('[data-page-index="0"]')).toHaveAttribute('role', 'region');

  const first = await lines.nth(0).boundingBox();
  const second = await lines.nth(1).boundingBox();
  if (!first || !second) throw new Error('text layer not laid out');
  await page.mouse.move(first.x + 1, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(second.x + second.width - 1, second.y + second.height / 2, { steps: 8 });
  await page.mouse.up();
  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '');
  expect(selected).toContain('PAGE 1 OF outline-named-dests');
  expect(selected).toContain('Chapter 1: Introduction');

  // Copy assembles the lines (the raw DOM order would glue them together).
  const copied = await page.evaluate(() => {
    let text = '';
    const onCopy = (event: ClipboardEvent) => {
      text = event.clipboardData?.getData('text/plain') ?? '';
    };
    document.addEventListener('copy', onCopy);
    const data = new DataTransfer();
    document.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, cancelable: true }));
    document.removeEventListener('copy', onCopy);
    return text || data.getData('text/plain');
  });
  expect(copied).toBe('PAGE 1 OF outline-named-dests\nChapter 1: Introduction');

  if (browserName === 'chromium') {
    await page.keyboard.press(`${await mod(page)}+c`);
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe('PAGE 1 OF outline-named-dests\nChapter 1: Introduction');
  }

  // Double-click selects a word.
  await page.mouse.dblclick(second.x + 10, second.y + second.height / 2);
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('Chapter');
});

test('finds text, steps through the hits and clears with Escape', async ({ page }) => {
  await page.keyboard.press(`${await mod(page)}+f`);
  const field = page.getByRole('searchbox', { name: 'Find in document' });
  await expect(field).toBeFocused();
  await field.fill('outline-named-dests');

  const status = page.getByTestId('status-search');
  await expect(status).toContainText('1 of 6');
  await expect(page.getByTestId('search-hit')).toHaveCount(6);
  await expect(page.locator('[data-testid="search-highlights"]').first()).toBeVisible();

  await field.press('Enter');
  await expect(status).toContainText('2 of 6');
  await expect(page.getByTestId('status-pages')).toHaveText('Page 2 of 6');
  await field.press('Enter');
  await expect(status).toContainText('3 of 6');
  await expect(page.getByTestId('status-pages')).toHaveText('Page 3 of 6');
  await field.press('Shift+Enter');
  await expect(status).toContainText('2 of 6');
  await page.keyboard.press('F3');
  await expect(status).toContainText('3 of 6');

  // Match case finds nothing for the upper-cased query.
  await field.fill('OUTLINE');
  // A new search starts from the reader's page (page 3).
  await expect(status).toContainText('3 of 6');
  await page.getByRole('button', { name: 'Match case' }).click();
  await expect(page.getByTestId('search-status')).toHaveText('No results');

  await field.press('Escape');
  await expect(status).toHaveCount(0);
  await expect(page.locator('[data-testid="search-highlights"]')).toHaveCount(0);
  await expect(page.getByRole('searchbox', { name: 'Find in document' })).toHaveCount(0);
});

test('an internal link navigates; an external one asks first', async ({ page }) => {
  await page.keyboard.press(']');
  await expect(page.getByTestId('status-pages')).toHaveText('Page 2 of 6');

  const links = page.locator('[data-page-index="1"] [data-link]');
  await expect(links).toHaveCount(3);
  await page.getByRole('button', { name: 'Go to page 4' }).click();
  await expect(page.getByTestId('status-pages')).toHaveText('Page 4 of 6');

  await page.keyboard.press('[');
  await page.keyboard.press('[');
  await expect(page.getByTestId('status-pages')).toHaveText('Page 2 of 6');
  let popups = 0;
  page.on('popup', () => {
    popups += 1;
  });
  await page.getByRole('button', { name: 'External link: https://example.com/' }).click();
  const confirm = page.getByTestId('link-confirm');
  await expect(confirm).toContainText('https://example.com/');
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toHaveCount(0);
  expect(popups).toBe(0);
});

test('go to page accepts numbers; Home and End jump to the ends', async ({ page }) => {
  await page.keyboard.press(`${await mod(page)}+g`);
  const input = page.getByRole('textbox', { name: 'Page number or label' });
  await input.fill('9');
  await expect(page.getByText('No page “9”')).toBeVisible();
  await input.fill('5');
  await input.press('Enter');
  await expect(page.getByTestId('status-pages')).toHaveText('Page 5 of 6');
  await page.keyboard.press('End');
  await expect(page.getByTestId('status-pages')).toHaveText('Page 6 of 6');
  await page.keyboard.press('Home');
  await expect(page.getByTestId('status-pages')).toHaveText('Page 1 of 6');
});

test('two-up layout shows pages side by side', async ({ page }) => {
  await page.getByRole('radio', { name: 'Two pages' }).click();
  const left = page.locator('[data-page-index="0"]');
  const right = page.locator('[data-page-index="1"]');
  await expect(right).toBeVisible();
  const a = await left.boundingBox();
  const b = await right.boundingBox();
  if (!a || !b) throw new Error('pages not laid out');
  expect(Math.abs(a.y - b.y)).toBeLessThan(1);
  expect(b.x).toBeGreaterThan(a.x + a.width);
  await expect(page.locator('main canvas[data-state="rendered"]').first()).toBeVisible();

  await page.keyboard.press(']');
  await expect(page.getByTestId('status-pages')).toHaveText('Page 3 of 6');
  await page.getByRole('radio', { name: 'Continuous' }).click();
  await expect(page.getByTestId('status-pages')).toHaveText('Page 3 of 6');
});
