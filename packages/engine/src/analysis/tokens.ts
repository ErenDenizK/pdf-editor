/**
 * Page text → comparison tokens (spec §2.1 "Text"). `getPageText` runs are lines whose text
 * may hold characters without a glyph (generated spaces) and whose glyphs may have no text
 * (PDFium's line-end soft-hyphen marker, U+FFFE, comes through as an empty glyph). The two are
 * walked in step so every character knows its box, then each line is segmented into words
 * with `Intl.Segmenter` (word granularity, the document language). Tokens are normalised
 * (NFKC, soft hyphens and zero-width characters removed); a word hyphenated at a line end is
 * joined with its continuation when asked (one token with a box on each line).
 */
import type { Rect } from '@pdf-editor/document-model';

import { type Segment, xyCut } from '../convert/layout';
import type { CompareToken, TextRun } from '../types';
import { unionRect } from './geometry';
import { type LineChars, lineChars } from './line-chars';

export { type LineChars, lineChars };

/** A token plus where it came from (line index on its page, word-like or punctuation). */
export interface PageToken extends CompareToken {
  readonly line: number;
  readonly word: boolean;
}

export interface PageTokens {
  readonly tokens: readonly PageToken[];
  /** The page's line texts (as extracted), for change context. */
  readonly lines: readonly string[];
}

export interface TokenizeOptions {
  readonly locale?: string;
  readonly joinHyphens?: boolean;
}

const INVISIBLE = /[\u00ad\ufffe\u200b-\u200d\u2060\ufeff]/g;

const segmenters = new Map<string, Intl.Segmenter>();

function segmenter(locale: string): Intl.Segmenter {
  let s = segmenters.get(locale);
  if (!s) {
    try {
      s = new Intl.Segmenter(locale, { granularity: 'word' });
    } catch {
      s = new Intl.Segmenter('en', { granularity: 'word' });
    }
    segmenters.set(locale, s);
  }
  return s;
}

/** NFKC, invisible characters removed, whitespace collapsed. */
export function normalizeToken(text: string): string {
  return text.normalize('NFKC').replace(INVISIBLE, '').replace(/\s+/gu, ' ').trim();
}

interface RawToken {
  text: string;
  rects: Rect[];
  line: number;
  word: boolean;
}

function lineTokens(chars: LineChars, line: number, locale: string): RawToken[] {
  const out: RawToken[] = [];
  for (const seg of segmenter(locale).segment(chars.text)) {
    const text = normalizeToken(seg.segment);
    if (text === '') continue;
    const boxes: Rect[] = [];
    for (let i = seg.index; i < seg.index + seg.segment.length; i++) {
      const box = chars.boxes[i];
      if (box) boxes.push(box);
    }
    const rect = unionRect(boxes);
    out.push({ text, rects: rect ? [rect] : [], line, word: seg.isWordLike === true });
  }
  return out;
}

/**
 * Runs in reading order by recursive XY-cut in unrotated user space (the convert module's
 * layout on whole runs), so the order depends on where text sits, not on the content stream
 * or the page's rotation: the same page shown rotated yields the same tokens.
 */
export function runsInReadingOrder(runs: readonly TextRun[]): TextRun[] {
  if (runs.length < 2) return [...runs];
  const items: Segment[] = runs.map((run) => ({
    kind: 'text',
    units: [],
    text: run.text,
    // Top-down coordinates: y grows downwards.
    box: {
      x0: run.rect.x,
      y0: -(run.rect.y + run.rect.height),
      x1: run.rect.x + run.rect.width,
      y1: -run.rect.y,
    },
    size: run.glyphs[0]?.fontSize ?? run.rect.height,
    bold: false,
    hyphen: undefined,
  }));
  const index = new Map(items.map((item, i) => [item, i]));
  return xyCut(items).map((p) => runs[index.get(p.item as Segment) ?? 0] as TextRun);
}

/** Tokens of one page, in reading order (`runsInReadingOrder`). */
export function tokenizePage(runs: readonly TextRun[], options: TokenizeOptions = {}): PageTokens {
  const locale = options.locale ?? 'en';
  const join = options.joinHyphens ?? true;
  const lines = runsInReadingOrder(runs).map(lineChars);
  const tokens: RawToken[] = [];
  let pendingJoin: 'soft' | 'hard' | undefined;
  lines.forEach((chars, index) => {
    const own = lineTokens(chars, index, locale);
    const first = own[0];
    const prev = tokens[tokens.length - 1];
    if (pendingJoin && prev?.word && first?.word) {
      // Hard hyphens join only before a lower-case continuation ("gener-" + "ated"); a
      // capitalised one is more likely a compound ("Jean-" + "Paul") and keeps its hyphen.
      const lower = /^\p{Ll}/u.test(first.text);
      if (pendingJoin === 'soft' || lower) {
        const head = pendingJoin === 'hard' ? prev.text.replace(/[-\u2010]$/u, '') : prev.text;
        prev.text = head + first.text;
        prev.rects.push(...first.rects);
        own.shift();
      }
    }
    tokens.push(...own);
    pendingJoin = join ? chars.hyphen : undefined;
    // A hard hyphen segments as its own punctuation token: fold it into the word for joining.
    if (pendingJoin === 'hard') {
      const dash = tokens[tokens.length - 1];
      const word = tokens[tokens.length - 2];
      if (dash && word?.word && /^[-\u2010]$/u.test(dash.text) && dash.line === word.line) {
        word.text += dash.text;
        word.rects[word.rects.length - 1] = unionRect([
          ...word.rects.slice(-1),
          ...dash.rects,
        ]) as Rect;
        tokens.pop();
      } else {
        pendingJoin = undefined;
      }
    }
  });
  return { tokens, lines: lines.map((l) => l.text) };
}

/** FNV-1a 32-bit hash. */
export function hashString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}

/**
 * Word 3-shingles of a page (lower-cased word-like tokens), hashed, sorted and unique. Pages
 * with fewer than three words use their words, so short pages can still be matched.
 */
export function shingles(tokens: readonly PageToken[]): Int32Array {
  const words = tokens.filter((t) => t.word).map((t) => t.text.toLowerCase());
  const set = new Set<number>();
  if (words.length < 3) {
    for (const w of words) set.add(hashString(w));
  } else {
    for (let i = 0; i + 2 < words.length; i++) {
      set.add(hashString(`${words[i]}\u0001${words[i + 1]}\u0001${words[i + 2]}`));
    }
  }
  return Int32Array.from(set).sort();
}
