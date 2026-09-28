/**
 * The crop drawing layer: a page overlay in Read mode that exists only while "Crop
 * pages…" is drawing (crop-store.ts). It takes every page above the other layers; a drag
 * draws the crop rectangle, and releasing it hands the rectangle (through the page frame,
 * so in unrotated user space whatever the rotation, resize or existing crop) back to the
 * dialog. Esc (actions.ts) or the banner's Cancel ends the drawing without a rectangle.
 */
import { type PointerEvent as ReactPointerEvent, useRef, useState } from 'react';

import { type Box, cssBoxToUser } from '../annotations/geometry';
import { m } from '../i18n';
import type { PageOverlayProps } from '../stage/page-overlays';
import { displayedSize } from '../viewer/geometry';
import { pageFrame } from '../viewer/page-frame';
import { cancelCropDrawing, finishCropDrawing } from './actions';
import styles from './Crop.module.css';
import { useCropStore } from './crop-store';

/** A drag shorter than this (CSS px) in either direction is a click, not a rectangle. */
const MIN_DRAG_PX = 4;

interface Drag {
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
}

export function CropLayer(props: PageOverlayProps) {
  const drawing = useCropStore((s) => s.drawing !== null);
  const [box, setBox] = useState<Box | null>(null);
  const drag = useRef<Drag | null>(null);
  if (!drawing) return null;

  const frame = pageFrame(props);
  const shown = displayedSize(frame);
  const limit = { width: shown.width * frame.scale, height: shown.height * frame.scale };
  const at = (event: ReactPointerEvent<HTMLDivElement>) => {
    const r = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.min(Math.max(event.clientX - r.left, 0), limit.width),
      y: Math.min(Math.max(event.clientY - r.top, 0), limit.height),
    };
  };
  const spanned = (a: { x: number; y: number }, b: { x: number; y: number }): Box => ({
    left: Math.min(a.x, b.x),
    top: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  });

  return (
    <div
      className={styles.layer}
      data-crop-layer={props.pageIndex}
      role="group"
      aria-label={m.crop_draw_layer({ page: props.pageIndex + 1 })}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        const p = at(event);
        drag.current = { pointerId: event.pointerId, ...p };
        setBox({ left: p.x, top: p.y, width: 0, height: 0 });
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (start?.pointerId !== event.pointerId) return;
        setBox(spanned(start, at(event)));
      }}
      onPointerUp={(event) => {
        const start = drag.current;
        if (start?.pointerId !== event.pointerId) return;
        drag.current = null;
        const drawn = spanned(start, at(event));
        setBox(null);
        if (drawn.width < MIN_DRAG_PX || drawn.height < MIN_DRAG_PX) return;
        finishCropDrawing(props.pageId, cssBoxToUser(frame, drawn));
      }}
      onPointerCancel={() => {
        drag.current = null;
        setBox(null);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        cancelCropDrawing();
      }}
    >
      {box === null ? null : (
        <div
          className={styles.drawn}
          data-testid="crop-drawn"
          style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
        />
      )}
    </div>
  );
}
