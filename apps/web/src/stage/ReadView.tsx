/**
 * Read mode: the active document as a continuous, virtualized column of pages rendered by
 * the engine at zoom × devicePixelRatio. Placeholder sheets are sized from the model
 * (`pageDisplaySize`) so the layout never jumps; bitmaps fill in as they arrive. On zoom
 * the sheets resize at once (the current bitmap stretches) and a sharper render is
 * requested after a short debounce.
 */
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  type Size,
  type VirtualDocument,
  pageTotalRotation,
  type Workspace,
} from '@pdf-editor/document-model';
import { type RefObject, useEffect, useLayoutEffect, useRef } from 'react';

import { RENDER_PRIORITY } from '../engine/engine-service';
import { m } from '../i18n';
import { PageCanvas } from '../pages/PageCanvas';
import { PageOverlays } from './page-overlays';
import { CSS_PX_PER_PT, displaySize, rotationPhrase } from '../pages/page-geometry';
import { useSelectionStore } from '../state/selection-store';
import { useUiStore } from '../state/ui-store';
import { useViewStore } from '../state/view-store';
import { useWorkspaceStore } from '../state/workspace-store';
import styles from '../shell/Stage.module.css';

const PAD_X = 48;
const PAD_TOP = 16;
const PAD_BOTTOM = 112;
const GAP = 16;
/** Debounce before a zoom change requests sharper bitmaps. */
const ZOOM_RENDER_DELAY_MS = 160;

interface Layout {
  readonly sizes: readonly Size[];
  readonly maxWidth: number;
  readonly maxHeight: number;
}

function computeLayout(ws: Workspace, doc: VirtualDocument): Layout {
  const sizes = doc.pages.map((page) => displaySize(ws, page));
  let maxWidth = 1;
  let maxHeight = 1;
  for (const s of sizes) {
    maxWidth = Math.max(maxWidth, s.width);
    maxHeight = Math.max(maxHeight, s.height);
  }
  return { sizes, maxWidth, maxHeight };
}

export function ReadView({ doc }: { readonly doc: VirtualDocument }) {
  const ws = useWorkspaceStore((s) => s.workspace);
  const zoom = useUiStore((s) => s.zoom);
  const fitMode = useUiStore((s) => s.fitMode);
  const applyFitZoom = useUiStore((s) => s.applyFitZoom);
  const viewportRef = useRef<HTMLDivElement>(null);
  const layout = computeLayout(ws, doc);
  const cssScale = zoom * CSS_PX_PER_PT;

  // Fit width / fit page follow the viewport size.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el || fitMode === null) return;
    const fit = () => {
      const byWidth = (el.clientWidth - PAD_X * 2) / (layout.maxWidth * CSS_PX_PER_PT);
      const byHeight = (el.clientHeight - PAD_TOP - GAP) / (layout.maxHeight * CSS_PX_PER_PT);
      applyFitZoom(fitMode === 'width' ? byWidth : Math.min(byWidth, byHeight));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [fitMode, applyFitZoom, layout.maxWidth, layout.maxHeight]);

  return (
    <div ref={viewportRef} className={styles.viewport}>
      <PageColumn doc={doc} ws={ws} layout={layout} cssScale={cssScale} viewportRef={viewportRef} />
    </div>
  );
}

function PageColumn({
  doc,
  ws,
  layout,
  cssScale,
  viewportRef,
}: {
  readonly doc: VirtualDocument;
  readonly ws: Workspace;
  readonly layout: Layout;
  readonly cssScale: number;
  readonly viewportRef: RefObject<HTMLDivElement | null>;
}) {
  'use no memo'; // TanStack Virtual mutates its instance; the React Compiler must not cache it.
  const setCurrentPage = useViewStore((s) => s.setCurrentPage);
  const scrollRequest = useViewStore((s) => s.scrollRequest);
  const { sizes } = layout;
  const pages = doc.pages;
  const heightOf = (i: number) => (sizes[i]?.height ?? 792) * cssScale;

  // Opted out of the compiler above ('use no memo'), so the instance is read fresh.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: pages.length,
    getScrollElement: () => viewportRef.current,
    estimateSize: (i) => heightOf(i) + GAP,
    getItemKey: (i) => pages[i]?.id ?? i,
    paddingStart: PAD_TOP,
    paddingEnd: PAD_BOTTOM - GAP,
    overscan: 2,
  });

  // Keep the page under the viewport centre in place across zoom changes.
  const anchor = useRef<{ index: number; fraction: number } | null>(null);
  const lastScale = useRef(cssScale);
  useLayoutEffect(() => {
    if (lastScale.current === cssScale) return;
    lastScale.current = cssScale;
    virtualizer.measure();
    const el = viewportRef.current;
    const a = anchor.current;
    if (!el || !a) return;
    const start = virtualizer.getOffsetForIndex(a.index, 'start')?.[0];
    if (start === undefined) return;
    el.scrollTop = start + a.fraction * heightOf(a.index) - el.clientHeight / 2;
  });

  // Current page (status bar, Pages panel) and zoom anchor from the scroll position.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const top = el.scrollTop;
      const bottom = top + el.clientHeight;
      const centre = top + el.clientHeight / 2;
      const items = virtualizer.getVirtualItems();
      // Current page: the most visible one (the first on ties, so short pages read 1, 2, …).
      let current: (typeof items)[number] | undefined;
      let currentVisible = -1;
      // Zoom anchor: the page under the viewport centre.
      let centred = items[0];
      for (const item of items) {
        const visible = Math.min(item.end - GAP, bottom) - Math.max(item.start, top);
        if (visible > currentVisible + 0.5) {
          current = item;
          currentVisible = visible;
        }
        if (item.start <= centre) centred = item;
      }
      if (!current || !centred) return;
      const height = Math.max(1, heightOf(centred.index));
      anchor.current = {
        index: centred.index,
        fraction: Math.min(1, Math.max(0, (centre - centred.start) / height)),
      };
      setCurrentPage(current.index);
    };
    const onScroll = () => {
      if (frame === 0) frame = requestAnimationFrame(update);
    };
    update();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  });

  // Scroll-to-page requests (Pages panel, Enter in Arrange, selection on entering Read).
  const handledRequest = useRef(scrollRequest?.serial ?? 0);
  useEffect(() => {
    if (!scrollRequest || scrollRequest.serial === handledRequest.current) return;
    handledRequest.current = scrollRequest.serial;
    const index = pages.findIndex((p) => p.id === scrollRequest.pageId);
    if (index >= 0) virtualizer.scrollToIndex(index, { align: 'start' });
  });

  // Entering Read mode with a selection shows its first page.
  useEffect(() => {
    const { selected } = useSelectionStore.getState();
    if (selected.size === 0) return;
    const index = pages.findIndex((p) => selected.has(p.id));
    if (index > 0) virtualizer.scrollToIndex(index, { align: 'start' });
    // Mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const maxCssWidth = layout.maxWidth * cssScale;
  const items = virtualizer.getVirtualItems();
  const el = viewportRef.current;
  const viewTop = el?.scrollTop ?? 0;
  const viewBottom = viewTop + (el?.clientHeight ?? 0);

  return (
    <div
      className={styles.readCanvas}
      style={{ height: virtualizer.getTotalSize(), width: maxCssWidth + PAD_X * 2 }}
    >
      {items.map((item) => {
        const page = pages[item.index];
        const size = sizes[item.index];
        if (!page || !size) return null;
        const width = size.width * cssScale;
        const height = size.height * cssScale;
        const visible = item.end > viewTop && item.start < viewBottom;
        const total = pageTotalRotation(ws, page);
        return (
          <div
            key={item.key}
            className={styles.readItem}
            data-page-id={page.id}
            style={{ transform: `translateY(${item.start}px)`, height }}
          >
            <div
              role="img"
              aria-label={`${m.cell_label({ position: item.index + 1, count: pages.length })}${rotationPhrase(total)}`}
              className={styles.page}
              style={{ width, height }}
            >
              <PageCanvas
                sourceId={page.ref.kind === 'source' ? page.ref.source : undefined}
                blobId={page.ref.kind === 'image' ? page.ref.blob : undefined}
                index={page.ref.kind === 'source' ? page.ref.index : 0}
                rotation={page.rotation}
                widthPt={size.width}
                heightPt={size.height}
                cssWidth={width}
                priority={visible ? RENDER_PRIORITY.page : RENDER_PRIORITY.offscreen}
                delayMs={ZOOM_RENDER_DELAY_MS}
              />
              <PageOverlays
                page={page}
                pageId={page.id}
                pageIndex={item.index}
                sourceId={page.ref.kind === 'source' ? page.ref.source : undefined}
                sourceIndex={page.ref.kind === 'source' ? page.ref.index : 0}
                sizePt={size}
                cssScale={cssScale}
                rotation={total}
                visible={visible}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
