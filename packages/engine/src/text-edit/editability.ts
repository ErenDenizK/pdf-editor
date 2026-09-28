/**
 * Editability of a run (spec §2.5): what blocks editing entirely, whether the original font
 * can take the replacement (tier 2 pre-check: a glyph outline per non-space character,
 * WinAnsi for standard-14 fonts), and the fit report (the replacement's width in each tier's
 * font against the free space up to the next glyph on the line).
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

export interface FreeSpace {
  /** Where the replacement starts (the first selected glyph's origin). */
  readonly start: Point;
  readonly available: number;
  readonly boundedByGlyph: boolean;
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

/**
 * Free space for the replacement: from the first selected glyph to the next glyph on the
 * line (the run's own next glyph, else the nearest glyph of any object on the same
 * baseline), else to the page box edge.
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
    return { start, available: replaced, boundedByGlyph: true, replaced };
  }
  // The selection runs to the end of the line: look for glyphs of other objects after it.
  const lineHeight = Math.abs(info.size) * Math.hypot(info.pageMatrix[2], info.pageMatrix[3]);
  const mine = new Set(info.chars.slice(from, to).map((c) => c.index));
  let next = Number.POSITIVE_INFINITY;
  const count = raw.charCount(textPage);
  for (let i = 0; i < count; i++) {
    if (mine.has(i) || !raw.charObject(textPage, i)) continue;
    const o = raw.charOrigin(textPage, i);
    if (Math.abs(across(u, start, o)) > Math.max(0.3 * lineHeight, 0.5)) continue;
    const t = along(u, start, o);
    if (t >= replaced - POSITION_TOLERANCE && t < next) next = t;
  }
  if (Number.isFinite(next)) return { start, available: next, boundedByGlyph: true, replaced };
  return {
    start,
    available: toEdge(raw.pageBox(pagePtr), start, u),
    boundedByGlyph: false,
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

/** Width of `text` in the original font at `size`, points along the baseline. */
export function tier2Width(raw: RawText, info: ObjectInfo, text: string, size: number): number {
  const { scale } = axis(info.pageMatrix);
  let width = 0;
  for (const ch of text) width += raw.glyphWidth(info.font, ch, size) ?? 0;
  return width * scale;
}

/** Width of `text` in a bundled face at `size`, points along the baseline. */
export function tier1Width(face: Font, info: ObjectInfo, text: string, size: number): number {
  return faceAdvance(face, text) * size * axis(info.pageMatrix).scale;
}

export function fitOption(width: number, available: number): TextFitOption {
  const fits = width <= available + POSITION_TOLERANCE;
  const shrink = fits || width <= 0 ? 1 : available / width;
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
