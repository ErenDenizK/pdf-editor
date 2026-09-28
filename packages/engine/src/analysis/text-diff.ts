/**
 * Word-level text diff (spec §2.1 "Text") with jsdiff's `diffArrays` over normalised tokens.
 * Document scope: the tokens of every paired page in page-map order form one sequence per
 * document, so text reflowing across a page break is not a change; inserted and deleted
 * pages are reported as page changes, not as words. The common prefix and suffix are
 * trimmed first; the rest is diffed with a time budget that keeps the worker's tasks short.
 * Over budget, each pair is diffed on its own (`page-pairs`), and a pair over budget again
 * is reported as a whole-page replacement.
 */
import { diffArrays } from 'diff';
import type { Rect } from '@pdf-editor/document-model';

import type { PagePair, TextChange, TextComparison, TextSpanRef } from '../types';
import { mergeLineRects } from './geometry';
import type { Slicer } from './scheduler';
import type { PageTokens } from './tokens';

/** Time budget of one synchronous `diffArrays` call (well under the 200 ms task limit). */
export const DIFF_BUDGET_MS = 120;

/** A token's place: page index and position in that page's token list. */
interface Ref {
  readonly page: number;
  readonly index: number;
}

interface Sequence {
  readonly refs: Ref[];
  readonly texts: string[];
}

function sequence(
  pages: readonly (PageTokens | undefined)[],
  pageIndices: readonly number[],
): Sequence {
  const refs: Ref[] = [];
  const texts: string[] = [];
  for (const page of pageIndices) {
    const tokens = pages[page]?.tokens ?? [];
    tokens.forEach((token, index) => {
      refs.push({ page, index });
      texts.push(token.text);
    });
  }
  return { refs, texts };
}

interface Op {
  kind: 'same' | 'removed' | 'added';
  count: number;
}

/** `diffArrays` with a time budget; undefined when over budget. */
function diffOps(a: readonly string[], b: readonly string[], budgetMs: number): Op[] | undefined {
  // Common prefix and suffix are linear and never time out.
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }
  const ops: Op[] = [];
  if (prefix > 0) ops.push({ kind: 'same', count: prefix });
  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);
  if (midA.length > 0 || midB.length > 0) {
    if (midA.length === 0) ops.push({ kind: 'added', count: midB.length });
    else if (midB.length === 0) ops.push({ kind: 'removed', count: midA.length });
    else {
      const changes = diffArrays(midA, midB, { timeout: budgetMs });
      if (!changes) return undefined;
      for (const c of changes) {
        ops.push({ kind: c.added ? 'added' : c.removed ? 'removed' : 'same', count: c.count });
      }
    }
  }
  if (suffix > 0) ops.push({ kind: 'same', count: suffix });
  return ops;
}

/** Joins tokens as text: no space before closing punctuation or after opening brackets. */
export function joinTokens(texts: readonly string[]): string {
  let out = '';
  for (const t of texts) {
    if (out === '' || /^[.,;:!?%)\]}»”’]/u.test(t) || /[([{«“‘/]$/u.test(out)) out += t;
    else out += ` ${t}`;
  }
  return out;
}

function spans(refs: readonly Ref[], pages: readonly (PageTokens | undefined)[]): TextSpanRef[] {
  const out: TextSpanRef[] = [];
  let start = 0;
  for (let i = 1; i <= refs.length; i++) {
    if (i < refs.length && refs[i]?.page === refs[start]?.page) continue;
    const page = refs[start]?.page ?? 0;
    const tokens = refs.slice(start, i).map((r) => pages[r.page]?.tokens[r.index]);
    const rects: Rect[] = [];
    const lineIds: number[] = [];
    const texts: string[] = [];
    for (const t of tokens) {
      if (!t) continue;
      rects.push(...t.rects);
      texts.push(t.text);
      if (!lineIds.includes(t.line)) lineIds.push(t.line);
    }
    const lines = pages[page]?.lines ?? [];
    out.push({
      page,
      text: joinTokens(texts),
      rects: mergeLineRects(rects),
      line: lineIds.map((l) => lines[l] ?? '').join(' / '),
    });
    start = i;
  }
  return out;
}

/** Turns diff ops over two sequences into changes (a removal right before an addition = changed). */
function toChanges(
  ops: readonly Op[],
  seqA: Sequence,
  seqB: Sequence,
  pagesA: readonly (PageTokens | undefined)[],
  pagesB: readonly (PageTokens | undefined)[],
): TextChange[] {
  const out: TextChange[] = [];
  let ia = 0;
  let ib = 0;
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k] as Op;
    if (op.kind === 'same') {
      ia += op.count;
      ib += op.count;
      continue;
    }
    let removed: Ref[] = [];
    let added: Ref[] = [];
    if (op.kind === 'removed') {
      removed = seqA.refs.slice(ia, ia + op.count);
      ia += op.count;
      const next = ops[k + 1];
      if (next?.kind === 'added') {
        added = seqB.refs.slice(ib, ib + next.count);
        ib += next.count;
        k++;
      }
    } else {
      added = seqB.refs.slice(ib, ib + op.count);
      ib += op.count;
      const next = ops[k + 1];
      if (next?.kind === 'removed') {
        removed = seqA.refs.slice(ia, ia + next.count);
        ia += next.count;
        k++;
      }
    }
    const aSpans = spans(removed, pagesA);
    const bSpans = spans(added, pagesB);
    const n = Math.max(aSpans.length, bSpans.length);
    for (let s = 0; s < n; s++) {
      const a = aSpans[s];
      const b = bSpans[s];
      if (a && b) out.push({ kind: 'changed', a, b });
      else if (a) out.push({ kind: 'removed', a });
      else if (b) out.push({ kind: 'added', b });
    }
  }
  return out;
}

export async function diffText(
  pagesA: readonly (PageTokens | undefined)[],
  pagesB: readonly (PageTokens | undefined)[],
  pairs: readonly PagePair[],
  scope: 'document' | 'page-pairs',
  slicer: Slicer,
): Promise<TextComparison> {
  const paired = pairs.filter(
    (p): p is PagePair & { a: number; b: number } => p.a !== undefined && p.b !== undefined,
  );
  const docA = sequence(
    pagesA,
    paired.map((p) => p.a),
  );
  const docB = sequence(
    pagesB,
    paired.map((p) => p.b),
  );
  const tokens = { a: docA.texts.length, b: docB.texts.length };
  await slicer.tick('text: sequences');
  if (scope === 'document') {
    const ops = diffOps(docA.texts, docB.texts, DIFF_BUDGET_MS);
    await slicer.tick('text: document diff');
    if (ops) {
      return {
        scope: 'document',
        changes: toChanges(ops, docA, docB, pagesA, pagesB),
        pairsOverBudget: [],
        tokens,
      };
    }
  }
  const changes: TextChange[] = [];
  const pairsOverBudget: number[] = [];
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i] as PagePair;
    if (pair.a === undefined || pair.b === undefined) continue;
    const seqA = sequence(pagesA, [pair.a]);
    const seqB = sequence(pagesB, [pair.b]);
    let ops = diffOps(seqA.texts, seqB.texts, DIFF_BUDGET_MS);
    if (!ops) {
      pairsOverBudget.push(i);
      ops = [
        { kind: 'removed', count: seqA.texts.length },
        { kind: 'added', count: seqB.texts.length },
      ];
    }
    changes.push(...toChanges(ops, seqA, seqB, pagesA, pagesB));
    await slicer.tick('text: pair diff');
  }
  return { scope: 'page-pairs', changes, pairsOverBudget, tokens };
}
