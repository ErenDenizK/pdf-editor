/**
 * Straight pen lines (craft spec §5.6): the hold rule (timing threshold, tolerance, a press
 * held before moving), and on a layer with synthetic pointer events: a hold straightens the
 * stroke to the pointer and the line stays straight until release, handed over (and
 * committed) as two points; the 1 px cue, none under reduced motion; Shift snaps the line to
 * 45° steps in the preview, and a Shift line with the Highlighter along text becomes a
 * Highlight by the usual rule.
 */
import type { Rect } from '@pdf-editor/document-model';
import type { Glyph, TextRun } from '@pdf-editor/engine';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PageFrame } from '../geometry';
import { finishInkStroke } from '../ink';
import { highlighterPath, snapHighlighter } from './highlighter';
import { attachInkInput, createPenSession, type InkStrokeInput } from './ink-input';
import { InkPreview, type PreviewPath, type PreviewPoint } from './ink-preview';
import {
  HOLD_STRAIGHTEN_MS,
  HOLD_STRAIGHTEN_PX,
  HoldStill,
  STRAIGHTEN_CUE_MS,
  STRAIGHTEN_CUE_PX,
  straightEnd,
} from './straighten';

describe('the hold rule', () => {
  it('is due 500 ms after the pointer last left its 3 px circle', () => {
    const hold = new HoldStill();
    expect(HOLD_STRAIGHTEN_MS).toBe(500);
    expect(HOLD_STRAIGHTEN_PX).toBe(3);
    hold.begin(0, 0, 1000);
    // Nothing drawn yet: a press held still is not a stroke to straighten.
    expect(hold.remaining(5000)).toBe(Number.POSITIVE_INFINITY);
    hold.add(20, 0, 1100);
    expect(hold.remaining(1100)).toBe(500);
    expect(hold.remaining(1599)).toBe(1);
    expect(hold.remaining(1600)).toBe(0);
  });

  it('moves within the tolerance keep the hold; one beyond restarts it', () => {
    const hold = new HoldStill();
    hold.begin(0, 0, 0);
    hold.add(30, 0, 100);
    hold.add(32, 1, 200);
    hold.add(29, -2, 300);
    hold.add(30 + HOLD_STRAIGHTEN_PX, 0, 400);
    expect(hold.remaining(600)).toBe(0);
    hold.add(34, 0, 650);
    expect(hold.remaining(650)).toBe(500);
  });

  it('Shift snaps the end to 45° steps; a hold keeps it as it is', () => {
    const start = { x: 0, y: 0 };
    const end = straightEnd(start, { x: 100, y: 8 }, true);
    expect(end.x).toBeCloseTo(Math.hypot(100, 8), 6);
    expect(end.y).toBeCloseTo(0, 6);
    const diagonal = straightEnd(start, { x: 50, y: 46 }, true);
    expect(diagonal.x).toBeCloseTo(diagonal.y, 6);
    expect(straightEnd(start, { x: 100, y: 8 }, false)).toEqual({ x: 100, y: 8 });
  });
});

// ---------------------------------------------------------------------------
// On a layer
// ---------------------------------------------------------------------------

/** A preview that records what each frame drew. */
class RecordingPreview extends InkPreview {
  readonly frames: { points: PreviewPoint[]; predicted: number }[] = [];

  override draw(
    path: PreviewPath,
    predicted: readonly PreviewPoint[] = [],
    restart = false,
    settled = path.length - 2,
  ): void {
    const points: PreviewPoint[] = [];
    for (let i = 0; i < path.length; i++) points.push({ x: path.x(i), y: path.y(i), w: path.w(i) });
    this.frames.push({ points, predicted: predicted.length });
    super.draw(path, predicted, restart, settled);
  }
}

interface Rig {
  readonly layer: HTMLDivElement;
  readonly preview: RecordingPreview;
  readonly strokes: InkStrokeInput[];
  detach(): void;
}

let rig: Rig;

function setup(): Rig {
  const layer = document.createElement('div');
  Object.assign(layer.style, {
    position: 'fixed',
    left: '0px',
    top: '0px',
    width: '600px',
    height: '400px',
  });
  const host = document.createElement('div');
  Object.assign(host.style, { position: 'absolute', inset: '0px' });
  layer.appendChild(host);
  document.body.appendChild(layer);
  const preview = new RecordingPreview(host);
  const strokes: InkStrokeInput[] = [];
  const detach = attachInkInput({
    element: layer,
    preview,
    session: createPenSession(),
    context: () => ({ width: 2, color: '#1e88e5', opacity: 1, scale: 1 }),
    onStroke: (stroke, settle) => {
      strokes.push(stroke);
      settle()();
    },
  });
  return {
    layer,
    preview,
    strokes,
    detach: () => {
      detach();
      preview.destroy();
      layer.remove();
    },
  };
}

function pointer(type: string, x: number, y: number, shiftKey = false): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    pointerId: 3,
    pointerType: 'mouse',
    isPrimary: true,
    button: type === 'pointermove' ? -1 : 0,
    buttons: type === 'pointerup' ? 0 : 1,
    shiftKey,
  });
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));

/** Down at (20, 50), a wavy stroke to (200, 80). */
function scribble(): void {
  rig.layer.dispatchEvent(pointer('pointerdown', 20, 50));
  for (let i = 1; i <= 18; i++) {
    window.dispatchEvent(pointer('pointermove', 20 + i * 10, 50 + (i * 30) / 18 + (i % 2) * 6));
  }
}

describe('hold to straighten on a layer', () => {
  beforeEach(() => {
    rig = setup();
  });
  afterEach(() => {
    rig.detach();
    vi.restoreAllMocks();
  });

  it('a hold straightens the stroke; the line follows the pointer until release', async () => {
    scribble();
    // Still, with jitter inside the tolerance.
    for (let i = 0; i < 6; i++) {
      await wait(100);
      window.dispatchEvent(pointer('pointermove', 200 + (i % 2) * 2, 80 - (i % 2)));
    }
    await wait(80);
    await frame();
    let last = rig.preview.frames.at(-1);
    expect(last?.points).toHaveLength(2);
    expect(last?.points[0]).toMatchObject({ x: 20, y: 50 });
    expect(last?.predicted).toBe(0);
    // The line stays straight while the pointer wanders on, and ends where it is let go.
    window.dispatchEvent(pointer('pointermove', 260, 140));
    window.dispatchEvent(pointer('pointermove', 300, 90));
    await frame();
    last = rig.preview.frames.at(-1);
    expect(last?.points).toHaveLength(2);
    expect(last?.points[1]).toMatchObject({ x: 300, y: 90 });
    window.dispatchEvent(pointer('pointerup', 310, 100));
    const [stroke] = rig.strokes;
    expect(stroke?.points).toEqual([
      { x: 20, y: 50 },
      { x: 310, y: 100 },
    ]);
    expect(stroke?.widths).toEqual([2, 2]);
    expect(stroke?.straight).toBe(false);
    // The commit keeps two points (a straight line is all the smoothing leaves).
    const committed = finishInkStroke(
      (stroke?.points ?? []).map((p, i) => ({ ...p, w: stroke?.widths[i] ?? 2 })),
    );
    expect(committed.points).toEqual([
      { x: 20, y: 50 },
      { x: 310, y: 100 },
    ]);
  });

  it('under 500 ms, or moving beyond 3 px, the stroke stays free', async () => {
    scribble();
    await wait(HOLD_STRAIGHTEN_MS - 150);
    // Every 150 ms the pointer moves 5 px on: never still for 500 ms.
    for (let i = 1; i <= 5; i++) {
      window.dispatchEvent(pointer('pointermove', 200 + i * 5, 80));
      await wait(150);
    }
    await frame();
    expect(rig.preview.frames.at(-1)?.points.length).toBeGreaterThan(2);
    window.dispatchEvent(pointer('pointerup', 225, 80));
    expect(rig.strokes[0]?.points.length).toBeGreaterThan(2);
  });

  it('the snapped line is 1 px thicker for 120 ms', async () => {
    scribble();
    await wait(HOLD_STRAIGHTEN_MS + 30);
    await frame();
    const cue = rig.preview.frames.at(-1);
    expect(cue?.points).toHaveLength(2);
    expect(cue?.points[0]?.w).toBeCloseTo(2 + STRAIGHTEN_CUE_PX, 6);
    await wait(STRAIGHTEN_CUE_MS + 40);
    await frame();
    expect(rig.preview.frames.at(-1)?.points[0]?.w).toBeCloseTo(2, 6);
    window.dispatchEvent(pointer('pointerup', 200, 80));
  });

  it('no cue under reduced motion', async () => {
    const matchMedia = window.matchMedia.bind(window);
    vi.spyOn(window, 'matchMedia').mockImplementation((query: string) =>
      query.includes('prefers-reduced-motion')
        ? ({ matches: true, media: query } as MediaQueryList)
        : matchMedia(query),
    );
    scribble();
    await wait(HOLD_STRAIGHTEN_MS + 30);
    await frame();
    const line = rig.preview.frames.at(-1);
    expect(line?.points).toHaveLength(2);
    expect(line?.points[0]?.w).toBeCloseTo(2, 6);
    window.dispatchEvent(pointer('pointerup', 200, 80));
  });
});

describe('Shift', () => {
  beforeEach(() => {
    rig = setup();
  });
  afterEach(() => {
    rig.detach();
  });

  it('the preview snaps to 45° steps, as the commit does', async () => {
    rig.layer.dispatchEvent(pointer('pointerdown', 20, 50, true));
    for (let i = 1; i <= 10; i++) {
      window.dispatchEvent(pointer('pointermove', 20 + i * 20, 50 + i * 1.2, true));
    }
    await frame();
    const line = rig.preview.frames.at(-1);
    expect(line?.points).toHaveLength(2);
    expect(line?.points[1]?.y).toBeCloseTo(50, 6);
    window.dispatchEvent(pointer('pointerup', 220, 62, true));
    const [stroke] = rig.strokes;
    expect(stroke?.straight).toBe(true);
    expect(stroke?.points).toHaveLength(2);
    expect(stroke?.points[1]?.y).toBeCloseTo(50, 6);
  });
});

// ---------------------------------------------------------------------------
// The Highlighter
// ---------------------------------------------------------------------------

/** One line of text: glyphs 6 × 10 pt from x = 72, bottom at y = 700. */
function textRun(): TextRun {
  const glyphs: Glyph[] = [];
  for (let i = 0; i < 40; i++) {
    const rect: Rect = { x: 72 + i * 6, y: 700, width: 6, height: 10 };
    glyphs.push({ text: 'a', rect, fontSize: 12 });
  }
  return {
    text: 'a'.repeat(40),
    rect: { x: 72, y: 700, width: 240, height: 10 },
    glyphs,
  };
}

describe('Shift with the Highlighter', () => {
  it('a slanted Shift stroke along a line snaps level and becomes a Highlight', () => {
    // An identity-like frame: CSS px = pt, y down from the top of a 792 pt page.
    const frame: PageFrame = {
      size: { width: 612, height: 792 },
      originX: 0,
      originY: 0,
      rotation: 0,
      scale: 1,
    };
    // From the line's centre (y = 705 pt, 87 CSS px from the top), slanting 13° down: free
    // ink as drawn, a level line along the text with Shift.
    const slanted: InkStrokeInput = {
      points: [
        { x: 80, y: 87 },
        { x: 300, y: 140 },
      ],
      widths: [12, 12],
      pointerType: 'mouse',
      widthSource: 'constant',
      straight: false,
    };
    const free = highlighterPath(slanted, frame, 12);
    expect(snapHighlighter([textRun()], free, 12, { alt: false }).kind).toBe('ink');
    const level = highlighterPath({ ...slanted, straight: true }, frame, 12);
    expect(level).toHaveLength(2);
    expect(level[1]?.y).toBeCloseTo(level[0]?.y ?? 0, 6);
    expect(snapHighlighter([textRun()], level, 12, { alt: false }).kind).toBe('highlight');
  });
});
