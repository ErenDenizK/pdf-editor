/**
 * Home end to end (experience-redesign §3, §11): a new user merges two files in under five
 * actions, dropped or opened with "Open files" (every click, key press, drop and file
 * dialog choice is counted), the Files tab's selection, Combine and "Show Home", a card
 * dragged onto another opens the merge dialog as [target, dragged], the keyboard path
 * through the cards, and the navigator collapsed while no file is open. Drops use a
 * script-built DataTransfer, which Chromium accepts (as in batch.spec).
 */
import { readFile } from 'node:fs/promises';

import { expect, type Locator, type Page, test } from '@playwright/test';

import { fixturePath, openFixtures, useFileInputPicker } from './helpers';

test.skip(({ browserName }) => browserName !== 'chromium', 'Script-built drops need Chromium');

/** Counts what a user does: each click, key press and drop is one action. */
class User {
  actions = 0;
  constructor(private readonly page: Page) {}

  async click(target: Locator): Promise<void> {
    this.actions += 1;
    await target.click();
  }

  async press(key: string): Promise<void> {
    this.actions += 1;
    await this.page.keyboard.press(key);
  }

  /** Picks corpus files in the file dialog `opener` opens: the click, then the choice. */
  async pick(opener: Locator, names: readonly string[]): Promise<void> {
    const chooser = this.page.waitForEvent('filechooser');
    await this.click(opener);
    this.actions += 1;
    await (await chooser).setFiles(names.map(fixturePath));
  }

  /** Drops corpus files on `target` (dragenter, dragover, drop: one gesture). */
  async drop(target: Locator, names: readonly string[]): Promise<void> {
    this.actions += 1;
    const files = await Promise.all(
      names.map(async (name) => ({ name, bytes: [...(await readFile(fixturePath(name)))] })),
    );
    await target.evaluate((element, list) => {
      const data = new DataTransfer();
      for (const file of list) {
        data.items.add(
          new File([new Uint8Array(file.bytes)], file.name, { type: 'application/pdf' }),
        );
      }
      for (const type of ['dragenter', 'dragover', 'drop']) {
        element.dispatchEvent(
          new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data }),
        );
      }
    }, files);
  }
}

function cards(page: Page): Locator {
  return page.getByRole('listbox', { name: 'Files' }).getByRole('option');
}

function card(page: Page, title: string): Locator {
  return page
    .getByRole('listbox', { name: 'Files' })
    .getByRole('option', { name: new RegExp(`^${title},`) });
}

const documentTabs = (page: Page) =>
  page.getByRole('tablist', { name: 'Open documents' }).getByRole('tab');

test('a new user merges two dropped files in under five actions', async ({ page }) => {
  await page.goto('./?lang=en');
  await expect(page.getByRole('heading', { name: 'Drop PDFs to start' })).toBeVisible();
  const user = new User(page);

  // 1. Drop two files on the empty app: Home, both cards selected.
  await user.drop(page.getByTestId('app-shell'), ['simple-text.pdf', 'rotated-pages.pdf']);
  await expect(page.getByTestId('home')).toBeVisible();
  await expect(cards(page)).toHaveCount(2);
  await expect(cards(page).and(page.getByRole('option', { selected: true }))).toHaveCount(2);

  // 2. Combine.
  const combine = page.getByRole('button', { name: 'Combine 2 files' });
  await user.click(combine);
  const dialog = page.getByTestId('merge-all-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('merge-row')).toHaveCount(2);
  await expect(dialog.getByTestId('merge-row').nth(0)).toContainText('simple-text');

  // 3. Confirm the dialog's default.
  await user.click(dialog.getByRole('button', { name: 'Merge', exact: true }));
  await expect(dialog).toBeHidden();

  // One document with every page, in Read.
  await expect(documentTabs(page)).toHaveCount(1);
  await expect(documentTabs(page).first()).toHaveAccessibleName(/simple-text/);
  await expect(page.getByTestId('home')).toHaveCount(0);
  await expect(page.getByTestId('status-pages')).toHaveText('Page 1 of 7');
  expect(user.actions).toBeLessThanOrEqual(5);
  expect(user.actions).toBe(3);
});

test('a new user merges two files opened with "Open files" in under five actions', async ({
  page,
}) => {
  await useFileInputPicker(page);
  await page.goto('./?lang=en');
  const user = new User(page);

  // 1–2. "Open files" on the empty card, two files chosen: Home, both cards selected, as
  // after a drop.
  await user.pick(page.getByTestId('home').getByRole('button', { name: 'Open files' }), [
    'simple-text.pdf',
    'rotated-pages.pdf',
  ]);
  await expect(page.getByTestId('home')).toBeVisible();
  await expect(cards(page)).toHaveCount(2);
  await expect(cards(page).and(page.getByRole('option', { selected: true }))).toHaveCount(2);
  // Home is a view of the files: no mode control, the glyph current (ADR-0019 §1).
  await expect(page.getByRole('radiogroup', { name: 'View mode' })).toHaveCount(0);
  await expect(page.getByTestId('home-button')).toHaveAttribute('aria-current', 'page');

  // 3. Combine. 4. Confirm the dialog's default.
  await user.click(page.getByRole('button', { name: 'Combine 2 files' }));
  const dialog = page.getByTestId('merge-all-dialog');
  await expect(dialog.getByTestId('merge-row')).toHaveCount(2);
  await user.click(dialog.getByRole('button', { name: 'Merge', exact: true }));
  await expect(dialog).toBeHidden();

  await expect(documentTabs(page)).toHaveCount(1);
  await expect(page.getByTestId('status-pages')).toHaveText('Page 1 of 7');
  expect(user.actions).toBeLessThanOrEqual(5);
  expect(user.actions).toBe(4);
});

test('the Files tab shares Home’s selection, combines and leads to Home', async ({ page }) => {
  await useFileInputPicker(page);
  await page.goto('./?lang=en');
  await openFixtures(page, ['simple-text.pdf', 'rotated-pages.pdf', 'mixed-sizes.pdf']);
  await expect(page.getByTestId('home')).toBeVisible();

  // On Home no tab is selected; a tab click leaves Home for that document, in Read.
  await expect(documentTabs(page).and(page.getByRole('tab', { selected: true }))).toHaveCount(0);
  await documentTabs(page).first().click();
  await expect(page.getByTestId('home')).toHaveCount(0);
  await expect(page.getByRole('radio', { name: 'Read, locked' })).toBeChecked();
  await expect(page.getByTestId('home-button')).not.toHaveAttribute('aria-current', 'page');

  await page.getByRole('tab', { name: /^Files/ }).click();
  const panel = page.locator('#left-panel');
  const boxes = panel.getByRole('checkbox');
  await expect(boxes).toHaveCount(3);
  // The three opened together are still selected.
  await expect(panel.getByRole('button', { name: 'Combine 3 files' })).toBeVisible();
  await panel.getByRole('checkbox', { name: 'Select simple-text' }).uncheck();
  await expect(panel.getByRole('button', { name: 'Combine 2 files' })).toBeVisible();
  await panel.getByRole('checkbox', { name: 'Select rotated-pages' }).uncheck();
  // One selected: nothing to combine, so no button (never a disabled one).
  await expect(panel.getByTestId('files-combine')).toHaveCount(0);
  await panel.getByRole('checkbox', { name: 'Select mixed-sizes' }).uncheck();
  await expect(panel.getByRole('button', { name: 'Combine all 3 files' })).toBeVisible();

  await panel.getByRole('checkbox', { name: 'Select rotated-pages' }).check();
  await panel.getByRole('checkbox', { name: 'Select simple-text' }).check();
  await panel.getByRole('button', { name: 'Show Home' }).click();
  await expect(page.getByTestId('home')).toBeVisible();
  await expect(
    cards(page)
      .and(page.getByRole('option', { selected: true }))
      .evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')?.split(',')[0])),
  ).resolves.toEqual(['simple-text', 'rotated-pages']);

  await panel.getByRole('button', { name: 'Combine 2 files' }).click();
  const dialog = page.getByTestId('merge-all-dialog');
  // Selection order: rotated-pages was ticked first.
  await expect(dialog.getByTestId('merge-row').nth(0)).toContainText('rotated-pages');
  await expect(dialog.getByTestId('merge-row').nth(1)).toContainText('simple-text');
});

test('the navigator stays collapsed while no file is open and reopens as it was', async ({
  page,
}) => {
  await useFileInputPicker(page);
  await page.goto('./?lang=en');
  const panel = page.locator('#left-panel');
  const rail = page.getByRole('tablist', { name: 'Navigator views' });
  await expect(rail.getByRole('tab')).toHaveCount(4);
  await expect(panel).toHaveCount(0);
  await expect(rail.getByRole('tab', { selected: true })).toHaveCount(0);

  await openFixtures(page, ['simple-text.pdf']);
  await expect(panel).toBeVisible();
  await expect(rail.getByRole('tab', { name: /^Pages/ })).toHaveAttribute('aria-selected', 'true');

  // Closing the last file collapses it again; a tab picked meanwhile opens it.
  await rail.getByRole('tab', { name: /^Files/ }).click();
  await panel.getByRole('button', { name: 'Close simple-text' }).click();
  await expect(panel).toHaveCount(0);
  await rail.getByRole('tab', { name: 'Files' }).click();
  await expect(panel).toBeVisible();
  await expect(panel.getByText('No files open')).toBeVisible();
});

test('a card dragged onto another opens the merge dialog with the target first', async ({
  page,
}) => {
  await page.goto('./?lang=en');
  const user = new User(page);
  await user.drop(page.getByTestId('app-shell'), ['simple-text.pdf', 'rotated-pages.pdf']);
  await expect(cards(page)).toHaveCount(2);

  // CSS locators: once the dialog opens, the cards behind it leave the accessibility tree.
  const source = page.locator('[role="option"][aria-label^="simple-text,"]');
  const target = page.locator('[role="option"][aria-label^="rotated-pages,"]');
  const data = await page.evaluateHandle(() => new DataTransfer());
  const fire = (locator: Locator, type: string) =>
    locator.dispatchEvent(type, { dataTransfer: data });
  await fire(source, 'dragstart');
  await fire(target, 'dragenter');
  await fire(target, 'dragover');
  // The target is marked and says what a drop does.
  await expect(target).toHaveAttribute('data-drop-target', 'true');
  await expect(page.getByTestId('home-drop-label')).toHaveText('Combine with rotated-pages');
  await fire(target, 'drop');
  await fire(source, 'dragend');

  const dialog = page.getByTestId('merge-all-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('merge-row').nth(0)).toContainText('rotated-pages');
  await expect(dialog.getByTestId('merge-row').nth(1)).toContainText('simple-text');
  await expect(target).not.toHaveAttribute('data-drop-target');
  // Nothing merged without the dialog (the tabs are behind the modal dialog, hence CSS).
  await expect(
    page.locator('[role="tablist"][aria-label="Open documents"] [role="tab"]'),
  ).toHaveCount(2);

  await dialog.getByRole('button', { name: 'Merge', exact: true }).click();
  await expect(documentTabs(page)).toHaveCount(1);
  await expect(documentTabs(page).first()).toHaveAccessibleName(/rotated-pages/);
  await expect(page.getByTestId('status-pages')).toHaveText('Page 1 of 7');
});

test('the keyboard path: Tab to the cards, arrows, Space and Enter', async ({ page }) => {
  await useFileInputPicker(page);
  await page.goto('./?lang=en');
  await openFixtures(page, ['simple-text.pdf', 'rotated-pages.pdf', 'mixed-sizes.pdf']);
  // Opened together on an empty app: Home, the new cards selected.
  await expect(page.getByTestId('home')).toBeVisible();
  await expect(page.getByRole('radiogroup', { name: 'View mode' })).toHaveCount(0);
  await expect(page.getByTestId('home-button')).toHaveAttribute('aria-current', 'page');
  await expect(cards(page).and(page.getByRole('option', { selected: true }))).toHaveCount(3);

  // Tab from the last toolbar button into the cards: one card is in the tab order.
  await page.getByTestId('home-combine').focus();
  await page.keyboard.press('Tab');
  await expect(card(page, 'simple-text')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(cards(page).and(page.getByRole('option', { selected: true }))).toHaveCount(0);
  // Compare and Close show only when they apply (never disabled).
  await expect(page.getByRole('button', { name: 'Compare', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Close', exact: true })).toHaveCount(0);

  await page.keyboard.press('ArrowRight');
  await expect(card(page, 'rotated-pages')).toBeFocused();
  await page.keyboard.press('Space');
  await expect(card(page, 'rotated-pages')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Shift+ArrowRight');
  await expect(card(page, 'mixed-sizes')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: 'Combine 2 files' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Compare', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close', exact: true })).toBeVisible();

  await page.keyboard.press('Enter');
  await expect(page.getByTestId('home')).toHaveCount(0);
  await expect(
    documentTabs(page).and(page.getByRole('tab', { selected: true })),
  ).toHaveAccessibleName(/mixed-sizes/);
  await expect(page.getByRole('radio', { name: 'Read, locked' })).toBeChecked();
  await expect(page.getByTestId('home-button')).not.toHaveAttribute('aria-current', 'page');

  // The app glyph leads back to Home.
  await page.getByTestId('home-button').click();
  await expect(page.getByTestId('home')).toBeVisible();
});
