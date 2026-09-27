/**
 * Light-table geometry (docs/specs/light-table.md §1–§3), as pure functions so hit testing
 * works on a virtualized grid without asking the DOM where cells are.
 *
 * The table is a vertical stack of sections (one per shown document). A section is a
 * header followed by rows of fixed-size cells laid out left to right:
 *
 *   x of column c = padX + c * (cellWidth + gapX)
 *   y of row r    = gridTop + r * rowHeight          (rowHeight includes the row gap)
 *
 * Drop targets are **gaps**, never cells: gap `column` k of a row sits in the gutter
 * before cell k; k = cells-in-row is the row end. The gutter (gapX) is reserved space, so
 * the 2px insertion bar never shifts anything.
 */

/** Spacing constants (CSS pixels). */
export const GRID = {
  padX: 32,
  gapX: 20,
  gapY: 20,
  /** Label and hover actions under the thumbnail (the reserved gutter of spec §4). */
  metaHeight: 28,
  /** Thumbnail box aspect (height / width): fits Letter; A4 portrait is narrower. */
  boxAspect: 1.3,
  headerHeight: 48,
  /** Space after a section's last row. */
  sectionGap: 16,
  padTop: 8,
  /** Room for the floating tool bar under the last row. */
  padBottom: 112,
  /** Height of the drop row of a section without pages. */
  emptyRowHeight: 120,
} as const;

export interface GridMetrics {
  readonly cellWidth: number;
  readonly boxHeight: number;
  /** boxHeight + metaHeight + gapY. */
  readonly rowHeight: number;
  readonly columns: number;
  readonly padX: number;
  readonly gapX: number;
}

export function gridMetrics(width: number, cellWidth: number): GridMetrics {
  const boxHeight = Math.round(cellWidth * GRID.boxAspect);
  const columns = Math.max(
    1,
    Math.floor((width - GRID.padX * 2 + GRID.gapX) / (cellWidth + GRID.gapX)),
  );
  return {
    cellWidth,
    boxHeight,
    rowHeight: boxHeight + GRID.metaHeight + GRID.gapY,
    columns,
    padX: GRID.padX,
    gapX: GRID.gapX,
  };
}

export function rowCount(count: number, columns: number): number {
  return Math.ceil(count / Math.max(1, columns));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// ---------------------------------------------------------------------------
// Section stack layout
// ---------------------------------------------------------------------------

export interface SectionSpec<Id extends string = string> {
  readonly id: Id;
  readonly count: number;
  readonly collapsed: boolean;
}

export interface SectionLayout<Id extends string = string> {
  readonly id: Id;
  /** Position in the section list. */
  readonly index: number;
  readonly count: number;
  readonly collapsed: boolean;
  /** Top of the section (its header), in table coordinates. */
  readonly top: number;
  /** Top of the first row. */
  readonly gridTop: number;
  /** Rendered rows: 0 when collapsed, 1 (a drop row) when the section has no pages. */
  readonly rows: number;
  readonly gridHeight: number;
  /** Bottom of the section including the trailing gap. */
  readonly bottom: number;
  /** Index of the section's header item in `ArrangeLayout.items`. */
  readonly firstItem: number;
}

/** One virtualizer item: a section header, a row of cells, or the gap after a section. */
export type LayoutItem =
  | {
      readonly kind: 'header';
      readonly section: number;
      readonly start: number;
      readonly size: number;
    }
  | {
      readonly kind: 'row';
      readonly section: number;
      readonly row: number;
      readonly start: number;
      readonly size: number;
    }
  | {
      readonly kind: 'gap';
      readonly section: number;
      readonly start: number;
      readonly size: number;
    };

export interface ArrangeLayout<Id extends string = string> {
  readonly sections: readonly SectionLayout<Id>[];
  readonly items: readonly LayoutItem[];
  /** Includes padTop and padBottom. */
  readonly totalHeight: number;
}

/**
 * Stacks sections vertically. Item starts match what TanStack Virtual computes for the
 * same sizes with `paddingStart: GRID.padTop`, so either can be used to position rows.
 */
export function computeLayout<Id extends string>(
  specs: readonly SectionSpec<Id>[],
  metrics: GridMetrics,
): ArrangeLayout<Id> {
  const sections: SectionLayout<Id>[] = [];
  const items: LayoutItem[] = [];
  let y = GRID.padTop;
  specs.forEach((spec, index) => {
    const top = y;
    const firstItem = items.length;
    items.push({ kind: 'header', section: index, start: y, size: GRID.headerHeight });
    y += GRID.headerHeight;
    const gridTop = y;
    let rows = 0;
    let gridHeight = 0;
    if (!spec.collapsed) {
      if (spec.count === 0) {
        rows = 1;
        gridHeight = GRID.emptyRowHeight;
        items.push({ kind: 'row', section: index, row: 0, start: y, size: gridHeight });
        y += gridHeight;
      } else {
        rows = rowCount(spec.count, metrics.columns);
        for (let row = 0; row < rows; row++) {
          items.push({ kind: 'row', section: index, row, start: y, size: metrics.rowHeight });
          y += metrics.rowHeight;
        }
        gridHeight = rows * metrics.rowHeight;
      }
    }
    items.push({ kind: 'gap', section: index, start: y, size: GRID.sectionGap });
    y += GRID.sectionGap;
    sections.push({
      id: spec.id,
      index,
      count: spec.count,
      collapsed: spec.collapsed,
      top,
      gridTop,
      rows,
      gridHeight,
      bottom: y,
      firstItem,
    });
  });
  return { sections, items, totalHeight: y + GRID.padBottom };
}

/** Item index of a cell's row (for scrollToIndex). */
export function rowItemIndex(section: SectionLayout, pageIndex: number, columns: number): number {
  if (section.collapsed) return section.firstItem;
  const row = section.count === 0 ? 0 : Math.floor(pageIndex / Math.max(1, columns));
  return section.firstItem + 1 + clamp(row, 0, Math.max(0, section.rows - 1));
}

/** The section whose vertical extent contains `y` (table coordinates), if any. */
export function sectionAtY<Id extends string>(
  layout: ArrangeLayout<Id>,
  y: number,
): SectionLayout<Id> | undefined {
  return layout.sections.find((s) => y >= s.top && y < s.bottom);
}

// ---------------------------------------------------------------------------
// Insertion gaps
// ---------------------------------------------------------------------------

export interface Gap {
  /** Insertion index in the document, pre-removal (what `movePages` expects). */
  readonly index: number;
  /** Row the bar is drawn in. */
  readonly row: number;
  /** Gutter within the row: 0 = before the first cell, cells-in-row = after the last. */
  readonly column: number;
}

/**
 * The gap nearest to a point, in coordinates relative to the section's first row
 * (x from the section's left edge, y from `gridTop`). Points above the grid snap to the
 * first row, points below the last row mean "end of section", and a row's trailing gutter
 * (column = cells in that row) is distinct from the next row's leading gutter even though
 * both insert at the same index, so the bar follows the pointer.
 */
export function gapAt(metrics: GridMetrics, count: number, x: number, y: number): Gap {
  if (count <= 0) return { index: 0, row: 0, column: 0 };
  const columns = Math.max(1, metrics.columns);
  const rows = rowCount(count, columns);
  const lastRowCells = count - (rows - 1) * columns;
  if (y >= rows * metrics.rowHeight) return { index: count, row: rows - 1, column: lastRowCells };
  const row = clamp(Math.floor(y / metrics.rowHeight), 0, rows - 1);
  const rowStart = row * columns;
  const cellsInRow = Math.min(columns, count - rowStart);
  const pitch = metrics.cellWidth + metrics.gapX;
  const column = clamp(Math.round((x - metrics.padX + metrics.gapX / 2) / pitch), 0, cellsInRow);
  return { index: rowStart + column, row, column };
}

/** The gap for an insertion index (keyboard paste, collapsed-section drops). */
export function gapForIndex(metrics: GridMetrics, count: number, index: number): Gap {
  const columns = Math.max(1, metrics.columns);
  const i = clamp(index, 0, Math.max(0, count));
  if (count === 0) return { index: 0, row: 0, column: 0 };
  if (i === count) {
    const rows = rowCount(count, columns);
    return { index: i, row: rows - 1, column: count - (rows - 1) * columns };
  }
  return { index: i, row: Math.floor(i / columns), column: i % columns };
}

/** Where to draw the 2px bar for a gap, relative to the section's first row. */
export function gapBar(metrics: GridMetrics, gap: Gap): { x: number; y: number; height: number } {
  const pitch = metrics.cellWidth + metrics.gapX;
  return {
    x: Math.round(metrics.padX + gap.column * pitch - metrics.gapX / 2 - 1),
    y: gap.row * metrics.rowHeight,
    height: metrics.boxHeight,
  };
}

// ---------------------------------------------------------------------------
// Marquee
// ---------------------------------------------------------------------------

export interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export function normalizeRect(x1: number, y1: number, x2: number, y2: number): Rect {
  return {
    left: Math.min(x1, x2),
    top: Math.min(y1, y2),
    right: Math.max(x1, x2),
    bottom: Math.max(y1, y2),
  };
}

/** The rectangle of a cell's thumbnail box and label, in table coordinates. */
export function cellRect(section: SectionLayout, metrics: GridMetrics, index: number): Rect {
  const columns = Math.max(1, metrics.columns);
  const row = Math.floor(index / columns);
  const column = index % columns;
  const left = metrics.padX + column * (metrics.cellWidth + metrics.gapX);
  const top = section.gridTop + row * metrics.rowHeight;
  return {
    left,
    top,
    right: left + metrics.cellWidth,
    bottom: top + metrics.rowHeight - GRID.gapY,
  };
}

/**
 * Cells a marquee rectangle (table coordinates) touches, per section, in page order.
 * Only rows overlapping the rectangle are visited, so this is cheap on huge tables.
 */
export function cellsInRect<Id extends string>(
  layout: ArrangeLayout<Id>,
  metrics: GridMetrics,
  rect: Rect,
): { readonly section: Id; readonly indices: readonly number[] }[] {
  const columns = Math.max(1, metrics.columns);
  const pitch = metrics.cellWidth + metrics.gapX;
  const colFrom = clamp(Math.floor((rect.left - metrics.padX) / pitch), 0, columns - 1);
  const colTo = clamp(Math.floor((rect.right - metrics.padX) / pitch), 0, columns - 1);
  const result: { section: Id; indices: number[] }[] = [];
  for (const section of layout.sections) {
    if (section.collapsed || section.count === 0) continue;
    if (rect.bottom < section.gridTop || rect.top >= section.gridTop + section.gridHeight) continue;
    const rowFrom = clamp(
      Math.floor((rect.top - section.gridTop) / metrics.rowHeight),
      0,
      section.rows - 1,
    );
    const rowTo = clamp(
      Math.floor((rect.bottom - section.gridTop) / metrics.rowHeight),
      0,
      section.rows - 1,
    );
    const indices: number[] = [];
    for (let row = rowFrom; row <= rowTo; row++) {
      for (let column = colFrom; column <= colTo; column++) {
        const index = row * columns + column;
        if (index >= section.count) break;
        const cell = cellRect(section, metrics, index);
        const hit =
          cell.left <= rect.right &&
          cell.right >= rect.left &&
          cell.top <= rect.bottom &&
          cell.bottom >= rect.top;
        if (hit) indices.push(index);
      }
    }
    if (indices.length > 0) result.push({ section: section.id, indices });
  }
  return result;
}

/**
 * Auto-scroll speed for a pointer near the top or bottom edge of a scroll container
 * (marquee; drags use the pragmatic-drag-and-drop auto-scroller). Pixels per frame,
 * negative = up; ramps up quadratically inside `zone`.
 */
export function edgeScrollSpeed(
  pointerY: number,
  top: number,
  bottom: number,
  zone = 48,
  max = 24,
): number {
  if (pointerY < top + zone) {
    const t = clamp((top + zone - pointerY) / zone, 0, 1);
    return -Math.ceil(max * t * t);
  }
  if (pointerY > bottom - zone) {
    const t = clamp((pointerY - (bottom - zone)) / zone, 0, 1);
    return Math.ceil(max * t * t);
  }
  return 0;
}
