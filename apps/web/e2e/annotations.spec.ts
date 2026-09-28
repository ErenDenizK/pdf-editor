/**
 * Annotations end to end (spec viewer-annotations §2–§5): draw with the mouse, one history
 * entry per annotation, undo and redo through the engine. Screenshots for the design
 * review with `CAPTURE_SCREENSHOTS=1` (written to docs/design/screenshots/).
 */
import { fileURLToPath } from 'node:url';

import { expect, type Page, test } from '@playwright/test';

import { openFixtures, useFileInputPicker } from './helpers';

const screenshots = new URL('../../../docs/design/screenshots/', import.meta.url);
const capture = Boolean(process.env.CAPTURE_SCREENSHOTS);

function layer(page: Page, index = 0) {
  return page.locator(`[data-annotation-layer="${index}"]`);
}

/** Drags from one fraction of the page's box to another. */
async function drag(
  page: Page,
  index: number,
  from: [number, number],
  to: [number, number],
): Promise<void> {
  const box = await layer(page, index).boundingBox();
  if (!box) throw new Error('page not rendered');
  await page.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1], { steps: 8 });
  await page.mouse.up();
}

/**
 * Share of note-yellow pixels (the default #FFEB3B) in a region of the screen: decoded in
 * the page, so the test needs no image library.
 */
async function yellowShare(
  page: Page,
  clip: { x: number; y: number; width: number; height: number },
): Promise<number> {
  const png = await page.screenshot({ clip });
  return page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    if (!context) return 0;
    context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let yellow = 0;
    for (let i = 0; i < data.length; i += 4) {
      if ((data[i] ?? 0) > 200 && (data[i + 1] ?? 0) > 190 && (data[i + 2] ?? 255) < 140) yellow++;
    }
    return yellow / (data.length / 4);
  }, png.toString('base64'));
}

function historyRow(page: Page, label: string | RegExp) {
  return page.getByRole('list', { name: /history/i }).getByRole('button', { name: label });
}

test.describe('annotations', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test.beforeEach(async ({ page }) => {
    await useFileInputPicker(page);
  });

  test('draws a rectangle; undo removes it and redo restores it', async ({ browserName, page }) => {
    test.skip(browserName !== 'chromium', 'Covered in Chromium');
    await page.goto('./');
    await openFixtures(page, ['simple-text.pdf']);
    await expect(page.locator('canvas[data-state="rendered"]').first()).toBeAttached({
      timeout: 20_000,
    });

    await page.getByRole('button', { name: /^Shapes/ }).click();
    await page.getByRole('menuitem', { name: 'Rectangle' }).click();
    await expect(layer(page)).toHaveAttribute('data-tool', 'rectangle');
    await drag(page, 0, [0.2, 0.3], [0.5, 0.45]);

    const rectangle = layer(page).locator('[data-annotation-kind="square"]');
    await expect(rectangle).toHaveCount(1, { timeout: 10_000 });
    await expect(historyRow(page, /Rectangle on page 1/)).toHaveAttribute('data-state', 'present');
    await expect(page.getByTestId('annotation-bar')).toBeVisible();

    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(layer(page)).toHaveAttribute('data-tool', 'select');

    await page.keyboard.press('ControlOrMeta+z');
    await expect(rectangle).toHaveCount(0);
    await expect(historyRow(page, /Rectangle on page 1/)).toHaveAttribute('data-state', 'future');

    await page.keyboard.press('ControlOrMeta+Shift+z');
    await expect(rectangle).toHaveCount(1);
    await expect(historyRow(page, /Rectangle on page 1/)).toHaveAttribute('data-state', 'present');
  });

  test('selected text, then U, underlines it', async ({ browserName, page }) => {
    test.skip(browserName !== 'chromium', 'Covered in Chromium');
    await page.goto('./');
    await openFixtures(page, ['simple-text.pdf']);
    const line = page
      .getByTestId('text-layer')
      .first()
      .getByText(/^The quick brown fox/);
    await expect(line).toBeAttached({ timeout: 20_000 });
    await line.click({ clickCount: 3 });
    await page.keyboard.press('u');
    await expect(layer(page).locator('[data-annotation-kind="underline"]')).toHaveCount(1);
    await expect(historyRow(page, /Underline on page 1/)).toBeVisible();
    // The tool did not change: the selection was used.
    await expect(layer(page)).toHaveAttribute('data-tool', 'select');
  });

  test('types a text box, erases an ink stroke, places a built-in stamp', async ({
    browserName,
    page,
  }) => {
    test.skip(browserName !== 'chromium', 'Covered in Chromium');
    await page.goto('./');
    await openFixtures(page, ['simple-text.pdf']);
    await expect(page.locator('canvas[data-state="rendered"]').first()).toBeAttached({
      timeout: 20_000,
    });
    // Text box: click, type, Escape commits.
    await page.locator('body').press('t');
    await drag(page, 0, [0.15, 0.6], [0.15, 0.6]);
    const editor = page.getByRole('textbox', { name: 'Text box text' });
    await expect(editor).toBeFocused();
    await editor.fill('Reviewed');
    await editor.press('Escape');
    await expect(layer(page).locator('[data-annotation-kind="free-text"]')).toHaveCount(1);
    await expect(historyRow(page, /Text box on page 1/)).toBeVisible();

    // Ink, then erase it.
    await page.locator('body').press('Escape');
    await page.locator('body').press('p');
    await drag(page, 0, [0.3, 0.45], [0.6, 0.47]);
    await expect(layer(page).locator('[data-annotation-kind="ink"]')).toHaveCount(1);
    await page.locator('body').press('Shift+E');
    await drag(page, 0, [0.45, 0.4], [0.45, 0.52]);
    await expect(layer(page).locator('[data-annotation-kind="ink"]')).toHaveCount(0);
    await expect(historyRow(page, /Delete ink/)).toBeVisible();

    // Built-in stamp from the tool bar menu.
    await page.getByRole('button', { name: 'Stamp or image' }).click();
    await page.getByRole('menuitem', { name: 'Draft' }).click();
    await drag(page, 0, [0.7, 0.35], [0.7, 0.35]);
    await expect(layer(page).locator('[data-annotation-kind="stamp"]')).toHaveCount(1);
    await expect(historyRow(page, /Stamp on page 1/)).toBeVisible();

    // Delete removes the selected stamp; undo brings it back.
    await page.locator('body').press('Delete');
    await expect(layer(page).locator('[data-annotation-kind="stamp"]')).toHaveCount(0);
    await page.keyboard.press('ControlOrMeta+z');
    await expect(layer(page).locator('[data-annotation-kind="stamp"]')).toHaveCount(1);
  });

  test('a note on a /Rotate 90 page is selectable where its icon is drawn', async ({
    browserName,
    page,
  }) => {
    test.skip(browserName !== 'chromium', 'Covered in Chromium');
    await page.goto('./');
    await openFixtures(page, ['rotated-pages.pdf']);
    await expect(page.locator('canvas[data-state="rendered"]').first()).toBeAttached({
      timeout: 20_000,
    });
    // Page 2 carries /Rotate 90: PDFium draws the NoRotate icon upright from the /Rect's
    // upper-left corner, one icon width right of the /Rect's own footprint.
    await layer(page, 1).scrollIntoViewIfNeeded();
    await page.locator('body').press('n');
    await drag(page, 1, [0.5, 0.4], [0.5, 0.4]);
    await page.getByRole('dialog', { name: 'New note' }).getByRole('textbox').fill('Rotated');
    await page.getByRole('button', { name: 'Save' }).click();
    const note = layer(page, 1).locator('[data-annotation-kind="text"]');
    await expect(note).toHaveCount(1, { timeout: 10_000 });
    await page.locator('body').press('Escape');
    await page.locator('body').press('Escape');
    await page.mouse.move(0, 0);

    const box = await note.boundingBox();
    if (!box) throw new Error('note hit target not rendered');
    // The icon is mostly yellow (black lines, white below the bubble): the hit target
    // covers it once the page has re-rendered with the note.
    await expect.poll(() => yellowShare(page, box), { timeout: 10_000 }).toBeGreaterThan(0.3);
    // Nothing yellow where the plain /Rect would have put the box (left of the icon).
    expect(await yellowShare(page, { ...box, x: box.x - box.width })).toBeLessThan(0.02);

    // Clicking the drawn icon selects the note.
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 3);
    await expect(page.getByTestId('annotation-bar')).toBeVisible();
    await expect(layer(page, 1).locator('[data-selected-annotation]')).toHaveCount(1);
  });

  test('screenshots for design review', async ({ browserName, page }) => {
    test.skip(!capture || browserName !== 'chromium', 'Set CAPTURE_SCREENSHOTS=1 (Chromium).');
    await page.goto('./');
    await openFixtures(page, ['simple-text.pdf']);
    await expect(page.locator('canvas[data-state="rendered"]').first()).toBeAttached({
      timeout: 20_000,
    });
    const tool = async (key: string) => {
      await page.locator('body').press(key);
    };
    // Highlight over the first line of text.
    await tool('h');
    const text = page.getByTestId('text-layer').first();
    await expect(text).toBeAttached({ timeout: 10_000 });
    await drag(page, 0, [0.12, 0.115], [0.45, 0.115]);
    await expect(layer(page).locator('[data-annotation-kind="highlight"]')).toHaveCount(1);
    await tool('Escape');
    // Ink.
    await tool('p');
    const box = await layer(page).boundingBox();
    if (!box) throw new Error('no page');
    await page.mouse.move(box.x + box.width * 0.15, box.y + box.height * 0.3);
    await page.mouse.down();
    for (let i = 0; i <= 24; i++) {
      await page.mouse.move(
        box.x + box.width * (0.15 + i * 0.012),
        box.y + box.height * (0.3 + Math.sin(i / 3) * 0.02),
      );
    }
    await page.mouse.up();
    await expect(layer(page).locator('[data-annotation-kind="ink"]')).toHaveCount(1);
    // Ellipse and arrow.
    await tool('o');
    await drag(page, 0, [0.6, 0.25], [0.85, 0.36]);
    await tool('a');
    await drag(page, 0, [0.55, 0.5], [0.3, 0.42]);
    // A note.
    await tool('n');
    await drag(page, 0, [0.88, 0.12], [0.88, 0.12]);
    await page
      .getByRole('dialog', { name: 'New note' })
      .getByRole('textbox')
      .fill('Check these figures against the Q3 report.');
    await page.getByRole('button', { name: 'Save' }).click();
    // A text box and a stamp.
    await tool('t');
    await drag(page, 0, [0.58, 0.52], [0.9, 0.52]);
    await page.getByRole('textbox', { name: 'Text box text' }).fill('Numbers updated in v2');
    await page.getByRole('textbox', { name: 'Text box text' }).press('Escape');
    await tool('Escape');
    await page.getByRole('button', { name: 'Stamp or image' }).click();
    await page.getByRole('menuitem', { name: 'Approved' }).click();
    await drag(page, 0, [0.72, 0.68], [0.72, 0.68]);
    await tool('Escape');
    // A rectangle, selected, with the contextual bar.
    await tool('r');
    await drag(page, 0, [0.12, 0.5], [0.45, 0.62]);
    await expect(page.getByTestId('annotation-bar')).toBeVisible();
    await page.waitForTimeout(600);
    await page.screenshot({
      path: fileURLToPath(new URL('m2-annotations-1440.png', screenshots)),
    });

    await tool('Escape');
    await tool('Escape');
    await page.getByRole('tab', { name: 'Comments' }).click();
    await expect(page.getByText('Check these figures against the Q3 report.')).toBeVisible();
    await page.waitForTimeout(400);
    await page.screenshot({
      path: fileURLToPath(new URL('m2-comments-1440.png', screenshots)),
    });
  });
});
