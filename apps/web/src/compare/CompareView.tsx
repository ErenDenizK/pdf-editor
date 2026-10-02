/**
 * The Compare view (spec recognize-and-compare §2.2), the stage's third view.
 *
 * - Setup: the two documents (open tabs, or a PDF dropped or opened here, which opens as a
 *   tab), page matching (auto, page by page, best match) and the resolution of the pixel
 *   diff (100 or 150 dpi).
 * - While running: progress by phase with Cancel; rows appear once the page map is known and
 *   fill in as each pair's visual diff lands (the rows in view first).
 * - Result: paired pages A | B in one scroll container (scroll and zoom synchronised), or B
 *   over A with an opacity slider (onion skin, both pages from the top-left corner as the
 *   pixel diff sees them); changed areas outlined, changed words marked, the heat map over
 *   B on request; a page map strip with inserted and deleted pages. The floating tool bar is
 *   glass; everything docked is opaque (DESIGN.md §2).
 *
 * Zoom is the shell's (Mod+= / Mod+- / Mod+0 and the status bar work here too); fit width
 * fits the two columns to the stage. Read-only: nothing here changes a document. When a
 * compared document changes after the run read it (in another view, or undo / redo here),
 * the pages draw the new state while the result describes the old one: a notice says so
 * and offers to run again.
 */
import type { DocumentId } from '@pdf-editor/document-model';
import type { PagePair, PixelDiffResult, TextChange } from '@pdf-editor/engine';
import {
  ChevronDown,
  ChevronUp,
  Columns2,
  Flame,
  FolderOpen,
  Layers,
  Maximize2,
  RefreshCw,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  type SyntheticEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { RENDER_PRIORITY } from '../engine/engine-service';
import {
  dragHasFiles,
  filesFromDataTransfer,
  isOpenableFile,
  partitionFiles,
  pickFiles,
} from '../files/open-files';
import { formatNumber, formatPercent, m } from '../i18n';
import { PageCanvas } from '../pages/PageCanvas';
import { CSS_PX_PER_PT } from '../pages/page-geometry';
import { announce } from '../shell/announcer';
import { useCommandShortcut } from '../shell/use-command-shortcut';
import { useUiStore } from '../state/ui-store';
import { useWorkspaceStore } from '../state/workspace-store';
import toolStyles from '../tools/ToolDialog.module.css';
import { IconButton } from '../ui/IconButton';
import { Range } from '../ui/Range';
import { userRectToCss } from '../viewer/geometry';
import { rowLabel } from './change-labels';
import { buildChangeList, buildPartialChangeList, rowIndex, rowStatus } from './changes';
import { stepChanges } from './compare-commands';
import { cancelCompare, heatmapBitmap, releaseCompare, startCompare } from './compare-runner';
import {
  type CompareLayout,
  type CompareSideView,
  requestReveal,
  useCompareStore,
} from './compare-store';
import styles from './CompareView.module.css';
import {
  fitPageScale,
  fitScale,
  heatmapCss,
  LAYOUT,
  layoutRows,
  revealScrollTop,
  rowSizes,
  type RowsLayout,
  sheetBox,
  sideFrame,
  visibleRows,
} from './layout';
import { displayedPageSize, type SidePage } from './side-page';

/** Rows rendered above and below the viewport. */
const OVERSCAN_PX = 800;
const ZOOM_RENDER_DELAY_MS = 160;

export default function CompareView({ dragging }: { readonly dragging: boolean }) {
  const status = useCompareStore((s) => s.status);
  if (status === 'setup' || status === 'failed') return <CompareSetup dragging={dragging} />;
  return <CompareResults />;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const ALIGNMENTS = [
  { id: 'auto', label: m.compare_align_auto, hint: m.compare_align_auto_hint },
  { id: 'index', label: m.compare_align_index, hint: m.compare_align_index_hint },
  { id: 'best-match', label: m.compare_align_best, hint: m.compare_align_best_hint },
] as const;

const RESOLUTIONS = [100, 150] as const;

/** Opens the first PDF of `files` as a tab and makes it B, keeping the active tab. */
async function addSecondFile(files: readonly File[]): Promise<void> {
  const { pdfs } = partitionFiles(files);
  const file = pdfs[0];
  if (!file) {
    announce(m.drop_no_pdfs());
    return;
  }
  const store = useWorkspaceStore.getState();
  const previous = store.workspace.activeDocument;
  const { opened, skipped } = await store.openFiles([file]);
  const added = opened[0];
  if (added) {
    useCompareStore.setState({ b: added.documentId });
    if (previous !== undefined && useWorkspaceStore.getState().workspace.documents[previous]) {
      useWorkspaceStore.getState().setActive(previous);
    }
    announce(m.compare_file_added({ name: added.name }));
  } else if (skipped[0]) {
    announce(m.compare_file_failed({ name: skipped[0].name }));
  }
}

function CompareSetup({ dragging }: { readonly dragging: boolean }) {
  const order = useWorkspaceStore((s) => s.workspace.documentOrder);
  const documents = useWorkspaceStore((s) => s.workspace.documents);
  const a = useCompareStore((s) => s.a);
  const b = useCompareStore((s) => s.b);
  const alignment = useCompareStore((s) => s.alignment);
  const dpi = useCompareStore((s) => s.dpi);
  const error = useCompareStore((s) => s.error);
  const [over, setOver] = useState(false);
  const alignName = useId();
  const dpiName = useId();
  const set = useCompareStore.setState;
  const ready = a !== null && b !== null && a !== b && !!documents[a] && !!documents[b];

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (ready) void startCompare();
  };
  const onDragOver = (event: DragEvent) => {
    if (!dragHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setOver(true);
  };
  const onDrop = (event: DragEvent) => {
    if (!dragHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    setOver(false);
    void filesFromDataTransfer(event.dataTransfer, isOpenableFile).then(addSecondFile);
  };
  const documentOptions = (except: DocumentId | null) =>
    order.map((id) => (
      <option key={id} value={id} disabled={id === except}>
        {documents[id]?.title ?? id}
      </option>
    ));

  return (
    <div className={styles.setup} data-testid="compare-setup">
      <form className={styles.card} onSubmit={submit} aria-labelledby="compare-setup-title">
        <h2 id="compare-setup-title" className={styles.cardTitle}>
          {m.compare_setup_title()}
        </h2>
        <p className={toolStyles.description}>{m.compare_setup_body()}</p>
        <div className={toolStyles.row}>
          <label className={toolStyles.field}>
            <span className={toolStyles.label}>{m.compare_side_a()}</span>
            <select
              className={toolStyles.select}
              value={a ?? ''}
              onChange={(event) => set({ a: (event.target.value || null) as DocumentId | null })}
            >
              {a === null ? <option value="">{m.compare_choose()}</option> : null}
              {documentOptions(b)}
            </select>
          </label>
          <label className={toolStyles.field}>
            <span className={toolStyles.label}>{m.compare_side_b()}</span>
            <select
              className={toolStyles.select}
              value={b ?? ''}
              onChange={(event) => set({ b: (event.target.value || null) as DocumentId | null })}
            >
              {b === null ? <option value="">{m.compare_choose()}</option> : null}
              {documentOptions(a)}
            </select>
          </label>
        </div>
        <div
          className={styles.dropZone}
          data-file-drop-zone=""
          data-active={dragging || over ? '' : undefined}
          onDragOver={onDragOver}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
        >
          <span>{m.compare_drop_hint()}</span>
          <button
            type="button"
            className={`${toolStyles.secondary} ${styles.fileButton}`}
            onClick={() => void pickFiles('pdf').then(addSecondFile)}
          >
            <FolderOpen aria-hidden="true" className={styles.buttonIcon} />
            {m.compare_open_file()}
          </button>
        </div>
        <fieldset className={toolStyles.fieldset}>
          <legend className={toolStyles.legend}>{m.compare_align_label()}</legend>
          <div className={styles.presets3}>
            {ALIGNMENTS.map((option) => (
              <label key={option.id} className={toolStyles.preset}>
                <input
                  type="radio"
                  name={alignName}
                  value={option.id}
                  checked={alignment === option.id}
                  onChange={() => set({ alignment: option.id })}
                />
                <span className={toolStyles.presetName}>{option.label()}</span>
                <span className={toolStyles.hint}>{option.hint()}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className={toolStyles.fieldset}>
          <legend className={toolStyles.legend}>{m.compare_dpi_label()}</legend>
          <div className={toolStyles.row}>
            {RESOLUTIONS.map((value) => (
              <label key={value} className={toolStyles.check}>
                <input
                  type="radio"
                  name={dpiName}
                  value={value}
                  checked={dpi === value}
                  onChange={() => set({ dpi: value })}
                />
                <span>{m.compare_dpi_value({ dpi: value })}</span>
              </label>
            ))}
          </div>
          <span className={toolStyles.hint}>{m.compare_dpi_hint()}</span>
        </fieldset>
        <p className={styles.note}>{m.compare_note_export()}</p>
        {error ? (
          <p className={toolStyles.error} role="alert">
            {error}
          </p>
        ) : null}
        <div className={toolStyles.actions}>
          <span className={toolStyles.spacer} />
          <button type="submit" className={toolStyles.primary} disabled={!ready}>
            {m.compare_run()}
          </button>
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

interface Marker {
  readonly id: string;
  readonly rects: readonly { x: number; y: number; width: number; height: number }[];
}

/** Text-change boxes per page-map row and side (removed and changed words on A, new on B). */
function textMarkers(
  changes: readonly TextChange[],
  pairs: readonly PagePair[],
): Map<number, { a: Marker[]; b: Marker[] }> {
  const rows = rowIndex(pairs);
  const out = new Map<number, { a: Marker[]; b: Marker[] }>();
  const at = (row: number) => {
    let entry = out.get(row);
    if (!entry) {
      entry = { a: [], b: [] };
      out.set(row, entry);
    }
    return entry;
  };
  changes.forEach((change, k) => {
    const id = `text:${k}`;
    if (change.a) {
      const row = rows.a.get(change.a.page);
      if (row !== undefined) at(row).a.push({ id, rects: change.a.rects });
    }
    if (change.b) {
      const row = rows.b.get(change.b.page);
      if (row !== undefined) at(row).b.push({ id, rects: change.b.rects });
    }
  });
  return out;
}

function useViewportSize(ref: RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () =>
      setSize((s) =>
        s.width === element.clientWidth && s.height === element.clientHeight
          ? s
          : { width: element.clientWidth, height: element.clientHeight },
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

function CompareResults() {
  const status = useCompareStore((s) => s.status);
  const sides = useCompareStore((s) => s.sides);
  const pairs = useCompareStore((s) => s.pairs);
  const visuals = useCompareStore((s) => s.visuals);
  const result = useCompareStore((s) => s.result);
  const mode = useCompareStore((s) => s.layout);
  const reveal = useCompareStore((s) => s.reveal);
  const stale = useCompareStore((s) => s.stale);
  const zoom = useUiStore((s) => s.zoom);
  const fitMode = useUiStore((s) => s.fitMode);
  const viewportRef = useRef<HTMLDivElement>(null);
  const viewport = useViewportSize(viewportRef);
  const [scrollTop, setScrollTop] = useState(0);

  const sizes = useMemo(
    () => (pairs && sides ? rowSizes(pairs, sides.a.pages, sides.b.pages) : []),
    [pairs, sides],
  );
  const fitted =
    fitMode === 'page'
      ? fitPageScale(sizes, mode, viewport.width, viewport.height)
      : fitScale(sizes, mode, viewport.width);
  const scale = fitMode === null ? zoom * CSS_PX_PER_PT : fitted;
  const layout = useMemo(() => layoutRows(sizes, mode, scale), [sizes, mode, scale]);

  // Zoom and layout changes keep the row at the top of the viewport where it was.
  const anchored = useRef<{
    layout: RowsLayout;
    row: number;
    within: number;
    before: number;
  } | null>(null);
  useLayoutEffect(() => {
    const element = viewportRef.current;
    const previous = anchored.current;
    if (
      element &&
      previous &&
      previous.layout !== layout &&
      previous.layout.tops.length > 0 &&
      layout.tops.length > 0
    ) {
      const row = Math.min(previous.row, layout.tops.length - 1);
      const top =
        (layout.tops[row] ?? 0) + previous.before + previous.within * (layout.heights[row] ?? 0);
      element.scrollTop = Math.max(0, top - LAYOUT.header);
      setScrollTop(element.scrollTop);
    }
  }, [layout]);
  useEffect(() => {
    const at = scrollTop + LAYOUT.header;
    const { first } = visibleRows(layout, at, 1);
    const height = layout.heights[first] ?? 0;
    const offset = at - (layout.tops[first] ?? 0);
    const within = height > 0 ? Math.min(1, Math.max(0, offset / height)) : 0;
    // Above the row (its gap or the top padding): kept in CSS px.
    anchored.current = { layout, row: first, within, before: Math.min(0, offset) };
  }, [layout, scrollTop]);

  // Keep the shell's zoom (status bar, zoom commands) in step with a fitted scale.
  useEffect(() => {
    if (fitMode !== null && viewport.width > 0 && sizes.length > 0) {
      useUiStore.getState().applyFitZoom(fitted / CSS_PX_PER_PT);
    }
  }, [fitMode, fitted, viewport.width, sizes.length]);

  // The first row in view: the visual diff starts there on the next run.
  const inView = visibleRows(layout, scrollTop + LAYOUT.header, Math.max(1, viewport.height));
  useEffect(() => {
    useCompareStore.setState((s) =>
      s.visibleRow === inView.first ? s : { visibleRow: inView.first },
    );
  }, [inView.first]);

  // Bring a revealed change into view.
  const lastReveal = useRef(0);
  useEffect(() => {
    const element = viewportRef.current;
    if (!reveal || !element || !pairs || !sides || reveal.serial === lastReveal.current) return;
    if (viewport.height === 0) return;
    lastReveal.current = reveal.serial;
    const pair = pairs[reveal.row];
    const index = reveal.side === 'a' ? pair?.a : pair?.b;
    const page = index === undefined ? undefined : sides[reveal.side].pages[index];
    element.scrollTop = revealScrollTop({
      layout,
      mode,
      row: reveal.row,
      side: reveal.side,
      page,
      rect: reveal.rect,
      scrollTop: element.scrollTop,
      viewportHeight: element.clientHeight,
    });
    setScrollTop(element.scrollTop);
  }, [reveal, layout, mode, pairs, sides, viewport.height]);

  const markers = useMemo(
    () =>
      result && pairs
        ? textMarkers(result.text.changes, pairs)
        : new Map<number, { a: Marker[]; b: Marker[] }>(),
    [result, pairs],
  );
  const list = useMemo(
    () =>
      result ? buildChangeList(result) : pairs ? buildPartialChangeList(pairs, visuals) : null,
    [result, pairs, visuals],
  );

  const range = visibleRows(
    layout,
    Math.max(0, scrollTop - OVERSCAN_PX),
    viewport.height + 2 * OVERSCAN_PX,
  );
  const rows: number[] = [];
  if (pairs && sides) for (let row = range.first; row <= range.last; row++) rows.push(row);

  return (
    <div
      className={styles.results}
      data-testid="compare-view"
      data-status={status}
      data-stale={stale ? '' : undefined}
    >
      <div className={styles.bar}>
        {pairs && sides ? <PageMapStrip pairs={pairs} firstInView={inView.first} /> : null}
        <button
          type="button"
          className={`${toolStyles.secondary} ${styles.newButton}`}
          onClick={() => void releaseCompare()}
        >
          {m.compare_new()}
        </button>
      </div>
      {stale ? (
        <div className={styles.stale} data-testid="compare-stale">
          <span>{m.compare_stale()}</span>
          <button
            type="button"
            className={toolStyles.secondary}
            onClick={() => void startCompare()}
          >
            {m.compare_run_again()}
          </button>
        </div>
      ) : null}
      <div
        ref={viewportRef}
        className={styles.viewport}
        data-compare-viewport=""
        aria-busy={status !== 'done'}
        // Focusable by script (reveal, Esc); the browser scrolls it with the keyboard.
        tabIndex={-1}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        {pairs && sides ? (
          <div
            className={styles.canvas}
            style={{
              height: layout.contentHeight,
              width: Math.max(layout.contentWidth, viewport.width),
            }}
          >
            <ColumnHeader sides={sides} layout={layout} mode={mode} />
            {rows.map((row) => (
              <CompareRow
                key={row}
                row={row}
                pair={pairs[row] as PagePair}
                sides={sides}
                layout={layout}
                mode={mode}
                visual={visuals[row]}
                markers={markers.get(row)}
                status={rowStatus(row, pairs, visuals, result)}
              />
            ))}
          </div>
        ) : null}
      </div>
      {status === 'preparing' || status === 'running' ? <ProgressCard centred={!pairs} /> : null}
      {pairs && sides ? <CompareToolbar scale={scale} changes={list?.flat.length ?? 0} /> : null}
    </div>
  );
}

const STATUS_GLYPH = {
  identical: '=',
  changed: '~',
  inserted: '+',
  deleted: '−',
  pending: '·',
} as const;

function statusWord(status: keyof typeof STATUS_GLYPH): string {
  switch (status) {
    case 'identical':
      return m.compare_status_identical();
    case 'changed':
      return m.compare_status_changed();
    case 'inserted':
      return m.compare_status_inserted();
    case 'deleted':
      return m.compare_status_deleted();
    case 'pending':
      return m.compare_status_pending();
  }
}

function PageMapStrip({
  pairs,
  firstInView,
}: {
  readonly pairs: readonly PagePair[];
  readonly firstInView: number;
}) {
  const visuals = useCompareStore((s) => s.visuals);
  const result = useCompareStore((s) => s.result);
  return (
    <nav className={styles.strip} aria-label={m.compare_page_map()} data-testid="compare-page-map">
      <ol className={styles.stripList}>
        {pairs.map((pair, row) => {
          const status = rowStatus(row, pairs, visuals, result);
          return (
            <li key={row}>
              <button
                type="button"
                className={styles.stripCell}
                data-status={status}
                aria-current={row === firstInView ? 'true' : undefined}
                aria-label={`${rowLabel(pair)}: ${statusWord(status)}`}
                title={`${rowLabel(pair)}: ${statusWord(status)}`}
                onClick={() => requestReveal({ row, side: pair.b === undefined ? 'a' : 'b' })}
              >
                <span aria-hidden="true">{STATUS_GLYPH[status]}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function ColumnHeader({
  sides,
  layout,
  mode,
}: {
  readonly sides: { readonly a: CompareSideView; readonly b: CompareSideView };
  readonly layout: RowsLayout;
  readonly mode: CompareLayout;
}) {
  const style = (side: 'a' | 'b') => ({
    left:
      LAYOUT.padX + (mode === 'side' && side === 'b' ? layout.columnWidth + LAYOUT.columnGap : 0),
    width: layout.columnWidth,
  });
  return (
    <div className={styles.columnHeader} style={{ height: LAYOUT.header }}>
      {mode === 'side' ? (
        <>
          <span className={styles.columnName} style={style('a')}>
            <span className={styles.sideTag}>A</span>
            {sides.a.name}
          </span>
          <span className={styles.columnName} style={style('b')}>
            <span className={styles.sideTag}>B</span>
            {sides.b.name}
          </span>
        </>
      ) : (
        <span className={styles.columnName} style={{ ...style('a'), width: undefined }}>
          {m.compare_overlay_header({ a: sides.a.name, b: sides.b.name })}
        </span>
      )}
    </div>
  );
}

function CompareRow({
  row,
  pair,
  sides,
  layout,
  mode,
  visual,
  markers,
  status,
}: {
  readonly row: number;
  readonly pair: PagePair;
  readonly sides: { readonly a: CompareSideView; readonly b: CompareSideView };
  readonly layout: RowsLayout;
  readonly mode: CompareLayout;
  readonly visual: PixelDiffResult | undefined;
  readonly markers: { a: Marker[]; b: Marker[] } | undefined;
  readonly status: keyof typeof STATUS_GLYPH;
}) {
  const opacity = useCompareStore((s) => s.opacity);
  const heatmap = useCompareStore((s) => s.heatmap);
  const done = useCompareStore((s) => s.status === 'done');
  // Changed areas light up while their Changes item is the current one.
  const regionsCurrent = useCompareStore((s) => s.current === `visual:${row}`);
  const pageA = pair.a === undefined ? undefined : sides.a.pages[pair.a];
  const pageB = pair.b === undefined ? undefined : sides.b.pages[pair.b];
  const top = layout.tops[row] ?? 0;
  const height = layout.heights[row] ?? 0;
  const showHeat = heatmap && done && visual?.heatmapId !== undefined;
  return (
    <div
      className={styles.row}
      style={{ top, height, width: layout.contentWidth }}
      data-row={row}
      data-status={status}
      data-testid="compare-row"
    >
      <div className={styles.rowLabel} style={{ left: LAYOUT.padX }}>
        <span className={styles.rowGlyph} aria-hidden="true">
          {STATUS_GLYPH[status]}
        </span>
        <span>{rowLabel(pair)}</span>
        <span className={styles.rowStatus}>{statusWord(status)}</span>
      </div>
      {pageA ? (
        <Sheet
          side="a"
          page={pageA}
          name={sides.a.name}
          layout={layout}
          mode={mode}
          regions={visual?.regionsA}
          regionsCurrent={regionsCurrent}
          markers={markers?.a}
        />
      ) : (
        <Missing side="a" other={pageB} layout={layout} mode={mode} />
      )}
      {pageB ? (
        <Sheet
          side="b"
          page={pageB}
          name={sides.b.name}
          layout={layout}
          mode={mode}
          regions={showHeat ? undefined : visual?.regions}
          regionsCurrent={regionsCurrent}
          markers={markers?.b}
          opacity={mode === 'overlay' && pageA ? opacity : 1}
        >
          {showHeat && visual?.heatmapId ? (
            <Heatmap id={visual.heatmapId} visual={visual} scale={layout.scale} />
          ) : null}
        </Sheet>
      ) : mode === 'side' ? (
        <Missing side="b" other={pageA} layout={layout} mode={mode} />
      ) : null}
    </div>
  );
}

function Missing({
  side,
  other,
  layout,
  mode,
}: {
  readonly side: 'a' | 'b';
  readonly other: SidePage | undefined;
  readonly layout: RowsLayout;
  readonly mode: CompareLayout;
}) {
  if (!other) return null;
  const box = sheetBox(layout, mode, side, other);
  return (
    <div
      className={styles.missing}
      style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
    >
      {side === 'a' ? m.compare_missing_in_a() : m.compare_missing_in_b()}
    </div>
  );
}

function Sheet({
  side,
  page,
  name,
  layout,
  mode,
  regions,
  markers,
  opacity = 1,
  children,
  regionsCurrent = false,
}: {
  readonly side: 'a' | 'b';
  readonly page: SidePage;
  readonly name: string;
  readonly layout: RowsLayout;
  readonly mode: CompareLayout;
  readonly regions: PixelDiffResult['regions'] | undefined;
  readonly markers: readonly Marker[] | undefined;
  readonly opacity?: number;
  readonly children?: ReactNode;
  readonly regionsCurrent?: boolean;
}) {
  const current = useCompareStore((s) => s.current);
  const box = sheetBox(layout, mode, side, page);
  const display = displayedPageSize(page);
  const frame = sideFrame(page, layout.scale);
  return (
    <div
      className={styles.sheet}
      data-side={side}
      role="img"
      aria-label={m.compare_page_label({ page: page.index + 1, name })}
      style={{
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height,
        ...(opacity < 1 ? { opacity } : {}),
      }}
    >
      <PageCanvas
        sourceId={page.sourceId}
        index={page.index}
        rotation={page.delta}
        widthPt={display.width}
        heightPt={display.height}
        cssWidth={box.width}
        priority={RENDER_PRIORITY.visible}
        delayMs={ZOOM_RENDER_DELAY_MS}
      />
      {regions?.map((rect, i) => {
        const r = userRectToCss(frame, rect);
        return (
          <span
            key={`r${i}`}
            className={styles.region}
            data-current={regionsCurrent ? '' : undefined}
            style={{ left: r.left, top: r.top, width: r.width, height: r.height }}
          />
        );
      })}
      {markers?.flatMap((marker) =>
        marker.rects.map((rect, i) => {
          const r = userRectToCss(frame, rect);
          return (
            <span
              key={`${marker.id}:${i}`}
              className={styles.word}
              data-change={marker.id}
              data-current={current === marker.id ? '' : undefined}
              style={{ left: r.left, top: r.top, width: r.width, height: r.height }}
            />
          );
        }),
      )}
      {children}
    </div>
  );
}

function Heatmap({
  id,
  visual,
  scale,
}: {
  readonly id: string;
  readonly visual: PixelDiffResult;
  readonly scale: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const size = heatmapCss(visual, scale);
  useEffect(() => {
    let cancelled = false;
    void heatmapBitmap(id).then((bitmap) => {
      const canvas = ref.current;
      if (cancelled || !canvas || !bitmap || bitmap.width === 0) return;
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
      canvas.dataset.state = 'rendered';
    });
    return () => {
      cancelled = true;
    };
  }, [id]);
  return (
    <canvas
      ref={ref}
      className={styles.heatmap}
      data-testid="compare-heatmap"
      aria-hidden="true"
      style={{ width: size.width, height: size.height }}
    />
  );
}

// ---------------------------------------------------------------------------
// Progress and tool bar
// ---------------------------------------------------------------------------

function phaseLabel(phase: string): string {
  switch (phase) {
    case 'text':
      return m.compare_phase_text();
    case 'thumbnails':
      return m.compare_phase_thumbnails();
    case 'align':
      return m.compare_phase_align();
    case 'visual':
      return m.compare_phase_visual();
    case 'text-diff':
      return m.compare_phase_text_diff();
    default:
      return m.compare_phase_facts();
  }
}

function ProgressCard({ centred }: { readonly centred: boolean }) {
  const status = useCompareStore((s) => s.status);
  const progress = useCompareStore((s) => s.progress);
  const label =
    status === 'preparing' || !progress
      ? m.compare_preparing()
      : m.compare_progress({
          phase: phaseLabel(progress.phase),
          total: progress.total,
          doneText: formatNumber(progress.done),
          totalText: formatNumber(progress.total),
        });
  return (
    <div className={styles.progress} data-centred={centred ? '' : undefined}>
      <p className={styles.progressLabel} role="status" data-testid="compare-progress">
        {label}
      </p>
      <progress
        className={toolStyles.progress}
        max={Math.max(1, progress?.total ?? 1)}
        value={progress?.done ?? 0}
        aria-label={m.compare_progress_label()}
      />
      <button type="button" className={styles.glassButton} onClick={cancelCompare}>
        {m.common_cancel()}
      </button>
    </div>
  );
}

const LAYOUTS: readonly { id: CompareLayout; label: () => string; Icon: typeof Columns2 }[] = [
  { id: 'side', label: m.compare_layout_side, Icon: Columns2 },
  { id: 'overlay', label: m.compare_layout_overlay, Icon: Layers },
];

function CompareToolbar({ scale, changes }: { readonly scale: number; readonly changes: number }) {
  const mode = useCompareStore((s) => s.layout);
  const opacity = useCompareStore((s) => s.opacity);
  const heatmap = useCompareStore((s) => s.heatmap);
  const status = useCompareStore((s) => s.status);
  const hasHeat = useCompareStore((s) =>
    Object.values(s.visuals).some((v) => v.heatmapId !== undefined),
  );
  const ui = useUiStore.getState;
  const nextShortcut = useCommandShortcut('compare.next');
  const previousShortcut = useCommandShortcut('compare.previous');
  const zoomInShortcut = useCommandShortcut('zoom.in');
  const zoomOutShortcut = useCommandShortcut('zoom.out');
  const fitShortcut = useCommandShortcut('zoom.fit');
  const done = status === 'done';
  const opacityId = useId();

  const onLayoutKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const next: CompareLayout = mode === 'side' ? 'overlay' : 'side';
    useCompareStore.setState({ layout: next });
    event.currentTarget.parentElement
      ?.querySelector<HTMLElement>(`[data-layout="${next}"]`)
      ?.focus();
  };

  return (
    <div className={styles.toolbar} role="toolbar" aria-label={m.compare_toolbar_label()}>
      <div role="radiogroup" aria-label={m.compare_layout_label()} className={styles.segments}>
        {LAYOUTS.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={mode === id}
            tabIndex={mode === id ? 0 : -1}
            data-layout={id}
            className={styles.segment}
            onKeyDown={onLayoutKey}
            onClick={() => useCompareStore.setState({ layout: id })}
          >
            <Icon aria-hidden="true" className={styles.segmentIcon} />
            {label()}
          </button>
        ))}
      </div>
      {mode === 'overlay' ? (
        <label className={styles.slider} htmlFor={opacityId}>
          <span>{m.compare_opacity()}</span>
          <Range
            id={opacityId}
            className={styles.range}
            min={0}
            max={100}
            step={5}
            value={Math.round(opacity * 100)}
            aria-valuetext={formatPercent(opacity)}
            onChange={(event) =>
              useCompareStore.setState({ opacity: Number(event.target.value) / 100 })
            }
          />
        </label>
      ) : null}
      <span className={styles.divider} aria-hidden="true" />
      <IconButton
        label={m.compare_heatmap()}
        tooltip={done ? m.compare_heatmap() : m.compare_heatmap_pending()}
        icon={<Flame />}
        size="toolbar"
        aria-pressed={heatmap}
        aria-disabled={!done || !hasHeat ? 'true' : undefined}
        data-testid="compare-heatmap-toggle"
        onClick={() => {
          if (done && hasHeat) useCompareStore.setState({ heatmap: !heatmap });
        }}
      />
      <span className={styles.divider} aria-hidden="true" />
      <IconButton
        label={m.cmd_zoom_out()}
        icon={<ZoomOut />}
        size="toolbar"
        shortcut={zoomOutShortcut}
        onClick={() => ui().zoomOut()}
      />
      <span className={styles.zoom} aria-live="off">
        {formatPercent(scale / CSS_PX_PER_PT)}
      </span>
      <IconButton
        label={m.cmd_zoom_in()}
        icon={<ZoomIn />}
        size="toolbar"
        shortcut={zoomInShortcut}
        onClick={() => ui().zoomIn()}
      />
      <IconButton
        label={m.cmd_zoom_fit()}
        icon={<Maximize2 />}
        size="toolbar"
        shortcut={fitShortcut}
        onClick={() => ui().zoomFit()}
      />
      <span className={styles.divider} aria-hidden="true" />
      <IconButton
        label={m.cmd_compare_previous()}
        icon={<ChevronUp />}
        size="toolbar"
        shortcut={previousShortcut}
        aria-disabled={changes === 0 ? 'true' : undefined}
        onClick={() => stepChanges(-1)}
      />
      <IconButton
        label={m.cmd_compare_next()}
        icon={<ChevronDown />}
        size="toolbar"
        shortcut={nextShortcut}
        aria-disabled={changes === 0 ? 'true' : undefined}
        onClick={() => stepChanges(1)}
      />
      <span className={styles.divider} aria-hidden="true" />
      <IconButton
        label={m.compare_run_again()}
        icon={<RefreshCw />}
        size="toolbar"
        aria-disabled={done ? undefined : 'true'}
        onClick={() => {
          if (done) void startCompare();
        }}
      />
    </div>
  );
}
