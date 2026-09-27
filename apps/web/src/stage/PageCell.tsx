/**
 * One light-table cell. Props are primitives so `memo` skips every cell a model change does
 * not affect (spec §7: a drop re-renders only the affected cells); selection, drag and
 * clipboard state come from per-cell store selectors for the same reason.
 *
 * The hover action row (rotate, delete) lives in the reserved label gutter and only
 * toggles visibility, so nothing moves on hover (spec §4). It is a pointer affordance:
 * keyboard users have R / Shift+R and Delete, so the actions are hidden from assistive
 * tech and never focusable.
 */
import type { DocumentId, PageId, Rotation, SourceId } from '@pdf-editor/document-model';
import { Bookmark, RotateCw, Trash2 } from 'lucide-react';
import {
  memo,
  Profiler,
  type ProfilerOnRenderCallback,
  type ReactNode,
  useEffect,
  useRef,
} from 'react';

import { useDragSession } from '../dnd/drag-store';
import { attachPageDrag } from '../dnd/page-drag';
import { RENDER_PRIORITY } from '../engine/engine-service';
import { PageCanvas } from '../pages/PageCanvas';
import { rotationPhrase } from '../pages/page-geometry';
import { announce } from '../shell/announcer';
import { useSelectionStore } from '../state/selection-store';
import { pagesPhrase, useWorkspaceStore } from '../state/workspace-store';
import styles from './ArrangeView.module.css';

export interface PageCellProps {
  readonly pageId: PageId;
  readonly documentId: DocumentId;
  readonly index: number;
  readonly count: number;
  readonly column: number;
  readonly label: string;
  readonly sourceId: SourceId | undefined;
  readonly sourceIndex: number;
  readonly sourceName: string | undefined;
  readonly colorIndex: number;
  /** VirtualPage.rotation (on top of the intrinsic /Rotate). */
  readonly rotation: Rotation;
  /** Total displayed rotation, for the label. */
  readonly totalRotation: number;
  readonly widthPt: number;
  readonly heightPt: number;
  readonly thumbWidth: number;
  readonly thumbHeight: number;
  readonly cellWidth: number;
  readonly boxHeight: number;
  readonly outlined: boolean;
  readonly tabbable: boolean;
  readonly visible: boolean;
}

/** Cell render counts in development (profiling hook for tests and perf checks). */
export const cellRenderStats = { renders: 0, byPage: new Map<string, number>() };

const onCellRender: ProfilerOnRenderCallback = (id, phase) => {
  if (phase === 'nested-update') return;
  cellRenderStats.renders += 1;
  cellRenderStats.byPage.set(id, (cellRenderStats.byPage.get(id) ?? 0) + 1);
};

function Profiled({ id, children }: { readonly id: string; readonly children: ReactNode }) {
  return import.meta.env.DEV ? (
    <Profiler id={id} onRender={onCellRender}>
      {children}
    </Profiler>
  ) : (
    children
  );
}

export const PageCell = memo(function PageCell(props: PageCellProps) {
  return (
    <Profiled id={props.pageId}>
      <PageCellInner {...props} />
    </Profiled>
  );
});

function PageCellInner({
  pageId,
  documentId,
  index,
  count,
  column,
  label,
  sourceId,
  sourceIndex,
  sourceName,
  colorIndex,
  rotation,
  totalRotation,
  widthPt,
  heightPt,
  thumbWidth,
  thumbHeight,
  cellWidth,
  boxHeight,
  outlined,
  tabbable,
  visible,
}: PageCellProps) {
  const ref = useRef<HTMLDivElement>(null);
  const selected = useSelectionStore((s) => s.selected.has(pageId));
  const focused = useSelectionStore((s) => s.focused === pageId);
  const cut = useSelectionStore(
    (s) => s.clipboard?.mode === 'cut' && s.clipboard.pageIds.includes(pageId),
  );
  const dragging = useDragSession((s) => s.session?.pageIds.has(pageId) ?? false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return attachPageDrag(el, pageId);
  }, [pageId]);

  const position = String(index + 1);
  const labelText = label === position ? `Page ${position}` : `Page ${position} (${label})`;
  const name = `${labelText} of ${count}${sourceName ? `, from ${sourceName}` : ''}${rotationPhrase(totalRotation)}${outlined ? ', bookmarked' : ''}`;

  const rotate = () => {
    if (useWorkspaceStore.getState().rotatePages([pageId], 90)) {
      announce(`Rotated ${pagesPhrase(1)} right`);
    }
  };
  const remove = () => {
    if (useWorkspaceStore.getState().deletePages([pageId])) announce(`Deleted ${labelText}`);
  };

  return (
    <div
      ref={ref}
      role="gridcell"
      aria-colindex={column + 1}
      aria-selected={selected}
      aria-label={name}
      tabIndex={tabbable ? 0 : -1}
      data-page-id={pageId}
      data-document-id={documentId}
      data-focused={focused || undefined}
      data-dragging={dragging || undefined}
      data-cut={cut || undefined}
      data-tag={colorIndex}
      className={styles.cell}
      style={{ width: cellWidth }}
    >
      <div className={styles.box} style={{ height: boxHeight }}>
        <div
          className={styles.thumbSheet}
          data-thumb=""
          style={{ width: thumbWidth, height: thumbHeight }}
        >
          <PageCanvas
            sourceId={sourceId}
            index={sourceIndex}
            rotation={rotation}
            widthPt={widthPt}
            heightPt={heightPt}
            cssWidth={thumbWidth}
            priority={visible ? RENDER_PRIORITY.visible : RENDER_PRIORITY.offscreen}
          />
        </div>
      </div>
      <div className={styles.meta} aria-hidden="true">
        <span className={styles.label}>{label}</span>
        {outlined ? <Bookmark className={styles.outlineGlyph} /> : null}
        <span className={styles.hoverActions} data-hover-actions="">
          <span
            className={styles.hoverAction}
            aria-hidden="true"
            title="Rotate right"
            onClick={(event) => {
              event.stopPropagation();
              rotate();
            }}
          >
            <RotateCw />
          </span>
          <span
            className={styles.hoverAction}
            aria-hidden="true"
            title="Delete"
            onClick={(event) => {
              event.stopPropagation();
              remove();
            }}
          >
            <Trash2 />
          </span>
        </span>
      </div>
    </div>
  );
}
