/**
 * A scene: one still or clip, written as a Playwright test (spec §2.5). A scene file calls
 * `scene({ id, kind, crop, run })`; the harness opens the stage, records a clip or takes
 * the still, holds the last frame, checks the request log, and leaves the raw material in
 * `out/<id>/` with a `scene.json` that `encode` reads. Size limits live in `budgets.json`,
 * keyed by output file.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import type { Crop } from './frame.ts';
import { sceneDir } from './paths.ts';
import { watchRequests } from './privacy.ts';
import { Recorder, type RecordingStats } from './recorder.ts';
import { FINAL_HOLD_MS, type SceneKind, Stage } from './stage.ts';
import { SCALE, VIEWPORT } from './viewport.ts';

export interface Scene {
  /** `NN-name`, the prefix of every output file (`00-hero.png`, `01-open-many.gif`). */
  readonly id: string;
  readonly kind: SceneKind;
  /** The region that matters, in CSS pixels of the 1440 × 900 viewport. */
  readonly crop?: Crop;
  /**
   * Sets the scene off camera (open the documents, go to the page): a clip starts on what
   * `prepare` leaves on screen. Optional; everything in `run` is recorded.
   */
  prepare?(stage: Stage): Promise<void>;
  /**
   * Plays the scene. A clip is recorded from the end of `prepare` (or the first frame
   * after `Stage.open`) until `run` returns plus the final hold; a still is taken when
   * `run` returns.
   */
  run(stage: Stage): Promise<void>;
}

/** What `encode` needs to know about a captured scene (`out/<id>/scene.json`). */
export interface SceneRecord {
  readonly id: string;
  readonly kind: SceneKind;
  readonly crop?: Crop | undefined;
  /** Device pixels per CSS pixel of the captured material. */
  readonly scale: number;
  readonly viewport: { readonly width: number; readonly height: number };
  /** Clips: the recorder's measurements. */
  readonly recording?: RecordingStats;
}

/** The longest a clip may run (spec §6: "each under 8 s"). */
export const MAX_CLIP_MS = 8000;

/**
 * Recorder settings. PNG frames (CDP screencast) by default: JPEG frames differ a little
 * in every static region from one frame to the next, so the GIF's changed rectangles grew
 * to most of the frame. On clip 3 (dialogs, a scrolling page) PNG frames made the GIF
 * 1.83 MB instead of 3.05 MB, over its 3 MB budget, and the MP4 0.87 MB instead of
 * 1.14 MB, at the same frame rate. MEDIA_FRAME_FORMAT=jpeg restores Playwright's
 * `page.screencast` (JPEG only) for comparisons.
 */
function recorderFormat(): { format: 'jpeg' | 'png'; quality: number } {
  const format = process.env.MEDIA_FRAME_FORMAT === 'jpeg' ? 'jpeg' : 'png';
  return { format, quality: Number(process.env.MEDIA_JPEG_QUALITY ?? 90) };
}

/**
 * MEDIA_BEATS=1: prints when each pointer action and hold of a clip ends, in clip seconds
 * (cuts left out), to see where a clip spends its time when it runs long.
 */
function logBeats(id: string, stage: Stage, recorder: Recorder): void {
  const wrap = <T extends object>(target: T, names: readonly (keyof T & string)[]) => {
    for (const name of names) {
      const original = target[name] as unknown as (...args: unknown[]) => Promise<unknown>;
      Object.assign(target, {
        [name]: async (...args: unknown[]) => {
          const result = await original.apply(target, args);
          console.log(`${id} ${recorder.clipTime().toFixed(2)} s  ${name}`);
          return result;
        },
      });
    }
  };
  wrap(stage, ['hold', 'cut', 'rendered']);
  wrap(stage.cursor, ['click', 'move', 'down', 'up']);
}

export function scene(definition: Scene): void {
  test(definition.id, async ({ page, context, baseURL }) => {
    const origin = new URL(baseURL ?? 'http://localhost/').origin;
    const requests = watchRequests(context, definition.id, origin);
    const dir = sceneDir(definition.id);
    mkdirSync(dir, { recursive: true });
    // Stage.open checks that the page is 1440 × 900 at 2x before anything is captured.
    const stage = await Stage.open(page, definition.kind);
    const viewport = { ...VIEWPORT };
    const scale = SCALE;
    let recording: RecordingStats | undefined;
    await definition.prepare?.(stage);
    if (definition.kind === 'clip') {
      const engine = process.env.MEDIA_SCREENCAST;
      const recorder = await Recorder.start(page, {
        dir,
        size: { width: viewport.width * scale, height: viewport.height * scale },
        ...recorderFormat(),
        ...(engine === 'cdp' || engine === 'playwright' ? { engine } : {}),
      });
      stage.recorder = recorder;
      if (process.env.MEDIA_BEATS) logBeats(definition.id, stage, recorder);
      await definition.run(stage);
      await stage.hold(FINAL_HOLD_MS);
      recording = await recorder.stop();
      stage.recorder = undefined;
      console.log(`${definition.id}: ${JSON.stringify(recording)}`);
      // Clips stay under 8 s (spec §6). A warning, not a failure: app work runs slower on
      // a busy runner, and a long clip is a pacing problem, not a broken feature.
      if (recording.durationMs >= MAX_CLIP_MS) {
        console.warn(`${definition.id}: ${recording.durationMs} ms, over ${MAX_CLIP_MS} ms`);
      }
    } else {
      await definition.run(stage);
      // A still is a lossless screenshot at the device scale (spec §2.3).
      writeFileSync(join(dir, 'raw.png'), await page.screenshot({ type: 'png' }));
    }
    requests.stop();

    const record: SceneRecord = {
      id: definition.id,
      kind: definition.kind,
      crop: definition.crop,
      scale,
      viewport,
      ...(recording ? { recording } : {}),
    };
    writeFileSync(join(dir, 'scene.json'), `${JSON.stringify(record, null, 2)}\n`);
    expect(requests.violations, 'requests to another origin').toEqual([]);
  });
}
