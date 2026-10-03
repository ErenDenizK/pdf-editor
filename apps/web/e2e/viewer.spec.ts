/**
 * Read-mode viewer (spec viewer-annotations §1): text selection and copy, find in document,
 * internal and external links, go to page, and the two-up layout, on outline-named-dests.pdf.
 * The navigator's four tabs and the closed inspector on first run, with Document info in the
 * Document menu (experience-redesign §4); the status bar without a second view switch; Read
 * through a narrow-then-wide window resize.
 */
import { fileURLToPath } from 'node:url';

import { PDFDocument, PDFName, PDFString } from '@cantoo/pdf-lib';
import { expect, type Page, test } from '@playwright/test';

import { openFixtures, useFileInputPicker } from './helpers';

const screenshots = new URL('../../../docs/design/screenshots/', import.meta.url);

test.beforeEach(async ({ page, context, browserName }) => {
  await useFileInputPicker(page);
  if (browserName === 'chromium') {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  }
  await page.goto('./?lang=en');
  await openFixtures(page, ['outline-named-dests.pdf']);
  await expect(page.getByTestId('status-pages')).toHaveText('Page 1 of 6');
});

const mod = (page: Page) =>
  page.evaluate(() => (/mac/i.test(navigator.platform) ? 'Meta' : 'Control'));

test('selects page text with the mouse and copies it with lines kept', async ({
  page,
  browserName,
}) => {
  const layer = page.locator('[data-text-layer="0"]');
  const lines = layer.locator('[data-row]');
  await expect(lines.first()).toHaveText('PAGE 1 OF outline-named-dests');
  await expect(page.locator('[data-page-index="0"]')).toHaveAttribute('role', 'region');

  const first = await lines.nth(0).boundingBox();
  const second = await lines.nth(1).boundingBox();
  if (!first || !second) throw new Error('text layer not laid out');
  await page.mouse.move(first.x + 1, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(second.x + second.width - 1, second.y + second.height / 2, { steps: 8 });
  await page.mouse.up();
  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '');
  expect(selected).toContain('PAGE 1 OF outline-named-dests');
  expect(selected).toContain('Chapter 1: Introduction');

  // Copy assembles the lines (the raw DOM order would glue them together).
  const copied = await page.evaluate(() => {
    let text = '';
    const onCopy = (event: ClipboardEvent) => {
      text = event.clipboardData?.getData('text/plain') ?? '';
    };
    document.addEventListener('copy', onCopy);
    const data = new DataTransfer();
    document.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, cancelable: true }));
    document.removeEventListener('copy', onCopy);
    return text || data.getData('text/plain');
  });
  expect(copied).toBe('PAGE 1 OF outline-named-dests\nChapter 1: Introduction');

  if (browserName === 'chromium') {
    await page.keyboard.press(`${await mod(page)}+c`);
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe('PAGE 1 OF outline-named-dests\nChapter 1: Introduction');
  }

  // Double-click selects a word.
  await page.mouse.dblclick(second.x + 10, second.y + second.height / 2);
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('Chapter');
});

test('finds text, steps through the hits and clears with Escape', async ({ page }) => {
  await page.keyboard.press(`${await mod(page)}+f`);
  const field = page.getByRole('searchbox', { name: 'Find in document' });
  await expect(field).toBeFocused();
  // Before a query: one hint line with the shortcut, and no count or previous/next yet.
  await expect(page.getByTestId('search-hint')).toContainText('Type to search the document’s text');
  await expect(page.getByRole('button', { name: 'Next result' })).toHaveCount(0);
  await field.fill('outline-named-dests');
  await expect(page.getByTestId('search-hint')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Next result' })).toBeVisible();

  const status = page.getByTestId('status-search');
  await expect(status).toContainText('1 of 6');
  await expect(page.getByTestId('search-hit')).toHaveCount(6);
  // Mod+F shows the navigator's Find tab, its count in the name.
  await expect(page.getByRole('tab', { name: 'Find, 6 items' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.locator('[data-testid="search-highlights"]').first()).toBeVisible();

  await field.press('Enter');
  await expect(status).toContainText('2 of 6');
  await expect(page.getByTestId('status-pages')).toHaveText('Page 2 of 6');
  await field.press('Enter');
  await expect(status).toContainText('3 of 6');
  await expect(page.getByTestId('status-pages')).toHaveText('Page 3 of 6');
  await field.press('Shift+Enter');
  await expect(status).toContainText('2 of 6');
  await page.keyboard.press('F3');
  await expect(status).toContainText('3 of 6');

  // Match case finds nothing for the upper-cased query.
  await field.fill('OUTLINE');
  // A new search starts from the reader's page (page 3).
  await expect(status).toContainText('3 of 6');
  await page.getByRole('button', { name: 'Match case' }).click();
  await expect(page.getByTestId('search-status')).toHaveText('No results');

  await field.press('Escape');
  await expect(status).toHaveCount(0);
  await expect(page.locator('[data-testid="search-highlights"]')).toHaveCount(0);
  await expect(page.getByRole('searchbox', { name: 'Find in document' })).toHaveCount(0);
});

test('the navigator has four tabs with counts; the inspector starts closed', async ({ page }) => {
  const rail = page.getByRole('tablist', { name: 'Navigator views' });
  // Labels under the icons; the badge shows the count (hidden at 0).
  await expect(rail.getByRole('tab')).toHaveText([/^6Pages$/, 'Find', 'Review', /^1Files$/]);
  await expect(rail.getByRole('tab', { name: 'Pages, 6 items' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(rail.getByRole('tab', { name: 'Files, 1 item' })).toBeVisible();
  await expect(page.locator('#right-panel')).toHaveCount(0);

  // Document info is a sheet from the Document menu, not a form in the inspector.
  await page.getByTestId('document-menu').click();
  await page.getByRole('menuitem', { name: 'Document info…' }).click();
  const sheet = page.getByRole('dialog', { name: 'Document info' });
  await expect(sheet.getByTestId('metadata-editor')).toBeVisible();
  await expect(sheet.getByText('outline-named-dests.pdf')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await expect(page.locator('#right-panel')).toHaveCount(0);

  // The inspector opens only when asked (Mod+Alt+B) and is remembered across a reload.
  await page.keyboard.press('ControlOrMeta+Alt+b');
  await expect(page.locator('#right-panel')).toBeVisible();
  await expect(page.locator('#right-panel').getByTestId('metadata-editor')).toHaveCount(0);
  await page.reload();
  await openFixtures(page, ['outline-named-dests.pdf']);
  await expect(page.locator('#right-panel')).toBeVisible();
});

test('an internal link navigates; an external one asks first', async ({ page }) => {
  await page.keyboard.press(']');
  await expect(page.getByTestId('status-pages')).toHaveText('Page 2 of 6');

  const links = page.locator('[data-page-index="1"] [data-link]');
  await expect(links).toHaveCount(3);
  await page.getByRole('button', { name: 'Go to page 4' }).click();
  await expect(page.getByTestId('status-pages')).toHaveText('Page 4 of 6');

  await page.keyboard.press('[');
  await page.keyboard.press('[');
  await expect(page.getByTestId('status-pages')).toHaveText('Page 2 of 6');
  let popups = 0;
  page.on('popup', () => {
    popups += 1;
  });
  await page.getByRole('button', { name: 'External link: https://example.com/' }).click();
  const confirm = page.getByTestId('link-confirm');
  await expect(confirm).toContainText('https://example.com/');
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toHaveCount(0);
  expect(popups).toBe(0);
});

test('go to page accepts numbers; Home and End jump to the ends', async ({ page }) => {
  await page.keyboard.press(`${await mod(page)}+g`);
  const input = page.getByRole('textbox', { name: 'Page number or label' });
  await input.fill('9');
  await expect(page.getByText('No page “9”')).toBeVisible();
  await input.fill('5');
  await input.press('Enter');
  await expect(page.getByTestId('status-pages')).toHaveText('Page 5 of 6');
  await page.keyboard.press('End');
  await expect(page.getByTestId('status-pages')).toHaveText('Page 6 of 6');
  await page.keyboard.press('Home');
  await expect(page.getByTestId('status-pages')).toHaveText('Page 1 of 6');
});

test('two-up layout shows pages side by side', async ({ page }) => {
  await page.getByRole('radio', { name: 'Two pages' }).click();
  const left = page.locator('[data-page-index="0"]');
  const right = page.locator('[data-page-index="1"]');
  await expect(right).toBeVisible();
  const a = await left.boundingBox();
  const b = await right.boundingBox();
  if (!a || !b) throw new Error('pages not laid out');
  expect(Math.abs(a.y - b.y)).toBeLessThan(1);
  expect(b.x).toBeGreaterThan(a.x + a.width);
  await expect(page.locator('main canvas[data-state="rendered"]').first()).toBeVisible();

  await page.keyboard.press(']');
  await expect(page.getByTestId('status-pages')).toHaveText('Page 3 of 6');
  await page.getByRole('radio', { name: 'Continuous' }).click();
  await expect(page.getByTestId('status-pages')).toHaveText('Page 3 of 6');
});

test('the status bar keeps page, privacy and zoom; the view switch lives over the stage', async ({
  page,
}) => {
  const status = page.getByRole('contentinfo');
  await expect(status.getByTestId('status-pages')).toHaveText('Page 1 of 6');
  await expect(status.getByTestId('privacy-indicator')).toBeVisible();
  await expect(status.getByRole('button', { name: 'Zoom in' })).toBeVisible();
  await expect(status.getByRole('button', { name: 'Read mode' })).toHaveCount(0);
  await expect(status.getByRole('button', { name: 'Arrange pages' })).toHaveCount(0);
  // Read (locked) · Edit · Arrange; Home is the app glyph, not a segment (ADR-0019 §1–§2).
  const modes = page.getByRole('radiogroup', { name: 'View mode' }).getByRole('radio');
  await expect(modes).toHaveText(['Read', 'Edit', 'Arrange']);
  await expect(modes.first()).toHaveAccessibleName('Read, locked');
  for (const [index, key] of ['1', '2', '3'].entries()) {
    await expect(modes.nth(index)).toHaveAttribute('aria-keyshortcuts', key);
  }
});

/** A PDF with 500 annotations, 50 on each of 10 pages: notes, squares and pen strokes. */
async function fiveHundredAnnotations(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  for (let p = 0; p < 10; p++) {
    const page = doc.addPage([612, 792]);
    const annots = [];
    for (let i = 0; i < 50; i++) {
      const x = 40 + (i % 10) * 55;
      const y = 680 - Math.floor(i / 10) * 120;
      const Rect = [x, y, x + 40, y + 30];
      const NM = PDFString.of(`a-${p}-${i}`);
      const dict =
        i % 3 === 0
          ? ctx.obj({
              Type: 'Annot',
              Subtype: 'Text',
              Rect,
              NM,
              Contents: PDFString.of(`Note ${i}`),
            })
          : i % 3 === 1
            ? ctx.obj({ Type: 'Annot', Subtype: 'Square', Rect, NM, C: [1, 0, 0] })
            : ctx.obj({
                Type: 'Annot',
                Subtype: 'Ink',
                Rect,
                NM,
                C: [0, 0, 1],
                InkList: [[x + 2, y + 2, x + 20, y + 25, x + 38, y + 5]],
              });
      annots.push(ctx.register(dict));
    }
    page.node.set(PDFName.of('Annots'), ctx.obj(annots));
  }
  return Buffer.from(await doc.save());
}

// M6 review: Review with 500 items took 284 ms to its first row, with a 114 ms long task.
test('the Review tab shows the first of 500 items within 100 ms, without a long task', async ({
  page,
}) => {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open files' }).first().click();
  await (await chooser).setFiles({
    name: 'review-500.pdf',
    mimeType: 'application/pdf',
    buffer: await fiveHundredAnnotations(),
  });
  const review = page.getByRole('tab', { name: /^Review/ });
  // Every page's annotations are read (the badge counts them) before the tab opens.
  await expect(review).toHaveAccessibleName('Review, 500 items', { timeout: 30_000 });
  await page.waitForTimeout(500);

  // Three openings from the Pages tab; the median keeps one slow frame of a loaded machine
  // from deciding.
  const runs: { firstRow: number; longest: number; rows: number }[] = [];
  for (let run = 0; run < 3; run++) {
    await page.getByRole('tab', { name: /^Pages/ }).click();
    await expect(page.locator('[data-review-panel]')).toHaveCount(0);
    await page.waitForTimeout(500);
    runs.push(
      await review.evaluate(async (tab: HTMLElement) => {
        const long: number[] = [];
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) long.push(entry.duration);
        });
        observer.observe({ type: 'longtask' });
        const start = performance.now();
        tab.click();
        let firstRow = Number.POSITIVE_INFINITY;
        for (let i = 0; i < 600 && firstRow === Number.POSITIVE_INFINITY; i++) {
          if (document.querySelector('[data-review-panel] [data-review-kind]')) {
            firstRow = performance.now() - start;
          } else await new Promise((resolve) => setTimeout(resolve, 1));
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
        observer.disconnect();
        const rows = document.querySelectorAll('[data-review-panel] [data-review-kind]').length;
        return { firstRow, longest: Math.max(0, ...long), rows };
      }),
    );
  }
  const median = (values: number[]) => values.sort((a, b) => a - b)[1] ?? Number.NaN;
  expect(median(runs.map((run) => run.firstRow))).toBeLessThan(100);
  expect(median(runs.map((run) => run.longest))).toBeLessThanOrEqual(50);
  for (const run of runs) expect(run.rows).toBeLessThan(60);
});

/** The first Read page canvas that holds a rendered bitmap. */
const readBitmap = (page: Page) =>
  page.locator('[data-read-viewport] canvas[data-state="rendered"]').first();

// Regression: the virtualized page column found no scroll element on its first commit and
// stayed blank until something (a window resize) re-rendered it.
test('Read mode renders pages after Arrange without a resize', async ({ page }) => {
  await expect(readBitmap(page)).toBeVisible();
  await page.keyboard.press('3');
  await expect(page.locator('[data-read-viewport]')).toHaveCount(0);
  await page.keyboard.press('1');
  await expect(page.locator('[data-read-viewport] [data-page-index="0"]')).toBeVisible();
  await expect(readBitmap(page)).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId('status-pages')).toHaveText('Page 1 of 6');
});

// Regression (M6 review): the fitted zoom kept the viewport centre in place across a resize,
// so 1440 → 1024 → 1440 px scrolled page 1's only text (its heading) out of view.
test('page 1 keeps its text in view through 1440 → 1024 → 1440 px', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const viewport = page.locator('[data-read-viewport]');
  const first = viewport.locator('[data-page-index="0"] canvas[data-state="rendered"]');
  /** Dark pixels of page 1's bitmap in the part of the page the viewport shows. */
  const visibleInk = () =>
    first.evaluate((canvas: HTMLCanvasElement) => {
      const sheet = canvas.getBoundingClientRect();
      const view = canvas.closest('[data-read-viewport]')?.getBoundingClientRect();
      if (!view) return 0;
      const top = Math.max(sheet.top, view.top);
      const bottom = Math.min(sheet.bottom, view.bottom);
      if (bottom <= top) return 0;
      const ratio = canvas.width / sheet.width;
      const data = canvas
        .getContext('2d')
        ?.getImageData(
          0,
          Math.floor((top - sheet.top) * ratio),
          canvas.width,
          Math.max(1, Math.floor((bottom - top) * ratio)),
        ).data;
      let ink = 0;
      for (let i = 0; data && i < data.length; i += 4) if ((data[i] ?? 255) < 160) ink++;
      return ink;
    });
  const settle = async (width: number) => {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() =>
        first.evaluate(
          // The bitmap follows the sheet at device scale once the re-render has landed;
          // a one-pixel tolerance covers the snapped sheet size on every engine.
          (canvas: HTMLCanvasElement) =>
            Math.abs(canvas.width - canvas.getBoundingClientRect().width * devicePixelRatio) <= 1,
        ),
      )
      .toBe(true);
  };
  await settle(1440);
  await expect.poll(visibleInk).toBeGreaterThan(0);
  await settle(1024);
  await settle(1440);
  expect(await viewport.evaluate((el) => el.scrollTop)).toBe(0);
  await expect.poll(visibleInk).toBeGreaterThan(0);
});

test('a document opened in Read mode renders its pages, and so does the tab left', async ({
  page,
}) => {
  await expect(readBitmap(page)).toBeVisible();
  await openFixtures(page, ['simple-text.pdf']);
  const second = page.getByRole('tab', { name: 'simple-text' });
  await second.click();
  await expect(second).toHaveAttribute('aria-selected', 'true');
  const viewport = page.locator('[data-read-viewport]');
  await expect(viewport.locator('[data-page-index="0"]')).toBeVisible();
  await expect(readBitmap(page)).toBeVisible({ timeout: 5_000 });

  await page.getByRole('tab', { name: 'outline-named-dests' }).click();
  await expect(page.getByTestId('status-pages')).toHaveText('Page 1 of 6');
  await expect(readBitmap(page)).toBeVisible({ timeout: 5_000 });
});

test('screenshots of find and the two-up layout (design review)', async ({ browserName, page }) => {
  test.skip(
    !process.env.CAPTURE_SCREENSHOTS || browserName !== 'chromium',
    'Set CAPTURE_SCREENSHOTS=1 (Chromium) to write docs/design/screenshots/.',
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.keyboard.press(`${await mod(page)}+f`);
  const field = page.getByRole('searchbox', { name: 'Find in document' });
  await field.fill('page');
  await expect(page.getByTestId('status-search')).toContainText('1 of 7');
  await field.press('Enter');
  await field.press('Enter');
  await expect(page.getByTestId('status-search')).toContainText('3 of 7');
  await expect(
    page.locator('[data-read-viewport] canvas[data-state="rendered"]').first(),
  ).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({ path: fileURLToPath(new URL('m2-search-1440.png', screenshots)) });

  await field.press('Escape');
  await page.getByRole('tab', { name: /^Pages/ }).click();
  await page.getByRole('radio', { name: 'Two pages' }).click();
  await page.keyboard.press('Home');
  await expect(page.getByTestId('status-pages')).toHaveText('Page 1 of 6');
  await expect(page.locator('[data-page-index="1"] canvas[data-state="rendered"]')).toBeVisible();
  await page.mouse.move(720, 450);
  await page.waitForTimeout(500);
  await page.screenshot({ path: fileURLToPath(new URL('m2-two-up-1440.png', screenshots)) });
});
