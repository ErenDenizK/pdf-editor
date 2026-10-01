/**
 * Read-mode viewer (spec viewer-annotations §1): text selection and copy, find in document,
 * internal and external links, go to page, and the two-up layout, on outline-named-dests.pdf.
 * The navigator's four tabs and the closed inspector on first run, with Document info in the
 * Document menu (experience-redesign §4).
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
  const lines = layer.locator('[data-row]');
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
  // Mod+F shows the navigator's Find tab, its count in the name.
  await expect(page.getByRole('tab', { name: 'Find, 6 items' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
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

test('the navigator has four tabs with counts; the inspector starts closed', async ({ page }) => {
  const rail = page.getByRole('tablist', { name: 'Navigator views' });
  // Labels under the icons; the badge shows the count (hidden at 0).
  await expect(rail.getByRole('tab')).toHaveText([/^6Pages$/, 'Find', 'Review', /^1Files$/]);
  await expect(rail.getByRole('tab', { name: 'Pages, 6 items' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(rail.getByRole('tab', { name: 'Files, 1 item' })).toBeVisible();
  await expect(page.locator('#right-panel')).toHaveCount(0);

  // Document info is a sheet from the Document menu, not a form in the inspector.
  await page.getByTestId('document-menu').click();
  await page.getByRole('menuitem', { name: 'Document info…' }).click();
  const sheet = page.getByRole('dialog', { name: 'Document info' });
  await expect(sheet.getByTestId('metadata-editor')).toBeVisible();
  await expect(sheet.getByText('outline-named-dests.pdf')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await expect(page.locator('#right-panel')).toHaveCount(0);

  // The inspector opens only when asked (Mod+Alt+B) and is remembered across a reload.
  await page.keyboard.press('ControlOrMeta+Alt+b');
  await expect(page.locator('#right-panel')).toBeVisible();
  await expect(page.locator('#right-panel').getByTestId('metadata-editor')).toHaveCount(0);
  await page.reload();
  await openFixtures(page, ['outline-named-dests.pdf']);
  await expect(page.locator('#right-panel')).toBeVisible();
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

/** The first Read page canvas that holds a rendered bitmap. */
const readBitmap = (page: Page) =>
  page.locator('[data-read-viewport] canvas[data-state="rendered"]').first();

// Regression: the virtualized page column found no scroll element on its first commit and
// stayed blank until something (a window resize) re-rendered it.
test('Read mode renders pages after Arrange without a resize', async ({ page }) => {
  await expect(readBitmap(page)).toBeVisible();
  await page.keyboard.press('2');
  await expect(page.locator('[data-read-viewport]')).toHaveCount(0);
  await page.keyboard.press('1');
  await expect(page.locator('[data-read-viewport] [data-page-index="0"]')).toBeVisible();
  await expect(readBitmap(page)).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId('status-pages')).toHaveText('Page 1 of 6');
});

test('a document opened in Read mode renders its pages, and so does the tab left', async ({
  page,
}) => {
  await expect(readBitmap(page)).toBeVisible();
  await openFixtures(page, ['simple-text.pdf']);
  const second = page.getByRole('tab', { name: 'simple-text' });
  await second.click();
  await expect(second).toHaveAttribute('aria-selected', 'true');
  const viewport = page.locator('[data-read-viewport]');
  await expect(viewport.locator('[data-page-index="0"]')).toBeVisible();
  await expect(readBitmap(page)).toBeVisible({ timeout: 5_000 });

  await page.getByRole('tab', { name: 'outline-named-dests' }).click();
  await expect(page.getByTestId('status-pages')).toHaveText('Page 1 of 6');
  await expect(readBitmap(page)).toBeVisible({ timeout: 5_000 });
});
