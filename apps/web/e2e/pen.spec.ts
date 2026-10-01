/**
 * The pen end to end (experience-redesign spec §6.6, §11), in Chromium through CDP: a pen
 * stroke with force rising from 0.2 to 1.0 is drawn thinner at its start than at its end
 * and commits widths that rise along it; after a pen has been seen, a one-finger touch drag
 * scrolls the stage and adds no annotation.
 */
import { type CDPSession, expect, type Page, test } from '@playwright/test';

import { openFixtures, recordInkWidths, sentInkWidths, useFileInputPicker } from './helpers';

function layer(page: Page, index = 0) {
  return page.locator(`[data-annotation-layer="${index}"]`);
}

/** Vertical extent (CSS px) of the live preview's painted pixels in the column at layer x. */
async function previewThickness(page: Page, x: number): Promise<number> {
  return page.evaluate((cssX) => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      '[data-annotation-layer="0"] canvas[data-ink-preview="live"]',
    );
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return -1;
    const scale = canvas.width / Number.parseFloat(canvas.style.width);
    const column = Math.round((cssX - Number.parseFloat(canvas.style.left)) * scale);
    if (column < 0 || column >= canvas.width) return -1;
    const data = ctx.getImageData(column, 0, 1, canvas.height).data;
    let painted = 0;
    for (let i = 3; i < data.length; i += 4) if ((data[i] ?? 0) > 128) painted++;
    return painted / scale;
  }, x);
}

async function penStroke(
  cdp: CDPSession,
  from: { x: number; y: number },
  to: { x: number; y: number },
  steps: number,
  beforeRelease?: () => Promise<void>,
): Promise<void> {
  const at = (t: number) => ({
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
  });
  const pen = { pointerType: 'pen' as const, button: 'left' as const };
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    ...at(0),
    ...pen,
    buttons: 1,
    clickCount: 1,
    force: 0.2,
  });
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      ...at(t),
      ...pen,
      buttons: 1,
      force: 0.2 + 0.8 * t,
    });
  }
  await beforeRelease?.();
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    ...at(1),
    ...pen,
    buttons: 0,
    clickCount: 1,
    force: 0,
  });
}

test.describe('pen', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test.beforeEach(async ({ page }) => {
    await useFileInputPicker(page);
    await recordInkWidths(page);
  });

  test('pressure: thinner at the start than at the end; then a finger scrolls', async ({
    browserName,
    page,
  }) => {
    test.skip(browserName !== 'chromium', 'Pen and touch input through CDP (Chromium)');
    await page.goto('./');
    await openFixtures(page, ['simple-text.pdf']);
    await expect(page.locator('canvas[data-state="rendered"]').first()).toBeAttached({
      timeout: 20_000,
    });
    await page.locator('body').press('p');
    await expect(layer(page)).toHaveAttribute('data-tool', 'ink');
    const box = await layer(page).boundingBox();
    if (!box) throw new Error('page not rendered');
    const cdp = await page.context().newCDPSession(page);

    const from = { x: box.x + box.width * 0.2, y: box.y + Math.min(box.height, 800) * 0.45 };
    const to = { x: box.x + box.width * 0.7, y: from.y + 6 };
    let start = 0;
    let end = 0;
    await penStroke(cdp, from, to, 40, async () => {
      // What the preview draws, before release: thin where the force was low.
      const along = (t: number) => from.x + (to.x - from.x) * t - box.x;
      start = await previewThickness(page, along(0.08));
      end = await previewThickness(page, along(0.92));
    });
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start * 1.5);

    const ink = layer(page).locator('[data-annotation-kind="ink"]');
    await expect(ink).toHaveCount(1, { timeout: 10_000 });
    // The committed widths, point for point, rise along the stroke.
    const sent = await sentInkWidths(page);
    expect(sent).toHaveLength(1);
    const widths = sent[0]?.[0] ?? [];
    expect(widths.length).toBeGreaterThan(1);
    for (let i = 1; i < widths.length; i++) {
      expect(widths[i]).toBeGreaterThanOrEqual((widths[i - 1] ?? 0) - 0.01);
    }
    expect(widths.at(-1) ?? 0).toBeGreaterThan((widths[0] ?? 0) * 1.8);
    await expect(page.getByTestId('annotation-bar')).toHaveCount(0);

    // A pen has been seen: one finger pans the stage (after the 300 ms palm window).
    await page.waitForTimeout(400);
    const viewport = page.locator('[data-read-viewport]');
    const before = await viewport.evaluate((el) => el.scrollTop);
    // On the page, clear of the floating tool bar at the bottom of the window.
    const finger = { x: box.x + box.width * 0.5, y: 600 };
    const touch = (y: number) => [{ x: finger.x, y, radiusX: 5, radiusY: 5, force: 1, id: 1 }];
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: touch(finger.y),
    });
    for (let i = 1; i <= 10; i++) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: touch(finger.y - i * 20),
      });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBeGreaterThan(before + 150);
    await page.waitForTimeout(300);
    await expect(ink).toHaveCount(1);
    expect(await sentInkWidths(page)).toHaveLength(1);
    await expect(layer(page).locator('[data-settling]')).toHaveCount(0, { timeout: 5_000 });
  });
});
