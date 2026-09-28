import { expect, test } from '@playwright/test';

import { openFixtures, useFileInputPicker } from './helpers';

test('the application shell loads', async ({ page }) => {
  // Relative to baseURL, which already carries the deployment base path.
  await page.goto('./');

  await expect(page).toHaveTitle(/pdf-editor/);
  await expect(page.getByTestId('app-shell')).toBeVisible();
});

test('the status bar stays put while the privacy popover opens and closes', async ({ page }) => {
  await useFileInputPicker(page);
  await page.goto('./');
  await openFixtures(page, ['simple-text.pdf']);
  const label = page.getByTestId('status-pages');
  await expect(label).toHaveText('Page 1 of 3');
  const bar = await page.locator('footer').boundingBox();
  const before = await label.boundingBox();
  expect(bar).not.toBeNull();
  expect(before).not.toBeNull();
  // Nothing overflows the bar's left group, so nothing there can scroll it.
  expect(
    await label.evaluate((el) => {
      const group = el.parentElement;
      return group ? group.scrollWidth - group.clientWidth : -1;
    }),
  ).toBe(0);

  // Keyboard only: focus the trigger, open with Enter, close with Escape.
  const trigger = page.getByTestId('privacy-indicator');
  const popover = page.getByRole('dialog');
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(popover).toBeVisible();
  expect((await label.boundingBox())?.x).toBe(before?.x);
  await page.keyboard.press('Escape');
  await expect(popover).toBeHidden();
  await expect(trigger).toBeFocused();
  expect((await label.boundingBox())?.x).toBe(before?.x);

  // A click scrolls the trigger into view first; that used to shift the bar 8px left.
  await trigger.click();
  await expect(popover).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(popover).toBeHidden();

  // The label keeps its place and its first letter ("Page", not "age").
  expect((await label.boundingBox())?.x).toBe(before?.x);
  expect(before?.x).toBeGreaterThanOrEqual(bar?.x ?? Number.POSITIVE_INFINITY);
});
