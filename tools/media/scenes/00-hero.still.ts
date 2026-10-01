/**
 * Hero still (spec §1.1 item 2, §2.4): the light table, Arrange showing three documents
 * as three sections. Opened with the Open button: a still shows the result, not the way
 * there.
 */
import { expect } from '@playwright/test';

import { scene } from '../lib/scene.ts';

/**
 * The documents on the table, in opening order (the order of the sections). Corpus
 * fixtures for now; the demo fixtures (`test/fixtures/demo/`, spec §2.2) replace them here.
 */
const FIXTURES = ['forms-a.pdf', 'images.pdf', 'many-pages.pdf'] as const;

scene({
  id: '00-hero',
  kind: 'still',
  async run(stage) {
    const { page } = stage;
    await stage.openFixtures(FIXTURES);
    await page.getByRole('radio', { name: 'Arrange' }).click();
    const sections = page.getByRole('grid');
    await expect(sections).toHaveCount(FIXTURES.length);
    await stage.rendered(sections, 6);
    // The click left the mouse on the switch; move it to empty canvas so no hover shows.
    await page.mouse.move(1300, 470);
  },
});
