/**
 * Hero still (spec §1.1 item 2, §2.4): the light table, Arrange showing three documents
 * as three sections. Opened with the Open button (several files land on Home, ADR-0019 §1),
 * then Home's "Arrange pages": a still shows the result, not the way there.
 */
import { expect } from '@playwright/test';

import { scene } from '../lib/scene.ts';

/**
 * The documents on the table, in opening order (the order of the sections): the demo
 * documents of spec §2.2, from `test/fixtures/demo/`.
 */
const FIXTURES = ['demo-report-v1.pdf', 'demo-agreement.pdf', 'demo-letter-scan.pdf'] as const;

scene({
  id: '00-hero',
  kind: 'still',
  async run(stage) {
    const { page } = stage;
    await stage.openFixtures(FIXTURES);
    // With no card picked out, Home's "Arrange pages" lays every open file on the table.
    await page.getByTestId('home').getByRole('button', { name: 'Arrange pages' }).click();
    const sections = page.getByRole('grid');
    await expect(sections).toHaveCount(FIXTURES.length);
    // Smaller cells and the table to itself (no navigator), so all three sections are on
    // it at once, the report in one row.
    await stage.command('Smaller thumbnails');
    await stage.command('Toggle left panel');
    // The palette gives the focus back to the control it came from; no focus ring in the
    // still.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await stage.rendered(sections, 6);
    // The click left the mouse where Home's button was, over the table now; move it to
    // empty canvas so no hover shows.
    await page.mouse.move(1300, 470);
  },
});
