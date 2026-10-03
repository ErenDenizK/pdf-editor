/**
 * The paragraph editor end to end (craft spec §4.2, §4.7, §13 #9) on the tagged Chromium
 * export `text-edit-corpus/word-tagged.pdf` (tools/fixtures/text-edit-corpus.ts: a heading,
 * two paragraphs, three list items). Enter Edit, arm Edit text (E), click inside the first
 * paragraph: the paragraph editor opens with its mirror focused. Type a word, wait for the
 * settled preview, Esc: one history entry. Export, re-open the export and search: the new
 * word is there, inside the paragraph's text.
 */
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

import { expect, type Page, test } from '@playwright/test';

import { fixturePath, showInspector, useFileInputPicker } from './helpers';

test.skip(({ browserName }) => browserName !== 'chromium', 'Covered in Chromium');
test.use({ viewport: { width: 1440, height: 900 } });

const WORD = 'Brightly';
const AXE_SOURCE = readFileSync(
  createRequire(import.meta.url).resolve('axe-core/axe.min.js'),
  'utf8',
);

/**
 * Serious and critical axe violations in the paragraph editor (craft spec §9: none on a new
 * state). The page's run targets around it are the Edit text layer's, checked elsewhere.
 */
async function seriousViolations(page: Page): Promise<string[]> {
  if (!(await page.evaluate(() => 'axe' in window))) await page.evaluate(AXE_SOURCE);
  return page.evaluate(async () => {
    interface Result {
      id: string;
      impact: string | null;
      nodes: { target: string[] }[];
    }
    const { axe } = window as unknown as {
      axe: { run: (context: object, options: object) => Promise<{ violations: Result[] }> };
    };
    const result = await axe.run(
      { include: [['[data-paragraph-editor]']] },
      {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
        resultTypes: ['violations'],
      },
    );
    return result.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  });
}

function historyRows(page: Page, label: string | RegExp) {
  return page.getByRole('list', { name: /history/i }).getByRole('button', { name: label });
}

/** Searches the active document (opens the Search panel when needed). */
async function search(page: Page, query: string) {
  const field = page.getByRole('searchbox', { name: 'Find in document' });
  if (!(await field.isVisible())) await page.keyboard.press('ControlOrMeta+f');
  await field.fill(query);
  return page.getByTestId('search-hit');
}

test.beforeEach(async ({ page }) => {
  // Force the <a download> path: Playwright cannot drive the native save picker.
  await page.addInitScript({
    content:
      "Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });",
  });
  await useFileInputPicker(page);
  await page.goto('./?lang=en');
});

test('type a word into a paragraph, preview, Esc commits once; the export reads it', async ({
  page,
}) => {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open files' }).first().click();
  await (await chooser).setFiles(fixturePath('text-edit-corpus/word-tagged.pdf'));
  await expect(page.getByRole('tab', { name: 'word-tagged' })).toBeVisible();
  await showInspector(page);
  await expect(page.locator('canvas[data-state="rendered"]').first()).toBeAttached({
    timeout: 20_000,
  });
  await page.locator('[data-read-viewport]').focus();

  // E arms Edit text (switching to Edit); the page's runs become targets.
  await page.keyboard.press('e');
  await expect(page.getByRole('button', { name: 'Edit text' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  // Chromium prints one text object per glyph: the first "T" on the page starts the first
  // paragraph ("The ferry left the quay…"; the heading has none).
  const runs = page.locator('[data-text-edit-layer="0"] [data-text-run]');
  await expect(runs.first()).toBeVisible({ timeout: 20_000 });
  const ferry = page.locator('[data-text-edit-layer="0"] [data-text-run="T"]').first();
  await expect(ferry).toBeVisible();
  const box = await ferry.boundingBox();
  if (!box) throw new Error('paragraph not laid out');
  // Click just before the run's first glyph: the caret goes in front of it.
  await page.mouse.click(box.x + 1, box.y + box.height / 2);

  const editor = page.getByRole('textbox', { name: 'Paragraph on page 1' });
  await expect(editor).toBeFocused({ timeout: 20_000 });
  await expect(editor).toHaveText(/^The ferry left the quay at dawn/);
  await expect(page.getByTestId('paragraph-header')).toBeVisible();
  const before = (await editor.textContent()) ?? '';

  await page.keyboard.type(`${WORD} `);
  await expect(editor).toHaveText(new RegExp(`${WORD} `));
  const after = (await editor.textContent()) ?? '';
  expect(after.length).toBe(before.length + WORD.length + 1);
  // The settled preview: the dry run rendered over the paragraph.
  await expect(page.locator('[data-paragraph-editor]')).toHaveAttribute('data-preview', '', {
    timeout: 20_000,
  });
  await expect(page.getByTestId('paragraph-error')).toHaveCount(0);
  expect(await seriousViolations(page)).toEqual([]);

  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0, { timeout: 20_000 });
  await expect(historyRows(page, /^Paragraph edited/)).toHaveCount(1, { timeout: 20_000 });

  // Export and download.
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Export document' }).click();
  const exportDialog = page.getByTestId('export-dialog');
  await expect(exportDialog).toBeVisible();
  await exportDialog.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(exportDialog.getByTestId('export-verified')).toBeVisible({ timeout: 30_000 });
  const downloadPromise = page.waitForEvent('download');
  await exportDialog.getByRole('button', { name: 'Download' }).click();
  const bytes = await readFile(await (await downloadPromise).path());
  await page.keyboard.press('Escape');

  // Re-open the export and search it.
  const reopen = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open files' }).first().click();
  await (await reopen).setFiles({ name: 'edited.pdf', mimeType: 'application/pdf', buffer: bytes });
  await expect(page.getByRole('tab', { name: 'edited' })).toBeVisible();
  await expect(page.locator('canvas[data-state="rendered"]').first()).toBeAttached({
    timeout: 20_000,
  });
  const hits = await search(page, WORD);
  await expect(hits).toHaveCount(1, { timeout: 20_000 });
  await expect(hits.first()).toContainText(WORD);
});
