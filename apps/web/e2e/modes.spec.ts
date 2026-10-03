/**
 * Read and Edit (ADR-0019 §2–§3, craft spec §3.2–§3.3, §10): a file opens in Read with the
 * lock; nothing moves, fills or arms there; `2` enters Edit and the tool bar appears; a tab
 * click leaves Home in the document's last mode; `1` returns to Read and the bar collapses
 * to one Edit button; a tool key in Read switches to Edit and arms the tool.
 */
import { expect, type Page, test } from '@playwright/test';

import { enterEdit, openFixtures, useFileInputPicker } from './helpers';

const bar = (page: Page) => page.getByRole('toolbar', { name: 'Tools', exact: true });
const modeRadio = (page: Page, name: string) =>
  page.getByRole('radiogroup', { name: 'View mode' }).getByRole('radio', { name, exact: true });

test.beforeEach(async ({ page }) => {
  await useFileInputPicker(page);
  await page.goto('./?lang=en');
  await expect(page.getByTestId('app-shell')).toBeVisible();
});

test('opens in Read with the lock; nothing moves or arms; 2 and 1 switch; a tab click leaves Home', async ({
  page,
}) => {
  await openFixtures(page, ['annotations.pdf']);
  await expect(page.locator('canvas[data-state="rendered"]').first()).toBeAttached({
    timeout: 20_000,
  });

  // Read, with the lock; the bar is one Edit button.
  await expect(modeRadio(page, 'Read, locked')).toHaveAttribute('aria-checked', 'true');
  await expect(bar(page).getByRole('button')).toHaveCount(1);
  const edit = bar(page).getByRole('button', { name: 'Edit' });
  await expect(edit).toHaveAttribute('aria-keyshortcuts', '2');

  // A drag on the square neither selects nor moves it; Delete does nothing.
  const square = page.locator('[data-annotation-id="fixture-annot-square-1"]');
  await expect(square).toBeAttached();
  const before = await square.boundingBox();
  if (!before) throw new Error('no square');
  const cx = before.x + before.width / 2;
  const cy = before.y + before.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 60, cy + 40, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByTestId('annotation-bar')).toHaveCount(0);
  await page.keyboard.press('Delete');
  await expect(square).toBeAttached();
  expect(await square.boundingBox()).toEqual(before);
  // Nothing armed: the page keeps the Select pointer and the bar has no tools.
  const layer = page.locator('[data-annotation-layer="0"]');
  await expect(layer).toHaveAttribute('data-tool', 'select');
  await expect(layer).not.toHaveAttribute('data-drawing', /.*/);

  // 2: Edit, the bar's groups.
  await enterEdit(page);
  await expect.poll(() => bar(page).getByRole('button').count()).toBeGreaterThan(1);
  // In Edit the square selects.
  await square.click({ position: { x: 4, y: 4 } });
  await expect(page.getByTestId('annotation-bar')).toBeVisible();
  await page.keyboard.press('Escape');

  // Home, then the tab: back in the document's last mode (Edit).
  await page.keyboard.press('0');
  await expect(page.getByRole('radiogroup', { name: 'View mode' })).toHaveCount(0);
  await page.getByRole('tab', { name: 'annotations' }).click();
  await expect(modeRadio(page, 'Edit')).toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => bar(page).getByRole('button').count()).toBeGreaterThan(1);

  // 1: Read again; the bar collapses.
  await page.keyboard.press('1');
  await expect(modeRadio(page, 'Read, locked')).toHaveAttribute('aria-checked', 'true');
  await expect(bar(page).getByRole('button')).toHaveCount(1);

  // The Edit button enters Edit.
  await bar(page).getByRole('button', { name: 'Edit' }).click();
  await expect(modeRadio(page, 'Edit')).toHaveAttribute('aria-checked', 'true');
});

test('a tool key in Read switches to Edit and arms the tool, changing nothing', async ({
  page,
}) => {
  await openFixtures(page, ['simple-text.pdf']);
  await expect(page.locator('canvas[data-state="rendered"]').first()).toBeAttached({
    timeout: 20_000,
  });
  await expect(modeRadio(page, 'Read, locked')).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('r');
  await expect(modeRadio(page, 'Edit')).toHaveAttribute('aria-checked', 'true');
  const layer = page.locator('[data-annotation-layer="0"]');
  await expect(layer).toHaveAttribute('data-tool', 'rectangle');
  // Visibly armed: the tool's group is on the bar with the tool pressed.
  await expect(bar(page).locator('[data-tool][aria-pressed="true"]')).toHaveCount(1);
  await expect(page.getByRole('status').filter({ hasText: /^Edit mode\. / })).toHaveCount(1);
  await expect(layer.locator('[data-annotation-id]')).toHaveCount(0);
});

test('form fields are read-only in Read: a click shows "Switch to Edit to fill" and its Edit button', async ({
  page,
}) => {
  await openFixtures(page, ['forms-a.pdf']);
  const target = page.locator('[data-form-layer="0"] [data-field-name="name"]');
  await expect(target).toBeVisible({ timeout: 20_000 });
  await target.click();
  await expect(target).toBeFocused();
  await expect(page.locator('[data-form-editor="name"]')).toHaveCount(0);
  const notice = page.getByRole('status').filter({ hasText: 'Switch to Edit to fill' });
  await expect(notice).toBeVisible();

  // A checkbox does not toggle.
  const agree = page.locator('[data-form-layer="0"] [data-field-name="agree"]');
  const checked = await agree.getAttribute('aria-checked');
  await agree.click();
  await expect(agree).toHaveAttribute('aria-checked', checked ?? '');
  await expect(modeRadio(page, 'Read, locked')).toHaveAttribute('aria-checked', 'true');

  // The notice's Edit button switches; the field then fills.
  await target.click();
  await notice.getByRole('button', { name: 'Edit' }).click();
  await expect(modeRadio(page, 'Edit')).toHaveAttribute('aria-checked', 'true');
  const editor = page.locator('[data-form-editor="name"]');
  await expect(editor).toBeVisible();
  await expect(editor).toHaveValue('Alice Example');
});
