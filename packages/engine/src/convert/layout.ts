/**
 * Reading order from glyph geometry (spec §4 "Reading order"). Everything here works in the
 * page's display space (top-left origin, y down, after rotation), so rotated pages read the
 * way they look:
 *
 * 1. Runs → segments: each `getPageText` line is split where two glyphs are further apart
 *    than 1.8 × the font size (a gutter, not a word space).
 * 2. Segments and images → reading order by recursive XY-cut: at each level the widest
 *    whitespace gap is cut, horizontal gaps top to bottom, vertical gutters (weighted ×2, so
 *    columns win over aligned baselines) left to right.
 * 3. Segments → lines: consecutive segments of one column on the same baseline (tolerance
 *    0.3 × font size).
 * 4. Lines → blocks: a new block at a column change, a list marker, a font size or weight
 *    change, a gap larger than the column's usual leading, or an indentation change.
 *
 * Running headers and footers (the same text at the same height on at least half of the
 * pages, digits ignored) are detected across pages before step 2.
 */
import type { Rect } from '@pdf-editor/document-model';

import { geometryOf } from '../analysis/geometry';
import { type LineChars, lineChars } from '../analysis/line-chars';
import { userToDeviceRect } from '../pdfium/coords';
import type { ComparePageGeometry, ConvertPageInput, TextRun } from '../types';

export interface Box {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** One UTF-16 unit of text with its style, box (display space) and link. */
export interface Unit {
  readonly ch: string;
  readonly box?: Box;
  readonly size: number;
  readonly bold: boolean;
  link: number;
}

export interface Segment {
  readonly kind: 'text';
  readonly units: Unit[];
  readonly text: string;
  readonly box: Box;
  /** Dominant font size (by character count). */
  readonly size: number;
  readonly bold: boolean;
  /** The segment ends its source line with a hyphenation mark. */
  readonly hyphen: 'soft' | 'hard' | undefined;
}

export interface ImageItem {
  readonly kind: 'image';
  readonly box: Box;
  /** Index into the page's `images`. */
  readonly index: number;
}

export type Item = Segment | ImageItem;

/** An item in reading order, with the path of vertical cuts that led to it (its column). */
export interface Placed {
  readonly item: Item;
  readonly column: string;
}

export function toDisplayBox(page: ComparePageGeometry, rect: Rect): Box {
  const r = userToDeviceRect(geometryOf(page), rect);
  return {
    x0: r.origin.x,
    y0: r.origin.y,
    x1: r.origin.x + r.size.width,
    y1: r.origin.y + r.size.height,
  };
}

export function unionBox(boxes: readonly Box[]): Box {
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const b of boxes) {
    x0 = Math.min(x0, b.x0);
    y0 = Math.min(y0, b.y0);
    x1 = Math.max(x1, b.x1);
    y1 = Math.max(y1, b.y1);
  }
  return { x0, y0, x1, y1 };
}

const BOLD = /bold|black|heavy|semibold|demi/i;
/** A gap wider than this many font sizes splits a line into segments. */
const SEGMENT_GAP = 1.8;

/** The most frequent value (the first to reach the top count on a tie). */
export function dominant<T>(values: readonly T[]): T | undefined {
  const counts = new Map<T, number>();
  let best: T | undefined;
  let bestCount = 0;
  for (const v of values) {
    const c = (counts.get(v) ?? 0) + 1;
    counts.set(v, c);
    if (c > bestCount) {
      best = v;
      bestCount = c;
    }
  }
  return best;
}

/** A font size rounded to the nearest half point. */
export const roundSize = (size: number) => Math.round(size * 2) / 2;

function makeSegment(units: Unit[], hyphen: Segment['hyphen']): Segment | undefined {
  // Trim generated or blank units at both ends.
  let start = 0;
  let end = units.length;
  while (start < end && (units[start]?.ch.trim() ?? '') === '') start++;
  while (end > start && (units[end - 1]?.ch.trim() ?? '') === '') end--;
  const kept = units.slice(start, end);
  const boxes = kept.flatMap((u) => (u.box ? [u.box] : []));
  if (kept.length === 0 || boxes.length === 0) return undefined;
  const styled = kept.filter((u) => u.box && u.ch.trim() !== '');
  const size = dominant(styled.map((u) => roundSize(u.size))) ?? 0;
  const boldCount = styled.filter((u) => u.bold).length;
  return {
    kind: 'text',
    units: kept,
    text: kept.map((u) => u.ch).join(''),
    box: unionBox(boxes),
    size,
    bold: boldCount * 2 > styled.length,
    hyphen,
  };
}

/** The runs of a page as segments (display space). */
export function pageSegments(page: ComparePageGeometry, runs: readonly TextRun[]): Segment[] {
  const out: Segment[] = [];
  for (const run of runs) {
    const chars: LineChars = lineChars(run);
    const units: Unit[] = [];
    for (let i = 0; i < chars.text.length; i++) {
      const rect = chars.boxes[i];
      const glyph = run.glyphs[chars.glyphIndex[i] ?? -1];
      units.push({
        ch: chars.text[i] ?? '',
        ...(rect ? { box: toDisplayBox(page, rect) } : {}),
        size: glyph?.fontSize ?? 0,
        bold: BOLD.test(glyph?.fontName ?? ''),
        link: -1,
      });
    }
    // Split at wide gaps between consecutive boxed units.
    let current: Unit[] = [];
    let last: Unit | undefined;
    const pieces: Unit[][] = [];
    for (const unit of units) {
      if (unit.box && last?.box) {
        const size = Math.max(unit.size, last.size, 1);
        const gap = unit.box.x0 - last.box.x1;
        if (gap > SEGMENT_GAP * size || gap < -4 * size) {
          pieces.push(current);
          current = [];
        }
      }
      current.push(unit);
      if (unit.box) last = unit;
    }
    pieces.push(current);
    pieces.forEach((piece, index) => {
      const segment = makeSegment(piece, index === pieces.length - 1 ? chars.hyphen : undefined);
      if (segment) out.push(segment);
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Running headers, footers and page numbers
// ---------------------------------------------------------------------------

export type DropReason = 'running-header' | 'running-footer' | 'page-number';

const PAGE_NUMBER =
  /^(page|p\.|seite|sayfa|página|pagina)?\s*[#ivxlcdm]+(\s*(of|\/|von|de|di)\s*#+)?$/i;
/** Only lines in the top or bottom band of the page can be running furniture. */
const MARGIN_BAND = 0.15;

function furnitureKey(text: string): string {
  return text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
}

/**
 * Which segments of which pages are running headers, footers or page numbers: the same text
 * (digits ignored) within 2 pt of the same height on at least half of the pages (and at
 * least two), inside the top or bottom 15 % of the page.
 */
export function detectFurniture(
  pages: readonly { readonly segments: readonly Segment[]; readonly height: number }[],
): Map<Segment, DropReason> {
  const out = new Map<Segment, DropReason>();
  const withText = pages.filter((p) => p.segments.length > 0).length;
  const needed = Math.max(2, Math.ceil(withText / 2));
  if (withText < 2) return out;
  interface Candidate {
    readonly key: string;
    readonly y: number;
    readonly page: number;
    readonly segment: Segment;
    readonly top: boolean;
  }
  const candidates: Candidate[] = [];
  pages.forEach((page, index) => {
    for (const segment of page.segments) {
      const top = segment.box.y1 <= page.height * MARGIN_BAND;
      const bottom = segment.box.y0 >= page.height * (1 - MARGIN_BAND);
      if (!top && !bottom) continue;
      candidates.push({
        key: furnitureKey(segment.text),
        y: segment.box.y0,
        page: index,
        segment,
        top,
      });
    }
  });
  for (const c of candidates) {
    const pagesSeen = new Set<number>();
    for (const other of candidates) {
      if (other.key === c.key && Math.abs(other.y - c.y) <= 2) pagesSeen.add(other.page);
    }
    if (pagesSeen.size < needed) continue;
    const reason: DropReason = PAGE_NUMBER.test(c.key)
      ? 'page-number'
      : c.top
        ? 'running-header'
        : 'running-footer';
    out.set(c.segment, reason);
  }
  return out;
}

// ---------------------------------------------------------------------------
// XY-cut
// ---------------------------------------------------------------------------

interface Gap {
  readonly at: number;
  readonly size: number;
}

/** Widest gap between the projections of `items` on one axis. */
function widestGap(items: readonly Item[], axis: 'x' | 'y'): Gap | undefined {
  const spans = items
    .map((i): [number, number] => (axis === 'x' ? [i.box.x0, i.box.x1] : [i.box.y0, i.box.y1]))
    .sort((p, q) => p[0] - q[0]);
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

function medianSize(items: readonly Item[]): number {
  const sizes = items.flatMap((i) => (i.kind === 'text' ? [i.size] : [])).sort((a, b) => a - b);
  return sizes[Math.floor(sizes.length / 2)] ?? 10;
}

/** Items in reading order, each tagged with its column path. */
export function xyCut(items: readonly Item[], column = ''): Placed[] {
  if (items.length <= 1) return items.map((item) => ({ item, column }));
  const size = medianSize(items);
  const vertical = widestGap(items, 'x');
  const horizontal = widestGap(items, 'y');
  const useVertical =
    vertical !== undefined &&
    vertical.size >= Math.max(0.8 * size, 6) &&
    (horizontal === undefined || 2 * vertical.size >= horizontal.size);
  if (useVertical) {
    const left = items.filter((i) => (i.box.x0 + i.box.x1) / 2 < vertical.at);
    const right = items.filter((i) => (i.box.x0 + i.box.x1) / 2 >= vertical.at);
    if (left.length > 0 && right.length > 0) {
      return [...xyCut(left, `${column}L`), ...xyCut(right, `${column}R`)];
    }
  }
  if (horizontal !== undefined && horizontal.size > 0) {
    const above = items.filter((i) => (i.box.y0 + i.box.y1) / 2 < horizontal.at);
    const below = items.filter((i) => (i.box.y0 + i.box.y1) / 2 >= horizontal.at);
    if (above.length > 0 && below.length > 0) {
      return [...xyCut(above, column), ...xyCut(below, column)];
    }
  }
  // No clean cut (overlapping items): top to bottom, left to right.
  return [...items]
    .sort((p, q) => p.box.y0 - q.box.y0 || p.box.x0 - q.box.x0)
    .map((item) => ({ item, column }));
}

// ---------------------------------------------------------------------------
// Lines and blocks
// ---------------------------------------------------------------------------

export interface Line {
  readonly segments: Segment[];
  readonly box: Box;
  readonly size: number;
  readonly bold: boolean;
  readonly column: string;
  readonly hyphen: Segment['hyphen'];
}

export type Flow =
  | { readonly kind: 'line'; readonly line: Line }
  | { readonly kind: 'image'; readonly image: ImageItem; readonly column: string };

/** Groups consecutive segments of one column on the same baseline into lines. */
export function toLines(placed: readonly Placed[]): Flow[] {
  const out: Flow[] = [];
  let current: { segments: Segment[]; column: string } | undefined;
  const flush = () => {
    if (!current) return;
    const segs = current.segments;
    const styled = segs.flatMap((s) => s.units.filter((u) => u.box && u.ch.trim() !== ''));
    const last = segs[segs.length - 1] as Segment;
    out.push({
      kind: 'line',
      line: {
        segments: segs,
        box: unionBox(segs.map((s) => s.box)),
        size: dominant(styled.map((u) => roundSize(u.size))) ?? last.size,
        bold: styled.filter((u) => u.bold).length * 2 > styled.length,
        column: current.column,
        hyphen: last.hyphen,
      },
    });
    current = undefined;
  };
  for (const { item, column } of placed) {
    if (item.kind === 'image') {
      flush();
      out.push({ kind: 'image', image: item, column });
      continue;
    }
    const prev = current?.segments[current.segments.length - 1];
    const sameLine =
      current !== undefined &&
      prev !== undefined &&
      current.column === column &&
      Math.abs(prev.box.y1 - item.box.y1) <= 0.3 * Math.max(prev.size, item.size) &&
      item.box.x0 >= prev.box.x1 - 1;
    if (!sameLine) flush();
    current ??= { segments: [], column };
    current.segments.push(item);
  }
  flush();
  return out;
}

/** List markers: bullets, and enumerators such as `1.`, `a)`, `iv.`. */
const BULLET = /^([•◦▪▫‣⁃●○■□·–\-*])\s+/u;
const ENUMERATOR = /^((\d{1,3})|([a-z])|([ivxlcdm]{1,6}))([.)])\s+/i;

export interface ListMarker {
  readonly marker: string;
  readonly ordered: boolean;
  /** The number of a numeric enumerator. */
  readonly number?: number;
  /** UTF-16 units of the line text taken by the marker and its space. */
  readonly length: number;
}

export function lineText(line: Line): string {
  return line.segments.map((s) => s.text).join(' ');
}

export function listMarker(text: string): ListMarker | undefined {
  const bullet = BULLET.exec(text);
  if (bullet) return { marker: bullet[1] ?? '-', ordered: false, length: bullet[0].length };
  const enumerator = ENUMERATOR.exec(text);
  if (enumerator) {
    const digits = enumerator[2];
    return {
      marker: `${enumerator[1] ?? ''}${enumerator[5] ?? ''}`,
      ordered: true,
      ...(digits === undefined ? {} : { number: Number(digits) }),
      length: enumerator[0].length,
    };
  }
  return undefined;
}

export interface TextBlock {
  readonly kind: 'text';
  readonly lines: Line[];
  readonly marker?: ListMarker;
  readonly column: string;
}

export interface ImageBlock {
  readonly kind: 'image';
  readonly image: ImageItem;
}

export type Block = TextBlock | ImageBlock;

/** The upper median (the middle element of the sorted values); undefined when empty. */
export function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Same weight and a size within 10 %: a change of either starts a new block. */
export const sameStyle = (
  a: { readonly bold: boolean; readonly size: number },
  b: { readonly bold: boolean; readonly size: number },
) => a.bold === b.bold && Math.abs(a.size - b.size) <= 0.1 * Math.max(a.size, b.size);

/**
 * The white space between two lines above which a new block starts: more than the column's
 * usual gap `leading` (capped: a document whose lines are all far apart still breaks
 * paragraphs at 1.3 × the font size), and never below 0.6 × the size.
 */
export function blockBreakGap(size: number, leading: number): number {
  return Math.max(0.6 * size, Math.min(1.5 * leading + 1, 1.3 * size));
}

/** Splits the flow into blocks (paragraphs, list items, headings, images). */
export function toBlocks(flow: readonly Flow[]): Block[] {
  // Usual leading per column: the median gap between consecutive lines of one style.
  const gaps = new Map<string, number[]>();
  for (let i = 1; i < flow.length; i++) {
    const p = flow[i - 1];
    const l = flow[i];
    if (p?.kind !== 'line' || l?.kind !== 'line' || p.line.column !== l.line.column) continue;
    if (!sameStyle(p.line, l.line)) continue;
    const gap = l.line.box.y0 - p.line.box.y1;
    if (gap >= 0) gaps.set(l.line.column, [...(gaps.get(l.line.column) ?? []), gap]);
  }
  const blocks: Block[] = [];
  let block: { lines: Line[]; marker?: ListMarker; column: string; bodyLeft?: number } | undefined;
  const flush = () => {
    if (block) {
      blocks.push({
        kind: 'text',
        lines: block.lines,
        ...(block.marker ? { marker: block.marker } : {}),
        column: block.column,
      });
    }
    block = undefined;
  };
  for (const entry of flow) {
    if (entry.kind === 'image') {
      flush();
      blocks.push({ kind: 'image', image: entry.image });
      continue;
    }
    const line = entry.line;
    const marker = listMarker(lineText(line));
    const prev = block?.lines[block.lines.length - 1];
    let breakBefore = !block || !prev || marker !== undefined || block.column !== line.column;
    if (!breakBefore && block && prev) {
      const size = Math.max(line.size, prev.size, 1);
      const leading = median(gaps.get(line.column) ?? []) ?? 0.3 * size;
      const gap = line.box.y0 - prev.box.y1;
      if (!sameStyle(prev, line)) breakBefore = true;
      // More than the column's usual leading (see `blockBreakGap`).
      else if (gap > blockBreakGap(size, leading)) breakBefore = true;
      else if (gap < -0.5 * size) breakBefore = true;
      else {
        const first = block.lines[0] as Line;
        const left = block.bodyLeft ?? first.box.x0;
        if (line.box.x0 > left + size) {
          // Indented: a new paragraph, except the wrapped text of a list item (indented past
          // its marker) on the item's second line.
          breakBefore = !(block.marker && block.bodyLeft === undefined);
        } else if (line.box.x0 < left - size) {
          // Outdented: fine after an indented first line; a new block otherwise.
          breakBefore = block.bodyLeft !== undefined || block.marker !== undefined;
        }
      }
    }
    if (breakBefore) {
      flush();
      block = { lines: [line], column: line.column, ...(marker ? { marker } : {}) };
      continue;
    }
    if (block) {
      block.lines.push(line);
      block.bodyLeft ??= line.box.x0;
    }
  }
  flush();
  return blocks;
}

/** What `tableRows` needs of a segment: its box (display space, y down) and font size. */
export interface Boxed {
  readonly box: Box;
  readonly size: number;
}

/**
 * Groups of at least three consecutive rows with three or more segments each, two of whose
 * left edges line up: laid out like a table. Rows are segments sharing a baseline (box
 * bottoms within 0.3 × the size) anywhere on the page, in order of their bottoms; each group
 * lists its rows.
 */
export function tableRows<T extends Boxed>(segments: readonly T[]): T[][][] {
  const rows: T[][] = [];
  for (const s of [...segments].sort((a, b) => a.box.y1 - b.box.y1)) {
    const row = rows[rows.length - 1];
    const first = row?.[0];
    if (row && first && Math.abs(first.box.y1 - s.box.y1) <= 0.3 * Math.max(first.size, s.size))
      row.push(s);
    else rows.push([s]);
  }
  const tables: T[][][] = [];
  let run: T[][] = [];
  const close = () => {
    if (run.length >= 3) {
      // At least two cell starts line up across the rows.
      const starts = run.map((row) => new Set(row.map((s) => Math.round(s.box.x0 / 2))));
      const common = [...(starts[0] ?? [])].filter((x) => starts.every((set) => set.has(x)));
      if (common.length >= 2) tables.push(run);
    }
    run = [];
  };
  for (const row of rows) {
    if (row.length >= 3) run.push(row);
    else close();
  }
  close();
  return tables;
}

/**
 * How many groups of the page's segments are laid out like a table (`tableRows`; only
 * counted: their text keeps reading order).
 */
export function suspectedTables(segments: readonly Segment[]): number {
  return tableRows(segments).length;
}

/** Marks units whose box centre lies in a link rect (display space). */
export function applyLinks(page: ConvertPageInput, segments: readonly Segment[]): void {
  const links = (page.links ?? []).map((l) => toDisplayBox(page, l.rect));
  if (links.length === 0) return;
  for (const s of segments) {
    for (const u of s.units) {
      if (!u.box) continue;
      const cx = (u.box.x0 + u.box.x1) / 2;
      const cy = (u.box.y0 + u.box.y1) / 2;
      u.link = links.findIndex((b) => cx >= b.x0 && cx <= b.x1 && cy >= b.y0 && cy <= b.y1);
    }
    // Generated characters (spaces) between two units of the same link belong to it.
    for (let i = 0; i < s.units.length; i++) {
      const u = s.units[i] as Unit;
      if (u.box) continue;
      const before = s.units[i - 1]?.link ?? -1;
      const after = s.units[i + 1]?.link ?? -1;
      if (before >= 0 && before === after) u.link = before;
    }
  }
}
