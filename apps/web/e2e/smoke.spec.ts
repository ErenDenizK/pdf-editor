import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

import { openFixtures, useFileInputPicker } from './helpers';

const screenshots = new URL('../../../docs/design/screenshots/', import.meta.url);

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

test('the start card says what several files do, in both languages', async ({ page }) => {
  await page.goto('./?lang=en');
  await expect(
    page.getByText(
      'Drop PDFs here or open them. With two or more open you can combine them on Home or from the Document menu, arrange their pages together or compare them.',
    ),
  ).toBeVisible();
  await page.goto('./?lang=tr');
  await expect(
    page.getByText(
      'PDF’leri buraya bırakın ya da açın. İki veya daha fazla dosya açıkken onları ana ekranda ya da Belge menüsünden birleştirebilir, sayfalarını birlikte düzenleyebilir veya karşılaştırabilirsiniz.',
    ),
  ).toBeVisible();
});

test('the palette finds commands by keywords in both languages, without diacritics', async ({
  page,
}) => {
  await page.goto('./?lang=en');
  const search = async (query: string) => {
    await page.keyboard.press('ControlOrMeta+k');
    const input = page.getByRole('combobox', { name: /^(Search commands|Komut ara)$/ });
    await input.fill(query);
    return page.getByRole('option').first();
  };
  await expect(await search('kalem')).toContainText('Pen tool');
  await page.keyboard.press('Escape');
  await expect(await search('ciz')).toContainText('Pen tool');
  await page.keyboard.press('Escape');
  await expect(await search('birlestir')).toContainText(/Merge (all open documents|document into)/);
  await page.keyboard.press('Escape');
  await expect(await search('sertifika')).toContainText('Sign with certificate…');
  await page.keyboard.press('Escape');

  // The Turkish UI matches English keywords too.
  await page.goto('./?lang=tr');
  await expect(await search('draw')).toContainText('Kalem aracı');
  await page.keyboard.press('Escape');
  await expect(await search('birlestir')).toContainText(/birleştir|başka belgeye ekle/);
});

test('screenshots of the shell, Home and Document info (design review)', async ({
  browserName,
  page,
}) => {
  test.skip(
    !process.env.CAPTURE_SCREENSHOTS || browserName !== 'chromium',
    'Set CAPTURE_SCREENSHOTS=1 (Chromium) to write docs/design/screenshots/.',
  );
  test.setTimeout(120_000);
  const shot = (name: string, clip?: { x: number; y: number; width: number; height: number }) =>
    page.screenshot({
      path: fileURLToPath(new URL(name, screenshots)),
      ...(clip ? { clip } : {}),
    });
  const wide = { width: 1440, height: 900 };
  const narrow = { width: 1024, height: 700 };
  await page.setViewportSize(wide);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await useFileInputPicker(page);
  await page.goto('./?lang=en');
  const shell = page.getByTestId('app-shell');
  await expect(shell).toBeVisible();

  // The empty state, a file dragged over it, the palette and the keyboard map.
  await shot('m0-shell-empty-1440.png');
  await page.setViewportSize(narrow);
  await shot('m0-shell-empty-1024.png');
  await page.setViewportSize(wide);
  const drag = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.items.add(new File(['%PDF-1.7'], 'report.pdf', { type: 'application/pdf' }));
    return data;
  });
  await shell.dispatchEvent('dragenter', { dataTransfer: drag });
  await shell.dispatchEvent('dragover', { dataTransfer: drag });
  await expect(page.getByTestId('home')).toHaveAttribute('data-dragging', 'true');
  await shot('m0-shell-dragover-1440.png');
  await shell.dispatchEvent('dragleave', { dataTransfer: drag });
  await expect(page.getByTestId('home')).not.toHaveAttribute('data-dragging', 'true');

  await page.keyboard.press('ControlOrMeta+k');
  const search = page.getByRole('combobox', { name: 'Search commands' });
  await expect(search).toBeFocused();
  await shot('m0-shell-palette-1440.png');
  await page.setViewportSize(narrow);
  await shot('m0-shell-palette-1024.png');
  await page.setViewportSize(wide);
  await search.fill('zo');
  await shot('m0-shell-palette-query-1440.png');
  await page.keyboard.press('Escape');
  await expect(search).toHaveCount(0);
  await page.keyboard.press('?');
  await expect(page.getByRole('dialog')).toBeVisible();
  await shot('m0-shell-shortcuts-1440.png');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Home with three files, then Read and Arrange with all three.
  await openFixtures(page, ['outline-named-dests.pdf', 'images.pdf', 'forms-a.pdf']);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.locator('body').press('0');
  const home = page.getByTestId('home');
  await expect(home).toBeVisible();
  await expect(home.locator('canvas[data-state="rendered"]')).toHaveCount(3, {
    timeout: 20_000,
  });
  await page.mouse.move(720, 880);
  await shot('m6-home-three-files-1440.png');

  await page.locator('body').press('1');
  const rendered = page.locator('[data-read-viewport] canvas[data-state="rendered"]');
  await expect(rendered.first()).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(400);
  await shot('m0-shell-read-1440.png');

  // The privacy popover and a tool tooltip, cropped as before.
  await page.getByTestId('privacy-indicator').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await shot('m0-shell-privacy-1440.png', { x: 0, y: 640, width: 520, height: 260 });
  await page.keyboard.press('Escape');
  const bar = page.getByRole('toolbar', { name: 'Tools' });
  await bar.getByRole('button', { name: 'Mark up', exact: true }).click();
  await bar.getByRole('button', { name: /^Highlight/ }).hover();
  // Base UI tooltips open after 500 ms and carry no role.
  await page.waitForTimeout(900);
  const box = await bar.boundingBox();
  if (!box) throw new Error('tool bar not rendered');
  const cx = Math.round(box.x + box.width / 2);
  await shot('m0-shell-tooltip-1440.png', {
    x: Math.max(0, cx - 320),
    y: Math.round(box.y + box.height) - 172,
    width: 640,
    height: 200,
  });
  await page.mouse.move(720, 450);
  await page.locator('body').press('Escape');
  await page.locator('body').press('Escape');

  // The Document menu's sections, then Document info: a side sheet from the menu.
  await page.locator('body').press('Home');
  await expect(
    page.locator('[data-read-viewport] [data-page-index="0"] canvas[data-state="rendered"]'),
  ).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(400);
  await page.getByTestId('document-menu').click();
  await expect(page.getByRole('menuitem', { name: 'Merge files…' })).toBeVisible();
  await page.waitForTimeout(300);
  await shot('m6-document-menu-1440.png');
  await page.getByRole('menuitem', { name: 'Document info…' }).click();
  const sheet = page.getByRole('dialog', { name: 'Document info' });
  await expect(sheet.getByTestId('metadata-editor')).toBeVisible();
  await page.waitForTimeout(300);
  await shot('m6-document-info-1440.png');
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  await page.locator('body').press('2');
  await expect(page.locator('[role="grid"]').first()).toBeVisible();
  await expect(page.locator('[role="grid"] canvas[data-state="rendered"]').first()).toBeVisible({
    timeout: 20_000,
  });
  await page.waitForTimeout(600);
  await shot('m0-shell-arrange-1440.png');
  // Read at 1024 last: widening the window again leaves page 1 blank in Read at HEAD.
  await page.locator('body').press('1');
  await page.setViewportSize(narrow);
  await expect(
    page.locator('[data-read-viewport] [data-page-index="0"] canvas[data-state="rendered"]'),
  ).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(600);
  await shot('m0-shell-read-1024.png');
  await page.setViewportSize(wide);

  // Two documents, as in the first integration frames.
  await page.goto('./?lang=en');
  await openFixtures(page, ['outline-named-dests.pdf', 'rotated-pages.pdf']);
  await page.getByRole('tab', { name: 'outline-named-dests' }).click();
  await page.locator('body').press('1');
  await expect(rendered.first()).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(400);
  await shot('m0-integration-read-1440.png');
  await page.locator('body').press('2');
  await expect(page.locator('[role="grid"] canvas[data-state="rendered"]').first()).toBeVisible({
    timeout: 20_000,
  });
  await page.waitForTimeout(600);
  await shot('m0-integration-arrange-1440.png');
});
