/**
 * Annotations end to end (spec viewer-annotations §2–§5): draw with the mouse, one history
 * entry per annotation, undo and redo through the engine. Creating never selects
 * (experience-redesign spec §6.1), and a tool style set before drawing is used and
 * remembered (§6.3). Screenshots for the design review with `CAPTURE_SCREENSHOTS=1`
 * (written to docs/design/screenshots/).
 */
import { fileURLToPath } from 'node:url';

import { expect, type Page, test } from '@playwright/test';

import { openFixtures, showInspector, useFileInputPicker } from './helpers';

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

    await page.locator('body').press('r');
    await expect(layer(page)).toHaveAttribute('data-tool', 'rectangle');
    await drag(page, 0, [0.2, 0.3], [0.5, 0.45]);

    const rectangle = layer(page).locator('[data-annotation-kind="square"]');
    await expect(rectangle).toHaveCount(1, { timeout: 10_000 });
    // Creating does not select: no contextual bar (experience-redesign §6.1).
    await expect(page.getByTestId('annotation-bar')).toHaveCount(0);

    await page.keyboard.press('Escape');
    await expect(layer(page)).toHaveAttribute('data-tool', 'select');

    // Selecting it shows the contextual bar; the inspector stays closed (decision 4).
    const square = await rectangle.boundingBox();
    if (!square) throw new Error('rectangle hit target not rendered');
    await page.mouse.click(square.x + 4, square.y + square.height / 2);
    await expect(page.getByTestId('annotation-bar')).toBeVisible();
    await expect(page.locator('#right-panel')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('annotation-bar')).toHaveCount(0);

    await showInspector(page);
    await expect(historyRow(page, /Rectangle on page 1/)).toHaveAttribute('data-state', 'present');

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
    await showInspector(page);
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
    await showInspector(page);
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
    await expect(historyRow(page, /Delete (ink|pen)/)).toBeVisible();

    // Built-in stamp from the Fill & sign group's menu: a one-shot tool, so the eraser comes
    // back and the stamp is not selected (experience-redesign spec §5.2).
    const bar = page.getByRole('toolbar', { name: 'Tools' });
    // The eraser's group (Draw) is shown: its chip returns to the row of groups.
    await bar.getByRole('button', { name: 'Draw: back to all groups' }).click();
    await bar.getByRole('button', { name: 'Fill & sign' }).click();
    await bar.getByRole('button', { name: 'Stamp or image' }).click();
    await page.getByRole('menuitem', { name: 'Draft' }).click();
    await drag(page, 0, [0.7, 0.35], [0.7, 0.35]);
    const stamp = layer(page).locator('[data-annotation-kind="stamp"]');
    await expect(stamp).toHaveCount(1);
    await expect(historyRow(page, /Stamp on page 1/)).toBeVisible();
    await expect(layer(page)).toHaveAttribute('data-tool', 'eraser');
    await expect(page.getByTestId('annotation-bar')).toHaveCount(0);

    // Selected explicitly, Delete removes it; undo brings it back.
    await page.locator('body').press('Escape');
    await expect(layer(page)).toHaveAttribute('data-tool', 'select');
    await stamp.click();
    await expect(page.getByTestId('annotation-bar')).toBeVisible();
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

  test('pen: strokes never select; a colour set before drawing is used after a reload', async ({
    browserName,
    page,
  }) => {
    test.skip(browserName !== 'chromium', 'Covered in Chromium');
    await page.goto('./');
    await openFixtures(page, ['simple-text.pdf']);
    await expect(page.locator('canvas[data-state="rendered"]').first()).toBeAttached({
      timeout: 20_000,
    });
    await showInspector(page);
    // Records any contextual bar or selection outline, however briefly it appears.
    await page.evaluate(() => {
      const seen: string[] = [];
      (window as unknown as { __creationSelected: string[] }).__creationSelected = seen;
      new MutationObserver(() => {
        if (document.querySelector('[data-testid="annotation-bar"]')) seen.push('bar');
        if (document.querySelector('[data-selected-annotation]')) seen.push('selection');
      }).observe(document.body, { childList: true, subtree: true, attributes: true });
    });
    const ink = layer(page).locator('[data-annotation-kind="ink"]');
    await page.locator('body').press('p');
    await expect(layer(page)).toHaveAttribute('data-tool', 'ink');
    // Three strokes along one line in one go are one burst (experience-redesign spec §6.4):
    // one Ink, one path per stroke.
    for (const [i, x] of [0.2, 0.35, 0.5].entries()) {
      await drag(page, 0, [x, 0.3], [x + 0.12, 0.31]);
      await expect(ink.locator('polyline')).toHaveCount(i + 1, { timeout: 10_000 });
    }
    await expect(ink).toHaveCount(1);
    await expect(historyRow(page, /Pen on page 1 · 3 strokes/)).toBeVisible();
    await page.waitForTimeout(300);
    expect(
      await page.evaluate(
        () => (window as unknown as { __creationSelected: string[] }).__creationSelected,
      ),
    ).toEqual([]);
    await expect(page.getByTestId('annotation-bar')).toHaveCount(0);
    await expect(layer(page).locator('[data-selected-annotation]')).toHaveCount(0);

    // With the pen armed and nothing selected, the inspector edits the pen's style.
    const inspector = page.locator('#right-panel');
    if (!(await inspector.isVisible())) await page.keyboard.press('ControlOrMeta+Alt+b');
    const penStyle = inspector.getByRole('region', { name: /tool style$/ });
    await penStyle.getByRole('radio', { name: 'Blue' }).click();
    await expect(penStyle.getByRole('radio', { name: 'Blue' })).toHaveAttribute(
      'aria-checked',
      'true',
    );

    await page.reload();
    await openFixtures(page, ['simple-text.pdf']);
    await expect(page.locator('canvas[data-state="rendered"]').first()).toBeAttached({
      timeout: 20_000,
    });
    await page.locator('body').press('p');
    await expect(layer(page)).toHaveAttribute('data-tool', 'ink');
    if (!(await inspector.isVisible())) await page.keyboard.press('ControlOrMeta+Alt+b');
    await expect(penStyle.getByRole('radio', { name: 'Blue' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await drag(page, 0, [0.25, 0.5], [0.6, 0.5]);
    await expect(ink).toHaveCount(1, { timeout: 10_000 });
    await expect(page.getByTestId('annotation-bar')).toHaveCount(0);

    // Selecting the stroke shows its colour: the remembered blue.
    await page.locator('body').press('Escape');
    await expect(layer(page)).toHaveAttribute('data-tool', 'select');
    const box = await layer(page).boundingBox();
    if (!box) throw new Error('page not rendered');
    await page.mouse.click(box.x + box.width * 0.42, box.y + box.height * 0.5);
    const bar = page.getByTestId('annotation-bar');
    await expect(bar).toBeVisible();
    await expect(bar.getByRole('radio', { name: 'Blue' })).toHaveAttribute('aria-checked', 'true');
  });

  test('screenshots for design review', async ({ browserName, page }) => {
    test.skip(!capture || browserName !== 'chromium', 'Set CAPTURE_SCREENSHOTS=1 (Chromium).');
    await page.goto('./');
    await openFixtures(page, ['simple-text.pdf']);
    await expect(page.locator('canvas[data-state="rendered"]').first()).toBeAttached({
      timeout: 20_000,
    });
    // With the inspector the page fits above the tool bar and its options tier, so the drags
    // below land on the page.
    await showInspector(page);
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
    // From the text box's group (Mark up) back to the row, then Fill & sign.
    await page.getByRole('button', { name: /: back to all groups$/ }).click();
    await page.getByRole('button', { name: 'Fill & sign' }).click();
    await page.getByRole('button', { name: 'Stamp or image' }).click();
    await page.getByRole('menuitem', { name: 'Approved' }).click();
    await drag(page, 0, [0.72, 0.68], [0.72, 0.68]);
    await tool('Escape');
    // A rectangle, then selected (creating does not select), with the contextual bar.
    await tool('r');
    await drag(page, 0, [0.12, 0.5], [0.45, 0.62]);
    await tool('Escape');
    const square = await layer(page).locator('[data-annotation-kind="square"]').boundingBox();
    if (!square) throw new Error('rectangle hit target not rendered');
    await page.mouse.click(square.x + 4, square.y + square.height / 2);
    await expect(page.getByTestId('annotation-bar')).toBeVisible();
    await page.waitForTimeout(600);
    await page.screenshot({
      path: fileURLToPath(new URL('m2-annotations-1440.png', screenshots)),
    });

    await tool('Escape');
    await tool('Escape');
    await page.getByRole('tab', { name: /^Review/ }).click();
    await expect(page.getByText('Check these figures against the Q3 report.')).toBeVisible();
    await page.waitForTimeout(400);
    await page.screenshot({
      path: fileURLToPath(new URL('m2-comments-1440.png', screenshots)),
    });
  });

  test('screenshots of the pen, the Review tab and the lasso (design review)', async ({
    browserName,
    page,
  }) => {
    test.skip(!capture || browserName !== 'chromium', 'Set CAPTURE_SCREENSHOTS=1 (Chromium).');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('./?lang=en');
    await openFixtures(page, ['simple-text.pdf']);
    await expect(page.locator('canvas[data-state="rendered"]').first()).toBeAttached({
      timeout: 20_000,
    });
    const box = await layer(page).boundingBox();
    if (!box) throw new Error('page not rendered');
    const at = (fx: number, fy: number) => ({
      x: box.x + box.width * fx,
      y: box.y + box.width * fy,
    });
    /** One mouse stroke through page fractions (y as a share of the page width). */
    const stroke = async (points: readonly [number, number][]) => {
      const [first, ...rest] = points;
      if (!first) return;
      await page.mouse.move(at(...first).x, at(...first).y);
      await page.mouse.down();
      for (const p of rest) await page.mouse.move(at(...p).x, at(...p).y, { steps: 2 });
      await page.mouse.up();
    };
    /** Handwriting-like loops (a prolate cycloid) from x0, `loops` of them. */
    const loops = (x0: number, y: number, count: number) =>
      Array.from({ length: count * 16 + 1 }, (_, i): [number, number] => {
        const t = (i / 16) * 2 * Math.PI;
        return [x0 + 0.0045 * (t - 1.7 * Math.sin(t)), y - 0.011 * Math.cos(t)];
      });
    const ink = layer(page).locator('[data-annotation-kind="ink"]');

    // The Draw group: four presets as ink dots, then Eraser, Lasso and Shapes.
    const bar = page.getByRole('toolbar', { name: 'Tools' });
    await bar.getByRole('button', { name: 'Draw', exact: true }).click();
    const presets = bar.getByRole('radiogroup', { name: 'Pen presets' });
    // Yellow highlighter over "quick brown".
    await presets.getByRole('radio', { name: /^Yellow highlighter/ }).click();
    await stroke([
      [0.165, 0.243],
      [0.29, 0.243],
    ]);
    await expect(ink).toHaveCount(1, { timeout: 10_000 });
    // Red: a ring around "lazy dog".
    await page.waitForTimeout(1700);
    await presets.getByRole('radio', { name: /^Red pen/ }).click();
    await stroke(
      Array.from({ length: 48 }, (_, i): [number, number] => {
        const a = (i / 44) * 2 * Math.PI - 2.6;
        return [0.468 + 0.072 * Math.cos(a), 0.243 + 0.026 * Math.sin(a)];
      }),
    );
    await expect(ink).toHaveCount(2, { timeout: 10_000 });
    // Blue: a handwritten line in three strokes, one burst.
    await page.waitForTimeout(1700);
    await presets.getByRole('radio', { name: /^Blue pen/ }).click();
    await stroke(loops(0.12, 0.36, 6));
    await stroke(loops(0.32, 0.36, 4));
    // The underline sits close under the loops: a gap of more than 0.6 of the median stroke
    // height would start a new line, and so a new burst (bursts.ts, `onBurstLine`).
    await stroke([
      [0.12, 0.379],
      [0.3, 0.381],
      [0.47, 0.377],
    ]);
    await expect(ink).toHaveCount(3, { timeout: 10_000 });
    await expect(ink.last().locator('polyline')).toHaveCount(3);
    await page.mouse.move(720, 600);
    await page.waitForTimeout(400);
    await page.screenshot({
      path: fileURLToPath(new URL('m6-draw-presets-1440.png', screenshots)),
    });

    // A note, then the Review tab: one row per burst.
    await page.waitForTimeout(1700);
    await page.locator('body').press('n');
    await drag(page, 0, [0.86, 0.36], [0.86, 0.36]);
    await page
      .getByRole('dialog', { name: 'New note' })
      .getByRole('textbox')
      .fill('Check these figures against the Q3 report.');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.locator('body').press('Escape');
    await page.getByRole('tab', { name: /^Review/ }).click();
    await expect(page.locator('[data-review-panel] [data-annotation-row]')).toHaveCount(4);
    await page.mouse.move(720, 600);
    await page.waitForTimeout(400);
    await page.screenshot({
      path: fileURLToPath(new URL('m6-navigator-review-1440.png', screenshots)),
    });

    // The lasso around the last two strokes of the handwritten line.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.locator('body').press('q');
    await expect(layer(page)).toHaveAttribute('data-tool', 'lasso');
    await stroke([
      [0.312, 0.325],
      [0.5, 0.325],
      [0.5, 0.41],
      [0.312, 0.41],
      [0.312, 0.33],
    ]);
    const lasso = page.locator('[data-lasso-bar]');
    await expect(lasso).toBeVisible();
    await page.mouse.move(720, 700);
    await page.waitForTimeout(400);
    await page.screenshot({
      path: fileURLToPath(new URL('m6-lasso-1440.png', screenshots)),
    });
  });
});
