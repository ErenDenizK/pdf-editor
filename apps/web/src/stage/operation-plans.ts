/**
 * Pure planners for the section operations (spec §5): page-range parsing, split preview
 * math, outline cut points, interleave previews and title validation. No store, no DOM,
 * no messages: the dialogs turn the results into localized text, and unit tests cover the
 * math directly.
 */
import type { InterleaveMode, PageId, VirtualDocument } from '@pdf-editor/document-model';

// ---------------------------------------------------------------------------
// Page ranges ("1-3, 5, 8-10")
// ---------------------------------------------------------------------------

/** 0-based inclusive [start, end], the model's `SplitSpec` range format. */
export type PageRange = readonly [number, number];

export type RangeProblem =
  | { readonly kind: 'empty' }
  | { readonly kind: 'syntax'; readonly token: string }
  | { readonly kind: 'zero'; readonly token: string }
  | { readonly kind: 'reversed'; readonly token: string }
  | { readonly kind: 'out-of-bounds'; readonly token: string; readonly pageCount: number }
  | { readonly kind: 'overlap'; readonly first: string; readonly second: string };

export type RangeParse =
  | { readonly ok: true; readonly ranges: readonly PageRange[] }
  | { readonly ok: false; readonly problems: readonly RangeProblem[] };

const DASHES = /[-‐‑‒–—]/;
const RANGE_TOKEN = /^(\d+)?\s*[-‐‑‒–—]\s*(\d+)?$/;

/**
 * Parses 1-based page ranges typed by a user: numbers and `a-b` spans separated by commas
 * or semicolons (`1-3, 5, 8-10`). Open ends are allowed (`8-` to the end, `-3` from the
 * start). Returns the model's 0-based inclusive pairs in the order typed, or every problem
 * found (so the dialog can show them all at once).
 */
export function parsePageRanges(text: string, pageCount: number): RangeParse {
  const tokens = text
    .split(/[,;]/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return { ok: false, problems: [{ kind: 'empty' }] };

  const problems: RangeProblem[] = [];
  const parsed: { token: string; range: PageRange }[] = [];
  for (const token of tokens) {
    let start: number;
    let end: number;
    if (/^\d+$/.test(token)) {
      start = end = Number(token);
    } else if (DASHES.test(token)) {
      const match = RANGE_TOKEN.exec(token);
      if (match === null || (match[1] === undefined && match[2] === undefined)) {
        problems.push({ kind: 'syntax', token });
        continue;
      }
      start = match[1] === undefined ? 1 : Number(match[1]);
      end = match[2] === undefined ? pageCount : Number(match[2]);
    } else {
      problems.push({ kind: 'syntax', token });
      continue;
    }
    if (start === 0 || end === 0) {
      problems.push({ kind: 'zero', token });
      continue;
    }
    if (end < start) {
      problems.push({ kind: 'reversed', token });
      continue;
    }
    if (end > pageCount) {
      problems.push({ kind: 'out-of-bounds', token, pageCount });
      continue;
    }
    parsed.push({ token, range: [start - 1, end - 1] });
  }

  const sorted = [...parsed].sort((a, b) => a.range[0] - b.range[0]);
  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1];
    const current = sorted[i];
    if (previous && current && current.range[0] <= previous.range[1]) {
      problems.push({ kind: 'overlap', first: previous.token, second: current.token });
    }
  }
  return problems.length > 0
    ? { ok: false, problems }
    : { ok: true, ranges: parsed.map((p) => p.range) };
}

// ---------------------------------------------------------------------------
// Split preview
// ---------------------------------------------------------------------------

export type SplitInput =
  | { readonly mode: 'every'; readonly n: number }
  | { readonly mode: 'ranges'; readonly ranges: readonly PageRange[] }
  /** 0-based indices where a new part starts (index 0 is ignored). */
  | { readonly mode: 'cuts'; readonly cuts: readonly number[] };

export type SplitPreview =
  | {
      readonly ok: true;
      /** Page count of each new document, in order. */
      readonly parts: readonly number[];
      /** Pages that stay in the original document ('ranges' only). */
      readonly remaining: number;
    }
  | { readonly ok: false; readonly reason: 'single-part' | 'invalid' | 'empty-document' };

/** What a split would create, mirroring the model's `splitDocument` rules. */
export function previewSplit(pageCount: number, input: SplitInput): SplitPreview {
  if (pageCount <= 0) return { ok: false, reason: 'empty-document' };
  switch (input.mode) {
    case 'every': {
      if (!Number.isInteger(input.n) || input.n < 1) return { ok: false, reason: 'invalid' };
      const parts: number[] = [];
      for (let start = 0; start < pageCount; start += input.n) {
        parts.push(Math.min(input.n, pageCount - start));
      }
      return parts.length < 2
        ? { ok: false, reason: 'single-part' }
        : { ok: true, parts, remaining: 0 };
    }
    case 'ranges': {
      if (input.ranges.length === 0) return { ok: false, reason: 'invalid' };
      let covered = 0;
      for (const [start, end] of input.ranges) {
        if (start < 0 || end < start || end >= pageCount) return { ok: false, reason: 'invalid' };
        covered += end - start + 1;
      }
      return {
        ok: true,
        parts: input.ranges.map(([start, end]) => end - start + 1),
        remaining: pageCount - covered,
      };
    }
    case 'cuts': {
      const cuts = [...new Set(input.cuts)]
        .filter((cut) => Number.isInteger(cut) && cut > 0 && cut < pageCount)
        .sort((a, b) => a - b);
      if (cuts.length === 0) return { ok: false, reason: 'single-part' };
      const bounds = [0, ...cuts, pageCount];
      const parts = bounds.slice(1).map((end, i) => end - (bounds[i] ?? 0));
      return { ok: true, parts, remaining: 0 };
    }
  }
}

/** A sensible default chunk size: two parts, rounded up. */
export function defaultChunkSize(pageCount: number): number {
  return Math.max(1, Math.ceil(pageCount / 2));
}

/**
 * Cut points from the top-level bookmarks: every top-level node that points at a page of
 * this document starts a part. `titles[k]` is the bookmark that starts part k (undefined
 * for a leading part without a bookmark).
 */
export function outlineCuts(doc: VirtualDocument): {
  readonly cuts: readonly number[];
  readonly titles: readonly (string | undefined)[];
  /** Top-level bookmarks with a page destination. */
  readonly bookmarks: number;
} {
  const index = new Map<PageId, number>(doc.pages.map((p, i) => [p.id, i] as const));
  const starts = new Map<number, string>();
  let bookmarks = 0;
  for (const node of doc.outline) {
    const destination = node.destination;
    if (destination?.kind !== 'page') continue;
    const at = index.get(destination.page);
    if (at === undefined) continue;
    bookmarks += 1;
    if (!starts.has(at)) starts.set(at, node.title);
  }
  const cuts = [...starts.keys()].filter((i) => i > 0).sort((a, b) => a - b);
  const titles = [starts.get(0), ...cuts.map((cut) => starts.get(cut))];
  return { cuts, titles, bookmarks };
}

/** Cut points from selected pages of `doc`: each selected page starts a new part. */
export function selectionCuts(doc: VirtualDocument, selected: ReadonlySet<PageId>): number[] {
  return doc.pages.flatMap((page, i) => (i > 0 && selected.has(page.id) ? [i] : []));
}

// ---------------------------------------------------------------------------
// Interleave preview
// ---------------------------------------------------------------------------

export interface InterleaveSlot {
  readonly from: 'a' | 'b';
  /** 1-based page number within its input document. */
  readonly page: number;
}

/**
 * The first `limit` pages of an interleave result, mirroring the model's `interleave`
 * (a1, b1, a2, b2, …; leftovers appended; duplex reverses b first).
 */
export function previewInterleave(
  aCount: number,
  bCount: number,
  mode: InterleaveMode,
  limit = 6,
): InterleaveSlot[] {
  const b = Array.from({ length: bCount }, (_, i) => i + 1);
  if (mode === 'duplex-reverse-b') b.reverse();
  const slots: InterleaveSlot[] = [];
  for (let i = 0; i < Math.max(aCount, bCount) && slots.length < limit; i++) {
    if (i < aCount) slots.push({ from: 'a', page: i + 1 });
    const fromB = b[i];
    if (fromB !== undefined && slots.length < limit) slots.push({ from: 'b', page: fromB });
  }
  return slots;
}

// ---------------------------------------------------------------------------
// Titles
// ---------------------------------------------------------------------------

export const MAX_TITLE_LENGTH = 200;

export type TitleProblem = 'empty' | 'too-long' | 'control';

/** Validates a document title; returns the trimmed title or the problem. */
export function validateTitle(
  raw: string,
):
  | { readonly ok: true; readonly title: string }
  | { readonly ok: false; readonly problem: TitleProblem } {
  const title = raw.trim();
  if (title.length === 0) return { ok: false, problem: 'empty' };
  if (title.length > MAX_TITLE_LENGTH) return { ok: false, problem: 'too-long' };
  for (const char of title) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return { ok: false, problem: 'control' };
  }
  return { ok: true, title };
}

/** Moves item `index` one step up (-1) or down (+1); returns a new array. */
export function moveItem<T>(items: readonly T[], index: number, direction: -1 | 1): T[] {
  const target = index + direction;
  const next = [...items];
  if (index < 0 || index >= items.length || target < 0 || target >= items.length) return next;
  const [moved] = next.splice(index, 1);
  if (moved !== undefined) next.splice(target, 0, moved);
  return next;
}
