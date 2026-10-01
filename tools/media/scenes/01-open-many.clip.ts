/**
 * Clip 1, "Open many PDFs at once" (spec §6): three files dragged in from the desktop and
 * dropped on Home, then Arrange shows them as three sections on one light table.
 */
import { expect } from '@playwright/test';

import { scene } from '../lib/scene.ts';

/**
 * The dropped files, in drop order (the order of the cards and sections). Corpus fixtures
 * for now; the demo fixtures (`test/fixtures/demo/`, spec §2.2) replace them here.
 */
const FIXTURES = ['forms-a.pdf', 'images.pdf', 'many-pages.pdf'] as const;

scene({
  id: '01-open-many',
  kind: 'clip',
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

    await cursor.click(page.getByRole('radio', { name: 'Arrange' }), 460);
    const sections = page.getByRole('grid');
    await expect(sections).toHaveCount(FIXTURES.length);
    await stage.rendered(sections, 6);
    await stage.hold();
    // To empty canvas beside the sections, so the poster frame shows the table unobscured.
    await cursor.move(1240, 470, 420);
  },
});
