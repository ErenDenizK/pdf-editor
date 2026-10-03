/**
 * The Edit text tool's pure logic (redaction-and-text-editing spec §2.2, §2.5): which runs
 * are editable, where a click puts the caret, the range an edited line replaces, the honesty
 * badge and fit choice shown from `checkEditability` (or, between engine checks, estimated
 * from the run's one-off analysis: craft spec §4.8), and the history label from the applied
 * result. No engine calls and no DOM, so it is unit-tested directly.
 */
import type { Rotation } from '@pdf-editor/document-model';
import {
  type LocatedRun,
  TEXT_EDIT_SHRINK_FLOOR,
  type TextEditability,
  type TextEditBlocker,
  type TextEditFailure,
  type TextEditResult,
  type TextFitOption,
  type TextRunAnalysis,
  type TextRunFont,
  type TextTier2Refusal,
} from '@pdf-editor/engine';

import { formatPercent, getLocale, m } from '../i18n';
import type { PageFrame } from '../viewer/geometry';
import { humanFontName } from './font-names';

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/** Text render mode 3 (neither fill nor stroke): OCR layers. */
const RENDER_INVISIBLE = 3;

/**
 * Why a located run cannot be edited at all (the engine's own rule, `blockerOf`): Type3
 * fonts, invisible text, vertical writing, text in nested forms. Undefined when editable.
 */
export function blockerOfRun(run: LocatedRun): TextEditBlocker | undefined {
  if (run.font.kind === 'type3') return 'type3';
  if (run.renderMode === RENDER_INVISIBLE) return 'invisible';
  if (run.vertical) return 'vertical';
  if (run.objectPath.length > 2) return 'nested-form';
  return undefined;
}

export function blockerLabel(
  reason: TextEditBlocker | 'unsupported-chars',
  missing: readonly string[] = [],
): string {
  switch (reason) {
    case 'type3':
      return m.text_edit_reason_type3();
    case 'invisible':
      return m.text_edit_reason_invisible();
    case 'paths':
      return m.text_edit_reason_paths();
    case 'vertical':
      return m.text_edit_reason_vertical();
    case 'nested-form':
      return m.text_edit_reason_nested_form();
    case 'shared-form':
      return m.text_edit_reason_shared_form();
    case 'clipped':
      return m.text_edit_reason_clipped();
    case 'unreadable-encoding':
      return m.text_edit_reason_unreadable_encoding();
    case 'unsupported-chars':
      return m.text_edit_reason_unsupported_chars({ chars: quoteChars(missing) });
  }
}

/** A run's identity on its page revision: object path and first text-page character. */
export function runKey(run: Pick<LocatedRun, 'objectPath' | 'charStart'>): string {
  return `${run.objectPath.join('.')}:${run.charStart}`;
}

/** Where a run starts on the page (its first glyph's origin, else its line box corner). */
function runOrigin(run: LocatedRun): { x: number; y: number } {
  return run.glyphs[0]?.origin ?? { x: run.lineBox.x, y: run.lineBox.y };
}

/** Length of a rect projected on the unit vector `v`. */
function extentAlong(rect: LocatedRun['lineBox'], v: { x: number; y: number }): number {
  return Math.abs(v.x) * rect.width + Math.abs(v.y) * rect.height;
}

/**
 * The run the keyboard focus returns to after the editor over `previous` closed: among the
 * editable `runs` on the same line (same writing direction, origin within half the line's
 * thickness of it), the one with `previous`'s key, else the one nearest to where `previous`
 * started (an edit splits the line into new objects, so keys change). Undefined when no
 * editable run is left on that line.
 */
export function focusReturnRun(
  runs: readonly LocatedRun[],
  previous: LocatedRun,
): LocatedRun | undefined {
  const d = previous.direction;
  const normal = { x: -d.y, y: d.x };
  const origin = runOrigin(previous);
  const tolerance = Math.max(extentAlong(previous.lineBox, normal) / 2, 0.5);
  const key = runKey(previous);
  let best: LocatedRun | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const run of runs) {
    if (blockerOfRun(run)) continue;
    if (run.direction.x * d.x + run.direction.y * d.y < 0.99) continue;
    const o = runOrigin(run);
    const offset = { x: o.x - origin.x, y: o.y - origin.y };
    if (Math.abs(offset.x * normal.x + offset.y * normal.y) > tolerance) continue;
    if (runKey(run) === key) return run;
    // Distance along the line from `previous`'s start to the run's extent (0 inside it).
    const start = offset.x * d.x + offset.y * d.y;
    const end = start + extentAlong(run.lineBox, d);
    const distance = start > 0 ? start : end < 0 ? -end : 0;
    if (distance < bestDistance) {
      best = run;
      bestDistance = distance;
    }
  }
  return best;
}

function quoteChars(chars: readonly string[]): string {
  return chars.length === 0 ? '…' : chars.map((c) => `“${c}”`).join(' ');
}

/** UTF-16 offsets of the run's glyph boundaries: `[0, len(g0), len(g0 g1), …, text.length]`. */
export function glyphBoundaries(run: Pick<LocatedRun, 'glyphs' | 'text'>): number[] {
  const out = [0];
  for (const glyph of run.glyphs) out.push((out[out.length - 1] ?? 0) + glyph.text.length);
  // Defensive: a run whose glyph texts do not add up to its text still gets its end.
  if (out[out.length - 1] !== run.text.length) out.push(run.text.length);
  return out;
}

/** The glyph of `run` under a user-space point: the one containing it, else the nearest. */
export function glyphIndexAt(
  run: Pick<LocatedRun, 'glyphs'>,
  point: { readonly x: number; readonly y: number },
): number {
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  run.glyphs.forEach((glyph, index) => {
    const r = glyph.rect;
    const dx = Math.max(r.x - point.x, 0, point.x - (r.x + r.width));
    const dy = Math.max(r.y - point.y, 0, point.y - (r.y + r.height));
    const distance = Math.hypot(dx, dy);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });
  return best;
}

/** The input selection that picks glyph `index` of the run (its characters). */
export function glyphSelection(
  run: Pick<LocatedRun, 'glyphs' | 'text'>,
  index: number,
): { readonly start: number; readonly end: number } {
  const bounds = glyphBoundaries(run);
  if (index < 0 || index >= run.glyphs.length) {
    return { start: run.text.length, end: run.text.length };
  }
  return { start: bounds[index] ?? 0, end: bounds[index + 1] ?? run.text.length };
}

/** Distance of `point` from the run's first glyph origin along its writing direction. */
function alongRun(
  run: Pick<LocatedRun, 'glyphs' | 'direction'>,
  point: { readonly x: number; readonly y: number },
): number {
  const origin = run.glyphs[0]?.origin ?? { x: 0, y: 0 };
  return (point.x - origin.x) * run.direction.x + (point.y - origin.y) * run.direction.y;
}

/**
 * Where a click at a user-space point puts the caret (craft spec §4.2: a caret at the click,
 * never a glyph selection): before the glyph under the point when the point is on its first
 * half along the line, after it otherwise. UTF-16 offset in `run.text`.
 */
export function caretOffset(
  run: Pick<LocatedRun, 'glyphs' | 'text' | 'direction'>,
  point: { readonly x: number; readonly y: number },
): number {
  const index = glyphIndexAt(run, point);
  const bounds = glyphBoundaries(run);
  const glyph = run.glyphs[index];
  if (!glyph) return run.text.length;
  const r = glyph.rect;
  const middle = alongRun(run, { x: r.x + r.width / 2, y: r.y + r.height / 2 });
  const after = alongRun(run, point) > middle;
  return bounds[after ? index + 1 : index] ?? run.text.length;
}

/**
 * The word around a caret offset (double-click): the letters and digits on both sides of
 * it; a caret between spaces takes the spaces. UTF-16 offsets in `text`.
 */
export function wordAt(
  text: string,
  offset: number,
): { readonly start: number; readonly end: number } {
  const blank = (ch: string | undefined) => ch === undefined || SPACE.test(ch);
  let at = Math.max(0, Math.min(offset, text.length));
  // At the end of a word, the word before the caret.
  if (blank(text[at]) && !blank(text[at - 1])) at -= 1;
  const kind = blank(text[at]);
  let start = at;
  let end = at;
  while (start > 0 && blank(text[start - 1]) === kind) start -= 1;
  while (end < text.length && blank(text[end]) === kind) end += 1;
  return { start, end };
}

/** The line as typed in the editor: one line, no control characters. */
export function singleLine(text: string): string {
  return text.replace(/[\r\n\t\u2028\u2029]+/g, ' ');
}

export interface EditRange {
  /** UTF-16 offsets in the run's text, on glyph boundaries. */
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

const SPACE = /\s/;

/**
 * What an edited line replaces: the smallest changed span, widened to whole words (so a
 * substituted font never starts mid-word) and to glyph boundaries (ligatures), with the
 * text that takes its place. Undefined when nothing changed. Everything outside the range
 * stays in place on the page (spec §2.5: the object is split around the selection).
 */
export function editRange(
  run: Pick<LocatedRun, 'glyphs' | 'text'>,
  next: string,
): EditRange | undefined {
  const original = run.text;
  if (next === original) return undefined;
  const limit = Math.min(original.length, next.length);
  let prefix = 0;
  while (prefix < limit && original[prefix] === next[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < limit - prefix &&
    original[original.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  let start = prefix;
  let end = original.length - suffix;
  while (start > 0 && !SPACE.test(original[start - 1] ?? ' ')) start -= 1;
  while (end < original.length && !SPACE.test(original[end] ?? ' ')) end += 1;
  const bounds = glyphBoundaries(run);
  start = [...bounds].reverse().find((b) => b <= start) ?? 0;
  end = bounds.find((b) => b >= end) ?? original.length;
  const tail = original.length - end;
  return { start, end, replacement: next.slice(start, next.length - tail) };
}

/**
 * Direction of the run on screen, degrees clockwise from left-to-right: the run's writing
 * direction in user space (y up) turned by the page's total rotation, snapped to a quarter.
 */
export function screenAngle(frame: PageFrame, run: Pick<LocatedRun, 'direction'>): Rotation {
  const dx = run.direction.x;
  // CSS y grows downward.
  const dy = -run.direction.y;
  let user: number;
  if (Math.abs(dx) >= Math.abs(dy)) user = dx >= 0 ? 0 : 180;
  else user = dy > 0 ? 90 : 270;
  return ((user + frame.rotation) % 360) as Rotation;
}

// ---------------------------------------------------------------------------
// Honesty badge
// ---------------------------------------------------------------------------

/**
 * "Times New Roman · not embedded" for the editor's header: the human name of the font
 * (font-names.ts); the header keeps the raw /BaseFont in its tooltip.
 */
export function fontLine(font: Pick<TextRunFont, 'baseName' | 'embedded'>): string {
  const name = humanFontName(font.baseName);
  return font.embedded
    ? m.text_edit_font_embedded({ font: name })
    : m.text_edit_font_not_embedded({ font: name });
}

const FAMILIES: Readonly<Record<string, string>> = {
  JetBrainsMono: 'JetBrains Mono',
  NotoSerif: 'Noto Serif',
  NotoSans: 'Noto Sans',
};

/** Display family of a bundled face key (`NotoSerif-Bold` → `Noto Serif`). */
export function familyOfFace(face: string | undefined): string {
  if (face === undefined || face === '') return '?';
  const stem = face.split('-')[0] ?? face;
  return FAMILIES[stem] ?? stem;
}

/**
 * - `same`: tier 2 in the embedded original font;
 * - `info`: tier 2 in a standard-14 font that is not embedded;
 * - `warning`: tier 1, the new text uses a bundled face (also "moves out of form");
 * - `blocked`: not editable.
 */
export type BadgeTone = 'same' | 'info' | 'warning' | 'blocked';

export interface HonestyBadge {
  readonly tone: BadgeTone;
  readonly label: string;
  /** A second line: why it is not editable, or what moving out of a form means. */
  readonly detail?: string;
  /**
   * Tier 2 was refused and tier 1 is used instead: why, as a sentence ("It has no glyph for
   * “F”"). Absent when the reason is that the font is not embedded: the font line says so.
   */
  readonly fellBack?: string;
}

function refusalLabel(reason: TextTier2Refusal, missing: readonly string[]): string {
  const chars = quoteChars(missing);
  switch (reason) {
    case 'in-form':
      return m.text_edit_refusal_in_form();
    case 'not-embedded':
      return m.text_edit_refusal_not_embedded();
    case 'outside-winansi':
      return m.text_edit_refusal_outside_winansi({ chars });
    case 'missing-glyphs':
      return m.text_edit_refusal_missing_glyphs({ chars });
    case 'readback':
      return m.text_edit_refusal_readback({ chars });
    case 'clipped':
      return m.text_edit_refusal_clipped();
    case 'ambiguous-encoding':
      return m.text_edit_refusal_ambiguous_encoding({ chars });
    case 'blocked':
      return m.text_edit_refusal_generic();
  }
}

/** A clause as a sentence: its first letter in upper case ("it has…" → "It has…"). */
function sentenceCase(text: string): string {
  const first = text.charAt(0);
  return first.toLocaleUpperCase(getLocale()) + text.slice(1);
}

/** The badge for an editability report (spec §2.2: font, embedded or not, honesty state). */
export function honestyBadge(check: TextEditability): HonestyBadge {
  const family = check.tier1.ok ? check.tier1.family : undefined;
  // Fell back: tier 1 is used because the original font refused the new text. A run in a
  // form never gets tier 2; its badge says so on its own. A font that is not embedded is
  // already said by the font line above the badge, so it is not repeated.
  const fellBack =
    check.tier === 1 &&
    !check.tier2.ok &&
    check.tier2.reason !== 'blocked' &&
    check.tier2.reason !== 'in-form' &&
    check.tier2.reason !== 'not-embedded'
      ? m.text_edit_fell_back({
          reason: sentenceCase(refusalLabel(check.tier2.reason, check.tier2.missing)),
        })
      : undefined;
  const withFallBack = fellBack === undefined ? {} : { fellBack };
  switch (check.honesty) {
    case 'same-font':
      return { tone: 'same', label: m.text_edit_badge_same_font() };
    case 'same-font-not-embedded':
      return { tone: 'info', label: m.text_edit_badge_same_font_not_embedded() };
    case 'font-substituted':
      return {
        tone: 'warning',
        label: m.text_edit_badge_substituted({ family: family ?? '?' }),
        ...withFallBack,
      };
    case 'moved-out-of-form':
      return {
        tone: 'warning',
        label: m.text_edit_badge_moved_out_of_form(),
        detail: m.text_edit_detail_moved_out_of_form({ family: family ?? '?' }),
        ...withFallBack,
      };
    case 'not-editable': {
      const detail = check.tier1.ok
        ? m.text_edit_refusal_generic()
        : blockerLabel(check.tier1.reason, check.tier1.missing);
      return { tone: 'blocked', label: m.text_edit_badge_not_editable(), detail };
    }
  }
}

// ---------------------------------------------------------------------------
// Fit
// ---------------------------------------------------------------------------

/** How the replacement is fitted (`TextEditRequest.fit`). */
export type FitChoice = 'keep' | 'shrink' | 'overflow';

export interface FitState {
  /** Free space along the baseline, points. */
  readonly available: number;
  /** Width of the replacement in the font the edit will use, points. */
  readonly needed: number;
  readonly fits: boolean;
  /** Size factor that makes it fit. */
  readonly shrink: number;
  /** `shrink` is at or above the 75% floor. */
  readonly canShrink: boolean;
}

/** The fit of the tier the edit will use; undefined when the run is not editable. */
export function fitStateOf(check: TextEditability): FitState | undefined {
  const option =
    check.tier === 2 ? check.fit.tier2 : check.tier === 1 ? check.fit.tier1 : undefined;
  if (!option) return undefined;
  return {
    available: check.fit.available,
    needed: option.width,
    fits: option.fits,
    shrink: option.shrink,
    canShrink: option.canShrink,
  };
}

/**
 * The fit to commit with: `keep` when the text fits; otherwise what the user chose, when
 * it still applies (shrink only above the floor). Null means the user must choose first.
 */
export function resolveFit(
  state: FitState | undefined,
  choice: FitChoice | null,
): FitChoice | null {
  if (!state) return null;
  if (state.fits) return 'keep';
  if (choice === 'overflow') return 'overflow';
  if (choice === 'shrink' && state.canShrink) return 'shrink';
  return null;
}

/**
 * How much wider than the line the new text is, in whole percent ("12% too wide for the
 * line"). At least 1%: a text that does not fit is never "0% too wide".
 */
export function fitSummary(state: FitState): string {
  const over = state.available > 0 ? state.needed / state.available - 1 : 1;
  return m.text_edit_fit_too_wide({ percent: formatPercent(Math.max(0.01, over)) });
}

// ---------------------------------------------------------------------------
// Estimate between engine checks (craft spec §4.8)
// ---------------------------------------------------------------------------

/** `checkEditability`'s slack when comparing widths (`POSITION_TOLERANCE`), points. */
const FIT_TOLERANCE = 0.01;

/** The engine's `fitOption` (editability.ts), as arithmetic on measured widths. */
function fitOption(width: number, available: number, spacing = 0): TextFitOption {
  const fits = width <= available + FIT_TOLERANCE;
  const scalable = width - spacing;
  const shrink = fits || scalable <= 0 ? 1 : Math.max(0, (available - spacing) / scalable);
  return { width, shrink, fits, canShrink: shrink >= TEXT_EDIT_SHRINK_FLOOR };
}

/** Which tier-2 refusal the engine reports first when several characters are refused. */
const REFUSAL_ORDER: readonly TextTier2Refusal[] = [
  'outside-winansi',
  'missing-glyphs',
  'ambiguous-encoding',
];

/**
 * The editability of `text` in the run's editor, estimated from the run's analysis with
 * arithmetic only (no engine call): the replaced range and its free space from the run's
 * glyph origins and the analysed line end, widths from the measured advances. Undefined
 * when a character of the replacement is unknown to the analysis (the engine's check then
 * decides). The engine's check stays the authority: it also verifies by read-back and the
 * clip, which the estimate cannot.
 */
export function estimateEditability(
  analysis: TextRunAnalysis,
  run: Pick<LocatedRun, 'glyphs' | 'text' | 'direction'>,
  text: string,
): TextEditability | undefined {
  const range = editRange(run, text) ?? { start: 0, end: run.text.length, replacement: run.text };
  const bounds = glyphBoundaries(run);
  const count = run.glyphs.length;
  const g0 = Math.min(bounds.indexOf(range.start), count);
  const g1 = Math.min(bounds.indexOf(range.end), count);
  if (g0 < 0 || g1 < 0) return undefined;
  const at = (g: number) => {
    const glyph = run.glyphs[g];
    return glyph ? alongRun(run, glyph.origin) : analysis.runEnd;
  };
  const replaced = Math.max(0, at(g1) - at(g0));
  const toLineEnd = g1 >= count;
  const fitBase = {
    available: toLineEnd ? Math.max(0, analysis.lineEnd - at(g0)) : replaced,
    boundedByGlyph: toLineEnd ? analysis.lineBound === 'glyph' : true,
    boundedBy: toLineEnd ? analysis.lineBound : ('glyph' as const),
    replaced,
  };
  if (analysis.blocker) {
    return {
      tier2: { ok: false, reason: 'blocked', missing: [] },
      tier1: { ok: false, reason: analysis.blocker },
      honesty: 'not-editable',
      fit: fitBase,
    };
  }
  const chars = Array.from(range.replacement);
  const unique = [...new Set(chars)];

  let tier2: TextEditability['tier2'] | undefined;
  let tier2Fit: TextFitOption | undefined;
  const { refusal, advances, refused } = analysis.tier2;
  const reason = REFUSAL_ORDER.find((r) => unique.some((c) => refused[c] === r));
  if (refusal) {
    tier2 = { ok: false, reason: refusal, missing: [] };
  } else if (reason) {
    tier2 = { ok: false, reason, missing: unique.filter((c) => refused[c] === reason) };
  } else if (chars.every((c) => advances[c] !== undefined)) {
    let width = 0;
    let spacing = 0;
    for (const c of chars) {
      const advance = advances[c];
      width += advance?.spaced ?? 0;
      spacing += (advance?.spaced ?? 0) - (advance?.plain ?? 0);
    }
    tier2 = { ok: true };
    tier2Fit = fitOption(width, fitBase.available, spacing);
  }
  if (!tier2) return undefined;

  const face = analysis.tier1;
  let tier1Fit: TextFitOption | undefined;
  if (face && chars.every((c) => face.advances[c] !== undefined)) {
    const width = chars.reduce((sum, c) => sum + (face.advances[c] ?? 0), 0);
    tier1Fit = fitOption(width, fitBase.available);
  }
  if (!tier2.ok && !tier1Fit) return undefined;
  const tier = tier2.ok ? 2 : 1;
  return {
    tier2,
    tier1: face
      ? { ok: true, substitute: face.substitute, family: face.family }
      : { ok: false, reason: 'unsupported-chars', missing: [] },
    tier,
    honesty: tier === 2 ? analysis.honesty.tier2 : analysis.honesty.tier1,
    fit: {
      ...fitBase,
      ...(tier2Fit ? { tier2: tier2Fit } : {}),
      ...(tier1Fit ? { tier1: tier1Fit } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** History label from the applied result ("Text edited (same font)"). */
export function historyLabel(result: TextEditResult): string {
  const family = familyOfFace(result.substitute);
  switch (result.honesty) {
    case 'same-font':
      return m.history_text_edit_same_font();
    case 'same-font-not-embedded':
      return m.history_text_edit_same_font_not_embedded();
    case 'font-substituted':
      return result.fellBack
        ? m.history_text_edit_fell_back({ family })
        : m.history_text_edit_substituted({ family });
    case 'moved-out-of-form':
      return m.history_text_edit_moved_out_of_form();
  }
}

/** What the editor says when an edit failed. */
export function failureMessage(reason: TextEditFailure | undefined): string {
  switch (reason) {
    case 'stale-run':
    case 'invalid-range':
      return m.text_edit_error_stale();
    case 'not-editable':
      return m.text_edit_error_not_editable();
    case 'does-not-fit':
      return m.text_edit_error_does_not_fit();
    case 'unsupported-chars':
      return m.text_edit_error_unsupported_chars();
    case 'verification-failed':
      return m.text_edit_error_verification();
    default:
      return m.text_edit_error_generic();
  }
}
