/**
 * The paragraph editor's canvas (craft spec §4.7): affine helpers, glyph outlines scaled by
 * the font size and the span's matrix, the per-font glyph cache, and the scene built from a
 * layout (plates only where lines change, glyphs of rewritten lines, caret, substitutes).
 */
import type { GlyphOutlineSegment, ParagraphStyleInfo } from '@pdf-editor/engine';
import { decideOverflow, layoutParagraph } from '@pdf-editor/engine';
import { describe, expect, it } from 'vitest';

import type { PageFrame } from '../viewer/geometry';
import {
  apply,
  buildScene,
  compose,
  cssColor,
  cssFromUser,
  type DrawContext,
  drawGlyph,
  drawScene,
  type DrawStyle,
  drawStylesOf,
  GlyphCache,
  glyphToUser,
  invert,
  pathFromSegments,
  userFromText,
} from './glyph-canvas';
import { ADVANCE, FONT, LEADING, LEFT, paragraph, SIZE, TOP } from './paragraph-fixtures';
import {
  caretLines,
  initialState,
  insertText,
  type LayoutFunctions,
  relayout,
} from './paragraph-model';

const fns: LayoutFunctions = { layoutParagraph, decideOverflow };

const SQUARE: GlyphOutlineSegment[] = [
  { kind: 'move', x: 0, y: 0, close: false },
  { kind: 'line', x: 1, y: 0, close: false },
  { kind: 'line', x: 1, y: 1, close: false },
  { kind: 'line', x: 0, y: 1, close: true },
];

const FRAME: PageFrame = {
  size: { width: 612, height: 792 },
  originX: 0,
  originY: 0,
  rotation: 0,
  scale: 2,
};

const STYLE: DrawStyle = {
  fontId: 0,
  fontSize: SIZE,
  matrix: [1, 0, 0, 1, 0, 0],
  fill: '#000000',
  family: 'serif',
  bold: false,
  italic: false,
};

/** Records what the drawing does (a 2D context stand-in). */
function recorder() {
  const calls: { name: string; args: unknown[] }[] = [];
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push({ name, args });
    };
  const ctx: DrawContext = {
    setTransform: record('setTransform'),
    clearRect: record('clearRect'),
    fillRect: record('fillRect'),
    fill: record('fill'),
    fillText: record('fillText'),
    beginPath: record('beginPath'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    closePath: record('closePath'),
    stroke: record('stroke'),
    save: record('save'),
    restore: record('restore'),
    clip: record('clip'),
    rect: record('rect'),
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
  };
  return { ctx, calls };
}

describe('affine helpers', () => {
  it('composes, inverts and maps user space to CSS pixels on the page', () => {
    const m = compose([2, 0, 0, 2, 0, 0], [1, 0, 0, 1, 10, 5]);
    expect(apply(m, { x: 1, y: 1 })).toEqual({ x: 12, y: 7 });
    const back = apply(invert(m), { x: 12, y: 7 });
    expect(back.x).toBeCloseTo(1);
    expect(back.y).toBeCloseTo(1);
    const css = cssFromUser(FRAME);
    expect(apply(css, { x: 0, y: 792 })).toEqual({ x: 0, y: 0 });
    expect(apply(css, { x: 100, y: 692 })).toEqual({ x: 200, y: 200 });
    // Text space of a 90° writing direction: along the line is up the page.
    const rotated = userFromText({ x: 0, y: 1 });
    expect(apply(rotated, { x: 10, y: 0 })).toEqual({ x: 0, y: 10 });
  });

  it('scales a glyph outline by the font size and the span matrix', () => {
    const plain = glyphToUser(10, [1, 0, 0, 1, 0, 0], { x: 100, y: 200 });
    expect(apply(plain, { x: 1, y: 0 })).toEqual({ x: 110, y: 200 });
    const big = glyphToUser(20, [1, 0, 0, 1, 0, 0], { x: 100, y: 200 });
    expect(apply(big, { x: 0.5, y: 0.5 })).toEqual({ x: 110, y: 210 });
    // The matrix's scale and shear apply; its translation does not (the origin does).
    const matrix = glyphToUser(10, [2, 0, 0.5, 2, 999, 999], { x: 0, y: 0 });
    expect(apply(matrix, { x: 1, y: 1 })).toEqual({ x: 25, y: 20 });
  });
});

describe('glyph cache', () => {
  it('builds a path once per font and character, and keeps misses apart', () => {
    const cache = new GlyphCache();
    expect(cache.get(0, 'a')).toBeUndefined();
    cache.put(0, 'a', SQUARE);
    cache.put(0, ' ', null);
    expect(cache.missing(0, ['a', ' ', 'b'])).toEqual(['b']);
    const first = cache.get(0, 'a');
    expect(first).toBeInstanceOf(Path2D);
    expect(cache.get(0, 'a')).toBe(first);
    expect(cache.get(0, ' ')).toBeNull();
    expect(cache.builds).toBe(1);
    // Another font id is another glyph.
    expect(cache.get(1, 'a')).toBeUndefined();
    // Asked for: not missing, still drawn as text (undefined) until it arrives.
    cache.request(1, ['a']);
    expect(cache.missing(1, ['a'])).toEqual([]);
    expect(cache.get(1, 'a')).toBeUndefined();
    cache.release(1, ['a']);
    expect(cache.missing(1, ['a'])).toEqual(['a']);
  });

  it('turns segments into a fillable path (lines and three-segment curves)', () => {
    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    expect(ctx.isPointInPath(pathFromSegments(SQUARE), 0.5, 0.5)).toBe(true);
    const curve = pathFromSegments([
      { kind: 'move', x: 0, y: 0, close: false },
      { kind: 'bezier', x: 0, y: 1, close: false },
      { kind: 'bezier', x: 1, y: 1, close: false },
      { kind: 'bezier', x: 1, y: 0, close: true },
    ]);
    expect(ctx.isPointInPath(curve, 0.5, 0.5)).toBe(true);
    expect(ctx.isPointInPath(curve, 0.5, 0.95)).toBe(false);
  });

  it('draws a cached glyph at the composed transform, again without rebuilding it', () => {
    const cache = new GlyphCache();
    cache.put(0, 'H', SQUARE);
    const { ctx, calls } = recorder();
    const userToDevice = cssFromUser(FRAME);
    const glyph = { ch: 'H', x: 100, y: 700, style: STYLE };
    drawGlyph(ctx, cache, glyph, userFromText({ x: 1, y: 0 }), userToDevice);
    drawGlyph(
      ctx,
      cache,
      { ...glyph, style: { ...STYLE, fontSize: 20 } },
      userFromText({ x: 1, y: 0 }),
      userToDevice,
    );
    const transforms = calls.filter((c) => c.name === 'setTransform').map((c) => c.args);
    // 10 pt at 2 CSS px per point: 20 px per em, y flipped, origin at (200, 184).
    expect(transforms[0]).toEqual([20, 0, 0, -20, 200, 184]);
    expect(transforms[1]).toEqual([40, 0, 0, -40, 200, 184]);
    expect(calls.filter((c) => c.name === 'fill')).toHaveLength(2);
    expect(cache.builds).toBe(1);
  });

  it('draws substitutes and glyphs not loaded yet as text in the style’s family', () => {
    const cache = new GlyphCache();
    const { ctx, calls } = recorder();
    drawGlyph(
      ctx,
      cache,
      { ch: 'ğ', x: 0, y: 0, style: { ...STYLE, substituteScale: 0.5 }, substitute: true },
      userFromText({ x: 1, y: 0 }),
      [1, 0, 0, 1, 0, 0],
    );
    expect(calls.find((c) => c.name === 'fillText')?.args.slice(0, 1)).toEqual(['ğ']);
    expect(ctx.font).toContain('serif');
    const t = calls.find((c) => c.name === 'setTransform')?.args;
    expect(t?.[0]).toBeCloseTo((10 * 0.5) / 100);
  });
});

describe('scene', () => {
  const LINES = ['The quick brown fox', 'jumps over the lazy', 'dog and runs away.'];

  function sceneFor(
    text: (s: ReturnType<typeof initialState>) => ReturnType<typeof initialState>,
    focused = true,
  ) {
    const setup = paragraph(LINES, { width: 20 * ADVANCE });
    const state = text(initialState(setup.input, 0));
    const result = relayout(fns, setup, state);
    const lines = caretLines(setup, state, result.layout);
    return {
      setup,
      result,
      scene: buildScene({ setup, state, relayout: result, lines, styles: { s0: STYLE }, focused }),
    };
  }

  it('draws only the rewritten line, over a plate that leaves the other lines to the page', () => {
    const { scene } = sceneFor((s) => insertText({ ...s, anchor: 30, focus: 30 }, 'x'));
    const baselines = new Set(scene.glyphs.map((g) => g.y));
    expect([...baselines]).toEqual([TOP - LEADING]);
    expect(scene.glyphs.map((g) => g.ch).join('')).toBe('jumpsoverxthelazy');
    // One plate over the old line, one under the new one: none over lines 1 and 3.
    for (const plate of scene.plates) {
      expect(plate.y1).toBeLessThanOrEqual(TOP - 0.3 * SIZE + 1e-9);
      expect(plate.y0).toBeGreaterThanOrEqual(TOP - 2 * LEADING + SIZE - 1e-9);
    }
    expect(scene.caret?.x).toBe(LEFT + 11 * ADVANCE);
  });

  it('draws nothing and no plate for an unchanged paragraph; the caret only when focused', () => {
    const { scene } = sceneFor((s) => s);
    expect(scene.glyphs).toEqual([]);
    expect(scene.plates).toEqual([]);
    expect(scene.caret).toBeDefined();
    expect(sceneFor((s) => s, false).scene.caret).toBeUndefined();
  });

  it('marks characters the font lacks as substitutes', () => {
    const { scene } = sceneFor((s) => insertText({ ...s, anchor: 4, focus: 4 }, 'ğ'));
    // The fixture style has no substitute: an unknown character is unsupported, not substituted.
    expect(scene.glyphs.find((g) => g.ch === 'ğ')?.substitute).toBeUndefined();
    const setup = paragraph(LINES, { width: 20 * ADVANCE });
    const withSub = {
      ...setup,
      input: {
        ...setup.input,
        styles: {
          s0: {
            ...(setup.input.styles.s0 ?? { advances: {}, wordGap: ADVANCE }),
            substitute: { font: 'NotoSerif-Regular', advances: { ğ: ADVANCE } },
          },
        },
      },
    };
    const state = insertText(initialState(withSub.input, 4), 'ğ');
    const r = relayout(fns, withSub, state);
    const lines = caretLines(withSub, state, r.layout);
    const s = buildScene({
      setup: withSub,
      state,
      relayout: r,
      lines,
      styles: { s0: STYLE },
      focused: true,
    });
    expect(r.layout.substituted).toEqual([{ char: 'ğ', font: 'NotoSerif-Regular' }]);
    expect(s.glyphs.find((g) => g.ch === 'ğ')?.substitute).toBe(true);
  });

  it('draws a scene: plates, glyphs, then the caret', () => {
    const { scene } = sceneFor((s) => insertText({ ...s, anchor: 30, focus: 30 }, 'x'));
    const cache = new GlyphCache();
    for (const ch of 'jumpsoverxthelazy') cache.put(0, ch, SQUARE);
    const { ctx, calls } = recorder();
    drawScene(
      ctx,
      { width: 100, height: 100 },
      scene,
      cache,
      userFromText({ x: 1, y: 0 }),
      cssFromUser(FRAME),
      {
        colors: { plate: '#fff', selection: 'blue', caret: 'red', overlap: 'pink' },
        dpr: 2,
      },
    );
    const names = calls.map((c) => c.name);
    expect(names[0]).toBe('setTransform');
    expect(names).toContain('clearRect');
    expect(calls.filter((c) => c.name === 'fill').length).toBe(1 + 17);
    expect(names[names.length - 1]).toBe('stroke');
    expect(ctx.lineWidth).toBe(3);
  });
});

describe('scene over the settled preview', () => {
  it('draws plates only around the preview and no glyphs; caret on top', () => {
    const setup = paragraph(['The quick brown fox', 'jumps over the lazy'], {
      width: 20 * ADVANCE,
    });
    const state = insertText(initialState(setup.input, 30), 'x');
    const result = relayout(fns, setup, state);
    const lines = caretLines(setup, state, result.layout);
    const scene = buildScene({
      setup,
      state,
      relayout: result,
      lines,
      styles: { s0: STYLE },
      focused: true,
    });
    const { ctx, calls } = recorder();
    drawScene(
      ctx,
      { width: 100, height: 100 },
      scene,
      new GlyphCache(),
      userFromText({ x: 1, y: 0 }),
      cssFromUser(FRAME),
      {
        colors: { plate: '#fff', selection: 'blue', caret: 'red', overlap: 'pink' },
        dpr: 1,
        preview: { x: 72, y: 680, width: 120, height: 30 },
      },
    );
    const names = calls.map((c) => c.name);
    expect(names).toContain('clip');
    expect(calls.find((c) => c.name === 'clip')?.args).toEqual(['evenodd']);
    // The plates' one fill, inside save/restore; no glyph is drawn.
    expect(calls.filter((c) => c.name === 'fill')).toHaveLength(1);
    expect(names.indexOf('restore')).toBeGreaterThan(names.indexOf('fill'));
    expect(names[names.length - 1]).toBe('stroke');
  });
});

describe('draw styles', () => {
  it('take the engine’s style facts: font id, size, matrix, colour and the substitute', () => {
    const info: ParagraphStyleInfo = {
      fontId: 3,
      font: { ...FONT, monospace: false, serif: true, bold: true },
      fontSize: 11,
      size: 11,
      matrix: [1, 0, 0, 1, 0, 0],
      fill: [255, 0, 0, 255],
      renderMode: 0,
      substitute: { face: 'NotoSerif-Bold', family: 'Noto Serif', scale: 0.98 },
    };
    const styles = drawStylesOf({ s1: info });
    expect(styles.s1).toMatchObject({
      fontId: 3,
      fontSize: 11,
      fill: 'rgba(255, 0, 0, 1)',
      family: '"Noto Serif", serif',
      substituteScale: 0.98,
      bold: true,
    });
    expect(cssColor(undefined)).toBe('#000000');
  });
});
