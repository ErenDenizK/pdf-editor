/**
 * The paragraph editor's model (craft spec §4.2, §4.7, §4.8; ADR-0020 §3, §7): the
 * paragraph's text with a style per character, the caret and the selection, the text
 * operations the hidden mirror turns keys into, and the per-keystroke layout. Pure: no DOM,
 * no engine call. A keystroke costs one `layoutParagraph` (and, when the paragraph grows,
 * `decideOverflow`) on cached advances, plus the caret geometry below.
 *
 * - **Text.** `ParagraphState.text` starts as the paragraph's de-hyphenated text
 *   (`ParagraphBlock.text`, equal to `LayoutInput.text`); `\n` is a line break the user typed.
 *   Every UTF-16 unit has a style id of the layout input. Typed text inherits the style of
 *   the character before the caret (the first character's at the start).
 * - **One edit.** However many keys were typed, the layout and the writer see one
 *   replacement of the original text (`paragraphEdit`: common prefix and suffix), so lines
 *   before the first change stay byte-identical (spec §4.3).
 * - **Caret geometry** (`caretLines`): per laid-out line, the x of every caret position in
 *   paragraph text space (the layout's runs and kerning for rewritten lines; the original
 *   line's edges for kept and reused lines, whose glyphs the writer leaves alone).
 */
import type {
  LayoutEdit,
  LayoutInput,
  LayoutLineStatus,
  LayoutOptions,
  LayoutStyle,
  LocatedRun,
  OverflowBox,
  OverflowDecision,
  ParagraphBlock,
  ParagraphLayout,
} from '@pdf-editor/engine';

// ---------------------------------------------------------------------------
// State and text operations
// ---------------------------------------------------------------------------

export interface ParagraphState {
  readonly text: string;
  /** Style id (a key of `LayoutInput.styles`) of each UTF-16 unit of `text`. */
  readonly styles: readonly string[];
  /** Selection ends (UTF-16 offsets): `anchor` stays, `focus` moves; equal for a caret. */
  readonly anchor: number;
  readonly focus: number;
  /** Where vertical moves aim (text-space x), kept across consecutive Up and Down. */
  readonly goalX?: number;
}

export interface TextRange {
  readonly start: number;
  readonly end: number;
}

/** The first style of the input (what an empty paragraph types in). */
function defaultStyle(input: LayoutInput): string {
  return input.spans[0]?.style ?? Object.keys(input.styles)[0] ?? '';
}

/** The style id of each UTF-16 unit of the input's text. */
export function stylesOf(input: LayoutInput): string[] {
  const out = new Array<string>(input.text.length).fill(defaultStyle(input));
  for (const span of input.spans) {
    const end = Math.min(span.end, out.length);
    for (let i = Math.max(0, span.start); i < end; i++) out[i] = span.style;
  }
  return out;
}

function clampOffset(text: string, offset: number): number {
  const at = Math.max(0, Math.min(offset, text.length));
  // Never inside a surrogate pair.
  return isTrail(text, at) ? at - 1 : at;
}

function isTrail(text: string, at: number): boolean {
  const code = text.charCodeAt(at);
  const before = text.charCodeAt(at - 1);
  return at > 0 && code >= 0xdc00 && code <= 0xdfff && before >= 0xd800 && before <= 0xdbff;
}

export function initialState(input: LayoutInput, caret: number): ParagraphState {
  const at = clampOffset(input.text, caret);
  return { text: input.text, styles: stylesOf(input), anchor: at, focus: at };
}

export function selectionOf(state: ParagraphState): TextRange {
  return {
    start: Math.min(state.anchor, state.focus),
    end: Math.max(state.anchor, state.focus),
  };
}

export function isCollapsed(state: ParagraphState): boolean {
  return state.anchor === state.focus;
}

/** The style typed text takes at `offset`: the character before it, else the one after. */
export function styleAt(state: ParagraphState, offset: number, fallback = ''): string {
  return state.styles[offset - 1] ?? state.styles[offset] ?? fallback;
}

/** Replaces `range` by `insert` (typed: the style before the range), caret after it. */
export function replaceRange(
  state: ParagraphState,
  range: TextRange,
  insert: string,
  style?: string,
): ParagraphState {
  const start = clampOffset(state.text, range.start);
  const end = Math.max(start, clampOffset(state.text, range.end));
  const typed = style ?? styleAt(state, start, state.styles[0]);
  const text = state.text.slice(0, start) + insert + state.text.slice(end);
  const styles = [
    ...state.styles.slice(0, start),
    ...new Array<string>(insert.length).fill(typed),
    ...state.styles.slice(end),
  ];
  const caret = start + insert.length;
  return { text, styles, anchor: caret, focus: caret };
}

/** Types `insert` over the selection. */
export function insertText(state: ParagraphState, insert: string): ParagraphState {
  return replaceRange(state, selectionOf(state), insert);
}

/** The previous caret stop (one code point back). */
export function previousStop(text: string, offset: number): number {
  if (offset <= 0) return 0;
  return isTrail(text, offset - 1) ? offset - 2 : offset - 1;
}

/** The next caret stop (one code point on). */
export function nextStop(text: string, offset: number): number {
  if (offset >= text.length) return text.length;
  return isTrail(text, offset + 1) ? offset + 2 : offset + 1;
}

const SPACE = /\s/u;

/** Start of the word before `offset` (Mod/Alt+Left, Mod/Alt+Backspace). */
export function wordStartBefore(text: string, offset: number): number {
  let at = offset;
  while (at > 0 && SPACE.test(text[at - 1] ?? '')) at -= 1;
  while (at > 0 && !SPACE.test(text[at - 1] ?? '')) at -= 1;
  return at;
}

/** End of the word after `offset` (Mod/Alt+Right, Mod/Alt+Delete). */
export function wordEndAfter(text: string, offset: number): number {
  let at = offset;
  while (at < text.length && SPACE.test(text[at] ?? '')) at += 1;
  while (at < text.length && !SPACE.test(text[at] ?? '')) at += 1;
  return at;
}

/** The word (or the run of spaces) around `offset`: a double-click. */
export function wordRange(text: string, offset: number): TextRange {
  const blank = (ch: string | undefined) => ch === undefined || SPACE.test(ch);
  let at = Math.max(0, Math.min(offset, text.length));
  if (blank(text[at]) && !blank(text[at - 1])) at -= 1;
  const kind = blank(text[at]);
  let start = at;
  let end = at;
  while (start > 0 && blank(text[start - 1]) === kind) start -= 1;
  while (end < text.length && blank(text[end]) === kind) end += 1;
  return { start, end };
}

/** Backspace: the selection, else the code point (or the word) before the caret. */
export function deleteBackward(
  state: ParagraphState,
  unit: 'char' | 'word' = 'char',
): ParagraphState {
  if (!isCollapsed(state)) return replaceRange(state, selectionOf(state), '');
  const end = state.focus;
  const start = unit === 'word' ? wordStartBefore(state.text, end) : previousStop(state.text, end);
  if (start === end) return state;
  return replaceRange(state, { start, end }, '');
}

/** Delete: the selection, else the code point (or the word) after the caret. */
export function deleteForward(
  state: ParagraphState,
  unit: 'char' | 'word' = 'char',
): ParagraphState {
  if (!isCollapsed(state)) return replaceRange(state, selectionOf(state), '');
  const start = state.focus;
  const end = unit === 'word' ? wordEndAfter(state.text, start) : nextStop(state.text, start);
  if (start === end) return state;
  return replaceRange(state, { start, end }, '');
}

/** The state without a vertical goal (any move but Up and Down). */
function withoutGoal(state: ParagraphState): ParagraphState {
  const { goalX: _goal, ...rest } = state;
  return rest;
}

export function selectAll(state: ParagraphState): ParagraphState {
  return { ...withoutGoal(state), anchor: 0, focus: state.text.length };
}

/** Moves the focus to `offset`; `extend` keeps the anchor (Shift). */
export function moveTo(
  state: ParagraphState,
  offset: number,
  extend: boolean,
  goalX?: number,
): ParagraphState {
  const focus = clampOffset(state.text, offset);
  const next: ParagraphState = { ...state, focus, anchor: extend ? state.anchor : focus };
  return goalX === undefined ? withoutGoal(next) : { ...next, goalX };
}

/** Left/Right: collapses a selection to its side, else steps one code point or word. */
export function moveHorizontal(
  state: ParagraphState,
  direction: -1 | 1,
  extend: boolean,
  unit: 'char' | 'word' = 'char',
): ParagraphState {
  if (!extend && !isCollapsed(state) && unit === 'char') {
    const range = selectionOf(state);
    return moveTo(state, direction < 0 ? range.start : range.end, false);
  }
  const from = state.focus;
  const to =
    direction < 0
      ? unit === 'word'
        ? wordStartBefore(state.text, from)
        : previousStop(state.text, from)
      : unit === 'word'
        ? wordEndAfter(state.text, from)
        : nextStop(state.text, from);
  return moveTo(state, to, extend);
}

/**
 * The change from the original text as one replacement (common prefix and suffix), typed
 * in the style of its first inserted character; null when the text is unchanged.
 */
export function paragraphEdit(original: string, state: ParagraphState): LayoutEdit | null {
  const { text } = state;
  if (text === original) return null;
  let start = 0;
  const max = Math.min(text.length, original.length);
  while (start < max && text.charCodeAt(start) === original.charCodeAt(start)) start += 1;
  let suffix = 0;
  while (
    suffix < max - start &&
    text.charCodeAt(text.length - 1 - suffix) === original.charCodeAt(original.length - 1 - suffix)
  ) {
    suffix += 1;
  }
  // Keep surrogate pairs whole on both sides.
  if (isTrail(original, start) || isTrail(text, start)) start -= 1;
  let end = original.length - suffix;
  let insertEnd = text.length - suffix;
  if (isTrail(original, end) || isTrail(text, insertEnd)) {
    end += 1;
    insertEnd += 1;
  }
  const insert = text.slice(start, insertEnd);
  const style = insert.length > 0 ? state.styles[start] : undefined;
  return { start, end, text: insert, ...(style === undefined ? {} : { style }) };
}

// ---------------------------------------------------------------------------
// Layout (per keystroke, main thread)
// ---------------------------------------------------------------------------

/** The pure layout functions (`@pdf-editor/engine`, loaded with the editor). */
export interface LayoutFunctions {
  readonly layoutParagraph: (
    input: LayoutInput,
    edit: LayoutEdit,
    options?: LayoutOptions,
  ) => ParagraphLayout;
  readonly decideOverflow: (
    layout: ParagraphLayout,
    box: OverflowBox,
    gapBelow: number,
  ) => OverflowDecision;
}

/** What the layout of an open paragraph needs besides its text (asked once at open). */
export interface ParagraphSetup {
  readonly block: ParagraphBlock;
  readonly input: LayoutInput;
  /** The original gap to the block below, kept when the paragraph grows (points). */
  readonly paragraphGap: number;
  /** Empty space below the paragraph's last line down to the next block (points). */
  readonly gapBelow: number;
}

export interface ParagraphRelayout {
  readonly edit: LayoutEdit | null;
  /** The layout as it will be written (tightened when the policy tightens). */
  readonly layout: ParagraphLayout;
  readonly decision: OverflowDecision;
}

const NO_EDIT: LayoutEdit = { start: 0, end: 0, text: '' };

/** Lays the paragraph out for the state's text and applies the overflow policy. */
export function relayout(
  fns: LayoutFunctions,
  setup: ParagraphSetup,
  state: ParagraphState,
): ParagraphRelayout {
  const edit = paragraphEdit(setup.input.text, state);
  const used = edit ?? NO_EDIT;
  const natural = fns.layoutParagraph(setup.input, used);
  const decision =
    edit === null
      ? ({ kind: 'commit', layout: natural } as const)
      : fns.decideOverflow(
          natural,
          { input: setup.input, edit: used, paragraphGap: setup.paragraphGap },
          setup.gapBelow,
        );
  return { edit, layout: decision.layout, decision };
}

// ---------------------------------------------------------------------------
// Caret geometry
// ---------------------------------------------------------------------------

/** One laid-out line with the x of each caret position (paragraph text space). */
export interface CaretLine {
  readonly status: LayoutLineStatus;
  /** Original line (kept and reused lines). */
  readonly source?: number;
  readonly start: number;
  readonly end: number;
  readonly next: number;
  /** Text-space y of the baseline (up is positive, as `ParagraphLine.baseline`). */
  readonly baseline: number;
  /** Reused lines: their move from the original baseline (points, positive downward). */
  readonly dy: number;
  /** Size on the page of the line (points): the caret's height. */
  readonly size: number;
  /** `xs[k]`: x of the caret before `text[start + k]`, for k in 0 … end − start. */
  readonly xs: Float64Array;
}

/** Calls `fn` for each code point of `text[from, to)` with its UTF-16 offset (no allocation per step but the character). */
function eachCodePoint(
  text: string,
  from: number,
  to: number,
  fn: (offset: number, ch: string) => void,
): void {
  let i = from;
  while (i < to) {
    const code = text.charCodeAt(i);
    const pair = code >= 0xd800 && code <= 0xdbff && i + 1 < text.length;
    const ch = pair ? text.slice(i, i + 2) : (text[i] ?? '');
    fn(i, ch);
    i += ch.length || 1;
  }
}

const meanAdvances = new WeakMap<LayoutStyle, number>();

/** Advance of `ch` in a style: the original font, the substitute, else the mean advance. */
export function advanceOf(style: LayoutStyle | undefined, ch: string): number {
  if (!style) return 0;
  const own = style.advances[ch];
  if (own) return own.spaced;
  const sub = style.substitute?.advances[ch];
  if (sub !== undefined) return sub;
  if (ch === ' ' || ch === '\t') return style.wordGap;
  let mean = meanAdvances.get(style);
  if (mean === undefined) {
    let sum = 0;
    let count = 0;
    for (const key in style.advances) {
      sum += style.advances[key]?.spaced ?? 0;
      count += 1;
    }
    mean = count > 0 ? sum / count : style.wordGap;
    meanAdvances.set(style, mean);
  }
  return mean;
}

function fillGaps(xs: Float64Array, set: Uint8Array): void {
  const n = xs.length;
  let last = -1;
  for (let k = 0; k < n; k++) {
    if (!set[k]) continue;
    if (last >= 0 && k - last > 1) {
      const from = xs[last] ?? 0;
      const to = xs[k] ?? from;
      for (let j = last + 1; j < k; j++) xs[j] = from + ((to - from) * (j - last)) / (k - last);
    } else if (last < 0) {
      for (let j = 0; j < k; j++) xs[j] = xs[k] ?? 0;
    }
    last = k;
  }
  if (last < 0) return;
  for (let j = last + 1; j < n; j++) xs[j] = xs[last] ?? 0;
}

/**
 * Caret positions of every laid-out line. Rewritten lines follow the layout's runs (advance
 * plus kerning per character; gaps between runs are shared out); kept and reused lines spread
 * the characters' advances over the original line's edges (the extra width on word gaps when
 * the paragraph is justified).
 */
export function caretLines(
  setup: ParagraphSetup,
  state: ParagraphState,
  layout: ParagraphLayout,
): CaretLine[] {
  const { block, input } = setup;
  const top = block.lines[0]?.baseline ?? 0;
  const hyphen = input.hyphenChar ?? '-';
  const fallback = defaultStyle(input);
  const styleOf = (offset: number) => input.styles[state.styles[offset] ?? fallback];
  return layout.lines.map((line) => {
    const n = Math.max(0, line.end - line.start);
    const xs = new Float64Array(n + 1);
    const original = line.source === undefined ? undefined : block.lines[line.source];
    if (line.status === 'rewritten' || !original) {
      const set = new Uint8Array(n + 1);
      for (const run of line.runs) {
        let x = run.x;
        let k = 0;
        eachCodePoint(layout.text, run.start, run.end, (offset, ch) => {
          const at = offset - line.start;
          if (at >= 0 && at <= n) {
            xs[at] = x;
            set[at] = 1;
          }
          x += advanceOf(styleOf(offset), ch) + (run.kerning[k] ?? 0);
          k += 1;
        });
        const end = run.end - line.start;
        if (end >= 0 && end <= n && !set[end]) {
          xs[end] = x;
          set[end] = 1;
        }
      }
      if (!set.some((v) => v === 1)) {
        xs[0] = line.x;
        set[0] = 1;
      }
      fillGaps(xs, set);
    } else {
      const widths: number[] = [];
      const gaps: number[] = [];
      let natural = 0;
      eachCodePoint(layout.text, line.start, line.end, (offset, ch) => {
        const w = advanceOf(styleOf(offset), ch);
        widths.push(w);
        if (ch === ' ') gaps.push(widths.length - 1);
        natural += w;
      });
      const hyphenWidth =
        original.end === 'joined' ? advanceOf(styleOf(Math.max(0, line.end - 1)), hyphen) : 0;
      const available = Math.max(0, original.x1 - original.x0 - hyphenWidth);
      const extra = available - natural;
      const onGaps = block.align === 'justify' && gaps.length > 0 && extra > 0;
      const scale = onGaps || natural <= 0 ? 1 : available / natural;
      const perGap = onGaps ? extra / gaps.length : 0;
      let x = original.x0;
      let index = 0;
      eachCodePoint(layout.text, line.start, line.end, (offset, ch) => {
        const at = offset - line.start;
        xs[at] = x;
        // Fill the trail unit of a surrogate pair with the same x.
        if (ch.length > 1 && at + 1 <= n) xs[at + 1] = x;
        x += (widths[index] ?? 0) * scale + (ch === ' ' ? perGap : 0);
        index += 1;
      });
      xs[n] = x;
    }
    return {
      status: line.status,
      ...(line.source === undefined ? {} : { source: line.source }),
      start: line.start,
      end: line.end,
      next: line.next,
      baseline: top - line.y,
      dy: line.dy,
      size: original?.size ?? block.size,
      xs,
    };
  });
}

/** The line showing the caret at `offset` and its x. */
export function caretAt(
  lines: readonly CaretLine[],
  offset: number,
): { readonly line: number; readonly x: number } {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    // A line owns [start, next): the joining space shows the caret at its visible end.
    if (offset < line.next || i === lines.length - 1) {
      const k = Math.max(line.start, Math.min(offset, line.end)) - line.start;
      return { line: i, x: line.xs[Math.min(k, line.xs.length - 1)] ?? 0 };
    }
  }
  return { line: 0, x: 0 };
}

/** The caret offset nearest to `x` on one line. */
export function offsetOnLine(line: CaretLine, x: number): number {
  let best = 0;
  let distance = Number.POSITIVE_INFINITY;
  for (let k = 0; k < line.xs.length; k++) {
    const d = Math.abs((line.xs[k] ?? 0) - x);
    if (d < distance) {
      distance = d;
      best = k;
    }
  }
  return line.start + best;
}

/** The caret offset nearest to a text-space point (a click on the canvas). */
export function offsetAtPoint(
  lines: readonly CaretLine[],
  point: { readonly x: number; readonly y: number },
): number {
  let best: CaretLine | undefined;
  let distance = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    // Lines own the band from their descent to their ascent; nearest baseline otherwise.
    const middle = line.baseline + line.size * 0.3;
    const d = Math.abs(point.y - middle);
    if (d < distance) {
      distance = d;
      best = line;
    }
  }
  return best ? offsetOnLine(best, point.x) : 0;
}

/** Up/Down: the nearest position to the goal x on the line above or below. */
export function moveVertical(
  state: ParagraphState,
  lines: readonly CaretLine[],
  direction: -1 | 1,
  extend: boolean,
): ParagraphState {
  const here = caretAt(lines, state.focus);
  const goalX = state.goalX ?? here.x;
  const target = lines[here.line + direction];
  if (!target) {
    return moveTo(state, direction < 0 ? 0 : state.text.length, extend, goalX);
  }
  return moveTo(state, offsetOnLine(target, goalX), extend, goalX);
}

/** Home/End: the start or the visible end of the caret's line. */
export function moveLineEdge(
  state: ParagraphState,
  lines: readonly CaretLine[],
  edge: 'start' | 'end',
  extend: boolean,
): ParagraphState {
  const line = lines[caretAt(lines, state.focus).line];
  if (!line) return state;
  return moveTo(state, edge === 'start' ? line.start : line.end, extend);
}

/**
 * The selection as one text-space rectangle per line it touches (`y0` below the baseline,
 * `y1` above it).
 */
export function selectionRects(
  lines: readonly CaretLine[],
  range: TextRange,
): { x0: number; x1: number; y0: number; y1: number }[] {
  if (range.start >= range.end) return [];
  const out: { x0: number; x1: number; y0: number; y1: number }[] = [];
  lines.forEach((line, i) => {
    const last = i === lines.length - 1;
    const owned = last ? Number.POSITIVE_INFINITY : line.next;
    if (range.start >= owned || range.end <= line.start) return;
    const from = Math.max(range.start, line.start);
    const to = Math.min(range.end, line.end);
    const x0 = line.xs[Math.min(from, line.end) - line.start] ?? 0;
    let x1 = line.xs[Math.max(from, to) - line.start] ?? x0;
    // Selected past the visible end (the joining space or a line break): show a sliver.
    if (range.end > line.end && !last) x1 += line.size * 0.25;
    if (x1 <= x0) return;
    out.push({
      x0,
      x1,
      y0: line.baseline - line.size * 0.25,
      y1: line.baseline + line.size * 0.9,
    });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Opening: which paragraph, and where the caret goes
// ---------------------------------------------------------------------------

/** Offset of each span's text in its line's text (`ParagraphLine.text` joins them). */
function spanOffsets(line: ParagraphBlock['lines'][number]): number[] {
  const out: number[] = [];
  let cursor = 0;
  for (const span of line.spans) {
    const at = span.text === '' ? cursor : line.text.indexOf(span.text, cursor);
    out.push(at < 0 ? cursor : at);
    if (at >= 0) cursor = at + span.text.length;
  }
  return out;
}

function sameRun(
  a: {
    readonly objectPath: readonly number[];
    readonly charStart: number;
    readonly charCount: number;
  },
  b: {
    readonly objectPath: readonly number[];
    readonly charStart: number;
    readonly charCount: number;
  },
): boolean {
  if (a.objectPath.length !== b.objectPath.length) return false;
  if (a.objectPath.some((v, i) => v !== b.objectPath[i])) return false;
  // Runs overlap on the text page (a run cut by a wide gap belongs to several blocks).
  return a.charStart < b.charStart + b.charCount && b.charStart < a.charStart + a.charCount;
}

/**
 * The detected paragraph holding `run` at its UTF-16 offset `offset` (a click of the Edit
 * text tool), with the matching offset in the paragraph's text.
 */
export function paragraphOfRun(
  blocks: readonly ParagraphBlock[],
  run: LocatedRun,
  offset: number,
): { readonly block: ParagraphBlock; readonly offset: number } | undefined {
  // The glyph the offset falls on.
  let glyph = 0;
  let consumed = 0;
  for (const g of run.glyphs) {
    if (consumed >= offset) break;
    consumed += Math.max(1, g.text.length);
    glyph += 1;
  }
  const charIndex = run.charStart + glyph;
  for (const block of blocks) {
    const index = block.ref.runs.findIndex((r) => sameRun(r, run));
    if (index < 0) continue;
    for (const line of block.lines) {
      const offsets = spanOffsets(line);
      for (let s = 0; s < line.spans.length; s++) {
        const span = line.spans[s];
        const ref = block.ref.runs[span?.run ?? -1];
        if (!span || !ref || !sameRun(ref, run)) continue;
        // The span's glyphs in text-page indices of the clicked run.
        const first = ref.charStart + span.glyphStart;
        const last = ref.charStart + span.glyphEnd;
        if (charIndex < first || charIndex > last) continue;
        const within = Math.min(span.text.length, charIndex - first);
        return { block, offset: line.start + (offsets[s] ?? 0) + within };
      }
    }
    return { block, offset: block.lines[0]?.start ?? 0 };
  }
  return undefined;
}

/** A user-space point in the paragraph's text space. */
export function toTextSpace(
  block: Pick<ParagraphBlock, 'direction'>,
  point: { readonly x: number; readonly y: number },
): { x: number; y: number } {
  const d = block.direction;
  return { x: point.x * d.x + point.y * d.y, y: -point.x * d.y + point.y * d.x };
}

/**
 * The caret offset nearest to a user-space point from the block's own geometry (before the
 * layout input arrives): the nearest line, characters spread evenly over each span.
 */
export function offsetNearPoint(
  block: ParagraphBlock,
  point: { readonly x: number; readonly y: number },
): number {
  const p = toTextSpace(block, point);
  let line = block.lines[0];
  let distance = Number.POSITIVE_INFINITY;
  for (const l of block.lines) {
    const d = Math.abs(p.y - (l.baseline + l.size * 0.3));
    if (d < distance) {
      distance = d;
      line = l;
    }
  }
  if (!line) return 0;
  const offsets = spanOffsets(line);
  let best = line.start;
  let bestDistance = Number.POSITIVE_INFINITY;
  line.spans.forEach((span, s) => {
    const n = span.text.length;
    for (let k = 0; k <= n; k++) {
      const x = span.x0 + (n > 0 ? ((span.x1 - span.x0) * k) / n : 0);
      const d = Math.abs(p.x - x);
      if (d < bestDistance) {
        bestDistance = d;
        best = line.start + (offsets[s] ?? 0) + k;
      }
    }
  });
  return best;
}
