/**
 * The pen's input pipeline (experience-redesign spec §6.6), in a real browser: pointer
 * roles and palm rejection, the pressure and speed width mappings, and the native handlers
 * on a layer with synthetic pointer events (pen with pressure, touch pan after a pen,
 * touch ignored next to a pen, palms, fingers before any pen).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  attachInkInput,
  createPenSession,
  InkSamples,
  type InkStrokeInput,
  PALM_CONTACT_PX,
  type PenSession,
  pointerRole,
  SPEED_PRESSURE_STILL,
  speedPressure,
  StrokeWidths,
  TOUCH_AFTER_PEN_MS,
  widthFromPressure,
} from './ink-input';
import { InkPreview } from './ink-preview';

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

  it('a zoom in the middle of a stroke keeps it straight; it is handed over at the new zoom', () => {
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

  it('a mouse draws with speed-derived widths', () => {
    drag(rig.layer, 'mouse', 1, [20, 40], [300, 40], { steps: 30 });
    expect(rig.strokes).toHaveLength(1);
    expect(rig.strokes[0]?.widthSource).toBe('speed');
    expect(rig.session.penSeen).toBe(false);
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
