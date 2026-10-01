/**
 * The about page (presentation spec §3, acceptance §8) from the preview build: `about/`
 * transfers at most 300 KB without its videos, asks no other origin for anything, loads no
 * script of the app's bundle, carries the app's Content Security Policy word for word, and
 * under reduced motion leaves the hero clip on its poster. The layout has no horizontal
 * scroll at phone width or at 1440 px, and the app's Document menu opens the page in a new
 * tab.
 *
 * The clips, posters and request log under `media/` are produced by the deploy job's media
 * run, not by `vite build`, so here those requests answer 404; the page must stand without
 * them (each clip keeps its placeholder box) and the test tolerates exactly those.
 */
import { expect, type Page, test } from '@playwright/test';

import { openFixtures, useFileInputPicker } from './helpers';

/** Spec §3: at most 300 KB transferred without videos. */
const BUDGET_BYTES = 300 * 1024;
/** The page's own script pauses clips under reduced motion and nothing else. */
const SCRIPT_BUDGET_BYTES = 4 * 1024;

const CSP_META = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i;

/** The app's entry script and its policy, read from the built `index.html`. */
async function appShell(page: Page): Promise<{ entry: string; csp: string }> {
  const response = await page.request.get('./');
  expect(response.ok()).toBe(true);
  const html = await response.text();
  const entry = /<script\b[^>]*\btype="module"[^>]*\bsrc="([^"]+)"/.exec(html)?.[1];
  const csp = CSP_META.exec(html)?.[1];
  if (!entry || !csp) throw new Error('the built index.html has no entry script or CSP');
  return { entry: new URL(entry, response.url()).pathname, csp };
}

interface Loaded {
  readonly url: string;
  readonly type: string;
  readonly status: number;
  readonly bytes: number;
}

/** Loads `about/` and records every response with its decoded body size. */
async function loadAbout(page: Page): Promise<{ loaded: Loaded[]; requested: string[] }> {
  const requested: string[] = [];
  const reads: Promise<Loaded>[] = [];
  page.on('request', (request) => requested.push(request.url()));
  page.on('response', (response) => {
    const request = response.request();
    reads.push(
      response
        .body()
        .then(
          (body) => body.length,
          // Redirects and aborted media ranges have no body to read.
          () => 0,
        )
        .then((bytes) => ({
          url: response.url(),
          type: request.resourceType(),
          status: response.status(),
          bytes,
        })),
    );
  });
  await page.goto('about/');
  await page.waitForLoadState('networkidle');
  return { loaded: await Promise.all(reads), requested };
}

const isMedia = (url: string) => new URL(url).pathname.includes('/media/');

test('the about page stays within its budget and asks only its own origin', async ({
  page,
  baseURL,
}) => {
  const origin = new URL(baseURL ?? 'http://localhost').origin;
  const app = await appShell(page);
  const { loaded, requested } = await loadAbout(page);

  await expect(page).toHaveTitle('About Recto');
  await expect(
    page.getByRole('heading', {
      level: 1,
      name: 'A PDF editor that runs entirely in your browser. Nothing is uploaded.',
    }),
  ).toBeVisible();

  // Nothing from another origin (data: and blob: never leave the page).
  const foreign = requested.filter(
    (url) => /^(https?|wss?):/.test(url) && new URL(url).origin !== origin,
  );
  expect(foreign).toEqual([]);

  // Only media/ may be missing: it is published by the media job, not by the build.
  const failed = loaded.filter((r) => r.status >= 400 && !isMedia(r.url));
  expect(failed.map((r) => `${r.status} ${r.url}`)).toEqual([]);

  // ≤ 300 KB without the videos (decoded bytes, so an upper bound on what is transferred).
  const total = loaded.filter((r) => r.type !== 'media').reduce((sum, r) => sum + r.bytes, 0);
  test.info().annotations.push({ type: 'about page bytes', description: String(total) });
  expect(total).toBeLessThanOrEqual(BUDGET_BYTES);

  // No app bundle: not the entry script, by tag or by request, and only a few bytes of JS.
  const scripts = await page
    .locator('script[src]')
    .evaluateAll((nodes) => nodes.map((node) => (node as HTMLScriptElement).src));
  expect(scripts.map((src) => new URL(src).pathname)).not.toContain(app.entry);
  expect(requested.map((url) => new URL(url).pathname)).not.toContain(app.entry);
  const js = loaded.filter((r) => r.type === 'script').reduce((sum, r) => sum + r.bytes, 0);
  expect(js).toBeLessThanOrEqual(SCRIPT_BUDGET_BYTES);

  // The same policy as the app, character for character.
  const csp = await page
    .locator('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute('content');
  expect(csp).toBe(app.csp);

  // The clips wait for a click: only the hero may start on its own.
  const clips = await page.locator('video').evaluateAll((videos) =>
    videos.map((node) => {
      const video = node as HTMLVideoElement;
      return { id: video.id, preload: video.getAttribute('preload'), poster: video.poster };
    }),
  );
  expect(clips.length).toBeGreaterThanOrEqual(8);
  for (const clip of clips) {
    expect(clip.preload, clip.id).toBe('none');
    expect(clip.poster, clip.id).toMatch(/\/media\/[\w-]+\.poster\.webp$/);
  }
});

test('the hero clip plays muted in a loop when motion is welcome', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('about/');
  const hero = page.locator('#hero-clip');
  await expect(hero).toBeVisible();
  const state = await hero.evaluate((node) => {
    const video = node as HTMLVideoElement;
    return { autoplay: video.autoplay, muted: video.muted, loop: video.loop };
  });
  expect(state).toEqual({ autoplay: true, muted: true, loop: true });
});

test('under reduced motion the hero clip stays on its poster', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('about/');
  const hero = page.locator('#hero-clip');
  await expect(hero).toBeVisible();
  await expect
    .poll(() =>
      hero.evaluate((node) => {
        const video = node as HTMLVideoElement;
        return {
          autoplay: video.autoplay,
          paused: video.paused,
          preload: video.preload,
          playing: video.currentTime > 0,
        };
      }),
    )
    .toEqual({ autoplay: false, paused: true, preload: 'none', playing: false });
  expect(await hero.getAttribute('poster')).toMatch(/01-open-many\.poster\.webp$/);
});

for (const width of [360, 1440]) {
  test(`no horizontal scroll at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('about/');
    await expect(page.locator('main')).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    // Each clip keeps its box while its poster is missing.
    const box = await page.locator('#hero-clip').boundingBox();
    expect(box?.height ?? 0).toBeGreaterThan(100);
  });
}

test('"About this app" in the Document menu opens the page in a new tab', async ({
  page,
  context,
}) => {
  await useFileInputPicker(page);
  await page.goto('./');
  await openFixtures(page, ['simple-text.pdf']);
  await page.getByTestId('document-menu').click();
  const item = page.getByRole('menuitem', { name: 'About this app' });
  await expect(item).toBeVisible();
  const opened = context.waitForEvent('page');
  await item.click();
  const about = await opened;
  await about.waitForLoadState();
  expect(new URL(about.url()).pathname).toBe(new URL('about/', page.url()).pathname);
  await expect(about).toHaveTitle('About Recto');
  // noopener: the new tab has no handle on the app.
  expect(await about.evaluate(() => window.opener === null)).toBe(true);
});
