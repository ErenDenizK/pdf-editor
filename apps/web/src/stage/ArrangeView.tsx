/**
 * Arrange mode: the light table (docs/specs/light-table.md). A virtualized grid of the
 * active document's pages at one of five cell sizes, with the source colour tag, page label
 * and selection state per cell.
 *
 * Interaction is delegated to the grid element (one click and one keydown handler), and
 * every cell carries a stable `data-page-id`, so a drag-and-drop adapter can attach to
 * cells later without competing inline handlers.
 *
 * Keys (spec §2–§4): arrows move focus (wrapping across rows), Shift+arrows extend, Space
 * toggles, Home/End, Enter opens the page in Read mode, Alt+arrows move the selection one
 * slot. R / Shift+R, Delete, Mod+D, Mod+A and Esc are global commands.
 */
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  effectiveLabel,
  type PageId,
  pageTotalRotation,
  type VirtualDocument,
  type Workspace,
} from '@pdf-editor/document-model';
import {
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from 'react';

import { moveSelectionBy, arrangeSizeMessage } from '../commands/app-commands';
import { currentPlatform } from '../commands/shortcuts';
import { RENDER_PRIORITY } from '../engine/engine-service';
import { PageCanvas } from '../pages/PageCanvas';
import { displaySize, fitInBox, rotationPhrase } from '../pages/page-geometry';
import { announce } from '../shell/announcer';
import styles from '../shell/Stage.module.css';
import {
  clickSelection,
  extendSelection,
  moveFocusIndex,
  selectionSnapshot,
  toggleSelection,
  useSelectionStore,
} from '../state/selection-store';
import { ARRANGE_SIZES, useUiStore } from '../state/ui-store';
import { useViewStore } from '../state/view-store';
import { useWorkspaceStore } from '../state/workspace-store';

const PAD_X = 32;
const PAD_TOP = 16;
const PAD_BOTTOM = 112;
const GAP_X = 20;
const GAP_Y = 20;
/** Thumbnail box aspect (height / width): fits Letter; A4 portrait is slightly narrower. */
const BOX_ASPECT = 1.3;
/** Label line under the thumbnail. */
const META_HEIGHT = 28;
/** Wheel delta that steps the cell size once with Mod+Scroll. */
const WHEEL_STEP = 60;

type NavKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End';
const NAV_KEYS: readonly string[] = [
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
];

function isMod(event: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return currentPlatform === 'mac' ? event.metaKey : event.ctrlKey;
}

export function ArrangeView({ doc }: { readonly doc: VirtualDocument }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const stepArrangeSize = useUiStore((s) => s.stepArrangeSize);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Mod+Scroll changes the cell size (non-passive: it must cancel browser zoom).
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    let accumulated = 0;
    const onWheel = (event: WheelEvent) => {
      if (!isMod(event)) return;
      event.preventDefault();
      accumulated += event.deltaY;
      if (Math.abs(accumulated) < WHEEL_STEP) return;
      const direction = accumulated < 0 ? 1 : -1;
      accumulated = 0;
      if (stepArrangeSize(direction)) announce(arrangeSizeMessage());
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [stepArrangeSize]);

  return (
    <div ref={viewportRef} className={styles.viewport}>
      {width > 0 ? <PageGrid doc={doc} width={width} viewportRef={viewportRef} /> : null}
    </div>
  );
}

function PageGrid({
  doc,
  width,
  viewportRef,
}: {
  readonly doc: VirtualDocument;
  readonly width: number;
  readonly viewportRef: RefObject<HTMLDivElement | null>;
}) {
  'use no memo'; // TanStack Virtual mutates its instance; the React Compiler must not cache it.
  const ws = useWorkspaceStore((s) => s.workspace);
  const files = useWorkspaceStore((s) => s.files);
  const arrangeSize = useUiStore((s) => s.arrangeSize);
  const setViewMode = useUiStore((s) => s.setViewMode);
  const focused = useSelectionStore((s) => s.focused);
  const apply = useSelectionStore((s) => s.apply);
  const clear = useSelectionStore((s) => s.clear);
  const scrollToPage = useViewStore((s) => s.scrollToPage);
  const gridRef = useRef<HTMLDivElement>(null);

  const cellWidth = (ARRANGE_SIZES[arrangeSize] ?? ARRANGE_SIZES[1]).width;
  const boxHeight = Math.round(cellWidth * BOX_ASPECT);
  const rowHeight = boxHeight + META_HEIGHT + GAP_Y;
  const columns = Math.max(1, Math.floor((width - PAD_X * 2 + GAP_X) / (cellWidth + GAP_X)));
  const pages = doc.pages;
  const order = pages.map((p) => p.id);
  const rowCount = Math.ceil(pages.length / columns);
  const el = viewportRef.current;
  const screenRows = Math.max(1, Math.ceil((el?.clientHeight ?? 800) / rowHeight));

  // Opted out of the compiler above ('use no memo'), so the instance is read fresh.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => rowHeight,
    paddingStart: PAD_TOP,
    paddingEnd: PAD_BOTTOM,
    // Spec §7: render the visible range ± one screen (at low priority).
    overscan: screenRows,
  });
  useEffect(() => {
    virtualizer.measure();
  }, [virtualizer, rowHeight]);

  const focusedIndex = focused === null ? -1 : order.indexOf(focused);

  // Keep DOM focus on the focused cell while the grid has focus (roving tabindex).
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid || focused === null || !grid.contains(document.activeElement)) return;
    const cell = grid.querySelector<HTMLElement>(`[data-page-id="${CSS.escape(focused)}"]`);
    if (cell && document.activeElement !== cell) cell.focus({ preventScroll: true });
  });

  const focusIndex = (index: number) => {
    const id = order[index];
    if (id === undefined) return;
    virtualizer.scrollToIndex(Math.floor(index / columns), { align: 'auto' });
    return id;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLElement && event.target.closest('[role="gridcell"]') === null)
      return;
    const state = selectionSnapshot();
    const current = focusedIndex >= 0 ? focusedIndex : 0;
    if (NAV_KEYS.includes(event.key)) {
      if (event.altKey && !event.shiftKey && !isMod(event)) {
        const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns }[
          event.key as 'ArrowLeft'
        ];
        if (step === undefined) return;
        event.preventDefault();
        moveSelectionBy(step);
        return;
      }
      event.preventDefault();
      const next = moveFocusIndex(current, pages.length, event.key as NavKey, columns);
      const id = focusIndex(next);
      if (id === undefined) return;
      if (event.shiftKey) apply(extendSelection(state, order, id));
      else apply({ ...state, focused: id, anchor: state.selected.size === 0 ? id : state.anchor });
      return;
    }
    if (event.key === ' ' && !event.altKey && !isMod(event)) {
      const id = order[current];
      if (id === undefined) return;
      event.preventDefault();
      apply(toggleSelection(state, id));
      return;
    }
    if (event.key === 'Enter') {
      const id = order[current];
      if (id === undefined) return;
      event.preventDefault();
      openInRead(id);
    }
  };

  const openInRead = (id: PageId) => {
    setViewMode('read');
    scrollToPage(id);
  };

  const cellFrom = (event: MouseEvent): PageId | undefined => {
    const cell = (event.target as Element).closest<HTMLElement>('[data-page-id]');
    return (cell?.dataset.pageId as PageId | undefined) ?? undefined;
  };

  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const id = cellFrom(event);
    if (id === undefined) {
      clear();
      return;
    }
    apply(
      clickSelection(selectionSnapshot(), order, id, {
        shift: event.shiftKey,
        mod: isMod(event),
      }),
    );
  };

  const onDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    const id = cellFrom(event);
    if (id !== undefined) openInRead(id);
  };

  const rows = virtualizer.getVirtualItems();
  const viewTop = el?.scrollTop ?? 0;
  const viewBottom = viewTop + (el?.clientHeight ?? 0);
  // Roving tabindex: the focused cell, else the first rendered one.
  const rovingId =
    focused !== null &&
    order.includes(focused) &&
    rows.some((r) => r.index === Math.floor(focusedIndex / columns))
      ? focused
      : order[(rows[0]?.index ?? 0) * columns];

  return (
    <div
      ref={gridRef}
      role="grid"
      aria-label={`Pages of ${doc.title}`}
      aria-multiselectable="true"
      aria-rowcount={rowCount}
      aria-colcount={columns}
      tabIndex={-1}
      className={styles.lightTable}
      style={{ height: virtualizer.getTotalSize() }}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
    >
      {rows.map((row) => {
        const visible = row.end > viewTop && row.start < viewBottom;
        const start = row.index * columns;
        return (
          <div
            key={row.key}
            role="row"
            aria-rowindex={row.index + 1}
            className={styles.gridRow}
            style={{
              transform: `translateY(${row.start}px)`,
              gridTemplateColumns: `repeat(${columns}, ${cellWidth}px)`,
              columnGap: GAP_X,
              paddingInline: PAD_X,
            }}
          >
            {pages.slice(start, start + columns).map((page, offset) => (
              <PageCell
                key={page.id}
                ws={ws}
                doc={doc}
                index={start + offset}
                column={offset}
                cellWidth={cellWidth}
                boxHeight={boxHeight}
                colorIndex={
                  page.ref.kind === 'source' ? (files[page.ref.source]?.colorIndex ?? 0) : 0
                }
                sourceName={page.ref.kind === 'source' ? files[page.ref.source]?.name : undefined}
                tabbable={page.id === rovingId}
                priority={visible ? RENDER_PRIORITY.visible : RENDER_PRIORITY.offscreen}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}

function PageCell({
  ws,
  doc,
  index,
  column,
  cellWidth,
  boxHeight,
  colorIndex,
  sourceName,
  tabbable,
  priority,
}: {
  readonly ws: Workspace;
  readonly doc: VirtualDocument;
  readonly index: number;
  readonly column: number;
  readonly cellWidth: number;
  readonly boxHeight: number;
  readonly colorIndex: number;
  readonly sourceName: string | undefined;
  readonly tabbable: boolean;
  readonly priority: number;
}) {
  const page = doc.pages[index];
  const id = page?.id;
  const selected = useSelectionStore((s) => (id === undefined ? false : s.selected.has(id)));
  const focused = useSelectionStore((s) => s.focused === id);
  if (!page) return null;
  const size = displaySize(ws, page);
  const fitted = fitInBox(size, cellWidth, boxHeight);
  const label = effectiveLabel(ws, doc, index);
  const total = pageTotalRotation(ws, page);
  const labelText = label === String(index + 1) ? `Page ${label}` : `Page ${index + 1} (${label})`;
  return (
    <div
      role="gridcell"
      aria-colindex={column + 1}
      aria-selected={selected}
      aria-label={`${labelText} of ${doc.pages.length}${sourceName ? `, from ${sourceName}` : ''}${rotationPhrase(total)}`}
      tabIndex={tabbable ? 0 : -1}
      data-page-id={page.id}
      data-focused={focused || undefined}
      className={styles.cell}
    >
      <div className={styles.cellBox} style={{ height: boxHeight }}>
        <div className={styles.thumbSheet} style={{ width: fitted.width, height: fitted.height }}>
          <PageCanvas
            sourceId={page.ref.kind === 'source' ? page.ref.source : undefined}
            index={page.ref.kind === 'source' ? page.ref.index : 0}
            rotation={page.rotation}
            widthPt={size.width}
            heightPt={size.height}
            cssWidth={fitted.width}
            priority={priority}
          />
        </div>
      </div>
      <div className={styles.cardMeta} aria-hidden="true">
        <span className={styles.cardTag} data-tag={colorIndex} />
        <span className={`${styles.cardName} ${styles.numeric}`}>{label}</span>
      </div>
    </div>
  );
}
