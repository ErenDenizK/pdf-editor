/**
 * The dry ink layer of one page (craft spec §5.3 item 7): a page overlay holding committed
 * pen strokes until the page bitmap shows them (`dry-ink.ts`). It sits over the page bitmap
 * and under the annotation layer (whose `z-index` puts its wet canvas above), and it is not
 * a stacking context, so the Highlighter's Multiply canvas blends with the bitmap. React
 * only mounts the element and passes the page frame; the strokes are drawn imperatively.
 *
 * Registered at module load (imported by `AnnotationLayer.tsx`), before the annotation
 * layer.
 */
import { useLayoutEffect, useRef } from 'react';

import { type PageOverlayProps, registerPageOverlay } from '../../stage/page-overlays';
import { pageFrame } from '../../viewer/page-frame';
import { DryInkView } from './dry-ink';

const STYLE = { position: 'absolute', inset: 0, pointerEvents: 'none' } as const;

export function DryInkLayer(props: PageOverlayProps) {
  const { sourceId, sourceIndex } = props;
  const ref = useRef<HTMLDivElement>(null);
  const viewRef = useRef<DryInkView | null>(null);
  const frame = sourceId === undefined ? null : pageFrame(props);

  // Every render: a zoom, rotation or page resize redraws the strokes for the new frame;
  // another page or element gets a view of its own.
  useLayoutEffect(() => {
    const element = ref.current;
    let view = viewRef.current;
    if (
      view &&
      (view.element !== element || view.source !== sourceId || view.pageIndex !== sourceIndex)
    ) {
      view.destroy();
      view = null;
      viewRef.current = null;
    }
    if (!element || !frame || sourceId === undefined) return;
    if (view) view.setFrame(frame);
    else viewRef.current = new DryInkView(element, sourceId, sourceIndex, frame);
  });

  useLayoutEffect(
    () => () => {
      viewRef.current?.destroy();
      viewRef.current = null;
    },
    [],
  );

  if (sourceId === undefined) return null;
  return <div ref={ref} style={STYLE} data-dry-ink="" aria-hidden="true" />;
}

DryInkLayer.displayName = 'DryInkLayer';

registerPageOverlay(DryInkLayer);
