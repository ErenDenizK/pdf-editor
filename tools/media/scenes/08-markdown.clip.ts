/**
 * Clip 8, "Pages to Markdown" (spec §6): the report's pages 2–4 through Document menu →
 * "Export as Markdown / text…", Markdown, a page range; the preview shows the pages'
 * headings as Markdown headings. The scene asserts them (test/fixtures/README.md: Contents,
 * Chair's foreword, The year in numbers).
 *
 * The spec's last beat, "Copy", has no control in the app: the dialog offers Cancel and
 * Download only (apps/web/src/convert/ConvertDialog.tsx). The clip ends on the preview,
 * with the pointer resting by Download, and leaves the beat out rather than faking it.
 */
import { expect } from '@playwright/test';

import { scene } from '../lib/scene.ts';

const FIXTURES = ['demo-report-v1.pdf'] as const;

scene({
  id: '08-markdown',
  kind: 'clip',
  // The dialog: options on the left, the preview on the right.
  crop: { x: 240, y: 96, width: 960, height: 720 },
  async prepare(stage) {
    const { page } = stage;
    await stage.openFixtures(FIXTURES);
    await stage.rendered(page.locator('main'), 1);
    await stage.cursor.place(1060, 620);
  },
  async run(stage) {
    const { page, cursor } = stage;
    await stage.hold(200);

    // 1. Document menu → Export as Markdown / text…
    await cursor.click(page.getByTestId('document-menu'), 400);
    await cursor.click(page.getByRole('menuitem', { name: 'Export as Markdown / text…' }), 380);
    const dialog = page.getByTestId('convert-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('radio', { name: /^Markdown/ })).toBeChecked();

    // 2. Pages 2–4.
    await cursor.click(dialog.getByRole('radio', { name: 'Page range' }), 380);
    const range = dialog.getByRole('textbox', { name: 'Page range' });
    await range.pressSequentially('2-4', { delay: 70 });

    // 3. The preview: the three pages' headings, as Markdown.
    const preview = dialog.getByTestId('convert-preview');
    await expect(preview).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
    // The range is applied: the preview starts at page 2's heading, not at the cover.
    await expect(preview).toHaveText(/^# Contents\n/);
    await expect(preview).toContainText(/^#+ Chair’s foreword$/m);
    await expect(preview).toContainText(/^#+ The year in numbers$/m);
    await expect(dialog.getByTestId('convert-output')).toHaveText(/^Downloads demo-report-v1\./);
    await stage.hold(400);
    // Down the preview to the foreword's heading and the next page's.
    await cursor.moveTo(preview, 400, { x: 0.6, y: 0.55 });
    await preview.evaluate((el) => el.scrollBy({ top: 150, behavior: 'smooth' }));
    await stage.hold(450);
    // Just right of Download, clear of the preview and inside the crop.
    const download = await dialog.getByRole('button', { name: 'Download' }).boundingBox();
    if (!download) throw new Error('the Download button is not laid out');
    await cursor.move(download.x + download.width + 10, download.y + download.height / 2, 420);
  },
});
