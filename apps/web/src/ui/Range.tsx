/**
 * The app's range input (DESIGN.md §3, "Range"): a 2 px track whose filled part runs up to
 * the thumb and a small round thumb, styled in Range.module.css. The browser draws the
 * filled part itself in Firefox (`::-moz-range-progress`); Chromium and WebKit have no such
 * part, so the track paints it from `--fill`, the value's position along the range, which
 * this wrapper sets. Every other prop goes to the `<input type="range">` as is.
 */
import type { ComponentPropsWithRef, CSSProperties } from 'react';

import styles from './Range.module.css';

export type RangeProps = Omit<ComponentPropsWithRef<'input'>, 'type' | 'value' | 'min' | 'max'> & {
  readonly value: number;
  readonly min: number;
  readonly max: number;
};

/** Where `value` sits between `min` and `max`, as a CSS percentage (clamped). */
export function rangeFill(value: number, min: number, max: number): string {
  if (!(max > min) || !Number.isFinite(value)) return '0%';
  const ratio = Math.min(1, Math.max(0, (value - min) / (max - min)));
  return `${Math.round(ratio * 10_000) / 100}%`;
}

export function Range({ value, min, max, className, style, ...rest }: RangeProps) {
  return (
    <input
      type="range"
      className={[styles.range, className].filter(Boolean).join(' ')}
      min={min}
      max={max}
      value={value}
      style={{ ...style, '--fill': rangeFill(value, min, max) } as CSSProperties}
      {...rest}
    />
  );
}
