/**
 * Arrange mode: the light table (docs/specs/light-table.md). One scroll container with a
 * stack of sections (every open document unless hidden; the active one always), each a
 * virtualized grid of page cells. TanStack Virtual picks the rendered range over a flat
 * list of header / row / gap items; positions come from `dnd/geometry.ts`, which also does
 * hit testing, so drops and marquees work on rows that are not in the DOM.
 *
 * Interaction:
 * - Click / Shift / Mod select (Shift ranges within a section); marquee on empty space
 *   (additive with Shift or Mod) with edge auto-scroll; selection spans sections.
 * - Keys: arrows move focus (wrapping across rows and sections), Shift+arrows extend,
 *   Space toggles, Home/End, Enter opens in Read mode, Alt+arrows move pages one slot,
 *   Alt+Shift+arrows move to the row (left/right) or section (up/down) edge.
 *   Clipboard (Mod+X/C/V), R, Delete, Mod+D, Mod+A, Esc are commands.
 * - Drag and drop on @atlaskit/pragmatic-drag-and-drop: pages between gaps (Alt copies),
 *   tabs onto the table (pin), OS files onto a section (insert at the gap) or the
 *   background (open as documents, handled by the shell's window-wide drop).
 */
import { autoScrollForElements } from '@atlaskit/pragmatic-drag-and-drop-auto-scroll/element';
import { autoScrollForExternal } from '@atlaskit/pragmatic-drag-and-drop-auto-scroll/external';
import { dropTargetForExternal } from '@atlaskit/pragmatic-drag-and-drop/adapter/drop-target-for-external';
import {
  dropTargetForElements,
  monitorForElements,
} from '@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter';
import { monitorForExternal } from '@atlaskit/pragmatic-drag-and-drop/adapter/monitor-for-external';
import type { DragLocation } from '@atlaskit/pragmatic-drag-and-drop/types';
import { combine } from '@atlaskit/pragmatic-drag-and-drop/utils/combine';
import { containsFiles } from '@atlaskit/pragmatic-drag-and-drop/utils/contains-files';
import { ContextMenu } from '@base-ui/react/context-menu';
import type { DocumentId, PageId } from '@pdf-editor/document-model';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from 'react';

import { arrangeSizeMessage, moveSelectionBy } from '../commands/app-commands';
import { currentPlatform } from '../commands/shortcuts';
import {
  type DropHighlight,
  setDragSession,
  setDropHighlight,
  useDragSession,
  useDropHighlight,
} from '../dnd/drag-store';
import { insertFilesAt, showInArrange, transferPages } from '../dnd/drop';
import {
  type ArrangeLayout,
  cellsInRect,
  computeLayout,
  edgeScrollSpeed,
  gapAt,
  GRID,
  type GridMetrics,
  gridMetrics,
  normalizeRect,
  rowItemIndex,
} from '../dnd/geometry';
import { isPageDrag, isTabDrag } from '../dnd/page-drag';
import { filesFromItems, isOpenableFile } from '../files/open-files';
import { m } from '../i18n';
import { announce } from '../shell/announcer';
import {
  clickSelection,
  extendSelection,
  marqueeSelection,
  sameSelection,
  type SelectionSnapshot,
  selectionSnapshot,
  toggleSelection,
  useSelectionStore,
} from '../state/selection-store';
import { ARRANGE_SIZES, useUiStore } from '../state/ui-store';
import { useViewStore } from '../state/view-store';
import { useWorkspaceStore } from '../state/workspace-store';
import { type MoveEdge, movePagesToEdge } from './arrange-actions';
import { provideArrangeColumns } from './arrange-commands';
import { pageIndexes, type ShownSection, useShownSections } from './arrange-data';
import { ArrangeContextMenuPopup } from './ArrangeContextMenu';
import { ArrangeSection } from './ArrangeSection';
import styles from './ArrangeView.module.css';
import { ContextualBar } from './ContextualBar';

/** Wheel delta that steps the cell size once with Mod+Scroll. */
const WHEEL_STEP = 60;
/** Pointer travel before a press on empty space becomes a marquee. */
const MARQUEE_THRESHOLD = 4;
/** Collapsed sections expand after hovering a drag over them this long (spec §3). */
const EXPAND_DELAY_MS = 600;

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

export function ArrangeView() {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const stepArrangeSize = useUiStore((s) => s.stepArrangeSize);
  const backgroundTarget = useDropHighlight((s) => s.highlight?.kind === 'background');

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
    <div className={styles.frame}>
      <div ref={viewportRef} className={styles.viewport} data-testid="light-table">
        {width > 0 ? <LightTable width={width} viewportRef={viewportRef} /> : null}
      </div>
      {backgroundTarget ? (
        <div className={styles.backgroundOutline} aria-hidden="true">
          <span className={styles.dropLabel}>{m.arrange_drop_background()}</span>
        </div>
      ) : null}
    </div>
  );
}

interface TableState {
  readonly layout: ArrangeLayout<DocumentId>;
  readonly metrics: GridMetrics;
  readonly sections: readonly ShownSection[];
}

interface MarqueeDrag {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly additive: boolean;
  readonly base: SelectionSnapshot;
  clientX: number;
  clientY: number;
  moved: boolean;
  frame: number;
}

/** Where a pointer at `location` would drop, for the given drag kind. */
function dropHighlightAt(
  location: DragLocation,
  state: TableState,
  kind: 'pages' | 'files' | 'tab',
): DropHighlight | null {
  const target = location.dropTargets[0];
  if (target === undefined) return null;
  if (target.data.type === 'background') return { kind: 'background' };
  if (target.data.type !== 'section') return null;
  const id = target.data.documentId as DocumentId;
  const section = state.layout.sections.find((s) => s.id === id);
  if (section === undefined) return null;
  if (kind === 'tab' || section.collapsed) return { kind: 'section', section: id };
  const rect = target.element.getBoundingClientRect();
  const gap = gapAt(
    state.metrics,
    section.count,
    location.input.clientX - rect.left,
    location.input.clientY - rect.top - GRID.headerHeight,
  );
  return {
    kind: 'gap',
    section: id,
    gap,
    duplicate: kind === 'pages' && location.input.altKey,
    files: kind === 'files',
  };
}

function LightTable({
  width,
  viewportRef,
}: {
  readonly width: number;
  readonly viewportRef: RefObject<HTMLDivElement | null>;
}) {
  'use no memo'; // TanStack Virtual mutates its instance; the React Compiler must not cache it.
  const sections = useShownSections();
  const ws = useWorkspaceStore((s) => s.workspace);
  const files = useWorkspaceStore((s) => s.files);
  const setActive = useWorkspaceStore((s) => s.setActive);
  const arrangeSize = useUiStore((s) => s.arrangeSize);
  const setViewMode = useUiStore((s) => s.setViewMode);
  const focused = useSelectionStore((s) => s.focused);
  const apply = useSelectionStore((s) => s.apply);
  const scrollToPage = useViewStore((s) => s.scrollToPage);
  const dragging = useDragSession((s) => s.session !== null);
  const tableRef = useRef<HTMLDivElement>(null);
  const marqueeRef = useRef<MarqueeDrag | null>(null);
  const scrollFocusPending = useRef(false);
  const [marquee, setMarquee] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(
    null,
  );
  const [menuPage, setMenuPage] = useState<PageId | null>(null);

  const cellWidth = (ARRANGE_SIZES[arrangeSize] ?? ARRANGE_SIZES[1]).width;
  const metrics = gridMetrics(width, cellWidth);
  const specs = sections.map((s) => ({
    id: s.doc.id,
    count: s.doc.pages.length,
    collapsed: s.collapsed,
  }));
  const layout = computeLayout(specs, metrics);
  const el = viewportRef.current;
  const screenRows = Math.max(1, Math.ceil((el?.clientHeight ?? 800) / metrics.rowHeight));

  // Opted out of the compiler above ('use no memo'), so the instance is read fresh.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: layout.items.length,
    getScrollElement: () => viewportRef.current,
    estimateSize: (index) => layout.items[index]?.size ?? 0,
    paddingStart: GRID.padTop,
    paddingEnd: GRID.padBottom,
    // Spec §7: render the visible range ± one screen (at low priority).
    overscan: screenRows + 1,
  });
  const layoutKey = `${metrics.rowHeight}:${metrics.columns}:${specs
    .map((s) => `${s.id}/${s.count}/${s.collapsed ? 1 : 0}`)
    .join(',')}`;
  useEffect(() => {
    virtualizer.measure();
  }, [virtualizer, layoutKey]);

  // Drag-and-drop handlers are registered once and read the latest geometry from here.
  const stateRef = useRef<TableState>({ layout, metrics, sections });
  useEffect(() => {
    stateRef.current = { layout, metrics, sections };
  });

  useEffect(() => provideArrangeColumns(() => stateRef.current.metrics.columns), []);

  const locate = (id: PageId): { section: number; index: number } | undefined => {
    for (let i = 0; i < sections.length; i++) {
      const section = sections[i];
      const index = section ? pageIndexes(section.doc).get(id) : undefined;
      if (index !== undefined) return { section: i, index };
    }
    return undefined;
  };

  const scrollToCell = (section: number, index: number) => {
    const sectionLayout = layout.sections[section];
    if (!sectionLayout) return;
    virtualizer.scrollToIndex(rowItemIndex(sectionLayout, index, metrics.columns), {
      align: 'auto',
    });
  };

  const activateSectionOf = (id: PageId) => {
    const location = locate(id);
    const doc = location === undefined ? undefined : sections[location.section]?.doc;
    if (doc && useWorkspaceStore.getState().workspace.activeDocument !== doc.id) setActive(doc.id);
  };

  // ------------------------------------------------------------------ drag and drop
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    let hoverSection: DocumentId | null = null;
    let hoverTimer: number | undefined;
    const hover = (highlight: DropHighlight | null) => {
      const id = highlight?.kind === 'section' ? highlight.section : null;
      const collapsed =
        id !== null && stateRef.current.layout.sections.find((s) => s.id === id)?.collapsed;
      const next = collapsed ? id : null;
      if (next === hoverSection) return;
      window.clearTimeout(hoverTimer);
      hoverSection = next;
      if (next !== null) {
        hoverTimer = window.setTimeout(() => {
          useUiStore.getState().setArrangeCollapsed(next, false);
          hoverSection = null;
        }, EXPAND_DELAY_MS);
      }
    };
    const update = (location: DragLocation, kind: 'pages' | 'files' | 'tab') => {
      const highlight = dropHighlightAt(location, stateRef.current, kind);
      hover(highlight);
      setDropHighlight(highlight);
      return highlight;
    };
    const finish = () => {
      window.clearTimeout(hoverTimer);
      hoverSection = null;
      setDropHighlight(null);
      setDragSession(null);
    };
    const insertionIndex = (highlight: DropHighlight): number | undefined => {
      if (highlight.kind === 'gap') return highlight.gap.index;
      if (highlight.kind === 'section') {
        return stateRef.current.layout.sections.find((s) => s.id === highlight.section)?.count;
      }
      return undefined;
    };
    const elementKind = (data: Record<string | symbol, unknown>) =>
      isTabDrag(data) ? ('tab' as const) : ('pages' as const);
    const background = { type: 'background' };

    return combine(
      dropTargetForElements({
        element: viewport,
        getData: () => background,
        canDrop: ({ source }) => isTabDrag(source.data),
      }),
      dropTargetForExternal({
        element: viewport,
        getData: () => background,
        canDrop: containsFiles,
      }),
      autoScrollForElements({
        element: viewport,
        canScroll: ({ source }) => isPageDrag(source.data) || isTabDrag(source.data),
      }),
      autoScrollForExternal({ element: viewport, canScroll: containsFiles }),
      monitorForElements({
        canMonitor: ({ source }) => isPageDrag(source.data) || isTabDrag(source.data),
        onDragStart: ({ source, location }) => {
          const data = source.data;
          setDragSession({
            kind: elementKind(data),
            pageIds: new Set(isPageDrag(data) ? data.pageIds : []),
          });
          update(location.current, elementKind(data));
          requestAnimationFrame(() => {
            try {
              performance.measure('light-table:drag-start', 'light-table:drag-start');
            } catch {
              // The mark is missing when the drag did not start on a page cell.
            }
          });
        },
        onDrag: ({ source, location }) => {
          update(location.current, elementKind(source.data));
        },
        onDropTargetChange: ({ source, location }) => {
          update(location.current, elementKind(source.data));
        },
        onDrop: ({ source, location }) => {
          const data = source.data;
          const highlight = dropHighlightAt(location.current, stateRef.current, elementKind(data));
          finish();
          if (highlight === null) return; // Escape, or dropped outside any gap.
          if (isTabDrag(data)) {
            showInArrange(data.documentId);
            return;
          }
          if (!isPageDrag(data) || highlight.kind === 'background') return;
          const index = insertionIndex(highlight);
          if (index === undefined) return;
          transferPages({
            pageIds: data.pageIds,
            target: { document: highlight.section, index },
            duplicate: location.current.input.altKey,
          });
        },
      }),
      monitorForExternal({
        canMonitor: containsFiles,
        onDragStart: ({ location }) => {
          setDragSession({ kind: 'files', pageIds: new Set() });
          update(location.current, 'files');
        },
        onDrag: ({ location }) => {
          update(location.current, 'files');
        },
        onDropTargetChange: ({ location }) => {
          update(location.current, 'files');
        },
        onDrop: ({ source, location }) => {
          const highlight = dropHighlightAt(location.current, stateRef.current, 'files');
          finish();
          // The background (and anything else) is the shell's window-wide drop.
          if (highlight === null || highlight.kind === 'background') return;
          const index = insertionIndex(highlight);
          if (index === undefined) return;
          // Must run synchronously: the item list dies when the drop handler returns.
          const pending = filesFromItems(source.items, [], isOpenableFile);
          void pending.then((found) => {
            if (found.length === 0) {
              announce(m.drop_no_pdfs());
              return;
            }
            void insertFilesAt(found, { document: highlight.section, index });
          });
        },
      }),
      () => {
        finish();
      },
    );
  }, [viewportRef]);

  // ------------------------------------------------------------------ focus
  // Keep DOM focus on the focused cell while the table has focus (roving tabindex).
  useEffect(() => {
    const table = tableRef.current;
    if (!table) return;
    if (scrollFocusPending.current && focused !== null) {
      scrollFocusPending.current = false;
      const location = locate(focused);
      if (location) scrollToCell(location.section, location.index);
    }
    if (focused === null || !table.contains(document.activeElement)) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && !active.matches('[role="gridcell"], [role="grid"]')) {
      return;
    }
    const cell = table.querySelector<HTMLElement>(`[data-page-id="${CSS.escape(focused)}"]`);
    if (cell && document.activeElement !== cell) cell.focus({ preventScroll: true });
  });

  // ------------------------------------------------------------------ keyboard
  const navigate = (
    sectionIndex: number,
    index: number,
    key: string,
  ): { section: number; index: number } | null => {
    const cols = metrics.columns;
    const count = sections[sectionIndex]?.doc.pages.length ?? 0;
    const open = (i: number) => {
      const s = sections[i];
      return s !== undefined && !s.collapsed && s.doc.pages.length > 0;
    };
    const previous = () => {
      for (let i = sectionIndex - 1; i >= 0; i--) if (open(i)) return i;
      return -1;
    };
    const next = () => {
      for (let i = sectionIndex + 1; i < sections.length; i++) if (open(i)) return i;
      return -1;
    };
    const countOf = (i: number) => sections[i]?.doc.pages.length ?? 0;
    const column = index % cols;
    switch (key) {
      case 'ArrowLeft': {
        if (index > 0) return { section: sectionIndex, index: index - 1 };
        const p = previous();
        return p < 0 ? null : { section: p, index: countOf(p) - 1 };
      }
      case 'ArrowRight': {
        if (index < count - 1) return { section: sectionIndex, index: index + 1 };
        const n = next();
        return n < 0 ? null : { section: n, index: 0 };
      }
      case 'ArrowUp': {
        if (index - cols >= 0) return { section: sectionIndex, index: index - cols };
        const p = previous();
        if (p < 0) return null;
        const c = countOf(p);
        const lastRowStart = Math.floor((c - 1) / cols) * cols;
        return { section: p, index: Math.min(lastRowStart + column, c - 1) };
      }
      case 'ArrowDown': {
        if (index + cols < count) return { section: sectionIndex, index: index + cols };
        if (Math.floor(index / cols) < Math.floor((count - 1) / cols)) {
          return { section: sectionIndex, index: count - 1 };
        }
        const n = next();
        return n < 0 ? null : { section: n, index: Math.min(column, countOf(n) - 1) };
      }
      case 'Home':
        return { section: sectionIndex, index: 0 };
      case 'End':
        return { section: sectionIndex, index: count - 1 };
      default:
        return null;
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const cell =
      event.target instanceof HTMLElement
        ? event.target.closest<HTMLElement>('[role="gridcell"][data-page-id]')
        : null;
    if (cell === null) return;
    const id = cell.dataset.pageId as PageId;
    const location = locate(id);
    if (location === undefined) return;
    const section = sections[location.section];
    if (!section) return;
    const order = section.doc.pages.map((p) => p.id);
    const state = selectionSnapshot();

    if (NAV_KEYS.includes(event.key)) {
      if (event.altKey && !isMod(event)) {
        event.preventDefault();
        activateSectionOf(id);
        scrollFocusPending.current = true;
        if (event.shiftKey) {
          const edges: Partial<Record<string, MoveEdge>> = {
            ArrowLeft: 'row-start',
            ArrowRight: 'row-end',
            ArrowUp: 'section-start',
            ArrowDown: 'section-end',
          };
          const edge = edges[event.key];
          if (edge) movePagesToEdge(edge, metrics.columns);
          return;
        }
        const step = {
          ArrowLeft: -1,
          ArrowRight: 1,
          ArrowUp: -metrics.columns,
          ArrowDown: metrics.columns,
        }[event.key as 'ArrowLeft'];
        if (step !== undefined) moveSelectionBy(step);
        return;
      }
      if (isMod(event)) return;
      event.preventDefault();
      const target = navigate(location.section, location.index, event.key);
      if (target === null) return;
      const targetSection = sections[target.section];
      const targetId = targetSection?.doc.pages[target.index]?.id;
      if (targetSection === undefined || targetId === undefined) return;
      scrollToCell(target.section, target.index);
      if (event.shiftKey && target.section === location.section) {
        apply(extendSelection(state, order, targetId));
      } else {
        apply({
          ...state,
          focused: targetId,
          anchor: state.selected.size === 0 ? targetId : state.anchor,
        });
      }
      activateSectionOf(targetId);
      return;
    }
    if (event.key === ' ' && !event.altKey && !isMod(event)) {
      event.preventDefault();
      apply(toggleSelection(state, id));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      openInRead(id);
    }
  };

  const openInRead = (id: PageId) => {
    activateSectionOf(id);
    setViewMode('read');
    scrollToPage(id);
  };

  // ------------------------------------------------------------------ pointer
  const cellFrom = (event: MouseEvent): PageId | undefined => {
    const cell = (event.target as Element).closest<HTMLElement>('[data-page-id]');
    return (cell?.dataset.pageId as PageId | undefined) ?? undefined;
  };

  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const id = cellFrom(event);
    if (id === undefined) return;
    const location = locate(id);
    const order = location ? (sections[location.section]?.doc.pages.map((p) => p.id) ?? []) : [];
    apply(
      clickSelection(selectionSnapshot(), order, id, { shift: event.shiftKey, mod: isMod(event) }),
    );
    activateSectionOf(id);
  };

  const onDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    const id = cellFrom(event);
    if (id !== undefined) openInRead(id);
  };

  const onContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    const id = cellFrom(event);
    setMenuPage(id ?? null);
    if (id === undefined) return;
    const state = selectionSnapshot();
    if (!state.selected.has(id)) apply({ selected: new Set([id]), anchor: id, focused: id });
    else apply({ ...state, focused: id });
    activateSectionOf(id);
  };

  const updateMarquee = () => {
    const drag = marqueeRef.current;
    const table = tableRef.current;
    if (!drag || !table) return;
    const rect = table.getBoundingClientRect();
    const x2 = drag.clientX - rect.left;
    const y2 = drag.clientY - rect.top;
    setMarquee({ x1: drag.startX, y1: drag.startY, x2, y2 });
    const { layout: currentLayout, metrics: currentMetrics, sections: current } = stateRef.current;
    const hits = cellsInRect(
      currentLayout,
      currentMetrics,
      normalizeRect(drag.startX, drag.startY, x2, y2),
    ).flatMap(({ section, indices }) => {
      const doc = current.find((s) => s.doc.id === section)?.doc;
      return doc ? indices.flatMap((i) => (doc.pages[i] ? [doc.pages[i].id] : [])) : [];
    });
    const next = marqueeSelection(drag.base, hits, drag.additive);
    if (!sameSelection(next.selected, useSelectionStore.getState().selected)) {
      useSelectionStore.getState().apply(next);
    }
  };

  const autoScroll = () => {
    const drag = marqueeRef.current;
    const viewport = viewportRef.current;
    if (!drag || !viewport) return;
    const bounds = viewport.getBoundingClientRect();
    const speed = edgeScrollSpeed(drag.clientY, bounds.top, bounds.bottom);
    if (speed === 0) {
      drag.frame = 0;
      return;
    }
    viewport.scrollTop += speed;
    updateMarquee();
    drag.frame = requestAnimationFrame(autoScroll);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.pointerType === 'touch') return;
    const target = event.target as Element;
    if (
      target.closest(
        '[data-page-id], [data-section-header], [data-context-bar], button, a, input, [role="menu"]',
      )
    ) {
      return;
    }
    const table = event.currentTarget;
    const rect = table.getBoundingClientRect();
    marqueeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX - rect.left,
      startY: event.clientY - rect.top,
      additive: event.shiftKey || isMod(event),
      base: selectionSnapshot(),
      clientX: event.clientX,
      clientY: event.clientY,
      moved: false,
      frame: 0,
    };
    table.setPointerCapture(event.pointerId);
    table.focus({ preventScroll: true });
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = marqueeRef.current;
    if (drag?.pointerId !== event.pointerId) return;
    drag.clientX = event.clientX;
    drag.clientY = event.clientY;
    if (!drag.moved) {
      const rect = event.currentTarget.getBoundingClientRect();
      const dx = event.clientX - rect.left - drag.startX;
      const dy = event.clientY - rect.top - drag.startY;
      if (Math.hypot(dx, dy) < MARQUEE_THRESHOLD) return;
      drag.moved = true;
    }
    updateMarquee();
    if (drag.frame === 0) drag.frame = requestAnimationFrame(autoScroll);
  };

  const endMarquee = (event: PointerEvent<HTMLDivElement>) => {
    const drag = marqueeRef.current;
    if (drag?.pointerId !== event.pointerId) return;
    marqueeRef.current = null;
    if (drag.frame !== 0) cancelAnimationFrame(drag.frame);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setMarquee(null);
    if (!drag.moved) {
      // A plain click on empty space clears the selection (Shift / Mod keep it).
      if (!drag.additive) useSelectionStore.getState().clear();
      return;
    }
    const count = useSelectionStore.getState().selected.size;
    announce(m.status_selected({ count }));
  };

  // ------------------------------------------------------------------ render
  const virtualItems = virtualizer.getVirtualItems();
  const rowsBySection = new Map<number, number[]>();
  for (const item of virtualItems) {
    const layoutItem = layout.items[item.index];
    if (!layoutItem) continue;
    const rows = rowsBySection.get(layoutItem.section) ?? [];
    if (layoutItem.kind === 'row') rows.push(layoutItem.row);
    rowsBySection.set(layoutItem.section, rows);
  }
  const viewTop = el?.scrollTop ?? 0;
  const viewBottom = viewTop + (el?.clientHeight ?? 0);
  const marqueeRect =
    marquee === null ? null : normalizeRect(marquee.x1, marquee.y1, marquee.x2, marquee.y2);

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger
        ref={tableRef}
        className={styles.table}
        style={{ height: layout.totalHeight }}
        tabIndex={-1}
        data-dragging={dragging || undefined}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        onKeyDown={onKeyDown}
        onContextMenu={onContextMenu}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endMarquee}
        onPointerCancel={endMarquee}
      >
        {sections.map((section, i) => {
          const rows = rowsBySection.get(i);
          const sectionLayout = layout.sections[i];
          if (rows === undefined || sectionLayout === undefined) return null;
          const first = rows[0];
          const focusedIndex = focused === null ? undefined : pageIndexes(section.doc).get(focused);
          const focusedRendered =
            focusedIndex !== undefined && rows.includes(Math.floor(focusedIndex / metrics.columns));
          const tabbableId = focusedRendered
            ? (focused ?? undefined)
            : first === undefined
              ? undefined
              : section.doc.pages[first * metrics.columns]?.id;
          return (
            <ArrangeSection
              key={section.doc.id}
              section={section}
              layout={sectionLayout}
              metrics={metrics}
              rows={rows}
              ws={ws}
              files={files}
              viewTop={viewTop}
              viewBottom={viewBottom}
              tabbableId={tabbableId}
            />
          );
        })}
        {marqueeRect ? (
          <div
            className={styles.marquee}
            data-testid="marquee"
            aria-hidden="true"
            style={{
              left: marqueeRect.left,
              top: marqueeRect.top,
              width: marqueeRect.right - marqueeRect.left,
              height: marqueeRect.bottom - marqueeRect.top,
            }}
          />
        ) : null}
        <ContextualBar
          sections={sections}
          layout={layout}
          metrics={metrics}
          width={width}
          viewTop={viewTop}
          viewBottom={viewBottom}
          suppressed={marquee !== null}
        />
      </ContextMenu.Trigger>
      <ArrangeContextMenuPopup pageId={menuPage} sectionIds={sections.map((s) => s.doc.id)} />
    </ContextMenu.Root>
  );
}
