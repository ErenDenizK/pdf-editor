/**
 * Natural ink input (experience-redesign spec §6.6, P3): native pointer handlers on a page's
 * annotation layer while the pen is armed. Framework-free: no React state per move, so a
 * stroke does not re-render the layer.
 *
 * - **Samples.** Every point (x, y, pressure, time) goes into a growable `Float32Array`, read
 *   from `getCoalescedEvents()` when the browser has it. x and y are in CSS pixels of the
 *   page at the zoom the stroke started with: a sample taken after a zoom change is scaled
 *   back by the layer's size, so a zoom in the middle of a stroke does not bend it, and the
 *   finished stroke is handed over at the zoom of the release. `getPredictedEvents()` points
 *   are drawn for the current frame only, never committed.
 * - **Preview.** One `InkPreview` canvas per page, drawn once per animation frame.
 * - **Width.** Pen pressure, or speed when there is no pressure (mice, touch, pens whose
 *   browser reports the constant default); see `widthFromPressure` and `speedPressure`.
 *   The preset width is the nominal width: a pressure of 0.5, or a moderate speed, draws it.
 * - **Pointer types and palms.** See `pointerRole`. Once a pen has been seen in the
 *   session, one finger pans the stage (our own pan: the layer has `touch-action: none`;
 *   no inertia) and two fingers zoom through the Read view's anchored pinch zoom, which
 *   sees the touches because they bubble on to it. Rejected touches stop here.
 */
import type { InkPreview, PreviewPath, PreviewPoint } from './ink-preview';

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
/** Time constant (ms) of the smoothing of the speed-derived pressure. */
export const SPEED_SMOOTHING_MS = 40;
/** Speed-derived pressure: from this when still to `1 − SPEED_PRESSURE_STILL` when fast. */
export const SPEED_PRESSURE_STILL = 0.75;

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
export type WidthSource = 'pressure' | 'speed';

/**
 * The widths of one stroke as samples arrive. Pens with real pressure use it; everything
 * else uses speed. A pen that has not reported real pressure yet starts with speed and
 * switches at its first real value, which then also stands for the samples before it
 * (`take` reports that earlier widths changed). With pressure, a sample that reports 0 (no
 * value yet) takes the previous pressure.
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
    this.source = pointerType === 'pen' && pressureSeen ? 'pressure' : 'speed';
  }

  /** Width (pt) of a new sample; `rewrote` is true when earlier widths changed too. */
  take(x: number, y: number, pressure: number, time: number): { width: number; rewrote: boolean } {
    const samples = this.samples;
    const n = samples.length;
    let rewrote = false;
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

  /** The stroke in CSS px of the page at the current zoom. */
  const view = (s: ActiveStroke): PreviewPath => {
    const { samples, zoom } = s;
    const scale = s.scale * zoom;
    if (s.straight && samples.length > 1) {
      const last = samples.length - 1;
      return {
        length: 2,
        x: (i) => samples.x(i === 0 ? 0 : last) * zoom,
        y: (i) => samples.y(i === 0 ? 0 : last) * zoom,
        w: () => s.nominal * scale,
      };
    }
    return {
      length: samples.length,
      x: (i) => samples.x(i) * zoom,
      y: (i) => samples.y(i) * zoom,
      w: (i) => samples.width(i) * scale,
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
    preview.draw(view(s), s.straight ? [] : s.predicted, s.restart);
    s.restart = false;
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
    if (rewrote) s.restart = true;
  };

  const startListening = () => {
    if (listening) return;
    listening = true;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  };

  const stopListening = () => {
    if (!listening || stroke || pans.size > 0) return;
    listening = false;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
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
    const rect = element.getBoundingClientRect();
    const s: ActiveStroke = {
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      samples,
      widths: new StrokeWidths(samples, context.width, e.pointerType, session.pressureSeen),
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
      const rect = element.getBoundingClientRect();
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
      const last = s.samples.length - 1;
      const w = s.samples.width(last) * s.scale * s.zoom;
      s.predicted = (e.getPredictedEvents?.() ?? []).map((c) => ({ ...local(c, rect), w }));
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
      const rect = element.getBoundingClientRect();
      measure(s, rect);
      const p = local(e, rect);
      const last = s.samples.length - 1;
      if (
        Math.fround(p.x / s.zoom) !== s.samples.x(last) ||
        Math.fround(p.y / s.zoom) !== s.samples.y(last)
      ) {
        addSample(s, p.x, p.y, e.pressure > 0 ? e.pressure : s.samples.pressure(last), e.timeStamp);
      }
      s.straight = e.shiftKey;
      s.predicted = [];
      cancelFrame();
      preview.draw(view(s), [], true);
      stroke = null;
      penUp(s);
      releaseCapture(s.pointerId);
      stopListening();
      const v = view(s);
      const input: InkStrokeInput = {
        points: Array.from({ length: v.length }, (_, i) => ({ x: v.x(i), y: v.y(i) })),
        widths: Array.from({ length: v.length }, (_, i) => v.w(i) / (s.scale * s.zoom)),
        pointerType: s.pointerType,
        widthSource: s.widths.source,
        straight: s.straight && s.samples.length > 1,
      };
      let settled = false;
      const settle: SettleInk = (final) => {
        settled = true;
        return preview.settle(final).release;
      };
      try {
        options.onStroke(input, settle);
      } finally {
        if (!settled) preview.cancel();
      }
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

  /** A hovering pen counts as seen: fingers pan from then on. */
  const onHover = (e: PointerEvent) => {
    if (e.pointerType === 'pen') session.penSeen = true;
  };

  element.addEventListener('pointerdown', onPointerDown);
  element.addEventListener('pointermove', onHover, { passive: true });
  return () => {
    element.removeEventListener('pointerdown', onPointerDown);
    element.removeEventListener('pointermove', onHover);
    dropStroke();
    pans.clear();
    stroke = null;
    listening = true;
    stopListening();
  };
}
