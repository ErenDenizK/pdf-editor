/**
 * Matching of redacted strings in text (research 06 §3 step 0): case- and
 * whitespace-insensitive, so "Secret 7731" in an outline title matches the redacted
 * "SECRET-7731 " only when the characters agree once case and whitespace are ignored.
 *
 * Normalisation, per code point: NFKC, then lower case; whitespace, zero-width characters,
 * the soft hyphen and the byte-order mark are dropped. Matches are mapped back to ranges of
 * the original text so replacement keeps everything around them.
 */

/** Code points ignored when matching (whitespace and invisible formatting characters). */
const IGNORED = new RegExp('^[\\s\\u00ad\\u180e\\u200b-\\u200d\\u2060\\ufeff]$', 'u');

/** The normalised form of `text` used for matching. */
export function normalizeForMatch(text: string): string {
  return normalizeWithMap(text).text;
}

interface Normalized {
  readonly text: string;
  /** Per code unit of `text`: start of the original code point it came from. */
  readonly starts: readonly number[];
  /** Per code unit of `text`: end (exclusive) of that original code point. */
  readonly ends: readonly number[];
}

function normalizeWithMap(text: string): Normalized {
  let out = '';
  const starts: number[] = [];
  const ends: number[] = [];
  let index = 0;
  for (const char of text) {
    const end = index + char.length;
    if (!IGNORED.test(char)) {
      const folded = char.normalize('NFKC').toLowerCase();
      for (const part of folded) {
        if (IGNORED.test(part)) continue;
        out += part;
        const units = part.length;
        for (let k = 0; k < units; k++) {
          starts.push(index);
          ends.push(end);
        }
      }
    }
    index = end;
  }
  return { text: out, starts, ends };
}

/** Candidate placeholders, tried in order until one contains no redacted string. */
const PLACEHOLDERS = ['[redacted]', '[…]', '***', ''];

/**
 * Finds and replaces redacted strings. Empty (or whitespace-only) strings are ignored, so a
 * matcher built from nothing matches nothing.
 */
export class RedactedStringMatcher {
  /** Distinct normalised needles, longest first. */
  readonly needles: readonly string[];

  constructor(strings: readonly string[]) {
    const set = new Set<string>();
    for (const s of strings) {
      const n = normalizeForMatch(s);
      if (n !== '') set.add(n);
    }
    this.needles = [...set].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  }

  get empty(): boolean {
    return this.needles.length === 0;
  }

  /** `text` contains a redacted string. */
  matches(text: string): boolean {
    if (this.needles.length === 0 || text === '') return false;
    const n = normalizeForMatch(text);
    return this.needles.some((needle) => n.includes(needle));
  }

  /** Ranges `[start, end)` of `text` covered by redacted strings, merged and sorted. */
  ranges(text: string): [number, number][] {
    if (this.needles.length === 0) return [];
    const map = normalizeWithMap(text);
    const found: [number, number][] = [];
    for (const needle of this.needles) {
      for (let at = map.text.indexOf(needle); at >= 0; at = map.text.indexOf(needle, at + 1)) {
        const start = map.starts[at];
        const end = map.ends[at + needle.length - 1];
        if (start !== undefined && end !== undefined) found.push([start, end]);
      }
    }
    found.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged: [number, number][] = [];
    for (const range of found) {
      const last = merged[merged.length - 1];
      if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
      else merged.push([range[0], range[1]]);
    }
    return merged;
  }

  /**
   * `text` with every redacted string replaced by `placeholder`. Repeats while a match
   * remains (a removal can join two halves into a new match); falls back to the bare
   * placeholder after a few rounds.
   */
  replace(text: string, placeholder: string): string {
    let current = text;
    for (let round = 0; round < 8; round++) {
      const ranges = this.ranges(current);
      if (ranges.length === 0) return current;
      let out = '';
      let from = 0;
      for (const [start, end] of ranges) {
        out += current.slice(from, start) + placeholder;
        from = end;
      }
      current = out + current.slice(from);
    }
    return this.matches(current) ? placeholder : current;
  }

  /**
   * The placeholder to write: `preferred` when it contains no redacted string, else the
   * first safe default ("[redacted]", "[…]", "***", then the empty string).
   */
  placeholder(preferred?: string): string {
    for (const candidate of [...(preferred === undefined ? [] : [preferred]), ...PLACEHOLDERS]) {
      if (!this.matches(candidate)) return candidate;
    }
    return '';
  }
}
