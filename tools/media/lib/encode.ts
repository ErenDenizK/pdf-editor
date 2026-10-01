/**
 * Turns what the scenes captured (`out/<id>/`) into the published files (`out/media/`),
 * with ffmpeg (spec §2.4). Run as `pnpm encode [id…]`; without ids, every captured scene.
 *
 * - Still: framed (lib/frame.ts) at 1800 px, saved as PNG by ffmpeg at its highest zlib
 *   level with per-row filter choice (`-pred mixed`), plus WebP q90 (alpha kept).
 * - Clip: the ffconcat list gives each frame its real duration; ffmpeg resamples to a
 *   constant rate. README GIF: 15 fps, 1200 px wide, the scene's crop, two-pass palette
 *   (`palettegen`, see GIF_STATS_MODE; `paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`)
 *   and the hairline; square corners, since transparency makes ffmpeg write whole frames
 *   (lib/frame.ts). Web clip: 30 fps MP4 (H.264, `-crf 20
 *   -preset slow -pix_fmt yuv420p -movflags +faststart`), WebM (VP9, constant quality) and
 *   a WebP poster from the last frame.
 *
 * `out/requests.log` is copied next to the media, which it is published with.
 */
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { chromium, type Browser } from '@playwright/test';

import { chromiumLaunchOptions } from '../../../tooling/playwright-chromium.ts';
import { HERMETIC_ARGS } from './browser.ts';
import { type Crop, frameStill, hairlineLayer } from './frame.ts';
import { MEDIA_DIR, OUT_DIR, REQUEST_LOG, sceneDir } from './paths.ts';
import { imageSize, type FrameRecord } from './recorder.ts';
import type { SceneRecord } from './scene.ts';
import { VIEWPORT } from './viewport.ts';

/** Hero still width (spec §2.4: "PNG 1800 px"), twice the 900 px it is shown at. */
export const STILL_WIDTH = 1800;
/** README GIF (spec §2.4). */
export const GIF_WIDTH = 1200;
export const GIF_FPS = 15;
/**
 * Palette statistics. The spec names `diff`, but on clip 1 it starved colours that appear
 * once (rendered thumbnails) in favour of the greys under the moving pointer: the poster
 * frame lost its orange, green and yellow. `full` keeps them and was 7% smaller
 * (docs/research/10-media-spike.md). MEDIA_GIF_STATS=diff restores the spec's choice.
 */
export const GIF_STATS_MODE = process.env.MEDIA_GIF_STATS === 'diff' ? 'diff' : 'full';
/** About-page clip: the frames' own width (1440 px at the default capture), 30 fps. */
export const WEB_WIDTH = 1440;
export const WEB_FPS = 30;

function ffmpeg(args: readonly string[]): void {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
}

/** ffmpeg `crop=` for a CSS-pixel crop of frames `scale` device pixels per CSS pixel. */
function cropFilter(crop: Crop | undefined, scale: number): string[] {
  if (!crop) return [];
  const px = (value: number) => Math.round(value * scale);
  return [`crop=${px(crop.width)}:${px(crop.height)}:${px(crop.x)}:${px(crop.y)}`];
}

/** Output height for `width`, from the crop's (or viewport's) aspect ratio; even if asked. */
function heightFor(width: number, crop: Crop | undefined, even: boolean): number {
  const box = crop ?? VIEWPORT;
  const height = Math.round((width * box.height) / box.width);
  return even ? height + (height % 2) : height;
}

async function encodeStill(browser: Browser, record: SceneRecord): Promise<string[]> {
  const raw = readFileSync(join(sceneDir(record.id), 'raw.png'));
  const size = imageSize(raw);
  if (!size) throw new Error(`${record.id}: raw.png is not a PNG`);
  const framed = await frameStill(browser, raw, {
    scale: size.width / VIEWPORT.width,
    width: STILL_WIDTH,
    crop: record.crop,
  });
  const framedPath = join(sceneDir(record.id), 'framed.png');
  writeFileSync(framedPath, framed);

  const png = join(MEDIA_DIR, `${record.id}.png`);
  const webp = join(MEDIA_DIR, `${record.id}.webp`);
  ffmpeg(['-i', framedPath, '-c:v', 'png', '-compression_level', '9', '-pred', 'mixed', png]);
  ffmpeg([
    ...['-i', framedPath, '-c:v', 'libwebp', '-quality', '90', '-pix_fmt', 'yuva420p'],
    ...['-compression_level', '6', webp],
  ]);
  return [png, webp];
}

async function encodeClip(browser: Browser, record: SceneRecord): Promise<string[]> {
  const dir = sceneDir(record.id);
  const list = join(dir, 'frames.ffconcat');
  const { records } = JSON.parse(readFileSync(join(dir, 'recording.json'), 'utf8')) as {
    records: FrameRecord[];
  };
  const last = records.at(-1);
  if (!last) throw new Error(`${record.id}: no frames`);
  const frameSize = imageSize(readFileSync(join(dir, last.file)));
  if (!frameSize) throw new Error(`${record.id}: unreadable frame ${last.file}`);
  // Frames may be 1x or 2x of the viewport (lib/viewport.ts); crops are in CSS pixels.
  const crop = cropFilter(record.crop, frameSize.width / VIEWPORT.width);
  const input = ['-f', 'concat', '-safe', '0', '-i', list];
  const outputs: string[] = [];

  // README GIF: the hairline over every frame, then one palette for the whole clip, and
  // only the changed rectangle of each frame written.
  const gifHeight = heightFor(GIF_WIDTH, record.crop, false);
  const hairlinePath = join(dir, 'gif-hairline.png');
  writeFileSync(hairlinePath, await hairlineLayer(browser, GIF_WIDTH, gifHeight));
  const gif = join(MEDIA_DIR, `${record.id}.gif`);
  const gifChain = [`fps=${GIF_FPS}`, ...crop, `scale=${GIF_WIDTH}:${gifHeight}:flags=lanczos`];
  ffmpeg([
    ...input,
    ...['-i', hairlinePath],
    '-filter_complex',
    [
      `[0:v]${gifChain.join(',')}[v]`,
      '[v][1:v]overlay=format=auto[o]',
      '[o]split[s0][s1]',
      `[s0]palettegen=stats_mode=${GIF_STATS_MODE}[p]`,
      '[s1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle',
    ].join(';'),
    ...['-loop', '0', gif],
  ]);
  outputs.push(gif);

  // About-page clip.
  const webHeight = heightFor(WEB_WIDTH, record.crop, true);
  const webChain = [
    `fps=${WEB_FPS}`,
    ...crop,
    `scale=${WEB_WIDTH}:${webHeight}:flags=lanczos`,
    'format=yuv420p',
  ].join(',');
  const mp4 = join(MEDIA_DIR, `${record.id}.mp4`);
  ffmpeg([
    ...input,
    ...['-vf', webChain, '-an'],
    ...['-c:v', 'libx264', '-crf', '20', '-preset', 'slow', '-pix_fmt', 'yuv420p'],
    ...['-movflags', '+faststart', mp4],
  ]);
  const webm = join(MEDIA_DIR, `${record.id}.webm`);
  ffmpeg([
    ...input,
    ...['-vf', webChain, '-an'],
    ...['-c:v', 'libvpx-vp9', '-crf', '34', '-b:v', '0', '-row-mt', '1'],
    ...['-deadline', 'good', '-cpu-used', '2', '-pix_fmt', 'yuv420p', webm],
  ]);
  // The last beat is the poster (spec §6).
  const poster = join(MEDIA_DIR, `${record.id}.poster.webp`);
  ffmpeg([
    ...['-i', join(dir, last.file)],
    ...['-vf', [...crop, `scale=${WEB_WIDTH}:${webHeight}:flags=lanczos`].join(',')],
    ...['-c:v', 'libwebp', '-quality', '85', '-compression_level', '6', poster],
  ]);
  outputs.push(mp4, webm, poster);
  return outputs;
}

function capturedIds(): string[] {
  if (!existsSync(OUT_DIR)) return [];
  return readdirSync(OUT_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(OUT_DIR, entry.name, 'scene.json')))
    .map((entry) => entry.name)
    .sort();
}

async function main(ids: readonly string[]): Promise<void> {
  const selected = ids.length > 0 ? ids : capturedIds();
  if (selected.length === 0) throw new Error('nothing captured yet: run `pnpm capture` first');
  mkdirSync(MEDIA_DIR, { recursive: true });
  const browser = await chromium.launch({ ...chromiumLaunchOptions(), args: [...HERMETIC_ARGS] });
  try {
    for (const id of selected) {
      const record = JSON.parse(
        readFileSync(join(sceneDir(id), 'scene.json'), 'utf8'),
      ) as SceneRecord;
      const started = performance.now();
      const files =
        record.kind === 'still'
          ? await encodeStill(browser, record)
          : await encodeClip(browser, record);
      const seconds = ((performance.now() - started) / 1000).toFixed(1);
      console.log(
        `${id}: ${files.map((file) => file.slice(MEDIA_DIR.length)).join(', ')} (${seconds} s)`,
      );
    }
  } finally {
    await browser.close();
  }
  if (existsSync(REQUEST_LOG)) copyFileSync(REQUEST_LOG, join(MEDIA_DIR, 'requests.log'));
}

await main(process.argv.slice(2));
