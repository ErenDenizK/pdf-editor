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
   * Plays the scene. A clip is recorded from the first frame after `Stage.open` until
   * `run` returns plus the final hold; a still is taken when `run` returns.
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

/** Recorder settings, overridable for the spike's comparisons. */
function recorderFormat(): { format: 'jpeg' | 'png'; quality: number } {
  const format = process.env.MEDIA_FRAME_FORMAT === 'png' ? 'png' : 'jpeg';
  return { format, quality: Number(process.env.MEDIA_JPEG_QUALITY ?? 90) };
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
    if (definition.kind === 'clip') {
      const engine = process.env.MEDIA_SCREENCAST;
      const recorder = await Recorder.start(page, {
        dir,
        size: { width: viewport.width * scale, height: viewport.height * scale },
        ...recorderFormat(),
        ...(engine === 'cdp' || engine === 'playwright' ? { engine } : {}),
      });
      await definition.run(stage);
      await stage.hold(FINAL_HOLD_MS);
      recording = await recorder.stop();
      console.log(`${definition.id}: ${JSON.stringify(recording)}`);
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
