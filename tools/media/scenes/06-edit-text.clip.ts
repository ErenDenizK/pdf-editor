/**
 * Clip 6, "Edit a line of text" (spec §6): page 3 of the report (the foreword). The Edit
 * text tool, a click on the line that begins "2024 was a year" (it opens the paragraph
 * editor, ADR-0020), "2024" becomes "2025", and the settled preview shows the line re-set
 * in its own embedded font with no honesty line naming a substitute (test/fixtures/README.md:
 * the subsets hold the glyphs, so the edit stays in the same font). The scene asserts that
 * state.
 */
import { expect } from '@playwright/test';

import { scene } from '../lib/scene.ts';

const FIXTURES = ['demo-report-v1.pdf'] as const;
/** The text-edit target (test/fixtures/README.md, "demo-report-v1.pdf"). */
const LINE =
  '2024 was a year of steady water and full boats. We began the season with a waiting list for';

scene({
  id: '06-edit-text',
  kind: 'clip',
  // The top of the page: the line, the editor and its check, large enough to read.
  crop: { x: 340, y: 50, width: 1100, height: 620 },
  async prepare(stage) {
    const { page } = stage;
    await stage.openFixtures(FIXTURES);
    // One file opens in its document, in Read (ADR-0019 §2).
    await expect(page.getByRole('radio', { name: 'Read, locked' })).toBeChecked();
    // Page 3 at the top of the view (a thumbnail click would also select the page).
    await page.locator('[data-page-index="2"]').evaluate((el) => el.scrollIntoView());
    await expect(page.getByRole('contentinfo')).toContainText('(3 of 10)');
    await stage.rendered(page.locator('main'), 1);
    await stage.cursor.place(1100, 560);
  },
  async run(stage) {
    const { page, cursor } = stage;
    await stage.hold(200);

    // 1. E arms the Edit text tool (in Read it switches to Edit first, ADR-0019 §3; its
    //    button sits in a tool group that is closed until a tool of it is in use); the
    //    page's lines become targets.
    await page.keyboard.press('e');
    await expect(page.getByRole('radio', { name: 'Edit', exact: true })).toBeChecked();
    const tool = page.getByRole('button', { name: 'Edit text' });
    await expect(tool).toHaveAttribute('aria-pressed', 'true');
    await stage.hold(300);
    const line = page.locator(`[data-text-edit-layer] [data-text-run="${LINE}"]`);
    await expect(line).toBeVisible({ timeout: 20_000 });

    // 2. A click before "2024" opens the line's paragraph in the paragraph editor, the caret
    //    at the click.
    await cursor.click(line, 450, { x: 0.02, y: 0.5 });
    const editor = page.getByRole('textbox', { name: 'Paragraph on page 3' });
    await expect(editor).toBeFocused({ timeout: 20_000 });
    await expect(editor).toHaveText(new RegExp(`^${LINE}`));
    await stage.hold(450);

    // 3. "2024" → "2025": the year selected from the keyboard, then typed over.
    await page.keyboard.press('Home');
    for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowRight');
    await stage.hold(250);
    await page.keyboard.type('2025', { delay: 90 });
    await expect(editor).toHaveText(new RegExp(`^${LINE.replace('2024', '2025')}`));

    // 4. The check: the settled preview (the engine's dry run, exactly what will be saved)
    //    replaces the drawn line, with no honesty line: every character stays in the
    //    paragraph's own embedded font.
    await expect(page.locator('[data-paragraph-editor]')).toHaveAttribute('data-preview', '', {
      timeout: 20_000,
    });
    await expect(page.getByTestId('paragraph-honesty')).toHaveCount(0);
    await expect(page.getByTestId('paragraph-error')).toHaveCount(0);
    await stage.hold(300);
    // Into the page's blank left margin, below the check: over text, a line would light up
    // as a target, and the line and the editor's header stay clear.
    await cursor.move(405, 560, 380);
  },
});
