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

// ---------------------------------------------------------------------------
// The Edit policy (craft spec §3.5): double-click to edit text, the pen never opens it
// ---------------------------------------------------------------------------

const FOX = 'The quick brown fox jumps over the lazy dog';

/** The text layer's span of the first (Helvetica) line of text-edit-fonts.pdf. */
const foxLine = (page: Page) =>
  page.locator('[data-page-index="0"] [data-testid="text-layer"] span', { hasText: FOX }).first();

async function openFontsFixture(page: Page): Promise<{ x: number; y: number }> {
  await openFixtures(page, ['text-edit-fonts.pdf']);
  await expect(page.locator('canvas[data-state="rendered"]').first()).toBeAttached({
    timeout: 20_000,
  });
  await expect(foxLine(page)).toBeAttached({ timeout: 20_000 });
  const box = await foxLine(page).boundingBox();
  if (!box) throw new Error('line not laid out');
  // On "fox" (a word, not the space after it).
  return { x: box.x + box.width * 0.4, y: box.y + box.height / 2 };
}

test('double-click on text opens the editor in Edit, not in Read', async ({ page }) => {
  const at = await openFontsFixture(page);
  // The line editor, or the paragraph editor where the line is part of a paragraph (T6).
  const editor = page.getByRole('textbox', { name: /^(Line text|Paragraph on page 1)$/ });

  // Read: the double-click selects a word, as on any page; no editor.
  await page.mouse.dblclick(at.x, at.y);
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString().trim() ?? ''))
    .not.toBe('');
  await page.waitForTimeout(400);
  await expect(editor).toHaveCount(0);

  // Edit, with Select: the editor opens with the caret at the point.
  await enterEdit(page);
  await page.mouse.move(at.x, at.y);
  await page.mouse.dblclick(at.x, at.y);
  await expect(editor).toBeFocused({ timeout: 20_000 });
  // A caret at the point, nothing selected (the field's own selection, or the document's
  // inside the paragraph editor's mirror).
  const [start, end] = await editor.evaluate((el) => {
    if (el instanceof HTMLInputElement) return [el.selectionStart ?? -1, el.selectionEnd ?? -1];
    const range = window.getSelection()?.getRangeAt(0);
    return range ? [range.startOffset, range.collapsed ? range.startOffset : -1] : [-1, -2];
  });
  expect(end).toBe(start);
  if ((await editor.getAttribute('aria-label')) === 'Line text') {
    await expect(editor).toHaveValue(FOX);
    expect(start).toBeGreaterThan(FOX.length * 0.25);
    expect(start).toBeLessThan(FOX.length * 0.65);
  }
  // The Select tool stays armed; Esc leaves without a change.
  await expect(page.locator('[data-annotation-layer="0"]')).toHaveAttribute('data-tool', 'select');
  await editor.press('Escape');
  await expect(editor).toHaveCount(0);
  await expect(foxLine(page)).toHaveText(FOX);
});

test('a pen stroke over text never opens the editor', async ({ page }) => {
  const at = await openFontsFixture(page);
  await enterEdit(page);
  const editor = page.getByRole('textbox', { name: /^(Line text|Paragraph on page 1)$/ });
  const layer = page.locator('[data-annotation-layer="0"]');

  // A pen (synthetic pointer events: Playwright has no pen): it hovers, which turns
  // "Pen draws in Edit" on, then writes across the line, then taps twice on it.
  await page.evaluate(
    async ({ x, y }) => {
      const pen = (type: string, px: number, init: PointerEventInit = {}) =>
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerType: 'pen',
          pointerId: 7,
          isPrimary: true,
          clientX: px,
          clientY: y,
          pressure: 0.5,
          button: 0,
          buttons: 1,
          ...init,
        });
      const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      const under = () => document.elementFromPoint(x, y) ?? document.body;
      under().dispatchEvent(pen('pointermove', x, { buttons: 0, pressure: 0 }));
      await pause(200);
      under().dispatchEvent(pen('pointerdown', x - 60));
      for (let i = 1; i <= 12; i++) {
        window.dispatchEvent(pen('pointermove', x - 60 + i * 10));
        await pause(10);
      }
      window.dispatchEvent(pen('pointerup', x + 60, { buttons: 0, pressure: 0 }));
      await pause(100);
      for (let i = 0; i < 2; i++) {
        under().dispatchEvent(pen('pointerdown', x));
        window.dispatchEvent(pen('pointerup', x, { buttons: 0, pressure: 0 }));
      }
      under().dispatchEvent(
        new MouseEvent('dblclick', {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          detail: 2,
        }),
      );
    },
    { x: at.x, y: at.y },
  );

  // The pen wrote ink; the text never took the press.
  await expect(layer.locator('[data-annotation-kind="ink"]')).not.toHaveCount(0, {
    timeout: 20_000,
  });
  await page.waitForTimeout(400);
  await expect(editor).toHaveCount(0);
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('');
  await expect(layer).toHaveAttribute('data-tool', 'select');
});
