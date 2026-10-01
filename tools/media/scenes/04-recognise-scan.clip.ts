/**
 * Clip 4, "Recognise a scan" (spec §6): the scanned letter, Document menu → "Recognize text
 * (OCR)…", English, the first page (the second is Turkish). The recognition itself is cut,
 * not sped up, and a "shortened" caption says so (spec §2.3). Then the result: the page's
 * quality in the OCR section, and a recognised line selected with the pointer, as on any
 * page with text. The scene asserts that the selection holds the letter's words.
 */
import { expect } from '@playwright/test';

import { scene } from '../lib/scene.ts';

const FIXTURES = ['demo-letter-scan.pdf'] as const;
/** A line of page 1's ground truth (test/fixtures/README.md, "demo-letter-scan.pdf"). */
const LINE = 'Temporary event notice: Autumn Head, 12 October 2024';

scene({
  id: '04-recognise-scan',
  kind: 'clip',
  // The page, the dialog and the inspector; the navigator's thumbnails are left out.
  crop: { x: 320, y: 0, width: 1120, height: 900 },
  async prepare(stage) {
    const { page } = stage;
    await stage.openFixtures(FIXTURES);
    await stage.rendered(page.locator('main'), 1);
    await stage.cursor.place(1000, 560);
  },
  async run(stage) {
    const { page, cursor } = stage;

    // 1. Document menu → Recognize text (OCR)…: English, the current page.
    await cursor.click(page.getByTestId('document-menu'), 350);
    await cursor.click(page.getByRole('menuitem', { name: 'Recognize text (OCR)…' }), 350);
    const dialog = page.getByTestId('ocr-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('checkbox', { name: /English/ })).toBeChecked();
    await cursor.click(dialog.getByRole('radio', { name: 'Current page (1)' }), 350);
    await cursor.click(dialog.getByRole('button', { name: 'Recognize 1 page' }), 350);
    await expect(dialog.getByTestId('ocr-progress')).toBeVisible();
    await stage.hold(300);

    // 2. The wait, cut: the clip goes straight from the progress to the result, and the
    //    caption sits just under the dialog.
    const result = dialog.getByTestId('ocr-result');
    await stage.cut(
      () => expect(result).toBeVisible({ timeout: 180_000 }),
      async () => {
        const box = await dialog.boundingBox();
        if (!box) throw new Error('the OCR dialog is not laid out');
        return { x: box.x + box.width / 2, y: box.y + box.height + 26 };
      },
      // Gone before the dialog closes and the inspector opens under it.
      { ms: 750 },
    );
    await expect(result).toContainText('Recognize text: 1 page, eng');

    // 3. The result: the page's quality in the OCR section.
    await cursor.click(dialog.getByRole('button', { name: 'Show results' }), 350);
    await expect(dialog).toHaveCount(0);
    const quality = page.getByTestId('ocr-section').getByTestId('ocr-quality');
    await expect(quality).toHaveText(/^Good · \d+%$/);
    await stage.hold(200);

    // 4. Select a recognised line by dragging across it, as on a page with real text. The
    //    recognised text layer has one span per line; this one reads as the ground truth.
    const line = page.getByTestId('text-layer').first().getByText(LINE, { exact: true });
    await expect(line).toBeAttached();
    const lineBox = await line.boundingBox();
    if (!lineBox) throw new Error('the recognised line is not laid out');
    const y = lineBox.y + lineBox.height / 2;
    await cursor.move(lineBox.x + 1, y, 420);
    await cursor.down();
    await cursor.move(lineBox.x + lineBox.width - 1, y, 500);
    await cursor.up();
    await expect
      .poll(() => page.evaluate(() => window.getSelection()?.toString().trim() ?? ''))
      .toBe(LINE);
    // Into the dark gutter right of the page: the lines below are longer than the selected
    // one, so anywhere beside it the arrow would sit on text.
    const sheet = await page.locator('[data-page-index="0"]').boundingBox();
    if (!sheet) throw new Error('the page is not laid out');
    await cursor.move(sheet.x + sheet.width + 12, y + 40, 380);
  },
});
