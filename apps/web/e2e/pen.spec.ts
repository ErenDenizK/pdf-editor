/**
 * The pen end to end (experience-redesign spec §6.6, §11), in Chromium through CDP: a pen
 * stroke with force rising from 0.2 to 1.0 is drawn thinner at its start than at its end
 * and commits widths that rise along it; after a pen has been seen, a one-finger touch drag
 * scrolls the stage and adds no annotation. Presets (§6.2): the Draw group's dots, an armed
 * preset survives a reload and an edit changes the next stroke; bursts (§6.4): two quick
 * strokes are one annotation and one Review row, a stroke after N + 200 ms another.
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

/**
 * Style of every ink sent to the engine worker (create and update payloads), recorded like
 * `recordInkWidths`: the colour and nominal width the pen committed.
 */
async function recordInkStyles(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const found: { color: string; strokeWidth: number; paths: number }[] = [];
    (window as unknown as { __inkStyles: typeof found }).__inkStyles = found;
    const collect = (value: unknown, depth: number): void => {
      if (typeof value !== 'object' || value === null || depth > 8) return;
      if (Array.isArray(value)) {
        for (const item of value) collect(item, depth + 1);
        return;
      }
      if (Object.getPrototypeOf(value) !== Object.prototype) return;
      const record = value as Record<string, unknown>;
      if (
        record.kind === 'ink' &&
        typeof record.color === 'string' &&
        Array.isArray(record.paths)
      ) {
        found.push({
          color: record.color.toUpperCase(),
          strokeWidth: Number(record.strokeWidth),
          paths: record.paths.length,
        });
        return;
      }
      for (const key of Object.keys(record)) collect(record[key], depth + 1);
    };
    const post = Object.getOwnPropertyDescriptor(Worker.prototype, 'postMessage')?.value as (
      this: Worker,
      ...args: unknown[]
    ) => void;
    Worker.prototype.postMessage = function (this: Worker, ...args: unknown[]) {
      try {
        collect(args[0], 0);
      } catch {
        // Recording must never break the message.
      }
      post.apply(this, args);
    } as Worker['postMessage'];
  });
}

async function lastInkStyle(page: Page) {
  return page.evaluate(() =>
    (
      window as unknown as { __inkStyles?: { color: string; strokeWidth: number; paths: number }[] }
    ).__inkStyles?.at(-1),
  );
}

/** A mouse stroke on the first page, between fractions of its box. */
async function mouseStroke(page: Page, from: [number, number], to: [number, number]) {
  const box = await layer(page).boundingBox();
  if (!box) throw new Error('page not rendered');
  const height = Math.min(box.height, 800);
  await page.mouse.move(box.x + box.width * from[0], box.y + height * from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * to[0], box.y + height * to[1], { steps: 10 });
  await page.mouse.up();
}

async function openSimple(page: Page): Promise<void> {
  await page.goto('./');
  await openFixtures(page, ['simple-text.pdf']);
  await expect(page.locator('canvas[data-state="rendered"]').first()).toBeAttached({
    timeout: 20_000,
  });
}

test.describe('pen presets and bursts', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test.beforeEach(async ({ page }) => {
    await useFileInputPicker(page);
    await recordInkStyles(page);
  });

  test('presets in the Draw group: arm blue, draw, reload, still blue; an edit changes the next stroke', async ({
    page,
  }) => {
    await openSimple(page);
    const bar = page.getByRole('toolbar', { name: 'Tools' });
    await bar.getByRole('button', { name: 'Draw', exact: true }).click();
    const presets = bar.getByRole('radiogroup', { name: 'Pen presets' });
    await expect(presets.getByRole('radio')).toHaveCount(4);
    await expect(presets.getByRole('radio', { name: 'Black pen, 1.5 pt' })).toBeVisible();
    await expect(presets.getByRole('radio', { name: 'Yellow highlighter, 12 pt' })).toBeVisible();
    const blue = presets.getByRole('radio', { name: 'Blue pen, 1.5 pt' });
    await blue.click();
    await expect(layer(page)).toHaveAttribute('data-tool', 'ink');
    await expect(blue).toHaveAttribute('aria-checked', 'true');
    await expect(blue).toHaveAttribute('data-armed', '');
    // Arming opens nothing.
    await expect(page.getByTestId('pen-preset-editor')).toHaveCount(0);

    const ink = layer(page).locator('[data-annotation-kind="ink"]');
    await mouseStroke(page, [0.2, 0.3], [0.5, 0.31]);
    await expect(ink).toHaveCount(1, { timeout: 10_000 });
    expect(await lastInkStyle(page)).toMatchObject({ color: '#1760EE', strokeWidth: 1.5 });

    await page.reload();
    await openSimple(page);
    await page.locator('body').press('p');
    await expect(layer(page)).toHaveAttribute('data-tool', 'ink');
    const again = page
      .getByRole('radiogroup', { name: 'Pen presets' })
      .getByRole('radio', { name: 'Blue pen, 1.5 pt' });
    await expect(again).toHaveAttribute('aria-checked', 'true');
    await expect(again).toHaveAttribute('data-armed', '');
    await mouseStroke(page, [0.2, 0.3], [0.5, 0.31]);
    await expect(ink).toHaveCount(1, { timeout: 10_000 });
    expect(await lastInkStyle(page)).toMatchObject({ color: '#1760EE', strokeWidth: 1.5 });

    // The armed preset again: its editor; a width stop changes the next stroke.
    await again.click();
    const editor = page.getByRole('dialog', { name: 'Edit Blue pen' });
    await expect(editor).toBeVisible();
    await editor.getByRole('radio', { name: '5 pt', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(editor).toHaveCount(0);
    await expect(layer(page)).toHaveAttribute('data-tool', 'ink');
    await mouseStroke(page, [0.2, 0.7], [0.5, 0.71]);
    await expect(ink).toHaveCount(2, { timeout: 10_000 });
    expect(await lastInkStyle(page)).toMatchObject({ color: '#1760EE', strokeWidth: 5 });
  });

  test('two quick strokes are one annotation and one Review row; a later one is another', async ({
    page,
  }) => {
    await openSimple(page);
    await page.locator('body').press('p');
    await expect(layer(page)).toHaveAttribute('data-tool', 'ink');
    const ink = layer(page).locator('[data-annotation-kind="ink"]');
    await mouseStroke(page, [0.2, 0.4], [0.35, 0.41]);
    await mouseStroke(page, [0.38, 0.4], [0.5, 0.41]);
    await expect(ink.locator('polyline')).toHaveCount(2, { timeout: 10_000 });
    await expect(ink).toHaveCount(1);
    expect(await lastInkStyle(page)).toMatchObject({ paths: 2 });

    const review = page.getByRole('tab', { name: /^Review/ });
    if ((await review.getAttribute('aria-selected')) !== 'true') await review.click();
    const rows = page.locator('[data-review-panel] [data-annotation-row]');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Pen · 2 strokes');

    // After the pause (N = 1,500 ms) plus 200 ms, a stroke is its own annotation.
    await page.waitForTimeout(1700);
    await mouseStroke(page, [0.2, 0.45], [0.35, 0.46]);
    await expect(ink).toHaveCount(2, { timeout: 10_000 });
    await expect(rows).toHaveCount(2);
  });
});

test.describe('lasso', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test.beforeEach(async ({ page }) => {
    await useFileInputPicker(page);
  });

  test('Q, a lasso around a stroke, the bar, Delete removes it', async ({ page }) => {
    await page.goto('./');
    await openFixtures(page, ['simple-text.pdf']);
    await expect(page.locator('canvas[data-state="rendered"]').first()).toBeAttached({
      timeout: 20_000,
    });
    await page.locator('body').press('p');
    await expect(layer(page)).toHaveAttribute('data-tool', 'ink');
    const box = await layer(page).boundingBox();
    if (!box) throw new Error('page not rendered');
    const y = box.y + Math.min(box.height, 800) * 0.45;
    const x0 = box.x + box.width * 0.3;
    const x1 = box.x + box.width * 0.5;
    await page.mouse.move(x0, y);
    await page.mouse.down();
    await page.mouse.move(x1, y + 8, { steps: 12 });
    await page.mouse.up();
    const ink = layer(page).locator('[data-annotation-kind="ink"]');
    await expect(ink).toHaveCount(1, { timeout: 10_000 });

    await page.locator('body').press('q');
    await expect(layer(page)).toHaveAttribute('data-tool', 'lasso');
    // A loop around the stroke, starting and ending left of it.
    const loop = [
      { x: x0 - 30, y: y - 30 },
      { x: x1 + 30, y: y - 30 },
      { x: x1 + 30, y: y + 40 },
      { x: x0 - 30, y: y + 40 },
      { x: x0 - 30, y: y - 25 },
    ];
    await page.mouse.move(loop[0]?.x ?? 0, loop[0]?.y ?? 0);
    await page.mouse.down();
    for (const p of loop.slice(1)) await page.mouse.move(p.x, p.y, { steps: 8 });
    await page.mouse.up();

    const bar = page.locator('[data-lasso-bar]');
    await expect(bar).toBeVisible();
    await expect(bar).toContainText('1 stroke');
    await expect(layer(page).locator('[data-lasso-path]')).toHaveCount(1);

    await page.keyboard.press('Delete');
    await expect(ink).toHaveCount(0, { timeout: 10_000 });
    await expect(bar).toHaveCount(0);
    await expect(layer(page)).toHaveAttribute('data-tool', 'lasso');
  });
});

/** Points (CSS px) of every ink path on the first page, as the layer draws them. */
async function inkPoints(page: Page): Promise<number[][][]> {
  return layer(page)
    .locator('[data-annotation-kind="ink"] polyline')
    .evaluateAll((lines) =>
      lines.map((line) =>
        (line.getAttribute('points') ?? '')
          .trim()
          .split(/\s+/)
          .map((pair) => pair.split(',').map(Number)),
      ),
    );
}

function expectSamePoints(actual: number[][][], expected: number[][][], tolerance = 0.5): void {
  expect(actual.map((path) => path.length)).toEqual(expected.map((path) => path.length));
  actual.forEach((path, i) =>
    path.forEach(([x = 0, y = 0], j) => {
      const [ex = 0, ey = 0] = expected[i]?.[j] ?? [];
      expect(Math.abs(x - ex), `path ${i} point ${j} x`).toBeLessThanOrEqual(tolerance);
      expect(Math.abs(y - ey), `path ${i} point ${j} y`).toBeLessThanOrEqual(tolerance);
    }),
  );
}

/** Share of dark pixels (ink) in a region of the screen, decoded in the page. */
async function darkShare(
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
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) {
      if ((data[i] ?? 0) + (data[i + 1] ?? 0) + (data[i + 2] ?? 0) < 3 * 120) dark++;
    }
    return dark / (data.length / 4);
  }, png.toString('base64'));
}

test.describe('pen: width changes, zoom, Draw, lines and undo', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test.beforeEach(async ({ page }) => {
    await useFileInputPicker(page);
    await recordInkWidths(page);
  });

  test('a width change on a whole burst thickens it, scales its widths and moves no point', async ({
    page,
  }) => {
    await openSimple(page);
    await page.locator('body').press('p');
    await expect(layer(page)).toHaveAttribute('data-tool', 'ink');
    const ink = layer(page).locator('[data-annotation-kind="ink"]');
    await mouseStroke(page, [0.2, 0.55], [0.35, 0.56]);
    await mouseStroke(page, [0.37, 0.55], [0.5, 0.56]);
    await expect(ink.locator('polyline')).toHaveCount(2, { timeout: 10_000 });
    await expect(ink).toHaveCount(1);
    await expect(layer(page).locator('[data-settling]')).toHaveCount(0, { timeout: 5_000 });
    const before = await inkPoints(page);
    const widthsBefore = (await sentInkWidths(page)).at(-1) ?? [];
    expect(widthsBefore).toHaveLength(2);
    const box = await layer(page).boundingBox();
    if (!box) throw new Error('page not rendered');
    const height = Math.min(box.height, 800);
    const clip = {
      x: box.x + box.width * 0.18,
      y: box.y + height * 0.55 - 20,
      width: box.width * 0.34,
      height: 48,
    };
    const thin = await darkShare(page, clip);
    expect(thin).toBeGreaterThan(0);

    // The Select tool: the whole annotation, its bar's width slider 1.5 → 6.5 pt.
    await page.keyboard.press('Escape');
    await page.locator('body').press('v');
    const first = before[0]?.[Math.floor((before[0]?.length ?? 0) / 2)] ?? [0, 0];
    await page.mouse.click(box.x + (first[0] ?? 0), box.y + (first[1] ?? 0));
    const bar = page.getByTestId('annotation-bar');
    await expect(bar).toBeVisible();
    const slider = bar.getByRole('slider', { name: /^Stroke width/ });
    await slider.fill('6.5');
    await expect(slider).toHaveValue('6.5');
    await page.keyboard.press('Escape');
    await expect(bar).toHaveCount(0);
    // The stored widths scale with /BS /W, so the drawn stroke gets thicker.
    await expect.poll(() => darkShare(page, clip), { timeout: 10_000 }).toBeGreaterThan(thin * 2);
    const widthsAfter = (await sentInkWidths(page)).at(-1) ?? [];
    widthsAfter.forEach((path, i) =>
      path.forEach((w, j) => {
        const ratio = w / (widthsBefore[i]?.[j] ?? 1);
        expect(Math.abs(ratio - 6.5 / 1.5), `width ${i}.${j}`).toBeLessThan(0.05);
      }),
    );
    expectSamePoints(await inkPoints(page), before);

    // The Lasso around both strokes: another width change, and still no point moves.
    await page.locator('body').press('q');
    await expect(layer(page)).toHaveAttribute('data-tool', 'lasso');
    const loop = [
      { x: clip.x - 10, y: clip.y - 10 },
      { x: clip.x + clip.width + 10, y: clip.y - 10 },
      { x: clip.x + clip.width + 10, y: clip.y + clip.height + 10 },
      { x: clip.x - 10, y: clip.y + clip.height + 10 },
      { x: clip.x - 10, y: clip.y - 6 },
    ];
    await page.mouse.move(loop[0]?.x ?? 0, loop[0]?.y ?? 0);
    await page.mouse.down();
    for (const p of loop.slice(1)) await page.mouse.move(p.x, p.y, { steps: 8 });
    await page.mouse.up();
    const lassoBar = page.locator('[data-lasso-bar]');
    await expect(lassoBar).toContainText('2 strokes');
    const sent = (await sentInkWidths(page)).length;
    const lassoWidth = lassoBar.getByRole('slider', { name: /^Stroke width/ });
    await lassoWidth.fill('4.5');
    await expect(lassoWidth).toHaveValue('4.5');
    await page.keyboard.press('Escape');
    await expect
      .poll(async () => (await sentInkWidths(page)).length, { timeout: 10_000 })
      .toBeGreaterThan(sent);
    await page.waitForTimeout(800);
    expectSamePoints(await inkPoints(page), before);
  });

  test('a zoom in the middle of a pen stroke keeps the committed line straight', async ({
    browserName,
    page,
  }) => {
    test.skip(browserName !== 'chromium', 'Pen input through CDP (Chromium)');
    await openSimple(page);
    await page.locator('body').press('p');
    await expect(layer(page)).toHaveAttribute('data-tool', 'ink');
    const box = await layer(page).boundingBox();
    if (!box) throw new Error('page not rendered');
    const cdp = await page.context().newCDPSession(page);
    const pen = { pointerType: 'pen' as const, button: 'left' as const };
    const y = box.y + Math.min(box.height, 800) * 0.55;
    const x0 = box.x + box.width * 0.2;
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: x0,
      y,
      ...pen,
      buttons: 1,
      clickCount: 1,
      force: 0.5,
    });
    for (let i = 1; i <= 10; i++) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: x0 + i * 10,
        y,
        ...pen,
        buttons: 1,
        force: 0.5,
      });
    }
    // The page zooms in under the pen; the pen goes on along the same line of the page,
    // which is now somewhere else on the screen.
    await page.keyboard.press('Control+Equal');
    await expect
      .poll(async () => (await layer(page).boundingBox())?.width ?? 0)
      .toBeGreaterThan(box.width * 1.05);
    const zoomed = await layer(page).boundingBox();
    if (!zoomed) throw new Error('page not rendered');
    const k = zoomed.width / box.width;
    const onPage = (sx: number, sy: number) => ({
      x: zoomed.x + (sx - box.x) * k,
      y: zoomed.y + (sy - box.y) * k,
    });
    for (let i = 11; i <= 20; i++) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        ...onPage(x0 + i * 10, y),
        ...pen,
        buttons: 1,
        force: 0.5,
      });
    }
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      ...onPage(x0 + 200, y),
      ...pen,
      buttons: 0,
      clickCount: 1,
      force: 0,
    });
    const ink = layer(page).locator('[data-annotation-kind="ink"]');
    await expect(ink).toHaveCount(1, { timeout: 10_000 });
    const [path = []] = await inkPoints(page);
    // A straight stroke simplifies to its two ends; a bent one keeps the corner. The stroke
    // must still span both halves: 200 CSS px of a 612 pt page at the first zoom.
    expect(path.length).toBeGreaterThanOrEqual(2);
    const ys = path.map(([, py = 0]) => py);
    const [ax = 0, ay = 0] = path[0] ?? [];
    const [bx = 0, by = 0] = path.at(-1) ?? [];
    expect(Math.abs(bx - ax)).toBeGreaterThan(0.8 * ((200 * 612) / box.width));
    // One straight segment per zoom: every point lies on the line through the ends.
    for (const [px = 0, py = 0] of path) {
      const t = (px - ax) / (bx - ax || 1);
      expect(Math.abs(py - (ay + (by - ay) * t)), `y at x ${px}`).toBeLessThan(2);
    }
    // Horizontal on the page: no step where the zoom changed.
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(2);
  });

  test('picking Draw arms the pen: the first stroke draws', async ({ page }) => {
    await openSimple(page);
    const bar = page.getByRole('toolbar', { name: 'Tools' });
    await bar.getByRole('button', { name: 'Draw', exact: true }).click();
    await expect(layer(page)).toHaveAttribute('data-tool', 'ink');
    const black = bar.getByRole('radio', { name: 'Black pen, 1.5 pt' });
    await expect(black).toHaveAttribute('data-armed', '');
    await mouseStroke(page, [0.2, 0.3], [0.5, 0.31]);
    await expect(layer(page).locator('[data-annotation-kind="ink"]')).toHaveCount(1, {
      timeout: 10_000,
    });
    // Another Draw tool: no preset ring.
    await page.locator('body').press('q');
    await expect(layer(page)).toHaveAttribute('data-tool', 'lasso');
    await expect(bar.locator('[data-pen-preset][data-armed]')).toHaveCount(0);
  });

  test('the next line is a new burst; Ctrl+Z inside a burst removes its last stroke only', async ({
    page,
  }) => {
    await openSimple(page);
    await page.locator('body').press('p');
    await expect(layer(page)).toHaveAttribute('data-tool', 'ink');
    const ink = layer(page).locator('[data-annotation-kind="ink"]');
    // Line one: two strokes. Line two, about 20 pt lower: two more, a burst of its own.
    await mouseStroke(page, [0.2, 0.5], [0.3, 0.503]);
    await mouseStroke(page, [0.32, 0.5], [0.42, 0.503]);
    await mouseStroke(page, [0.2, 0.53], [0.3, 0.533]);
    await mouseStroke(page, [0.32, 0.53], [0.42, 0.533]);
    await expect(ink.locator('polyline')).toHaveCount(4, { timeout: 10_000 });
    await expect(ink).toHaveCount(2);

    // The second line's burst is open: Ctrl+Z takes its last stroke only.
    await page.keyboard.press('ControlOrMeta+z');
    await expect(ink.locator('polyline')).toHaveCount(3, { timeout: 10_000 });
    await expect(ink).toHaveCount(2);
    // One stroke left in it: the ordinary undo removes that annotation.
    await page.keyboard.press('ControlOrMeta+z');
    await expect(ink).toHaveCount(1, { timeout: 10_000 });
    await expect(ink.locator('polyline')).toHaveCount(2);
  });
});
