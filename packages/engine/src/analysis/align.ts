/**
 * Page alignment (spec §2.1 "Page matching"): by index, or best match with Needleman–Wunsch
 * over page similarity. Similarity is the Jaccard index of word 3-shingles, computed through
 * an inverted index (only pages sharing a shingle cost anything); pages without text on
 * either side fall back to 32×32 greyscale thumbnails. A pair scores `similarity − τ` and a
 * gap scores 0, so two pages are paired only when their similarity exceeds τ; unpaired pages
 * are deleted (first document) or inserted (second). O(n·m) time and memory, fine to 2 000
 * pages a side; the work is sliced so the worker stays responsive.
 */
import type { PagePair } from '../types';
import type { Slicer } from './scheduler';

/** What alignment needs of a page. */
export interface AlignPage {
  readonly shingles: Int32Array;
  readonly words: number;
  /** 32×32 greyscale thumbnail (row-major), for pages without text. */
  readonly thumb?: Uint8Array;
}

export const THUMB_SIZE = 32;
export const DEFAULT_MIN_SIMILARITY = 0.15;

/** Mean absolute difference (0–255) at which two thumbnails count as unrelated. */
const THUMB_SCALE = 32;

export function thumbSimilarity(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
  return Math.max(0, 1 - sum / n / THUMB_SCALE);
}

export function jaccard(a: Int32Array, b: Int32Array): number {
  if (a.length === 0 && b.length === 0) return 0;
  let i = 0;
  let j = 0;
  let common = 0;
  while (i < a.length && j < b.length) {
    const x = a[i] as number;
    const y = b[j] as number;
    if (x === y) {
      common++;
      i++;
      j++;
    } else if (x < y) i++;
    else j++;
  }
  return common / (a.length + b.length - common);
}

/** Similarity of one pair and what it was based on. */
export function pageSimilarity(
  a: AlignPage,
  b: AlignPage,
): { value: number; basis: PagePair['basis'] } {
  if (a.words > 0 && b.words > 0) return { value: jaccard(a.shingles, b.shingles), basis: 'text' };
  if (a.words === 0 && b.words === 0 && a.thumb && b.thumb) {
    return { value: thumbSimilarity(a.thumb, b.thumb), basis: 'thumbnail' };
  }
  return { value: 0, basis: 'none' };
}

/** Similarity matrix (row-major n×m) and the basis of each entry (0 none, 1 text, 2 thumbnail). */
export interface SimilarityMatrix {
  readonly n: number;
  readonly m: number;
  readonly values: Float32Array;
  readonly basis: Uint8Array;
}

const BASIS: readonly PagePair['basis'][] = ['none', 'text', 'thumbnail'];

export async function similarityMatrix(
  a: readonly AlignPage[],
  b: readonly AlignPage[],
  slicer: Slicer,
  onRow?: (row: number) => void,
): Promise<SimilarityMatrix> {
  const n = a.length;
  const m = b.length;
  const values = new Float32Array(n * m);
  const basis = new Uint8Array(n * m);
  // Inverted index over the second document's shingles.
  const index = new Map<number, number[]>();
  b.forEach((page, j) => {
    for (const s of page.shingles) {
      let list = index.get(s);
      if (!list) index.set(s, (list = []));
      list.push(j);
    }
  });
  await slicer.tick('align: index');
  const counts = new Int32Array(m);
  for (let i = 0; i < n; i++) {
    const pa = a[i] as AlignPage;
    const row = i * m;
    if (pa.words > 0) {
      counts.fill(0);
      for (const s of pa.shingles) {
        const list = index.get(s);
        if (list) for (const j of list) counts[j] = (counts[j] ?? 0) + 1;
      }
      for (let j = 0; j < m; j++) {
        const pb = b[j] as AlignPage;
        if (pb.words === 0) continue;
        const common = counts[j] ?? 0;
        const union = pa.shingles.length + pb.shingles.length - common;
        values[row + j] = union > 0 ? common / union : 0;
        basis[row + j] = 1;
      }
    } else if (pa.thumb) {
      for (let j = 0; j < m; j++) {
        const pb = b[j] as AlignPage;
        if (pb.words > 0 || !pb.thumb) continue;
        values[row + j] = thumbSimilarity(pa.thumb, pb.thumb);
        basis[row + j] = 2;
      }
    }
    onRow?.(i);
    await slicer.tick('align: similarity');
  }
  return { n, m, values, basis };
}

function unpairedSimilarity(matrix: SimilarityMatrix, side: 'a' | 'b', index: number): number {
  let best = 0;
  if (side === 'a') {
    for (let j = 0; j < matrix.m; j++)
      best = Math.max(best, matrix.values[index * matrix.m + j] ?? 0);
  } else {
    for (let i = 0; i < matrix.n; i++)
      best = Math.max(best, matrix.values[i * matrix.m + index] ?? 0);
  }
  return round(best);
}

const round = (v: number) => Math.round(v * 1000) / 1000;

function pairOf(matrix: SimilarityMatrix, i: number, j: number): PagePair {
  const k = i * matrix.m + j;
  return {
    a: i,
    b: j,
    similarity: round(matrix.values[k] ?? 0),
    basis: BASIS[matrix.basis[k] ?? 0] ?? 'none',
  };
}

/** Pages paired by position; the longer document's extra pages are inserted or deleted. */
export function alignByIndex(matrix: SimilarityMatrix): PagePair[] {
  const pairs: PagePair[] = [];
  const common = Math.min(matrix.n, matrix.m);
  for (let i = 0; i < common; i++) {
    const p = pairOf(matrix, i, i);
    pairs.push({ ...p, basis: p.basis === 'none' ? 'index' : p.basis });
  }
  for (let i = common; i < matrix.n; i++) {
    pairs.push({ a: i, similarity: unpairedSimilarity(matrix, 'a', i), basis: 'none' });
  }
  for (let j = common; j < matrix.m; j++) {
    pairs.push({ b: j, similarity: unpairedSimilarity(matrix, 'b', j), basis: 'none' });
  }
  return pairs;
}

const DIAG = 1;
const UP = 2; // consume a page of the first document (deleted)
const LEFT = 3; // consume a page of the second document (inserted)

/**
 * Needleman–Wunsch: maximises Σ (similarity − τ) over the paired pages, gaps free. Between two
 * pairs, deleted pages are listed before inserted ones.
 */
export async function alignBestMatch(
  matrix: SimilarityMatrix,
  minSimilarity: number,
  slicer: Slicer,
): Promise<PagePair[]> {
  const { n, m, values } = matrix;
  const width = m + 1;
  const score = new Float32Array((n + 1) * width);
  const move = new Uint8Array((n + 1) * width);
  for (let i = 1; i <= n; i++) move[i * width] = UP;
  for (let j = 1; j <= m; j++) move[j] = LEFT;
  for (let i = 1; i <= n; i++) {
    const row = i * width;
    const prev = (i - 1) * width;
    for (let j = 1; j <= m; j++) {
      const diag =
        (score[prev + j - 1] ?? 0) + (values[(i - 1) * m + (j - 1)] ?? 0) - minSimilarity;
      const up = score[prev + j] ?? 0;
      const left = score[row + j - 1] ?? 0;
      // Strictly better only: ties go to gaps, so a pair must beat τ.
      if (diag > up && diag > left) {
        score[row + j] = diag;
        move[row + j] = DIAG;
      } else if (up >= left) {
        score[row + j] = up;
        move[row + j] = UP;
      } else {
        score[row + j] = left;
        move[row + j] = LEFT;
      }
    }
    await slicer.tick('align: dynamic programming');
  }
  // Traceback.
  const reversed: PagePair[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const step = move[i * width + j];
    if (step === DIAG) {
      reversed.push(pairOf(matrix, i - 1, j - 1));
      i--;
      j--;
    } else if (step === UP || j === 0) {
      reversed.push({
        a: i - 1,
        similarity: unpairedSimilarity(matrix, 'a', i - 1),
        basis: 'none',
      });
      i--;
    } else {
      reversed.push({
        b: j - 1,
        similarity: unpairedSimilarity(matrix, 'b', j - 1),
        basis: 'none',
      });
      j--;
    }
  }
  const pairs = reversed.reverse();
  // Deleted before inserted within each run of unpaired rows.
  const out: PagePair[] = [];
  let run: PagePair[] = [];
  const flush = () => {
    out.push(...run.filter((p) => p.b === undefined), ...run.filter((p) => p.a === undefined));
    run = [];
  };
  for (const p of pairs) {
    if (p.a !== undefined && p.b !== undefined) {
      flush();
      out.push(p);
    } else run.push(p);
  }
  flush();
  return out;
}
