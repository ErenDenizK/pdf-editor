/**
 * The Changes list (spec recognize-and-compare §2.2): a `ComparisonResult` (or, while the
 * run is in progress, the page map and the visual diffs so far) as rows the panel lists
 * and J/K step through. Pure data: labels are made by the panel and by `changes-text.ts`.
 *
 * Every item says where to reveal it: a page-map row, a side and a user-space rectangle on
 * that side's page (text boxes, the bounds of the changed areas) or none (the page top).
 */
import type { Rect } from '@pdf-editor/document-model';
import type {
  ComparePairStatus,
  ComparisonResult,
  FactChange,
  PagePair,
  PixelDiffResult,
  TextChange,
} from '@pdf-editor/engine';

/** Shown next to every row: never colour alone (DESIGN.md §5). */
export type ChangeSign = '+' | '-' | '~';

interface ItemBase {
  /** Stable within one result: `page:3`, `visual:1`, `text:0`, `fact:2`. */
  readonly id: string;
  readonly sign: ChangeSign;
  /** Page-map row to reveal; null for document-level facts. */
  readonly row: number | null;
  readonly side: 'a' | 'b';
  readonly rect?: Rect;
}

export type ChangeItem =
  | (ItemBase & {
      readonly kind: 'page';
      readonly status: 'inserted' | 'deleted';
      readonly page: number;
      readonly words?: number;
      readonly firstLine?: string;
    })
  | (ItemBase & {
      readonly kind: 'visual';
      readonly regions: number;
      /** Share of the page's pixels that differ, 0–1. */
      readonly ratio: number;
      readonly sizeMismatch: boolean;
    })
  | (ItemBase & { readonly kind: 'text'; readonly change: TextChange })
  | (ItemBase & { readonly kind: 'fact'; readonly fact: FactChange });

export interface ChangeGroup {
  readonly row: number;
  readonly pair: PagePair;
  readonly status: ComparePairStatus | 'pending';
  readonly items: readonly ChangeItem[];
}

export interface ChangeList {
  /** Facts about the whole document (metadata, fields, attachments, signatures, page count). */
  readonly document: readonly ChangeItem[];
  /** Page-map rows with at least one change, in page-map order. */
  readonly groups: readonly ChangeGroup[];
  /** Every item in list order (document first): what J/K step through. */
  readonly flat: readonly ChangeItem[];
}

/** The smallest rectangle around `rects` (user space). */
export function unionRect(rects: readonly Rect[]): Rect | undefined {
  if (rects.length === 0) return undefined;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.width);
    y1 = Math.max(y1, r.y + r.height);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Page-map row lookups: document page index → row, per side. */
export function rowIndex(pairs: readonly PagePair[]): {
  readonly a: ReadonlyMap<number, number>;
  readonly b: ReadonlyMap<number, number>;
} {
  const a = new Map<number, number>();
  const b = new Map<number, number>();
  pairs.forEach((pair, row) => {
    if (pair.a !== undefined) a.set(pair.a, row);
    if (pair.b !== undefined) b.set(pair.b, row);
  });
  return { a, b };
}

const SIGN_OF_TEXT: Readonly<Record<TextChange['kind'], ChangeSign>> = {
  added: '+',
  removed: '-',
  changed: '~',
};

function factSign(fact: FactChange): ChangeSign {
  if (fact.a === undefined) return '+';
  if (fact.b === undefined) return '-';
  return '~';
}

/** Page facts that belong to a page-map row (the others are about the whole document). */
const PAGE_FACTS: ReadonlySet<FactChange['kind']> = new Set([
  'page-size',
  'page-rotation',
  'annotations',
]);

function pageItem(row: number, pair: PagePair, extra: { words?: number; firstLine?: string }) {
  const inserted = pair.a === undefined;
  return {
    id: `page:${row}`,
    kind: 'page' as const,
    sign: inserted ? ('+' as const) : ('-' as const),
    row,
    side: inserted ? ('b' as const) : ('a' as const),
    status: inserted ? ('inserted' as const) : ('deleted' as const),
    page: (inserted ? pair.b : pair.a) ?? 0,
    ...(extra.words === undefined ? {} : { words: extra.words }),
    ...(extra.firstLine === undefined ? {} : { firstLine: extra.firstLine }),
  };
}

function visualItem(row: number, visual: PixelDiffResult): ChangeItem | undefined {
  if (visual.changedPixels === 0) return undefined;
  const rect = unionRect(visual.regions);
  return {
    id: `visual:${row}`,
    kind: 'visual',
    sign: '~',
    row,
    side: 'b',
    ...(rect ? { rect } : {}),
    regions: visual.regions.length,
    ratio: visual.changedRatio,
    sizeMismatch: visual.sizeMismatch,
  };
}

function finish(
  document: ChangeItem[],
  byRow: Map<number, ChangeItem[]>,
  pairs: readonly PagePair[],
  status: (row: number) => ChangeGroup['status'],
): ChangeList {
  const groups: ChangeGroup[] = [];
  pairs.forEach((pair, row) => {
    const items = byRow.get(row);
    if (items && items.length > 0) groups.push({ row, pair, status: status(row), items });
  });
  return { document, groups, flat: [...document, ...groups.flatMap((g) => g.items)] };
}

function push(map: Map<number, ChangeItem[]>, row: number, item: ChangeItem): void {
  const list = map.get(row);
  if (list) list.push(item);
  else map.set(row, [item]);
}

/** The Changes list of a finished comparison. */
export function buildChangeList(result: ComparisonResult): ChangeList {
  const pairs = result.pages.map((p) => p.pair);
  const rows = rowIndex(pairs);
  const byRow = new Map<number, ChangeItem[]>();
  const document: ChangeItem[] = [];

  result.pages.forEach((page, row) => {
    if (page.status === 'inserted' || page.status === 'deleted') {
      push(
        byRow,
        row,
        pageItem(row, page.pair, {
          ...(page.words === undefined ? {} : { words: page.words }),
          ...(page.firstLine === undefined ? {} : { firstLine: page.firstLine }),
        }),
      );
    } else if (page.visual) {
      const item = visualItem(row, page.visual);
      if (item) push(byRow, row, item);
    }
  });

  result.text.changes.forEach((change, k) => {
    // Revealed where the new text is; removed text only exists in the first document.
    const onB = change.b !== undefined ? rows.b.get(change.b.page) : undefined;
    const onA = change.a !== undefined ? rows.a.get(change.a.page) : undefined;
    const side: 'a' | 'b' = onB !== undefined ? 'b' : 'a';
    const row = onB ?? onA;
    const span = side === 'b' ? change.b : change.a;
    const rect = span ? unionRect(span.rects) : undefined;
    const item: ChangeItem = {
      id: `text:${k}`,
      kind: 'text',
      sign: SIGN_OF_TEXT[change.kind],
      row: row ?? null,
      side,
      ...(rect ? { rect } : {}),
      change,
    };
    if (row === undefined) document.push(item);
    else push(byRow, row, item);
  });

  result.facts.forEach((fact, k) => {
    const onB = fact.bPage !== undefined ? rows.b.get(fact.bPage) : undefined;
    const onA = fact.aPage !== undefined ? rows.a.get(fact.aPage) : undefined;
    const row = PAGE_FACTS.has(fact.kind) ? (onB ?? onA) : undefined;
    const item: ChangeItem = {
      id: `fact:${k}`,
      kind: 'fact',
      sign: factSign(fact),
      row: row ?? null,
      side: onB !== undefined ? 'b' : 'a',
      fact,
    };
    if (row === undefined) document.push(item);
    else push(byRow, row, item);
  });

  // Within a row: the page itself, then the picture, the words and the facts.
  const order = { page: 0, visual: 1, text: 2, fact: 3 } as const;
  for (const list of byRow.values()) list.sort((x, y) => order[x.kind] - order[y.kind]);
  return finish(document, byRow, pairs, (row) => result.pages[row]?.status ?? 'identical');
}

/**
 * The list while the run is in progress: inserted and deleted pages from the page map, and
 * the visual diffs that have landed. Text changes and facts come with the result.
 */
export function buildPartialChangeList(
  pairs: readonly PagePair[],
  visuals: Readonly<Record<number, PixelDiffResult>>,
): ChangeList {
  const byRow = new Map<number, ChangeItem[]>();
  pairs.forEach((pair, row) => {
    if (pair.a === undefined || pair.b === undefined) {
      push(byRow, row, pageItem(row, pair, {}));
      return;
    }
    const visual = visuals[row];
    const item = visual ? visualItem(row, visual) : undefined;
    if (item) push(byRow, row, item);
  });
  return finish([], byRow, pairs, (row) => {
    const pair = pairs[row];
    if (pair?.a === undefined) return 'inserted';
    if (pair.b === undefined) return 'deleted';
    const visual = visuals[row];
    if (!visual) return 'pending';
    return visual.changedPixels > 0 ? 'changed' : 'identical';
  });
}

/** Status of a page-map row for the page map strip. */
export function rowStatus(
  row: number,
  pairs: readonly PagePair[],
  visuals: Readonly<Record<number, PixelDiffResult>>,
  result: ComparisonResult | null,
): ComparePairStatus | 'pending' {
  const done = result?.pages[row]?.status;
  if (done) return done;
  const pair = pairs[row];
  if (!pair) return 'pending';
  if (pair.a === undefined) return 'inserted';
  if (pair.b === undefined) return 'deleted';
  const visual = visuals[row];
  if (!visual) return 'pending';
  return visual.changedPixels > 0 ? 'changed' : 'identical';
}

/** The item after (`direction` 1) or before (-1) `current` in list order, wrapping around. */
export function stepChange(
  flat: readonly ChangeItem[],
  current: string | null,
  direction: 1 | -1,
): ChangeItem | undefined {
  if (flat.length === 0) return undefined;
  const index = current === null ? -1 : flat.findIndex((item) => item.id === current);
  if (index < 0) return direction > 0 ? flat[0] : flat[flat.length - 1];
  return flat[(index + direction + flat.length) % flat.length];
}
