/**
 * Read mode: the active document as a virtualized column of rows rendered by the engine at
 * zoom × devicePixelRatio. A row is one page (continuous), a spread of two pages side by
 * side (two-up), or only the current page (single page). Placeholder sheets are sized from
 * the model (`pageDisplaySize`) so the layout never jumps; bitmaps fill in as they arrive.
 * On zoom the sheets resize at once (the current bitmap stretches) and a sharper render is
 * requested after a short debounce; above the single-bitmap cap, visible tiles render at
 * full resolution (`TiledPage`).
 *
 * Zoom keeps a stable anchor: the point under the viewport centre (buttons, keys) or under
 * the pointer (Mod+wheel, trackpad pinch, touch pinch, Safari gestures) stays in place.
 *
 * Every page hosts the registered overlays (text layer, search highlights, links, …).
 * With a text layer the page is a `region` whose content is its text; the canvas is
 * decorative.
 */
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  type Rect,
  type Size,
  type VirtualDocument,
  type VirtualPage,
  pageTotalRotation,
  type Workspace,
} from '@pdf-editor/document-model';
import { type RefObject, useEffect, useLayoutEffect, useRef } from 'react';

import { RENDER_PRIORITY, sheetSize } from '../engine/engine-service';
import { m } from '../i18n';
import { PageCanvas } from '../pages/PageCanvas';
import { CSS_PX_PER_PT, displaySize, rotationPhrase } from '../pages/page-geometry';
import { needsTiles, TiledPage } from '../pages/TiledPage';
import { useSelectionStore } from '../state/selection-store';
import { MAX_ZOOM, MIN_ZOOM, useUiStore } from '../state/ui-store';
import { type ReadLayout, useViewStore } from '../state/view-store';
import { useWorkspaceStore } from '../state/workspace-store';
import styles from '../shell/Stage.module.css';
import { type Box, userRectToCss } from '../viewer/geometry';
import { GoToPageDialog } from '../viewer/GoToPageDialog';
import {
  documentFingerprint,
  documentLabels,
  recallPosition,
  rememberPosition,
} from '../viewer/navigation';
import { pageFrame } from '../viewer/page-frame';
import { setReadController } from '../viewer/read-controller';
import '../viewer/register';
import { installCopyHandler } from '../viewer/TextLayer';
import { PageOverlays } from './page-overlays';
import { type ContentFrame, contentFrame, ResizedContent } from './ResizedContent';

const PAD_X = 48;
const PAD_TOP = 16;
const PAD_BOTTOM = 112;
const GAP = 16;
/** Debounce before a zoom change requests sharper bitmaps. */
const ZOOM_RENDER_DELAY_MS = 160;
/** Wheel delta (pixels) that doubles or halves the zoom with Mod+wheel / pinch. */
const WHEEL_ZOOM_DOUBLING = 300;
/** A programmatic scroll has settled after this long without scroll events. */
const NAV_SETTLE_MS = 180;
/** Remember the reading position after it has settled for this long. */
const REMEMBER_DELAY_MS = 600;

/**
 * A resized page in Read mode (`VirtualPage.resize`): where its content bitmap goes on the
 * sheet (the model's `pageContentPlacement`, via `contentFrame`), in CSS pixels snapped to
 * device pixels, and the content's scale for the canvas and tiles. The overlays use the
 * page's resized frame (`pageFrame` with the page), which maps engine geometry to the same
 * place through the resize matrix; read-resize.test.tsx checks the two agree.
 */
interface ResizedLayout {
  readonly box: Box;
  /** Displayed content size in points (after rotation). */
  readonly contentPt: Size;
  /** CSS pixels per content point (horizontally, for a stretch). */
  readonly contentScale: number;
  /** Non-uniform (stretch): the bitmap is stretched by CSS, never drawn 1:1 or tiled. */
  readonly stretched: boolean;
  /** Content reaches past the sheet (scale to cover, shrinking canvas): clip the sheet. */
  readonly overflows: boolean;
}

/** Exported for tests. */
export function resizedLayout(
  frame: ContentFrame,
  stretched: boolean,
  sheet: Size,
  dpr: number,
): ResizedLayout {
  const raw = {
    left: frame.left * sheet.width,
    top: frame.top * sheet.height,
    width: frame.width * sheet.width,
    height: frame.height * sheet.height,
  };
  const contentPt = { width: frame.widthPt, height: frame.heightPt };
  const contentScale = raw.width / Math.max(1e-6, contentPt.width);
  const snap = (v: number) => Math.round(v * dpr) / dpr;
  // Uniform: the same snapping as a sheet, so the exact-scale bitmap maps 1:1.
  const size = stretched
    ? { width: raw.width, height: raw.height }
    : sheetSize(contentPt.width, contentPt.height, contentScale, dpr);
  const box = { left: snap(raw.left), top: snap(raw.top), ...size };
  const overflows =
    box.left < -0.5 ||
    box.top < -0.5 ||
    box.left + box.width > sheet.width + 0.5 ||
    box.top + box.height > sheet.height + 0.5;
  return { box, contentPt, contentScale, stretched, overflows };
}

function resizedLayoutOf(
  ws: Workspace,
  page: VirtualPage,
  sheet: Size,
  dpr: number,
): ResizedLayout | undefined {
  const frame = contentFrame(ws, page);
  if (frame === undefined) return undefined;
  const stretched = page.resize?.mode === 'scale' && page.resize.stretch === true;
  return resizedLayout(frame, stretched, sheet, dpr);
}

/** Documents whose remembered position was already applied this session. */
const restored = new Set<string>();

interface Row {
  /** Page indices, left to right. */
  readonly pages: readonly number[];
  /** Points: sum of the page widths (gaps excluded) and the tallest page. */
  readonly width: number;
  readonly height: number;
}

interface Layout {
  readonly sizes: readonly Size[];
  readonly rows: readonly Row[];
  /** Row index of every page (-1 when the layout does not show it). */
  readonly rowOf: readonly number[];
  /** Widest row in points, and whether any row has two pages (one gap). */
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly maxGaps: number;
}

function rowOfPages(pages: readonly number[], sizes: readonly Size[]): Row {
  let width = 0;
  let height = 0;
  for (const i of pages) {
    width += sizes[i]?.width ?? 0;
    height = Math.max(height, sizes[i]?.height ?? 0);
  }
  return { pages, width, height };
}

/** Rows for a layout. Exported for tests. */
export function computeRows(
  sizes: readonly Size[],
  layout: ReadLayout,
  currentPage: number,
): Row[] {
  const count = sizes.length;
  if (count === 0) return [];
  if (layout === 'single') {
    return [rowOfPages([Math.min(Math.max(0, currentPage), count - 1)], sizes)];
  }
  if (layout === 'two-up') {
    const rows: Row[] = [];
    for (let i = 0; i < count; i += 2) {
      rows.push(rowOfPages(i + 1 < count ? [i, i + 1] : [i], sizes));
    }
    return rows;
  }
  return sizes.map((_, i) => rowOfPages([i], sizes));
}

function computeLayout(
  ws: Workspace,
  doc: VirtualDocument,
  layout: ReadLayout,
  currentPage: number,
): Layout {
  const sizes = doc.pages.map((page) => displaySize(ws, page));
  const rows = computeRows(sizes, layout, currentPage);
  const rowOf = new Array<number>(sizes.length).fill(-1);
  rows.forEach((row, r) => {
    for (const i of row.pages) rowOf[i] = r;
  });
  // Fit modes use every page, so the zoom does not change from page to page.
  const all = computeRows(sizes, layout === 'single' ? 'continuous' : layout, 0);
  let maxWidth = 1;
  let maxHeight = 1;
  let maxGaps = 0;
  for (const row of all) {
    maxWidth = Math.max(maxWidth, row.width);
    maxHeight = Math.max(maxHeight, row.height);
    maxGaps = Math.max(maxGaps, row.pages.length - 1);
  }
  return { sizes, rows, rowOf, maxWidth, maxHeight, maxGaps };
}

export function ReadView({ doc }: { readonly doc: VirtualDocument }) {
  const ws = useWorkspaceStore((s) => s.workspace);
  const zoom = useUiStore((s) => s.zoom);
  const fitMode = useUiStore((s) => s.fitMode);
  const applyFitZoom = useUiStore((s) => s.applyFitZoom);
  const readLayout = useViewStore((s) => s.layout);
  const currentPage = useViewStore((s) => s.currentPage);
  const viewportRef = useRef<HTMLDivElement>(null);
  const layout = computeLayout(ws, doc, readLayout, currentPage);
  const cssScale = zoom * CSS_PX_PER_PT;

  // Fit width / fit page follow the viewport size.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el || fitMode === null) return;
    const fit = () => {
      const byWidth =
        (el.clientWidth - PAD_X * 2 - layout.maxGaps * GAP) / (layout.maxWidth * CSS_PX_PER_PT);
      const byHeight = (el.clientHeight - PAD_TOP - GAP) / (layout.maxHeight * CSS_PX_PER_PT);
      applyFitZoom(fitMode === 'width' ? byWidth : Math.min(byWidth, byHeight));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [fitMode, applyFitZoom, layout.maxWidth, layout.maxHeight, layout.maxGaps]);

  // Copy from the text layer assembles lines and pages (TextLayer.tsx).
  useEffect(() => installCopyHandler(), []);

  // Remember the reading position per document fingerprint (localStorage, guarded).
  const fingerprint = documentFingerprint(ws, doc);
  useEffect(() => {
    if (fingerprint === undefined) return;
    let timer = 0;
    const unsubscribe = useViewStore.subscribe((state, previous) => {
      if (state.currentPage === previous.currentPage) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(
        () => rememberPosition(fingerprint, state.currentPage),
        REMEMBER_DELAY_MS,
      );
    });
    return () => {
      unsubscribe();
      window.clearTimeout(timer);
    };
  }, [fingerprint]);

  return (
    <div
      ref={viewportRef}
      className={styles.viewport}
      data-read-viewport
      data-layout={readLayout}
      tabIndex={-1}
    >
      <PageColumn
        doc={doc}
        ws={ws}
        layout={layout}
        readLayout={readLayout}
        cssScale={cssScale}
        viewportRef={viewportRef}
        fingerprint={fingerprint}
      />
      <GoToPageDialog doc={doc} />
    </div>
  );
}

/** A zoom anchor: a point of a row that must stay under a viewport position. */
interface Anchor {
  readonly row: number;
  /** Position inside the row, 0 = top, 1 = bottom. */
  readonly fraction: number;
  /** Viewport position (CSS px from the viewport's top-left) that keeps the point. */
  readonly viewportX: number;
  readonly viewportY: number;
  /** Horizontal distance of the point from the canvas centre, CSS px, at `scale`. */
  readonly fromCentre: number;
  readonly scale: number;
}

function PageColumn({
  doc,
  ws,
  layout,
  readLayout,
  cssScale,
  viewportRef,
  fingerprint,
}: {
  readonly doc: VirtualDocument;
  readonly ws: Workspace;
  readonly layout: Layout;
  readonly readLayout: ReadLayout;
  readonly cssScale: number;
  readonly viewportRef: RefObject<HTMLDivElement | null>;
  readonly fingerprint: string | undefined;
}) {
  'use no memo'; // TanStack Virtual mutates its instance; the React Compiler must not cache it.
  const setCurrentPage = useViewStore((s) => s.setCurrentPage);
  const setVisibleRange = useViewStore((s) => s.setVisibleRange);
  const scrollRequest = useViewStore((s) => s.scrollRequest);
  const { sizes, rows } = layout;
  const pages = doc.pages;
  const heightOf = (r: number) => (rows[r]?.height ?? 792) * cssScale;
  const rowCssWidth = (r: number) => {
    const row = rows[r];
    return row ? row.width * cssScale + (row.pages.length - 1) * GAP : 0;
  };
  const canvasWidth = layout.maxWidth * cssScale + layout.maxGaps * GAP + PAD_X * 2;

  // Opted out of the compiler above ('use no memo'), so the instance is read fresh.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => viewportRef.current,
    estimateSize: (r) => heightOf(r) + GAP,
    getItemKey: (r) => {
      const first = rows[r]?.pages[0];
      return `${readLayout}:${(first === undefined ? undefined : pages[first]?.id) ?? r}`;
    },
    paddingStart: PAD_TOP,
    paddingEnd: PAD_BOTTOM - GAP,
    overscan: 2,
  });

  /** Canvas width as laid out (at least the viewport). */
  const laidOutWidth = (el: HTMLElement, width: number) => Math.max(el.clientWidth, width);

  /** An anchor for the point at viewport position (vx, vy). */
  const anchorAt = (vx: number, vy: number): Anchor | null => {
    const el = viewportRef.current;
    if (!el) return null;
    const y = el.scrollTop + vy;
    let found: Anchor | null = null;
    for (const item of virtualizer.getVirtualItems()) {
      if (item.start <= y || found === null) {
        const height = Math.max(1, heightOf(item.index));
        found = {
          row: item.index,
          fraction: Math.min(1, Math.max(0, (y - item.start) / height)),
          viewportX: vx,
          viewportY: vy,
          fromCentre: el.scrollLeft + vx - laidOutWidth(el, canvasWidth) / 2,
          scale: cssScale,
        };
      }
    }
    return found;
  };

  // Pending navigation target: cleared once the programmatic scroll goes quiet.
  const settleTimer = useRef(0);
  const armSettle = () => {
    window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(() => {
      useViewStore.getState().setNavTarget(null);
    }, NAV_SETTLE_MS);
  };

  // Keep the anchored point in place across zoom changes.
  const anchor = useRef<Anchor | null>(null);
  const pointerAnchor = useRef<Anchor | null>(null);
  const lastScale = useRef(cssScale);
  useLayoutEffect(() => {
    if (lastScale.current === cssScale) return;
    lastScale.current = cssScale;
    virtualizer.measure();
    const el = viewportRef.current;
    const a = pointerAnchor.current ?? anchor.current;
    pointerAnchor.current = null;
    if (!el || !a) return;
    const start = virtualizer.getOffsetForIndex(a.row, 'start')?.[0];
    if (start === undefined) return;
    el.scrollTop = start + a.fraction * heightOf(a.row) - a.viewportY;
    const ratio = cssScale / a.scale;
    el.scrollLeft = laidOutWidth(el, canvasWidth) / 2 + a.fromCentre * ratio - a.viewportX;
  });

  // Current page, visible pages and the zoom anchor from the scroll position.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const top = el.scrollTop;
      const bottom = top + el.clientHeight;
      const items = virtualizer.getVirtualItems();
      // Current: the most visible row (the first on ties, so short pages read 1, 2, …).
      let current: (typeof items)[number] | undefined;
      let currentVisible = -1;
      let first = Number.POSITIVE_INFINITY;
      let last = -1;
      for (const item of items) {
        const visible = Math.min(item.end - GAP, bottom) - Math.max(item.start, top);
        if (visible > currentVisible + 0.5) {
          current = item;
          currentVisible = visible;
        }
        if (visible > 0) {
          for (const page of rows[item.index]?.pages ?? []) {
            first = Math.min(first, page);
            last = Math.max(last, page);
          }
        }
      }
      const centre = anchorAt(el.clientWidth / 2, el.clientHeight / 2);
      if (centre) anchor.current = centre;
      const page = current ? rows[current.index]?.pages[0] : undefined;
      if (page === undefined) return;
      setCurrentPage(page);
      if (last >= 0) setVisibleRange(first, last);
      else setVisibleRange(page, page);
    };
    const onScroll = () => {
      if (frame === 0) frame = requestAnimationFrame(update);
      // A programmatic scroll is still moving: wait for it to go quiet.
      if (useViewStore.getState().navTarget !== null) armSettle();
    };
    update();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  });

  // The user scrolling by hand abandons a pending navigation target (see view-store).
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const abandon = () => {
      window.clearTimeout(settleTimer.current);
      useViewStore.getState().setNavTarget(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      // Only keys that scroll natively; `[` `]` PageUp PageDown Space Home End are commands.
      if (event.key.startsWith('Arrow')) abandon();
    };
    el.addEventListener('wheel', abandon, { passive: true });
    el.addEventListener('touchstart', abandon, { passive: true });
    el.addEventListener('pointerdown', abandon);
    el.addEventListener('keydown', onKeyDown);
    return () => {
      el.removeEventListener('wheel', abandon);
      el.removeEventListener('touchstart', abandon);
      el.removeEventListener('pointerdown', abandon);
      el.removeEventListener('keydown', onKeyDown);
    };
  });
  useEffect(
    () => () => {
      window.clearTimeout(settleTimer.current);
      useViewStore.getState().setNavTarget(null);
    },
    [],
  );

  // Zoom under the pointer: Mod+wheel and trackpad pinch (ctrlKey wheel), touch pinch,
  // Safari gesture events.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const zoomAround = (factor: number, clientX: number, clientY: number) => {
      const { zoom, setZoom } = useUiStore.getState();
      const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * factor));
      if (Math.abs(next - zoom) < 1e-4) return;
      const bounds = el.getBoundingClientRect();
      pointerAnchor.current = anchorAt(clientX - bounds.left, clientY - bounds.top);
      setZoom(next);
    };
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? el.clientHeight : 1;
      const delta = Math.max(-150, Math.min(150, event.deltaY * unit));
      zoomAround(2 ** (-delta / WHEEL_ZOOM_DOUBLING), event.clientX, event.clientY);
    };
    // Safari trackpad pinch.
    let gestureZoom = 1;
    const onGestureStart = (event: Event) => {
      event.preventDefault();
      gestureZoom = useUiStore.getState().zoom;
    };
    const onGestureChange = (event: Event) => {
      event.preventDefault();
      const e = event as Event & { scale?: number; clientX?: number; clientY?: number };
      const target = gestureZoom * (e.scale ?? 1);
      const zoom = useUiStore.getState().zoom;
      zoomAround(target / zoom, e.clientX ?? 0, e.clientY ?? 0);
    };
    // Touch pinch: two active touch pointers.
    const touches = new Map<number, { x: number; y: number }>();
    let pinchDistance = 0;
    const distance = () => {
      const [a, b] = [...touches.values()];
      return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType !== 'touch') return;
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (touches.size === 2) pinchDistance = distance();
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!touches.has(event.pointerId)) return;
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (touches.size !== 2 || pinchDistance <= 0) return;
      const now = distance();
      const [a, b] = [...touches.values()];
      if (a && b && now > 0) zoomAround(now / pinchDistance, (a.x + b.x) / 2, (a.y + b.y) / 2);
      pinchDistance = now;
    };
    const onPointerEnd = (event: PointerEvent) => {
      touches.delete(event.pointerId);
      if (touches.size < 2) pinchDistance = 0;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('gesturestart', onGestureStart);
    el.addEventListener('gesturechange', onGestureChange);
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerEnd);
    el.addEventListener('pointercancel', onPointerEnd);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('gesturestart', onGestureStart);
      el.removeEventListener('gesturechange', onGestureChange);
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', onPointerEnd);
      el.removeEventListener('pointercancel', onPointerEnd);
    };
  });

  /** A page to show once the single-page layout has switched to it. */
  const pendingReveal = useRef<{ index: number; reveal: Rect | undefined } | null>(null);

  /** Brings page `index` into view; `reveal` (user space) scrolls minimally to a region. */
  const showPage = (index: number, reveal?: Rect) => {
    const el = viewportRef.current;
    if (!el) return;
    if (readLayout === 'single' && layout.rowOf[index] !== 0) {
      // The single row shows the current page: switch it, then scroll once laid out.
      setCurrentPage(index);
      pendingReveal.current = { index, reveal };
      return;
    }
    const r = layout.rowOf[index] ?? -1;
    if (r < 0) return;
    if (reveal === undefined) {
      virtualizer.scrollToIndex(r, { align: 'start' });
      return;
    }
    const page = pages[index];
    const size = sizes[index];
    const row = rows[r];
    const rowStart = virtualizer.getOffsetForIndex(r, 'start')?.[0];
    if (!page || !size || !row || rowStart === undefined) return;
    // For 'start', the scroll offset that puts the row at the top is the row's top.
    const rowTop = rowStart;
    const frame = pageFrame({
      sourceId: page.ref.kind === 'source' ? page.ref.source : undefined,
      sourceIndex: page.ref.kind === 'source' ? page.ref.index : 0,
      sizePt: size,
      rotation: pageTotalRotation(ws, page),
      cssScale,
      page,
    });
    const box = userRectToCss(frame, reveal);
    const top = rowTop + box.top;
    const bottom = top + box.height;
    const margin = Math.min(96, el.clientHeight / 4);
    if (top < el.scrollTop + margin || bottom > el.scrollTop + el.clientHeight - margin) {
      el.scrollTop = Math.max(0, top - el.clientHeight / 3);
    }
    // Horizontally: rows are centred in the canvas.
    const width = laidOutWidth(el, canvasWidth);
    let x = (width - rowCssWidth(r)) / 2;
    for (const i of row.pages) {
      if (i === index) break;
      x += (sizes[i]?.width ?? 0) * cssScale + GAP;
    }
    const left = x + box.left;
    const right = left + box.width;
    if (left < el.scrollLeft + 16 || right > el.scrollLeft + el.clientWidth - 16) {
      el.scrollLeft = Math.max(0, left - el.clientWidth / 3);
    }
  };
  useEffect(() => {
    const pending = pendingReveal.current;
    if (!pending || layout.rowOf[pending.index] !== 0) return;
    pendingReveal.current = null;
    if (pending.reveal) showPage(pending.index, pending.reveal);
    else viewportRef.current?.scrollTo({ top: 0 });
  });

  // Scroll-to-page requests (Pages panel, outline, links, search, go to page).
  const handledRequest = useRef(scrollRequest?.serial ?? 0);
  useEffect(() => {
    if (!scrollRequest || scrollRequest.serial === handledRequest.current) return;
    handledRequest.current = scrollRequest.serial;
    const index = pages.findIndex((p) => p.id === scrollRequest.pageId);
    if (index < 0) return;
    showPage(index, scrollRequest.reveal);
    // Relative moves step from here until the scroll settles (navigation.ts).
    useViewStore.getState().setNavTarget(index);
    armSettle();
  });

  // A layout switch keeps the current page in view.
  const lastLayout = useRef(readLayout);
  useLayoutEffect(() => {
    if (lastLayout.current === readLayout) return;
    lastLayout.current = readLayout;
    const current = useViewStore.getState().currentPage;
    virtualizer.measure();
    if (readLayout === 'single') viewportRef.current?.scrollTo({ top: 0 });
    else {
      const r = layout.rowOf[current] ?? 0;
      virtualizer.scrollToIndex(r, { align: 'start' });
    }
  });

  // On mount: a selection shows its first page; otherwise the remembered position.
  useEffect(() => {
    const { selected } = useSelectionStore.getState();
    const selectedIndex = selected.size > 0 ? pages.findIndex((p) => selected.has(p.id)) : -1;
    if (selectedIndex > 0) {
      showPage(selectedIndex);
    } else if (fingerprint !== undefined && !restored.has(doc.id)) {
      const remembered = recallPosition(fingerprint);
      if (remembered !== undefined && remembered > 0 && remembered < pages.length) {
        showPage(remembered);
      }
    }
    restored.add(doc.id);
    // Mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Commands that act on the viewport (PageUp / PageDown / Space).
  useEffect(() => {
    setReadController({
      scrollByScreen: (direction) => {
        const el = viewportRef.current;
        if (!el) return;
        const step = Math.max(40, el.clientHeight - 48);
        const view = useViewStore.getState();
        const pending = view.navTarget;
        if (readLayout === 'single') {
          const atEnd =
            direction > 0
              ? el.scrollTop + el.clientHeight >= el.scrollHeight - 2
              : el.scrollTop <= 1;
          const current = pending ?? view.currentPage;
          const target = current + direction;
          if (atEnd && target >= 0 && target < pages.length) {
            setCurrentPage(target);
            view.setNavTarget(target);
            armSettle();
            pendingReveal.current = { index: target, reveal: undefined };
            requestAnimationFrame(() => {
              if (direction < 0) el.scrollTop = el.scrollHeight;
            });
            return;
          }
        } else if (pending !== null) {
          // A programmatic scroll is in flight: land on its target first, then move a screen.
          const r = layout.rowOf[pending] ?? -1;
          const start = r >= 0 ? virtualizer.getOffsetForIndex(r, 'start')?.[0] : undefined;
          if (start !== undefined) el.scrollTop = start;
        }
        window.clearTimeout(settleTimer.current);
        view.setNavTarget(null);
        el.scrollBy({ top: direction * step });
      },
      ownsFocus: () => {
        // The pages themselves or nowhere; never a control (a focused link hotspot keeps
        // Space and Enter).
        const active = document.activeElement;
        return !active || active === document.body || active === viewportRef.current;
      },
    });
    return () => setReadController(null);
  });

  const items = virtualizer.getVirtualItems();
  const el = viewportRef.current;
  const viewTop = el?.scrollTop ?? 0;
  const viewBottom = viewTop + (el?.clientHeight ?? 0);
  const labels = documentLabels(ws, doc);
  const dpr = window.devicePixelRatio || 1;

  return (
    <div
      className={styles.readCanvas}
      style={{ height: virtualizer.getTotalSize(), width: canvasWidth }}
    >
      {items.map((item) => {
        const row = rows[item.index];
        if (!row) return null;
        const rowVisible = item.end > viewTop && item.start < viewBottom;
        return (
          <div
            key={item.key}
            className={styles.readItem}
            data-row={item.index}
            style={{
              transform: `translateY(${item.start}px)`,
              height: heightOf(item.index),
              gap: GAP,
            }}
          >
            {row.pages.map((index) => {
              const page = pages[index];
              const size = sizes[index];
              if (!page || !size) return null;
              // Whole device pixels, matching the exact-scale bitmap (drawn 1:1).
              const { width, height } = sheetSize(size.width, size.height, cssScale, dpr);
              const total = pageTotalRotation(ws, page);
              const sourceId = page.ref.kind === 'source' ? page.ref.source : undefined;
              const sourceIndex = page.ref.kind === 'source' ? page.ref.index : 0;
              const name = `${m.cell_label({ position: index + 1, count: pages.length })}${rotationPhrase(total)}`;
              const label = labels[index];
              const textual = sourceId !== undefined;
              const resized = resizedLayoutOf(ws, page, { width, height }, dpr);
              // The bitmap covers the content box: the page's own, or the resized one's.
              const contentPt = resized?.contentPt ?? size;
              const contentScale = resized?.contentScale ?? cssScale;
              const tiled =
                textual &&
                rowVisible &&
                resized?.stretched !== true &&
                needsTiles(contentScale, contentPt.width, contentPt.height);
              return (
                <div
                  key={page.id}
                  role={textual ? 'region' : 'img'}
                  aria-label={
                    label !== undefined && label !== String(index + 1)
                      ? `${name} (${m.viewer_page_label({ label })})`
                      : name
                  }
                  className={styles.page}
                  data-page-id={page.id}
                  data-page-index={index}
                  data-resized={resized === undefined ? undefined : ''}
                  style={{ width, height, ...(resized?.overflows ? { overflow: 'hidden' } : {}) }}
                >
                  <ResizedContent frame={resized?.box} unit="px">
                    <PageCanvas
                      sourceId={sourceId}
                      blobId={page.ref.kind === 'image' ? page.ref.blob : undefined}
                      index={sourceIndex}
                      rotation={page.rotation}
                      widthPt={contentPt.width}
                      heightPt={contentPt.height}
                      cssWidth={resized?.box.width ?? width}
                      exact={resized?.stretched !== true}
                      priority={rowVisible ? RENDER_PRIORITY.page : RENDER_PRIORITY.offscreen}
                      delayMs={ZOOM_RENDER_DELAY_MS}
                    />
                    {tiled && sourceId !== undefined ? (
                      <TiledPage
                        sourceId={sourceId}
                        index={sourceIndex}
                        rotation={page.rotation}
                        frame={pageFrame({
                          sourceId,
                          sourceIndex,
                          sizePt: contentPt,
                          rotation: total,
                          cssScale: contentScale,
                        })}
                      />
                    ) : null}
                  </ResizedContent>
                  <PageOverlays
                    page={page}
                    pageId={page.id}
                    pageIndex={index}
                    sourceId={sourceId}
                    sourceIndex={sourceIndex}
                    sizePt={size}
                    cssScale={cssScale}
                    rotation={total}
                    visible={rowVisible}
                  />
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
