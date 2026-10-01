/**
 * The frame every image gets (spec §2.1): no device frame, no browser chrome, no shadow;
 * the viewport (or a crop of it) with a baked-in 10 px corner radius (`--radius-3`) and a
 * 1 px `rgb(255 255 255 / 0.10)` hairline (`--border-hairline`), on transparent corners.
 *
 * It is drawn by the browser rather than by hand: the image goes into a small HTML page
 * that clips it to the rounded rectangle and draws the hairline on top, and a screenshot
 * with `omitBackground: true` keeps the corners transparent. Radius and hairline are CSS
 * pixels at the size the image is shown at (README and about page: about 900 px wide),
 * so a 1800 px image gets a 20 px radius and a 2 px line.
 *
 * GIFs are the exception: they keep square corners and get only the hairline
 * (`hairlineLayer`, composited per frame by lib/encode.ts). ffmpeg's GIF encoder writes
 * every frame whole once frames contain transparent pixels, which made the 6.5 s clip
 * 8.5–10.3 MB instead of 0.54 MB (docs/research/10-media-spike.md).
 */
import type { Browser } from '@playwright/test';

/** The width the README and the about page show media at, in CSS pixels. */
export const DISPLAY_WIDTH = 900;
export const RADIUS = 10;
export const HAIRLINE = 'rgb(255 255 255 / 0.1)';

/** A rectangle in CSS pixels of the 1440 × 900 viewport. */
export interface Crop {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface Shape {
  readonly width: number;
  readonly height: number;
  readonly radius: number;
  readonly line: number;
}

function shape(width: number, height: number): Shape {
  const scale = width / DISPLAY_WIDTH;
  return { width, height, radius: RADIUS * scale, line: scale };
}

async function render(
  browser: Browser,
  size: { width: number; height: number },
  html: string,
  transparent: boolean,
): Promise<Buffer> {
  // Device scale 1: the page is laid out in output pixels, so nothing is resampled twice.
  const context = await browser.newContext({ viewport: size, deviceScaleFactor: 1 });
  try {
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page
      .locator('img')
      .evaluateAll((images) =>
        Promise.all(images.map((image) => (image as HTMLImageElement).decode())),
      );
    return await page.screenshot({ omitBackground: transparent, type: 'png' });
  } finally {
    await context.close();
  }
}

const RESET = '<style>html,body{margin:0;background:transparent}</style>';

/**
 * Frames a still: `png` is a viewport screenshot at `scale` device pixels per CSS pixel;
 * `crop` (CSS pixels) picks a region; the result is `width` pixels wide.
 */
export async function frameStill(
  browser: Browser,
  png: Buffer,
  options: { readonly scale: number; readonly width: number; readonly crop?: Crop | undefined },
): Promise<Buffer> {
  const sourceWidth = png.readUInt32BE(16);
  const sourceHeight = png.readUInt32BE(20);
  const crop = options.crop ?? {
    x: 0,
    y: 0,
    width: sourceWidth / options.scale,
    height: sourceHeight / options.scale,
  };
  const factor = options.width / crop.width;
  const height = Math.round(crop.height * factor);
  const s = shape(options.width, height);
  const html = `<!doctype html>${RESET}
<div style="position:relative;width:${s.width}px;height:${s.height}px;overflow:hidden;border-radius:${s.radius}px">
  <img alt="" src="data:image/png;base64,${png.toString('base64')}"
    style="position:absolute;left:${-crop.x * factor}px;top:${-crop.y * factor}px;width:${(sourceWidth / options.scale) * factor}px;height:${(sourceHeight / options.scale) * factor}px">
  <div style="position:absolute;inset:0;border-radius:${s.radius}px;box-shadow:inset 0 0 0 ${s.line}px ${HAIRLINE}"></div>
</div>`;
  return render(browser, { width: s.width, height: s.height }, html, true);
}

/** The hairline alone, on a transparent `width` × `height` layer (for GIF frames). */
export async function hairlineLayer(
  browser: Browser,
  width: number,
  height: number,
): Promise<Buffer> {
  const s = shape(width, height);
  return render(
    browser,
    { width, height },
    `<!doctype html>${RESET}<div style="position:absolute;inset:0;box-shadow:inset 0 0 0 ${s.line}px ${HAIRLINE}"></div>`,
    true,
  );
}
