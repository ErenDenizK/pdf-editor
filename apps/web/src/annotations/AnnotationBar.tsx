/**
 * Contextual bar above the selected annotations (spec §2): replaces property dialogs.
 * One Tab stop per control group; Escape (the global command) deselects.
 */
import type { Annotation } from '@pdf-editor/engine';
import { Lock } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';

import { m } from '../i18n';
import type { PageTarget } from './annotation-store';
import { displayRect, type PageFrame, rectToCss } from './geometry';
import { annotationName, capitalize } from './labels';
import styles from './AnnotationLayer.module.css';
import { StyleControls } from './StyleControls';

const BAR_HEIGHT = 40;
/** Width assumed before the bar has been measured. */
const INITIAL_WIDTH = 480;

export function AnnotationBar({
  target,
  annotations,
  frame,
}: {
  readonly target: PageTarget;
  readonly annotations: readonly Annotation[];
  readonly frame: PageFrame;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(INITIAL_WIDTH);
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
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  for (const a of annotations) {
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
  const locked = annotations.every((a) => a.flags?.locked);
  const name =
    annotations.length === 1 && first
      ? capitalize(annotationName(first))
      : m.annot_count({ count: annotations.length });
  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label={m.annot_bar_label({ name })}
      className={styles.bar}
      data-testid="annotation-bar"
      data-annotation-keep=""
      style={{ left: x, top: y }}
      onPointerDown={(e) => e.stopPropagation()}
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
          <StyleControls target={target} annotations={annotations} variant="bar" />
        </>
      )}
    </div>
  );
}
