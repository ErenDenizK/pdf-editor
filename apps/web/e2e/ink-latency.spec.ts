/**
 * Ink latency harness (craft spec §5.1, research 12 §8), Chromium only: synthetic input
 * through CDP `Input.dispatchMouseEvent` with explicit timestamps, paced in real time, on
 * the demo report, read back from `window.__inkStats` (`src/annotations/pen/ink-stats.ts`,
 * switched on by its storage key before load).
 *
 * Three runs: a long cursive pen line at 240 Hz (5,000 samples, force and tilt), a burst of
 * 64 short pen strokes at 240 Hz on one line (one Ink of 64 paths), and a mouse run at
 * 125 Hz. Each records the preview draw per frame, event-to-draw, pointer-up to committed
 * stroke visible and long tasks, prints them, and adds them to the test's annotations next
 * to the §5.1 targets. The expectations are soft and generous so the suite is green today;
 * the pen work (P7) tightens them to the targets.
 *
 * Headless timing is noisy and the event times are synthetic: the numbers are a trend
 * between builds on one machine, not a photon latency (research 12 §8, M6).
 */
import { loadavg } from 'node:os';

import { type CDPSession, expect, type Page, test } from '@playwright/test';

import { fixturePath, useFileInputPicker } from './helpers';

/** `src/annotations/pen/ink-stats.ts` (kept in step by hand: e2e does not import app code). */
const INK_STATS_STORAGE_KEY = 'pdf-editor:dev:ink-stats';
const DEMO = 'demo/demo-report-v1.pdf';

interface Percentiles {
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

interface Summary {
  readonly strokes: number;
  readonly cancelled: number;
  readonly pending: number;
  readonly samples: Percentiles;
  readonly drawMs: Percentiles;
  readonly drawMsByPoints: {
    readonly under1000: Percentiles;
    readonly from1000to4000: Percentiles;
    readonly from4000: Percentiles;
  };
  readonly eventToDrawMs: Percentiles;
  readonly finalDrawMs: Percentiles;
  readonly commitVisibleMs: Percentiles;
  readonly longTasks: {
    readonly observed: readonly string[];
    readonly strokesWithLongTask: number;
    readonly count: number;
    readonly maxMs: number;
  };
}

interface InkStatsWindow {
  __inkStats?: { summary(): Summary; reset(): void };
  __inkPresses?: number[];
}

/** One input sample: `at` ms after the run starts, CSS px of the page. */
interface Sample {
  readonly at: number;
  readonly x: number;
  readonly y: number;
  readonly force?: number;
}

type PointerKind = 'pen' | 'mouse';

interface Played {
  /** Node-side lateness of each dispatch against its timestamp, ms. */
  readonly lateMs: number[];
  /** The timestamps sent with each press, ms since the Unix epoch. */
  readonly pressAt: number[];
}

const PEN_HZ = 240;
const MOUSE_HZ = 125;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function nearestRank(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] ?? 0;
}

/**
 * Dispatches the strokes in real time: each sample is sent when its time on the 240 Hz (or
 * 125 Hz) schedule comes, stamped with the moment it is sent (seconds since the Unix epoch,
 * the clock CDP expects), so a harness that falls behind on a busy machine does not inflate
 * event-to-draw; how late it fell behind is reported. The first sample of a stroke presses,
 * the last releases. Sends are not awaited one by one (CDP keeps their order), so a slow
 * round trip does not delay the next sample.
 */
async function play(
  cdp: CDPSession,
  strokes: readonly (readonly Sample[])[],
  kind: PointerKind,
): Promise<Played> {
  const start = performance.now() + 100;
  const lateMs: number[] = [];
  const pressAt: number[] = [];
  const sends: Promise<unknown>[] = [];
  for (const stroke of strokes) {
    for (let index = 0; index < stroke.length; index++) {
      const sample = stroke[index];
      if (!sample) continue;
      const due = start + sample.at;
      for (let wait = due - performance.now(); wait > 0; wait = due - performance.now()) {
        if (wait > 2) await sleep(wait - 1.5);
        else await tick();
      }
      const sentAt = performance.now();
      lateMs.push(sentAt - due);
      const timestamp = (performance.timeOrigin + sentAt) / 1000;
      const type =
        index === 0 ? 'mousePressed' : index === stroke.length - 1 ? 'mouseReleased' : 'mouseMoved';
      if (type === 'mousePressed') pressAt.push(timestamp * 1000);
      const pen =
        kind === 'pen'
          ? {
              force: type === 'mouseReleased' ? 0 : (sample.force ?? 0.5),
              tiltX: 18,
              tiltY: -12,
            }
          : {};
      sends.push(
        cdp.send('Input.dispatchMouseEvent', {
          type,
          x: sample.x,
          y: sample.y,
          button: 'left',
          buttons: type === 'mouseReleased' ? 0 : 1,
          ...(type === 'mouseMoved' ? {} : { clickCount: 1 }),
          pointerType: kind,
          timestamp,
          ...pen,
        }),
      );
    }
  }
  await Promise.all(sends);
  return { lateMs, pressAt };
}

/** A long cursive line: loops drifting right, 5,000 samples at 240 Hz, force waving. */
function cursiveLine(box: Box): Sample[] {
  const count = 5_000;
  const period = 1000 / PEN_HZ;
  const x0 = box.x + box.width * 0.12;
  const span = box.width * 0.76;
  const y0 = box.y + 220;
  const radius = 18;
  const loopMs = 320;
  return Array.from({ length: count }, (_, i) => {
    const t = i * period;
    const phase = (2 * Math.PI * t) / loopMs;
    return {
      at: t,
      x: x0 + (span * i) / (count - 1) - radius * Math.sin(phase),
      y: y0 - radius * (1 - Math.cos(phase)) * 0.9,
      force: 0.45 + 0.25 * Math.sin(phase / 3),
    };
  });
}

/** 64 short pen strokes on one line (one burst): arcs about 100 ms long, 70 ms apart. */
function shortBurst(box: Box): Sample[][] {
  const period = 1000 / PEN_HZ;
  const samples = 24;
  const pause = 70;
  const step = Math.min(10, (box.width * 0.8) / 64);
  const x0 = box.x + box.width * 0.1;
  const y0 = box.y + 340;
  return Array.from({ length: 64 }, (_, s) => {
    const begin = s * (samples * period + pause);
    return Array.from({ length: samples }, (_, i) => {
      const u = i / (samples - 1);
      return {
        at: begin + i * period,
        x: x0 + s * step + u * step * 0.7,
        y: y0 - 12 * Math.sin(Math.PI * u) + (s % 3) * 1.5,
        force: 0.3 + 0.5 * Math.sin(Math.PI * u),
      };
    });
  });
}

/** A mouse at 125 Hz: twelve wavy strokes of 1 s, 200 ms apart. */
function mouseRun(box: Box): Sample[][] {
  const period = 1000 / MOUSE_HZ;
  const samples = MOUSE_HZ;
  const x0 = box.x + box.width * 0.12;
  const width = box.width * 0.06;
  const y0 = box.y + 460;
  return Array.from({ length: 12 }, (_, s) => {
    const begin = s * (samples * period + 200);
    return Array.from({ length: samples }, (_, i) => {
      const u = i / (samples - 1);
      return {
        at: begin + i * period,
        // Whole CSS pixels, as a mouse reports them.
        x: Math.round(x0 + s * width * 1.05 + u * width),
        y: Math.round(y0 + 14 * Math.sin(2 * Math.PI * u * 2)),
      };
    });
  });
}

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Opens the demo report, arms the pen and returns the first page's layer box. */
async function openDemoArmed(page: Page): Promise<Box> {
  const chooser = page.waitForEvent('filechooser');
  await page
    .getByRole('button', { name: /^(Open files|Dosya aç)$/ })
    .first()
    .click();
  await (await chooser).setFiles([fixturePath(DEMO)]);
  await expect(page.getByRole('tab', { name: 'demo-report-v1' })).toBeVisible();
  await expect(page.locator('canvas[data-state="rendered"]').first()).toBeAttached({
    timeout: 20_000,
  });
  await page.locator('body').press('p');
  const layer = page.locator('[data-annotation-layer="0"]');
  await expect(layer).toHaveAttribute('data-tool', 'ink');
  await expect
    .poll(() => page.evaluate(() => Boolean((window as InkStatsWindow).__inkStats)))
    .toBe(true);
  const box = await layer.boundingBox();
  if (!box) throw new Error('page not rendered');
  // Let the first render and the thumbnails finish before measuring.
  await page.waitForTimeout(1_000);
  await page.evaluate(() => {
    (window as InkStatsWindow).__inkStats?.reset();
    (window as InkStatsWindow).__inkPresses = [];
  });
  return box;
}

/** Waits until every committed stroke is visible, then reads the summary. */
async function settledSummary(page: Page, strokes: number): Promise<Summary> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const s = (window as InkStatsWindow).__inkStats?.summary();
          return s ? s.strokes - s.cancelled - s.pending : -1;
        }),
      { timeout: 60_000 },
    )
    .toBe(strokes);
  const summary = await page.evaluate(() => (window as InkStatsWindow).__inkStats?.summary());
  if (!summary) throw new Error('no ink statistics');
  return summary;
}

/** Page clock minus the sent timestamps, at each press (ms): how far event times drift. */
async function clockSkew(page: Page, played: Played): Promise<number> {
  const seen = await page.evaluate(() => (window as InkStatsWindow).__inkPresses ?? []);
  const diffs = played.pressAt
    .slice(0, seen.length)
    .map((sent, i) => (seen[i] ?? Number.NaN) - sent);
  return nearestRank(diffs, 0.5);
}

const ms = (value: number) => (Number.isFinite(value) ? `${value.toFixed(2)} ms` : 'n/a');
const pair = (p: Percentiles) => `p50 ${ms(p.p50)}, p95 ${ms(p.p95)}, max ${ms(p.max)}`;

/** Prints the run and records it, with the §5.1 targets, as annotations. */
function report(name: string, summary: Summary, played: Played, skew: number): void {
  const late = nearestRank(played.lateMs, 0.95);
  const rows: [string, string][] = [
    ['strokes', `${summary.strokes} (${summary.cancelled} cancelled)`],
    ['samples per stroke', `p50 ${summary.samples.p50}, max ${summary.samples.max}`],
    [
      'preview draw per frame (target ≤ 1 ms)',
      `${pair(summary.drawMs)}, ${summary.drawMs.count} frames`,
    ],
    ['  frames < 1,000 samples', pair(summary.drawMsByPoints.under1000)],
    ['  frames 1,000–4,000 samples', pair(summary.drawMsByPoints.from1000to4000)],
    ['  frames ≥ 4,000 samples', pair(summary.drawMsByPoints.from4000)],
    ['event to draw (target p95 ≤ 4 ms)', pair(summary.eventToDrawMs)],
    ['full redraw at release', pair(summary.finalDrawMs)],
    ['pointer-up to committed visible (target ≤ 50 ms)', pair(summary.commitVisibleMs)],
    [
      'long tasks > 50 ms (target none)',
      `${summary.longTasks.count} (strokes hit ${summary.longTasks.strokesWithLongTask}, max ${ms(summary.longTasks.maxMs)}; observed: ${summary.longTasks.observed.join(', ') || 'none'})`,
    ],
    ['dispatch lateness p95 (harness)', ms(late)],
    ['page clock minus sent timestamp, median (harness)', ms(skew)],
    ['load average, 1 min (machine)', (loadavg()[0] ?? 0).toFixed(2)],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));
  console.log(
    [`\n[ink-latency] ${name}`, ...rows.map(([l, v]) => `  ${l.padEnd(width)}  ${v}`)].join('\n'),
  );
  const annotations = test.info().annotations;
  annotations.push(
    { type: 'preview draw p95 (target ≤ 1 ms)', description: ms(summary.drawMs.p95) },
    { type: 'event to draw p95 (target ≤ 4 ms)', description: ms(summary.eventToDrawMs.p95) },
    {
      type: 'committed visible p95 (target ≤ 50 ms)',
      description: ms(summary.commitVisibleMs.p95),
    },
    {
      type: 'long tasks > 50 ms (target none)',
      description: `${summary.longTasks.count} (max ${ms(summary.longTasks.maxMs)})`,
    },
    {
      type: 'harness',
      description: `dispatch lateness p95 ${ms(late)}, clock skew ${ms(skew)}, load ${(loadavg()[0] ?? 0).toFixed(2)}`,
    },
  );
}

/**
 * Generous today; P7 tightens these to the §5.1 targets. `commitVisibleMs` is the ceiling
 * for pointer-up to committed stroke visible (p95), set per run from the baseline
 * (`docs/qa/ink-latency-baseline.md`) with room for a loaded machine.
 */
function softExpectations(summary: Summary, commitVisibleMs: number): void {
  expect.soft(summary.drawMs.count, 'frames were drawn').toBeGreaterThan(0);
  expect.soft(summary.drawMs.p95, 'preview draw p95 (ms)').toBeLessThanOrEqual(4);
  expect.soft(summary.eventToDrawMs.count, 'event-to-draw reported').toBeGreaterThan(0);
  expect.soft(Number.isFinite(summary.eventToDrawMs.p95), 'event-to-draw is a number').toBe(true);
  expect
    .soft(summary.commitVisibleMs.p95, 'committed visible p95 (ms)')
    .toBeLessThanOrEqual(commitVisibleMs);
}

test.describe('ink latency', () => {
  // In order in one worker, overriding `fullyParallel`: parallel runs would measure each
  // other. A failed run does not skip the others.
  test.describe.configure({ mode: 'default' });
  test.use({ viewport: { width: 1440, height: 900 } });

  test.beforeEach(async ({ browserName, page }) => {
    test.skip(browserName !== 'chromium', 'CDP input with explicit timestamps (Chromium)');
    await useFileInputPicker(page);
    await page.addInitScript((key) => {
      window.localStorage.setItem(key, '1');
      const presses: number[] = [];
      (window as InkStatsWindow).__inkPresses = presses;
      window.addEventListener(
        'pointerdown',
        (e) => (window as InkStatsWindow).__inkPresses?.push(performance.timeOrigin + e.timeStamp),
        { capture: true },
      );
    }, INK_STATS_STORAGE_KEY);
    await page.goto('./');
  });

  test('a long cursive pen line at 240 Hz', async ({ page }) => {
    test.setTimeout(120_000);
    const box = await openDemoArmed(page);
    const cdp = await page.context().newCDPSession(page);
    const played = await play(cdp, [cursiveLine(box)], 'pen');
    const summary = await settledSummary(page, 1);
    report(
      'long cursive pen line, 240 Hz, 5,000 samples',
      summary,
      played,
      await clockSkew(page, played),
    );
    expect(summary.samples.max).toBeGreaterThan(4_000);
    // Today 520–940 ms: the whole 5,000-sample stroke is smoothed, written and repainted.
    softExpectations(summary, 3_000);
  });

  test('a burst of 64 short pen strokes at 240 Hz', async ({ page }) => {
    test.setTimeout(120_000);
    const box = await openDemoArmed(page);
    const cdp = await page.context().newCDPSession(page);
    const played = await play(cdp, shortBurst(box), 'pen');
    const summary = await settledSummary(page, 64);
    report('64 short pen strokes, 240 Hz', summary, played, await clockSkew(page, played));
    // Today p95 1.8–3.9 s: each stroke restarts the 160 ms repaint debounce, so a stroke
    // becomes visible only in a pause, behind a growing queue of appends.
    softExpectations(summary, 8_000);
  });

  test('a mouse run at 125 Hz', async ({ page }) => {
    test.setTimeout(120_000);
    const box = await openDemoArmed(page);
    const cdp = await page.context().newCDPSession(page);
    const played = await play(cdp, mouseRun(box), 'mouse');
    const summary = await settledSummary(page, 12);
    report('mouse, 125 Hz, 12 strokes', summary, played, await clockSkew(page, played));
    // Today p50 315–335 ms, p95 520–640 ms.
    softExpectations(summary, 1_500);
  });
});
