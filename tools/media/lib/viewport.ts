/**
 * The capture viewport (spec §2.3): 1440 × 900 CSS pixels at 2 device pixels each.
 *
 * By default the scale factor is emulated (Playwright's `deviceScaleFactor: 2`): the app
 * lays out and renders at 2x, stills (`page.screenshot`) are 2880 × 1800, and Chromium's
 * screencast sends clip frames at 1440 × 900 CSS pixels, downsampled from the 2x render,
 * at 30–50 fps on four cores (docs/research/10-media-spike.md).
 *
 * MEDIA_WINDOW_SCALE=2 (or 1.5) instead launches a real window at that forced scale
 * factor, sized until its page is exactly 1440 × 900 (`fitWindow`). Its screencast frames
 * are full size (2880 × 1800) but arrive at about 14 fps on the same machine, too few for
 * a pointer that moves; it stays here for faster runners and for the spike's comparison.
 */
import { expect, type Page } from '@playwright/test';

export const VIEWPORT = { width: 1440, height: 900 } as const;
const windowScale = Number(process.env.MEDIA_WINDOW_SCALE ?? 0);
export const EMULATED = !(windowScale > 0);
export const SCALE = EMULATED ? 2 : windowScale;

/** Context and launch options for the configured mode. */
export function viewportOptions(): {
  viewport: { width: number; height: number } | null;
  deviceScaleFactor?: number;
  args: string[];
} {
  if (EMULATED) return { viewport: { ...VIEWPORT }, deviceScaleFactor: SCALE, args: [] };
  return {
    viewport: null,
    args: [
      `--force-device-scale-factor=${SCALE}`,
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    ],
  };
}

/**
 * Sizes a real window so its page is exactly 1440 × 900 (headless Chromium may reserve
 * part of the window, the headless shell does not), then checks the scale factor.
 */
export async function fitWindow(page: Page): Promise<void> {
  if (!EMULATED) {
    const session = await page.context().newCDPSession(page);
    try {
      // Window and page sizes round differently at fractional scales; a few passes settle.
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const inner = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
        const dw = VIEWPORT.width - inner.width;
        const dh = VIEWPORT.height - inner.height;
        if (dw === 0 && dh === 0) break;
        const { windowId, bounds } = await session.send('Browser.getWindowForTarget');
        await session.send('Browser.setWindowBounds', {
          windowId,
          bounds: {
            width: (bounds.width ?? VIEWPORT.width) + dw,
            height: (bounds.height ?? VIEWPORT.height) + dh,
          },
        });
        // The page sees the new size once it has laid out again.
        await page.evaluate(() => new Promise(requestAnimationFrame));
      }
    } finally {
      await session.detach();
    }
  }
  await expect
    .poll(() => page.evaluate(() => [innerWidth, innerHeight, devicePixelRatio]))
    .toEqual([VIEWPORT.width, VIEWPORT.height, SCALE]);
}
