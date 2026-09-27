/**
 * A small fuzzy scorer for the command palette. No dependency: command lists are short
 * (tens to low hundreds), so an O(query x text^2) alignment is cheap and finds the best
 * match rather than the first greedy one.
 *
 * Scoring favours, in order: matches at word starts ("zi" -> "Zoom In"), consecutive runs,
 * a match at the very beginning, and short gaps. Everything is case-insensitive.
 */

export interface FuzzyMatch {
  readonly score: number;
  /** Indices into the text of each matched query character, ascending. */
  readonly positions: readonly number[];
}

const SEPARATORS = new Set([' ', '-', '_', '/', '.', ':', '(', ')', '…']);

const BONUS_FIRST_CHAR = 12;
const BONUS_WORD_START = 8;
const BONUS_CAMEL = 6;
const BONUS_CONSECUTIVE = 6;
const BONUS_PREFIX = 10;
const BONUS_EXACT = 20;
const PENALTY_GAP_START = 3;
const PENALTY_GAP_EXTEND = 0.5;
const PENALTY_LEADING_MAX = 3;

function positionBonus(text: string, index: number): number {
  if (index === 0) return BONUS_FIRST_CHAR;
  const prev = text[index - 1] ?? '';
  const current = text[index] ?? '';
  if (SEPARATORS.has(prev)) return BONUS_WORD_START;
  const isUpper = current !== current.toLowerCase() && current === current.toUpperCase();
  const prevIsLower = prev !== prev.toUpperCase() && prev === prev.toLowerCase();
  if (isUpper && prevIsLower) return BONUS_CAMEL;
  return 0;
}

function gapPenalty(gap: number): number {
  return gap <= 0 ? 0 : PENALTY_GAP_START + (gap - 1) * PENALTY_GAP_EXTEND;
}

/** Scores `text` against `query`. Returns null when `query` is not a subsequence. */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = query.trim().toLowerCase().replace(/\s+/g, ' ');
  if (q === '') return { score: 0, positions: [] };
  const t = text.toLowerCase();
  const m = q.length;
  const n = t.length;
  if (m > n) return null;

  // score[i][j]: best score with query[i] matched at text[j]; -Infinity if impossible.
  const score: Float64Array[] = [];
  const from: Int32Array[] = [];
  for (let i = 0; i < m; i++) {
    const row = new Float64Array(n).fill(Number.NEGATIVE_INFINITY);
    const back = new Int32Array(n).fill(-1);
    const qc = q[i];
    for (let j = i; j < n - (m - 1 - i); j++) {
      if (t[j] !== qc) continue;
      const base = 1 + positionBonus(text, j);
      if (i === 0) {
        row[j] = base - Math.min(j * 0.25, PENALTY_LEADING_MAX);
        continue;
      }
      const prevRow = score[i - 1];
      if (!prevRow) continue;
      let best = Number.NEGATIVE_INFINITY;
      let bestK = -1;
      for (let k = i - 1; k < j; k++) {
        const prev = prevRow[k] ?? Number.NEGATIVE_INFINITY;
        if (prev === Number.NEGATIVE_INFINITY) continue;
        const candidate = prev + (k === j - 1 ? BONUS_CONSECUTIVE : -gapPenalty(j - k - 1));
        if (candidate > best) {
          best = candidate;
          bestK = k;
        }
      }
      if (bestK >= 0) {
        row[j] = best + base;
        back[j] = bestK;
      }
    }
    score.push(row);
    from.push(back);
  }

  const lastRow = score[m - 1];
  const lastBack = from;
  if (!lastRow) return null;
  let bestEnd = -1;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let j = 0; j < n; j++) {
    const value = lastRow[j] ?? Number.NEGATIVE_INFINITY;
    if (value > bestScore) {
      bestScore = value;
      bestEnd = j;
    }
  }
  if (bestEnd < 0) return null;

  const positions = new Array<number>(m);
  let j = bestEnd;
  for (let i = m - 1; i >= 0; i--) {
    positions[i] = j;
    j = lastBack[i]?.[j] ?? -1;
  }

  let total = bestScore;
  if (t.startsWith(q)) total += BONUS_PREFIX;
  if (t === q) total += BONUS_EXACT;
  return { score: total, positions };
}

export interface Ranked<T> {
  readonly item: T;
  readonly score: number;
  /** Matched positions in the item's primary text (for highlighting). */
  readonly positions: readonly number[];
}

/**
 * Filters and sorts items by fuzzy score. `secondary` texts (keywords, group names) can
 * match too, at a discount, and contribute no highlight positions. Ties keep input order.
 */
export function fuzzyFilter<T>(
  query: string,
  items: readonly T[],
  primary: (item: T) => string,
  secondary: (item: T) => readonly string[] = () => [],
): Ranked<T>[] {
  if (query.trim() === '') {
    return items.map((item) => ({ item, score: 0, positions: [] }));
  }
  const ranked: (Ranked<T> & { order: number })[] = [];
  items.forEach((item, order) => {
    const main = fuzzyMatch(query, primary(item));
    let best: Ranked<T> | null = main
      ? { item, score: main.score, positions: main.positions }
      : null;
    for (const text of secondary(item)) {
      const alt = fuzzyMatch(query, text);
      if (alt && (!best || alt.score * 0.75 > best.score)) {
        best = { item, score: alt.score * 0.75, positions: main?.positions ?? [] };
      }
    }
    if (best) ranked.push({ ...best, order });
  });
  ranked.sort((a, b) => b.score - a.score || a.order - b.order);
  return ranked.map(({ item, score, positions }) => ({ item, score, positions }));
}
