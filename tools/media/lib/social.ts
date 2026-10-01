/**
 * `pnpm social`: the repository's social preview and `og:image` (spec §3, §4), rendered
 * from `social/template.html` to `out/media/social.png`, 1280 × 640. It needs the hero still
 * (`out/media/00-hero.png`), so it runs after `encode`. The PNG is re-encoded by ffmpeg at
 * its highest zlib level, like the hero; `check` holds it to its budget (under 1 MB).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { chromium } from '@playwright/test';

import { chromiumLaunchOptions } from '../../../tooling/playwright-chromium.ts';
import { HERMETIC_ARGS } from './browser.ts';
import { MEDIA_DIR, OUT_DIR, TOOL_DIR } from './paths.ts';

export const SOCIAL_SIZE = { width: 1280, height: 640 } as const;
const TEMPLATE = join(TOOL_DIR, 'social', 'template.html');
const HERO = join(MEDIA_DIR, '00-hero.png');

async function main(): Promise<void> {
  if (!existsSync(HERO)) throw new Error('no hero still yet: run `pnpm capture` and `pnpm encode`');
  mkdirSync(MEDIA_DIR, { recursive: true });
  const browser = await chromium.launch({ ...chromiumLaunchOptions(), args: [...HERMETIC_ARGS] });
  const raw = join(OUT_DIR, 'social-raw.png');
  try {
    // Device scale 1: the preview is uploaded at exactly 1280 × 640.
    const context = await browser.newContext({
      viewport: { ...SOCIAL_SIZE },
      deviceScaleFactor: 1,
      colorScheme: 'dark',
    });
    const page = await context.newPage();
    // Everything the template uses is a local file; anything else would be a mistake.
    const foreign: string[] = [];
    page.on('request', (request) => {
      if (!request.url().startsWith('file:')) foreign.push(request.url());
    });
    await page.goto(pathToFileURL(TEMPLATE).href, { waitUntil: 'load' });
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all([...document.images].map((image) => image.decode()));
    });
    const fonts = await page.evaluate(() =>
      [...document.fonts].filter((face) => face.status === 'loaded').map((face) => face.weight),
    );
    if (!fonts.includes('700')) throw new Error('Inter Bold did not load in the template');
    if (foreign.length > 0) throw new Error(`the template asked for ${foreign.join(', ')}`);
    await page.screenshot({ path: raw, type: 'png' });
  } finally {
    await browser.close();
  }
  const out = join(MEDIA_DIR, 'social.png');
  execFileSync(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-y', '-i', raw].concat([
      '-c:v',
      'png',
      '-compression_level',
      '9',
      '-pred',
      'mixed',
      out,
    ]),
    { stdio: ['ignore', 'inherit', 'inherit'] },
  );
  console.log(`social: ${out.slice(MEDIA_DIR.length)}`);
}

await main();
