/**
 * Ink latency statistics (craft spec §5.1): percentiles, the per-stroke record, long tasks
 * overlapping a stroke's press-to-visible window, and the hooks in the real input pipeline
 * and preview (frames, event-to-draw, pointer-up to committed stroke visible), on and off.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { attachInkInput, createPenSession } from './ink-input';
import { InkPreview } from './ink-preview';
import {
  disableInkStats,
  enableInkStats,
  type InkStatsApi,
  INK_STATS_MAX_STROKES,
  InkStatsCollector,
  inkStats,
  LONG_TASK_MS,
  percentiles,
} from './ink-stats';

const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));

describe('percentiles', () => {
  it('nearest rank over unsorted values; NaN when empty', () => {
    const values = Array.from({ length: 100 }, (_, i) => 100 - i);
    expect(percentiles(values)).toEqual({ count: 100, p50: 50, p95: 95, max: 100 });
    expect(percentiles([7])).toEqual({ count: 1, p50: 7, p95: 7, max: 7 });
    const empty = percentiles([]);
    expect(empty.count).toBe(0);
    expect(empty.p95).toBeNaN();
  });
});

describe('the collector', () => {
  let stats: InkStatsCollector;
  beforeEach(() => {
    stats = new InkStatsCollector({ observeLongTasks: false });
  });

  it('records frames, the release and the visible commit of a stroke', () => {
    stats.strokeBegin('pen', 1000);
    stats.frame(1010, 1010.5, 1008, 4);
    stats.frame(1026, 1026.25, 1025, 9);
    stats.strokeEnd(1040, 1040, 1041, 10);
    const ended = stats.takeEnded();
    expect(ended).not.toBeNull();
    expect(stats.takeEnded()).toBeNull();
    expect(stats.summary().pending).toBe(1);
    if (ended) {
      stats.visible(ended, 1100);
      stats.visible(ended, 1500);
    }
    const summary = stats.summary();
    expect(summary.strokes).toBe(1);
    expect(summary.pending).toBe(0);
    expect(summary.samples.p50).toBe(10);
    expect(summary.drawMs).toEqual({ count: 2, p50: 0.25, p95: 0.5, max: 0.5 });
    expect(summary.eventToDrawMs).toEqual({ count: 2, p50: 1.25, p95: 2.5, max: 2.5 });
    expect(summary.finalDrawMs.p50).toBe(1);
    // The first report counts.
    expect(summary.commitVisibleMs).toEqual({ count: 1, p50: 60, p95: 60, max: 60 });
    expect(summary.drawMsByPoints.under1000.count).toBe(2);
    expect(summary.drawMsByPoints.from4000.count).toBe(0);
  });

  it('buckets draw times by the samples drawn', () => {
    stats.strokeBegin('mouse', 0);
    stats.frame(0, 1, 0, 10);
    stats.frame(0, 2, 0, 1500);
    stats.frame(0, 3, 0, 5000);
    const { drawMsByPoints } = stats.summary();
    expect(drawMsByPoints.under1000.max).toBe(1);
    expect(drawMsByPoints.from1000to4000.max).toBe(2);
    expect(drawMsByPoints.from4000.max).toBe(3);
  });

  it('a cancelled stroke is counted but kept out of the timings', () => {
    stats.strokeBegin('pen', 0);
    stats.frame(0, 1, 0, 3);
    stats.strokeCancel();
    // Released, then the commit was refused before a settling preview was made.
    stats.strokeBegin('pen', 100);
    stats.frame(100, 101, 100, 3);
    stats.strokeEnd(110, 110, 111, 3);
    stats.strokeCancel();
    const summary = stats.summary();
    expect(summary.strokes).toBe(2);
    expect(summary.cancelled).toBe(2);
    expect(summary.pending).toBe(0);
    expect(summary.drawMs.count).toBe(0);
    expect(stats.takeEnded()).toBeNull();
  });

  it('a long task overlapping the press-to-visible window marks the stroke', () => {
    stats.strokeBegin('pen', 1000);
    stats.strokeEnd(1200, 1200, 1201, 20);
    const first = stats.takeEnded();
    if (first) stats.visible(first, 1400);
    stats.strokeBegin('pen', 2000);
    stats.strokeEnd(2200, 2200, 2201, 20);
    const second = stats.takeEnded();
    if (second) stats.visible(second, 2300);
    stats.noteLong('long-animation-frame', 1350, 80); // during the first commit
    stats.noteLong('longtask', 1700, 120); // between strokes
    stats.noteLong('longtask', 2100, LONG_TASK_MS); // not long
    const { longTasks } = stats.summary();
    expect(longTasks.strokesWithLongTask).toBe(1);
    expect(longTasks.count).toBe(1);
    expect(longTasks.maxMs).toBe(80);
    expect(stats.longEntries()).toHaveLength(2);
    stats.reset();
    expect(stats.summary().strokes).toBe(0);
    expect(stats.longEntries()).toHaveLength(0);
  });

  it('keeps the newest strokes only', () => {
    stats.noteLong('longtask', 0, 55);
    stats.noteLong('longtask', 50_000, 60);
    for (let i = 0; i < INK_STATS_MAX_STROKES + 2; i++) stats.strokeBegin('pen', i * 100);
    const kept = stats.strokes();
    expect(kept).toHaveLength(INK_STATS_MAX_STROKES);
    expect(kept[0]?.startedAt).toBe(200);
    // Long entries that end before the oldest kept stroke go with the dropped strokes.
    expect(stats.longEntries().map((e) => e.startTime)).toEqual([50_000]);
  });

  it('copies the raw records', () => {
    stats.strokeBegin('pen', 0);
    stats.frame(0, 1, 0, 2);
    const copy = stats.strokes();
    copy[0]?.drawMs.push(99);
    expect(stats.strokes()[0]?.drawMs).toEqual([1]);
  });
});

describe('hooks in the input pipeline', () => {
  let layer: HTMLDivElement;
  let preview: InkPreview;
  let detach: () => void;
  let releases: (() => void)[];

  beforeEach(() => {
    enableInkStats({ observeLongTasks: false }).reset();
    layer = document.createElement('div');
    Object.assign(layer.style, {
      position: 'fixed',
      left: '0px',
      top: '0px',
      width: '400px',
      height: '300px',
    });
    document.body.appendChild(layer);
    preview = new InkPreview(layer);
    releases = [];
    detach = attachInkInput({
      element: layer,
      preview,
      session: createPenSession(),
      context: () => ({ width: 2, color: '#1e88e5', opacity: 1, scale: 1 }),
      onStroke: (_stroke, settle) => {
        releases.push(settle());
      },
    });
  });

  afterEach(() => {
    detach();
    preview.destroy();
    layer.remove();
    enableInkStats({ observeLongTasks: false }).reset();
  });

  const event = (type: string, x: number, y: number) =>
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      pointerId: 5,
      pointerType: 'pen',
      isPrimary: true,
      button: type === 'pointermove' ? -1 : 0,
      buttons: type === 'pointerup' ? 0 : 1,
      pressure: type === 'pointerup' ? 0 : 0.6,
    });

  it('records frames, event-to-draw and pointer-up to visible', async () => {
    layer.dispatchEvent(event('pointerdown', 20, 20));
    for (let i = 1; i <= 6; i++) {
      layer.dispatchEvent(event('pointermove', 20 + i * 10, 20 + i * 3));
      await nextFrame();
    }
    layer.dispatchEvent(event('pointerup', 90, 40));
    const api = (window as Window & { __inkStats?: InkStatsApi }).__inkStats;
    expect(api).toBeDefined();
    expect(api?.summary().pending).toBe(1);
    await nextFrame();
    for (const release of releases) release();
    const summary = api?.summary();
    expect(summary?.strokes).toBe(1);
    expect(summary?.pending).toBe(0);
    expect(summary?.samples.p50).toBe(8);
    expect(summary?.drawMs.count).toBeGreaterThanOrEqual(6);
    expect(summary?.drawMs.max).toBeGreaterThanOrEqual(0);
    expect(summary?.eventToDrawMs.count).toBe(summary?.drawMs.count);
    // Same clock: the newest sample is never drawn before it happened.
    expect(summary?.eventToDrawMs.p50).toBeGreaterThanOrEqual(0);
    expect(summary?.eventToDrawMs.max).toBeLessThan(5_000);
    expect(summary?.finalDrawMs.count).toBe(1);
    expect(summary?.commitVisibleMs.count).toBe(1);
    expect(summary?.commitVisibleMs.p50).toBeGreaterThan(0);
  });

  it('a cancelled stroke leaves nothing pending', () => {
    layer.dispatchEvent(event('pointerdown', 20, 20));
    layer.dispatchEvent(event('pointermove', 40, 30));
    layer.dispatchEvent(event('pointercancel', 40, 30));
    const summary = inkStats()?.summary();
    expect(summary?.strokes).toBe(1);
    expect(summary?.cancelled).toBe(1);
    expect(summary?.pending).toBe(0);
  });

  it('off: no collector, no window hook, and the pen still draws and settles', async () => {
    disableInkStats();
    expect(inkStats()).toBeNull();
    expect((window as Window & { __inkStats?: InkStatsApi }).__inkStats).toBeUndefined();
    layer.dispatchEvent(event('pointerdown', 20, 20));
    layer.dispatchEvent(event('pointermove', 60, 30));
    await nextFrame();
    layer.dispatchEvent(event('pointerup', 80, 40));
    expect(preview.stats.frames).toBeGreaterThanOrEqual(2);
    expect(releases).toHaveLength(1);
    expect(layer.querySelectorAll('[data-settling]')).toHaveLength(1);
    for (const release of releases) release();
    expect(layer.querySelectorAll('[data-settling]')).toHaveLength(0);
  });
});
