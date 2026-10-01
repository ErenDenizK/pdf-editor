/**
 * Contextual bar above the selected annotations (spec §2): replaces property dialogs.
 * A toolbar with one Tab stop and a roving tabindex, as the tool bar (DESIGN.md §5):
 * Left / Right move between its controls, Home / End to the ends; Escape (the global
 * command) deselects.
 *
 * For a lasso selection (`paths`, experience-redesign spec §6.5) it sits above the taken
 * paths rather than the whole annotations, names the stroke count and shows the lasso's
 * controls (`lasso/LassoSelection.tsx`): colour, opacity, width, a move grip and Delete.
 */
import type { Annotation } from '@pdf-editor/engine';
import { Lock } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';

import { m } from '../i18n';
import { useRovingTabindex } from '../shell/FloatingToolbar.roving';
import { useFocusRescue } from '../ui/use-focus-rescue';
import type { PageTarget } from './annotation-store';
import { displayRect, type PageFrame, rectToCss } from './geometry';
import { annotationName, capitalize } from './labels';
import { type PathPicks, pickCount, pickedCssBounds } from './lasso/geometry';
import { LassoBarControls } from './lasso/LassoSelection';
import styles from './AnnotationLayer.module.css';
import { StyleControls } from './StyleControls';

/** Esc or Delete from the bar: focus stays on the page rather than falling to <body>. */
const pageViewport = (bar: HTMLElement) => bar.closest<HTMLElement>('[data-read-viewport]');

const BAR_HEIGHT = 40;
/** Width assumed before the bar has been measured. */
const INITIAL_WIDTH = 480;

export function AnnotationBar({
  target,
  annotations,
  frame,
  paths,
}: {
  readonly target: PageTarget;
  readonly annotations: readonly Annotation[];
  readonly frame: PageFrame;
  /** The lasso's taken paths: the bar is about them (spec §6.5). */
  readonly paths?: PathPicks;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(INITIAL_WIDTH);
  const roving = useRovingTabindex(ref);
  useFocusRescue(ref, pageViewport);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      if (element.offsetWidth > 0) setWidth(element.offsetWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // The lasso's taken paths.
  const pathBox = paths ? pickedCssBounds(frame, annotations, paths) : null;
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  if (pathBox) {
    top = pathBox.top;
    bottom = pathBox.top + pathBox.height;
    left = pathBox.left;
    right = pathBox.left + pathBox.width;
  }
  for (const a of pathBox ? [] : annotations) {
    const box = rectToCss(frame, displayRect(frame, a));
    top = Math.min(top, box.top);
    bottom = Math.max(bottom, box.top + box.height);
    left = Math.min(left, box.left);
    right = Math.max(right, box.left + box.width);
  }
  const pageWidth =
    (frame.rotation === 90 || frame.rotation === 270 ? frame.size.height : frame.size.width) *
    frame.scale;
  // Above the selection; below it when the selection touches the top of the page.
  const y = top - BAR_HEIGHT - 12 >= -BAR_HEIGHT ? top - BAR_HEIGHT - 12 : bottom + 12;
  // Centred on the selection, kept within the page (the stage clips beyond it).
  const x =
    width >= pageWidth
      ? (pageWidth - width) / 2
      : Math.min(Math.max((left + right) / 2 - width / 2, 0), pageWidth - width);
  const first = annotations[0];
  const locked = !paths && annotations.every((a) => a.flags?.locked);
  const name = paths
    ? m.lasso_strokes({ count: pickCount(paths) })
    : annotations.length === 1 && first
      ? capitalize(annotationName(first))
      : m.annot_count({ count: annotations.length });
  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label={m.annot_bar_label({ name })}
      className={styles.bar}
      data-testid="annotation-bar"
      data-lasso-bar={paths ? '' : undefined}
      data-annotation-keep=""
      style={{ left: x, top: y }}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={roving.onKeyDown}
      onFocus={roving.onFocus}
    >
      <span className={styles.barName}>{name}</span>
      {locked ? (
        <span className={styles.barLocked} title={m.annot_locked()}>
          <Lock aria-hidden="true" />
          {m.annot_locked_short()}
        </span>
      ) : (
        <>
          <span className={styles.barDivider} aria-hidden="true" />
          {paths ? (
            <LassoBarControls pageId={target.pageId} />
          ) : (
            <StyleControls target={target} annotations={annotations} variant="bar" />
          )}
        </>
      )}
    </div>
  );
}
