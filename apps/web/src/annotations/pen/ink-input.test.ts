/**
 * The pen's input pipeline (experience-redesign spec §6.6), in a real browser: pointer
 * roles and palm rejection, the pressure and speed width mappings, and the native handlers
 * on a layer with synthetic pointer events (pen with pressure, touch pan after a pen,
 * touch ignored next to a pen, palms, fingers before any pen). Craft spec §5.2: a mouse
 * draws the constant width and touch stays within ±10 %; one stroke model, so the committed
 * outline lies on the last preview frame; prediction capped and tapered; no layout read per
 * move; the pen cursor.
 */
import { inkOutlineOps } from '@pdf-editor/engine/ink-outline';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { finishInkStroke, INK_MOUSE_DEDUPE_CSS_PX } from '../ink';
import {
  attachInkInput,
  capPrediction,
  createPenSession,
  type InkInputContext,
  InkSamples,
  type InkStrokeInput,
  PALM_CONTACT_PX,
  PEN_CURSOR_PROPERTY,
  type PenSession,
  penCursor,
  PREDICT_HORIZON_MS,
  PREDICT_MAX_PX,
  PREDICT_TAPER,
  predictionCap,
  predictTip,
  pointerRole,
  SPEED_PRESSURE_STILL,
  SPEED_SMOOTHING_MS,
  speedPressure,
  StrokeWidths,
  TOUCH_AFTER_PEN_MS,
  widthFromPressure,
} from './ink-input';
import { InkPreview, outlinePath, type PreviewPath, type PreviewPoint } from './ink-preview';

describe('pointer roles', () => {
  it('pens and mice draw; touch draws until a pen has been seen, then pans', () => {
    const session = createPenSession();
    expect(pointerRole(session, { pointerType: 'pen' }, 0)).toBe('draw');
    expect(pointerRole(session, { pointerType: 'mouse' }, 0)).toBe('draw');
    expect(pointerRole(session, { pointerType: 'touch', width: 10, height: 10 }, 0)).toBe('draw');
    session.penSeen = true;
    expect(pointerRole(session, { pointerType: 'touch', width: 10, height: 10 }, 0)).toBe('pan');
    expect(pointerRole(session, { pointerType: 'mouse' }, 0)).toBe('draw');
  });

  it('ignores touch while a pen is down and for 300 ms after', () => {
    const session = createPenSession();
    session.penSeen = true;
    session.pensDown.add(7);
    expect(pointerRole(session, { pointerType: 'touch' }, 1000)).toBe('ignore');
    session.pensDown.delete(7);
    session.lastPenUpAt = 1000;
    expect(pointerRole(session, { pointerType: 'touch' }, 1000)).toBe('ignore');
    expect(pointerRole(session, { pointerType: 'touch' }, 1000 + TOUCH_AFTER_PEN_MS - 1)).toBe(
      'ignore',
    );
    expect(pointerRole(session, { pointerType: 'touch' }, 1000 + TOUCH_AFTER_PEN_MS)).toBe('pan');
  });

  it('ignores a contact larger than 40 CSS px, with or without a pen', () => {
    const session = createPenSession();
    const palm = { pointerType: 'touch', width: PALM_CONTACT_PX + 1, height: 20 };
    expect(pointerRole(session, palm, 0)).toBe('ignore');
    expect(pointerRole(session, { ...palm, width: PALM_CONTACT_PX }, 0)).toBe('draw');
    session.penSeen = true;
    expect(pointerRole(session, { pointerType: 'touch', width: 8, height: 60 }, 0)).toBe('ignore');
  });
});

describe('width mapping', () => {
  it('pressure: half the nominal width at 0, the nominal at 0.5, 1.5 times at 1', () => {
    expect(widthFromPressure(2, 0)).toBeCloseTo(1);
    expect(widthFromPressure(2, 0.5)).toBeCloseTo(2);
    expect(widthFromPressure(2, 1)).toBeCloseTo(3);
    expect(widthFromPressure(2, 0.2)).toBeCloseTo(1.4);
    expect(widthFromPressure(2, 4)).toBeCloseTo(3);
    expect(widthFromPressure(2, -1)).toBeCloseTo(1);
  });

  it('speed: still strokes thicken, fast ones thin, smoothed over time', () => {
    let still = 0.5;
    for (let i = 0; i < 50; i++) still = speedPressure(still, 0, 16);
    expect(still).toBeCloseTo(SPEED_PRESSURE_STILL, 2);
    let fast = 0.5;
    for (let i = 0; i < 50; i++) fast = speedPressure(fast, 80, 16);
    expect(fast).toBeCloseTo(1 - SPEED_PRESSURE_STILL, 2);
    // One quick sample moves the simulated pressure only a little.
    const once = speedPressure(0.5, 50, 1);
    expect(once).toBeLessThan(0.5);
    expect(once).toBeGreaterThan(0.48);
    // A moderate speed keeps the nominal width.
    expect(speedPressure(0.5, 16, 16)).toBeCloseTo(0.5, 5);
  });

  it('a pen with real pressure uses it; a pen at the constant 0.5 uses speed', () => {
    const pressured = new InkSamples();
    const widths = new StrokeWidths(pressured, 2, 'pen', false);
    for (const [i, p] of [0.2, 0.6, 1].entries()) {
      const { width } = widths.take(i * 4, 0, p, i * 16);
      pressured.push(i * 4, 0, p, i * 16, width);
    }
    expect(widths.source).toBe('pressure');
    for (const [i, p] of [0.2, 0.6, 1].entries()) {
      expect(pressured.width(i)).toBeCloseTo(widthFromPressure(2, p), 5);
    }

    const constant = new InkSamples();
    const speed = new StrokeWidths(constant, 2, 'pen', false);
    for (let i = 0; i < 10; i++) {
      const { width } = speed.take(i * 40, 0, 0.5, i * 8);
      constant.push(i * 40, 0, 0.5, i * 8, width);
    }
    expect(speed.source).toBe('speed');
    expect(constant.width(9)).toBeLessThan(constant.width(0));
  });

  it('speed widths stay within ±10 % of the nominal, smoothed over at most 20 ms', () => {
    expect(widthFromPressure(2, SPEED_PRESSURE_STILL)).toBeCloseTo(2.2);
    expect(widthFromPressure(2, 1 - SPEED_PRESSURE_STILL)).toBeCloseTo(1.8);
    expect(SPEED_SMOOTHING_MS).toBeLessThanOrEqual(20);
    // After one time constant of stillness, 63 % of the way to the still width.
    const p = speedPressure(0.5, 0, SPEED_SMOOTHING_MS);
    expect(p - 0.5).toBeCloseTo((SPEED_PRESSURE_STILL - 0.5) * (1 - Math.exp(-1)), 5);
  });

  it('a mouse draws the constant nominal width whatever its speed', () => {
    const samples = new InkSamples();
    const widths = new StrokeWidths(samples, 2, 'mouse', true);
    expect(widths.source).toBe('constant');
    for (let i = 0; i < 30; i++) {
      // Still, then fast, then still again.
      const x = i < 10 ? 0 : i < 20 ? (i - 9) * 40 : 400;
      const { width, rewrote } = widths.take(x, 0, 0.5, i * 8);
      expect(width).toBe(2);
      expect(rewrote).toBe(false);
      samples.push(x, 0, 0.5, i * 8, width);
    }
  });

  it('a pen switches to pressure at its first real value, which also stands for the samples before', () => {
    const samples = new InkSamples();
    const widths = new StrokeWidths(samples, 2, 'pen', false);
    const first = widths.take(0, 0, 0.5, 0);
    samples.push(0, 0, 0.5, 0, first.width);
    expect(widths.source).toBe('speed');
    const next = widths.take(5, 0, 0.9, 10);
    expect(next.rewrote).toBe(true);
    expect(widths.source).toBe('pressure');
    expect(samples.width(0)).toBeCloseTo(widthFromPressure(2, 0.9));
    expect(next.width).toBeCloseTo(widthFromPressure(2, 0.9));
    // A sample without a value (0) keeps the previous pressure.
    expect(widths.take(9, 0, 0, 20).width).toBeCloseTo(widthFromPressure(2, 0.9));
  });

  it('the sample buffer grows', () => {
    const samples = new InkSamples();
    for (let i = 0; i < 1000; i++) samples.push(i, -i, 0.5, i, 1 + i / 1000);
    expect(samples.length).toBe(1000);
    expect([samples.x(999), samples.y(999), samples.time(999)]).toEqual([999, -999, 999]);
    expect(samples.width(500)).toBeCloseTo(1.5);
  });
});

// ---------------------------------------------------------------------------
// Native handlers on a layer
// ---------------------------------------------------------------------------

interface Rig {
  readonly viewport: HTMLDivElement;
  readonly layer: HTMLDivElement;
  readonly strokes: InkStrokeInput[];
  readonly bubbled: string[];
  readonly session: PenSession;
  clock: number;
  detach(): void;
}

let rig: Rig;

function setup(): Rig {
  const viewport = document.createElement('div');
  viewport.setAttribute('data-read-viewport', '');
  Object.assign(viewport.style, {
    position: 'fixed',
    left: '0px',
    top: '0px',
    width: '400px',
    height: '300px',
    overflow: 'auto',
  });
  const layer = document.createElement('div');
  Object.assign(layer.style, { position: 'relative', width: '1200px', height: '1600px' });
  const host = document.createElement('div');
  Object.assign(host.style, { position: 'absolute', inset: '0px' });
  layer.appendChild(host);
  viewport.appendChild(layer);
  document.body.appendChild(viewport);
  const strokes: InkStrokeInput[] = [];
  const bubbled: string[] = [];
  // What the Read view's pinch zoom would see.
  viewport.addEventListener('pointerdown', (e) => bubbled.push(e.pointerType));
  const session = createPenSession();
  const preview = new InkPreview(host);
  const r: Rig = {
    viewport,
    layer,
    strokes,
    bubbled,
    session,
    clock: 10_000,
    detach: () => undefined,
  };
  const detach = attachInkInput({
    element: layer,
    preview,
    session,
    now: () => r.clock,
    context: () => ({ width: 2, color: '#1e88e5', opacity: 1, scale: 1 }),
    onStroke: (stroke, settle) => {
      strokes.push(stroke);
      settle()();
    },
  });
  r.detach = () => {
    detach();
    preview.destroy();
    viewport.remove();
  };
  return r;
}

const frames = async (n: number) => {
  for (let i = 0; i < n; i++) await new Promise((resolve) => requestAnimationFrame(resolve));
};

function pointer(
  type: string,
  init: {
    x: number;
    y: number;
    id: number;
    kind: 'pen' | 'touch' | 'mouse';
    pressure?: number;
    size?: number;
  },
): PointerEvent {
  const up = type === 'pointerup' || type === 'pointercancel';
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.x,
    clientY: init.y,
    pointerId: init.id,
    pointerType: init.kind,
    isPrimary: true,
    button: type === 'pointermove' ? -1 : 0,
    buttons: up ? 0 : 1,
    pressure: init.pressure ?? (up ? 0 : 0.5),
    width: init.size ?? 1,
    height: init.size ?? 1,
  });
}

/** A press at (x0, y0), `steps` moves to (x1, y1), release. `pressure(t)` for t in 0..1. */
function drag(
  target: HTMLElement,
  kind: 'pen' | 'touch' | 'mouse',
  id: number,
  from: [number, number],
  to: [number, number],
  options: { steps?: number; pressure?: (t: number) => number; size?: number } = {},
): void {
  const steps = options.steps ?? 20;
  const at = (t: number) => ({
    x: from[0] + (to[0] - from[0]) * t,
    y: from[1] + (to[1] - from[1]) * t,
    id,
    kind,
    ...(options.pressure ? { pressure: options.pressure(t) } : {}),
    ...(options.size === undefined ? {} : { size: options.size }),
  });
  target.dispatchEvent(pointer('pointerdown', at(0)));
  for (let i = 1; i <= steps; i++) target.dispatchEvent(pointer('pointermove', at(i / steps)));
  target.dispatchEvent(pointer('pointerup', { ...at(1), pressure: 0 }));
}

describe('ink input on a layer', () => {
  beforeEach(() => {
    rig = setup();
  });
  afterEach(() => {
    rig.detach();
  });

  it('a pen stroke with rising pressure commits rising widths', () => {
    drag(rig.layer, 'pen', 2, [20, 40], [220, 60], {
      steps: 40,
      pressure: (t) => 0.2 + 0.8 * t,
    });
    expect(rig.strokes).toHaveLength(1);
    const [stroke] = rig.strokes;
    expect(stroke?.pointerType).toBe('pen');
    expect(stroke?.widthSource).toBe('pressure');
    expect(stroke?.points).toHaveLength(41);
    const widths = stroke?.widths ?? [];
    expect(widths[0]).toBeCloseTo(widthFromPressure(2, 0.2), 4);
    expect(widths[widths.length - 1]).toBeCloseTo(widthFromPressure(2, 1), 4);
    for (let i = 1; i < widths.length; i++) {
      expect(widths[i]).toBeGreaterThanOrEqual((widths[i - 1] ?? 0) - 1e-6);
    }
    expect(rig.session.penSeen).toBe(true);
    expect(rig.session.pensDown.size).toBe(0);
    expect(rig.session.lastPenUpAt).toBe(rig.clock);
  });

  it('a zoom in the middle of a stroke keeps it straight; it is handed over at the new zoom', async () => {
    // A pen moving along y = 40 (CSS px at zoom 1) from x = 20 to 220; at half way the page
    // zooms to 150 %, so the same page points arrive at 1.5 times the CSS px.
    const pen = (type: string, x: number, zoom: number, pressure = 0.5) =>
      rig.layer.dispatchEvent(
        pointer(type, { x: x * zoom, y: 40 * zoom, id: 4, kind: 'pen', pressure }),
      );
    pen('pointerdown', 20, 1);
    for (let i = 1; i <= 10; i++) pen('pointermove', 20 + i * 10, 1);
    rig.layer.style.width = '1800px';
    rig.layer.style.height = '2400px';
    // The layer's new size arrives through its ResizeObserver, before the next paint.
    await frames(2);
    for (let i = 11; i <= 20; i++) pen('pointermove', 20 + i * 10, 1.5);
    pen('pointerup', 220, 1.5, 0);
    expect(rig.strokes).toHaveLength(1);
    const points = rig.strokes[0]?.points ?? [];
    expect(points).toHaveLength(21);
    points.forEach((p, i) => {
      expect(p.y).toBeCloseTo(60, 3);
      expect(p.x).toBeCloseTo((20 + i * 10) * 1.5, 3);
    });
    // Widths stay in points: the preset's nominal width at the constant 0.5 of a pen.
    for (const w of rig.strokes[0]?.widths ?? []) expect(w).toBeGreaterThan(0.9);
  });

  it('a mouse draws the constant nominal width', () => {
    drag(rig.layer, 'mouse', 1, [20, 40], [300, 40], { steps: 30 });
    expect(rig.strokes).toHaveLength(1);
    expect(rig.strokes[0]?.widthSource).toBe('constant');
    expect(new Set(rig.strokes[0]?.widths)).toEqual(new Set([2]));
    expect(rig.session.penSeen).toBe(false);
  });

  it('a mouse stroke is handed over deduped at 1.5 CSS px, its last point kept', () => {
    rig.layer.dispatchEvent(pointer('pointerdown', { x: 20, y: 40, id: 1, kind: 'mouse' }));
    // Integer jitter: 1 px steps, then a real move.
    for (const x of [21, 22, 23, 24, 25, 26, 40, 41]) {
      rig.layer.dispatchEvent(pointer('pointermove', { x, y: 40, id: 1, kind: 'mouse' }));
    }
    rig.layer.dispatchEvent(pointer('pointerup', { x: 41, y: 40, id: 1, kind: 'mouse' }));
    const xs = rig.strokes[0]?.points.map((p) => p.x) ?? [];
    expect(xs).toEqual([20, 22, 24, 26, 40, 41]);
    for (let i = 1; i + 1 < xs.length; i++) {
      expect((xs[i] ?? 0) - (xs[i - 1] ?? 0)).toBeGreaterThanOrEqual(INK_MOUSE_DEDUPE_CSS_PX);
    }
  });

  it('measures the layer at the press and after a scroll, not on every move', () => {
    const spy = vi.spyOn(rig.layer, 'getBoundingClientRect');
    const at = (x: number) => ({ x, y: 60, id: 3, kind: 'pen' as const, pressure: 0.5 });
    rig.layer.dispatchEvent(pointer('pointerdown', at(20)));
    for (let i = 1; i <= 30; i++) rig.layer.dispatchEvent(pointer('pointermove', at(20 + i * 4)));
    expect(spy).toHaveBeenCalledTimes(1);
    rig.viewport.scrollTop = 40;
    rig.viewport.dispatchEvent(new Event('scroll'));
    for (let i = 31; i <= 40; i++) rig.layer.dispatchEvent(pointer('pointermove', at(20 + i * 4)));
    expect(spy).toHaveBeenCalledTimes(2);
    rig.layer.dispatchEvent(pointer('pointerup', at(180)));
    expect(spy).toHaveBeenCalledTimes(2);
    expect(rig.strokes).toHaveLength(1);
    spy.mockRestore();
  });

  it('after a pen, one finger pans the stage and draws nothing; two reach the pinch zoom', () => {
    drag(rig.layer, 'pen', 2, [20, 40], [120, 40], { pressure: () => 0.7 });
    expect(rig.strokes).toHaveLength(1);
    rig.clock += TOUCH_AFTER_PEN_MS + 50;
    rig.viewport.scrollTo(200, 300);
    drag(rig.layer, 'touch', 11, [200, 250], [150, 100], { size: 12 });
    expect(rig.strokes).toHaveLength(1);
    expect(rig.viewport.scrollLeft).toBe(250);
    expect(rig.viewport.scrollTop).toBe(450);
    // The touches bubble on to the Read view (its pinch zoom counts them).
    expect(rig.bubbled.filter((t) => t === 'touch')).toHaveLength(1);
    // A second finger stops the pan: the pinch zoom has the gesture.
    const a = { x: 100, y: 100, id: 21, kind: 'touch' as const };
    const b = { x: 200, y: 200, id: 22, kind: 'touch' as const };
    rig.layer.dispatchEvent(pointer('pointerdown', a));
    rig.layer.dispatchEvent(pointer('pointerdown', b));
    rig.layer.dispatchEvent(pointer('pointermove', { ...a, y: 50 }));
    expect(rig.viewport.scrollTop).toBe(450);
    rig.layer.dispatchEvent(pointer('pointerup', a));
    rig.layer.dispatchEvent(pointer('pointerup', b));
    expect(rig.strokes).toHaveLength(1);
    expect(rig.bubbled.filter((t) => t === 'touch')).toHaveLength(3);
  });

  it('ignores touch while the pen is down and for 300 ms after it lifts', () => {
    const pen = { x: 40, y: 40, id: 3, kind: 'pen' as const, pressure: 0.6 };
    rig.layer.dispatchEvent(pointer('pointerdown', pen));
    // A palm next to the pen: neither drawn nor passed on to the pinch zoom.
    drag(rig.layer, 'touch', 12, [100, 200], [140, 260], { size: 10 });
    rig.layer.dispatchEvent(pointer('pointermove', { ...pen, x: 90 }));
    rig.layer.dispatchEvent(pointer('pointerup', { ...pen, x: 90 }));
    expect(rig.strokes).toHaveLength(1);
    rig.clock += TOUCH_AFTER_PEN_MS - 10;
    const scrolled = rig.viewport.scrollTop;
    drag(rig.layer, 'touch', 13, [100, 200], [100, 100], { size: 10 });
    expect(rig.viewport.scrollTop).toBe(scrolled);
    expect(rig.strokes).toHaveLength(1);
    expect(rig.bubbled.filter((t) => t === 'touch')).toHaveLength(0);
  });

  it('ignores a large contact (a palm) even before any pen', () => {
    drag(rig.layer, 'touch', 14, [100, 200], [180, 220], { size: PALM_CONTACT_PX + 20 });
    expect(rig.strokes).toHaveLength(0);
    expect(rig.bubbled).toHaveLength(0);
  });

  it('before any pen a finger draws (speed widths); a second finger makes it a pinch', () => {
    drag(rig.layer, 'touch', 15, [30, 30], [200, 90], { size: 10 });
    expect(rig.strokes).toHaveLength(1);
    expect(rig.strokes[0]?.widthSource).toBe('speed');
    for (const w of rig.strokes[0]?.widths ?? []) {
      expect(w).toBeGreaterThanOrEqual(2 * 0.9 - 1e-6);
      expect(w).toBeLessThanOrEqual(2 * 1.1 + 1e-6);
    }
    const a = { x: 50, y: 50, id: 16, kind: 'touch' as const, size: 10 };
    const b = { x: 150, y: 150, id: 17, kind: 'touch' as const, size: 10 };
    rig.layer.dispatchEvent(pointer('pointerdown', a));
    rig.layer.dispatchEvent(pointer('pointermove', { ...a, x: 60 }));
    rig.layer.dispatchEvent(pointer('pointerdown', b));
    rig.layer.dispatchEvent(pointer('pointermove', { ...a, x: 20 }));
    rig.layer.dispatchEvent(pointer('pointerup', a));
    rig.layer.dispatchEvent(pointer('pointerup', b));
    expect(rig.strokes).toHaveLength(1);
  });

  it('a hovering pen counts as seen', () => {
    rig.layer.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, pointerType: 'pen', pointerId: 4 }),
    );
    expect(rig.session.penSeen).toBe(true);
    drag(rig.layer, 'touch', 18, [100, 200], [100, 150], { size: 10 });
    expect(rig.strokes).toHaveLength(0);
  });

  it('a cancelled stroke commits nothing; detaching stops listening', () => {
    const pen = { x: 40, y: 40, id: 5, kind: 'pen' as const, pressure: 0.6 };
    rig.layer.dispatchEvent(pointer('pointerdown', pen));
    rig.layer.dispatchEvent(pointer('pointermove', { ...pen, x: 80 }));
    rig.layer.dispatchEvent(pointer('pointercancel', { ...pen, x: 80 }));
    expect(rig.strokes).toHaveLength(0);
    expect(rig.session.pensDown.size).toBe(0);
    rig.detach();
    drag(rig.layer, 'pen', 6, [20, 40], [120, 40], { pressure: () => 0.7 });
    expect(rig.strokes).toHaveLength(0);
    rig = setup();
  });
});

// ---------------------------------------------------------------------------
// Prediction (craft spec §5.2 item 3)
// ---------------------------------------------------------------------------

describe('prediction', () => {
  /** Samples moving along x at `speed` px/ms, one every 8 ms. */
  const moving = (speed: number, n = 4) =>
    Array.from({ length: n }, (_, i) => ({ x: 100 + i * 8 * speed, y: 50, t: i * 8 }));

  it('extrapolates the last samples one frame ahead, tapered to 0.8 of the width', () => {
    const [tip] = predictTip(moving(0.25), 4);
    const last = 100 + 3 * 8 * 0.25;
    expect(tip?.x).toBeCloseTo(last + 0.25 * PREDICT_HORIZON_MS, 5);
    expect(tip?.y).toBeCloseTo(50, 5);
    expect(tip?.w).toBeCloseTo(4 * PREDICT_TAPER, 5);
  });

  it('reaches at most 12 px, or 4 widths for a wide stroke', () => {
    expect(predictionCap(2)).toBe(PREDICT_MAX_PX);
    expect(predictionCap(10)).toBe(40);
    const fast = moving(3);
    const last = fast[3]?.x ?? 0;
    expect((predictTip(fast, 2)[0]?.x ?? 0) - last).toBeCloseTo(12, 5);
    expect((predictTip(fast, 10)[0]?.x ?? 0) - last).toBeCloseTo(40, 5);
  });

  it('predicts nothing when slow, with too few samples, or without time', () => {
    expect(predictTip(moving(0.04), 4)).toEqual([]);
    expect(predictTip(moving(1, 2), 4)).toEqual([]);
    expect(
      predictTip(
        [
          { x: 0, y: 0, t: 5 },
          { x: 5, y: 0, t: 5 },
          { x: 9, y: 0, t: 5 },
        ],
        4,
      ),
    ).toEqual([]);
  });

  it('shrinks as the pointer decelerates', () => {
    const slowing = [
      { x: 0, y: 0, t: 0 },
      { x: 8, y: 0, t: 8 },
      { x: 16, y: 0, t: 16 },
      { x: 17, y: 0, t: 24 },
    ];
    const [tip] = predictTip(slowing, 4);
    // The newest segment's speed (0.125 px/ms) for 16 ms, along the average direction.
    expect((tip?.x ?? 0) - 17).toBeCloseTo(2, 5);
  });

  it('holds the browser’s predictions to the same horizon and cap, tapered', () => {
    const last = { x: 100, y: 100, t: 50 };
    const out = capPrediction(
      last,
      [
        { x: 104, y: 100, t: 58 },
        { x: 130, y: 100, t: 64 },
        { x: 140, y: 100, t: 80 },
      ],
      2,
    );
    // The third is beyond 16 ms; the second is pulled back to 12 px.
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ x: 104, y: 100 });
    expect(out[1]?.x).toBeCloseTo(112, 5);
    expect(out[1]?.w).toBeCloseTo(2 * PREDICT_TAPER, 5);
    expect(out[0]?.w).toBeGreaterThan(out[1]?.w ?? 0);
  });
});

// ---------------------------------------------------------------------------
// One stroke model: the commit lies on the last preview frame (craft spec §5.2 item 2)
// ---------------------------------------------------------------------------

/** Records what the preview drew (device-independent: CSS px of the page). */
class RecordingPreview extends InkPreview {
  frames: { points: PreviewPoint[]; predicted: readonly PreviewPoint[]; settled: number }[] = [];

  override draw(
    path: PreviewPath,
    predicted: readonly PreviewPoint[] = [],
    restart = false,
    settled = path.length - 2,
  ): void {
    const points = Array.from({ length: path.length }, (_, i) => ({
      x: path.x(i),
      y: path.y(i),
      w: path.w(i),
    }));
    this.frames.push({ points, predicted, settled });
    super.draw(path, predicted, restart, settled);
  }
}

/** The outline's boundary as a polyline (curves flattened). */
function boundary(ops: string): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  const args: number[] = [];
  for (const token of ops.split(/\s+/)) {
    if (token === '') continue;
    if (token === 'm' || token === 'l') out.push({ x: args[0] ?? 0, y: args[1] ?? 0 });
    else if (token === 'c') {
      const p0 = out[out.length - 1] ?? { x: 0, y: 0 };
      const [x1 = 0, y1 = 0, x2 = 0, y2 = 0, x3 = 0, y3 = 0] = args;
      for (let k = 1; k <= 8; k++) {
        const t = k / 8;
        const u = 1 - t;
        out.push({
          x: u * u * u * p0.x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
          y: u * u * u * p0.y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
        });
      }
    } else if (token !== 'h') {
      args.push(Number(token));
      continue;
    }
    args.length = 0;
  }
  return out;
}

function distanceToPolyline(p: { x: number; y: number }, line: { x: number; y: number }[]) {
  let best = Infinity;
  for (let i = 0; i < line.length; i++) {
    const a = line[i] as { x: number; y: number };
    const b = line[(i + 1) % line.length] as { x: number; y: number };
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
    best = Math.min(best, Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy));
  }
  return best;
}

/** The boundary with its straight edges cut into pieces of at most `step` px. */
function densify(line: { x: number; y: number }[], step = 0.25): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < line.length; i++) {
    const a = line[i] as { x: number; y: number };
    const b = line[(i + 1) % line.length] as { x: number; y: number };
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
    for (let k = 0; k < n; k++)
      out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
  }
  return out;
}

/**
 * Hausdorff distance between the two filled shapes (device px): how far a point of one lies
 * outside the other. A point outside a shape is nearest to its true edge, which is part of
 * its boundary polyline (the inner side of a round join runs inside the shape, never
 * nearer), so the distance to the polyline is exact there.
 */
function outlineDistance(a: string, b: string): number {
  const ctx = document.createElement('canvas').getContext('2d') as CanvasRenderingContext2D;
  const one = (from: string, to: string) => {
    const shape = outlinePath(to);
    const edge = boundary(to);
    let worst = 0;
    for (const p of densify(boundary(from))) {
      if (ctx.isPointInPath(shape, p.x, p.y, 'nonzero')) continue;
      worst = Math.max(worst, distanceToPolyline(p, edge));
    }
    return worst;
  };
  return Math.max(one(a, b), one(b, a));
}

/**
 * A recorded mouse stroke: handwriting ("lle") at 125 Hz, integer pixel positions, slowing
 * at the tops of the loops (as recorded in the 2026-10 audit's slow-handwriting run).
 */
function recordedMouseStroke(): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i <= 150; i++) {
    const t = i / 150;
    const s = t + 0.04 * Math.sin(t * Math.PI * 6);
    const x = 40 + 260 * s + 18 * Math.sin(s * Math.PI * 6);
    const y = 140 - 50 * Math.abs(Math.sin(s * Math.PI * 3)) + 6 * Math.cos(s * Math.PI * 6);
    out.push({ x: Math.round(x), y: Math.round(y) });
  }
  return out;
}

describe('one stroke model', () => {
  let host: HTMLDivElement;
  let layer: HTMLDivElement;
  let preview: RecordingPreview;
  let detach: () => void;
  let strokes: InkStrokeInput[];
  let context: InkInputContext;

  beforeEach(() => {
    layer = document.createElement('div');
    Object.assign(layer.style, {
      position: 'fixed',
      left: '0px',
      top: '0px',
      width: '400px',
      height: '300px',
    });
    host = document.createElement('div');
    Object.assign(host.style, { position: 'absolute', inset: '0px' });
    layer.appendChild(host);
    document.body.appendChild(layer);
    preview = new RecordingPreview(host);
    strokes = [];
    // 100 % zoom: 4/3 CSS px per point.
    context = { width: 1.5, color: '#1a1a1a', opacity: 1, scale: 4 / 3 };
    detach = attachInkInput({
      element: layer,
      preview,
      session: createPenSession(),
      context: () => context,
      onStroke: (stroke, settle) => {
        strokes.push(stroke);
        settle()();
      },
    });
  });

  afterEach(() => {
    detach();
    preview.destroy();
    layer.remove();
  });

  it('smooths the stable part, draws the raw tip, and never commits the prediction', async () => {
    const points = recordedMouseStroke();
    const send = (type: string, p: { x: number; y: number }) =>
      layer.dispatchEvent(pointer(type, { ...p, id: 1, kind: 'mouse' }));
    send('pointerdown', points[0] as { x: number; y: number });
    for (const [i, p] of points.slice(1, 60).entries()) {
      send('pointermove', p);
      if (i % 6 === 5) await frames(1);
    }
    await frames(1);
    const frame = preview.frames.at(-1);
    expect(frame).toBeDefined();
    // Smoothed: 4 points per kept segment, many more than the samples before the tip.
    expect(frame?.settled ?? 0).toBeGreaterThan(100);
    // The tip ends at the newest sample (raw), and a prediction goes past it.
    const last = points[59] as { x: number; y: number };
    expect(frame?.points.at(-1)).toMatchObject({ x: last.x, y: last.y });
    const predicted = preview.frames.flatMap((f) => f.predicted);
    expect(predicted.length).toBeGreaterThan(0);
    send('pointerup', last);
    const committed = strokes[0]?.points ?? [];
    for (const q of predicted) {
      expect(committed.some((p) => p.x === q.x && p.y === q.y)).toBe(false);
    }
    expect(committed.at(-1)).toEqual({ x: last.x, y: last.y });
  });

  it('the committed outline lies within 0.5 device px of the last preview frame (no snap)', () => {
    const points = recordedMouseStroke();
    const send = (type: string, p: { x: number; y: number }) =>
      layer.dispatchEvent(pointer(type, { ...p, id: 1, kind: 'mouse' }));
    send('pointerdown', points[0] as { x: number; y: number });
    for (const p of points.slice(1)) send('pointermove', p);
    send('pointerup', points.at(-1) as { x: number; y: number });
    const stroke = strokes[0];
    expect(stroke).toBeDefined();
    const last = preview.frames.at(-1);
    if (!stroke || !last) return;
    // The release frame is the whole stroke, final (nothing left in the tip).
    expect(last.settled).toBe(last.points.length);
    expect(last.predicted).toEqual([]);

    // The commit as AnnotationLayer's `inkCommit` makes it: user space (pt), finishInkStroke.
    const scale = context.scale;
    const done = finishInkStroke(
      stroke.points.map((p, i) => ({ x: p.x / scale, y: p.y / scale, w: stroke.widths[i] ?? 0 })),
    );
    const dpr = window.devicePixelRatio || 1;
    const device = scale * dpr;
    const committedCentre = done.points.map((p) => ({ x: p.x * device, y: p.y * device }));
    const previewCentre = last.points.map((p) => ({ x: p.x * dpr, y: p.y * dpr }));
    const committed = inkOutlineOps(
      committedCentre,
      done.widths.map((w) => w * device),
    );
    const previewed = inkOutlineOps(
      previewCentre,
      last.points.map((p) => p.w * dpr),
    );
    expect(done.points.length).toBeLessThan(last.points.length / 2);
    expect(outlineDistance(committed, previewed)).toBeLessThan(0.5);
  });
});

// ---------------------------------------------------------------------------
// The pen cursor (craft spec §5.2 item 5)
// ---------------------------------------------------------------------------

describe('pen cursor', () => {
  const svgOf = (cursor: string) => {
    const m = /^url\("data:image\/svg\+xml,(.*)"\) (\d+) (\d+), crosshair$/.exec(cursor);
    expect(m).not.toBeNull();
    return { svg: decodeURIComponent(m?.[1] ?? ''), x: Number(m?.[2]), y: Number(m?.[3]) };
  };

  it('is a dot of the colour and on-screen width, a 1 px ring, the hot spot centred', () => {
    const { svg, x, y } = svgOf(penCursor('#1E5BD8', 1, 8));
    expect(svg).toContain('width="10"');
    expect(svg).toContain('r="4" fill="#1E5BD8"');
    expect(svg).toContain('r="4.5" fill="none" stroke="rgba(255,255,255,0.9)"');
    expect([x, y]).toEqual([5, 5]);
    // A light ink gets a dark ring.
    expect(svgOf(penCursor('#FFEA00', 1, 8)).svg).toContain('stroke="rgba(0,0,0,0.7)"');
  });

  it('clamps the dot to 3–32 px', () => {
    expect(svgOf(penCursor('#000000', 1, 0.5)).svg).toContain('r="1.5"');
    const big = svgOf(penCursor('#000000', 1, 90));
    expect(big.svg).toContain('r="16"');
    expect(big.svg).toContain('width="34"');
    expect([big.x, big.y]).toEqual([17, 17]);
  });

  it('the armed layer carries it and follows preset and zoom changes; detaching removes it', () => {
    const layer = document.createElement('div');
    Object.assign(layer.style, { position: 'fixed', width: '200px', height: '200px' });
    document.body.appendChild(layer);
    const preview = new InkPreview(layer);
    let context: InkInputContext = { width: 2, color: '#1a1a1a', opacity: 1, scale: 1.5 };
    const detach = attachInkInput({
      element: layer,
      preview,
      session: createPenSession(),
      context: () => context,
      onStroke: (_stroke, settle) => settle()(),
    });
    const cursor = () => layer.style.getPropertyValue(PEN_CURSOR_PROPERTY);
    expect(cursor()).toBe(penCursor('#1a1a1a', 1, 3));
    context = { ...context, color: '#e0301e', scale: 3 };
    layer.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }));
    expect(cursor()).toBe(penCursor('#e0301e', 1, 6));
    detach();
    preview.destroy();
    expect(cursor()).toBe('');
    layer.remove();
  });
});
