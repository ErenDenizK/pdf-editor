/**
 * Document tools end to end (spec document-tools.md §5, §6): compress images.pdf with the
 * Screen preset through the Compress dialog, apply it to the export and download a
 * smaller, complete PDF; export page 1 as a PNG and check its pixel size. The Edit bar's
 * five groups by mouse and keyboard, the page context menu, and the Document menu's sections
 * (experience-redesign spec §5, craft spec §3.4).
 */
import { readFile, stat, writeFile } from 'node:fs/promises';

import {
  concatTransformationMatrix,
  drawObject,
  PDFDocument,
  PDFName,
  popGraphicsState,
  pushGraphicsState,
  StandardFonts,
} from '@cantoo/pdf-lib';
import { expect, type Page, test } from '@playwright/test';

import { enterEdit, fixturePath, openFixtures, useFileInputPicker } from './helpers';

test.skip(
  ({ browserName }) => browserName !== 'chromium',
  'Tool downloads are verified on Chromium',
);

async function setUp(page: Page): Promise<void> {
  // Force the <a download> path: Playwright cannot drive the native save picker.
  await page.addInitScript({
    content:
      "Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });",
  });
  await useFileInputPicker(page);
  await page.goto('./');
  await expect(page.getByTestId('app-shell')).toBeVisible();
  await openFixtures(page, ['images.pdf']);
}

async function openTool(page: Page, name: string): Promise<void> {
  await page.getByTestId('document-menu').click();
  await page.getByRole('menuitem', { name }).click();
}

test('compress images.pdf with the Screen preset and export a smaller PDF', async ({ page }) => {
  await setUp(page);
  const source = await stat(fixturePath('images.pdf'));

  await openTool(page, 'Compress…');
  const dialog = page.getByTestId('compress-dialog');
  await expect(dialog.getByTestId('compress-estimate')).toBeVisible({ timeout: 30_000 });
  // The analysis lists the three images, the transparent one as skipped.
  await expect(dialog.getByRole('table')).toContainText('DeviceRGB + α');
  await dialog.getByText('Screen', { exact: true }).click();
  await expect(dialog.getByRole('radio', { name: /Screen/ })).toBeChecked();
  await dialog.getByRole('button', { name: 'Compress', exact: true }).click();
  await expect(dialog.getByTestId('compress-result')).toBeVisible({ timeout: 30_000 });

  // Compare renders the same page before and after.
  await dialog.getByRole('checkbox', { name: 'Compare before and after' }).check();
  await expect(dialog.getByTestId('compress-compare').locator('canvas')).toHaveCount(2, {
    timeout: 15_000,
  });
  await dialog.getByRole('button', { name: 'Apply to export' }).click();
  await expect(dialog).toBeHidden();

  await page.getByRole('button', { name: 'Export document' }).click();
  const exportDialog = page.getByTestId('export-dialog');
  await expect(exportDialog.getByTestId('export-compression')).toContainText('Screen');
  await exportDialog.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(exportDialog.getByTestId('export-verified')).toBeVisible({ timeout: 30_000 });
  await expect(exportDialog.getByTestId('export-compression')).toContainText('→');

  const downloadPromise = page.waitForEvent('download');
  await exportDialog.getByRole('button', { name: 'Download' }).click();
  const download = await downloadPromise;
  const path = await download.path();
  const bytes = await readFile(path);
  expect(bytes.byteLength).toBeLessThan(source.size);
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  expect(pdf.getPageCount()).toBe(3);
});

test('export page 1 as a PNG with the expected pixel size', async ({ page }) => {
  await setUp(page);
  const fixture = await PDFDocument.load(await readFile(fixturePath('images.pdf')), {
    updateMetadata: false,
  });
  const first = fixture.getPage(0);
  const expectedWidth = Math.round((first.getWidth() * 150) / 72);
  const expectedHeight = Math.round((first.getHeight() * 150) / 72);

  await openTool(page, 'Export pages as images…');
  const dialog = page.getByTestId('images-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Pages' }).fill('1');
  await expect(dialog.getByTestId('images-output')).toHaveText(
    `One image, ${expectedWidth} × ${expectedHeight} px`,
  );
  const downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Export', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('images-1.png');
  const png = await readFile(await download.path());
  // PNG signature, then the IHDR chunk: width and height as big-endian 32-bit integers.
  expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(png.subarray(12, 16).toString('latin1')).toBe('IHDR');
  expect(png.readUInt32BE(16)).toBe(expectedWidth);
  expect(png.readUInt32BE(20)).toBe(expectedHeight);
});

test('the tool bar walks its five groups by mouse and keyboard', async ({ page }) => {
  await setUp(page);
  await enterEdit(page);
  const bar = page.getByRole('toolbar', { name: 'Tools' });
  const groups = ['Select', 'Write', 'Text', 'Fill & sign', 'Redact'];
  // At rest: five labelled groups (ADR-0019 §4, craft spec §3.4).
  await expect(bar.getByRole('button')).toHaveText(groups);
  // Select is the idle tool: the first chip, on while nothing is armed.
  const select = bar.getByRole('button', { name: 'Select', exact: true });
  await expect(select).toHaveAttribute('aria-pressed', 'true');

  // Mouse: each group with tools morphs the bar in place; its chip returns to the row.
  const sample: Readonly<Record<string, string>> = {
    Write: 'Eraser',
    Text: 'Edit text',
    'Fill & sign': 'Signature image',
    Redact: 'Mark for redaction',
  };
  for (const group of Object.keys(sample)) {
    await bar.getByRole('button', { name: group, exact: true }).click();
    const chip = bar.getByRole('button', { name: `${group}: back to all groups` });
    await expect(chip).toBeFocused();
    await expect(
      bar.getByRole('button', { name: sample[group] ?? group, exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: `${group} tools` })).toHaveCount(1);
    await chip.click();
    await expect(bar.getByRole('button')).toHaveText(groups);
  }
  // The Text group holds Edit text, Text box, Note and Image.
  await bar.getByRole('button', { name: 'Text', exact: true }).click();
  for (const name of ['Edit text', 'Text box', 'Note', 'Image']) {
    await expect(bar.getByRole('button', { name, exact: true })).toBeVisible();
  }
  await bar.getByRole('button', { name: 'Text: back to all groups' }).click();
  // Picking Write armed the pen and picking Text Edit text (review finding 3), so Select is
  // off; Select disarms it and the row stays (it has no tool row).
  await expect(page.locator('[data-annotation-layer="0"]')).toHaveAttribute(
    'data-tool',
    'edit-text',
  );
  await expect(select).toHaveAttribute('aria-pressed', 'false');
  await select.click();
  await expect(select).toHaveAttribute('aria-pressed', 'true');
  await expect(bar.getByRole('button')).toHaveText(groups);
  await expect(page.locator('[data-annotation-layer="0"]')).toHaveAttribute('data-tool', 'select');

  // The page operations moved to the page context menu, which names its page.
  const first = await page.locator('[data-page-index="0"]').boundingBox();
  if (!first) throw new Error('page 1 not laid out');
  await page.mouse.click(first.x + 40, first.y + 40, { button: 'right' });
  const pageMenu = page.getByTestId('page-context-menu');
  await expect(pageMenu.getByRole('menuitem', { name: 'Rotate page 1 left' })).toBeVisible();
  await expect(pageMenu.getByRole('menuitem', { name: 'Delete page 1' })).toBeVisible();
  await expect(pageMenu.getByRole('menuitem', { name: /^Edit text here/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(pageMenu).toHaveCount(0);

  // Keyboard: one Tab stop (the group used last), arrows, Enter opens, Esc disarms and returns.
  await expect(bar.locator('button[tabindex="0"]')).toHaveCount(1);
  await select.focus();
  await page.keyboard.press('ArrowRight');
  await expect(bar.getByRole('button', { name: 'Write', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(bar.getByRole('button', { name: 'Write: back to all groups' })).toBeFocused();
  // The pen is its presets (experience-redesign spec §6.2): a radiogroup of ink dots.
  await page.keyboard.press('ArrowRight');
  const presets = bar.getByRole('radiogroup', { name: 'Pen presets' });
  await expect(presets.getByRole('radio', { name: 'Black pen, 1.5 pt' })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  const blue = presets.getByRole('radio', { name: 'Blue pen, 1.5 pt' });
  await expect(blue).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(blue).toHaveAttribute('aria-checked', 'true');
  await expect(blue).toHaveAttribute('data-armed', '');
  await expect(page.locator('[data-annotation-layer="0"]')).toHaveAttribute('data-tool', 'ink');
  // Arming opens nothing; the pen's tier stays hidden until a pen with pressure is seen.
  await expect(page.getByTestId('pen-preset-editor')).toHaveCount(0);
  const tier = page.getByRole('toolbar', { name: 'Pen options' });
  await expect(tier).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(blue).not.toHaveAttribute('data-armed', '');
  await expect(page.locator('[data-annotation-layer="0"]')).toHaveAttribute('data-tool', 'select');
  await page.keyboard.press('Escape');
  await expect(bar.getByRole('button')).toHaveText(groups);
  await expect(bar.getByRole('button', { name: 'Write', exact: true })).toBeFocused();

  // U arms Underline from the keyboard: no group holds it, so the row shows. Its options open
  // only on request: U again (review finding 5).
  await page.locator('body').press('u');
  await expect(page.locator('[data-annotation-layer="0"]')).toHaveAttribute(
    'data-tool',
    'underline',
  );
  await expect(bar.getByRole('button')).toHaveText(groups);
  await expect(page.getByTestId('options-tier')).toHaveCount(0);
  await page.locator('body').press('u');
  await expect(page.getByRole('toolbar', { name: 'Underline options' })).toBeVisible();
  await page.locator('body').press('Escape');
  await expect(page.getByTestId('options-tier')).toHaveCount(0);

  // The Esc ladder from the page (craft spec §3.5): the first Esc disarms to Select, the
  // Eraser and the Lasso included; the second returns the bar to the row. The armed tool's
  // tooltip says so.
  for (const key of ['Shift+E', 'q']) {
    await page.locator('body').press(key);
    await expect(bar).toHaveAttribute('data-bar-view', 'write');
    await page.locator('body').press('Escape');
    await expect(page.locator('[data-annotation-layer="0"]')).toHaveAttribute(
      'data-tool',
      'select',
    );
    await expect(bar).toHaveAttribute('data-bar-view', 'write');
    await page.locator('body').press('Escape');
    await expect(bar).toHaveAttribute('data-bar-view', 'groups');
  }
  await page.locator('body').press('Shift+E');
  await bar.getByRole('button', { name: 'Eraser', exact: true }).hover();
  await expect(page.getByText('Eraser · Esc: Select')).toBeVisible();
  await page.locator('body').press('Escape');
  await page.locator('body').press('Escape');

  // A shortcut arms its tool and shows its group.
  await page.locator('body').press('x');
  await expect(bar.getByRole('button', { name: 'Mark for redaction' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(bar.getByRole('button', { name: 'Redact: back to all groups' })).toBeVisible();

  // The Document menu: Merge, Split, Compare and Rotate under "Combine and split".
  await page.locator('body').press('Escape');
  await page.getByTestId('document-menu').click();
  const menu = page.getByRole('menu');
  await expect(menu.getByText('Combine and split')).toBeVisible();
  for (const name of ['Merge files…', 'Split…', 'Compare with…', 'Rotate pages']) {
    await expect(menu.getByRole('menuitem', { name })).toBeVisible();
  }
  await page.keyboard.press('Escape');
});

/** A Letter page with a 1600 × 1200 Flate RGB "photo" placed 4 inches wide (400 dpi). */
async function photoPdf(): Promise<Uint8Array> {
  const width = 1600;
  const height = 1200;
  const pixels = new Uint8Array(width * height * 3);
  let seed = 7;
  const random = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 3;
      const sky = y < height * 0.55;
      const hill = Math.sin(x / 180) * 60 + height * 0.62;
      const noise = (random() - 0.5) * 14;
      const [r, g, b] = sky
        ? [90 + (y / height) * 120, 150 + (y / height) * 70, 230]
        : y > hill
          ? [40 + (x / width) * 60, 120 + Math.sin(x / 40) * 20, 50]
          : [70, 150, 80];
      const sun = Math.hypot(x - width * 0.75, y - height * 0.2) < 110;
      pixels[o] = Math.max(0, Math.min(255, (sun ? 250 : r) + noise));
      pixels[o + 1] = Math.max(0, Math.min(255, (sun ? 210 : g) + noise));
      pixels[o + 2] = Math.max(0, Math.min(255, (sun ? 60 : b) + noise));
    }
  }
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const stream = doc.context.flateStream(pixels, {
    Type: 'XObject',
    Subtype: 'Image',
    Width: width,
    Height: height,
    ColorSpace: 'DeviceRGB',
    BitsPerComponent: 8,
  });
  const ref = doc.context.register(stream);
  const page = doc.addPage([612, 792]);
  page.drawText('Field report: 400 dpi photo', { x: 72, y: 720, size: 18, font });
  page.node.setXObject(PDFName.of('Photo'), ref);
  page.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(288, 0, 0, 216, 72, 470),
    drawObject('Photo'),
    popGraphicsState(),
  );
  return doc.save();
}

test('compress dialog result with compare (design screenshot)', async ({ page }, testInfo) => {
  test.skip(
    !process.env.CAPTURE_SCREENSHOTS,
    'Set CAPTURE_SCREENSHOTS=1 to write docs/design/screenshots/.',
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await useFileInputPicker(page);
  await page.goto('./');
  await expect(page.getByTestId('app-shell')).toBeVisible();
  const file = testInfo.outputPath('field-report.pdf');
  await writeFile(file, await photoPdf());
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open files' }).first().click();
  await (await chooser).setFiles(file);
  await expect(page.getByRole('tab', { name: 'field-report' })).toBeVisible();

  await openTool(page, 'Compress…');
  const dialog = page.getByTestId('compress-dialog');
  await expect(dialog.getByTestId('compress-estimate')).toBeVisible({ timeout: 30_000 });
  await expect(dialog.getByRole('table')).toContainText('Downsample to 600×450');
  await dialog.getByRole('button', { name: 'Compress', exact: true }).click();
  await expect(dialog.getByTestId('compress-result')).toContainText('→', { timeout: 30_000 });
  await dialog.getByRole('checkbox', { name: 'Compare before and after' }).check();
  await expect(dialog.getByTestId('compress-compare').locator('canvas')).toHaveCount(2, {
    timeout: 15_000,
  });
  // Scroll both panes (they scroll together) to the photo.
  await dialog.getByRole('img', { name: 'Before' }).evaluate((element) => {
    element.scrollTop = 230;
    element.scrollLeft = 330;
    element.dispatchEvent(new Event('scroll'));
  });
  await page.screenshot({ path: '../../docs/design/screenshots/m3-compress-1440.png' });
});
