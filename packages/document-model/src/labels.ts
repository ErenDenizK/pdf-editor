/**
 * Page label semantics.
 *
 * Effective label of the page at `index` (derived at read time, never stored per page):
 *   1. the explicit range in `VirtualDocument.labels` covering `index` (the range with the
 *      greatest startIndex <= index), formatted as prefix + number in the range's style;
 *   2. otherwise the source page's authored label (`SourcePageInfo.label`);
 *   3. otherwise the 1-based position.
 *
 * Explicit ranges are anchored to the page at their startIndex: structural edits shift
 * them (see `shiftLabelsForRemoval` / `shiftLabelsForInsertion`), so deleting a page in the
 * front matter renumbers the front matter without disturbing the body.
 */
import { DocumentModelError } from './errors';
import { lookup, requireDocument, withWorkspace, putDocuments } from './internal';
import type {
  DocumentId,
  PageLabelRange,
  PageLabelStyle,
  VirtualDocument,
  Workspace,
} from './types';

export const PAGE_LABEL_STYLES: readonly PageLabelStyle[] = [
  'decimal',
  'roman-upper',
  'roman-lower',
  'alpha-upper',
  'alpha-lower',
  'none',
];

export interface ParsedLabel {
  readonly style: PageLabelStyle;
  readonly prefix: string;
  /** Absent for style 'none'. Always >= 1 otherwise. */
  readonly number?: number;
}

// ---------------------------------------------------------------------------
// Number formatting
// ---------------------------------------------------------------------------

const ROMAN: readonly (readonly [number, string])[] = [
  [1000, 'M'],
  [900, 'CM'],
  [500, 'D'],
  [400, 'CD'],
  [100, 'C'],
  [90, 'XC'],
  [50, 'L'],
  [40, 'XL'],
  [10, 'X'],
  [9, 'IX'],
  [5, 'V'],
  [4, 'IV'],
  [1, 'I'],
];

export function toRoman(value: number): string {
  let rest = value;
  let out = '';
  for (const [amount, glyph] of ROMAN) {
    while (rest >= amount) {
      out += glyph;
      rest -= amount;
    }
  }
  return out;
}

const CANONICAL_ROMAN = /^M*(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/;
const ROMAN_VALUES: Readonly<Record<string, number>> = {
  I: 1,
  V: 5,
  X: 10,
  L: 50,
  C: 100,
  D: 500,
  M: 1000,
};

/** Parses an upper-case canonical roman numeral; undefined when not canonical. */
export function fromRoman(text: string): number | undefined {
  if (text.length === 0 || !CANONICAL_ROMAN.test(text)) return undefined;
  let total = 0;
  for (let i = 0; i < text.length; i++) {
    const current = ROMAN_VALUES[text.charAt(i)] ?? 0;
    const next = ROMAN_VALUES[text.charAt(i + 1)] ?? 0;
    total += current < next ? -current : current;
  }
  return total;
}

/** PDF alphabetic numbering: A…Z, AA…ZZ, AAA… (the letter repeats). */
export function toAlpha(value: number): string {
  const letter = String.fromCharCode(65 + ((value - 1) % 26));
  return letter.repeat(Math.floor((value - 1) / 26) + 1);
}

export function formatLabelNumber(style: PageLabelStyle, value: number): string {
  switch (style) {
    case 'decimal':
      return String(value);
    case 'roman-upper':
      return toRoman(value);
    case 'roman-lower':
      return toRoman(value).toLowerCase();
    case 'alpha-upper':
      return toAlpha(value);
    case 'alpha-lower':
      return toAlpha(value).toLowerCase();
    case 'none':
      return '';
  }
}

/** Label of the page `offset` pages after the start of `range`. */
export function formatRangeLabel(range: PageLabelRange, offset: number): string {
  const prefix = range.prefix ?? '';
  if (range.style === 'none') return prefix;
  return prefix + formatLabelNumber(range.style, (range.firstNumber ?? 1) + offset);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function romanCandidate(label: string, upper: boolean): ParsedLabel | undefined {
  const charset = upper ? /[IVXLCDM]/ : /[ivxlcdm]/;
  let start = label.length;
  while (start > 0 && charset.test(label.charAt(start - 1))) start--;
  // Longest canonical suffix wins ("xiv" is 14, not "x" + 4).
  for (let i = start; i < label.length; i++) {
    const digits = label.slice(i);
    const value = fromRoman(upper ? digits : digits.toUpperCase());
    if (value !== undefined) {
      return {
        style: upper ? 'roman-upper' : 'roman-lower',
        prefix: label.slice(0, i),
        number: value,
      };
    }
  }
  return undefined;
}

function alphaCandidates(label: string): ParsedLabel[] {
  const last = label.charAt(label.length - 1);
  const upper = last >= 'A' && last <= 'Z';
  const lower = last >= 'a' && last <= 'z';
  if (!upper && !lower) return [];
  let run = 0;
  while (run < label.length && label.charAt(label.length - 1 - run) === last) run++;
  const letterValue = last.toUpperCase().charCodeAt(0) - 64;
  const style: PageLabelStyle = upper ? 'alpha-upper' : 'alpha-lower';
  const out: ParsedLabel[] = [];
  for (let length = run; length >= 1; length--) {
    out.push({
      style,
      prefix: label.slice(0, label.length - length),
      number: (length - 1) * 26 + letterValue,
    });
  }
  return out;
}

/**
 * Every way `label` can be expressed as a PDF label range entry, preferred first:
 * decimal, roman, alphabetic, then `none` (prefix = literal label), then letter readings
 * whose prefix ends in a letter. Each candidate round-trips exactly through
 * `formatRangeLabel`.
 */
export function labelCandidates(label: string): ParsedLabel[] {
  const out: ParsedLabel[] = [];
  const digits = /[0-9]+$/.exec(label);
  if (digits !== null) {
    // Leading zeros cannot be expressed numerically; they move into the prefix.
    const trimmed = digits[0].replace(/^0+/, '');
    const value = Number(trimmed);
    if (trimmed.length > 0 && Number.isSafeInteger(value)) {
      out.push({
        style: 'decimal',
        prefix: label.slice(0, label.length - trimmed.length),
        number: value,
      });
    }
  }
  // Letter numerals glued to a preceding letter ("Cover" = "Cove" + r) are unlikely
  // readings; they rank after the literal but stay available for sequence detection.
  const unlikely: ParsedLabel[] = [];
  const letterCandidates = [
    romanCandidate(label, true),
    romanCandidate(label, false),
    ...alphaCandidates(label),
  ];
  for (const candidate of letterCandidates) {
    if (candidate === undefined) continue;
    (/\p{L}$/u.test(candidate.prefix) ? unlikely : out).push(candidate);
  }
  out.push({ style: 'none', prefix: label }, ...unlikely);
  return out;
}

/** Best single reading of a label (never throws; falls back to style 'none'). */
export function parseLabel(label: string): ParsedLabel {
  return labelCandidates(label)[0] ?? { style: 'none', prefix: label };
}

function parsedToRange(parsed: ParsedLabel, startIndex: number): PageLabelRange {
  const withPrefix = parsed.prefix.length > 0 ? { prefix: parsed.prefix } : {};
  return parsed.number === undefined
    ? { startIndex, style: parsed.style, ...withPrefix }
    : { startIndex, style: parsed.style, ...withPrefix, firstNumber: parsed.number };
}

// ---------------------------------------------------------------------------
// Effective labels
// ---------------------------------------------------------------------------

/** The explicit range covering `index`, if any. */
export function explicitRangeAt(
  labels: readonly PageLabelRange[],
  index: number,
): PageLabelRange | undefined {
  let found: PageLabelRange | undefined;
  for (const range of labels) {
    if (range.startIndex > index) break;
    found = range;
  }
  return found;
}

export function effectiveLabel(ws: Workspace, doc: VirtualDocument, index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= doc.pages.length) {
    throw new DocumentModelError('invalid-index', `Page index ${index} outside document`);
  }
  const range = explicitRangeAt(doc.labels, index);
  if (range !== undefined) return formatRangeLabel(range, index - range.startIndex);
  const ref = doc.pages[index]?.ref;
  if (ref?.kind === 'source') {
    const authored = lookup(ws.sources, ref.source)?.pages[ref.index]?.label;
    if (authored !== undefined) return authored;
  }
  return String(index + 1);
}

export function effectiveLabels(ws: Workspace, doc: VirtualDocument): string[] {
  return doc.pages.map((_, index) => effectiveLabel(ws, doc, index));
}

/**
 * Compresses a list of labels into ranges suitable for a /PageLabels number tree.
 * Greedy: a range continues while the next label equals the expected successor; a new
 * range picks the candidate reading that the following label continues, else the
 * preferred reading. Always round-trips: formatting the result reproduces `labels`.
 */
export function deriveRangesFromLabels(labels: readonly string[]): PageLabelRange[] {
  const ranges: PageLabelRange[] = [];
  let current: PageLabelRange | undefined;
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i] ?? '';
    if (current !== undefined && formatRangeLabel(current, i - current.startIndex) === label) {
      continue;
    }
    const next = labels[i + 1];
    const candidates = labelCandidates(label);
    const continued = candidates.find(
      (candidate) =>
        next !== undefined && formatRangeLabel(parsedToRange(candidate, 0), 1) === next,
    );
    const chosen = continued ?? candidates[0] ?? { style: 'none', prefix: label };
    current = parsedToRange(chosen, i);
    ranges.push(current);
  }
  return ranges;
}

export function deriveLabelRanges(ws: Workspace, doc: VirtualDocument): PageLabelRange[] {
  return deriveRangesFromLabels(effectiveLabels(ws, doc));
}

// ---------------------------------------------------------------------------
// Validation and editing
// ---------------------------------------------------------------------------

/** Throws `invalid-range` unless ranges are well-formed for a document of `pageCount`. */
export function assertLabelRanges(labels: readonly PageLabelRange[], pageCount: number): void {
  let previous = -1;
  for (const range of labels) {
    const where = `Label range at ${String(range.startIndex)}`;
    if (
      !Number.isInteger(range.startIndex) ||
      range.startIndex < 0 ||
      range.startIndex >= pageCount
    ) {
      throw new DocumentModelError(
        'invalid-range',
        `${where}: startIndex outside 0…${pageCount - 1}`,
      );
    }
    if (range.startIndex <= previous) {
      throw new DocumentModelError('invalid-range', `${where}: startIndex must strictly increase`);
    }
    if (!PAGE_LABEL_STYLES.includes(range.style)) {
      throw new DocumentModelError('invalid-range', `${where}: unknown style`);
    }
    if (
      range.firstNumber !== undefined &&
      (!Number.isSafeInteger(range.firstNumber) || range.firstNumber < 1)
    ) {
      throw new DocumentModelError(
        'invalid-range',
        `${where}: firstNumber must be an integer >= 1`,
      );
    }
    if (range.prefix !== undefined && typeof range.prefix !== 'string') {
      throw new DocumentModelError('invalid-range', `${where}: prefix must be a string`);
    }
    previous = range.startIndex;
  }
}

/** Replaces a document's explicit label ranges (sorted by startIndex first). */
export function setLabelRanges(
  ws: Workspace,
  documentId: DocumentId,
  labels: readonly PageLabelRange[],
): Workspace {
  const doc = requireDocument(ws, documentId);
  const sorted = [...labels].sort((a, b) => a.startIndex - b.startIndex);
  assertLabelRanges(sorted, doc.pages.length);
  const next: VirtualDocument = { ...doc, labels: sorted, clean: false };
  return withWorkspace(ws, { documents: putDocuments(ws.documents, [next]) });
}

// ---------------------------------------------------------------------------
// Range maintenance under structural edits (used by pages.ts)
// ---------------------------------------------------------------------------

/**
 * Pages at `removed` (indices before removal) were deleted. Each range stays anchored to
 * its first page; if that page was removed, the next surviving page becomes the anchor.
 * When two ranges collapse onto the same page, the later one wins.
 */
export function shiftLabelsForRemoval(
  labels: readonly PageLabelRange[],
  removed: ReadonlySet<number>,
  newLength: number,
): readonly PageLabelRange[] {
  if (labels.length === 0 || removed.size === 0) return labels;
  const sortedRemoved = [...removed].sort((a, b) => a - b);
  const out: PageLabelRange[] = [];
  let changed = false;
  for (const range of labels) {
    let before = 0;
    while (before < sortedRemoved.length && (sortedRemoved[before] ?? 0) < range.startIndex)
      before++;
    const startIndex = range.startIndex - before;
    if (startIndex >= newLength) {
      changed = true;
      continue;
    }
    if (out.length > 0 && out[out.length - 1]?.startIndex === startIndex) {
      out.pop();
      changed = true;
    }
    if (startIndex !== range.startIndex) changed = true;
    out.push(startIndex === range.startIndex ? range : { ...range, startIndex });
  }
  return changed ? out : labels;
}

/**
 * `count` pages were inserted before the page at `index`. Ranges anchored at or after the
 * insertion point shift, so inserted pages continue the preceding range; a range anchored
 * at 0 never moves (inserting at the very front joins the first range).
 */
export function shiftLabelsForInsertion(
  labels: readonly PageLabelRange[],
  index: number,
  count: number,
): readonly PageLabelRange[] {
  if (count === 0 || !labels.some((r) => r.startIndex >= index && r.startIndex > 0)) return labels;
  return labels.map((range) =>
    range.startIndex >= index && range.startIndex > 0
      ? { ...range, startIndex: range.startIndex + count }
      : range,
  );
}

/**
 * Explicit ranges for the pages [start, end) moved into a document of their own; labels
 * are preserved (the covering range is re-based with an adjusted firstNumber).
 */
export function sliceLabels(
  labels: readonly PageLabelRange[],
  start: number,
  end: number,
): PageLabelRange[] {
  const out: PageLabelRange[] = [];
  const covering = explicitRangeAt(labels, start);
  if (covering !== undefined) {
    out.push(
      covering.style === 'none'
        ? { ...covering, startIndex: 0 }
        : {
            ...covering,
            startIndex: 0,
            firstNumber: (covering.firstNumber ?? 1) + (start - covering.startIndex),
          },
    );
  }
  for (const range of labels) {
    if (range.startIndex > start && range.startIndex < end) {
      out.push({ ...range, startIndex: range.startIndex - start });
    }
  }
  return out;
}
