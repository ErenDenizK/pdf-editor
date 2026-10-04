/**
 * Paragraph detection (spec craft §4.1–§4.2, ADR-0020 §2, research 11 §3): the located runs
 * of a page become paragraphs (`ParagraphBlock`), structure tree first, geometry for the
 * rest. Pure: no engine call; `HostedTextEditor.analyzeParagraphs` feeds it `locatePage`'s
 * runs and `readParagraphTags`' tags.
 *
 * Everything works in **text space** (see `ParagraphBlock` in `types.ts`): runs are grouped
 * by writing direction (1° buckets) and projected onto it, so rotated text reads like
 * horizontal text. Invisible runs (OCR layers) form their own group. Vertical runs are one
 * refused block each.
 *
 * 1. **Pieces.** A run is cut where two glyphs are more than 3 × space apart (a tab stop, a
 *    table row drawn by one object), or 8 × space when a space glyph stands in the gap (a
 *    stretched space of a justified line). The space width is the page's median space
 *    advance over font size (from space glyphs to the next glyph on the line, default
 *    0.25 em), times the piece's size. Left edges are glyph origins; right edges are the end
 *    of the last glyph's advance when it ends its run (the run's loose box), else its ink.
 * 2. **Drop caps.** A piece of at most two letters, at least twice the size of two or more
 *    lines just to its right whose baselines lie within its height, is a drop cap: it is
 *    attached to the top line's paragraph, which is refused (`drop-cap`).
 * 3. **Structure tree.** Runs whose MCIDs belong to one `/P`, `/LI` (with its `/Lbl` and
 *    `/LBody`), `/LBody` or `/H1`–`/H6` form one paragraph (`source: 'tags'`). A group whose
 *    lines are not vertically contiguous (a pitch over 2 × size, lines that do not overlap
 *    along the line, or another piece between two of its lines) falls back to geometry.
 * 4. **Columns and reading order.** Recursive XY-cut on the pieces: a vertical channel at
 *    least 2 × space wide in a region of at least 3 lines splits it into columns (left
 *    first), unless the left side is only list markers; otherwise the widest horizontal gap
 *    splits it (top first). Lines never cross a channel, and blocks are returned in this
 *    order (a table therefore reads column by column).
 * 5. **Lines.** In each XY-cut leaf, pieces whose baselines are within 0.2 × size form a
 *    line, split again at gaps over 3 × space (8 × space with a space glyph in the gap; a
 *    lone list marker keeps text up to 4 × size away). A gap is kept, whatever its width,
 *    when a same-size line within 2 × size above or below has ink at its middle: a
 *    justified line's stretched space, not a gutter or a gap between cells. A short piece
 *    at most 0.8 × the size, within 0.6 × size of a line's baseline and touching it, is a
 *    superscript or subscript of that line.
 * 6. **Tables.** `tableRows` (from the Markdown converter: three or more consecutive rows of
 *    three or more line segments, two cell starts aligned) gives one box per segment
 *    (`kind: 'cell'`), unless the median segment is 25 characters or longer (three columns
 *    of body text).
 * 7. **Paragraphs.** Each line joins the paragraph of the nearest line above it in its
 *    column that overlaps it along the line, when that line ends its paragraph and:
 *    - no list marker starts it (`listMarker`: `•`, `–`, `1.`, `a)`…);
 *    - the dominant family, weight and size match (size within 0.5 pt);
 *    - the baseline pitch is over 0.5 × size, at most 1.6 × size, and within ±15 % of the
 *      paragraph's running leading (the first pair sets it);
 *    - the white space between the lines is at most `blockBreakGap(size, gap)` (from
 *      `toBlocks`: `max(0.6·size, min(1.5·gap + 1, 1.3·size))`, with `gap` the column's
 *      median gap between same-style lines) and not below −0.5 × size;
 *    - the left edges align within one space, or it is a first-line indent (the first line
 *      starts right of the second, by at most 4 × size), a hanging indent (the first line
 *      starts with a list marker), or the line returns under a drop cap; or the centres, or
 *      the right edges, align within one space (centred, right-aligned text);
 *    - the line above reaches at least 85 % of the paragraph's measure, or the new line's
 *      first word would not have fitted after it (a ragged line broken early for a long
 *      word), unless the paragraph can still be centred or right-aligned.
 * 8. **Alignment** (edges as in step 1). Over the non-final lines (the first line's left edge left out when it is
 *    indented): left and right edges both varying under 0.5 pt is `justify` (with two
 *    lines: the first line ends within 0.5 pt of a right edge that at least three lines of
 *    the column share); else left edges within one space `left`, right edges `right`,
 *    centres `center`. A single line is centred when its centre is within one space of its
 *    column's and it starts more than 2 spaces in, right-aligned when it ends within one
 *    space of the column's right edge and starts more than 2 spaces in, else left.
 * 9. **Text.** Line text keeps the space glyphs and adds a space where two runs are more
 *    than 0.8 × space apart, or, on a page with no space glyph at all (pdfTeX), where the ink
 *    gap inside a run exceeds 0.15 × size. A line-end hyphen (flagged by
 *    `FPDFText_IsHyphen`, or a hyphen after a letter) before a lower-case start is dropped
 *    and the word joined; before anything else it stays, with no space (`Jean-Paul`); a
 *    soft hyphen always joins. This is the Markdown converter's rule (`convert/markdown.ts`).
 * 10. **Wrap measure** (`wrapRight`, left-aligned blocks only; others keep their own). The
 *    smallest filled or stroked path whose bounds hold the block's lines and glyphs (within
 *    0.5 pt) bounds it: its right edge minus the inset the text has from its left edge
 *    (padding taken equal on both sides), unless another block in that box overlaps the
 *    block's lines vertically (a page-wide background behind two columns). Without such a
 *    box, the column's: the furthest right edge of the blocks that share its horizontal
 *    extent. Either way it stops one size short of a block beside it (to its right, with
 *    lines at the same height), never passes the page, and is never left of the block's own
 *    longest line.
 * 11. **Hard line breaks** (`end: 'forced'`, `\n` in the text instead of the space). The
 *    measure runs from the block's left edge to its box's inner edge (step 10), or without
 *    a box to the end of its own longest line (a column's edge is too weak a hint: a
 *    footnote across two columns widens it). A line that is not the last and reaches less
 *    than 85 % of it ends in a hard break when the next line's first word would have
 *    fitted after it (a typesetter would have put it there), or when
 *    the next line is one word that is itself short (an e-mail address or URL in an
 *    address), which counts before the last line only when the block has another hard
 *    break. A line ending in a hyphen never does. Tagged and geometric blocks alike; a
 *    tagged block's hard-break lines are left out of the justification test (step 8).
 *
 * Known failure modes (research 11 §3.4) and what the user sees:
 * - Two columns with a gutter under 2 × space, or with fewer than 3 lines: no channel; lines
 *   still break at gaps over 3 × space, and the join rules rarely join across (left edges
 *   differ), but reading order may interleave. "Split here" / "Join with next" correct it.
 * - Short lines of similar length (addresses, verse, a list without markers) join into one
 *   paragraph: each line reaches 85 % of the others. Step 11 then marks their breaks hard
 *   (all of them inside a box wider than the lines), so a rewrap keeps them.
 * - Without a box, hard breaks are judged on the block's own longest line: an address whose
 *   longest line is followed by another keeps that break soft, and a line before a word too
 *   long to fit that is followed by more words too. Editing such a line can pull words up.
 * - A soft break is taken for a hard one when a paragraph was wrapped narrower than its box
 *   allows (a right padding larger than the left): the paragraph then keeps its lines, and
 *   only the edited line grows.
 * - A justified line with a gap wider than 3 × space and no space glyph, next to lines with
 *   their own gaps at that place, splits in two.
 * - A heading in the body size and weight is a paragraph; a bold single line of up to 80
 *   characters without final punctuation, or a size of at least 1.15 × the body's, is a
 *   heading.
 * - Captions set in the body's font and size, close to the text, join it.
 * - A paragraph continued in the next column, or on the next page, is two paragraphs.
 * - A multi-line table cell is one box per line; a table whose rows have fewer than three
 *   cells is read as text; three or more columns of short text lines read as a table.
 * - Lines spaced more than 1.6 × size apart (double spacing) are one paragraph each.
 * - Two-line paragraphs may be classed `left` instead of `justify` and the reverse.
 * - A drop cap is refused, never edited: its text joins the first line without a space.
 * - Tags that are wrong but contiguous (one `/P` per line, a `/P` holding two paragraphs)
 *   are trusted.
 * - Glyph boxes of text rotated by other than a multiple of 90° are projected bounding
 *   boxes, so edges are slightly wide.
 */
import type { Rect, SourceId } from '@pdf-editor/document-model';

import { blockBreakGap, type ListMarker, listMarker, median, tableRows } from '../convert/layout';
import type {
  LocatedRun,
  ParagraphAlign,
  ParagraphBlock,
  ParagraphLine,
  ParagraphLineEnd,
  ParagraphRefusal,
  ParagraphSpan,
  TextRunRef,
} from '../types';
import { locatePage } from './locate';
import type { RawText } from './raw';
import { type ParagraphTag, readParagraphTags } from './struct-tree';

/** The page box the runs sit on (unrotated user space) and its /Rotate. */
export interface PageGeometry {
  readonly width: number;
  readonly height: number;
  /** /Rotate in degrees. Detection works in text space, so it does not depend on it. */
  readonly rotation: number;
  /** Lower-left corner of the box (default 0, 0). */
  readonly x?: number;
  readonly y?: number;
}

// --- Thresholds (see the module comment) ---

/** Default space advance over font size when the page has no space glyph to measure. */
const DEFAULT_SPACE_RATIO = 0.25;
/** A gap wider than this many spaces cuts a run into pieces and a line in two. */
const BREAK_SPACES = 3;
/** Minimum width of a column channel, in spaces, and its minimum height in lines. */
const CHANNEL_SPACES = 2;
const CHANNEL_LINES = 3;
/** Baselines within this many sizes are one line. */
const BASELINE_TOLERANCE = 0.2;
/** Largest baseline pitch of one paragraph, in sizes, and the leading tolerance. */
const MAX_PITCH = 1.6;
const LEADING_TOLERANCE = 0.15;
/** Largest size difference of one paragraph's lines, points. */
const SIZE_TOLERANCE = 0.5;
/** A line shorter than this share of the measure ends a left-aligned paragraph. */
const SHORT_LINE = 0.85;
/** A box holds a paragraph when it reaches this close (points) to its lines' extent. */
const BOX_TOLERANCE = 0.5;
/** Edges varying less than this (points) are justified. */
const JUSTIFY_TOLERANCE = 0.5;
/**
 * A gap with a space glyph in it cuts a run or a line only above this many spaces (a
 * stretched space of a justified line is not a tab stop).
 */
const SPACED_BREAK_SPACES = 8;
/**
 * Word spaces without a space glyph: an ink gap wider than this many sizes inside a run, on a
 * page that writes no space glyphs (pdfTeX), or wider than this many spaces between runs.
 */
const WORD_GAP = 0.15;
const RUN_WORD_GAP = 0.8;
/** A lone list marker (`•`, `1.`, `a)`, `iv.`) that keeps the text after it on its line. */
const MARKER_ONLY = /^([•◦▪▫‣⁃●○■□·–\-*]|\d{1,3}[.)]|[a-z][.)]|\(?[ivxlcdm]{1,6}[.)])$/iu;
/** A first-line or hanging indent is at most this many sizes. */
const MAX_INDENT = 4;
/** A tagged group's lines are contiguous when their pitch is at most this many sizes. */
const MAX_TAG_PITCH = 2;
/** A drop cap is at least this many times the size of the lines it spans. */
const DROP_CAP_RATIO = 2;
/** Median piece length (characters) from which aligned rows are text columns, not a table. */
const TABLE_TEXT_CHARS = 25;
/** Leading assumed for a single line with no same-size neighbour, in sizes. */
const DEFAULT_LEADING = 1.2;
/** Headings by geometry: at least this many times the body size, at most this many lines. */
const HEADING_RATIO = 1.15;
const MAX_HEADING_LINES = 3;
/** A single bold line of at most this many characters, not ending in punctuation, is a heading. */
const MAX_BOLD_HEADING_CHARS = 80;

const SOFT_HYPHENS = new Set(['­', '￾', '']);
/** PDFium reads a line-end hyphen as U+0002 (`FPDFText_IsHyphen` is true for it). */
const PDFIUM_HYPHEN = '\u0002';

interface Vec {
  readonly x: number;
  readonly y: number;
}

/** A run with the facts every step needs. */
interface Prepared {
  readonly run: LocatedRun;
  /** Size on the page (Tf × the matrix's scale across the line). */
  readonly size: number;
  readonly family: string;
  readonly bold: boolean;
  readonly refusal?: ParagraphRefusal;
}

/** A glyph projected into text space. */
interface GlyphGeo {
  readonly x0: number;
  readonly x1: number;
  readonly bottom: number;
  readonly top: number;
  readonly origin: number;
  /** The origin across the line (its baseline). */
  readonly base: number;
  readonly blank: boolean;
}

type Role = 'flow' | 'tagged' | 'cell' | 'dropcap' | 'blank';

/** A slice of a run that sits on one line (cut at wide gaps). */
interface Piece {
  readonly prep: Prepared;
  readonly geo: readonly GlyphGeo[];
  readonly g0: number;
  readonly g1: number;
  readonly x0: number;
  readonly x1: number;
  readonly bottom: number;
  readonly top: number;
  readonly baseline: number;
  /** Origin of the first solid glyph along the line (cell starts line up on it). */
  readonly start: number;
  /**
   * Where the last solid glyph's advance ends when it ends its run (the run's loose box),
   * else its ink edge: right edges of justified lines agree on it, not on the ink.
   */
  readonly right: number;
  readonly size: number;
  readonly space: number;
  readonly chars: number;
  /** A space glyph before the first, or after the last, solid glyph. */
  readonly leadBlank: boolean;
  readonly trailBlank: boolean;
  /** The page writes space glyphs (else word gaps are found from the ink). */
  readonly spaces: boolean;
  role: Role;
  tag?: number;
  column: string;
  leaf: number;
  rank: number;
  /** Drop caps: the baseline of the top line they belong to. */
  dropFor?: number;
}

/** A line being built (text space). */
interface Row {
  readonly pieces: Piece[];
  readonly blanks: Piece[];
  baseline: number;
  x0: number;
  x1: number;
  top: number;
  bottom: number;
  size: number;
  family: string;
  bold: boolean;
  space: number;
  readonly column: string;
  rank: number;
  dropCap?: Piece;
}

interface Group {
  readonly rows: Row[];
  readonly source: 'tags' | 'geometry';
  readonly kind?: ParagraphBlock['kind'];
  readonly tag?: string;
  candidates: Set<ParagraphAlign>;
  bodyLeft?: number;
  leading?: number;
  pitches: number[];
}

/** Writing-direction frame of a group of runs. */
interface Frame {
  readonly u: Vec;
}

const along = (p: Vec, u: Vec) => p.x * u.x + p.y * u.y;
const across = (p: Vec, u: Vec) => -p.x * u.y + p.y * u.x;

function range(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return Math.max(...values) - Math.min(...values);
}

function dominantBy<T>(items: readonly T[], key: (t: T) => string, weight: (t: T) => number): T {
  const totals = new Map<string, number>();
  let best = items[0] as T;
  let bestWeight = -1;
  for (const item of items) {
    const k = key(item);
    const w = (totals.get(k) ?? 0) + weight(item);
    totals.set(k, w);
    if (w > bestWeight) {
      best = item;
      bestWeight = w;
    }
  }
  return best;
}

/** The font family without subset tag, style suffix or `MT`/`PS` tails, lower case. */
export function fontFamily(baseName: string): string {
  const name = baseName.replace(/^[A-Z]{6}\+/, '');
  const head = name.split(/[-,]/)[0] ?? name;
  return head.replace(/(PS)?MT$|PS$/, '').toLowerCase();
}

/** Why paragraph mode is refused for any block holding this run (`blockerOf`'s rules). */
export function runRefusal(run: LocatedRun): ParagraphRefusal | undefined {
  if (run.fontId === undefined && run.font.baseName === '') return 'paths';
  if (run.font.kind === 'type3') return 'type3';
  if (run.renderMode === 3) return 'invisible';
  if (run.vertical) return 'vertical';
  if (run.objectPath.length > 2) return 'nested-form';
  return undefined;
}

function prepare(run: LocatedRun): Prepared {
  const scale = Math.hypot(run.matrix[2], run.matrix[3]);
  let size = Math.abs(run.fontSize) * scale;
  if (!Number.isFinite(size) || size <= 0) size = Math.max(run.lineBox.height, 1);
  const refusal = runRefusal(run);
  return {
    run,
    size,
    family: fontFamily(run.font.baseName),
    bold: run.font.bold,
    ...(refusal ? { refusal } : {}),
  };
}

function projectRect(rect: Rect, u: Vec) {
  const xs = [rect.x, rect.x + rect.width];
  const ys = [rect.y, rect.y + rect.height];
  let x0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const x of xs) {
    for (const y of ys) {
      const a = along({ x, y }, u);
      const c = across({ x, y }, u);
      x0 = Math.min(x0, a);
      x1 = Math.max(x1, a);
      y0 = Math.min(y0, c);
      y1 = Math.max(y1, c);
    }
  }
  return { x0, x1, y0, y1 };
}

function glyphGeometry(run: LocatedRun, u: Vec): GlyphGeo[] {
  return run.glyphs.map((g) => {
    const origin = along(g.origin, u);
    const base = across(g.origin, u);
    const blank = g.text.trim() === '' && !SOFT_HYPHENS.has(g.text);
    if (g.rect.width <= 0 || g.rect.height <= 0) {
      return { x0: origin, x1: origin, bottom: base, top: base, origin, base, blank };
    }
    const r = projectRect(g.rect, u);
    return { x0: r.x0, x1: r.x1, bottom: r.y0, top: r.y1, origin, base, blank };
  });
}

/**
 * Median space advance over font size, from space glyphs followed by a glyph, and whether the
 * page has any such glyph.
 */
function spaceRatio(
  preps: readonly Prepared[],
  geos: ReadonlyMap<Prepared, GlyphGeo[]>,
): { ratio: number; spaces: boolean } {
  // Every glyph by line (baseline rounded to half the size), then along it: a space's
  // advance runs to the next glyph's origin, whichever run that glyph is in.
  const entries: { key: number; origin: number; space: boolean; size: number }[] = [];
  for (const prep of preps) {
    const geo = geos.get(prep) ?? [];
    prep.run.glyphs.forEach((g, i) => {
      const own = geo[i];
      if (!own) return;
      entries.push({
        key: Math.round(own.base / Math.max(prep.size / 2, 0.5)),
        origin: own.origin,
        space: g.text === ' ',
        size: prep.size,
      });
    });
  }
  entries.sort((a, b) => a.key - b.key || a.origin - b.origin);
  const ratios: number[] = [];
  for (let i = 0; i + 1 < entries.length; i++) {
    const a = entries[i] as (typeof entries)[number];
    const b = entries[i + 1] as (typeof entries)[number];
    if (!a.space || a.key !== b.key) continue;
    const advance = b.origin - a.origin;
    if (advance > 0 && advance < a.size) ratios.push(advance / a.size);
  }
  const r = median(ratios) ?? DEFAULT_SPACE_RATIO;
  return { ratio: Math.min(0.6, Math.max(0.12, r)), spaces: ratios.length > 0 };
}

/** The run's loose right edge, when the piece ends the run with a solid glyph. */
function advanceEnd(prep: Prepared, g1: number, trailBlank: boolean, u: Vec): number | undefined {
  const loose = prep.run.looseLineBox;
  if (!loose || trailBlank || g1 !== prep.run.glyphs.length) return undefined;
  if (loose.width <= 0) return undefined;
  return projectRect(loose, u).x1;
}

function makePiece(
  prep: Prepared,
  geo: GlyphGeo[],
  g0: number,
  g1: number,
  space: number,
  spaces: boolean,
  u: Vec,
): Piece {
  let x0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let bottom = Number.POSITIVE_INFINITY;
  let top = Number.NEGATIVE_INFINITY;
  let baseline: number | undefined;
  let chars = 0;
  let leadBlank = false;
  let trailBlank = false;
  let start: number | undefined;
  for (let i = g0; i < g1; i++) {
    const g = geo[i] as GlyphGeo;
    if (g.blank) {
      if (chars === 0) leadBlank = true;
      trailBlank = true;
      continue;
    }
    trailBlank = false;
    chars++;
    x0 = Math.min(x0, g.x0);
    x1 = Math.max(x1, g.x1);
    bottom = Math.min(bottom, g.bottom);
    top = Math.max(top, g.top);
    baseline ??= g.base;
    start ??= g.origin;
  }
  const blank = chars === 0;
  if (blank) {
    const first = geo[g0] as GlyphGeo;
    x0 = first.origin;
    x1 = (geo[g1 - 1] as GlyphGeo).origin;
    baseline = first.base;
    bottom = first.bottom;
    top = first.top;
  }
  return {
    prep,
    geo,
    g0,
    g1,
    x0,
    x1,
    bottom,
    top,
    baseline: baseline ?? 0,
    start: start ?? x0,
    right: advanceEnd(prep, g1, trailBlank, u) ?? x1,
    size: prep.size,
    space: space * prep.size,
    chars,
    leadBlank: leadBlank && chars > 0,
    trailBlank: trailBlank && chars > 0,
    spaces,
    role: blank ? 'blank' : 'flow',
    column: '',
    leaf: -1,
    rank: 0,
  };
}

/**
 * Cuts a run at gaps over 3 × space (8 × space when a space glyph stands in the gap), and
 * where the text jumps backwards.
 */
function piecesOf(
  prep: Prepared,
  geo: GlyphGeo[],
  ratio: number,
  spaces: boolean,
  u: Vec,
): Piece[] {
  const n = geo.length;
  if (n === 0) return [];
  const space = ratio * prep.size;
  const out: Piece[] = [];
  let start = 0;
  let last: GlyphGeo | undefined;
  let blankSince = false;
  for (let i = 0; i < n; i++) {
    const g = geo[i] as GlyphGeo;
    if (g.blank) {
      blankSince = true;
      continue;
    }
    if (last) {
      const gap = g.x0 - last.x1;
      const limit = (blankSince ? SPACED_BREAK_SPACES : BREAK_SPACES) * space;
      if (gap > limit || gap < -4 * prep.size) {
        // The blanks after the previous glyph stay with it.
        out.push(makePiece(prep, geo, start, i, ratio, spaces, u));
        start = i;
      }
    }
    last = g;
    blankSince = false;
  }
  out.push(makePiece(prep, geo, start, n, ratio, spaces, u));
  return out;
}

/** The solid text of a piece. */
function pieceText(p: Piece): string {
  return p.prep.run.glyphs
    .slice(p.g0, p.g1)
    .map((g) => g.text)
    .join('')
    .trim();
}

// ---------------------------------------------------------------------------
// Reading order: XY-cut with column channels
// ---------------------------------------------------------------------------

interface Gap {
  readonly at: number;
  readonly size: number;
}

function widestGap(items: readonly Piece[], span: (p: Piece) => [number, number]): Gap | undefined {
  const spans = items.map(span).sort((a, b) => a[0] - b[0]);
  let best: Gap | undefined;
  let end = spans[0]?.[1] ?? 0;
  for (let k = 1; k < spans.length; k++) {
    const [s, e] = spans[k] as [number, number];
    if (s > end) {
      const size = s - end;
      if (!best || size > best.size) best = { at: (s + end) / 2, size };
    }
    end = Math.max(end, e);
  }
  return best;
}

/** Number of distinct baselines (within 0.2 × size). */
function lineCount(items: readonly Piece[]): number {
  const sorted = [...items].sort((a, b) => b.baseline - a.baseline);
  let count = 0;
  let last: Piece | undefined;
  for (const p of sorted) {
    if (!last || last.baseline - p.baseline > BASELINE_TOLERANCE * Math.max(last.size, p.size)) {
      count++;
      last = p;
    }
  }
  return count;
}

/** Sets `column`, `leaf` and `rank` of every piece (non-blank, not a drop cap). */
function readingOrder(items: readonly Piece[]): void {
  let rank = 0;
  let leaf = 0;
  const visit = (region: readonly Piece[], path: string): void => {
    if (region.length === 0) return;
    if (region.length > 1) {
      const space = median(region.map((p) => p.space)) ?? 3;
      const v = widestGap(region, (p) => [p.x0, p.x1]);
      if (v && v.size >= CHANNEL_SPACES * space && lineCount(region) >= CHANNEL_LINES) {
        const left = region.filter((p) => (p.x0 + p.x1) / 2 < v.at);
        const right = region.filter((p) => (p.x0 + p.x1) / 2 >= v.at);
        // A column of list markers is not a text column.
        const markers = left.every((p) => MARKER_ONLY.test(pieceText(p)));
        if (left.length > 0 && right.length > 0 && !markers) {
          visit(left, `${path}L`);
          visit(right, `${path}R`);
          return;
        }
      }
      const h = widestGap(region, (p) => [p.bottom, p.top]);
      if (h && h.size > 0) {
        visit(
          region.filter((p) => (p.bottom + p.top) / 2 > h.at),
          path,
        );
        visit(
          region.filter((p) => (p.bottom + p.top) / 2 <= h.at),
          path,
        );
        return;
      }
    }
    const id = leaf++;
    for (const p of [...region].sort((a, b) => b.baseline - a.baseline || a.x0 - b.x0)) {
      p.column = path;
      p.leaf = id;
      p.rank = rank++;
    }
  };
  visit(items, '');
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

function newRow(pieces: Piece[]): Row {
  const first = pieces[0] as Piece;
  const row: Row = {
    pieces,
    blanks: [],
    baseline: first.baseline,
    x0: 0,
    x1: 0,
    top: 0,
    bottom: 0,
    size: first.size,
    family: first.prep.family,
    bold: first.prep.bold,
    space: first.space,
    column: first.column,
    rank: first.rank,
  };
  refreshRow(row);
  return row;
}

function refreshRow(row: Row): void {
  const ps = row.pieces.sort((a, b) => a.x0 - b.x0);
  const main = dominantBy(
    ps,
    (p) => `${Math.round(p.size * 2)}`,
    (p) => p.chars,
  );
  const style = dominantBy(
    ps,
    (p) => `${p.prep.family}|${p.prep.bold}`,
    (p) => p.chars,
  );
  row.baseline = main.baseline;
  row.size = main.size;
  row.space = main.space;
  row.family = style.prep.family;
  row.bold = style.prep.bold;
  row.x0 = Math.min(...ps.map((p) => p.start));
  row.x1 = Math.max(...ps.map((p) => p.right));
  row.top = Math.max(...ps.map((p) => p.top));
  row.bottom = Math.min(...ps.map((p) => p.bottom));
  row.rank = Math.min(...ps.map((p) => p.rank));
}

/**
 * Whether a same-size line within 2 × size above or below has ink around the middle of the
 * gap `[from, to]` at `p`'s baseline: then the gap is a stretched word space of a justified
 * line, not a tab stop, a gutter or a gap between table cells (other lines have their gaps
 * there too).
 */
function spanned(p: Piece, from: number, to: number, cover: readonly Piece[]): boolean {
  const mid = (from + to) / 2;
  const half = p.space / 2;
  return cover.some(
    (q) =>
      Math.abs(q.size - p.size) <= SIZE_TOLERANCE &&
      Math.abs(q.baseline - p.baseline) > BASELINE_TOLERANCE * p.size &&
      Math.abs(q.baseline - p.baseline) <= 2 * p.size &&
      q.x0 < mid + half &&
      q.x1 > mid - half,
  );
}

/** Whether a space glyph (in its own run) sits in the gap `[from, to]` on `p`'s line. */
function blankIn(p: Piece, from: number, to: number, blanks: readonly Piece[]): boolean {
  return blanks.some(
    (b) =>
      Math.abs(b.baseline - p.baseline) <= BASELINE_TOLERANCE * p.size &&
      b.x0 >= from - 1 &&
      b.x0 <= to + 1,
  );
}

/**
 * Lines of one set of pieces: baselines within 0.2 × size, split (when `cover`, the column's
 * pieces, is given) at gaps over 3 × space that no neighbouring line spans.
 */
function rowsOf(
  pieces: readonly Piece[],
  cover?: readonly Piece[],
  blanks: readonly Piece[] = [],
): Row[] {
  const clusters: Piece[][] = [];
  for (const p of [...pieces].sort((a, b) => b.baseline - a.baseline)) {
    const cluster = clusters.find((c) => {
      const head = c[0] as Piece;
      return (
        Math.abs(head.baseline - p.baseline) <= BASELINE_TOLERANCE * Math.max(head.size, p.size)
      );
    });
    if (cluster) cluster.push(p);
    else clusters.push([p]);
  }
  const rows: Row[] = [];
  for (const cluster of clusters) {
    cluster.sort((a, b) => a.x0 - b.x0);
    let current: Piece[] = [];
    let end = Number.NEGATIVE_INFINITY;
    for (const p of cluster) {
      const before = current[current.length - 1];
      const space = Math.max(p.space, before?.space ?? 0);
      const spaced = before?.trailBlank === true || p.leadBlank || blankIn(p, end, p.x0, blanks);
      const limit =
        current.length === 1 && MARKER_ONLY.test(pieceText(before as Piece))
          ? MAX_INDENT * p.size
          : (spaced ? SPACED_BREAK_SPACES : BREAK_SPACES) * space;
      if (cover && current.length > 0 && p.x0 - end > limit && !spanned(p, end, p.x0, cover)) {
        rows.push(newRow(current));
        current = [];
      }
      current.push(p);
      end = Math.max(end, p.x1);
    }
    if (current.length > 0) rows.push(newRow(current));
  }
  return mergeScripts(rows);
}

/** Folds superscripts and subscripts (short, smaller, touching) into their line. */
function mergeScripts(rows: Row[]): Row[] {
  const out = [...rows];
  for (const r of rows) {
    const chars = r.pieces.reduce((n, p) => n + p.chars, 0);
    if (chars > 4) continue;
    const host = out.find(
      (s) =>
        s !== r &&
        r.size <= 0.8 * s.size &&
        Math.abs(r.baseline - s.baseline) <= 0.6 * s.size &&
        r.x0 <= s.x1 + 1.5 * s.space &&
        r.x1 >= s.x0 - 1.5 * s.space,
    );
    if (!host) continue;
    host.pieces.push(...r.pieces);
    const baseline = host.baseline;
    refreshRow(host);
    host.baseline = baseline;
    out.splice(out.indexOf(r), 1);
  }
  return out;
}

/** A glyph's text with PDFium's line-end hyphen and soft-hyphen markers read as `-`. */
function glyphText(text: string): string {
  return text === PDFIUM_HYPHEN || SOFT_HYPHENS.has(text) ? '-' : text;
}

/** Width of the line's first word: up to the first space glyph or word gap. */
function firstWordWidth(row: Row): number {
  let end = row.x0;
  let prev: GlyphGeo | undefined;
  for (const piece of row.pieces) {
    for (let i = piece.g0; i < piece.g1; i++) {
      const g = piece.geo[i] as GlyphGeo;
      if (g.blank) {
        if (prev) return end - row.x0;
        continue;
      }
      if (prev && g.x0 - prev.x1 > RUN_WORD_GAP * piece.space) return end - row.x0;
      end = Math.max(end, g.x1);
      prev = g;
    }
  }
  return end - row.x0;
}

/** The line's text: glyphs in order, a space where a gap stands for one. */
function rowText(row: Row): { text: string; soft: boolean; flagged: boolean } {
  const items = [...row.pieces, ...row.blanks].sort((a, b) => a.x0 - b.x0 || a.g0 - b.g0);
  let out = '';
  let prev: GlyphGeo | undefined;
  let prevPiece: Piece | undefined;
  let spaced = true;
  let soft = false;
  let flagged = false;
  for (const piece of items) {
    const glyphs = piece.prep.run.glyphs;
    for (let i = piece.g0; i < piece.g1; i++) {
      const g = piece.geo[i] as GlyphGeo;
      const text = glyphs[i]?.text ?? '';
      if (g.blank) {
        if (!spaced) out += ' ';
        spaced = true;
        continue;
      }
      if (prev && !spaced) {
        const gap = g.x0 - prev.x1;
        const word =
          prevPiece === piece
            ? !piece.spaces && gap > WORD_GAP * row.size
            : gap > RUN_WORD_GAP * Math.max(piece.space, prevPiece?.space ?? 0);
        if (word) out += ' ';
      }
      soft = SOFT_HYPHENS.has(text);
      flagged = i === glyphs.length - 1 && piece.prep.run.endsWithHyphen === true;
      out += glyphText(text);
      spaced = false;
      prev = g;
      prevPiece = piece;
    }
  }
  return { text: out.trim().replace(/\s+/g, ' '), soft, flagged };
}

// ---------------------------------------------------------------------------
// Paragraphs
// ---------------------------------------------------------------------------

interface ColumnStats {
  /** Median white space between same-style lines, per column. */
  readonly gap: ReadonlyMap<string, number>;
  /** Left and right edges of each column's text. */
  readonly bounds: ReadonlyMap<string, { readonly left: number; readonly right: number }>;
  /** Number of lines ending at the column's right edge (within 0.5 pt). */
  readonly flushRight: ReadonlyMap<string, number>;
}

const overlaps = (a: Row, b: Row) => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0;

function sameStyleRows(a: Row, b: Row): boolean {
  return a.bold === b.bold && a.family === b.family && Math.abs(a.size - b.size) <= SIZE_TOLERANCE;
}

/** The nearest line above `row` in `above` that overlaps it along the line. */
function nearestAbove(row: Row, above: readonly Row[]): Row | undefined {
  let best: Row | undefined;
  for (const r of above) {
    if (r.baseline - row.baseline <= BASELINE_TOLERANCE * Math.max(r.size, row.size)) continue;
    if (!overlaps(r, row)) continue;
    if (!best || r.baseline < best.baseline) best = r;
  }
  return best;
}

/** The alignments a join of `line` to `group` (after `prev`) keeps, or undefined. */
function joinable(
  group: Group,
  prev: Row,
  line: Row,
  markerOf: (row: Row) => ListMarker | undefined,
  columnGap: number | undefined,
): Set<ParagraphAlign> | undefined {
  if (markerOf(line)) return undefined;
  if (!sameStyleRows(prev, line)) return undefined;
  const size = Math.max(prev.size, line.size, 1);
  const pitch = prev.baseline - line.baseline;
  if (pitch <= 0.5 * size || pitch > MAX_PITCH * size) return undefined;
  if (
    group.leading !== undefined &&
    Math.abs(pitch - group.leading) > LEADING_TOLERANCE * group.leading
  ) {
    return undefined;
  }
  const gap = prev.bottom - line.top;
  if (gap > blockBreakGap(size, columnGap ?? 0.3 * size) || gap < -0.5 * size) return undefined;
  const space = Math.max(prev.space, line.space);
  const first = group.rows.length === 1;
  const head = group.rows[0] as Row;
  const left = group.bodyLeft ?? head.x0;
  const ok = new Set<ParagraphAlign>();
  if (
    Math.abs(line.x0 - left) <= space ||
    (first && line.x0 < prev.x0 - space && prev.x0 - line.x0 <= MAX_INDENT * size) ||
    (first &&
      markerOf(prev) &&
      line.x0 > prev.x0 + space &&
      line.x0 - prev.x0 <= MAX_INDENT * size) ||
    (head.dropCap && Math.abs(line.x0 - head.dropCap.start) <= space)
  ) {
    ok.add('left');
    ok.add('justify');
  }
  if (Math.abs((line.x0 + line.x1) / 2 - (prev.x0 + prev.x1) / 2) <= space) ok.add('center');
  if (Math.abs(line.x1 - prev.x1) <= space) ok.add('right');
  const candidates = new Set([...group.candidates].filter((a) => ok.has(a)));
  if (candidates.has('left')) {
    const rows = [...group.rows, line];
    const minLeft = Math.min(
      ...rows.map((r) => r.x0),
      head.dropCap?.start ?? Number.POSITIVE_INFINITY,
    );
    const right = Math.max(...rows.map((r) => r.x1));
    // Short, and the next line's first word would have fitted after it: a paragraph end.
    if (
      prev.x1 - minLeft < SHORT_LINE * (right - minLeft) &&
      prev.x1 + space + firstWordWidth(line) <= right
    ) {
      candidates.delete('left');
      candidates.delete('justify');
    }
  }
  return candidates.size > 0 ? candidates : undefined;
}

const ALL_ALIGNMENTS: readonly ParagraphAlign[] = ['left', 'justify', 'center', 'right'];

function newGroup(row: Row, source: Group['source'], extra: Partial<Group> = {}): Group {
  return {
    rows: [row],
    source,
    candidates: new Set(ALL_ALIGNMENTS),
    pitches: [],
    ...extra,
  };
}

function addRow(group: Group, row: Row, candidates: Set<ParagraphAlign>): void {
  const prev = group.rows[group.rows.length - 1] as Row;
  const pitch = prev.baseline - row.baseline;
  group.pitches.push(pitch);
  group.leading = group.pitches.reduce((a, b) => a + b, 0) / group.pitches.length;
  group.candidates = candidates;
  group.rows.push(row);
  if (group.rows.length === 2) group.bodyLeft = row.x0;
}

/** Groups the flow lines of one column into paragraphs. */
function paragraphsOf(
  rows: readonly Row[],
  markerOf: (row: Row) => ListMarker | undefined,
  columnGap: number | undefined,
): Group[] {
  const sorted = [...rows].sort((a, b) => b.baseline - a.baseline || a.x0 - b.x0);
  const groups: Group[] = [];
  const groupOf = new Map<Row, Group>();
  const placed: Row[] = [];
  for (const row of sorted) {
    const prev = nearestAbove(row, placed);
    const group = prev ? groupOf.get(prev) : undefined;
    const candidates =
      group && prev && group.rows[group.rows.length - 1] === prev
        ? joinable(group, prev, row, markerOf, columnGap)
        : undefined;
    if (group && candidates) {
      addRow(group, row, candidates);
      groupOf.set(row, group);
    } else {
      const g = newGroup(row, 'geometry');
      groups.push(g);
      groupOf.set(row, g);
    }
    placed.push(row);
  }
  return groups;
}

function columnStats(rows: readonly Row[]): ColumnStats {
  const byColumn = new Map<string, Row[]>();
  for (const r of rows) byColumn.set(r.column, [...(byColumn.get(r.column) ?? []), r]);
  const gap = new Map<string, number>();
  const bounds = new Map<string, { left: number; right: number }>();
  const flushRight = new Map<string, number>();
  for (const [column, list] of byColumn) {
    const gaps: number[] = [];
    for (const r of list) {
      const above = nearestAbove(r, list);
      if (above && sameStyleRows(above, r)) {
        const g = above.bottom - r.top;
        if (g >= 0) gaps.push(g);
      }
    }
    const m = median(gaps);
    if (m !== undefined) gap.set(column, m);
    const left = Math.min(...list.map((r) => r.x0));
    const right = Math.max(...list.map((r) => r.x1));
    bounds.set(column, { left, right });
    flushRight.set(column, list.filter((r) => right - r.x1 < JUSTIFY_TOLERANCE).length);
  }
  return { gap, bounds, flushRight };
}

/**
 * `row` ends short of the measure (`left` to `right`) although `next`'s first word would have
 * fitted after it: the producer broke the line on purpose.
 */
function shortBreak(row: Row, next: Row, left: number, right: number): boolean {
  return (
    row.x1 - left < SHORT_LINE * (right - left) &&
    row.x1 + row.space + firstWordWidth(next) <= right
  );
}

function alignOf(
  group: Group,
  stats: ColumnStats,
  pageSpan: { readonly left: number; readonly right: number },
): ParagraphAlign {
  const rows = group.rows;
  const head = rows[0] as Row;
  const space = head.space;
  if (rows.length === 1) {
    let bounds = stats.bounds.get(head.column) ?? pageSpan;
    if (bounds.right - bounds.left <= head.x1 - head.x0 + space) bounds = pageSpan;
    const inset = head.x0 - bounds.left;
    if (inset > 2 * space) {
      const centre = (head.x0 + head.x1) / 2;
      if (Math.abs(centre - (bounds.left + bounds.right) / 2) <= space) return 'center';
      if (Math.abs(head.x1 - bounds.right) <= space) return 'right';
    }
    return 'left';
  }
  const body = rows.slice(0, -1);
  const indented = rows.length > 1 && Math.abs(head.x0 - (rows[1] as Row).x0) > space;
  const lefts = body.flatMap((r, i) => (i === 0 && indented ? [] : [r.x0]));
  // A tagged paragraph's hard line breaks end short of the edge, as typesetters leave them.
  const ownLeft = Math.min(...rows.map((r) => r.x0));
  const ownRight = Math.max(...rows.map((r) => r.x1));
  const flowing =
    group.source === 'tags'
      ? body.filter((r, i) => !shortBreak(r, rows[i + 1] as Row, ownLeft, ownRight))
      : body;
  const rights = flowing.map((r) => r.x1);
  const has = (a: ParagraphAlign) => group.candidates.has(a);
  if (has('justify') || group.source === 'tags') {
    if (body.length >= 2) {
      if (
        rights.length >= 2 &&
        range(lefts) < JUSTIFY_TOLERANCE &&
        range(rights) < JUSTIFY_TOLERANCE
      ) {
        return 'justify';
      }
    } else {
      const bounds = stats.bounds.get(head.column);
      const flush = stats.flushRight.get(head.column) ?? 0;
      const last = rows[rows.length - 1] as Row;
      if (
        bounds &&
        flush >= 3 &&
        bounds.right - head.x1 < JUSTIFY_TOLERANCE &&
        last.x1 < head.x1 - space
      ) {
        return 'justify';
      }
    }
  }
  const allLefts = rows.flatMap((r, i) => (i === 0 && indented ? [] : [r.x0]));
  if (range(allLefts) <= space && (has('left') || group.source === 'tags')) return 'left';
  if (range(rows.map((r) => r.x1)) <= space) return 'right';
  if (range(rows.map((r) => (r.x0 + r.x1) / 2)) <= space) return 'center';
  return 'left';
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

function refOf(run: LocatedRun): TextRunRef {
  return {
    source: run.source,
    pageIndex: run.pageIndex,
    objectPath: run.objectPath,
    charStart: run.charStart,
    charCount: run.charCount,
    text: run.text,
  };
}

function unionRects(rects: readonly Rect[]): Rect {
  if (rects.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  const x0 = Math.min(...rects.map((r) => r.x));
  const y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.width));
  const y1 = Math.max(...rects.map((r) => r.y + r.height));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function lineEndOf(
  current: { readonly text: string; readonly soft: boolean; readonly flagged: boolean },
  next: string | undefined,
): ParagraphLineEnd {
  if (next === undefined) return 'end';
  const last = current.text.at(-1) ?? '';
  const hyphen = last === '-' || last === '‐';
  if (current.soft && hyphen) return 'joined';
  const hard = hyphen && (current.flagged || /\p{L}/u.test(current.text.at(-2) ?? ''));
  if (!hard) return 'space';
  return /^\p{Ll}/u.test(next) ? 'joined' : 'hyphen';
}

interface BlockContext {
  readonly frame: Frame;
  readonly stats: ColumnStats;
  readonly pageSpan: { readonly left: number; readonly right: number };
  readonly bodySize: number;
  readonly leadingBySize: ReadonlyMap<number, number>;
  readonly markerOf: (row: Row) => ListMarker | undefined;
}

/** A block before numbering: its runs (for the ref) and its reading-order rank. */
interface DraftBlock {
  readonly block: Omit<ParagraphBlock, 'ref'>;
  readonly runs: readonly LocatedRun[];
  readonly rank: number;
  /** Per line, what the hard-break test needs (absent: no line can end in one). */
  readonly facts?: readonly LineFacts[];
}

/** A line's space width and the width of its first word (text space). */
interface LineFacts {
  readonly space: number;
  readonly firstWord: number;
}

function toBlock(group: Group, ctx: BlockContext): DraftBlock {
  const runs: LocatedRun[] = [];
  const runIndex = (run: LocatedRun): number => {
    let i = runs.indexOf(run);
    if (i < 0) {
      i = runs.length;
      runs.push(run);
    }
    return i;
  };
  const spanOf = (piece: Piece): ParagraphSpan => {
    const { run } = piece.prep;
    const text = run.glyphs
      .slice(piece.g0, piece.g1)
      .map((g) => glyphText(g.text))
      .join('');
    return {
      run: runIndex(run),
      glyphStart: piece.g0,
      glyphEnd: piece.g1,
      text,
      ...(run.fontId !== undefined ? { fontId: run.fontId } : {}),
      font: run.font,
      fontSize: run.fontSize,
      size: piece.size,
      matrix: run.matrix,
      ...(run.textMatrix ? { textMatrix: run.textMatrix } : {}),
      ...(run.fill ? { fill: run.fill } : {}),
      renderMode: run.renderMode,
      ...(run.mcid !== undefined ? { mcid: run.mcid } : {}),
      x0: piece.start,
      x1: piece.right,
    };
  };
  const rows = group.rows;
  const head = rows[0] as Row;
  const dropCap = head.dropCap;
  const dropSpan = dropCap ? spanOf(dropCap) : undefined;
  const texts = rows.map(rowText);
  let text = dropSpan ? dropSpan.text.trim() : '';
  const lines: ParagraphLine[] = rows.map((row, i) => {
    const t = texts[i] as ReturnType<typeof rowText>;
    const end = lineEndOf(t, texts[i + 1]?.text);
    const start = text.length;
    text += t.text;
    if (end === 'joined') text = text.slice(0, -1);
    else if (end === 'space') text += ' ';
    const pieces = [...row.pieces, ...row.blanks].sort((a, b) => a.x0 - b.x0 || a.g0 - b.g0);
    return {
      spans: pieces.map(spanOf),
      baseline: row.baseline,
      x0: row.x0,
      x1: row.x1,
      size: row.size,
      text: t.text,
      start,
      end,
      endsWithHyphen: t.flagged,
    };
  });
  const allPieces = rows.flatMap((r) => [...r.pieces, ...r.blanks]);
  if (dropCap) allPieces.push(dropCap);
  const rects = allPieces.flatMap((p) =>
    p.prep.run.glyphs
      .slice(p.g0, p.g1)
      .map((g) => g.rect)
      .filter((r) => r.width > 0 && r.height > 0),
  );
  const left = Math.min(...rows.map((r) => r.x0), dropCap?.start ?? Number.POSITIVE_INFINITY);
  const right = Math.max(...rows.map((r) => r.x1));
  const size = dominantBy(
    rows,
    (r) => `${Math.round(r.size * 2)}`,
    (r) => r.pieces.reduce((n, p) => n + p.chars, 0),
  ).size;
  const leading =
    group.pitches.length > 0
      ? (median(rows.slice(1).map((r, i) => (rows[i] as Row).baseline - r.baseline)) ??
        DEFAULT_LEADING * size)
      : (ctx.leadingBySize.get(Math.round(size * 2)) ?? DEFAULT_LEADING * size);
  const marker = ctx.markerOf(head);
  const refusal =
    allPieces.map((p) => p.prep.refusal).find((r) => r !== undefined) ??
    (dropCap ? ('drop-cap' as const) : undefined);
  const plain = text.trimEnd();
  const heading =
    (size >= HEADING_RATIO * ctx.bodySize && rows.length <= MAX_HEADING_LINES) ||
    (rows.length === 1 &&
      head.bold &&
      plain.length <= MAX_BOLD_HEADING_CHARS &&
      !/[.,;:]$/.test(plain));
  const kind: ParagraphBlock['kind'] =
    group.kind ?? (marker ? 'list-item' : heading ? 'heading' : 'paragraph');
  const block: Omit<ParagraphBlock, 'ref'> = {
    lines,
    align: alignOf(group, ctx.stats, ctx.pageSpan),
    leading,
    source: group.source,
    kind,
    ...(group.tag ? { tag: group.tag } : {}),
    direction: ctx.frame.u,
    measure: { left, right },
    indent: head.x0 - left,
    size,
    ...(marker ? { marker: marker.marker } : {}),
    ...(dropSpan ? { dropCap: dropSpan } : {}),
    text: text.trimEnd(),
    box: rects.length > 0 ? unionRects(rects) : unionRects(runs.map((r) => r.lineBox)),
    ...(refusal ? { refusal } : {}),
  };
  const facts = rows.map((r) => ({ space: r.space, firstWord: firstWordWidth(r) }));
  return { block, runs, rank: Math.min(...rows.map((r) => r.rank)), facts };
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

/** MCID → paragraph group (an `LI` takes its `Lbl`, `LBody` and their paragraphs). */
function tagGroups(tags: readonly ParagraphTag[]): Map<number, number> {
  const out = new Map<number, number>();
  tags.forEach((tag, i) => {
    let group = i;
    let parent = tag.parent;
    let guard = 0;
    while (parent !== undefined && guard++ < 64) {
      if (tags[parent]?.type === 'LI') group = parent;
      parent = tags[parent]?.parent;
    }
    for (const mcid of tag.mcids) if (!out.has(mcid)) out.set(mcid, group);
  });
  return out;
}

const KIND_OF_TAG: Readonly<Record<string, ParagraphBlock['kind']>> = {
  P: 'paragraph',
  LI: 'list-item',
  LBody: 'list-item',
};

/** Whether a tagged group's lines follow each other with nothing in between. */
function contiguous(rows: readonly Row[], others: readonly Piece[]): boolean {
  const sorted = [...rows].sort((a, b) => b.baseline - a.baseline);
  const x0 = Math.min(...rows.map((r) => r.x0));
  const x1 = Math.max(...rows.map((r) => r.x1));
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1] as Row;
    const b = sorted[i] as Row;
    const size = Math.max(a.size, b.size);
    if (a.baseline - b.baseline > MAX_TAG_PITCH * size || !overlaps(a, b)) return false;
    const between = others.some(
      (p) =>
        p.baseline < a.baseline - BASELINE_TOLERANCE * size &&
        p.baseline > b.baseline + BASELINE_TOLERANCE * size &&
        Math.min(p.x1, x1) - Math.max(p.x0, x0) > 0,
    );
    if (between) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/** Drop caps: marks them and the top baseline of the lines they span. */
function findDropCaps(pieces: readonly Piece[]): void {
  for (const s of pieces) {
    if (s.role !== 'flow') continue;
    const letters = s.prep.run.glyphs
      .slice(s.g0, s.g1)
      .map((g) => g.text)
      .join('')
      .trim();
    if (letters.length === 0 || letters.length > 2 || !/\p{L}/u.test(letters)) continue;
    const spanned = pieces.filter(
      (t) =>
        t !== s &&
        t.role === 'flow' &&
        DROP_CAP_RATIO * t.size <= s.size &&
        t.x0 >= s.x1 - t.space &&
        t.x0 <= s.x1 + MAX_INDENT * t.size &&
        t.baseline >= s.bottom - 0.5 * t.size &&
        t.baseline <= s.top,
    );
    if (lineCount(spanned) < 2) continue;
    s.role = 'dropcap';
    s.dropFor = Math.max(...spanned.map((t) => t.baseline));
  }
}

function detectFrame(
  preps: readonly Prepared[],
  frame: Frame,
  tags: readonly ParagraphTag[],
  page: PageGeometry,
  bodySize: number,
): DraftBlock[] {
  const { u } = frame;
  const geos = new Map<Prepared, GlyphGeo[]>();
  for (const p of preps) geos.set(p, glyphGeometry(p.run, u));
  const { ratio, spaces } = spaceRatio(preps, geos);
  const pieces = preps.flatMap((p) => piecesOf(p, geos.get(p) ?? [], ratio, spaces, u));
  const solid = () => pieces.filter((p) => p.role !== 'blank');
  findDropCaps(pieces);

  // Structure tree.
  const mcidGroup = tagGroups(tags);
  const tagged = new Map<number, Piece[]>();
  for (const p of pieces) {
    const { run } = p.prep;
    if (p.role !== 'flow' || run.mcid === undefined || run.inForm) continue;
    const group = mcidGroup.get(run.mcid);
    if (group === undefined) continue;
    tagged.set(group, [...(tagged.get(group) ?? []), p]);
  }
  const valid = new Map<number, Piece[]>();
  for (const [group, list] of tagged) {
    const own = new Set(list);
    const others = solid().filter((p) => !own.has(p));
    if (!contiguous(rowsOf(list), others)) continue;
    for (const p of list) {
      p.role = 'tagged';
      p.tag = group;
    }
    valid.set(group, list);
  }

  // Reading order and columns (tagged pieces included).
  readingOrder(solid().filter((p) => p.role !== 'dropcap'));
  const tagRows = new Map<number, Row[]>();
  for (const [group, list] of valid) tagRows.set(group, rowsOf(list));

  // Lines per XY-cut leaf, then paragraphs per column.
  const flow = pieces.filter((p) => p.role === 'flow');
  const leaves = new Map<number, Piece[]>();
  for (const p of pieces) {
    if (p.role === 'flow') leaves.set(p.leaf, [...(leaves.get(p.leaf) ?? []), p]);
  }
  const blankPieces = pieces.filter((p) => p.role === 'blank');
  const byColumnPieces = new Map<string, Piece[]>();
  for (const p of flow) {
    if (p.role === 'flow') {
      byColumnPieces.set(p.column, [...(byColumnPieces.get(p.column) ?? []), p]);
    }
  }
  const lineRows = [...leaves.values()].flatMap((list) =>
    rowsOf(list, byColumnPieces.get((list[0] as Piece).column) ?? [], blankPieces),
  );

  // Tables: one box per cell (a line segment of a table row).
  const cells = new Set<Row>();
  const boxed = lineRows.map((row) => ({
    row,
    size: row.size,
    box: { x0: row.x0, x1: row.x1, y0: -row.top, y1: -row.baseline },
  }));
  for (const table of tableRows(boxed)) {
    const list = table.flat();
    const chars = median(list.map((c) => c.row.pieces.reduce((n, p) => n + p.chars, 0))) ?? 0;
    if (chars >= TABLE_TEXT_CHARS) continue;
    for (const c of list) cells.add(c.row);
  }
  for (const row of cells) for (const p of row.pieces) p.role = 'cell';
  const flowRows = lineRows.filter((r) => !cells.has(r));
  const cellRows = [...cells];
  const tagRowList = [...tagRows.values()].flat();
  const allRows = [...flowRows, ...cellRows, ...tagRowList];

  for (const cap of pieces.filter((p) => p.role === 'dropcap')) {
    const host = flowRows
      .filter(
        (r) =>
          Math.abs(r.baseline - (cap.dropFor ?? 0)) <= BASELINE_TOLERANCE * r.size &&
          r.x0 >= cap.x1 - r.space,
      )
      .sort((a, b) => a.x0 - b.x0)[0];
    if (host) {
      host.dropCap = cap;
      cap.rank = host.rank;
    } else {
      // No line to attach to: an ordinary piece of its own.
      cap.role = 'flow';
      flowRows.push(newRow([cap]));
    }
  }

  // Space-only pieces join the line they sit on.
  for (const blank of pieces.filter((p) => p.role === 'blank')) {
    const host = allRows.find(
      (r) =>
        Math.abs(r.baseline - blank.baseline) <= BASELINE_TOLERANCE * r.size &&
        blank.x0 >= r.x0 - BREAK_SPACES * r.space &&
        blank.x0 <= r.x1 + BREAK_SPACES * r.space,
    );
    host?.blanks.push(blank);
  }

  const stats = columnStats([...flowRows, ...tagRowList]);
  const markers = new Map<Row, ListMarker | undefined>();
  const markerOf = (row: Row): ListMarker | undefined => {
    if (!markers.has(row)) markers.set(row, listMarker(rowText(row).text));
    return markers.get(row);
  };
  const groups: Group[] = [];
  const byColumn = new Map<string, Row[]>();
  for (const r of flowRows) byColumn.set(r.column, [...(byColumn.get(r.column) ?? []), r]);
  for (const [column, rows] of byColumn) {
    groups.push(...paragraphsOf(rows, markerOf, stats.gap.get(column)));
  }
  for (const r of cellRows) groups.push(newGroup(r, 'geometry', { kind: 'cell' }));
  for (const [group, rows] of tagRows) {
    const tag = tags[group];
    const sorted = [...rows].sort((a, b) => b.baseline - a.baseline);
    const g = newGroup(sorted[0] as Row, 'tags', {
      ...(tag ? { tag: tag.type, kind: KIND_OF_TAG[tag.type] ?? 'heading' } : {}),
    });
    for (const r of sorted.slice(1)) addRow(g, r, g.candidates);
    groups.push(g);
  }

  const leadingBySize = new Map<number, number[]>();
  for (const g of groups) {
    const rows = g.rows;
    for (let i = 1; i < rows.length; i++) {
      const key = Math.round((rows[i] as Row).size * 2);
      leadingBySize.set(key, [
        ...(leadingBySize.get(key) ?? []),
        (rows[i - 1] as Row).baseline - (rows[i] as Row).baseline,
      ]);
    }
  }
  const corners = [
    { x: page.x ?? 0, y: page.y ?? 0 },
    { x: (page.x ?? 0) + page.width, y: (page.y ?? 0) + page.height },
    { x: page.x ?? 0, y: (page.y ?? 0) + page.height },
    { x: (page.x ?? 0) + page.width, y: page.y ?? 0 },
  ].map((c) => along(c, u));
  const ctx: BlockContext = {
    frame,
    stats,
    pageSpan: { left: Math.min(...corners), right: Math.max(...corners) },
    bodySize,
    leadingBySize: new Map(
      [...leadingBySize].map(([k, v]) => [k, median(v) ?? DEFAULT_LEADING * (k / 2)]),
    ),
    markerOf,
  };
  return groups.map((g) => toBlock(g, ctx));
}

/** A vertical run: one refused block of one line. */
function verticalBlock(prep: Prepared): DraftBlock {
  const { run } = prep;
  const u = run.direction;
  const geo = glyphGeometry(run, u);
  const x0 = Math.min(...geo.map((g) => g.x0));
  const x1 = Math.max(...geo.map((g) => g.x1));
  const text = run.text.trim();
  const span: ParagraphSpan = {
    run: 0,
    glyphStart: 0,
    glyphEnd: run.glyphs.length,
    text: run.text,
    ...(run.fontId !== undefined ? { fontId: run.fontId } : {}),
    font: run.font,
    fontSize: run.fontSize,
    size: prep.size,
    matrix: run.matrix,
    ...(run.textMatrix ? { textMatrix: run.textMatrix } : {}),
    ...(run.fill ? { fill: run.fill } : {}),
    renderMode: run.renderMode,
    ...(run.mcid !== undefined ? { mcid: run.mcid } : {}),
    x0,
    x1,
  };
  const block: Omit<ParagraphBlock, 'ref'> = {
    lines: [
      {
        spans: [span],
        baseline: run.baseline ?? across(run.glyphs[0]?.origin ?? { x: 0, y: 0 }, u),
        x0,
        x1,
        size: prep.size,
        text,
        start: 0,
        end: 'end',
        endsWithHyphen: false,
      },
    ],
    align: 'left',
    leading: DEFAULT_LEADING * prep.size,
    source: 'geometry',
    kind: 'paragraph',
    direction: u,
    measure: { left: x0, right: x1 },
    indent: 0,
    size: prep.size,
    text,
    box: run.lineBox,
    refusal: 'vertical',
  };
  return { block, runs: [run], rank: Number.POSITIVE_INFINITY };
}

// ---------------------------------------------------------------------------
// Measures and hard line breaks
// ---------------------------------------------------------------------------

/** A text-space rectangle. */
interface Extent {
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly y1: number;
}

const sameDirection = (
  a: Pick<ParagraphBlock, 'direction'>,
  b: Pick<ParagraphBlock, 'direction'>,
) =>
  Math.abs(a.direction.x - b.direction.x) < 1e-6 && Math.abs(a.direction.y - b.direction.y) < 1e-6;

/** The block's lines along the measure, its glyphs across (text space). */
function blockExtent(block: Omit<ParagraphBlock, 'ref'>): Extent {
  const { y0, y1 } = projectRect(block.box, block.direction);
  return { x0: block.measure.left, x1: block.measure.right, y0, y1 };
}

/** The smallest of `boxes` that holds `inner` (within `BOX_TOLERANCE`). */
function enclosingBox(inner: Extent, boxes: readonly Extent[]): Extent | undefined {
  let best: Extent | undefined;
  let bestArea = Number.POSITIVE_INFINITY;
  for (const b of boxes) {
    if (
      b.x0 > inner.x0 + BOX_TOLERANCE ||
      b.x1 < inner.x1 - BOX_TOLERANCE ||
      b.y0 > inner.y0 + BOX_TOLERANCE ||
      b.y1 < inner.y1 - BOX_TOLERANCE
    ) {
      continue;
    }
    const area = (b.x1 - b.x0) * (b.y1 - b.y0);
    if (area < bestArea) {
      best = b;
      bestArea = area;
    }
  }
  return best;
}

/**
 * The right edge a rewrap of a left-aligned block may fill (step 10 of the module comment):
 * the inner edge of the smallest filled or stroked box holding it, when no other block in
 * that box stands beside it; else the column's (the furthest right edge of the blocks that
 * share its horizontal extent, as the paragraph editor's input had it); never left of its
 * own longest line nor past the page. `boxed`: a box set it.
 */
function wrapRightOf(
  draft: DraftBlock,
  drafts: readonly DraftBlock[],
  boxes: readonly Rect[],
  page: PageGeometry,
): { readonly right: number; readonly boxed: boolean } {
  const { block } = draft;
  const own = block.measure.right;
  if (block.align !== 'left' || block.refusal || block.lines.length === 0) {
    return { right: own, boxed: false };
  }
  const u = block.direction;
  const mine = blockExtent(block);
  const others = drafts.filter((d) => d !== draft && sameDirection(d.block, block));
  const box = enclosingBox(
    mine,
    boxes.map((r) => projectRect(r, u)),
  );
  const beside =
    box !== undefined &&
    others.some((d) => {
      const e = blockExtent(d.block);
      const inBox =
        Math.min(e.x1, box.x1) > Math.max(e.x0, box.x0) &&
        Math.min(e.y1, box.y1) > Math.max(e.y0, box.y0);
      return inBox && Math.min(e.y1, mine.y1) - Math.max(e.y0, mine.y0) > BOX_TOLERANCE;
    });
  let right: number;
  const boxed = box !== undefined && !beside;
  if (box && boxed) {
    right = box.x1 - Math.max(0, mine.x0 - box.x0);
  } else {
    right = own;
    for (const d of others) {
      const o = d.block;
      if (o.refusal) continue;
      const overlap = Math.min(o.measure.right, own) - Math.max(o.measure.left, block.measure.left);
      if (overlap > 0) right = Math.max(right, o.measure.right);
    }
  }
  // Never into text beside it (the next column): one size short of its left edge.
  for (const d of others) {
    const e = blockExtent(d.block);
    if (e.x0 < mine.x1 || Math.min(e.y1, mine.y1) - Math.max(e.y0, mine.y0) <= BOX_TOLERANCE) {
      continue;
    }
    right = Math.min(right, e.x0 - block.size);
  }
  const pageBox = projectRect(
    { x: page.x ?? 0, y: page.y ?? 0, width: page.width, height: page.height },
    u,
  );
  return { right: Math.max(own, Math.min(right, pageBox.x1)), boxed };
}

/**
 * The block with its hard line breaks (step 11 of the module comment): such a line ends in
 * `forced`, and `\n` replaces the space that joined it to the next line in `text`.
 */
function withHardBreaks(
  block: Omit<ParagraphBlock, 'ref'>,
  facts: readonly LineFacts[],
  right: number,
): Omit<ParagraphBlock, 'ref'> {
  const left = block.measure.left;
  const width = right - left;
  const { lines } = block;
  if (width <= 0 || lines.length < 2) return block;
  const short = (line: ParagraphLine) => line.x1 - left < SHORT_LINE * width;
  // A short line before a line of one short word (an e-mail address, a URL): a soft break
  // leaves one only before the last line, unless the paragraph has other hard breaks.
  const hardAt = (i: number, beforeLast: boolean): boolean => {
    const line = lines[i] as ParagraphLine;
    const next = lines[i + 1];
    const f = facts[i];
    const g = facts[i + 1];
    if (!next || !f || !g || line.end !== 'space' || !short(line)) return false;
    if (line.x1 + f.space + g.firstWord <= right) return true;
    return (beforeLast || i + 2 < lines.length) && !/\s/u.test(next.text) && short(next);
  };
  let hard = lines.map((_, i) => hardAt(i, false));
  if (hard.some(Boolean)) hard = lines.map((_, i) => hardAt(i, true));
  let text = block.text;
  let changed = false;
  const out = lines.map((line, i): ParagraphLine => {
    if (!hard[i]) return line;
    const at = line.start + line.text.length;
    if (text[at] !== ' ') return line;
    text = `${text.slice(0, at)}\n${text.slice(at + 1)}`;
    changed = true;
    return { ...line, end: 'forced' };
  });
  return changed ? { ...block, lines: out, text } : block;
}

/** Every block with its `wrapRight` and hard line breaks. */
function settleMeasures(
  drafts: readonly DraftBlock[],
  boxes: readonly Rect[],
  page: PageGeometry,
): DraftBlock[] {
  return drafts.map((draft) => {
    if (!draft.facts) return draft;
    const { right, boxed } = wrapRightOf(draft, drafts, boxes, page);
    // A column's edge is a weaker hint than a box: hard breaks are judged on the block's own
    // measure unless a box gives one.
    const block = withHardBreaks(
      draft.block,
      draft.facts,
      boxed ? right : draft.block.measure.right,
    );
    return {
      ...draft,
      block: right > block.measure.right ? { ...block, wrapRight: right } : block,
    };
  });
}

/**
 * The paragraphs of a page from its located runs (`locatePage`) and paragraph tags
 * (`readParagraphTags`), in reading order. `boxes` are the bounds of the page's filled or
 * stroked paths (unrotated user space), which bound a rewrap's measure. See the module
 * comment for the rules.
 */
export function detectParagraphs(
  runs: readonly LocatedRun[],
  tags: readonly ParagraphTag[],
  page: PageGeometry,
  boxes: readonly Rect[] = [],
): ParagraphBlock[] {
  const preps = runs.filter((r) => r.glyphs.length > 0).map(prepare);
  const sizes = new Map<number, number>();
  for (const p of preps) {
    const key = Math.round(p.size * 2);
    sizes.set(key, (sizes.get(key) ?? 0) + p.run.glyphs.length);
  }
  let bodyKey = 0;
  let most = -1;
  for (const [key, count] of sizes) {
    if (count > most || (count === most && key < bodyKey)) {
      bodyKey = key;
      most = count;
    }
  }
  const bodySize = bodyKey / 2 || 10;

  // Frames: writing direction in 1° buckets; invisible text apart.
  const frameGroups = new Map<string, Prepared[]>();
  const vertical: Prepared[] = [];
  for (const p of preps) {
    if (p.run.vertical) {
      vertical.push(p);
      continue;
    }
    const angle = Math.round((Math.atan2(p.run.direction.y, p.run.direction.x) * 180) / Math.PI);
    const key = `${(angle + 360) % 360}:${p.run.renderMode === 3 ? 'i' : 'v'}`;
    frameGroups.set(key, [...(frameGroups.get(key) ?? []), p]);
  }
  const ordered = [...frameGroups.values()].sort(
    (a, b) =>
      b.reduce((n, p) => n + p.run.glyphs.length, 0) -
      a.reduce((n, p) => n + p.run.glyphs.length, 0),
  );
  const drafts: DraftBlock[] = [];
  for (const group of ordered) {
    const first = group[0] as Prepared;
    const angle = Math.atan2(first.run.direction.y, first.run.direction.x);
    const rounded = (Math.round((angle * 180) / Math.PI) * Math.PI) / 180;
    const u = { x: Math.cos(rounded), y: Math.sin(rounded) };
    const snapped = {
      x: Math.abs(u.x) < 1e-9 ? 0 : u.x,
      y: Math.abs(u.y) < 1e-9 ? 0 : u.y,
    };
    const blocks = detectFrame(group, { u: snapped }, tags, page, bodySize);
    drafts.push(...blocks.sort((a, b) => a.rank - b.rank));
  }
  for (const p of vertical) drafts.push(verticalBlock(p));
  return settleMeasures(drafts, boxes, page).map(({ block, runs: blockRuns }, index) => {
    const first = blockRuns[0] as LocatedRun;
    return {
      ...block,
      ref: { source: first.source, pageIndex: first.pageIndex, index, runs: blockRuns.map(refOf) },
    };
  });
}

// ---------------------------------------------------------------------------
// Engine side: one page's analysis, cached by page state
// ---------------------------------------------------------------------------

/** Pages whose analysis is kept (least recently used dropped first). */
const CACHE_PAGES = 32;

/**
 * A cheap digest of what detection depends on: the page box and rotation, every page object's
 * type and bounds, and the text page's characters. Equal digests mean the runs, and therefore
 * the paragraphs, are the same, whoever changed the page (an edit, an undo by replay, a
 * reopened source under the same id).
 */
export function pageFingerprint(raw: RawText, pagePtr: number, textPage: number): string {
  let h = 0x811c9dc5;
  const mix = (n: number) => {
    // FNV-1a over the value's text, so floats and negatives mix the same everywhere.
    const t = Number.isFinite(n) ? n.toFixed(2) : 'x';
    for (let i = 0; i < t.length; i++) {
      h ^= t.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= 0x2c;
    h = Math.imul(h, 0x01000193) >>> 0;
  };
  const box = raw.pageBox(pagePtr);
  [box.x, box.y, box.width, box.height, raw.m.FPDFPage_GetRotation(pagePtr)].forEach(mix);
  const objects = raw.pageObjects(pagePtr);
  mix(objects.length);
  for (const obj of objects) {
    mix(raw.objectType(obj));
    const b = raw.bounds(obj);
    if (b) [b.x, b.y, b.width, b.height].forEach(mix);
  }
  const count = raw.charCount(textPage);
  mix(count);
  for (let i = 0; i < count; i++) mix(raw.m.FPDFText_GetUnicode(textPage, i));
  return `${count}:${objects.length}:${h.toString(16)}`;
}

/** Analyses per source page, reused while the page's fingerprint is unchanged. */
export class ParagraphCache {
  private readonly entries = new Map<string, { digest: string; blocks: ParagraphBlock[] }>();

  get(source: SourceId, pageIndex: number, digest: string): ParagraphBlock[] | undefined {
    const key = `${source}:${pageIndex}`;
    const entry = this.entries.get(key);
    if (entry?.digest !== digest) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.blocks;
  }

  set(source: SourceId, pageIndex: number, digest: string, blocks: ParagraphBlock[]): void {
    const key = `${source}:${pageIndex}`;
    this.entries.delete(key);
    this.entries.set(key, { digest, blocks });
    while (this.entries.size > CACHE_PAGES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

/**
 * The paragraphs of a page inside a raw task: runs (`locatePage`), tags
 * (`readParagraphTags`), then `detectParagraphs`, reusing `cache` while the page's
 * fingerprint is unchanged.
 */
export function analyzePageParagraphs(
  raw: RawText,
  pagePtr: number,
  source: SourceId,
  pageIndex: number,
  cache?: ParagraphCache,
): ParagraphBlock[] {
  return raw.withTextPage(pagePtr, (textPage) => {
    const digest = pageFingerprint(raw, pagePtr, textPage);
    const cached = cache?.get(source, pageIndex, digest);
    if (cached) return cached;
    const runs = locatePage(raw, pagePtr, textPage, source, pageIndex);
    const tags = readParagraphTags(raw, pagePtr);
    const box = raw.pageBox(pagePtr);
    const blocks = detectParagraphs(
      runs,
      tags,
      {
        width: box.width,
        height: box.height,
        x: box.x,
        y: box.y,
        rotation: raw.m.FPDFPage_GetRotation(pagePtr) * 90,
      },
      raw.paintedPathBounds(pagePtr),
    );
    cache?.set(source, pageIndex, digest, blocks);
    return blocks;
  });
}
