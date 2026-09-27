/*
 * A focusable `separator` is an interactive widget in WAI-ARIA 1.2 (the APG "Window
 * Splitter" pattern), but jsx-a11y classifies the role as static. Disabled for this file.
 */
/* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */
import { type KeyboardEvent, type PointerEvent, useRef } from 'react';

import styles from './ResizeHandle.module.css';

interface ResizeHandleProps {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  /** +1 when dragging right grows the panel (left panel), -1 when it shrinks it (right panel). */
  readonly direction: 1 | -1;
  readonly onChange: (value: number) => void;
  readonly controls: string;
}

const KEY_STEP = 16;

/**
 * A focusable window splitter (APG "Window Splitter" pattern): drag with a pointer, or
 * focus it and use Left/Right (16px), Home/End (min/max).
 */
export function ResizeHandle({
  label,
  value,
  min,
  max,
  direction,
  onChange,
  controls,
}: ResizeHandleProps) {
  const drag = useRef<{ startX: number; startValue: number } | null>(null);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startX: event.clientX, startValue: value };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    onChange(drag.current.startValue + (event.clientX - drag.current.startX) * direction);
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const grow = direction === 1 ? 'ArrowRight' : 'ArrowLeft';
    const shrink = direction === 1 ? 'ArrowLeft' : 'ArrowRight';
    let next: number | null = null;
    if (event.key === grow) next = value + KEY_STEP;
    else if (event.key === shrink) next = value - KEY_STEP;
    else if (event.key === 'Home') next = min;
    else if (event.key === 'End') next = max;
    if (next === null) return;
    event.preventDefault();
    onChange(next);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-controls={controls}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      className={styles.handle}
      data-direction={direction}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
    />
  );
}
