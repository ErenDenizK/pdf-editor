/**
 * Editability of a run (spec §2.5): what blocks editing entirely, whether the original font
 * can take the replacement (tier 2 pre-check: a glyph outline per non-space character,
 * WinAnsi for standard-14 fonts), and the fit report (the replacement's width in each tier's
 * font against the free space up to the next glyph on the line, or at the end of a line up
 * to the right edge of its text block).
 */
import type { Font } from '@cantoo/fontkit';

import {
  TEXT_EDIT_SHRINK_FLOOR,
  type TextEditBlocker,
  type TextEditHonesty,
  type TextFitOption,
  type TextTier2Refusal,
} from '../types';
import { textEditError } from './errors';
import { faceAdvance, isBlank, isSymbolicStandard, isWinAnsi } from './fonts';
import { axis, type ObjectInfo, type ResolvedRun } from './locate';
import type { Point, RawText } from './raw';

/** `FPDF_TEXTRENDERMODE_INVISIBLE`. */
const RENDER_INVISIBLE = 3;

/** Slack when comparing positions and widths, points. */
export const POSITION_TOLERANCE = 0.01;

/** Why the run cannot be edited at all, or undefined. */
export function blockerOf(info: ObjectInfo): TextEditBlocker | undefined {
  if (!info.font) return 'paths';
  if (info.classified.kind === 'type3') return 'type3';
  if (info.renderMode === RENDER_INVISIBLE) return 'invisible';
  if (info.vertical) return 'vertical';
  if (info.place.forms.length > 1) return 'nested-form';
  return undefined;
}

/**
 * The selection as glyphs of the whole object (`analysis.glyphs`): a character range that
 * splits a glyph (one code shown as several characters, such as a ligature) is refused.
 */
export function glyphSelection(
  run: ResolvedRun,
  range: GlyphRange,
  glyphOfChar: readonly number[],
  glyphCount: number,
): { g0: number; g1: number } {
  const at = (charIndex: number): number => {
    // A generated space belongs to no glyph: the boundary is the next glyph.
    let i = charIndex;
    while (i < glyphOfChar.length && glyphOfChar[i] === -1) i++;
    if (i >= glyphOfChar.length) return glyphCount;
    const g = glyphOfChar[i] ?? -1;
    if (i > 0 && glyphOfChar[i - 1] === g) {
      throw textEditError(
        'invalid-range',
        `The selection splits a glyph that shows several characters in "${run.located.text}"`,
      );
    }
    return g;
  };
  return { g0: at(run.from + range.g0), g1: at(run.from + range.g1) };
}

/** The selection as glyph indices `[g0, g1)` of the run. */
export interface GlyphRange {
  readonly g0: number;
  readonly g1: number;
}

/** Maps UTF-16 offsets of `run.located.text` to glyph boundaries (or throws). */
export function glyphRange(run: ResolvedRun, start = 0, end?: number): GlyphRange {
  const glyphs = run.located.glyphs;
  const stop = end ?? run.located.text.length;
  const boundaries = [0];
  for (const g of glyphs) boundaries.push((boundaries[boundaries.length - 1] ?? 0) + g.text.length);
  const g0 = boundaries.indexOf(start);
  const g1 = boundaries.indexOf(stop);
  if (g0 < 0 || g1 < 0 || g1 < g0) {
    throw textEditError(
      'invalid-range',
      `Range ${start}..${stop} is not on character boundaries of "${run.located.text}"`,
    );
  }
  return { g0, g1 };
}

export type Tier2Check =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: TextTier2Refusal; readonly missing: string[] };

/** Tier 2 pre-check (before any change): the original font must encode and draw every char. */
export function tier2Precheck(raw: RawText, info: ObjectInfo, replacement: string): Tier2Check {
  if (blockerOf(info)) return { ok: false, reason: 'blocked', missing: [] };
  if (info.place.forms.length > 0) return { ok: false, reason: 'in-form', missing: [] };
  const kind = info.classified.kind;
  if (kind === 'not-embedded') return { ok: false, reason: 'not-embedded', missing: [] };
  const chars = [...new Set(replacement)];
  if (kind === 'standard14' && !isSymbolicStandard(info.facts.baseName)) {
    const outside = chars.filter((c) => !isWinAnsi(c));
    if (outside.length > 0) return { ok: false, reason: 'outside-winansi', missing: outside };
  }
  const missing = chars.filter((c) => !isBlank(c) && !raw.hasGlyphPath(info.font, c));
  if (missing.length > 0) return { ok: false, reason: 'missing-glyphs', missing };
  return { ok: true };
}

/** Honesty state of a successful edit. */
export function honestyOf(tier: 1 | 2, info: ObjectInfo): Exclude<TextEditHonesty, 'not-editable'> {
  if (tier === 2) {
    return info.classified.kind === 'embedded' ? 'same-font' : 'same-font-not-embedded';
  }
  return info.place.forms.length > 0 ? 'moved-out-of-form' : 'font-substituted';
}

// ---------------------------------------------------------------------------
// Fit
// ---------------------------------------------------------------------------

/** What ends the free space after a line: a glyph, the text block's right edge, the page. */
export type SpaceBound = 'glyph' | 'column' | 'page';

export interface FreeSpace {
  /** Where the replacement starts (the first selected glyph's origin). */
  readonly start: Point;
  readonly available: number;
  readonly boundedByGlyph: boolean;
  /** What `available` ends at. */
  readonly boundedBy: SpaceBound;
  readonly replaced: number;
}

function along(u: Point, from: Point, to: Point): number {
  return (to.x - from.x) * u.x + (to.y - from.y) * u.y;
}

function across(u: Point, from: Point, to: Point): number {
  return -(to.x - from.x) * u.y + (to.y - from.y) * u.x;
}

/** End of a glyph's advance (its origin plus its width along the baseline). */
function glyphEnd(raw: RawText, info: ObjectInfo, index: number): Point {
  const c = info.chars[index];
  if (!c) return { x: 0, y: 0 };
  const w = raw.glyphWidth(info.font, c.text, info.size) ?? 0;
  const { u, scale } = axis(info.pageMatrix);
  return { x: c.origin.x + w * scale * u.x, y: c.origin.y + w * scale * u.y };
}

/** Baselines closer than this, in line heights, are one line. */
const SAME_BASELINE = 0.2;
/** A gap along a baseline wider than this, in line heights, separates two columns. */
const COLUMN_GAP = 1;
/** Neighbouring lines of one text block are at most this far apart, in line heights. */
const BLOCK_LEADING = 1.75;
/** The free space may run this far past the block's right edge, in line heights. */
const COLUMN_TOLERANCE = 0.5;

/** A stretch of characters on one baseline, in the run's line frame (see `lineLimit`). */
interface Segment {
  /** Offset of the baseline across the line (0: the run's own). */
  readonly at: number;
  start: number;
  end: number;
  mine: boolean;
}

/**
 * Splits characters into lines (by baseline) and each line into segments at gaps wider than
 * `COLUMN_GAP` line heights, so the columns of a page sharing baselines stay apart. Ordered
 * by baseline, then along the line.
 */
function segmentsOf(
  points: readonly { at: number; start: number; end: number; mine: boolean }[],
  lineHeight: number,
): Segment[][] {
  const sorted = [...points].sort((a, b) => a.at - b.at);
  const lines: (typeof points)[number][][] = [];
  for (const p of sorted) {
    const line = lines[lines.length - 1];
    const last = line?.[line.length - 1];
    if (line && last && p.at - last.at <= SAME_BASELINE * lineHeight) line.push(p);
    else lines.push([p]);
  }
  return lines.map((line) => {
    const at = line.reduce((sum, p) => sum + p.at, 0) / line.length;
    const out: Segment[] = [];
    for (const p of [...line].sort((a, b) => a.start - b.start)) {
      const current = out[out.length - 1];
      if (current && p.start - current.end <= COLUMN_GAP * lineHeight) {
        current.end = Math.max(current.end, p.end);
        current.mine ||= p.mine;
      } else {
        out.push({ at, start: p.start, end: p.end, mine: p.mine });
      }
    }
    return out;
  });
}

/**
 * The right edge of the text block the run's line belongs to: lines whose baselines follow
 * each other at most `BLOCK_LEADING` line heights apart and that overlap the line along the
 * baseline, walked up and down from the run's line. Undefined when the line has no such
 * neighbour (a heading, a label): nothing tells where its column ends.
 */
function blockEnd(lines: readonly Segment[][], lineHeight: number): number | undefined {
  const index = lines.findIndex((line) => line.some((s) => s.mine));
  const own = lines[index]?.find((s) => s.mine);
  if (!own) return undefined;
  let end = own.end;
  let neighbours = 0;
  for (const step of [-1, 1]) {
    let edge = { at: own.at, start: own.start, end: own.end };
    for (let i = index + step; i >= 0 && i < lines.length; i += step) {
      const line = lines[i] ?? [];
      const at = line[0]?.at ?? edge.at;
      if (Math.abs(at - edge.at) > BLOCK_LEADING * lineHeight) break;
      const overlapping = line.filter((s) => s.start < edge.end && s.end > edge.start);
      if (overlapping.length === 0) break;
      edge = {
        at,
        start: Math.min(...overlapping.map((s) => s.start)),
        end: Math.max(...overlapping.map((s) => s.end)),
      };
      end = Math.max(end, edge.end);
      neighbours += 1;
    }
  }
  return neighbours > 0 ? end : undefined;
}

/** Where the free space after the run's last glyph ends (see `freeSpace`). */
export interface LineLimit {
  /** The run's first glyph origin: distances below are measured along the line from it. */
  readonly origin: Point;
  /** End of the run's last glyph advance. */
  readonly runEnd: number;
  /** Where the free space after the run ends. */
  readonly limit: number;
  readonly boundedBy: SpaceBound;
}

/**
 * Where the free space after the run ends, along its line: at the nearest glyph of another
 * object on the same baseline after the run, or at the right edge of the run's text block
 * (the furthest right edge among the neighbouring lines of the block, plus half a line
 * height), whichever comes first; else at the page box edge.
 */
export function lineLimit(
  raw: RawText,
  pagePtr: number,
  textPage: number,
  run: ResolvedRun,
): LineLimit {
  const { info, from, to } = run;
  const { u } = axis(info.pageMatrix);
  const origin = info.chars[from]?.origin ?? { x: 0, y: 0 };
  const runEnd = to > from ? along(u, origin, glyphEnd(raw, info, to - 1)) : 0;
  const lineHeight = Math.abs(info.size) * Math.hypot(info.pageMatrix[2], info.pageMatrix[3]) || 1;
  const mine = new Set(info.chars.slice(from, to).map((c) => c.index));
  let next = Number.POSITIVE_INFINITY;
  const points: { at: number; start: number; end: number; mine: boolean }[] = [];
  const count = raw.charCount(textPage);
  for (let i = 0; i < count; i++) {
    if (!raw.charObject(textPage, i)) continue;
    const own = mine.has(i);
    const o = raw.charOrigin(textPage, i);
    const at = across(u, origin, o);
    const t = along(u, origin, o);
    if (!own && Math.abs(at) <= Math.max(0.3 * lineHeight, 0.5)) {
      if (t >= runEnd - POSITION_TOLERANCE && t < next) next = t;
    }
    // Blocks are measured by their ink: a trailing space does not move a column's edge.
    if (isBlank(raw.charText(textPage, i))) continue;
    const box = raw.charBox(textPage, i);
    let start = t;
    let end = t;
    if (box.width > 0 || box.height > 0) {
      for (const corner of [
        { x: box.x, y: box.y },
        { x: box.x + box.width, y: box.y },
        { x: box.x, y: box.y + box.height },
        { x: box.x + box.width, y: box.y + box.height },
      ]) {
        const c = along(u, origin, corner);
        start = Math.min(start, c);
        end = Math.max(end, c);
      }
    }
    points.push({ at, start, end, mine: own });
  }
  const page = toEdge(raw.pageBox(pagePtr), origin, u);
  const right = mine.size > 0 ? blockEnd(segmentsOf(points, lineHeight), lineHeight) : undefined;
  const column =
    right === undefined
      ? undefined
      : Math.min(page, Math.max(right, runEnd) + COLUMN_TOLERANCE * lineHeight);
  if (Number.isFinite(next) && (column === undefined || next <= column)) {
    return { origin, runEnd, limit: next, boundedBy: 'glyph' };
  }
  if (column !== undefined) return { origin, runEnd, limit: column, boundedBy: 'column' };
  return { origin, runEnd, limit: page, boundedBy: 'page' };
}

/**
 * Free space for the replacement: from the first selected glyph to the next glyph on the
 * line (the run's own next glyph), or, when the selection runs to the end of the line, to
 * `lineLimit` (the next glyph of another object on the same baseline, the right edge of the
 * text block, or the page box edge).
 */
export function freeSpace(
  raw: RawText,
  pagePtr: number,
  textPage: number,
  run: ResolvedRun,
  range: GlyphRange,
): FreeSpace {
  const { info, from, to } = run;
  const { u } = axis(info.pageMatrix);
  const first = from + range.g0;
  const start =
    first < to
      ? (info.chars[first]?.origin ?? { x: 0, y: 0 })
      : to > from
        ? glyphEnd(raw, info, to - 1)
        : { x: 0, y: 0 };
  const selectionEnd =
    from + range.g1 < to
      ? (info.chars[from + range.g1]?.origin ?? start)
      : to > from
        ? glyphEnd(raw, info, to - 1)
        : start;
  const replaced = Math.max(0, along(u, start, selectionEnd));
  if (from + range.g1 < to) {
    return { start, available: replaced, boundedByGlyph: true, boundedBy: 'glyph', replaced };
  }
  // The selection runs to the end of the line.
  const line = lineLimit(raw, pagePtr, textPage, run);
  return {
    start,
    available: Math.max(0, line.limit - along(u, line.origin, start)),
    boundedByGlyph: line.boundedBy === 'glyph',
    boundedBy: line.boundedBy,
    replaced,
  };
}

/** Distance from `p` along `u` to the edge of `box`. */
function toEdge(
  box: { x: number; y: number; width: number; height: number },
  p: Point,
  u: Point,
): number {
  const ts: number[] = [];
  if (u.x > 1e-9) ts.push((box.x + box.width - p.x) / u.x);
  if (u.x < -1e-9) ts.push((box.x - p.x) / u.x);
  if (u.y > 1e-9) ts.push((box.y + box.height - p.y) / u.y);
  if (u.y < -1e-9) ts.push((box.y - p.y) / u.y);
  return Math.max(0, Math.min(...ts.filter((t) => t >= 0), Number.MAX_VALUE));
}

/** Width of `text` in a bundled face at `size`, points along the baseline. */
export function tier1Width(face: Font, info: ObjectInfo, text: string, size: number): number {
  return faceAdvance(face, text) * size * axis(info.pageMatrix).scale;
}

/**
 * The fit of a replacement `width` points wide, of which `spacing` (Tc/Tw, tier 2) does not
 * shrink with the font size: `shrink` is the size factor that makes it fit.
 */
export function fitOption(width: number, available: number, spacing = 0): TextFitOption {
  const fits = width <= available + POSITION_TOLERANCE;
  const scalable = width - spacing;
  const shrink = fits || scalable <= 0 ? 1 : Math.max(0, (available - spacing) / scalable);
  return { width, shrink, fits, canShrink: shrink >= TEXT_EDIT_SHRINK_FLOOR };
}

/**
 * The replacement's font size for a fit mode: the run's size when it fits or overflows,
 * shrunk (floor 75%) with `shrink`; `does-not-fit` otherwise.
 */
export function fittedSize(
  size: number,
  option: TextFitOption,
  fit: 'keep' | 'shrink' | 'overflow',
): number {
  if (option.fits || fit === 'overflow') return size;
  if (fit === 'shrink' && option.canShrink) {
    // Rounded down to 1/1000 pt so the content stream stays short and the text still fits.
    return Math.floor(size * option.shrink * 1000) / 1000;
  }
  throw textEditError(
    'does-not-fit',
    fit === 'keep'
      ? `The replacement needs ${option.width.toFixed(2)} pt; ${(option.width * option.shrink).toFixed(2)} pt are free (shrink or overflow)`
      : `Shrinking to fit needs ${(option.shrink * 100).toFixed(0)}% of the size, below the ${TEXT_EDIT_SHRINK_FLOOR * 100}% floor (overflow instead)`,
  );
}
