/**
 * The paragraph editor's canvas (craft spec §4.7, ADR-0020 §7, research 11 §6): rewritten
 * lines drawn from the PDF font's own glyph outlines (`FPDFFont_GetGlyphPath`, em units)
 * on the real baselines, scaled by the span's size and matrix, in the span's colour, over a
 * plate that hides the old glyphs (page white: decision §13 #8's fallback, the engine has no
 * cheap "page without this paragraph" render). Lines before the edit are not drawn: the page
 * shows through. Caret, selection, composition underline and the overlap warning are drawn
 * here too.
 *
 * Coordinates: the scene is in the paragraph's text space (`ParagraphBlock` convention:
 * x along the line, y up); `userFromText` turns it into user space and `deviceFromUser`
 * (the page frame, the canvas offset and the device pixel ratio) into canvas pixels.
 * Affine matrices use the canvas / PDF convention `[a, b, c, d, e, f]`:
 * x' = a·x + c·y + e, y' = b·x + d·y + f.
 */
import type {
  GlyphOutlineSegment,
  ParagraphStyleInfo,
  TextMatrix,
  TextRunFont,
} from '@pdf-editor/engine';

import { type PageFrame, userPointToCss } from '../viewer/geometry';
import {
  type CaretLine,
  caretAt,
  type ParagraphRelayout,
  type ParagraphSetup,
  type ParagraphState,
  selectionOf,
  selectionRects,
  type TextRange,
} from './paragraph-model';

export type Affine = readonly [number, number, number, number, number, number];

export const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];

/** `first`, then `then`. */
export function compose(first: Affine, then: Affine): Affine {
  return [
    then[0] * first[0] + then[2] * first[1],
    then[1] * first[0] + then[3] * first[1],
    then[0] * first[2] + then[2] * first[3],
    then[1] * first[2] + then[3] * first[3],
    then[0] * first[4] + then[2] * first[5] + then[4],
    then[1] * first[4] + then[3] * first[5] + then[5],
  ];
}

export function apply(m: Affine, p: { readonly x: number; readonly y: number }) {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

export function invert(m: Affine): Affine {
  const det = m[0] * m[3] - m[1] * m[2] || 1;
  const a = m[3] / det;
  const b = -m[1] / det;
  const c = -m[2] / det;
  const d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

export function translate(x: number, y: number): Affine {
  return [1, 0, 0, 1, x, y];
}

export function scale(sx: number, sy = sx): Affine {
  return [sx, 0, 0, sy, 0, 0];
}

/** User space → CSS pixels on the displayed page (the frame's rotation, scale, crop). */
export function cssFromUser(frame: PageFrame): Affine {
  const o = userPointToCss(frame, { x: 0, y: 0 });
  const x = userPointToCss(frame, { x: 1, y: 0 });
  const y = userPointToCss(frame, { x: 0, y: 1 });
  return [x.x - o.x, x.y - o.y, y.x - o.x, y.y - o.y, o.x, o.y];
}

/** Paragraph text space → user space, for a unit writing direction. */
export function userFromText(direction: { readonly x: number; readonly y: number }): Affine {
  return [direction.x, direction.y, -direction.y, direction.x, 0, 0];
}

/**
 * A glyph's em-unit outline → user space: scaled by the font size (Tf) and the linear part of
 * the span's matrix, placed at the glyph origin.
 */
export function glyphToUser(
  fontSize: number,
  matrix: TextMatrix,
  origin: { readonly x: number; readonly y: number },
): Affine {
  return [
    fontSize * matrix[0],
    fontSize * matrix[1],
    fontSize * matrix[2],
    fontSize * matrix[3],
    origin.x,
    origin.y,
  ];
}

// ---------------------------------------------------------------------------
// Glyph cache
// ---------------------------------------------------------------------------

/** Builds a canvas path from em-unit segments (three `bezier` segments per curve). */
export function pathFromSegments(segments: readonly GlyphOutlineSegment[]): Path2D {
  const path = new Path2D();
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (!s) continue;
    if (s.kind === 'move') path.moveTo(s.x, s.y);
    else if (s.kind === 'line') path.lineTo(s.x, s.y);
    else {
      const c2 = segments[i + 1];
      const end = segments[i + 2];
      if (c2 && end) {
        path.bezierCurveTo(s.x, s.y, c2.x, c2.y, end.x, end.y);
        i += 2;
        if (end.close) path.closePath();
        continue;
      }
      path.lineTo(s.x, s.y);
    }
    if (s.close) path.closePath();
  }
  return path;
}

/**
 * Glyph outlines per font id and character. Segments arrive from the engine once
 * (`glyphPaths`); the `Path2D` is built on first use and reused for every draw at any size
 * or matrix. `null`: the font has no outline for the character (spaces, missing glyphs).
 */
export class GlyphCache {
  private readonly segments = new Map<string, readonly GlyphOutlineSegment[] | null>();
  private readonly paths = new Map<string, Path2D | null>();
  /** Asked for and not arrived yet: not asked again, drawn as text meanwhile. */
  private readonly pending = new Set<string>();
  /** Paths built so far (a cache hit builds none). */
  builds = 0;

  private static key(fontId: number, ch: string): string {
    return `${fontId}:${ch}`;
  }

  has(fontId: number, ch: string): boolean {
    return this.segments.has(GlyphCache.key(fontId, ch));
  }

  put(fontId: number, ch: string, segments: readonly GlyphOutlineSegment[] | null): void {
    const key = GlyphCache.key(fontId, ch);
    this.segments.set(key, segments && segments.length > 0 ? segments : null);
    this.paths.delete(key);
    this.pending.delete(key);
  }

  /** Marks characters as asked for (`missing` leaves them out until they arrive or fail). */
  request(fontId: number, chars: Iterable<string>): void {
    for (const ch of chars) this.pending.add(GlyphCache.key(fontId, ch));
  }

  /** Forgets a request that failed, so the characters are asked for again. */
  release(fontId: number, chars: Iterable<string>): void {
    for (const ch of chars) this.pending.delete(GlyphCache.key(fontId, ch));
  }

  /** The characters of `chars` neither loaded nor asked for. */
  missing(fontId: number, chars: Iterable<string>): string[] {
    const out = new Set<string>();
    for (const ch of chars) {
      if (!this.has(fontId, ch) && !this.pending.has(GlyphCache.key(fontId, ch))) out.add(ch);
    }
    return [...out];
  }

  /** The outline as a path; null without one; undefined when not loaded yet. */
  get(fontId: number, ch: string): Path2D | null | undefined {
    const key = GlyphCache.key(fontId, ch);
    const built = this.paths.get(key);
    if (built !== undefined) return built;
    const segments = this.segments.get(key);
    if (segments === undefined) return undefined;
    const path = segments === null ? null : pathFromSegments(segments);
    if (path) this.builds += 1;
    this.paths.set(key, path);
    return path;
  }
}

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------

/** How the glyphs of one style are drawn. */
export interface DrawStyle {
  /** The page's font (`ParagraphSpan.fontId`); absent: drawn with `family`. */
  readonly fontId?: number;
  /** Tf, and the span's matrix (only its linear part is used). */
  readonly fontSize: number;
  readonly matrix: TextMatrix;
  /** CSS colour of the fill. */
  readonly fill: string;
  /** CSS font family, weight and style for characters without an outline in the page's font. */
  readonly family: string;
  /** Size factor of the substitute (x-heights matched, spec §4.5). */
  readonly substituteScale?: number;
  readonly bold: boolean;
  readonly italic: boolean;
}

export interface SceneGlyph {
  readonly ch: string;
  /** Glyph origin, paragraph text space. */
  readonly x: number;
  readonly y: number;
  readonly style: DrawStyle;
  /** Set in a bundled substitute (the honesty line names it): drawn with `style.family`. */
  readonly substitute?: boolean;
}

/** A rectangle in paragraph text space. */
export interface TextRect {
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly y1: number;
}

export interface Scene {
  /** Painted with the plate colour under the rewritten lines. */
  readonly plates: readonly TextRect[];
  readonly glyphs: readonly SceneGlyph[];
  readonly selection: readonly TextRect[];
  readonly caret?: { readonly x: number; readonly y0: number; readonly y1: number };
  readonly composition?: { readonly x0: number; readonly x1: number; readonly y: number };
  /** Lines running over the block below (spec §4.6 step 4). */
  readonly overlap: readonly TextRect[];
}

export interface SceneColors {
  readonly plate: string;
  readonly selection: string;
  readonly caret: string;
  readonly overlap: string;
}

export interface DrawOptions {
  readonly colors: SceneColors;
  /** Device pixels per CSS pixel: the caret stays a crisp line. */
  readonly dpr: number;
  /**
   * The settled preview's area (unrotated user space): glyphs are not drawn and plates only
   * outside it, where they still hide old glyph ink the preview's clip leaves out.
   */
  readonly preview?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

/** The subset of a 2D context the drawing uses (tests pass a recorder). */
export type DrawContext = Pick<
  CanvasRenderingContext2D,
  | 'setTransform'
  | 'clearRect'
  | 'fillRect'
  | 'fill'
  | 'fillText'
  | 'beginPath'
  | 'moveTo'
  | 'lineTo'
  | 'closePath'
  | 'stroke'
  | 'save'
  | 'restore'
  | 'clip'
  | 'rect'
> & {
  fillStyle: CanvasRenderingContext2D['fillStyle'];
  strokeStyle: CanvasRenderingContext2D['strokeStyle'];
  lineWidth: number;
  font: string;
};

/** Size of the font `fillText` draws substitutes with, scaled back to one em. */
const FALLBACK_PX = 100;

function rectPath(ctx: DrawContext, m: Affine, r: TextRect): void {
  const corners = [
    apply(m, { x: r.x0, y: r.y0 }),
    apply(m, { x: r.x1, y: r.y0 }),
    apply(m, { x: r.x1, y: r.y1 }),
    apply(m, { x: r.x0, y: r.y1 }),
  ];
  ctx.moveTo(corners[0]?.x ?? 0, corners[0]?.y ?? 0);
  for (const c of corners.slice(1)) ctx.lineTo(c.x, c.y);
  ctx.closePath();
}

function fillRects(ctx: DrawContext, m: Affine, rects: readonly TextRect[], fill: string): void {
  if (rects.length === 0) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = fill;
  ctx.beginPath();
  for (const r of rects) rectPath(ctx, m, r);
  ctx.fill();
}

/**
 * Draws one glyph: its outline from the cache at the span's size and matrix, or (substitutes,
 * outlines not loaded yet) the character in the style's CSS font.
 */
export function drawGlyph(
  ctx: DrawContext,
  cache: GlyphCache,
  glyph: SceneGlyph,
  textToUser: Affine,
  userToDevice: Affine,
): void {
  const { style } = glyph;
  const origin = apply(textToUser, glyph);
  const m = compose(glyphToUser(style.fontSize, style.matrix, origin), userToDevice);
  const path =
    glyph.substitute || style.fontId === undefined ? undefined : cache.get(style.fontId, glyph.ch);
  if (path === null) return;
  ctx.fillStyle = style.fill;
  if (path) {
    ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
    ctx.fill(path);
    return;
  }
  // Glyph space is y-up; text drawn by the canvas is y-down.
  const k = (glyph.substitute ? style.substituteScale : undefined) ?? 1;
  const t = compose(scale(k / FALLBACK_PX, -k / FALLBACK_PX), m);
  ctx.setTransform(t[0], t[1], t[2], t[3], t[4], t[5]);
  ctx.font = `${style.italic ? 'italic ' : ''}${style.bold ? '700 ' : ''}${FALLBACK_PX}px ${style.family}`;
  ctx.fillText(glyph.ch, 0, 0);
}

function strokeLine(
  ctx: DrawContext,
  m: Affine,
  from: { x: number; y: number },
  to: { x: number; y: number },
  color: string,
  width: number,
): void {
  const a = apply(m, from);
  const b = apply(m, to);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

/** Clears the canvas and draws the scene. */
export function drawScene(
  ctx: DrawContext,
  size: { readonly width: number; readonly height: number },
  scene: Scene,
  cache: GlyphCache,
  textToUser: Affine,
  userToDevice: Affine,
  options: DrawOptions,
): void {
  const { colors, dpr } = options;
  const textToDevice = compose(textToUser, userToDevice);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, size.width, size.height);
  const { preview } = options;
  if (preview) {
    // Plates around the preview only: a hole where the preview shows the page as saved.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, size.width, size.height);
    rectPath(ctx, userToDevice, {
      x0: preview.x,
      x1: preview.x + preview.width,
      y0: preview.y,
      y1: preview.y + preview.height,
    });
    ctx.clip('evenodd');
    fillRects(ctx, textToDevice, scene.plates, colors.plate);
    ctx.restore();
  } else {
    fillRects(ctx, textToDevice, scene.plates, colors.plate);
  }
  fillRects(ctx, textToDevice, scene.selection, colors.selection);
  if (!preview) {
    for (const glyph of scene.glyphs) drawGlyph(ctx, cache, glyph, textToUser, userToDevice);
  }
  fillRects(ctx, textToDevice, scene.overlap, colors.overlap);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (scene.composition) {
    const { x0, x1, y } = scene.composition;
    strokeLine(ctx, textToDevice, { x: x0, y }, { x: x1, y }, colors.caret, Math.max(1, dpr));
  }
  if (scene.caret) {
    const { x, y0, y1 } = scene.caret;
    const width = Math.max(1, Math.round(1.5 * dpr));
    strokeLine(ctx, textToDevice, { x, y: y0 }, { x, y: y1 }, colors.caret, width);
  }
}

// ---------------------------------------------------------------------------
// From the paragraph to a scene
// ---------------------------------------------------------------------------

/** CSS colour of an RGBA 0–255 fill (black when unknown). */
export function cssColor(fill: readonly [number, number, number, number] | undefined): string {
  if (!fill) return '#000000';
  const [r, g, b, a] = fill;
  return `rgba(${r}, ${g}, ${b}, ${Math.round((a / 255) * 1000) / 1000})`;
}

/** CSS fallbacks after a bundled face's family, by class. */
function genericFamily(font: TextRunFont): string {
  if (font.monospace) return 'monospace';
  return font.serif ? 'serif' : 'sans-serif';
}

/**
 * How each style of the paragraph is drawn (`ParagraphLayoutAnalysis.styles`): the page's
 * font by id, size, matrix and colour; characters the font lacks in the substitute's family
 * at its x-height factor.
 */
export function drawStylesOf(
  styles: Readonly<Record<string, ParagraphStyleInfo>>,
): Readonly<Record<string, DrawStyle>> {
  const out: Record<string, DrawStyle> = {};
  for (const [id, info] of Object.entries(styles)) {
    out[id] = {
      ...(info.fontId === undefined ? {} : { fontId: info.fontId }),
      fontSize: info.fontSize,
      matrix: info.matrix,
      fill: cssColor(info.fill),
      family: `"${info.substitute.family}", ${genericFamily(info.font)}`,
      substituteScale: info.substitute.scale,
      bold: info.font.bold,
      italic: info.font.italic,
    };
  }
  return out;
}

export interface SceneInput {
  readonly setup: ParagraphSetup;
  readonly state: ParagraphState;
  readonly relayout: ParagraphRelayout;
  readonly lines: readonly CaretLine[];
  readonly styles: Readonly<Record<string, DrawStyle>>;
  /** The mirror has the focus: the caret shows. */
  readonly focused: boolean;
  /** The IME composition's range in the state's text, while composing. */
  readonly composition?: TextRange;
}

/** Ascent and descent of a line's band as fractions of its size (the plate's extent). */
const BAND_ASCENT = 1.0;
const BAND_DESCENT = 0.3;
/** The caret runs from the descent to the ascent. */
const CARET_ASCENT = 0.88;
const CARET_DESCENT = 0.22;

function isBlank(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\u00a0';
}

/**
 * What the canvas shows for a state: plates over the original lines that change (rewritten
 * lines and reused lines that move) and under the lines that are drawn, never over a line the
 * page still shows; the glyphs of rewritten and moved lines; caret, selection, composition and
 * the lines that run over the block below.
 */
export function buildScene(input: SceneInput): Scene {
  const { setup, state, relayout, lines, styles } = input;
  const { block } = setup;
  const { layout, decision } = relayout;
  const fallbackId = setup.input.spans[0]?.style ?? Object.keys(setup.input.styles)[0] ?? '';
  const substituted = new Set(layout.substituted.map((s) => s.char));
  const left = block.measure.left;
  const right = block.measure.right;

  // Original lines the page keeps showing as they are.
  const still = new Set<number>();
  layout.lines.forEach((line) => {
    if (line.source === undefined) return;
    if (line.status === 'kept' || (line.status === 'reused' && Math.abs(line.dy) < 1e-6)) {
      still.add(line.source);
    }
  });
  const visible = block.lines.filter((_, j) => still.has(j));

  const band = (baseline: number, size: number, x0: number, x1: number): TextRect => {
    let y0 = baseline - BAND_DESCENT * size;
    let y1 = baseline + BAND_ASCENT * size;
    for (const v of visible) {
      if (Math.abs(v.baseline - baseline) < 1e-6) continue;
      if (v.baseline > baseline) y1 = Math.min(y1, v.baseline - BAND_DESCENT * v.size);
      else y0 = Math.max(y0, v.baseline + BAND_ASCENT * v.size);
    }
    const margin = size * 0.25;
    return { x0: x0 - margin, x1: x1 + margin, y0, y1: Math.max(y0, y1) };
  };

  const plates: TextRect[] = [];
  block.lines.forEach((line, j) => {
    if (!still.has(j)) {
      plates.push(
        band(line.baseline, line.size, Math.min(line.x0, left), Math.max(line.x1, right)),
      );
    }
  });

  const glyphs: SceneGlyph[] = [];
  const overlap: TextRect[] = [];
  const overrun =
    decision.kind === 'overflow' ? (decision.overlap > 0 ? decision.overlap : decision.excess) : 0;
  lines.forEach((line, i) => {
    const laid = layout.lines[i];
    if (!laid) return;
    const drawn =
      line.status === 'rewritten' || (line.status === 'reused' && Math.abs(line.dy) >= 1e-6);
    if (overrun > 0 && laid.y > layout.height - overrun - 1e-6) {
      overlap.push(band(line.baseline, line.size, left, right));
    }
    if (!drawn) return;
    plates.push(band(line.baseline, line.size, left, right));
    let offset = line.start;
    while (offset < line.end) {
      const cp = state.text.codePointAt(offset) ?? 0;
      const ch = String.fromCodePoint(cp);
      if (!isBlank(ch)) {
        const styleId = state.styles[offset] ?? fallbackId;
        const style = styles[styleId] ?? styles[fallbackId];
        if (style) {
          const own = setup.input.styles[styleId]?.advances[ch] !== undefined;
          glyphs.push({
            ch,
            x: line.xs[offset - line.start] ?? 0,
            y: line.baseline,
            style,
            ...(!own && substituted.has(ch) ? { substitute: true } : {}),
          });
        }
      }
      offset += ch.length;
    }
    // The original line-end hyphen, kept where the line still ends there.
    const hyphenChar = setup.input.hyphenChar ?? '-';
    const original = line.source === undefined ? undefined : block.lines[line.source];
    const hyphenStyle = laid.hyphen
      ? styles[laid.hyphen.style]
      : styles[state.styles[Math.max(0, line.end - 1)] ?? fallbackId];
    const hyphenX = laid.hyphen
      ? laid.hyphen.x
      : line.status === 'reused' && original?.end === 'joined'
        ? line.xs[line.end - line.start]
        : undefined;
    if (hyphenX !== undefined && hyphenStyle) {
      glyphs.push({ ch: hyphenChar, x: hyphenX, y: line.baseline, style: hyphenStyle });
    }
  });

  const range = selectionOf(state);
  const selection = selectionRects(lines, range);
  let caret: Scene['caret'];
  if (input.focused && range.start === range.end && !input.composition) {
    const at = caretAt(lines, state.focus);
    const line = lines[at.line];
    if (line) {
      caret = {
        x: at.x,
        y0: line.baseline - CARET_DESCENT * line.size,
        y1: line.baseline + CARET_ASCENT * line.size,
      };
    }
  }
  let composition: Scene['composition'];
  if (input.composition && input.composition.end > input.composition.start) {
    const a = caretAt(lines, input.composition.start);
    const b = caretAt(lines, input.composition.end);
    const line = lines[a.line];
    if (line) {
      composition = {
        x0: a.x,
        x1: a.line === b.line ? b.x : (line.xs[line.xs.length - 1] ?? a.x),
        y: line.baseline - 0.12 * line.size,
      };
    }
  }
  return {
    plates,
    glyphs,
    selection,
    ...(caret ? { caret } : {}),
    ...(composition ? { composition } : {}),
    overlap,
  };
}

/** The scene's extent in text space (plates, glyph bands, caret), for sizing the canvas. */
export function sceneBounds(scene: Scene, fallback: TextRect): TextRect {
  let x0 = fallback.x0;
  let x1 = fallback.x1;
  let y0 = fallback.y0;
  let y1 = fallback.y1;
  const grow = (r: TextRect) => {
    x0 = Math.min(x0, r.x0);
    x1 = Math.max(x1, r.x1);
    y0 = Math.min(y0, r.y0);
    y1 = Math.max(y1, r.y1);
  };
  for (const r of scene.plates) grow(r);
  for (const r of scene.overlap) grow(r);
  for (const g of scene.glyphs) {
    const size = g.style.fontSize * Math.hypot(g.style.matrix[0], g.style.matrix[1]);
    grow({ x0: g.x - size, x1: g.x + 2 * size, y0: g.y - size, y1: g.y + 1.2 * size });
  }
  return { x0, x1, y0, y1 };
}
