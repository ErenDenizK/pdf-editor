/**
 * Clip 3, "Redact, and the text is gone" (spec §6): on the agreement's page 2, "Find
 * sensitive data" lists the IBAN (with the e-mail and the phone number on page 1); the finds
 * are marked, the IBAN boxed on the page, and applied; then a search for the IBAN finds
 * nothing. The scene asserts that the IBAN is no longer in the text, so it doubles as an
 * e2e test (spec §2.2).
 */
import { expect } from '@playwright/test';

import { scene } from '../lib/scene.ts';

const FIXTURES = ['demo-agreement.pdf'] as const;
/** The documentation IBAN on page 2 (test/fixtures/README.md, "demo-agreement.pdf"). */
const IBAN = 'GB82 WEST 1234 5698 7654 32';

scene({
  id: '03-redact',
  kind: 'clip',
  // The navigator (finder, search) and the page beside it.
  crop: { x: 0, y: 40, width: 1100, height: 830 },
  async prepare(stage) {
    const { page } = stage;
    await stage.openFixtures(FIXTURES);
    // One file opens in its document, in Read (ADR-0019 §2).
    await expect(page.getByRole('radio', { name: 'Read, locked' })).toBeChecked();
    // The Review tab on its Marks filter, where "Find sensitive data" is ("Show redactions"
    // from the palette: the filter's chip only shows once there are marks).
    await page.keyboard.press('ControlOrMeta+k');
    await page.getByRole('combobox', { name: 'Search commands' }).fill('Show redactions');
    await expect(
      page.getByRole('option', { name: /Show redactions/, selected: true }),
    ).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-review-panel]')).toHaveAttribute('data-filter', 'redactions');
    // The palette hands the focus back to the toolbar; neither its focus tooltip nor a
    // focus ring may open the clip.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    // Page 2, where the IBAN is, in view: its hit is marked and then removed in front of
    // the viewer, with no trip through the list to reveal it.
    await page.locator('[data-page-index="1"]').evaluate((el) => el.scrollIntoView());
    await expect(page.getByRole('contentinfo')).toContainText('Page 2 of 4');
    await stage.rendered(page.locator('main'), 1);
    await stage.cursor.place(900, 500);
  },
  async run(stage) {
    const { page, cursor } = stage;
    const panel = page.locator('[data-review-panel]');
    await stage.hold(100);

    // 1. Find sensitive data: the IBAN is among the finds.
    await cursor.click(panel.getByRole('button', { name: 'Find sensitive data' }), 350);
    const finder = panel.getByRole('region', { name: 'Sensitive data' });
    const iban = finder.locator('[data-pattern="iban"]').getByRole('button', { name: /GB82/ });
    await expect(iban).toBeVisible();
    await stage.hold(450);

    // 2. Mark the finds (the IBAN is boxed on the page), then apply.
    await cursor.click(finder.getByRole('button', { name: /^Mark \d+ selected$/ }), 350);
    await expect(panel.getByTestId('redaction-summary')).toHaveText(/^3 marks · 3 selected$/);
    await stage.hold(250);
    await cursor.click(panel.getByTestId('redaction-apply'), 350);
    const dialog = page.getByTestId('redaction-apply-dialog');
    await expect(dialog).toBeVisible();
    await cursor.click(dialog.getByTestId('redaction-apply-confirm'), 350);
    const result = dialog.getByTestId('redaction-result');
    // While the app works, the pointer leaves for the dark gutter beside the page, where it
    // covers neither the result nor, later, "No results" and the black box.
    await Promise.all([
      cursor.move(330, 700, 450),
      expect(result).toBeVisible({ timeout: 30_000 }),
    ]);
    await expect(result.getByTestId('redaction-checks-summary')).toHaveText(
      /^Self-check: (\d+) of \1 checks passed$/,
    );
    await stage.hold(350);
    // Esc closes the finished dialog: no trip across the screen to its Close button.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    // 3. Search for the IBAN: nothing.
    await page.keyboard.press('ControlOrMeta+f');
    const field = page.getByRole('searchbox', { name: 'Find in document' });
    await field.fill(IBAN);
    await expect(page.getByTestId('search-status')).toHaveText('No results', { timeout: 20_000 });
    await expect(page.getByTestId('search-hit')).toHaveCount(0);
    // Nor is it in any page's text layer.
    await expect(page.getByTestId('text-layer').filter({ hasText: 'GB82' })).toHaveCount(0);
  },
});
