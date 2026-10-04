/**
 * Spike S2 measurements for "Glass panels" (craft spec §7, docs/research/14-glass-spike.md),
 * Chromium only. A generated 50-page document of alternating text and image pages, both
 * panels open, scrolled frame by frame at fit width (pages beside the panels) and zoomed in
 * (pages under them), and the light table in Arrange (nothing under the frame), with the
 * setting off and on. Each run records the interval between animation frames and prints p50,
 * p95, p99, the worst, and the share of frames over 16.7 ms. Since review F7 there is no
 * geometry gate: with the setting on every docked surface blurs, in every view.
 *
 * It reports and never fails on the numbers: headless Chromium here renders on the CPU
 * (SwiftShader), so the figures are a trend between the two settings on one machine, not
 * the owner's GPU. GPU memory is not readable from a headless page; the report leaves it to
 * the owner's machine.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { deflateSync } from 'node:zlib';

import { expect, type Page, test } from '@playwright/test';

import { showInspector, useFileInputPicker } from './helpers';

/** `src/state/appearance-store.ts` (kept in step by hand: e2e does not import app code). */
const APPEARANCE_STORAGE_KEY = 'pdf-editor:appearance:v1';
const PAGES = 50;
const SCROLL_FRAMES = 240;
const SCROLL_STEP_PX = 24;

/** A small PDF writer: Helvetica text pages and RGB image pages, alternating. */
function generateDocument(pages: number): Buffer {
  const objects: (string | Buffer)[] = [];
  const add = (body: string | Buffer) => {
    objects.push(body);
    return objects.length;
  };
  const stream = (dict: string, data: Buffer) =>
    Buffer.concat([
      Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`, 'latin1'),
      data,
      Buffer.from('\nendstream', 'latin1'),
    ]);

  const catalog = add('');
  const tree = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  // A 640 × 420 photograph-like gradient with noise, Flate-compressed.
  const [w, h] = [640, 420];
  const pixels = Buffer.alloc(w * h * 3);
  let seed = 7;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const noise = (seed >> 16) % 24;
      const i = (y * w + x) * 3;
      pixels[i] = Math.min(255, Math.round((x / w) * 200) + noise);
      pixels[i + 1] = Math.min(255, Math.round((y / h) * 180) + noise);
      pixels[i + 2] = Math.min(255, 120 + Math.round(Math.sin(x / 40 + y / 60) * 80) + noise);
    }
  }
  const image = add(
    stream(
      `/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`,
      deflateSync(pixels),
    ),
  );
  const kids: number[] = [];
  for (let p = 0; p < pages; p++) {
    let content = '';
    if (p % 2 === 0) {
      content += 'BT /F1 11 Tf 14 TL 56 780 Td\n';
      content += `(Page ${p + 1}: a text page for the glass spike) Tj T*\n`;
      for (let line = 0; line < 48; line++) {
        content += `(Line ${line + 1}. The quick brown fox jumps over the lazy dog, again and again.) Tj T*\n`;
      }
      content += 'ET\n';
    } else {
      content += `q 500 0 0 328 56 420 cm /Im0 Do Q\nBT /F1 12 Tf 56 380 Td (Page ${p + 1}: an image page) Tj ET\n`;
    }
    const contents = add(stream('', Buffer.from(content, 'latin1')));
    kids.push(
      add(
        `<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 612 792] /Contents ${contents} 0 R ` +
          `/Resources << /Font << /F1 ${font} 0 R >> /XObject << /Im0 ${image} 0 R >> >> >>`,
      ),
    );
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${tree} 0 R >>`;
  objects[tree - 1] =
    `<< /Type /Pages /Count ${pages} /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] >>`;

  const parts: Buffer[] = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets: number[] = [];
  let length = parts[0]?.length ?? 0;
  objects.forEach((body, i) => {
    offsets.push(length);
    const chunk = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`, 'latin1'),
      typeof body === 'string' ? Buffer.from(body, 'latin1') : body,
      Buffer.from('\nendobj\n', 'latin1'),
    ]);
    parts.push(chunk);
    length += chunk.length;
  });
  const xref =
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${length}\n%%EOF\n`;
  parts.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(parts);
}

interface FrameStats {
  readonly frames: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
  readonly over16_7: number;
  readonly blurredSurfaces: string;
  /** The first laid-out page's width, CSS px: shows the zoom the run scrolled at. */
  readonly pageWidth: number;
}

/**
 * Scrolls a view (the Read viewport, or the light table) one step per animation frame and
 * records frame intervals, and which docked surfaces carry a backdrop filter meanwhile.
 */
async function scrollRun(page: Page, selector = '[data-read-viewport]'): Promise<FrameStats> {
  return page.evaluate(
    async ({ frames, step, selector }) => {
      const viewport = document.querySelector<HTMLElement>(selector);
      if (!viewport) throw new Error(`no ${selector}`);
      viewport.scrollTop = 0;
      const shell = document.querySelector('[data-stage-bleed]');
      const surfaces: readonly (readonly [string, string])[] = [
        ['title', ':scope > header'],
        ['left', ':scope > [data-region="navigator"]'],
        ['right', ':scope > #right-panel'],
        ['status', ':scope > footer'],
      ];
      const near = new Set<string>();
      const times: number[] = [];
      await new Promise<void>((resolve) => {
        let n = 0;
        const tick = (now: number) => {
          times.push(now);
          if (n === 0) {
            for (const [name, query] of surfaces) {
              const el = shell?.querySelector(query);
              const filter = el ? getComputedStyle(el).backdropFilter : 'none';
              if (filter && filter !== 'none') near.add(name);
            }
          }
          if (n++ >= frames) {
            resolve();
            return;
          }
          viewport.scrollTop += step;
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      const intervals = times.slice(1).map((t, i) => t - (times[i] ?? t));
      const sorted = [...intervals].sort((a, b) => a - b);
      const at = (q: number) =>
        sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
      const round = (v: number) => Math.round(v * 100) / 100;
      return {
        frames: intervals.length,
        p50: round(at(0.5)),
        p95: round(at(0.95)),
        p99: round(at(0.99)),
        max: round(sorted.at(-1) ?? 0),
        over16_7: round((intervals.filter((v) => v > 16.7).length / intervals.length) * 100),
        blurredSurfaces: [...near].sort().join(' ') || 'none',
        pageWidth: Math.round(
          document.querySelector('[data-read-viewport] [data-page-index]')?.getBoundingClientRect()
            .width ?? 0,
        ),
      };
    },
    { frames: SCROLL_FRAMES, step: SCROLL_STEP_PX, selector },
  );
}

test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium only (spike S2)');

test('S2: frame times while scrolling 50 pages under both panels, Glass panels off and on', async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const file = testInfo.outputPath('glass-spike-50-pages.pdf');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, generateDocument(PAGES));

  await page.setViewportSize({ width: 1440, height: 900 });
  await useFileInputPicker(page);
  const results: Record<string, FrameStats | string> = {};
  // The GPU the numbers come from (software rendering headless); informational only.
  try {
    const cdp = await page.context().browser()?.newBrowserCDPSession();
    const info = (await cdp?.send('SystemInfo.getInfo')) as
      | { gpu: { devices: { deviceString: string; vendorString: string }[] } }
      | undefined;
    results.gpu =
      info?.gpu.devices.map((d) => `${d.vendorString} ${d.deviceString}`).join('; ') ?? 'unknown';
  } catch {
    results.gpu = 'unknown';
  }
  results.devicePixelRatio = String(await page.evaluate(() => window.devicePixelRatio));

  for (const glassPanels of [false, true]) {
    await page.goto('./');
    await page.evaluate(
      ([key, on]) => localStorage.setItem(key as string, JSON.stringify({ glassPanels: on })),
      [APPEARANCE_STORAGE_KEY, glassPanels] as const,
    );
    await page.reload();
    const chooser = page.waitForEvent('filechooser');
    await page
      .getByRole('button', { name: /^(Open files|Dosya aç)$/ })
      .first()
      .click();
    await (await chooser).setFiles(file);
    await expect(page.locator('canvas[data-state="rendered"]').first()).toBeAttached({
      timeout: 30_000,
    });
    await showInspector(page);
    const label = glassPanels ? 'on' : 'off';
    expect(
      await page.evaluate(() => document.documentElement.hasAttribute('data-glass-panels')),
    ).toBe(glassPanels);
    // Fit width: the pages sit beside the panels.
    await page.waitForTimeout(500);
    results[`fit width, setting ${label}`] = await scrollRun(page);
    // Zoomed in four steps (150 %): the pages run under the navigator and the inspector.
    await page.evaluate(() => {
      const viewport = document.querySelector<HTMLElement>('[data-read-viewport]');
      viewport?.focus();
    });
    for (let i = 0; i < 4; i++) await page.keyboard.press('ControlOrMeta+=');
    await page.waitForTimeout(800);
    results[`zoomed in, setting ${label}`] = await scrollRun(page);
    await page.evaluate(() => {
      const viewport = document.querySelector<HTMLElement>('[data-read-viewport]');
      if (viewport) viewport.scrollTop = 1500;
    });
    await page.waitForTimeout(800);
    const shot = testInfo.outputPath(`glass-zoomed-${label}.png`);
    await page.screenshot({ path: shot });
    await testInfo.attach(`zoomed in, setting ${label}`, { path: shot, contentType: 'image/png' });
    // Arrange: nothing passes under the frame here; without the old 80 px gate (review F7)
    // the frame blurs all the same, so this run shows what that costs.
    await page.keyboard.press('3');
    await expect(page.getByTestId('light-table')).toBeVisible();
    await page.waitForTimeout(800);
    results[`arrange, setting ${label}`] = await scrollRun(page, '[data-testid="light-table"]');
  }

  const summary = JSON.stringify(results, null, 2);
  console.log(`S2 glass spike (headless; a trend, not the owner's GPU):\n${summary}`);
  testInfo.annotations.push({ type: 'S2 frame times', description: summary });
  writeFileSync(testInfo.outputPath('glass-perf.json'), summary);
});
