/**
 * Clip 2, "Move pages between documents" (spec §6): in Arrange, pages 3–4 of the report
 * (the foreword and "The year in numbers") are selected, dragged with the app's drag image
 * (two sheets and a count) into the agreement, and dropped after its second page; the
 * agreement's section then holds them.
 */
import { expect } from '@playwright/test';

import { scene } from '../lib/scene.ts';
import { tabName } from '../lib/stage.ts';

/** The source and the target, in opening order (the order of the sections). */
const FIXTURES = ['demo-report-v1.pdf', 'demo-agreement.pdf'] as const;
const [REPORT, AGREEMENT] = FIXTURES.map(tabName) as [string, string];

scene({
  id: '02-move-pages',
  kind: 'clip',
  // The light table without the navigator: both sections, the drag and the drop.
  crop: { x: 314, y: 96, width: 1126, height: 780 },
  async prepare(stage) {
    const { page } = stage;
    await stage.openFixtures(FIXTURES);
    // Two files opened together land on Home (ADR-0019 §1); its "Arrange pages" lays both
    // on the table.
    await page.getByTestId('home').getByRole('button', { name: 'Arrange pages' }).click();
    await expect(page.getByRole('grid')).toHaveCount(FIXTURES.length);
    await stage.rendered(page.getByRole('grid'), 14);
    await stage.cursor.place(1240, 600);
  },
  async run(stage) {
    const { page, cursor } = stage;
    const report = page.getByRole('grid', { name: REPORT }).getByRole('gridcell');
    const agreement = page.getByRole('grid', { name: AGREEMENT }).getByRole('gridcell');
    await expect(report).toHaveCount(10);
    await expect(agreement).toHaveCount(4);
    await stage.hold(400);

    // Select pages 3 and 4: a click, then a Shift-click.
    await cursor.click(report.nth(2), 420, { x: 0.5, y: 0.45 });
    await page.keyboard.down('Shift');
    await cursor.click(report.nth(3), 380, { x: 0.5, y: 0.45 });
    await page.keyboard.up('Shift');
    await expect(report.nth(3)).toHaveAttribute('aria-selected', 'true');
    await stage.hold(300);

    // Drag them into the agreement, to the gap after its second page.
    await cursor.down();
    const target = await agreement.nth(1).boundingBox();
    if (!target) throw new Error('the agreement is not laid out');
    await cursor.move(target.x + target.width * 0.88, target.y + target.height * 0.45, 900);
    await expect(page.getByTestId('insertion-bar')).toHaveAttribute('data-index', '2');
    await stage.hold(350);
    await cursor.up();
    await stage.ghost.clear();

    // The result: the agreement holds six pages, the two from the report after its second.
    await expect(agreement).toHaveCount(6);
    await expect(report).toHaveCount(8);
    // The report's page labels travel with the pages: its pages 3 and 4 are labelled 1 and 2.
    await expect(agreement.nth(2)).toHaveAccessibleName(`Page 3 (1) of 6, from ${REPORT}.pdf`);
    await expect(agreement.nth(3)).toHaveAccessibleName(`Page 4 (2) of 6, from ${REPORT}.pdf`);
    await stage.rendered(page.getByRole('grid'), 12);
    await stage.hold();
    // Off the sections, so the poster shows both rows of the agreement unobscured.
    await cursor.move(1300, 560, 420);
  },
});
