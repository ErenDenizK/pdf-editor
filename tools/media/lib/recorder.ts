/**
 * Clip capture (spec §2.3). Frames come from the browser's compositor through
 * `page.screencast.start({ onFrame, size, quality })` (Playwright 1.63), or straight from
 * CDP `Page.startScreencast` when that API is missing or PNG frames are asked for (the
 * Playwright API delivers JPEG only). `recordVideo` is not used: its fixed-bitrate VP8 smears
 * glyph edges.
 *
 * Chromium sends a frame only when something on screen changed, so frames are irregular;
 * each carries the compositor's timestamp. `stop` writes the frames to
 * `out/<id>/frames/`, an ffconcat list that gives every frame its real duration (ffmpeg then
 * resamples to a constant rate, lib/encode.ts), and `recording.json` with the measurements
 * the spike reports: frame size, frame rate and frame-time jitter.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CDPSession, Page } from '@playwright/test';

export type FrameFormat = 'jpeg' | 'png';
export type ScreencastEngine = 'playwright' | 'cdp';

export interface RecorderOptions {
  /** The scene's working directory (`out/<id>/`). */
  readonly dir: string;
  /** Largest frame size in device pixels; the viewport at its device scale factor. */
  readonly size: { readonly width: number; readonly height: number };
  /** JPEG quality, 0–100. */
  readonly quality?: number;
  readonly format?: FrameFormat;
  /** Forces an engine; by default Playwright's API for JPEG, CDP for PNG or when missing. */
  readonly engine?: ScreencastEngine;
}

interface CapturedFrame {
  /** Compositor wall time, ms. */
  readonly timestamp: number;
  readonly data: Buffer;
}

export interface FrameRecord {
  readonly file: string;
  readonly timestamp: number;
  /** How long the frame stays on screen, ms (until the next frame, or the stop). */
  readonly duration: number;
}

export interface RecordingStats {
  readonly engine: ScreencastEngine;
  readonly format: FrameFormat;
  readonly quality: number;
  readonly frames: number;
  readonly durationMs: number;
  /** Distinct frame sizes in device pixels, e.g. ["2880x1800"]. */
  readonly frameSizes: readonly string[];
  readonly meanFrameBytes: number;
  /** Frames per second over the whole recording (idle periods send no frames). */
  readonly fpsOverall: number;
  /**
   * Intervals between frames while the screen was changing (≤ 100 ms apart): their rate,
   * spread and tail, which is what motion looks like.
   */
  readonly active: {
    readonly intervals: number;
    readonly fps: number;
    readonly medianMs: number;
    readonly p95Ms: number;
    readonly maxMs: number;
    readonly stdDevMs: number;
  };
}

/** Width × height of a JPEG (first SOF marker) or PNG (IHDR), or null if unrecognised. */
export function imageSize(data: Buffer): { width: number; height: number } | null {
  if (data.length > 24 && data.readUInt32BE(0) === 0x89504e47) {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (data[0] !== 0xff || data[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) return null;
    const marker = data[offset + 1] ?? 0;
    const length = data.readUInt16BE(offset + 2);
    // SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

const round = (value: number, digits = 1) => Number(value.toFixed(digits));

export class Recorder {
  private readonly frames: CapturedFrame[] = [];
  private stopper: (() => Promise<void>) | undefined;

  // Plain fields, not parameter properties: Node's type stripping (encode, check) rejects those.
  private readonly options: RecorderOptions;
  readonly engine: ScreencastEngine;

  private constructor(options: RecorderOptions, engine: ScreencastEngine) {
    this.options = options;
    this.engine = engine;
  }

  static async start(page: Page, options: RecorderOptions): Promise<Recorder> {
    const format = options.format ?? 'jpeg';
    const hasApi = typeof (page as Partial<Page>).screencast?.start === 'function';
    const engine = options.engine ?? (format === 'jpeg' && hasApi ? 'playwright' : 'cdp');
    if (engine === 'playwright' && format !== 'jpeg') {
      throw new Error('page.screencast delivers JPEG frames only; use the CDP engine for PNG');
    }
    const recorder = new Recorder(options, engine);
    await (engine === 'playwright' ? recorder.startPlaywright(page) : recorder.startCdp(page));
    return recorder;
  }

  private async startPlaywright(page: Page): Promise<void> {
    // Returning nothing from onFrame lets Playwright acknowledge the frame at once, so a
    // slow consumer never throttles the compositor.
    await page.screencast.start({
      size: this.options.size,
      quality: this.options.quality ?? 90,
      onFrame: ({ data, timestamp }) => {
        this.frames.push({ data, timestamp });
      },
    });
    this.stopper = () => page.screencast.stop();
  }

  private async startCdp(page: Page): Promise<void> {
    const session: CDPSession = await page.context().newCDPSession(page);
    session.on('Page.screencastFrame', (event) => {
      this.frames.push({
        data: Buffer.from(event.data, 'base64'),
        // metadata.timestamp is seconds since the epoch; fall back to arrival time.
        timestamp: event.metadata.timestamp ? event.metadata.timestamp * 1000 : Date.now(),
      });
      void session.send('Page.screencastFrameAck', { sessionId: event.sessionId });
    });
    await session.send('Page.startScreencast', {
      format: this.options.format ?? 'jpeg',
      ...(this.options.format === 'png' ? {} : { quality: this.options.quality ?? 90 }),
      maxWidth: this.options.size.width,
      maxHeight: this.options.size.height,
      everyNthFrame: 1,
    });
    this.stopper = async () => {
      await session.send('Page.stopScreencast');
      await session.detach();
    };
  }

  /**
   * Stops capturing and writes frames, the ffconcat list and the measurements. The last
   * frame lasts until the moment of the stop, so a final hold is kept at its real length.
   */
  async stop(): Promise<RecordingStats> {
    const stoppedAt = Date.now();
    await this.stopper?.();
    const frames = [...this.frames].sort((a, b) => a.timestamp - b.timestamp);
    if (frames.length === 0) throw new Error('the screencast delivered no frames');

    const dir = this.options.dir;
    const framesDir = join(dir, 'frames');
    rmSync(framesDir, { recursive: true, force: true });
    mkdirSync(framesDir, { recursive: true });
    const extension = this.options.format === 'png' ? 'png' : 'jpg';
    const records: FrameRecord[] = frames.map((frame, index) => {
      const next = frames[index + 1]?.timestamp ?? Math.max(stoppedAt, frame.timestamp + 1);
      const file = `frames/${String(index).padStart(5, '0')}.${extension}`;
      writeFileSync(join(dir, file), frame.data);
      return { file, timestamp: frame.timestamp, duration: next - frame.timestamp };
    });

    // ffconcat: each file with its duration; the last file is listed again so its duration
    // is honoured (the concat demuxer ignores the duration of the final entry).
    const lines = ['ffconcat version 1.0'];
    for (const record of records) {
      lines.push(`file '${record.file}'`, `duration ${(record.duration / 1000).toFixed(6)}`);
    }
    const last = records.at(-1);
    if (last) lines.push(`file '${last.file}'`);
    writeFileSync(join(dir, 'frames.ffconcat'), `${lines.join('\n')}\n`);

    const stats = this.measure(frames, records);
    writeFileSync(join(dir, 'recording.json'), `${JSON.stringify({ stats, records }, null, 2)}\n`);
    return stats;
  }

  private measure(frames: readonly CapturedFrame[], records: readonly FrameRecord[]) {
    const sizes = new Set<string>();
    let bytes = 0;
    for (const frame of frames) {
      const size = imageSize(frame.data);
      sizes.add(size ? `${size.width}x${size.height}` : 'unknown');
      bytes += frame.data.length;
    }
    const intervals = records.slice(0, -1).map((record) => record.duration);
    const active = intervals.filter((ms) => ms <= 100).sort((a, b) => a - b);
    const mean = active.reduce((sum, ms) => sum + ms, 0) / Math.max(1, active.length);
    const variance =
      active.reduce((sum, ms) => sum + (ms - mean) ** 2, 0) / Math.max(1, active.length);
    const durationMs = records.reduce((sum, record) => sum + record.duration, 0);
    const stats: RecordingStats = {
      engine: this.engine,
      format: this.options.format ?? 'jpeg',
      quality: this.options.quality ?? 90,
      frames: frames.length,
      durationMs: Math.round(durationMs),
      frameSizes: [...sizes],
      meanFrameBytes: Math.round(bytes / frames.length),
      fpsOverall: round((frames.length / durationMs) * 1000),
      active: {
        intervals: active.length,
        fps: round(mean > 0 ? 1000 / mean : 0),
        medianMs: round(percentile(active, 50)),
        p95Ms: round(percentile(active, 95)),
        maxMs: round(active.at(-1) ?? 0),
        stdDevMs: round(Math.sqrt(variance)),
      },
    };
    return stats;
  }
}
