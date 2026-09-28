/**
 * Geometry of the Compare view (pure, unit-tested): one row per page-map row, holding the
 * paired pages side by side (A | B) or stacked (overlay: B over A, both from the top-left
 * corner, the frame the pixel diff uses). One scroll container for both columns keeps the
 * scroll synchronised; one scale (CSS px per point) keeps the zoom synchronised.
 */
import type { Rect, Size } from '@pdf-editor/document-model';

import { type Box, type PageFrame, userRectToCss } from '../viewer/geometry';
import { displayedPageSize, type SidePage, totalRotation } from './side-page';

export type CompareLayoutMode = 'side' | 'overlay';

/** Space around and between pages, in CSS px. */
export const LAYOUT = {
  /** The sticky column header (document names) at the top of the scroll content. */
  header: 32,
  padX: 32,
  padTop: 16,
  /** Room under the last row for the floating tool bar. */
  padBottom: 96,
  /** Between the A and B columns. */
  columnGap: 24,
  /** Between rows. */
  rowGap: 24,
  /** The label line above each row's pages. */
  label: 24,
} as const;

export const MIN_SCALE = 0.1;
export const MAX_SCALE = 5;

/** Displayed sizes (points) of a row's pages; a missing side is an inserted or deleted page. */
export interface RowSizes {
  readonly a?: Size;
  readonly b?: Size;
}

export interface RowsLayout {
  readonly scale: number;
  /** Width of each column (side by side) or of the single column (overlay), CSS px. */
  readonly columnWidth: number;
  /** Top of each row (its label line) in the scroll content, CSS px. */
  readonly tops: readonly number[];
  readonly heights: readonly number[];
  readonly contentWidth: number;
  readonly contentHeight: number;
}

export const clampScale = (scale: number): number =>
  Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));

function widest(rows: readonly RowSizes[]): number {
  let max = 1;
  for (const row of rows) max = Math.max(max, row.a?.width ?? 0, row.b?.width ?? 0);
  return max;
}

/** The scale at which the widest page fits the viewport width in `mode`. */
export function fitScale(
  rows: readonly RowSizes[],
  mode: CompareLayoutMode,
  viewportWidth: number,
): number {
  const columns = mode === 'side' ? 2 : 1;
  const gaps = mode === 'side' ? LAYOUT.columnGap : 0;
  const available = Math.max(1, viewportWidth - 2 * LAYOUT.padX - gaps);
  return clampScale(available / columns / widest(rows));
}

/** The scale at which the tallest row fits the viewport height too (whole pages). */
export function fitPageScale(
  rows: readonly RowSizes[],
  mode: CompareLayoutMode,
  viewportWidth: number,
  viewportHeight: number,
): number {
  let tallest = 1;
  for (const row of rows) tallest = Math.max(tallest, row.a?.height ?? 0, row.b?.height ?? 0);
  const available = Math.max(
    1,
    viewportHeight - LAYOUT.header - LAYOUT.padTop - LAYOUT.label - LAYOUT.rowGap,
  );
  return clampScale(Math.min(fitScale(rows, mode, viewportWidth), available / tallest));
}

export function layoutRows(
  rows: readonly RowSizes[],
  mode: CompareLayoutMode,
  scale: number,
): RowsLayout {
  const columnWidth = widest(rows) * scale;
  const tops: number[] = [];
  const heights: number[] = [];
  let y = LAYOUT.header + LAYOUT.padTop;
  for (const row of rows) {
    const pageHeight = Math.max(row.a?.height ?? 0, row.b?.height ?? 0) * scale;
    const height = LAYOUT.label + pageHeight;
    tops.push(y);
    heights.push(height);
    y += height + LAYOUT.rowGap;
  }
  const columns = mode === 'side' ? 2 : 1;
  const contentWidth =
    2 * LAYOUT.padX + columns * columnWidth + (mode === 'side' ? LAYOUT.columnGap : 0);
  return {
    scale,
    columnWidth,
    tops,
    heights,
    contentWidth,
    contentHeight: y - LAYOUT.rowGap + LAYOUT.padBottom,
  };
}

/** The first and last row intersecting [scrollTop, scrollTop + height] (inclusive). */
export function visibleRows(
  layout: RowsLayout,
  scrollTop: number,
  height: number,
): { readonly first: number; readonly last: number } {
  const { tops, heights } = layout;
  if (tops.length === 0) return { first: 0, last: -1 };
  const bottom = scrollTop + height;
  let first = 0;
  // Rows are sorted by top: binary search for the first row ending below scrollTop.
  let lo = 0;
  let hi = tops.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((tops[mid] ?? 0) + (heights[mid] ?? 0) < scrollTop) lo = mid + 1;
    else {
      first = mid;
      hi = mid - 1;
    }
  }
  if (lo >= tops.length) first = tops.length - 1;
  let last = first;
  while (last + 1 < tops.length && (tops[last + 1] ?? Infinity) < bottom) last += 1;
  return { first, last };
}

/** The frame (geometry.ts) of a side page at `scale`. */
export function sideFrame(page: SidePage, scale: number): PageFrame {
  return {
    size: page.size,
    originX: page.origin.x,
    originY: page.origin.y,
    rotation: totalRotation(page),
    intrinsicRotation: page.intrinsic,
    scale,
  };
}

/** Where a side's page sheet sits in its row (CSS px, relative to the row's top-left). */
export function sheetBox(
  layout: RowsLayout,
  mode: CompareLayoutMode,
  side: 'a' | 'b',
  page: SidePage,
): Box {
  const size = displayedPageSize(page);
  const width = size.width * layout.scale;
  const height = size.height * layout.scale;
  // Side by side: each page centred in its column. Overlay: both at the column's left.
  const columnLeft =
    LAYOUT.padX + (mode === 'side' && side === 'b' ? layout.columnWidth + LAYOUT.columnGap : 0);
  const left = mode === 'side' ? columnLeft + (layout.columnWidth - width) / 2 : columnLeft;
  return { left, top: LAYOUT.label, width, height };
}

/**
 * The scroll position that brings a change into view: a user-space `rect` on a side's page
 * of `row` (or the row's top), kept where it is when already fully visible, otherwise
 * placed a third of the way down the viewport.
 */
export function revealScrollTop(input: {
  readonly layout: RowsLayout;
  readonly mode: CompareLayoutMode;
  readonly row: number;
  readonly side: 'a' | 'b';
  readonly page: SidePage | undefined;
  readonly rect?: Rect | undefined;
  readonly scrollTop: number;
  readonly viewportHeight: number;
}): number {
  const { layout, row, page, rect, scrollTop, viewportHeight } = input;
  const rowTop = layout.tops[row] ?? 0;
  let top = rowTop;
  let height: number = LAYOUT.label;
  if (page && rect) {
    const sheet = sheetBox(layout, input.mode, input.side, page);
    const box = userRectToCss(sideFrame(page, layout.scale), rect);
    top = rowTop + sheet.top + box.top;
    height = box.height;
  }
  const max = Math.max(0, layout.contentHeight - viewportHeight);
  // The sticky header covers the top of the viewport.
  const visible = top >= scrollTop + LAYOUT.header && top + height <= scrollTop + viewportHeight;
  if (visible) return scrollTop;
  const target = rect ? top - viewportHeight / 3 : rowTop - LAYOUT.header - LAYOUT.padTop;
  return Math.round(Math.min(max, Math.max(0, target)));
}

/**
 * The CSS size of a heat map (`width` × `height` px at `dpi`, top-left aligned with both
 * pages) at the view's scale.
 */
export function heatmapCss(
  visual: { readonly width: number; readonly height: number; readonly dpi: number },
  scale: number,
): Size {
  const k = (72 / visual.dpi) * scale;
  return { width: visual.width * k, height: visual.height * k };
}

/** A user-space rect on a side's page as a box relative to the row (for markers). */
export function markerBox(
  layout: RowsLayout,
  mode: CompareLayoutMode,
  side: 'a' | 'b',
  page: SidePage,
  rect: Rect,
): Box {
  const sheet = sheetBox(layout, mode, side, page);
  const box = userRectToCss(sideFrame(page, layout.scale), rect);
  return {
    left: sheet.left + box.left,
    top: sheet.top + box.top,
    width: box.width,
    height: box.height,
  };
}

/** Displayed sizes per page-map row. */
export function rowSizes(
  pairs: readonly { readonly a?: number; readonly b?: number }[],
  a: readonly SidePage[],
  b: readonly SidePage[],
): RowSizes[] {
  return pairs.map((pair) => {
    const pa = pair.a === undefined ? undefined : a[pair.a];
    const pb = pair.b === undefined ? undefined : b[pair.b];
    return {
      ...(pa ? { a: displayedPageSize(pa) } : {}),
      ...(pb ? { b: displayedPageSize(pb) } : {}),
    };
  });
}
