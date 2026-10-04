/**
 * Paragraph rewrap (spec craft §4.3, §4.5; ADR-0020 §3; research 11 §4.2–§4.3): pure layout
 * arithmetic, no engine call. Measurements arrive as data (advances probed once per font,
 * `probe.ts` / `analyzeRun`), so a keystroke costs a few hundred microseconds on the main
 * thread.
 *
 * - **Greedy first-fit from the edited line.** Lines before it stay as they are. The rewrap
 *   stops as soon as a new line ends where an original line ended, after the edit (the rest
 *   of the text is then unchanged): the later lines are reused, moved by the change in
 *   height. One exception to "from the edited line": an edit in the first word of a line
 *   re-breaks the line before it, so a shortened word can move back up; that line stays
 *   `kept` when it comes out the same.
 * - **Break opportunities** from `linebreak` (UAX #14), plus the paragraph's original
 *   line-end hyphens (de-hyphenated in the text), which can only end a line where they did;
 *   no hyphen is ever inserted.
 * - **Justified** lines take their slack on word gaps only, at most 1.5 × the natural gap;
 *   beyond that the line stays ragged and the layout says so.
 * - **Kerning** pairs harvested from the paragraph are reapplied where the pair recurs.
 * - **Substitutes**: a character the original font lacks is measured in the style's
 *   substitute (class-matched; the caller picks the face) and reported.
 */
// @ts-expect-error linebreak 1.1.0 ships no type declarations; `LineBreakerClass` types it.
import LineBreakerModule from 'linebreak';

import type {
  LayoutLine,
  LayoutRun,
  LayoutSubstitution,
  LayoutWord,
  ParagraphLayout,
  TextAdvance,
} from '../types';

interface LineBreakOpportunity {
  /** UTF-16 offset the next line starts at. */
  readonly position: number;
  /** A mandatory break (after a line feed). */
  readonly required: boolean;
}
type LineBreakerClass = new (text: string) => { nextBreak(): LineBreakOpportunity | null };
const LineBreaker = LineBreakerModule as LineBreakerClass;

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** Metrics of one style (font, size, Tc/Tw/Tz) of the paragraph, in points along the baseline. */
export interface LayoutStyle {
  /**
   * Advance of each character the original font can set (`TextAdvance`, as `analyzeRun`
   * reports it): `spaced` (inside the original object, its Tc/Tw/Tz applied) is what lines
   * are measured with, since rewritten lines reuse the original objects.
   */
  readonly advances: Readonly<Record<string, TextAdvance>>;
  /** The natural word gap of the paragraph in this style (a space, or the gap the producer left). */
  readonly wordGap: number;
  /** Kerning by pair (`'AV'`): displacement added after the first character (negative: closer). */
  readonly kerning?: Readonly<Record<string, number>>;
  /** The bundled face characters missing from the original font are set in, with its advances. */
  readonly substitute?: {
    readonly font: string;
    readonly advances: Readonly<Record<string, number>>;
    /** Characters set in another bundled face than `font` (it lacks them): their face. */
    readonly fonts?: Readonly<Record<string, string>>;
  };
}

/** A stretch of the paragraph's text in one style (UTF-16 offsets). */
export interface LayoutSpan {
  readonly start: number;
  readonly end: number;
  readonly style: string;
}

/** An original line of the paragraph; it ends where the next one starts. */
export interface LayoutSourceLine {
  /** UTF-16 offset of its first character in `LayoutInput.text`. */
  readonly start: number;
  /** Baseline, distance below the first line's baseline (points, positive downward). */
  readonly y: number;
  /** The line ended with a hyphen that the text joins (de-hyphenated: no separator). */
  readonly hyphenated?: boolean;
}

export type LayoutAlign = 'left' | 'right' | 'center' | 'justify';

/**
 * The paragraph as the layout needs it (T3's paragraph block maps onto this). Coordinates are
 * along the baseline in the paragraph's text space; lines go down by the leading.
 */
export interface LayoutInput {
  /**
   * The paragraph's text, de-hyphenated: original lines joined by their separator (usually one
   * space; nothing after a joined hyphen). `\n` is a line break typed by the user.
   */
  readonly text: string;
  readonly spans: readonly LayoutSpan[];
  readonly lines: readonly LayoutSourceLine[];
  readonly styles: Readonly<Record<string, LayoutStyle>>;
  /** Left and right edges of the measure; `firstIndent` moves the first line's left edge. */
  readonly measure: {
    readonly left: number;
    readonly right: number;
    readonly firstIndent?: number;
  };
  readonly align: LayoutAlign;
  /** Baseline-to-baseline distance for lines the paragraph did not have (points). */
  readonly leading: number;
  /** Character of the original line-end hyphens (default `-`). */
  readonly hyphenChar?: string;
}

/**
 * A stretch of a replacement's text in one style (UTF-16 offsets into `LayoutEdit.text`).
 * `source`: the stretch is original characters the user did not type, starting at this
 * offset of the original text (they keep their original style); absent for typed text, which
 * takes the style before the caret at the time it was typed.
 */
export interface LayoutEditSpan {
  readonly start: number;
  readonly end: number;
  readonly style: string;
  readonly source?: number;
}

/**
 * A replacement of `text.slice(start, end)` by `text`. Several separate changes in one
 * session are one replacement from the first change to the last; `spans` then gives every
 * character of `text` its own style (the untouched characters between the changes keep
 * theirs), so no character is restyled by a change elsewhere.
 */
export interface LayoutEdit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  /**
   * Style id of the inserted text where `spans` gives none (default: the style of the
   * character before the edit).
   */
  readonly style?: string;
  /** Per-character styles of `text` (see `LayoutEditSpan`); sorted, not overlapping. */
  readonly spans?: readonly LayoutEditSpan[];
}

/** Tightening factors (spec craft §4.6), applied to rewritten lines only. */
export interface LayoutOptions {
  /** Factor on the natural word gap (default 1). */
  readonly wordSpacing?: number;
  /** Factor on the leading of rewritten lines (default 1). */
  readonly leading?: number;
  /**
   * Rewrap the whole paragraph (every line `rewritten`, the factors on all of them): the
   * overflow policy's last resort before a run-over (spec craft §4.6). Default: from the
   * edited line, stopping where the rewrap converges.
   */
  readonly whole?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Width tolerance (points): a line this much too wide still fits. */
const FIT_EPSILON = 1e-6;
/** Justified gaps may stretch to this multiple of the natural gap (research 11 §4.3). */
export const MAX_GAP_STRETCH = 1.5;

const KIND_CHAR = 0;
const KIND_GAP = 1;
const KIND_NEWLINE = 2;
/** The second unit of a surrogate pair. */
const KIND_TRAIL = 3;

const FONT_ORIGINAL = 0;
const FONT_SUBSTITUTE = 1;
const FONT_NONE = 2;

function kindOf(ch: string): number {
  if (ch === ' ' || ch === '\t') return KIND_GAP;
  if (ch === '\n' || ch === '\r' || ch === ' ' || ch === ' ') return KIND_NEWLINE;
  return KIND_CHAR;
}

// ---------------------------------------------------------------------------
// Per-unit tables of the edited text
// ---------------------------------------------------------------------------

interface Tables {
  readonly text: string;
  readonly styleIds: readonly string[];
  readonly kind: Uint8Array;
  /** Advance (characters) or natural gap width (gaps), points. */
  readonly width: Float64Array;
  /** Kerning after a character, with the next one (same style, both in the original font). */
  readonly kern: Float64Array;
  readonly font: Uint8Array;
}

const meanAdvanceCache = new WeakMap<LayoutStyle, number>();

/** Width given to a character no font has (the edit is refused, but the caret still moves). */
function meanAdvance(style: LayoutStyle): number {
  let mean = meanAdvanceCache.get(style);
  if (mean === undefined) {
    const values = Object.values(style.advances).map((a) => a.spaced);
    mean =
      values.length > 0 ? values.reduce((sum, v) => sum + v, 0) / values.length : style.wordGap;
    meanAdvanceCache.set(style, mean);
  }
  return mean;
}

function glyphWidth(style: LayoutStyle, ch: string): { width: number; font: number } {
  const own = style.advances[ch];
  if (own) return { width: own.spaced, font: FONT_ORIGINAL };
  const sub = style.substitute?.advances[ch];
  if (sub !== undefined) return { width: sub, font: FONT_SUBSTITUTE };
  return { width: meanAdvance(style), font: FONT_NONE };
}

/** The bundled face a substituted character is set in. */
function substituteFontOf(style: LayoutStyle | undefined, ch: string): string | undefined {
  return style?.substitute?.fonts?.[ch] ?? style?.substitute?.font;
}

function buildTables(
  text: string,
  spans: readonly LayoutSpan[],
  styles: Readonly<Record<string, LayoutStyle>>,
  fallbackStyle: string,
): Tables {
  const n = text.length;
  const styleIds = new Array<string>(n).fill(fallbackStyle);
  for (const span of spans) {
    for (let i = Math.max(0, span.start); i < Math.min(n, span.end); i++) styleIds[i] = span.style;
  }
  const kind = new Uint8Array(n);
  const width = new Float64Array(n);
  const kern = new Float64Array(n);
  const font = new Uint8Array(n);
  let prev = -1;
  for (let i = 0; i < n; i++) {
    const cp = text.codePointAt(i) ?? 0;
    const ch = String.fromCodePoint(cp);
    const id = styleIds[i] ?? fallbackStyle;
    const style = styles[id];
    const k = kindOf(ch);
    kind[i] = k;
    if (style) {
      if (k === KIND_GAP) {
        width[i] = style.wordGap;
      } else if (k === KIND_CHAR) {
        const g = glyphWidth(style, ch);
        width[i] = g.width;
        font[i] = g.font;
      }
    }
    if (k === KIND_CHAR) {
      if (prev >= 0 && kind[prev] === KIND_CHAR && styleIds[prev] === id && style?.kerning) {
        if (font[prev] === FONT_ORIGINAL && font[i] === FONT_ORIGINAL) {
          const prevCh = String.fromCodePoint(text.codePointAt(prev) ?? 0);
          kern[prev] = style.kerning[prevCh + ch] ?? 0;
        }
      }
      prev = i;
    } else {
      prev = -1;
    }
    if (cp > 0xffff && i + 1 < n) {
      i += 1;
      kind[i] = KIND_TRAIL;
      styleIds[i] = id;
    }
  }
  return { text, styleIds, kind, width, kern, font };
}

/** Running width of a stretch of text: `nonGap + factor × gap`. */
class Measure {
  nonGap = 0;
  gap = 0;
  private pendingGap = 0;
  private pendingKern = 0;

  constructor(private readonly t: Tables) {}

  add(from: number, to: number): void {
    const { kind, width, kern } = this.t;
    for (let i = from; i < to; i++) {
      const k = kind[i];
      if (k === KIND_CHAR) {
        this.nonGap += this.pendingKern + (width[i] ?? 0);
        this.gap += this.pendingGap;
        this.pendingGap = 0;
        this.pendingKern = kern[i] ?? 0;
      } else if (k === KIND_GAP) {
        this.pendingGap += width[i] ?? 0;
        this.pendingKern = 0;
      } else if (k === KIND_NEWLINE) {
        this.pendingKern = 0;
      }
    }
  }

  width(factor: number): number {
    return this.nonGap + factor * this.gap;
  }
}

// ---------------------------------------------------------------------------
// Break opportunities
// ---------------------------------------------------------------------------

interface Opportunity {
  readonly position: number;
  readonly required: boolean;
  /** An original line-end hyphen: the line ends with the hyphen glyph. */
  readonly hyphen: boolean;
}

/** UAX #14 opportunities after `from`, merged with the kept hyphen positions (sorted). */
function opportunities(
  text: string,
  from: number,
  hyphens: readonly number[],
): () => Opportunity | undefined {
  const breaker = new LineBreaker(text.slice(from));
  let pending: LineBreakOpportunity | null = breaker.nextBreak();
  let h = 0;
  while (h < hyphens.length && (hyphens[h] ?? 0) <= from) h++;
  return () => {
    const hyphen = hyphens[h];
    const position = pending ? pending.position + from : Number.POSITIVE_INFINITY;
    if (hyphen !== undefined && hyphen < position) {
      h++;
      return { position: hyphen, required: false, hyphen: true };
    }
    if (!pending) return undefined;
    const out = { position, required: pending.required, hyphen: false };
    if (hyphen === position) h++;
    pending = breaker.nextBreak();
    return out;
  };
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** What the overflow policy needs beyond the layout (overflow.ts). */
export interface LayoutResult {
  readonly layout: ParagraphLayout;
  /**
   * For each rewritten line that ended because the next word did not fit: the word-spacing
   * factor at which it would (below the one used).
   */
  readonly thresholds: readonly number[];
}

interface BrokenLine {
  readonly start: number;
  readonly next: number;
  readonly hyphen: boolean;
  readonly overfull: boolean;
  readonly status: 'kept' | 'rewritten';
  readonly source?: number;
}

/**
 * Lays the paragraph out after `edit` (spec craft §4.3). Lines before the edited one come
 * back `kept`, the edited ones `rewritten`, and those after the point where the rewrap
 * converged `reused` with their vertical move.
 */
export function layoutParagraph(
  input: LayoutInput,
  edit: LayoutEdit,
  options: LayoutOptions = {},
): ParagraphLayout {
  return layoutWithThresholds(input, edit, options).layout;
}

export function layoutWithThresholds(
  input: LayoutInput,
  edit: LayoutEdit,
  options: LayoutOptions = {},
): LayoutResult {
  const f = options.wordSpacing ?? 1;
  const g = options.leading ?? 1;
  const old = input.text;
  const start = Math.max(0, Math.min(edit.start, old.length));
  const end = Math.max(start, Math.min(edit.end, old.length));
  const text = old.slice(0, start) + edit.text + old.slice(end);
  const delta = edit.text.length - (end - start);
  const insEnd = start + edit.text.length;
  const n = text.length;
  const oldLines: readonly LayoutSourceLine[] =
    input.lines.length > 0 ? input.lines : [{ start: 0, y: 0 }];
  const oldCount = oldLines.length;
  const oldNext = (j: number) => oldLines[j + 1]?.start ?? old.length;
  const oldY = (j: number) => oldLines[j]?.y ?? 0;
  const originalHeight = oldY(oldCount - 1);

  // Styles of the new text: the inserted text takes the caret's style.
  const styleAtOld = (i: number) => input.spans.find((s) => s.start <= i && i < s.end)?.style;
  const firstStyle = input.spans[0]?.style ?? Object.keys(input.styles)[0] ?? '';
  const insertStyle =
    edit.style ??
    (start > 0 ? styleAtOld(start - 1) : undefined) ??
    styleAtOld(start) ??
    firstStyle;
  const spans: LayoutSpan[] = [];
  for (const s of input.spans) {
    if (s.start < start)
      spans.push({ start: s.start, end: Math.min(s.end, start), style: s.style });
    if (s.end > end) {
      spans.push({ start: Math.max(s.start, end) + delta, end: s.end + delta, style: s.style });
    }
  }
  if (edit.text.length > 0) {
    // The inserted text's own styles where the edit gives them, else the caret's.
    let at = start;
    for (const s of edit.spans ?? []) {
      const from = Math.max(at, start + Math.max(0, s.start));
      const to = Math.min(insEnd, start + s.end);
      if (to <= from) continue;
      if (from > at) spans.push({ start: at, end: from, style: insertStyle });
      spans.push({ start: from, end: to, style: s.style });
      at = to;
    }
    if (at < insEnd) spans.push({ start: at, end: insEnd, style: insertStyle });
  }
  const t = buildTables(text, spans, input.styles, insertStyle);

  const whole = options.whole === true;
  const noChange = edit.text.length === 0 && start === end && !whole;
  // The edited line, and the one the rewrap starts at.
  let k = 0;
  for (let i = 0; i < oldCount; i++) if ((oldLines[i]?.start ?? 0) <= start) k = i;
  let first = whole ? 0 : k;
  if (k > 0 && !noChange && !whole) {
    let wordEnd = oldLines[k]?.start ?? 0;
    const limit = oldNext(k);
    while (wordEnd < limit && kindOf(old[wordEnd] ?? ' ') === KIND_CHAR) wordEnd++;
    if (start <= wordEnd) first = k - 1;
  }

  const broken: BrokenLine[] = [];
  for (let i = 0; i < (noChange ? oldCount : first); i++) {
    broken.push({
      start: oldLines[i]?.start ?? 0,
      next: oldNext(i),
      hyphen: oldLines[i]?.hyphenated === true && i + 1 < oldCount,
      overfull: false,
      status: 'kept',
      source: i,
    });
  }
  const thresholds: number[] = [];
  let converged: { readonly at: number; readonly source: number } | undefined;

  const indentOf = (index: number) => (index === 0 ? (input.measure.firstIndent ?? 0) : 0);
  const available = (index: number) => input.measure.right - input.measure.left - indentOf(index);
  const hyphenChar = input.hyphenChar ?? '-';
  const hyphenWidth = (before: number) => {
    const style = input.styles[t.styleIds[before] ?? ''];
    return style ? glyphWidth(style, hyphenChar).width : 0;
  };
  /** Index of the last unit of the character before `pos`. */
  const lastUnitBefore = (pos: number) =>
    pos >= 2 && t.kind[pos - 1] === KIND_TRAIL ? pos - 2 : pos - 1;

  if (!noChange) {
    // Original hyphen positions the edit did not touch, in the new text.
    const hyphens: number[] = [];
    for (let j = 0; j + 1 < oldCount; j++) {
      if (oldLines[j]?.hyphenated !== true) continue;
      const pos = oldNext(j);
      if (pos < start) hyphens.push(pos);
      else if (pos > end) hyphens.push(pos + delta);
    }
    const sourceEndingAt = new Map<number, number>();
    for (let j = 0; j + 1 < oldCount; j++) sourceEndingAt.set(oldNext(j), j);

    const lineStart0 = oldLines[first]?.start ?? 0;
    const nextOpportunity = opportunities(text, lineStart0, hyphens);
    let opp = nextOpportunity();
    let lineStart = lineStart0;
    while (lineStart < n && opp) {
      const index = broken.length;
      const avail = available(index);
      const measure = new Measure(t);
      let pos = lineStart;
      let chosen: Opportunity | undefined;
      let overfull = false;
      while (opp) {
        measure.add(pos, opp.position);
        pos = opp.position;
        const hyphen = opp.hyphen ? hyphenWidth(lastUnitBefore(opp.position)) : 0;
        if (measure.width(f) + hyphen <= avail + FIT_EPSILON) {
          chosen = opp;
          opp = nextOpportunity();
          if (chosen.required) break;
          continue;
        }
        if (!chosen) {
          chosen = opp;
          overfull = true;
          opp = nextOpportunity();
        } else if (measure.gap > 0) {
          const factor = (avail - measure.nonGap - hyphen) / measure.gap;
          if (factor < f) thresholds.push(factor);
        }
        break;
      }
      if (!chosen) break;
      const next = chosen.position;
      const source = oldLines[index];
      const kept =
        !whole &&
        index < oldCount &&
        source?.start === lineStart &&
        next <= start &&
        next === oldNext(index) &&
        chosen.hyphen === (source.hyphenated === true);
      broken.push({
        start: lineStart,
        next,
        hyphen: chosen.hyphen,
        overfull,
        status: kept ? 'kept' : 'rewritten',
        ...(kept ? { source: index } : {}),
      });
      lineStart = next;
      // Convergence: this line ends where an original one did, after the edit.
      if (!whole && next >= insEnd && next < n) {
        const j = sourceEndingAt.get(next - delta);
        if (j !== undefined && j >= first && chosen.hyphen === (oldLines[j]?.hyphenated === true)) {
          converged = { at: broken.length - 1, source: j };
          break;
        }
      }
    }
    // An emptied paragraph keeps one (empty) line; one ending with a typed line break gets
    // the empty line the caret is on.
    const last = broken[broken.length - 1];
    if (
      !converged &&
      (broken.length === 0 || (n > 0 && last?.next === n && t.kind[n - 1] === KIND_NEWLINE))
    ) {
      broken.push({ start: n, next: n, hyphen: false, overfull: false, status: 'rewritten' });
    }
  }

  // Place the lines.
  const lines: LayoutLine[] = [];
  const substituted = new Map<string, string>();
  const unsupported = new Set<string>();
  let ragged = false;
  let prevY = 0;
  for (const [index, line] of broken.entries()) {
    let y: number;
    if (line.status === 'kept') {
      y = oldY(line.source ?? index);
    } else if (index === 0) {
      y = oldY(0);
    } else {
      const step = index < oldCount ? oldY(index) - oldY(index - 1) : input.leading;
      y = prevY + step * g;
    }
    prevY = y;
    if (line.status === 'kept') {
      lines.push(keptLine(t, line, y, line.source ?? index, 'kept'));
      continue;
    }
    const placed = placeLine(t, input, line, index, y, f, available(index), n, {
      substituted,
      unsupported,
      hyphenChar,
    });
    if (placed.ragged) ragged = true;
    lines.push(placed);
  }
  if (converged) {
    const dy = prevY - oldY(converged.source);
    for (let j = converged.source + 1; j < oldCount; j++) {
      const s = oldLines[j]?.start ?? 0;
      lines.push(
        keptLine(
          t,
          {
            start: s + delta,
            next: oldNext(j) + delta,
            hyphen: oldLines[j]?.hyphenated === true && j + 1 < oldCount,
            overfull: false,
            status: 'kept',
          },
          oldY(j) + dy,
          j,
          'reused',
          dy,
        ),
      );
    }
  }

  const firstRewritten = lines.findIndex((l) => l.status === 'rewritten');
  const subs: LayoutSubstitution[] = [...substituted].map(([char, font]) => ({ char, font }));
  return {
    layout: {
      text,
      lines,
      lineDelta: lines.length - oldCount,
      firstRewritten,
      ragged,
      substituted: subs,
      unsupported: [...unsupported],
      height: lines[lines.length - 1]?.y ?? 0,
      originalHeight,
      wordSpacing: f,
      leading: g,
    },
    thresholds,
  };
}

/** End of the visible text of a line (trailing gaps and line breaks dropped). */
function contentEnd(t: Tables, start: number, next: number): number {
  let e = next;
  while (e > start && (t.kind[e - 1] === KIND_GAP || t.kind[e - 1] === KIND_NEWLINE)) e--;
  return e;
}

/** A kept or reused original line: only its place is new. */
function keptLine(
  t: Tables,
  line: BrokenLine,
  y: number,
  source: number,
  status: 'kept' | 'reused',
  dy = 0,
): LayoutLine {
  const end = contentEnd(t, line.start, line.next);
  return {
    status,
    source,
    start: line.start,
    end,
    next: line.next,
    text: t.text.slice(line.start, end),
    y,
    dy,
    x: 0,
    width: 0,
    justified: false,
    ragged: false,
    overfull: false,
    forced: line.next > 0 && t.kind[line.next - 1] === KIND_NEWLINE,
    words: [],
    runs: [],
  };
}

interface Honesty {
  readonly substituted: Map<string, string>;
  readonly unsupported: Set<string>;
  readonly hyphenChar: string;
}

/** Positions of a rewritten line's characters, words and runs. */
function placeLine(
  t: Tables,
  input: LayoutInput,
  line: BrokenLine,
  index: number,
  y: number,
  f: number,
  avail: number,
  n: number,
  honesty: Honesty,
): LayoutLine {
  const { start, next } = line;
  const end = contentEnd(t, start, next);
  const measure = new Measure(t);
  measure.add(start, end);
  const lastUnit = end >= 2 && t.kind[end - 1] === KIND_TRAIL ? end - 2 : end - 1;
  const hyphenStyleId = t.styleIds[lastUnit] ?? '';
  const hyphenStyle = input.styles[hyphenStyleId];
  const hyphenW =
    line.hyphen && hyphenStyle ? glyphWidth(hyphenStyle, honesty.hyphenChar).width : 0;
  const natural = measure.width(f) + hyphenW;
  const forced = next > 0 && t.kind[next - 1] === KIND_NEWLINE;
  const indent = index === 0 ? (input.measure.firstIndent ?? 0) : 0;
  const left = input.measure.left + indent;

  // Justification: slack on the word gaps only, each at most 1.5 × its natural width.
  let gapFactor = f;
  let justified = false;
  let ragged = false;
  const slack = avail - natural;
  if (input.align === 'justify' && !forced && next < n && !line.overfull) {
    if (measure.gap > 0 && f + slack / measure.gap <= MAX_GAP_STRETCH + FIT_EPSILON) {
      gapFactor = f + slack / measure.gap;
      justified = true;
    } else if (slack > FIT_EPSILON) {
      ragged = true;
    }
  }
  const width = justified ? avail : natural;
  let x0 = left;
  if (input.align === 'right') x0 = input.measure.right - width;
  else if (input.align === 'center') x0 = left + (avail - width) / 2;

  const words: LayoutWord[] = [];
  const runs: LayoutRun[] = [];
  let run:
    | {
        start: number;
        style: string;
        font: number;
        face?: string;
        x: number;
        kerning: number[];
        glyphs: number;
      }
    | undefined;
  let word: { start: number; x: number } | undefined;
  let x = x0;
  const closeRun = (at: number) => {
    // A run of word gaps alone carries nothing to write: the next run's x places the text.
    if (!run || run.glyphs === 0) {
      run = undefined;
      return;
    }
    const styleFont = run.face;
    runs.push({
      start: run.start,
      end: at,
      text: t.text.slice(run.start, at),
      style: run.style,
      ...(run.font === FONT_ORIGINAL || styleFont === undefined ? {} : { font: styleFont }),
      x: run.x,
      width: x - run.x,
      kerning: run.kerning,
    });
    run = undefined;
  };
  const closeWord = (at: number) => {
    if (!word) return;
    words.push({
      start: word.start,
      end: at,
      text: t.text.slice(word.start, at),
      x: word.x,
      width: x - word.x,
    });
    word = undefined;
  };
  for (let i = start; i < end; i++) {
    const kind = t.kind[i];
    if (kind === KIND_TRAIL || kind === KIND_NEWLINE) continue;
    const id = t.styleIds[i] ?? '';
    const style = input.styles[id];
    if (kind === KIND_GAP) {
      closeWord(i);
      const gapWidth = (t.width[i] ?? 0) * gapFactor;
      const ch = t.text[i] ?? ' ';
      const space = style?.advances[ch];
      if (!justified && space) {
        // The space glyph is written, with the gap's difference from it as an offset.
        if (run?.style !== id || run.font !== FONT_ORIGINAL) {
          closeRun(i);
          run = { start: i, style: id, font: FONT_ORIGINAL, x, kerning: [], glyphs: 0 };
        }
        run.kerning.push(gapWidth - space.spaced);
      } else {
        closeRun(i);
      }
      x += gapWidth;
      continue;
    }
    const font = t.font[i] ?? FONT_ORIGINAL;
    const cp = t.text.codePointAt(i) ?? 0;
    const ch = String.fromCodePoint(cp);
    const face = font === FONT_SUBSTITUTE ? substituteFontOf(style, ch) : undefined;
    if (font === FONT_SUBSTITUTE) {
      if (face !== undefined && !honesty.substituted.has(ch)) honesty.substituted.set(ch, face);
    } else if (font === FONT_NONE) {
      honesty.unsupported.add(ch);
    }
    if (run && (run.style !== id || run.font !== font || run.face !== face)) closeRun(i);
    run ??= {
      start: i,
      style: id,
      font,
      ...(face === undefined ? {} : { face }),
      x,
      kerning: [],
      glyphs: 0,
    };
    word ??= { start: i, x };
    const unitEnd = cp > 0xffff ? i + 2 : i + 1;
    const kern = unitEnd < end && t.kind[unitEnd] === KIND_CHAR ? (t.kern[i] ?? 0) : 0;
    run.kerning.push(kern);
    run.glyphs += 1;
    x += (t.width[i] ?? 0) + kern;
  }
  closeWord(end);
  closeRun(end);
  // A kept line-end hyphen follows the last character.
  const hyphen = line.hyphen ? { x, style: hyphenStyleId } : undefined;
  return {
    status: 'rewritten',
    start,
    end,
    next,
    text: t.text.slice(start, end),
    y,
    dy: 0,
    x: x0,
    width,
    justified,
    ragged,
    overfull: line.overfull,
    forced,
    ...(hyphen ? { hyphen } : {}),
    words,
    runs,
  };
}

/**
 * Kerning pairs of one style from a line of the original paragraph (research 11 §4.3): for
 * each pair of adjacent characters inside a word, the displacement written between them.
 * `chars` are the line's characters (one per code), `perCode` the `TJ` numbers after each
 * (`kerningPerCode`, thousandths of a text space unit, positive = move left), `size` the
 * font size and `scale` the horizontal scaling (`Tz` / 100). Recurring pairs keep their most
 * frequent value. Returns points, negative = closer, as `LayoutStyle.kerning` takes them.
 */
export function harvestKerning(
  lines: readonly { readonly chars: readonly string[]; readonly perCode: readonly number[] }[],
  size: number,
  scale = 1,
): Record<string, number> {
  const counts = new Map<string, Map<number, number>>();
  for (const { chars, perCode } of lines) {
    for (let i = 0; i + 1 < chars.length; i++) {
      const a = chars[i] ?? '';
      const b = chars[i + 1] ?? '';
      const tj = perCode[i] ?? 0;
      if (kindOf(a) !== KIND_CHAR || kindOf(b) !== KIND_CHAR || tj === 0) continue;
      const pair = a + b;
      const value = (-tj / 1000) * size * scale;
      const byValue = counts.get(pair) ?? new Map<number, number>();
      byValue.set(value, (byValue.get(value) ?? 0) + 1);
      counts.set(pair, byValue);
    }
  }
  const out: Record<string, number> = {};
  for (const [pair, byValue] of counts) {
    let best = 0;
    let bestCount = 0;
    for (const [value, count] of byValue) {
      if (count > bestCount) {
        best = value;
        bestCount = count;
      }
    }
    out[pair] = best;
  }
  return out;
}
