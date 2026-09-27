// page.evaluate callbacks run in the browser.
/**
 * Outline panel on a real PDF (nested bookmarks, authored open/closed state, navigation to
 * pages) and the UI language: `?lang=` override, the Language command, persistence.
 */
import { expect, test } from '@playwright/test';

import { openFixtures, useFileInputPicker } from './helpers';

test.beforeEach(async ({ page }) => {
  await useFileInputPicker(page);
});

test('the outline panel shows the bookmarks and navigates Read mode', async ({ page }) => {
  await page.goto('./?lang=en');
  await openFixtures(page, ['outline-named-dests.pdf']);
  await expect(page.getByTestId('status-pages')).toHaveText('Page 1 of 6');

  await page.getByRole('tab', { name: 'Outline', exact: true }).click();
  const tree = page.getByRole('tree', { name: /Outline of/ });
  // The engine does not report the authored /Count (open) state yet, so every node starts
  // collapsed (packages/engine mapBookmark); the panel honours whatever the model says.
  await expect(tree.getByRole('treeitem')).toHaveCount(3);
  const chapter2 = tree.getByRole('treeitem', { name: 'Chapter 2 – Methods' });
  await expect(chapter2).toHaveAttribute('aria-expanded', 'false');

  await tree.getByRole('treeitem', { name: 'Appendix' }).click();
  await expect(page.getByTestId('status-pages')).toHaveText('Page 6 of 6');

  // Keyboard (APG tree): expand, walk into the children, activate one.
  await chapter2.focus();
  await page.keyboard.press('ArrowRight');
  await expect(chapter2).toHaveAttribute('aria-expanded', 'true');
  await expect(tree.getByRole('treeitem')).toHaveCount(5);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  const results = tree.getByRole('treeitem', { name: '2.2 Results' });
  await expect(results).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(tree.getByRole('treeitem', { name: '2.2.1 Details' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('status-pages')).toHaveText('Page 5 of 6');
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('status-pages')).toHaveText('Page 1 of 6');
});

test('?lang= overrides the language without persisting it', async ({ page }) => {
  await page.goto('./?lang=tr');
  await expect(page.getByRole('heading', { name: 'Başlamak için PDF bırakın' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'tr');
  await expect(page.getByTestId('privacy-indicator')).toContainText('Yalnızca yerel');
  await expect(page.getByTestId('privacy-indicator')).toContainText('Dış istek yok');

  await page.goto('./');
  await expect(page.locator('html')).not.toHaveAttribute('lang', 'tr');
});

test('the Language command switches at runtime and persists', async ({ page }) => {
  await page.goto('./?lang=en');
  await expect(page.getByRole('heading', { name: 'Drop PDFs to start' })).toBeVisible();
  await page.getByRole('button', { name: 'Search commands…' }).click();
  await page.getByRole('combobox', { name: 'Search commands' }).fill('language');
  await page.getByRole('option', { name: 'Türkçe' }).click();

  await expect(page.getByRole('heading', { name: 'Başlamak için PDF bırakın' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'tr');
  // The explicit choice drops the override from the address and survives a reload.
  expect(new URL(page.url()).searchParams.has('lang')).toBe(false);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Başlamak için PDF bırakın' })).toBeVisible();
});
