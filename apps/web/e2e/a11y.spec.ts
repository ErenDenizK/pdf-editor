/**
 * Accessibility end to end (experience-redesign spec §10, WP A11; DESIGN.md §5), in Chromium:
 *
 * - the keyboard paths: F6 regions, Home's grid, the navigator's tablist and radio chips,
 *   the tool bar's groups and options tier, the pen presets and their editor, the
 *   contextual bar reached from a Review row, the lasso bar, the Document info sheet;
 * - announcements reach the live region, once and politely;
 * - axe-core on the main states of the new surfaces: no serious or critical violation;
 * - reduced motion turns the morph, the rise-in and every transition off;
 * - the focus ring tokens on the new controls;
 * - craft spec §9 (M8): Read with the lock, Edit with each of the five groups, the Edit text
 *   layer's paragraph targets (Tab between paragraphs, Enter opens) and the paragraph editor,
 *   the page context menu, the text selection bar in Read and Edit, a lasso selection with
 *   its handles and keyboard box, the Highlighter's announcement, Recents on Home, Glass
 *   panels and Reduce transparency, one state in Turkish; no Tab stop is ever hidden; the new
 *   surfaces neither move nor rise under reduced motion and turn solid under Reduce
 *   transparency.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { expect, type Locator, type Page, test } from '@playwright/test';

import { enterEdit, fixturePath, openFixtures, showInspector, useFileInputPicker } from './helpers';

test.skip(({ browserName }) => browserName !== 'chromium', 'One engine for axe and the keys');
test.use({ viewport: { width: 1440, height: 900 } });

test.beforeEach(async ({ page }) => {
  await useFileInputPicker(page);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function openSimple(page: Page): Promise<void> {
  await page.goto('./?lang=en');
  await openFixtures(page, ['simple-text.pdf']);
  await expect(page.locator('canvas[data-state="rendered"]').first()).toBeAttached({
    timeout: 20_000,
  });
}

const bar = (page: Page): Locator => page.getByRole('toolbar', { name: 'Tools', exact: true });
const layer = (page: Page): Locator => page.locator('[data-annotation-layer="0"]');
const viewport = (page: Page): Locator => page.locator('[data-read-viewport]');
/** The polite live region (shell/LiveRegion.tsx). */
const status = (page: Page): Locator =>
  page.locator('div[role="status"][aria-live="polite"].visually-hidden');
const holdsFocus = (locator: Locator): Promise<boolean> =>
  locator.evaluate((el) => el.contains(document.activeElement));
const focusedName = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return 'body';
    return el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 40) ?? el.tagName;
  });

/** A short stroke across the first page, by mouse, between fractions of the layer's box. */
async function stroke(page: Page, from: [number, number], to: [number, number]): Promise<void> {
  const box = await layer(page).boundingBox();
  if (!box) throw new Error('page not rendered');
  const h = Math.min(box.height, 800);
  await page.mouse.move(box.x + box.width * from[0], box.y + h * from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * to[0], box.y + h * to[1], { steps: 12 });
  await page.mouse.up();
}

/** A closed lasso loop around the area between two fractions of the first page. */
async function lasso(
  page: Page,
  from: [number, number],
  to: [number, number],
  margin = 30,
): Promise<void> {
  const box = await layer(page).boundingBox();
  if (!box) throw new Error('page not rendered');
  const h = Math.min(box.height, 800);
  const x0 = box.x + box.width * from[0] - margin;
  const x1 = box.x + box.width * to[0] + margin;
  const y0 = box.y + h * from[1] - margin;
  const y1 = box.y + h * to[1] + margin;
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  for (const [x, y] of [
    [x1, y0],
    [x1, y1],
    [x0, y1],
    [x0, y0 + 5],
  ] as const) {
    await page.mouse.move(x, y, { steps: 8 });
  }
  await page.mouse.up();
}

// ---------------------------------------------------------------------------
// Keyboard paths
// ---------------------------------------------------------------------------

test.describe('keyboard', () => {
  test('F6 and Shift+F6 cycle title bar, navigator, stage, tool bar and inspector', async ({
    page,
  }) => {
    await openSimple(page);
    await enterEdit(page);
    await showInspector(page);
    // An armed tool with options: the tier sits by the bar, but F6 lands on the bar, on the
    // armed tool. (T, the Text box in the Text group: the text markups have no bar entry since
    // craft spec §3.4, and H arms the Highlighter preset, whose tier is empty.)
    await page.locator('body').press('t');
    await page.locator('body').press('t');
    await expect(page.getByTestId('options-tier')).toBeVisible();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

    const title = page.getByRole('tablist', { name: 'Open documents' });
    const navigator = page.getByRole('tablist', { name: 'Navigator views' });
    const inspector = page.locator('#right-panel');
    const highlight = bar(page).getByRole('button', { name: 'Text box', exact: true });

    await page.keyboard.press('F6');
    await expect(title.getByRole('tab', { selected: true })).toBeFocused();
    await page.keyboard.press('F6');
    await expect(navigator.getByRole('tab', { selected: true })).toBeFocused();
    await page.keyboard.press('F6');
    await expect(viewport(page)).toBeFocused();
    await page.keyboard.press('F6');
    await expect(highlight).toBeFocused();
    await page.keyboard.press('F6');
    expect(await holdsFocus(inspector)).toBe(true);
    await page.keyboard.press('F6');
    await expect(title.getByRole('tab', { selected: true })).toBeFocused();

    // And back.
    await page.keyboard.press('Shift+F6');
    expect(await holdsFocus(inspector)).toBe(true);
    await page.keyboard.press('Shift+F6');
    await expect(highlight).toBeFocused();
    await page.keyboard.press('Shift+F6');
    await expect(viewport(page)).toBeFocused();
    await page.keyboard.press('Shift+F6');
    await expect(navigator.getByRole('tab', { selected: true })).toBeFocused();
  });

  test('Home: the toolbar row, then the grid; arrows, Space, Enter; F6 lands on a card', async ({
    page,
  }) => {
    await page.goto('./?lang=en');
    await openFixtures(page, ['simple-text.pdf', 'rotated-pages.pdf', 'mixed-sizes.pdf']);
    await page.keyboard.press('0');
    const home = page.getByTestId('home');
    await expect(home).toBeVisible();
    const grid = page.getByRole('listbox', { name: 'Files' });
    const card = (title: string) => grid.getByRole('option', { name: new RegExp(`^${title},`) });
    const stops = grid.locator('[role="option"][tabindex="0"]');

    // Nothing selected: Escape on a card clears what opening selected.
    await card('simple-text').focus();
    await page.keyboard.press('Escape');
    await expect(grid.getByRole('option', { selected: true })).toHaveCount(0);

    // The row first (Open files, Arrange pages, Combine…: the buttons shown), in order.
    const row = home.getByRole('button');
    const shown = await row.count();
    expect(shown).toBeGreaterThanOrEqual(3);
    await row.first().focus();
    for (let i = 1; i < shown; i++) {
      await page.keyboard.press('Tab');
      await expect(row.nth(i)).toBeFocused();
    }
    await expect(page.getByTestId('home-combine')).toBeFocused();
    // Then one Tab stop in the grid (roving tabindex).
    await page.keyboard.press('Tab');
    await expect(card('simple-text')).toBeFocused();
    await expect(stops).toHaveCount(1);
    await page.keyboard.press('ArrowRight');
    await expect(card('rotated-pages')).toBeFocused();
    await expect(stops).toHaveCount(1);
    await page.keyboard.press('Space');
    await expect(card('rotated-pages')).toHaveAttribute('aria-selected', 'true');
    await expect(status(page)).toHaveText('1 file selected');
    await page.keyboard.press('Shift+ArrowRight');
    await expect(status(page)).toHaveText('2 files selected');
    await page.keyboard.press('Escape');
    await expect(status(page)).toHaveText('0 files selected');
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByTestId('home-combine')).toBeFocused();
    // A card has no ⋯ menu yet (Combine is the row's button and a card drop), so Shift+F10
    // and the context menu key have nothing to open: no step to test.

    // F6 from the title bar: the navigator, then the stage, which lands on the grid's stop.
    await page.getByTestId('home-button').focus();
    await page.keyboard.press('F6');
    await page.keyboard.press('F6');
    await expect(card('mixed-sizes')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(home).toHaveCount(0);
    await expect(
      page.getByRole('tablist', { name: 'Open documents' }).getByRole('tab', { selected: true }),
    ).toHaveAccessibleName(/mixed-sizes/);
  });

  test('the navigator: the tablist, the Bookmarks switch and the Review filters', async ({
    page,
  }) => {
    await page.goto('./?lang=en');
    await openFixtures(page, ['annotations.pdf']);
    const tabs = page.getByRole('tablist', { name: 'Navigator views' });
    const tab = (id: string) => tabs.locator(`#rail-${id}`);
    await tab('pages').focus();

    // Arrows, Home and End move between the tabs (one Tab stop); Enter opens.
    await page.keyboard.press('ArrowDown');
    await expect(tab('find')).toBeFocused();
    await page.keyboard.press('End');
    await expect(tab('files')).toBeFocused();
    await page.keyboard.press('Home');
    await expect(tab('pages')).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(tab('files')).toBeFocused();
    await expect(tabs.locator('[role="tab"][tabindex="0"]')).toHaveCount(1);
    await page.keyboard.press('ArrowUp');
    await expect(tab('review')).toBeFocused();
    await expect(tab('review')).toHaveAccessibleName(/^Review, \d+ items?$/);
    await page.keyboard.press('Enter');
    await expect(tab('review')).toHaveAttribute('aria-selected', 'true');

    // Tab moves into the panel: the filters, a radio group (arrows choose, and say so).
    const filters = page.getByRole('radiogroup', { name: 'Show' });
    await page.keyboard.press('Tab');
    await expect(filters.getByRole('radio', { name: /^All/ })).toBeFocused();
    await page.keyboard.press('ArrowRight');
    const comments = filters.getByRole('radio', { name: /^Comments/ });
    await expect(comments).toBeFocused();
    await expect(comments).toHaveAttribute('aria-checked', 'true');
    await expect(status(page)).toHaveText(/^Comments: \d+ items?$/);
    await page.keyboard.press('End');
    await expect(filters.getByRole('radio').last()).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Home');
    await expect(filters.getByRole('radio', { name: /^All/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );

    // Pages: the Pages · Bookmarks switch is a radio group too.
    await tab('review').focus();
    await page.keyboard.press('Home');
    await page.keyboard.press('Enter');
    await expect(tab('pages')).toHaveAttribute('aria-selected', 'true');
    const view = page.getByRole('radiogroup', { name: 'Pages view' });
    await page.keyboard.press('Tab');
    await expect(view.getByRole('radio', { name: 'Pages' })).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(view.getByRole('radio', { name: 'Bookmarks' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(page.locator('[data-pages-view="bookmarks"]')).toBeVisible();
    await page.keyboard.press('ArrowLeft');
    await expect(view.getByRole('radio', { name: 'Pages' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  test('the tool bar: groups, a tool, its options tier by Tab, Esc', async ({ page }) => {
    await openSimple(page);
    await enterEdit(page);
    await expect(bar(page).locator('button[tabindex="0"]')).toHaveCount(1);
    await bar(page).locator('button[tabindex="0"]').focus();
    await page.keyboard.press('Home');
    // Select, the idle tool, is the row's first chip (craft spec §3.4).
    const select = bar(page).getByRole('button', { name: 'Select', exact: true });
    await expect(select).toBeFocused();
    await expect(select).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('ArrowRight');
    await expect(bar(page).getByRole('button', { name: 'Write', exact: true })).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(bar(page).getByRole('button', { name: 'Text', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(bar(page).getByRole('button', { name: 'Text: back to all groups' })).toBeFocused();
    await expect(status(page)).toHaveText('Text tools');

    // Arrows within the group (Edit text, Text box, Note); Enter arms a tool (aria-pressed).
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    const note = bar(page).getByRole('button', { name: 'Note', exact: true });
    await expect(note).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(note).toHaveAttribute('aria-pressed', 'true');
    await expect(status(page)).toHaveText('Note tool');
    // Its options open only on request: Enter on the armed tool again (review finding 5).
    const tier = page.getByRole('toolbar', { name: 'Note options' });
    await expect(tier).toHaveCount(0);
    await expect(note).toHaveAttribute('aria-description', 'Press again for options');
    await page.keyboard.press('Enter');
    await expect(tier).toBeVisible();
    await expect(status(page)).toHaveText('Note options');

    // Tab goes from the bar to its options tier: one Tab stop, arrows, and keys that work.
    await page.keyboard.press('Tab');
    expect(await holdsFocus(tier)).toBe(true);
    await expect(tier.locator('[tabindex="0"]')).toHaveCount(1);
    const before = await focusedName(page);
    await page.keyboard.press('ArrowRight');
    expect(await focusedName(page)).not.toBe(before);
    const swatch = tier.getByRole('radio').first();
    await swatch.focus();
    await page.keyboard.press('Space');
    await expect(swatch).toHaveAttribute('aria-checked', 'true');
    const opacity = tier.getByRole('slider', { name: 'Opacity' });
    await opacity.focus();
    const value = await opacity.inputValue();
    await page.keyboard.press('ArrowDown');
    await expect(opacity).not.toHaveValue(value);
    // Esc from the tier disarms; the tier goes and focus returns to the bar.
    await page.keyboard.press('Escape');
    await expect(tier).toHaveCount(0);
    await expect(note).toHaveAttribute('aria-pressed', 'false');
    await expect(note).toBeFocused();
    // With nothing armed, Esc on the bar returns to the row, on the group used.
    await page.keyboard.press('Escape');
    await expect(bar(page).getByRole('button', { name: 'Text', exact: true })).toBeFocused();
  });

  test('the pen presets: arrows, Enter arms, Enter again opens the editor, Esc closes it only', async ({
    page,
  }) => {
    await openSimple(page);
    await enterEdit(page);
    await bar(page).locator('button[tabindex="0"]').focus();
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await expect(status(page)).toHaveText('Write tools');
    await page.keyboard.press('ArrowRight');
    const presets = bar(page).getByRole('radiogroup', { name: 'Pen presets' });
    await expect(presets.getByRole('radio', { name: 'Black pen, 1.5 pt' })).toBeFocused();
    await page.keyboard.press('ArrowRight');
    const blue = presets.getByRole('radio', { name: 'Blue pen, 1.5 pt' });
    await expect(blue).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(blue).toHaveAttribute('data-armed', '');
    await expect(layer(page)).toHaveAttribute('data-tool', 'ink');
    // The preset, said once, in place of "Pen tool".
    await expect(status(page)).toHaveText('Blue pen, 1.5 pt');
    await expect(page.getByTestId('pen-preset-editor')).toHaveCount(0);

    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Edit Blue pen' })).toBeVisible();
    // By test id from here: a colour change renames the preset (and the dialog).
    const editor = page.getByTestId('pen-preset-editor');
    await expect.poll(() => holdsFocus(editor)).toBe(true);
    // The colours are a radio group: one Tab stop, the arrows choose.
    const colours = editor.getByRole('radiogroup', { name: 'Color' });
    const stop = colours.locator('[role="radio"][tabindex="0"]');
    await expect(stop).toHaveCount(1);
    await stop.focus();
    await page.keyboard.press('ArrowRight');
    await expect(colours.locator('[role="radio"][aria-checked="true"]')).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(colours.getByRole('radio', { name: 'Blue' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    // Esc closes the editor only: the pen stays armed, focus back on its dot.
    await page.keyboard.press('Escape');
    await expect(editor).toHaveCount(0);
    await expect(layer(page)).toHaveAttribute('data-tool', 'ink');
    await expect(blue).toBeFocused();
  });

  test('a Review row selects an ink; the contextual bar by keyboard; Delete', async ({ page }) => {
    await openSimple(page);
    await page.locator('body').press('p');
    await stroke(page, [0.3, 0.45], [0.5, 0.46]);
    const ink = layer(page).locator('[data-annotation-kind="ink"]');
    await expect(ink).toHaveCount(1, { timeout: 10_000 });
    await page.locator('body').press('Escape');

    await page.locator('#rail-review').click();
    const row = page.locator('[data-review-panel] [data-annotation-row]').first();
    await row.focus();
    await page.keyboard.press('Enter');
    const contextual = page.getByTestId('annotation-bar');
    await expect(contextual).toBeVisible();
    // F6 to the stage (the pages), then Tab into the bar: one Tab stop, arrows inside.
    await page.keyboard.press('F6');
    await expect(viewport(page)).toBeFocused();
    await page.keyboard.press('Tab');
    expect(await holdsFocus(contextual)).toBe(true);
    await expect(contextual.locator('[tabindex="0"]')).toHaveCount(1);
    await page.keyboard.press('End');
    await expect(contextual.getByRole('button', { name: 'Delete' })).toBeFocused();
    await page.keyboard.press('Delete');
    await expect(ink).toHaveCount(0, { timeout: 10_000 });
    await expect(contextual).toHaveCount(0);
    // Focus stays on the pages, not on <body>.
    await expect(viewport(page)).toBeFocused();
  });

  test('the lasso bar: said once, Tab into it, the grip nudges, Esc keeps the Lasso', async ({
    page,
  }) => {
    await openSimple(page);
    await page.locator('body').press('p');
    // Two strokes of one burst: one word, the second just right of the first on its line.
    await stroke(page, [0.3, 0.45], [0.36, 0.45]);
    await stroke(page, [0.39, 0.45], [0.45, 0.45]);
    // At once (within the burst's pause): the tool change closes the burst, and both are
    // said, once each.
    await page.locator('body').press('q');
    await expect(status(page)).toHaveText('Pen: 2 strokes on page 1. Lasso tool');
    const ink = layer(page).locator('[data-annotation-kind="ink"]');
    await expect(ink.locator('polyline')).toHaveCount(2, { timeout: 10_000 });
    await lasso(page, [0.3, 0.45], [0.36, 0.45], 10);
    const lassoBar = page.locator('[data-lasso-bar]');
    await expect(lassoBar).toBeVisible();
    await expect(status(page)).toHaveText('1 stroke selected');

    await viewport(page).focus();
    await page.keyboard.press('Tab');
    expect(await holdsFocus(lassoBar)).toBe(true);
    const grip = lassoBar.getByRole('button', { name: 'Move strokes' });
    await grip.focus();
    const path = layer(page).locator('[data-lasso-path]');
    const x = async () => (await path.boundingBox())?.x ?? 0;
    const from = await x();
    await page.keyboard.press('Shift+ArrowRight');
    await expect.poll(x, { timeout: 10_000 }).toBeGreaterThan(from + 5);
    await expect(grip).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(lassoBar).toHaveCount(0);
    await expect(layer(page)).toHaveAttribute('data-tool', 'lasso');
    await expect(viewport(page)).toBeFocused();
  });

  test('the Document info sheet: focus trap, Esc, focus back on the opener', async ({ page }) => {
    await openSimple(page);
    const opener = page.getByTestId('document-menu');
    await opener.focus();
    await page.keyboard.press('Enter');
    const item = page.getByRole('menuitem', { name: 'Document info…' });
    await item.focus();
    await page.keyboard.press('Enter');
    const sheet = page.getByTestId('document-info');
    await expect(sheet).toBeVisible();
    // Trapped: in the sheet, or on one of the trap's own focus guards (Base UI's invisible
    // edges, which hand focus back to the sheet on the next Tab).
    const trapped = () =>
      page.evaluate(() => {
        const el = document.activeElement;
        if (!el) return false;
        return (
          el.closest('[data-document-info]') !== null || el.hasAttribute('data-base-ui-focus-guard')
        );
      });
    await expect.poll(() => holdsFocus(sheet)).toBe(true);
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press('Tab');
      expect(await trapped()).toBe(true);
    }
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Shift+Tab');
      expect(await trapped()).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    await expect(opener).toBeFocused();
  });
});

// ---------------------------------------------------------------------------
// axe
// ---------------------------------------------------------------------------

const AXE_SOURCE = readFileSync(
  createRequire(import.meta.url).resolve('axe-core/axe.min.js'),
  'utf8',
);

interface AxeViolation {
  readonly id: string;
  readonly impact: string | null;
  readonly nodes: readonly { readonly target: readonly string[] }[];
}

/**
 * Accepted exceptions, by rule id, with the reason. Moderate and minor findings are
 * attached to the test's report and do not fail it; serious and critical ones fail it.
 */
const ACCEPTED: Readonly<Record<string, string>> = {};

async function axe(page: Page, name: string): Promise<void> {
  // Settled first: a dialog fading in would be measured at part opacity (color-contrast), and
  // so would the tool bar, faded while a stroke is in progress and a second after.
  await expect(page.locator('[data-stroking]')).toHaveCount(0, { timeout: 3000 });
  await page.waitForFunction(() =>
    document.getAnimations().every((animation) => animation.playState !== 'running'),
  );
  // Through the devtools protocol: the app's CSP refuses inline scripts.
  if (!(await page.evaluate(() => 'axe' in window))) await page.evaluate(AXE_SOURCE);
  const violations: AxeViolation[] = await page.evaluate(async () => {
    interface Result {
      id: string;
      impact: string | null;
      nodes: { target: string[] }[];
    }
    const { axe: runner } = window as unknown as {
      axe: { run: (context: Document, options: object) => Promise<{ violations: Result[] }> };
    };
    const result = await runner.run(document, {
      runOnly: {
        type: 'tag',
        values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'],
      },
      resultTypes: ['violations'],
    });
    return result.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      nodes: v.nodes.map((n) => ({ target: n.target })),
    }));
  });
  const found = violations.filter((v) => !(v.id in ACCEPTED));
  const describe = (v: AxeViolation) =>
    `${v.impact} ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`;
  const serious = (v: AxeViolation) => v.impact === 'serious' || v.impact === 'critical';
  const lesser = found.filter((v) => !serious(v));
  if (lesser.length > 0) {
    test
      .info()
      .annotations.push({ type: `axe: ${name}`, description: lesser.map(describe).join('; ') });
  }
  expect.soft(found.filter(serious).map(describe), name).toEqual([]);
}

test.describe('axe', () => {
  test('Home, empty and with files', async ({ page }) => {
    await page.goto('./?lang=en');
    await expect(page.getByRole('heading', { name: 'Drop PDFs to start' })).toBeVisible();
    await axe(page, 'empty Home');
    await openFixtures(page, ['simple-text.pdf', 'rotated-pages.pdf']);
    await page.keyboard.press('0');
    await expect(page.getByTestId('home')).toBeVisible();
    await axe(page, 'Home with files');
  });

  test('Read and Edit with the bar open on each group, the page menu and an options tier', async ({
    page,
  }) => {
    await openSimple(page);
    // Read carries its mode without colour: the lock glyph and the name (craft spec §9).
    const read = page.getByRole('radio', { name: 'Read, locked' });
    await expect(read).toHaveAttribute('aria-checked', 'true');
    await expect(read.getByTestId('read-lock')).toBeVisible();
    await expect(bar(page).getByRole('button', { name: 'Edit', exact: true })).toHaveAttribute(
      'aria-keyshortcuts',
      '2',
    );
    await axe(page, 'Read, the lock and the Edit button');
    await enterEdit(page);
    await axe(page, 'Edit, the groups');
    // Select arms from its chip and has no tool row (craft spec §3.4).
    const select = bar(page).getByRole('button', { name: 'Select', exact: true });
    await bar(page).getByRole('button', { name: 'Write', exact: true }).click();
    await bar(page).getByRole('button', { name: 'Write: back to all groups' }).click();
    await select.click();
    await expect(select).toHaveAttribute('aria-pressed', 'true');
    await axe(page, 'Edit, Select');
    // The four groups with tools.
    for (const group of ['Write', 'Text', 'Fill & sign', 'Redact']) {
      await bar(page).getByRole('button', { name: group, exact: true }).click();
      const chip = bar(page).getByRole('button', { name: `${group}: back to all groups` });
      await expect(chip).toBeVisible();
      await axe(page, `Edit, ${group}`);
      await chip.click();
    }
    // The page context menu (right-click on a page).
    const first = await page.locator('[data-page-index="0"]').boundingBox();
    if (!first) throw new Error('page 1 not laid out');
    await page.mouse.click(first.x + 40, first.y + 40, { button: 'right' });
    await expect(page.getByTestId('page-context-menu')).toBeVisible();
    await axe(page, 'Edit, the page context menu');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('page-context-menu')).toHaveCount(0);
    await page.locator('body').press('u');
    await page.locator('body').press('u');
    await expect(page.getByTestId('options-tier')).toBeVisible();
    await axe(page, 'Edit, Underline options');
  });

  test('the Review tab, the Document info sheet and the export dialog', async ({ page }) => {
    await page.goto('./?lang=en');
    await openFixtures(page, ['annotations.pdf']);
    await page.locator('#rail-review').click();
    await expect(page.locator('[data-review-panel] [data-annotation-row]').first()).toBeVisible();
    await axe(page, 'Review tab');

    await page.getByTestId('document-menu').click();
    await page.getByRole('menuitem', { name: 'Document info…' }).click();
    await expect(page.getByTestId('document-info')).toBeVisible();
    await axe(page, 'Document info sheet');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('document-info')).toHaveCount(0);

    await page.getByRole('button', { name: 'Export document' }).click();
    await expect(page.getByTestId('export-dialog')).toBeVisible();
    await axe(page, 'export dialog');
  });

  test('the pen editor and the lasso bar', async ({ page }) => {
    await openSimple(page);
    await page.locator('body').press('p');
    await page.getByRole('radio', { name: 'Black pen, 1.5 pt' }).click();
    await expect(page.getByTestId('pen-preset-editor')).toBeVisible();
    await axe(page, 'pen editor');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('pen-preset-editor')).toHaveCount(0);

    await stroke(page, [0.3, 0.45], [0.5, 0.46]);
    await expect(layer(page).locator('[data-annotation-kind="ink"]')).toHaveCount(1, {
      timeout: 10_000,
    });
    await page.locator('body').press('q');
    await lasso(page, [0.3, 0.45], [0.5, 0.46]);
    await expect(page.locator('[data-lasso-bar]')).toBeVisible();
    await axe(page, 'lasso bar');
  });
});

// ---------------------------------------------------------------------------
// Reduced motion
// ---------------------------------------------------------------------------

/** Longest current animation (Web Animations, CSS animations and transitions), ms. */
const longestAnimation = (page: Page): Promise<number> =>
  page.evaluate(() =>
    Math.max(
      0,
      ...document.getAnimations().map((a) => {
        const duration = a.effect?.getComputedTiming().duration;
        return typeof duration === 'number' ? duration : 0;
      }),
    ),
  );

/**
 * Records every Web Animations call from now on (the morph animates through `animate`), so
 * a movement that has already finished is still seen; read with `longestScripted`.
 */
const recordScripted = (page: Page): Promise<void> =>
  page.evaluate(() => {
    const seen: number[] = [];
    (window as unknown as { __animated: number[] }).__animated = seen;
    const animate = Object.getOwnPropertyDescriptor(Element.prototype, 'animate')
      ?.value as Element['animate'];
    Element.prototype.animate = function (this: Element, keyframes, options) {
      seen.push(typeof options === 'number' ? options : Number(options?.duration ?? 0));
      return animate.call(this, keyframes, options);
    };
  });
const longestScripted = (page: Page): Promise<number> =>
  page.evaluate(() =>
    Math.max(0, ...((window as unknown as { __animated?: number[] }).__animated ?? [])),
  );

/** The longest transition or animation duration set on the element, ms. */
const longestDuration = (locator: Locator): Promise<number> =>
  locator.evaluate((el) => {
    const style = getComputedStyle(el);
    const ms = (value: string) =>
      value.split(',').map((part) => {
        const v = part.trim();
        const n = Number.parseFloat(v);
        // `auto` (no time-based duration) counts as none.
        if (Number.isNaN(n)) return 0;
        return v.endsWith('ms') ? n : n * 1000;
      });
    return Math.max(...ms(style.transitionDuration), ...ms(style.animationDuration));
  });

/** The global reduced-motion floor (styles/global.css): 0.01 ms, i.e. none. */
const NONE_MS = 0.01;

test.describe('reduced motion', () => {
  test('without it, the morph moves (so the check below is meaningful)', async ({ page }) => {
    await openSimple(page);
    await enterEdit(page);
    await recordScripted(page);
    await bar(page).getByRole('button', { name: 'Write', exact: true }).click();
    expect(await longestScripted(page)).toBeGreaterThanOrEqual(100);
  });

  test('with it, the morph, the rise-in and the transitions are off', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openSimple(page);
    await enterEdit(page);
    const draw = bar(page).getByRole('button', { name: 'Write', exact: true });
    expect(await longestDuration(draw)).toBeLessThanOrEqual(NONE_MS);
    await recordScripted(page);
    await draw.click();
    // No morph: nothing was animated, nothing animates.
    expect(await longestScripted(page)).toBeLessThanOrEqual(NONE_MS);
    expect(await longestAnimation(page)).toBeLessThanOrEqual(NONE_MS);
    const dot = page.getByRole('radio', { name: 'Black pen, 1.5 pt' });
    expect(await longestDuration(dot)).toBeLessThanOrEqual(NONE_MS);
    // The preset editor rises in without movement (opened from the keyboard: arm, then
    // Enter again on the armed preset).
    await dot.focus();
    await page.keyboard.press('Enter');
    await expect(dot).toHaveAttribute('data-armed', '');
    await page.keyboard.press('Enter');
    const editor = page.getByTestId('pen-preset-editor');
    await expect(editor).toBeVisible();
    expect(await longestDuration(editor)).toBeLessThanOrEqual(NONE_MS);
    expect(await longestAnimation(page)).toBeLessThanOrEqual(NONE_MS);
    await page.keyboard.press('Escape');
    // So does the options tier (asked for: U again).
    await page.locator('body').press('u');
    await page.locator('body').press('u');
    const tier = page.getByTestId('options-tier');
    await expect(tier).toBeVisible();
    expect(await longestDuration(tier)).toBeLessThanOrEqual(NONE_MS);
    expect(await longestAnimation(page)).toBeLessThanOrEqual(NONE_MS);
  });
});

// ---------------------------------------------------------------------------
// Focus ring
// ---------------------------------------------------------------------------

test('the focus ring tokens apply to the new controls', async ({ page }) => {
  await page.goto('./?lang=en');
  await openFixtures(page, ['simple-text.pdf', 'annotations.pdf']);
  await page.getByRole('tab', { name: 'annotations' }).click();
  await enterEdit(page);
  const expectRing = async (name: string, target: Locator) => {
    // After a key press, so :focus-visible applies to a scripted focus.
    await page.keyboard.press('Shift');
    await target.focus();
    await expect(target, name).toBeFocused();
    const found = await target.evaluate((el) => {
      const style = getComputedStyle(el);
      const probe = document.createElement('span');
      probe.style.color = 'var(--accent)';
      document.body.append(probe);
      const accent = getComputedStyle(probe).color;
      probe.remove();
      return {
        visible: el.matches(':focus-visible'),
        style: style.outlineStyle,
        width: style.outlineWidth,
        colour: style.outlineColor,
        accent,
      };
    });
    expect(found.visible, name).toBe(true);
    expect(found.style, name).toBe('solid');
    expect(found.width, name).toBe('2px');
    // --accent, ≥ 3:1 over the glass bar and every surface (styles/tokens.test.ts).
    expect(found.colour, name).toBe(found.accent);
  };

  await expectRing('navigator tab', page.locator('#rail-review'));
  await page.locator('#rail-review').click();
  await expectRing('Review filter chip', page.getByRole('radio', { name: /^All/ }));
  await expectRing('Review row', page.locator('[data-annotation-row]').first());
  await page.locator('#rail-files').click();
  await expectRing('Files row', page.locator('[data-file-row] button').first());

  await page.keyboard.press('0');
  const firstCard = page.getByRole('listbox', { name: 'Files' }).getByRole('option').first();
  await expectRing('Home card', firstCard);
  await expectRing('Home action', page.getByTestId('home-combine'));
  await firstCard.dblclick();

  await expect(page.locator('canvas[data-state="rendered"]').first()).toBeAttached({
    timeout: 20_000,
  });
  // The pages' ring shows only when F6 or Tab brought the focus there (review finding 23).
  for (let i = 0; i < 8; i++) {
    if (await viewport(page).evaluate((el) => el === document.activeElement)) break;
    await page.keyboard.press('F6');
  }
  await expect(viewport(page)).toBeFocused();
  expect(await viewport(page).evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
  await enterEdit(page);
  await expectRing('bar group', bar(page).getByRole('button', { name: 'Write', exact: true }));
  await bar(page).getByRole('button', { name: 'Write', exact: true }).click();
  await expectRing('ink dot', page.getByRole('radio', { name: 'Blue pen, 1.5 pt' }));
  await page.locator('body').press('p');
  await stroke(page, [0.3, 0.45], [0.5, 0.46]);
  await expect(layer(page).locator('[data-annotation-kind="ink"]')).toHaveCount(1, {
    timeout: 10_000,
  });
  await page.locator('body').press('q');
  await lasso(page, [0.3, 0.45], [0.5, 0.46]);
  // The lasso's grab area (an SVG rect over the taken strokes) takes the pointer only; its
  // keyboard form is the bar's move grip (arrows nudge), which carries the ring.
  await expectRing('lasso move grip', page.getByRole('button', { name: 'Move strokes' }));
});

// ---------------------------------------------------------------------------
// Craft spec §9 (M8)
// ---------------------------------------------------------------------------

/** Opens the tagged Chromium export (one text object per glyph) in `lang`. */
async function openWordTagged(page: Page, lang = 'en'): Promise<void> {
  await page.goto(`./?lang=${lang}`);
  const chooser = page.waitForEvent('filechooser');
  await page
    .getByRole('button', { name: /^(Open files|Dosya aç)$/ })
    .first()
    .click();
  await (await chooser).setFiles(fixturePath('text-edit-corpus/word-tagged.pdf'));
  await expect(page.getByRole('tab', { name: 'word-tagged' })).toBeVisible();
  await expect(page.locator('canvas[data-state="rendered"]').first()).toBeAttached({
    timeout: 20_000,
  });
}

const paragraphTargets = (page: Page): Locator =>
  page.locator('[data-text-edit-layer="0"] [data-text-paragraph]');

/** Arms Edit text with E (switching to Edit) and waits for the paragraph targets. */
async function armEditText(page: Page): Promise<void> {
  await viewport(page).focus();
  await page.keyboard.press('e');
  await expect(paragraphTargets(page).first()).toBeAttached({ timeout: 20_000 });
}

/** A word of the first page's text layer, double-clicked: a selection and its bar. */
async function selectWord(page: Page): Promise<Locator> {
  const rows = page.getByTestId('text-layer').first().locator('span[data-row]');
  await expect(rows.first()).toBeAttached({ timeout: 20_000 });
  const box = await rows.first().boundingBox();
  if (!box) throw new Error('no text');
  await page.mouse.dblclick(box.x + Math.min(12, box.width / 4), box.y + box.height / 2);
  const selectionBar = page.getByRole('toolbar', { name: /^(Selected text|Seçili metin)$/ });
  await expect(selectionBar).toBeVisible();
  return selectionBar;
}

/** The first page's context menu, opened with a right-click on the paper. */
async function openPageMenu(page: Page): Promise<Locator> {
  const first = await page.locator('[data-page-index="0"]').boundingBox();
  if (!first) throw new Error('page 1 not laid out');
  await page.mouse.click(first.x + 40, first.y + 40, { button: 'right' });
  const menu = page.getByTestId('page-context-menu');
  await expect(menu).toBeVisible();
  return menu;
}

/**
 * Presses Tab (or Shift+Tab) `steps` times and checks that every stop is shown: an element
 * with a box, visible, outside any `aria-hidden` or inert subtree. Base UI's focus guards
 * (invisible by design, they hand the focus on) and the document itself pass. Returns what
 * each stop is called.
 */
async function tabWalk(page: Page, steps: number, back = false): Promise<string[]> {
  const names: string[] = [];
  for (let i = 0; i < steps; i++) {
    await page.keyboard.press(back ? 'Shift+Tab' : 'Tab');
    const stop = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return { ok: true, name: 'body' };
      if (el.hasAttribute('data-base-ui-focus-guard')) return { ok: true, name: 'focus guard' };
      const box = el.getBoundingClientRect();
      const shown =
        el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) &&
        box.width > 0 &&
        box.height > 0;
      const hidden = el.closest('[aria-hidden="true"], [inert]') !== null;
      const label = el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 40) ?? '';
      return { ok: shown && !hidden, name: `${el.tagName.toLowerCase()} “${label}”` };
    });
    expect(stop.ok, `Tab stop ${i + 1} is hidden: ${stop.name}`).toBe(true);
    names.push(stop.name);
  }
  return names;
}

test.describe('craft spec §9', () => {
  test('the pages show their focus ring after Tab or F6 only, never after a click or a mode key', async ({
    page,
  }) => {
    await openSimple(page);
    const frame = viewport(page).locator('xpath=..');
    const ring = () => frame.evaluate((el) => getComputedStyle(el, '::after').content);
    const box = await page.locator('[data-page-index="0"]').boundingBox();
    if (!box) throw new Error('page 1 not laid out');
    // A click on the pages, then a mode key (review finding 23): no frame around the stage.
    await page.mouse.click(box.x + box.width / 2, box.y + 60);
    await expect(viewport(page)).toBeFocused();
    await page.keyboard.press('2');
    expect(await ring()).toBe('none');
    await page.keyboard.press('1');
    expect(await ring()).toBe('none');
    // F6 between the regions reaches the pages: the ring shows.
    await bar(page).getByRole('button', { name: 'Edit', exact: true }).focus();
    for (let i = 0; i < 8; i++) {
      if (await viewport(page).evaluate((el) => el === document.activeElement)) break;
      await page.keyboard.press('F6');
    }
    await expect(viewport(page)).toBeFocused();
    expect(await ring()).not.toBe('none');
  });

  test('Read: F6 reaches the Edit button; the page menu and the selection bar; no hidden stop', async ({
    page,
  }) => {
    await openSimple(page);
    // F6 from the pages: the tool bar, which in Read is the one Edit button.
    await viewport(page).focus();
    await page.keyboard.press('F6');
    await expect(bar(page).getByRole('button', { name: 'Edit', exact: true })).toBeFocused();
    await viewport(page).focus();
    await tabWalk(page, 12);

    // The page context menu in Read: no page operation and no "Edit text here"; one quiet row
    // switches to Edit (review finding 4).
    const menu = await openPageMenu(page);
    await expect(
      menu.getByRole('menuitem', { name: /^Switch to Edit to change pages/ }),
    ).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Rotate page 1 right' })).toHaveCount(0);
    await expect(menu.getByRole('menuitem', { name: /Edit text here/ })).toHaveCount(0);
    await axe(page, 'Read, the page context menu');
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);

    // The text selection bar in Read: Copy and Mark up…, reached by Tab from the pages.
    const selectionBar = await selectWord(page);
    await expect(selectionBar.getByRole('button', { name: 'Copy' })).toBeVisible();
    await axe(page, 'Read, the text selection bar');
    await viewport(page).focus();
    let reached = false;
    for (let i = 0; i < 40 && !reached; i++) {
      await page.keyboard.press('Tab');
      reached = await holdsFocus(selectionBar);
    }
    expect(reached, 'Tab reaches the selection bar').toBe(true);
    await selectionBar.getByRole('button', { name: 'Mark up…' }).focus();
    await page.keyboard.press('Enter');
    // The Edit row on the same selection, the focus on its first markup.
    await expect(page.getByRole('radio', { name: 'Edit' })).toHaveAttribute('aria-checked', 'true');
    await expect(
      selectionBar.getByRole('button', { name: 'Underline', exact: true }),
    ).toBeVisible();
    expect(await holdsFocus(selectionBar)).toBe(true);
    await expect(selectionBar.getByRole('button', { name: 'Comment' })).toBeVisible();
    await axe(page, 'Edit, the text selection bar');
    await page.keyboard.press('Escape');
    await expect(selectionBar).toHaveCount(0);
  });

  test('Edit: F6 lands on the Select chip; each group by keyboard with no hidden stop', async ({
    page,
  }) => {
    await openSimple(page);
    await enterEdit(page);
    await showInspector(page);
    await viewport(page).focus();
    await page.keyboard.press('F6');
    const select = bar(page).getByRole('button', { name: 'Select', exact: true });
    await expect(select).toBeFocused();
    await page.keyboard.press('F6');
    expect(await holdsFocus(page.locator('#right-panel'))).toBe(true);
    await page.keyboard.press('Shift+F6');
    await expect(select).toBeFocused();
    // Every group: Enter opens it, Tab and Shift+Tab never stop on anything hidden (the
    // other groups' tools are not mounted while one group shows).
    for (const group of ['Write', 'Text', 'Fill & sign', 'Redact']) {
      await bar(page).locator('button[tabindex="0"]').focus();
      await page.keyboard.press('Home');
      const chosen = bar(page).getByRole('button', { name: group, exact: true });
      for (let i = 0; i < 6; i++) {
        if (await chosen.evaluate((el) => el === document.activeElement)) break;
        await page.keyboard.press('ArrowRight');
      }
      await page.keyboard.press('Enter');
      const chip = bar(page).getByRole('button', { name: `${group}: back to all groups` });
      await expect(chip).toBeFocused();
      await tabWalk(page, 4);
      await chip.focus();
      await tabWalk(page, 4, true);
      await chip.click();
    }
  });

  test('Edit text: Tab moves between paragraphs, Enter opens, Esc returns; axe', async ({
    page,
  }) => {
    await openWordTagged(page);
    await showInspector(page);
    await armEditText(page);
    const targets = paragraphTargets(page);
    const count = await targets.count();
    expect(count).toBeGreaterThanOrEqual(4);
    // One stop per paragraph: no glyph run is focusable or exposed.
    const exposedRuns = await page
      .locator('[data-text-edit-layer="0"] [data-text-run][data-editable]')
      .evaluateAll(
        (runs) =>
          runs.filter((r) => (r as HTMLElement).tabIndex >= 0 || !r.hasAttribute('aria-hidden'))
            .length,
      );
    expect(exposedRuns).toBe(0);
    for (let i = 0; i < count; i++) {
      await expect(targets.nth(i)).toHaveAttribute('aria-label', /^Edit paragraph “.+”$/);
      const box = await targets.nth(i).boundingBox();
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(24);
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(24);
    }
    await page.keyboard.press('Shift');
    await targets.first().focus();
    for (let i = 1; i < count; i++) {
      await page.keyboard.press('Tab');
      await expect(targets.nth(i)).toBeFocused();
    }
    await axe(page, 'Edit text armed, the paragraph targets');

    const ferry = page.locator(
      '[data-text-edit-layer="0"] [data-text-paragraph][aria-label*="The ferry"]',
    );
    await expect(ferry).toHaveCount(1);
    await ferry.focus();
    await page.keyboard.press('Enter');
    const editor = page.getByRole('textbox', { name: 'Paragraph on page 1' });
    await expect(editor).toBeFocused({ timeout: 20_000 });
    await expect(editor).toHaveAttribute('aria-multiline', 'true');
    await expect(editor).toHaveText(/^The ferry left the quay/);
    await expect(page.getByTestId('paragraph-header')).toBeVisible();
    await axe(page, 'the paragraph editor open');
    await page.keyboard.press('Escape');
    await expect(editor).toHaveCount(0);
    await expect(ferry).toBeFocused();
    await expect(
      page
        .getByRole('list', { name: /history/i })
        .getByRole('button', { name: /^Paragraph edited/ }),
    ).toHaveCount(0);
    await tabWalk(page, count + 2);
  });

  test('the lasso selection: 24 px handles, the keyboard box, axe', async ({ page }) => {
    await openSimple(page);
    await page.locator('body').press('p');
    await stroke(page, [0.3, 0.45], [0.5, 0.46]);
    await expect(layer(page).locator('[data-annotation-kind="ink"]')).toHaveCount(1, {
      timeout: 10_000,
    });
    await page.locator('body').press('q');
    await lasso(page, [0.3, 0.45], [0.5, 0.46]);
    await expect(page.locator('[data-lasso-bar]')).toBeVisible();
    const handles = layer(page).locator('[data-lasso-handle]');
    await expect(handles).toHaveCount(8);
    for (const hit of [...(await handles.all()), layer(page).locator('[data-lasso-rotate]')]) {
      const box = await hit.boundingBox();
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(24);
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(24);
    }
    // The keyboard path: the selection box, a labelled group in the tab order with its keys.
    const box = page.getByRole('group', { name: /^Selection: 1 stroke\. Arrow keys move it/ });
    await expect(box).toHaveAttribute('tabindex', '0');
    await expect(box).toHaveAttribute('aria-keyshortcuts', /Shift\+ArrowRight/);
    await page.keyboard.press('Shift');
    await box.focus();
    await expect(box).toBeFocused();
    expect(await box.evaluate((el) => el.matches(':focus-visible'))).toBe(true);
    await page.keyboard.press('Shift+ArrowRight');
    await expect(status(page)).toHaveText(/^Resized to \d+ × \d+ pt$/);
    await expect(box).toBeFocused();
    await axe(page, 'the lasso selection, its handles and box');
    await viewport(page).focus();
    await tabWalk(page, 10);
  });

  test('the Highlighter says the lines it highlighted', async ({ page }) => {
    await openSimple(page);
    await page.locator('body').press('h');
    await expect(layer(page)).toHaveAttribute('data-tool', 'ink');
    const rows = page.getByTestId('text-layer').first().locator('span[data-row]');
    await expect(rows.first()).toBeAttached({ timeout: 10_000 });
    const boxes = (await rows.evaluateAll((spans) =>
      spans.map((span) => {
        const r = span.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }),
    )) as { x: number; y: number; width: number; height: number }[];
    const longest = boxes.reduce((a, b) => (b.width > a.width ? b : a));
    const y = longest.y + longest.height / 2;
    await page.mouse.move(longest.x + 3, y);
    await page.mouse.down();
    await page.mouse.move(longest.x + longest.width - 3, y, { steps: 20 });
    await page.mouse.up();
    await expect(layer(page).locator('[data-annotation-kind="highlight"]')).toHaveCount(1, {
      timeout: 10_000,
    });
    await expect(status(page)).toHaveText('Highlighted 1 line on page 1');
  });

  test('Home: Recents, when the build has them', async ({ page }) => {
    await page.goto('./?lang=en');
    await openFixtures(page, ['simple-text.pdf', 'rotated-pages.pdf']);
    // Recents lists files opened lately that are not open now: close one (the Files panel).
    await page.locator('#rail-files').click();
    await page.getByRole('button', { name: 'Close rotated-pages' }).click();
    await expect(page.getByRole('tab', { name: 'rotated-pages' })).toHaveCount(0);
    // On Home the navigator offers Files only (review F16): its tab again collapses the panel.
    await page.locator('#rail-files').click();
    await page.keyboard.press('0');
    await expect(page.getByTestId('home')).toBeVisible();
    const recents = page.getByRole('list', { name: 'Recent files' });
    await recents.waitFor({ timeout: 3000 }).catch(() => undefined);
    if ((await recents.count()) === 0) {
      test.info().annotations.push({ type: 'skipped', description: 'No Recents list on Home' });
      return;
    }
    await expect(recents).toBeVisible();
    await axe(page, 'Home with Recents');
    await page.getByTestId('home-button').focus();
    await tabWalk(page, 12);
  });

  test('in Turkish: every new control is named; axe on Edit text and the page menu', async ({
    page,
  }) => {
    await openWordTagged(page, 'tr');
    await armEditText(page);
    await expect(page.getByRole('radio', { name: 'Düzenleme' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(page.getByRole('button', { name: 'Metin: tüm gruplara dön' })).toBeVisible();
    await expect(paragraphTargets(page).first()).toHaveAttribute(
      'aria-label',
      /^“.+” paragrafını düzenle$/,
    );
    await axe(page, 'Turkish, Edit text armed');
    const menu = await openPageMenu(page);
    await expect(menu.getByRole('menuitem', { name: 'Metni burada düzenle' })).toBeVisible();
    await axe(page, 'Turkish, the page context menu');
  });
});

/** Every glass surface on the page and what it paints (backdrop filter, background alpha). */
const glassSurfaces = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.glass, .glass-frame, .glass-menu')]
      .filter((el) => el.checkVisibility())
      .map((el) => {
        const style = getComputedStyle(el);
        const match = /rgba?\(([^)]+)\)/.exec(style.backgroundColor);
        const parts = match?.[1]?.split(/[\s,/]+/).filter(Boolean) ?? [];
        const alpha = parts.length === 4 ? Number(parts[3]) : 1;
        return {
          name: `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`,
          filter: style.backdropFilter,
          alpha,
        };
      }),
  );

async function appearance(
  page: Page,
  settings: { glassPanels: boolean; reduceTransparency: boolean },
): Promise<void> {
  await page.addInitScript((value) => {
    localStorage.setItem('pdf-editor:appearance:v1', value);
  }, JSON.stringify(settings));
}

test.describe('glass (craft spec §7, §9)', () => {
  test('Glass panels on: axe on Edit, the page menu and the selection bar', async ({ page }) => {
    await appearance(page, { glassPanels: true, reduceTransparency: false });
    await openSimple(page);
    await expect(page.locator('html')).toHaveAttribute('data-glass-panels', '');
    await showInspector(page);
    // Meaningful only if something is glass: the floating bar at least is translucent.
    expect(
      (await glassSurfaces(page)).some((surface) => surface.alpha < 1 || surface.filter !== 'none'),
    ).toBe(true);
    await axe(page, 'Glass panels, Read');
    await selectWord(page);
    await axe(page, 'Glass panels, the text selection bar');
    await page.keyboard.press('Escape');
    await enterEdit(page);
    await bar(page).getByRole('button', { name: 'Write', exact: true }).click();
    await axe(page, 'Glass panels, Edit, Write');
    await openPageMenu(page);
    await axe(page, 'Glass panels, the page context menu');
  });

  test('Reduce transparency: every glass tier is solid on the new surfaces', async ({ page }) => {
    await appearance(page, { glassPanels: true, reduceTransparency: true });
    await openWordTagged(page);
    await expect(page.locator('html')).toHaveAttribute('data-transparency', 'reduced');
    await showInspector(page);
    const expectSolid = async (state: string) => {
      const surfaces = await glassSurfaces(page);
      expect(surfaces.length, state).toBeGreaterThan(0);
      for (const surface of surfaces) {
        expect(surface.filter, `${state}: ${surface.name}`).toBe('none');
        expect(surface.alpha, `${state}: ${surface.name}`).toBe(1);
      }
    };
    await expectSolid('Read: frame and the Edit button');
    await selectWord(page);
    await expectSolid('the text selection bar');
    await page.keyboard.press('Escape');
    await openPageMenu(page);
    await expectSolid('the page context menu');
    await page.keyboard.press('Escape');
    await armEditText(page);
    await paragraphTargets(page).first().focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('paragraph-header')).toBeVisible({ timeout: 20_000 });
    await expectSolid('Edit, Text, the paragraph editor');
    await axe(page, 'Reduce transparency, the paragraph editor');
  });
});

test('reduced motion: the new surfaces neither move nor rise', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openWordTagged(page);
  const still = async (state: string, locator: Locator) => {
    expect(await longestDuration(locator), state).toBeLessThanOrEqual(NONE_MS);
    expect(await longestAnimation(page), state).toBeLessThanOrEqual(NONE_MS);
  };
  await recordScripted(page);
  await still('the text selection bar', await selectWord(page));
  await page.keyboard.press('Escape');
  await still('the page context menu', await openPageMenu(page));
  await page.keyboard.press('Escape');
  await armEditText(page);
  // The Text group's morph and its options tier.
  await still('the Edit bar', bar(page));
  await page.keyboard.press('Shift');
  await paragraphTargets(page).first().focus();
  await still('a paragraph target', paragraphTargets(page).first());
  await page.keyboard.press('Enter');
  const header = page.getByTestId('paragraph-header');
  await expect(header).toBeVisible({ timeout: 20_000 });
  await still('the paragraph editor header', header);
  expect(await longestScripted(page)).toBeLessThanOrEqual(NONE_MS);
});
