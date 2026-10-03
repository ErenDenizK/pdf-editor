/**
 * Ink latency statistics (craft spec §5.1; research 12 §8, M2–M4): an opt-in collector the
 * pen's input pipeline and preview report to, read as `window.__inkStats.summary()` by the
 * e2e harness (`e2e/ink-latency.spec.ts`) or by hand in the console.
 *
 * - **Enabled** in development builds, when `localStorage['pdf-editor:dev:ink-stats']` is
 *   `'1'`, or with `?inkstats=1` in the address. Otherwise `inkStats()` is `null` and the
 *   hooks cost one null check per frame: nothing is allocated on the move path.
 * - **Per stroke**: the sample count; per animation frame, the preview draw time
 *   (`performance.now()` around `InkPreview.draw`) and the event-to-draw latency (the newest
 *   drawn sample's `event.timeStamp` to the end of that draw, both on the
 *   `performance.now()` clock); the full redraw at release; pointer-up to committed stroke
 *   visible; and, for strokes the dry ink layer holds (craft spec §5.3 item 7), pointer-up
 *   to bitmap settled. "Committed visible" is the frame that presents the committed shape:
 *   the dry layer's draw (`pen/dry-ink.ts`), or without one the settling preview's release
 *   once the page has painted the stroke. "Bitmap settled" is the frame after the page
 *   bitmap that contains the stroke took over from the dry layer.
 * - **Long tasks**: `long-animation-frame` and `longtask` entries (where the browser has
 *   them) over 50 ms are kept, and a stroke counts as janked when one overlaps its window,
 *   from the press to its committed stroke being visible (the commit is part of it).
 */

/** The switch in local storage (`'1'` enables the collector on the next load). */
export const INK_STATS_STORAGE_KEY = 'pdf-editor:dev:ink-stats';
/** The query parameter that enables the collector (`?inkstats=1`). */
export const INK_STATS_QUERY = 'inkstats';
/** A task or animation frame longer than this (ms) is long. */
export const LONG_TASK_MS = 50;
/** Strokes kept (the oldest go first), so a long development session stays small. */
export const INK_STATS_MAX_STROKES = 1000;

/** Nearest-rank percentiles of a set of values (NaN when there are none). */
export interface InkStatsPercentiles {
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

/** What the collector knows about one stroke. */
export interface InkStrokeStats {
  readonly pointerType: string;
  /** Press, `performance.now()` clock. */
  readonly startedAt: number;
  /** Samples in the stroke (as of the last frame or the release). */
  samples: number;
  /** Preview draw time per animation frame, ms. */
  readonly drawMs: number[];
  /** Samples drawn in each of those frames. */
  readonly drawPoints: number[];
  /** Newest drawn sample's event time to the end of the frame's draw, ms. */
  readonly eventToDrawMs: number[];
  /** The full redraw at release, ms (NaN before it). */
  finalDrawMs: number;
  /** Pointer-up handled, `performance.now()` clock (NaN before it). */
  upAt: number;
  /** The committed shape is on screen (dry layer drawn, or settling preview released). */
  visibleAt: number;
  /** Held by the dry ink layer, so `settledAt` follows. */
  dry: boolean;
  /** The page bitmap with the stroke took over from the dry layer (NaN before it). */
  settledAt: number;
  /** Dropped without a commit (pointer cancel, detach). */
  cancelled: boolean;
}

/** A long task or long animation frame. */
export interface InkLongEntry {
  readonly type: 'long-animation-frame' | 'longtask';
  readonly startTime: number;
  readonly duration: number;
}

export interface InkStatsSummary {
  /** Strokes recorded (cancelled ones included in `strokes`, not in the timings). */
  readonly strokes: number;
  readonly cancelled: number;
  /** Ended strokes whose committed stroke is not visible yet. */
  readonly pending: number;
  /** Dry-layer strokes visible whose page bitmap has not taken over yet. */
  readonly unsettled: number;
  /** Samples per stroke. */
  readonly samples: InkStatsPercentiles;
  /** Preview draw per frame, ms, over every frame of every stroke. */
  readonly drawMs: InkStatsPercentiles;
  /** Preview draw per frame by samples drawn: flat in stroke length is the target. */
  readonly drawMsByPoints: {
    readonly under1000: InkStatsPercentiles;
    readonly from1000to4000: InkStatsPercentiles;
    readonly from4000: InkStatsPercentiles;
  };
  /** Newest sample's event time to the end of the frame's draw, ms. */
  readonly eventToDrawMs: InkStatsPercentiles;
  /** The full redraw at release, ms. */
  readonly finalDrawMs: InkStatsPercentiles;
  /** Pointer-up to committed stroke visible, ms. */
  readonly commitVisibleMs: InkStatsPercentiles;
  /** Pointer-up to the page bitmap showing the stroke (dry-layer strokes), ms. */
  readonly bitmapSettledMs: InkStatsPercentiles;
  readonly longTasks: {
    /** Which entry types the browser reports. */
    readonly observed: readonly InkLongEntry['type'][];
    /** Strokes with a long task or frame overlapping the press-to-visible window. */
    readonly strokesWithLongTask: number;
    /** Long entries overlapping any stroke window. */
    readonly count: number;
    /** The longest of those, ms (0 when none). */
    readonly maxMs: number;
  };
}

/** What `window.__inkStats` offers. */
export interface InkStatsApi {
  summary(): InkStatsSummary;
  /** Forgets every stroke and long entry. */
  reset(): void;
  /** The raw per-stroke records (copies). */
  strokes(): InkStrokeStats[];
  /** The long entries seen since the last reset. */
  longEntries(): InkLongEntry[];
}

/** Nearest-rank percentiles; NaN fields when `values` is empty. */
export function percentiles(values: readonly number[]): InkStatsPercentiles {
  const n = values.length;
  if (n === 0) return { count: 0, p50: Number.NaN, p95: Number.NaN, max: Number.NaN };
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p: number) => sorted[Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1))] ?? 0;
  return { count: n, p50: rank(0.5), p95: rank(0.95), max: sorted[n - 1] ?? 0 };
}

function newStroke(pointerType: string, startedAt: number): InkStrokeStats {
  return {
    pointerType,
    startedAt,
    samples: 0,
    drawMs: [],
    drawPoints: [],
    eventToDrawMs: [],
    finalDrawMs: Number.NaN,
    upAt: Number.NaN,
    visibleAt: Number.NaN,
    dry: false,
    settledAt: Number.NaN,
    cancelled: false,
  };
}

/** The entry types this browser's `PerformanceObserver` reports, of the two we want. */
function supportedLongTypes(): InkLongEntry['type'][] {
  if (typeof PerformanceObserver === 'undefined') return [];
  const supported = PerformanceObserver.supportedEntryTypes ?? [];
  return (['long-animation-frame', 'longtask'] as const).filter((t) => supported.includes(t));
}

export class InkStatsCollector {
  private list: InkStrokeStats[] = [];
  private current: InkStrokeStats | null = null;
  /** The stroke just released, waiting for its settling preview (same task). */
  private ended: InkStrokeStats | null = null;
  private long: InkLongEntry[] = [];
  private readonly observers: PerformanceObserver[] = [];
  readonly observed: readonly InkLongEntry['type'][];

  constructor(options: { readonly observeLongTasks?: boolean } = {}) {
    const types = options.observeLongTasks === false ? [] : supportedLongTypes();
    const observed: InkLongEntry['type'][] = [];
    for (const type of types) {
      try {
        const observer = new PerformanceObserver((entries) => {
          for (const e of entries.getEntries()) this.noteLong(type, e.startTime, e.duration);
        });
        observer.observe({ type, buffered: false });
        this.observers.push(observer);
        observed.push(type);
      } catch {
        // Not observable here: the summary says which types were.
      }
    }
    this.observed = observed;
  }

  /** A press started a stroke. */
  strokeBegin(pointerType: string, at: number = performance.now()): void {
    const stroke = newStroke(pointerType, at);
    if (this.list.length >= INK_STATS_MAX_STROKES) {
      const dropped = this.list.shift();
      const since = this.list[0]?.startedAt ?? at;
      if (dropped) this.long = this.long.filter((e) => e.startTime + e.duration > since);
    }
    this.list.push(stroke);
    this.current = stroke;
    this.ended = null;
  }

  /**
   * One animation frame's preview draw, from `start` to `end`, drawing `samples` samples of
   * which the newest has the event time `newestEventTime`.
   */
  frame(start: number, end: number, newestEventTime: number, samples: number): void {
    const s = this.current;
    if (!s) return;
    s.samples = samples;
    s.drawMs.push(end - start);
    s.drawPoints.push(samples);
    if (Number.isFinite(newestEventTime)) s.eventToDrawMs.push(end - newestEventTime);
  }

  /** The release: the full redraw took `start` to `end`; pointer-up was handled at `upAt`. */
  strokeEnd(upAt: number, start: number, end: number, samples: number): void {
    const s = this.current;
    if (!s) return;
    s.samples = samples;
    s.upAt = upAt;
    s.finalDrawMs = end - start;
    this.current = null;
    this.ended = s;
  }

  /** The stroke in progress was dropped. */
  strokeCancel(): void {
    const s = this.current ?? this.ended;
    if (s) s.cancelled = true;
    this.current = null;
    this.ended = null;
  }

  /**
   * The settling preview (or the dry layer's stroke) of the stroke just released was
   * created: returns the record whose `visible` the release reports, or null when no stroke
   * is waiting. A taken record is no longer cancelled by `strokeCancel`.
   */
  takeEnded(): InkStrokeStats | null {
    const s = this.ended;
    this.ended = null;
    return s;
  }

  /** The committed stroke of `stroke` is on screen (the first report counts). */
  visible(stroke: InkStrokeStats, at: number = performance.now()): void {
    if (Number.isNaN(stroke.visibleAt)) stroke.visibleAt = at;
  }

  /** The dry ink layer holds `stroke`: a `settled` report follows. */
  heldDry(stroke: InkStrokeStats): void {
    stroke.dry = true;
  }

  /**
   * The page bitmap containing `stroke` took over from the dry layer, or the dry stroke was
   * dropped (the first report counts).
   */
  settled(stroke: InkStrokeStats, at: number = performance.now()): void {
    if (Number.isNaN(stroke.settledAt)) stroke.settledAt = at;
  }

  /** Records a long task or animation frame (the observers call this). */
  noteLong(type: InkLongEntry['type'], startTime: number, duration: number): void {
    if (duration > LONG_TASK_MS) this.long.push({ type, startTime, duration });
  }

  reset(): void {
    this.list = [];
    this.current = null;
    this.ended = null;
    this.long = [];
  }

  strokes(): InkStrokeStats[] {
    return this.list.map((s) => ({
      ...s,
      drawMs: [...s.drawMs],
      drawPoints: [...s.drawPoints],
      eventToDrawMs: [...s.eventToDrawMs],
    }));
  }

  longEntries(): InkLongEntry[] {
    return [...this.long];
  }

  summary(): InkStatsSummary {
    const done = this.list.filter((s) => !s.cancelled);
    const draws: number[] = [];
    const byPoints: [number[], number[], number[]] = [[], [], []];
    const latency: number[] = [];
    const finals: number[] = [];
    const visible: number[] = [];
    const settled: number[] = [];
    let pending = 0;
    let unsettled = 0;
    const overlapping = new Set<InkLongEntry>();
    let janked = 0;
    for (const s of done) {
      s.drawMs.forEach((ms, i) => {
        draws.push(ms);
        const points = s.drawPoints[i] ?? 0;
        byPoints[points < 1000 ? 0 : points < 4000 ? 1 : 2].push(ms);
      });
      latency.push(...s.eventToDrawMs);
      if (!Number.isNaN(s.finalDrawMs)) finals.push(s.finalDrawMs);
      if (!Number.isNaN(s.upAt)) {
        if (Number.isNaN(s.visibleAt)) pending++;
        else visible.push(s.visibleAt - s.upAt);
        if (s.dry) {
          if (Number.isNaN(s.settledAt)) unsettled++;
          else settled.push(s.settledAt - s.upAt);
        }
      }
      const end = Number.isNaN(s.visibleAt)
        ? Number.isNaN(s.upAt)
          ? Number.POSITIVE_INFINITY
          : s.upAt
        : s.visibleAt;
      let hit = false;
      for (const e of this.long) {
        if (e.startTime < end && e.startTime + e.duration > s.startedAt) {
          overlapping.add(e);
          hit = true;
        }
      }
      if (hit) janked++;
    }
    let maxMs = 0;
    for (const e of overlapping) maxMs = Math.max(maxMs, e.duration);
    return {
      strokes: this.list.length,
      cancelled: this.list.length - done.length,
      pending,
      unsettled,
      samples: percentiles(done.map((s) => s.samples)),
      drawMs: percentiles(draws),
      drawMsByPoints: {
        under1000: percentiles(byPoints[0]),
        from1000to4000: percentiles(byPoints[1]),
        from4000: percentiles(byPoints[2]),
      },
      eventToDrawMs: percentiles(latency),
      finalDrawMs: percentiles(finals),
      commitVisibleMs: percentiles(visible),
      bitmapSettledMs: percentiles(settled),
      longTasks: {
        observed: this.observed,
        strokesWithLongTask: janked,
        count: overlapping.size,
        maxMs,
      },
    };
  }

  /** Stops observing long tasks. */
  dispose(): void {
    for (const observer of this.observers) observer.disconnect();
    this.observers.length = 0;
  }

  /** The `window.__inkStats` face of this collector. */
  api(): InkStatsApi {
    return {
      summary: () => this.summary(),
      reset: () => this.reset(),
      strokes: () => this.strokes(),
      longEntries: () => this.longEntries(),
    };
  }
}

/** Whether this load asked for the collector (development build, storage switch, query). */
export function inkStatsRequested(): boolean {
  if (import.meta.env.DEV) return true;
  try {
    if (window.localStorage.getItem(INK_STATS_STORAGE_KEY) === '1') return true;
  } catch {
    // Storage blocked: the query parameter still works.
  }
  try {
    return new URLSearchParams(window.location.search).get(INK_STATS_QUERY) === '1';
  } catch {
    return false;
  }
}

type InkStatsWindow = Window & { __inkStats?: InkStatsApi };

let active: InkStatsCollector | null = null;

/** The collector, or null when ink statistics are off (the hooks then do nothing). */
export function inkStats(): InkStatsCollector | null {
  return active;
}

/** Turns the collector on (idempotent) and exposes it as `window.__inkStats`. */
export function enableInkStats(
  options: { readonly observeLongTasks?: boolean } = {},
): InkStatsCollector {
  if (!active) {
    active = new InkStatsCollector(options);
    (window as InkStatsWindow).__inkStats = active.api();
  }
  return active;
}

/** Turns the collector off and removes `window.__inkStats` (tests). */
export function disableInkStats(): void {
  active?.dispose();
  active = null;
  delete (window as InkStatsWindow).__inkStats;
}

if (typeof window !== 'undefined' && inkStatsRequested()) enableInkStats();
