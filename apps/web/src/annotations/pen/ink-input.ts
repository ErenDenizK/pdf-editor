/**
 * Natural ink input (experience-redesign spec §6.6, P3): native pointer handlers on a page's
 * annotation layer while the pen is armed. Framework-free: no React state per move, so a
 * stroke does not re-render the layer.
 *
 * - **Samples.** Every point (x, y, pressure, time) goes into a growable `Float32Array`, read
 *   from `getCoalescedEvents()` when the browser has it. x and y are in CSS pixels of the
 *   page at the zoom the stroke started with: a sample taken after a zoom change is scaled
 *   back by the layer's size, so a zoom in the middle of a stroke does not bend it, and the
 *   finished stroke is handed over at the zoom of the release. The layer's position comes
 *   from the press, a `ResizeObserver` and passive scroll and resize listeners, never from a
 *   layout read per move.
 * - **One stroke model** (craft spec §5.2 item 2, `InkStrokeModel` in `../ink.ts`): the
 *   samples are deduped and smoothed as they arrive, exactly as the commit does; the preview
 *   draws the smoothed, final part plus the raw tip, and the stroke handed over is the kept
 *   points, so the shape does not move at release.
 * - **Prediction** (§5.2 item 3): `getPredictedEvents()` points, or our own linear
 *   prediction from the last samples when the browser gives none (`predictTip`), both capped
 *   to one frame ahead and a few widths, tapered, drawn for the current frame only and never
 *   committed.
 * - **Preview.** One `InkPreview` canvas per page, drawn once per animation frame.
 * - **Width** (§5.2 item 1). A mouse draws the constant nominal width. Pens use pressure;
 *   touch, and pens whose browser reports the constant default, follow speed within ±10 %
 *   (`speedPressure`, a 20 ms time constant). The preset width is the nominal width: a
 *   pressure of 0.5, or a moderate speed, draws it.
 * - **Cursor** (§5.2 item 5). While armed the layer's `--pen-cursor` is a dot of the preset's
 *   colour and on-screen width with a 1 px ring (`penCursor`), refreshed when the pointer
 *   moves over the layer after a preset or zoom change.
 * - **Pointer types and palms.** See `pointerRole`. Once a pen has been seen in the
 *   session, one finger pans the stage (our own pan: the layer has `touch-action: none`;
 *   no inertia) and two fingers zoom through the Read view's anchored pinch zoom, which
 *   sees the touches because they bubble on to it. Rejected touches stop here.
 */
import { inkDedupeDistance, InkStrokeModel, type WidthPoint } from '../ink';
import type { InkPreview, PreviewPath, PreviewPoint } from './ink-preview';
import { inkStats } from './ink-stats';

/** Touch is ignored for this long after a pen leaves the surface (ms). */
export const TOUCH_AFTER_PEN_MS = 300;
/** A touch whose contact is larger than this (CSS px, width or height) is a palm. */
export const PALM_CONTACT_PX = 40;
/**
 * Pressure to width: `nominal × (1 + PRESSURE_THINNING × (2p − 1))`, so pressure 0 draws
 * half the nominal width, 0.5 the nominal width and 1 one and a half times it.
 */
export const PRESSURE_THINNING = 0.5;
/** Speed (CSS px per ms) at and above which a stroke without pressure is thinnest. */
export const SPEED_FAST_PX_PER_MS = 2;
/** Time constant (ms) of the smoothing of the speed-derived pressure (craft §5.2: ≤ 20). */
export const SPEED_SMOOTHING_MS = 20;
/**
 * Speed-derived pressure: from this when still to `1 − SPEED_PRESSURE_STILL` when fast; 0.6
 * keeps the width within ±10 % of the nominal (craft spec §5.2 item 1).
 */
export const SPEED_PRESSURE_STILL = 0.6;
/** Prediction reaches at most this far ahead of the newest sample (ms). */
export const PREDICT_HORIZON_MS = 16;
/** Prediction reaches at most this far (CSS px), or `PREDICT_MAX_WIDTHS` widths if longer. */
export const PREDICT_MAX_PX = 12;
export const PREDICT_MAX_WIDTHS = 4;
/** Below this speed (CSS px per ms) nothing is predicted. */
export const PREDICT_MIN_SPEED = 0.05;
/** The predicted tip narrows to this share of the newest sample's width. */
export const PREDICT_TAPER = 0.8;

// ---------------------------------------------------------------------------
// Session and pointer rules
// ---------------------------------------------------------------------------

/** What the pages share about pens in this session (not persisted). */
export interface PenSession {
  /** A pen pointer has been seen (hovering or touching): fingers then pan and zoom. */
  penSeen: boolean;
  /** A pen has reported real pressure: later pen strokes start with pressure widths. */
  pressureSeen: boolean;
  /** Pens touching the surface now. */
  readonly pensDown: Set<number>;
  /** When the last pen left the surface (`performance.now()` clock). */
  lastPenUpAt: number;
}

export function createPenSession(): PenSession {
  return {
    penSeen: false,
    pressureSeen: false,
    pensDown: new Set(),
    lastPenUpAt: Number.NEGATIVE_INFINITY,
  };
}

let sharedSession = createPenSession();

/** The session every layer shares. */
export function penSession(): PenSession {
  return sharedSession;
}

/** Tests: forget that a pen was seen. */
export function resetPenSession(): void {
  sharedSession = createPenSession();
}

/** What a pointer press does while the pen is armed. */
export type PointerRole = 'draw' | 'pan' | 'ignore';

export interface PointerFacts {
  readonly pointerType: string;
  /** Contact size, CSS px (1 or 0 when the device does not report it). */
  readonly width?: number;
  readonly height?: number;
}

/**
 * The role of a press (spec §6.6): pens and mice draw. Touch is ignored while a pen is
 * down, for `TOUCH_AFTER_PEN_MS` after, and when its contact exceeds `PALM_CONTACT_PX`;
 * otherwise it pans once a pen has been seen and draws before (phones).
 */
export function pointerRole(session: PenSession, pointer: PointerFacts, now: number): PointerRole {
  if (pointer.pointerType !== 'touch') return 'draw';
  if (session.pensDown.size > 0) return 'ignore';
  if (now - session.lastPenUpAt < TOUCH_AFTER_PEN_MS) return 'ignore';
  if (Math.max(pointer.width ?? 0, pointer.height ?? 0) > PALM_CONTACT_PX) return 'ignore';
  return session.penSeen ? 'pan' : 'draw';
}

// ---------------------------------------------------------------------------
// Width
// ---------------------------------------------------------------------------

/** The full width at a point drawn with `pressure` (0–1) by a preset of `nominal` width. */
export function widthFromPressure(nominal: number, pressure: number): number {
  const p = Math.min(1, Math.max(0, pressure));
  return nominal * (1 + PRESSURE_THINNING * (2 * p - 1));
}

/**
 * The pressure a stroke without one simulates from its speed: towards
 * `SPEED_PRESSURE_STILL` when still and `1 − SPEED_PRESSURE_STILL` at `SPEED_FAST_PX_PER_MS`
 * or faster (a fast stroke is thin, as with a real pen), smoothed exponentially over
 * `SPEED_SMOOTHING_MS` so single jumpy samples do not show. A stroke starts at 0.5.
 * `distance` in CSS px, `dt` in ms (at least 1 ms is assumed).
 */
export function speedPressure(previous: number, distance: number, dt: number): number {
  const elapsed = Math.max(1, dt);
  const speed = distance / elapsed;
  const still = SPEED_PRESSURE_STILL;
  const target = still - (2 * still - 1) * Math.min(1, speed / SPEED_FAST_PX_PER_MS);
  const alpha = 1 - Math.exp(-elapsed / SPEED_SMOOTHING_MS);
  return previous + (target - previous) * alpha;
}

/**
 * The pressure browsers report without a sensor: 0.5 while a button is down (mice, pens
 * without pressure), 0 when nothing is pressed.
 */
export function isDefaultPressure(pressure: number): boolean {
  return pressure === 0.5 || pressure <= 0;
}

// ---------------------------------------------------------------------------
// Samples
// ---------------------------------------------------------------------------

/**
 * Fields per sample: x, y (CSS px at the stroke's starting zoom), pressure, time (ms since
 * the first sample), width (pt).
 */
const FIELDS = 5;

/** A growable buffer of stroke samples. */
export class InkSamples {
  private data = new Float32Array(FIELDS * 128);
  private count = 0;

  get length(): number {
    return this.count;
  }

  push(x: number, y: number, pressure: number, time: number, width: number): void {
    if ((this.count + 1) * FIELDS > this.data.length) {
      const next = new Float32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    const o = this.count * FIELDS;
    this.data[o] = x;
    this.data[o + 1] = y;
    this.data[o + 2] = pressure;
    this.data[o + 3] = time;
    this.data[o + 4] = width;
    this.count++;
  }

  x(i: number): number {
    return this.data[i * FIELDS] ?? 0;
  }
  y(i: number): number {
    return this.data[i * FIELDS + 1] ?? 0;
  }
  pressure(i: number): number {
    return this.data[i * FIELDS + 2] ?? 0;
  }
  time(i: number): number {
    return this.data[i * FIELDS + 3] ?? 0;
  }
  width(i: number): number {
    return this.data[i * FIELDS + 4] ?? 0;
  }
  setWidth(i: number, width: number): void {
    this.data[i * FIELDS + 4] = width;
  }
}

/** Where the widths of a stroke come from. */
export type WidthSource = 'pressure' | 'speed' | 'constant';

/**
 * The widths of one stroke as samples arrive. Pens with real pressure use it; a mouse draws
 * the constant nominal width; touch uses speed (±10 %). A pen that has not reported real
 * pressure yet starts with speed and switches at its first real value, which then also
 * stands for the samples before it (`take` reports that earlier widths changed). With
 * pressure, a sample that reports 0 (no value yet) takes the previous pressure.
 */
export class StrokeWidths {
  source: WidthSource;
  private simulated = 0.5;
  private lastPressure = -1;

  constructor(
    private readonly samples: InkSamples,
    private readonly nominal: number,
    private readonly pointerType: string,
    pressureSeen: boolean,
  ) {
    this.source =
      pointerType === 'mouse'
        ? 'constant'
        : pointerType === 'pen' && pressureSeen
          ? 'pressure'
          : 'speed';
  }

  /** Width (pt) of a new sample; `rewrote` is true when earlier widths changed too. */
  take(x: number, y: number, pressure: number, time: number): { width: number; rewrote: boolean } {
    const samples = this.samples;
    const n = samples.length;
    let rewrote = false;
    if (this.source === 'constant') return { width: this.nominal, rewrote };
    if (this.pointerType === 'pen' && this.source === 'speed' && !isDefaultPressure(pressure)) {
      this.source = 'pressure';
      rewrote = n > 0;
    }
    if (this.source === 'pressure') {
      if (pressure > 0) {
        if (this.lastPressure < 0) {
          // The first real value stands for the samples before it.
          for (let i = 0; i < n; i++)
            samples.setWidth(i, widthFromPressure(this.nominal, pressure));
          rewrote = n > 0;
        }
        this.lastPressure = pressure;
      }
      const p = this.lastPressure < 0 ? 0.5 : this.lastPressure;
      return { width: widthFromPressure(this.nominal, p), rewrote };
    }
    if (n > 0) {
      const i = n - 1;
      const distance = Math.hypot(x - samples.x(i), y - samples.y(i));
      this.simulated = speedPressure(this.simulated, distance, time - samples.time(i));
    }
    return { width: widthFromPressure(this.nominal, this.simulated), rewrote };
  }
}

// ---------------------------------------------------------------------------
// Prediction
// ---------------------------------------------------------------------------

/** A sample as prediction reads it: CSS px of the page now, time in ms. */
export interface TimedPoint {
  readonly x: number;
  readonly y: number;
  readonly t: number;
}

/** How far a prediction may reach from the newest sample (CSS px) for a stroke `width` wide. */
export function predictionCap(width: number): number {
  return Math.max(PREDICT_MAX_PX, PREDICT_MAX_WIDTHS * width);
}

/**
 * Our own prediction when the browser gives none (craft spec §5.2 item 3): the newest
 * sample moved on along the velocity of the last 3–4 samples (slowed to the newest
 * segment's speed when the pointer decelerates) for `PREDICT_HORIZON_MS`, capped by
 * `predictionCap`, its width tapered to `PREDICT_TAPER`. Nothing below `PREDICT_MIN_SPEED`
 * or with fewer than 3 samples. `recent` is oldest first; `width` is the newest sample's
 * width (CSS px).
 */
export function predictTip(recent: readonly TimedPoint[], width: number): PreviewPoint[] {
  const n = recent.length;
  if (n < 3) return [];
  const last = recent[n - 1] as TimedPoint;
  const first = recent[Math.max(0, n - 4)] as TimedPoint;
  const before = recent[n - 2] as TimedPoint;
  const dt = last.t - first.t;
  if (!(dt > 0)) return [];
  const vx = (last.x - first.x) / dt;
  const vy = (last.y - first.y) / dt;
  let speed = Math.hypot(vx, vy);
  if (speed < PREDICT_MIN_SPEED) return [];
  const dtLast = last.t - before.t;
  if (dtLast > 0) {
    const newest = Math.hypot(last.x - before.x, last.y - before.y) / dtLast;
    if (newest < speed) speed = newest;
  }
  if (speed < PREDICT_MIN_SPEED) return [];
  const length = Math.min(speed * PREDICT_HORIZON_MS, predictionCap(width));
  const k = length / Math.hypot(vx, vy);
  return [{ x: last.x + vx * k, y: last.y + vy * k, w: width * PREDICT_TAPER }];
}

/**
 * The browser's predicted points, held to the same limits as ours: up to
 * `PREDICT_HORIZON_MS` after the newest sample (when they carry times), within
 * `predictionCap` of it, and tapered to `PREDICT_TAPER` of its width.
 */
export function capPrediction(
  last: TimedPoint,
  predicted: readonly TimedPoint[],
  width: number,
): PreviewPoint[] {
  const cap = predictionCap(width);
  const kept = predicted.filter(
    (p) => !(p.t > 0 && last.t > 0 && p.t - last.t > PREDICT_HORIZON_MS),
  );
  return kept.map((p, i) => {
    const dx = p.x - last.x;
    const dy = p.y - last.y;
    const d = Math.hypot(dx, dy);
    const k = d > cap ? cap / d : 1;
    const taper = 1 - ((1 - PREDICT_TAPER) * (i + 1)) / kept.length;
    return { x: last.x + dx * k, y: last.y + dy * k, w: width * taper };
  });
}

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

/** On-screen dot diameter of the pen cursor (CSS px). */
export const PEN_CURSOR_MIN_PX = 3;
export const PEN_CURSOR_MAX_PX = 32;

/** Relative luminance (WCAG) of `#rrggbb`; 0 for anything else. */
function luminance(color: string): number {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (!m) return 0;
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => {
    const c = Number.parseInt(h ?? '0', 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * The armed pen's cursor (craft spec §5.2 item 5, research 12 §6): a dot of the preset's
 * colour (and opacity) as wide as the stroke draws on screen, `diameter` CSS px clamped to
 * 3–32, inside a 1 px ring that contrasts with the dot; an SVG data URI with its hot spot in
 * the centre, `crosshair` as the fallback. A CSS `cursor` value.
 */
export function penCursor(color: string, opacity: number, diameter: number): string {
  const d = Math.min(PEN_CURSOR_MAX_PX, Math.max(PEN_CURSOR_MIN_PX, diameter));
  const size = Math.ceil(d) + 2;
  const c = size / 2;
  const fill = /^#[0-9a-f]{6}$/i.test(color) ? color : '#000000';
  const ring = luminance(fill) > 0.4 ? 'rgba(0,0,0,0.7)' : 'rgba(255,255,255,0.9)';
  const alpha = Math.min(1, Math.max(0.2, opacity));
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
    `viewBox="0 0 ${size} ${size}">` +
    `<circle cx="${c}" cy="${c}" r="${d / 2}" fill="${fill}" fill-opacity="${alpha}"/>` +
    `<circle cx="${c}" cy="${c}" r="${d / 2 + 0.5}" fill="none" stroke="${ring}"/>` +
    '</svg>';
  const hot = Math.floor(c);
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${hot} ${hot}, crosshair`;
}

/** The custom property the layer's pen cursor rule reads (`AnnotationLayer.module.css`). */
export const PEN_CURSOR_PROPERTY = '--pen-cursor';

// ---------------------------------------------------------------------------
// The input pipeline
// ---------------------------------------------------------------------------

export interface InkInputContext {
  /** The preset's (nominal) width, points. */
  readonly width: number;
  readonly color: string;
  readonly opacity: number;
  /** CSS pixels per point at the current zoom. */
  readonly scale: number;
}

/** A finished stroke, in CSS pixels of the page. */
export interface InkStrokeInput {
  readonly points: readonly { readonly x: number; readonly y: number }[];
  /** Full width at each point, points (pt). */
  readonly widths: readonly number[];
  readonly pointerType: string;
  readonly widthSource: WidthSource;
  /** Shift was held at the end: a straight line from the first point to the last. */
  readonly straight: boolean;
}

/**
 * Moves the finished stroke to a settling preview, drawn from `final` (the committed centre
 * line and widths in CSS pixels) when given. Returns the function that removes it.
 */
export type SettleInk = (final?: PreviewPath) => () => void;

export interface InkInputOptions {
  /** The page's annotation layer. */
  readonly element: HTMLElement;
  readonly preview: InkPreview;
  /** The style and zoom to draw with; null stops the press. */
  readonly context: () => InkInputContext | null;
  /** Called before a stroke starts (commit an open editor, clear the selection). */
  readonly onBegin?: (event: PointerEvent) => void;
  /**
   * The finished stroke. Call `settle` synchronously (in the same task), else the live
   * preview is dropped.
   */
  readonly onStroke: (stroke: InkStrokeInput, settle: SettleInk) => void;
  readonly session?: PenSession;
  /** Clock of `PenSession.lastPenUpAt` (default `performance.now`). */
  readonly now?: () => number;
}

interface ActiveStroke {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly samples: InkSamples;
  readonly widths: StrokeWidths;
  /** Dedupe and smoothing as the commit does them (CSS px at the starting zoom; pt widths). */
  model: InkStrokeModel;
  /** The model's dedupe distance (CSS px at the starting zoom). */
  readonly minDistance: number;
  readonly nominal: number;
  /** CSS px per point when the stroke started. */
  readonly scale: number;
  /** The layer's width (CSS px) when the stroke started. */
  readonly baseWidth: number;
  /** The layer's size now relative to `baseWidth`: the zoom since the stroke started. */
  zoom: number;
  readonly startTime: number;
  straight: boolean;
  predicted: PreviewPoint[];
  /** The next frame must rebuild the preview. */
  restart: boolean;
}

interface Pan {
  x: number;
  y: number;
}

/** The scroll container a one-finger pan moves: the Read viewport, else a scrolling ancestor. */
function scrollContainer(element: HTMLElement): HTMLElement | null {
  const viewport = element.closest<HTMLElement>('[data-read-viewport]');
  if (viewport) return viewport;
  for (let el = element.parentElement; el; el = el.parentElement) {
    const style = getComputedStyle(el);
    if (/(auto|scroll)/.test(style.overflowY + style.overflowX)) return el;
  }
  return null;
}

/** The model of a stroke's samples so far (rebuilt when earlier widths change). */
function buildModel(samples: InkSamples, minDistance: number): InkStrokeModel {
  const model = new InkStrokeModel(minDistance);
  for (let i = 0; i < samples.length; i++) {
    model.add({ x: samples.x(i), y: samples.y(i), w: samples.width(i) });
  }
  return model;
}

/**
 * Attaches the pipeline to a page layer; returns the function that detaches it (a stroke
 * in progress is dropped).
 */
export function attachInkInput(options: InkInputOptions): () => void {
  const { element, preview } = options;
  const session = options.session ?? penSession();
  const now = options.now ?? (() => performance.now());
  let stroke: ActiveStroke | null = null;
  let frame = 0;
  const pans = new Map<number, Pan>();
  let panBase: { x: number; y: number; left: number; top: number } | null = null;
  let listening = false;
  /** The layer's box while a stroke is down; null when a resize or scroll moved it. */
  let layerBox: DOMRect | null = null;
  let cursorKey = '';

  const invalidateBox = () => {
    layerBox = null;
  };
  const resizeObserver =
    typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(invalidateBox);
  /** The layer's box: measured at the press and again only after a resize or a scroll. */
  const box = (): DOMRect => {
    layerBox ??= element.getBoundingClientRect();
    return layerBox;
  };

  /** The pen cursor for the armed preset at the current zoom (when it changed). */
  const updateCursor = () => {
    const context = options.context();
    if (!context) return;
    const diameter = context.width * context.scale;
    const key = `${context.color}|${context.opacity}|${diameter.toFixed(1)}`;
    if (key === cursorKey) return;
    cursorKey = key;
    element.style.setProperty(
      PEN_CURSOR_PROPERTY,
      penCursor(context.color, context.opacity, diameter),
    );
  };

  /** A point of the stroke at the current zoom (CSS px of the page). */
  const scaled = (s: ActiveStroke, p: WidthPoint): PreviewPoint => ({
    x: p.x * s.zoom,
    y: p.y * s.zoom,
    w: p.w * s.scale * s.zoom,
  });

  /** A `PreviewPath` over points at the starting zoom (pt widths). */
  const pathOf = (s: ActiveStroke, points: readonly WidthPoint[]): PreviewPath => {
    const scale = s.scale * s.zoom;
    return {
      length: points.length,
      x: (i) => (points[i]?.x ?? 0) * s.zoom,
      y: (i) => (points[i]?.y ?? 0) * s.zoom,
      w: (i) => (points[i]?.w ?? s.nominal) * scale,
    };
  };

  /** Shift: a straight line from the first sample to the newest, at the nominal width. */
  const straightView = (s: ActiveStroke): PreviewPath => {
    const { samples, zoom } = s;
    const last = samples.length - 1;
    return {
      length: 2,
      x: (i) => samples.x(i === 0 ? 0 : last) * zoom,
      y: (i) => samples.y(i === 0 ? 0 : last) * zoom,
      w: () => s.nominal * s.scale * zoom,
    };
  };

  /**
   * What the preview draws now: the model's final, smoothed points, then the raw tip; the
   * joins of all but the last smoothed point are final.
   */
  const liveView = (s: ActiveStroke): { path: PreviewPath; settled: number } => {
    if (s.straight && s.samples.length > 1) return { path: straightView(s), settled: 0 };
    const { smooth } = s.model;
    const tip = s.model.tip();
    const scale = s.scale * s.zoom;
    const n = smooth.length;
    const at = (i: number) => (i < n ? smooth[i] : tip[i - n]);
    return {
      path: {
        length: n + tip.length,
        x: (i) => (at(i)?.x ?? 0) * s.zoom,
        y: (i) => (at(i)?.y ?? 0) * s.zoom,
        w: (i) => (at(i)?.w ?? s.nominal) * scale,
      },
      settled: Math.max(0, n - 1),
    };
  };

  /** Follows a zoom change since the stroke started (the preview is rebuilt at the new size). */
  const measure = (s: ActiveStroke, rect: DOMRect) => {
    const zoom = s.baseWidth > 0 && rect.width > 0 ? rect.width / s.baseWidth : 1;
    if (Math.abs(zoom - s.zoom) > 1e-6) {
      s.zoom = zoom;
      s.restart = true;
    }
  };

  const paint = () => {
    frame = 0;
    const s = stroke;
    if (!s) return;
    const stats = inkStats();
    const start = stats ? performance.now() : 0;
    const view = liveView(s);
    preview.draw(view.path, s.straight ? [] : s.predicted, s.restart, view.settled);
    s.restart = false;
    if (stats) {
      // Event-to-draw: the newest sample's event time to the end of this draw.
      const last = s.samples.length - 1;
      stats.frame(start, performance.now(), s.startTime + s.samples.time(last), last + 1);
    }
  };

  const schedule = () => {
    if (frame === 0) frame = requestAnimationFrame(paint);
  };

  const cancelFrame = () => {
    if (frame !== 0) cancelAnimationFrame(frame);
    frame = 0;
  };

  const local = (e: { clientX: number; clientY: number }, rect: DOMRect) => ({
    x: e.clientX - rect.left,
    y: e.clientY - rect.top,
  });

  /** Adds a sample at (x, y), CSS px of the page at the current zoom. */
  const addSample = (s: ActiveStroke, x: number, y: number, pressure: number, time: number) => {
    const t = time - s.startTime;
    x /= s.zoom;
    y /= s.zoom;
    const { width, rewrote } = s.widths.take(x, y, pressure, t);
    s.samples.push(x, y, pressure, t, width);
    if (rewrote) {
      // Earlier widths changed (a pen's first real pressure): smooth them again.
      s.model = buildModel(s.samples, s.minDistance);
      s.restart = true;
    } else {
      const i = s.samples.length - 1;
      s.model.add({ x: s.samples.x(i), y: s.samples.y(i), w: width });
    }
  };

  /** The tip's prediction for this frame (CSS px at the current zoom); never committed. */
  const predict = (s: ActiveStroke, e: PointerEvent, rect: DOMRect): PreviewPoint[] => {
    const { samples, zoom } = s;
    const last = samples.length - 1;
    const width = samples.width(last) * s.scale * zoom;
    const timed = (i: number): TimedPoint => ({
      x: samples.x(i) * zoom,
      y: samples.y(i) * zoom,
      t: samples.time(i),
    });
    const newest = timed(last);
    const browser = e.getPredictedEvents?.() ?? [];
    if (browser.length > 0) {
      return capPrediction(
        newest,
        browser.map((c) => ({ ...local(c, rect), t: c.timeStamp - s.startTime })),
        width,
      );
    }
    const recent: TimedPoint[] = [];
    for (let i = Math.max(0, last - 3); i <= last; i++) recent.push(timed(i));
    return predictTip(recent, width);
  };

  const startListening = () => {
    if (listening) return;
    listening = true;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('scroll', invalidateBox, { capture: true, passive: true });
    window.addEventListener('resize', invalidateBox, { passive: true });
    resizeObserver?.observe(element);
  };

  const stopListening = () => {
    if (!listening || stroke || pans.size > 0) return;
    listening = false;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('scroll', invalidateBox, { capture: true });
    window.removeEventListener('resize', invalidateBox);
    resizeObserver?.disconnect();
    layerBox = null;
  };

  const penUp = (s: ActiveStroke) => {
    if (s.pointerType !== 'pen') return;
    session.pensDown.delete(s.pointerId);
    session.lastPenUpAt = now();
  };

  const releaseCapture = (pointerId: number) => {
    try {
      if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
    } catch {
      // Not captured (synthetic pointers): nothing to release.
    }
  };

  /** Drops the stroke in progress without committing it. */
  const dropStroke = () => {
    const s = stroke;
    if (!s) return;
    stroke = null;
    cancelFrame();
    penUp(s);
    releaseCapture(s.pointerId);
    preview.cancel();
    inkStats()?.strokeCancel();
    stopListening();
  };

  const rebasePan = () => {
    const container = scrollContainer(element);
    const only = pans.size === 1 ? [...pans.values()][0] : undefined;
    panBase =
      only && container
        ? { x: only.x, y: only.y, left: container.scrollLeft, top: container.scrollTop }
        : null;
  };

  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType === 'pen') session.penSeen = true;
    const role = pointerRole(session, e, now());
    if (role === 'ignore') {
      // Palms and fingers next to the pen: neither draw nor reach the pinch zoom.
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (role === 'pan') {
      // Bubbles on: two fingers are the Read view's pinch zoom.
      pans.set(e.pointerId, { x: e.clientX, y: e.clientY });
      rebasePan();
      startListening();
      return;
    }
    if (stroke) {
      if (e.pointerType === 'touch' && stroke.pointerType === 'touch') {
        // A second finger before any pen: a pinch, not a stroke.
        dropStroke();
      } else {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    if (e.button !== 0) return;
    // Presses in the layer's own chrome (bar, editors) are theirs.
    if (e.target instanceof Element && e.target.closest('[data-annotation-keep]')) return;
    e.preventDefault();
    options.onBegin?.(e);
    const context = options.context();
    if (!context) return;
    try {
      element.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic pointers cannot be captured; the window listeners follow them anyway.
    }
    if (e.pointerType === 'pen') session.pensDown.add(e.pointerId);
    const samples = new InkSamples();
    // The one layout read of the press; later only after a resize or a scroll.
    const rect = element.getBoundingClientRect();
    layerBox = rect;
    const minDistance = inkDedupeDistance(e.pointerType, context.scale);
    const s: ActiveStroke = {
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      samples,
      widths: new StrokeWidths(samples, context.width, e.pointerType, session.pressureSeen),
      model: new InkStrokeModel(minDistance),
      minDistance,
      nominal: context.width,
      scale: context.scale,
      baseWidth: rect.width,
      zoom: 1,
      startTime: e.timeStamp,
      straight: e.shiftKey,
      predicted: [],
      restart: false,
    };
    stroke = s;
    inkStats()?.strokeBegin(e.pointerType);
    preview.begin({ color: context.color, opacity: context.opacity });
    const p = local(e, rect);
    addSample(s, p.x, p.y, e.pressure, e.timeStamp);
    if (s.widths.source === 'pressure' && e.pointerType === 'pen') session.pressureSeen = true;
    startListening();
    schedule();
  };

  const onMove = (e: PointerEvent) => {
    const s = stroke;
    if (s?.pointerId === e.pointerId) {
      const rect = box();
      measure(s, rect);
      const coalesced = e.getCoalescedEvents?.() ?? [];
      for (const c of coalesced.length > 0 ? coalesced : [e]) {
        const p = local(c, rect);
        addSample(s, p.x, p.y, c.pressure, c.timeStamp);
      }
      if (s.widths.source === 'pressure' && s.pointerType === 'pen') session.pressureSeen = true;
      if (s.straight !== e.shiftKey) {
        s.straight = e.shiftKey;
        s.restart = true;
      }
      s.predicted = predict(s, e, rect);
      schedule();
      return;
    }
    const pan = pans.get(e.pointerId);
    if (!pan) return;
    pan.x = e.clientX;
    pan.y = e.clientY;
    const container = scrollContainer(element);
    if (panBase && container && pans.size === 1) {
      // No inertia (spec §6.6): the page follows the finger and stops with it.
      container.scrollLeft = panBase.left - (pan.x - panBase.x);
      container.scrollTop = panBase.top - (pan.y - panBase.y);
    }
  };

  const onUp = (e: PointerEvent) => {
    const s = stroke;
    if (s?.pointerId === e.pointerId) {
      const stats = inkStats();
      const upAt = stats ? performance.now() : 0;
      const rect = box();
      measure(s, rect);
      const p = local(e, rect);
      const last = s.samples.length - 1;
      if (
        Math.fround(p.x / s.zoom) !== s.samples.x(last) ||
        Math.fround(p.y / s.zoom) !== s.samples.y(last)
      ) {
        addSample(s, p.x, p.y, e.pressure > 0 ? e.pressure : s.samples.pressure(last), e.timeStamp);
      }
      const straight = e.shiftKey && s.samples.length > 1;
      if (straight !== s.straight) s.restart = true;
      s.straight = straight;
      s.predicted = [];
      cancelFrame();
      const drawStart = stats ? performance.now() : 0;
      // The last frame: the whole stroke smoothed as the commit smooths it. Its stable part
      // is already drawn, so only the end and the tip's area are outlined again.
      let points: PreviewPoint[];
      if (straight) {
        const v = straightView(s);
        preview.draw(v, [], true);
        points = [0, 1].map((i) => ({ x: v.x(i), y: v.y(i), w: v.w(i) }));
      } else {
        const final = [...s.model.smooth, ...s.model.finishTail()];
        preview.draw(pathOf(s, final), [], s.restart, final.length);
        points = s.model.handover().map((q) => scaled(s, q));
      }
      stats?.strokeEnd(upAt, drawStart, performance.now(), s.samples.length);
      stroke = null;
      penUp(s);
      releaseCapture(s.pointerId);
      stopListening();
      const toPt = s.scale * s.zoom;
      const input: InkStrokeInput = {
        points: points.map((q) => ({ x: q.x, y: q.y })),
        widths: points.map((q) => q.w / toPt),
        pointerType: s.pointerType,
        widthSource: s.widths.source,
        straight,
      };
      let settled = false;
      const settle: SettleInk = (final) => {
        settled = true;
        return preview.settle(final).release;
      };
      try {
        options.onStroke(input, settle);
      } finally {
        if (!settled) {
          preview.cancel();
          inkStats()?.strokeCancel();
        }
      }
      updateCursor();
      return;
    }
    if (pans.delete(e.pointerId)) {
      rebasePan();
      stopListening();
    }
  };

  const onCancel = (e: PointerEvent) => {
    if (stroke?.pointerId === e.pointerId) {
      dropStroke();
      return;
    }
    if (pans.delete(e.pointerId)) {
      rebasePan();
      stopListening();
    }
  };

  /** A hovering pen counts as seen; the cursor follows preset and zoom changes. */
  const onHover = (e: PointerEvent) => {
    if (e.pointerType === 'pen') session.penSeen = true;
    if (!stroke) updateCursor();
  };

  element.addEventListener('pointerdown', onPointerDown);
  element.addEventListener('pointermove', onHover, { passive: true });
  updateCursor();
  return () => {
    element.removeEventListener('pointerdown', onPointerDown);
    element.removeEventListener('pointermove', onHover);
    element.style.removeProperty(PEN_CURSOR_PROPERTY);
    dropStroke();
    pans.clear();
    stroke = null;
    listening = true;
    stopListening();
  };
}
