/**
 * Clip 1, "Open many PDFs at once" (spec §6): three files dragged in from the desktop and
 * dropped on Home, then Home's "Arrange pages" shows them as three sections on one light
 * table.
 */
import { expect } from '@playwright/test';

import { scene } from '../lib/scene.ts';

/**
 * The dropped files, in drop order (the order of the cards and sections): the demo
 * documents of spec §2.2, from `test/fixtures/demo/`.
 */
const FIXTURES = ['demo-report-v1.pdf', 'demo-agreement.pdf', 'demo-letter-scan.pdf'] as const;

scene({
  id: '01-open-many',
  kind: 'clip',
  async prepare(stage) {
    // As in the hero still: smaller cells and no navigator, so Arrange shows all three
    // sections at once.
    await stage.command('Smaller thumbnails');
    await stage.command('Toggle left panel');
    await stage.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  },
  async run(stage) {
    const { page, cursor } = stage;
    await expect(page.getByRole('heading', { name: 'Drop PDFs to start' })).toBeVisible();
    await stage.hold(500);

    // From the right edge of the window (another app, say) to the middle of Home.
    const target = await page.getByTestId('home').boundingBox();
    if (!target) throw new Error('Home is not visible');
    await stage.dropFiles(
      FIXTURES,
      { x: target.x + target.width * 0.5, y: target.y + target.height * 0.45 },
      { x: 1440 + 8, y: 640 },
      500,
    );
    const cards = page.getByRole('listbox', { name: 'Files' }).getByRole('option');
    await expect(cards).toHaveCount(FIXTURES.length);
    await stage.rendered(cards, FIXTURES.length);
    await stage.hold();

    // The dropped cards are selected, so "Arrange pages" lays all three on the table.
    await cursor.click(
      page.getByTestId('home').getByRole('button', { name: 'Arrange pages' }),
      460,
    );
    const sections = page.getByRole('grid');
    await expect(sections).toHaveCount(FIXTURES.length);
    await stage.rendered(sections, 6);
    await stage.hold();
    // To empty canvas beside the sections, so the poster frame shows the table unobscured.
    await cursor.move(1240, 470, 420);
  },
});
