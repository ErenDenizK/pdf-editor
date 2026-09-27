/**
 * The controls shared by the contextual bar and the Properties panel (spec §2): colour
 * swatches (8 fixed + custom), opacity, stroke width, font size, comment, delete. Slider
 * changes coalesce into one history entry (800 ms window) and only the latest value of a
 * burst is sent to the engine.
 */
import type { Annotation } from '@pdf-editor/engine';
import { MessageSquare, Trash2 } from 'lucide-react';
import { type CSSProperties, useRef, useState } from 'react';

import { formatPercent, m } from '../i18n';
import { IconButton } from '../ui/IconButton';
import { deleteAnnotations, updateAnnotations } from './actions';
import { type PageTarget, SWATCHES, useAnnotationStore } from './annotation-store';
import { hasStrokeWidth, normalizeHex, primaryColor, withColor } from './colors';
import type { UpdateAction } from './labels';
import styles from './StyleControls.module.css';

export const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72] as const;

const SWATCH_NAMES: readonly (() => string)[] = [
  m.color_yellow,
  m.color_orange,
  m.color_red,
  m.color_pink,
  m.color_purple,
  m.color_blue,
  m.color_green,
  m.color_black,
];

/** Latest-value slots per coalescing key: a burst of slider events sends one update. */
const pending = new Map<string, { value: number | string }>();

function applyLatest<T extends number | string>(
  key: string,
  value: T,
  send: (read: () => T) => void,
): void {
  const slot = pending.get(key);
  if (slot) {
    slot.value = value;
    return;
  }
  const fresh = { value };
  pending.set(key, fresh);
  send(() => {
    pending.delete(key);
    return fresh.value;
  });
}

export function StyleControls({
  target,
  annotations,
  variant,
}: {
  readonly target: PageTarget;
  readonly annotations: readonly Annotation[];
  readonly variant: 'bar' | 'panel';
}) {
  const editable = annotations.filter((a) => !a.flags?.locked);
  const ids = editable.map((a) => a.id);
  const idsKey = [...ids].sort().join(',');
  const first = editable[0];
  const disabled = first === undefined;
  const color = first ? primaryColor(first) : undefined;
  const opacity = first?.opacity ?? 1;
  const stroke = editable.find(hasStrokeWidth);
  const freeText = editable.find((a) => a.kind === 'free-text');
  const colorable = editable.some((a) => primaryColor(a) !== undefined || a.kind !== 'stamp');

  const update = (
    action: UpdateAction,
    change: (a: Annotation) => Annotation | undefined,
    key?: string,
  ) =>
    void updateAnnotations(target, ids, change, {
      action,
      ...(key === undefined ? {} : { coalesceKey: key }),
    });

  const setColor = (value: string) => {
    const hex = normalizeHex(value);
    update(
      'color',
      (a) => (a.kind === 'stamp' || a.kind === 'link' ? undefined : withColor(a, hex)),
      `color:${idsKey}`,
    );
  };

  const setOpacity = (value: number) => {
    const key = `opacity:${idsKey}`;
    applyLatest(key, value, (read) =>
      update('opacity', (a) => ({ ...a, opacity: Math.round(read() * 100) / 100 }), key),
    );
  };

  const setStroke = (value: number) => {
    const key = `stroke:${idsKey}`;
    applyLatest(key, value, (read) =>
      update('stroke', (a) => (hasStrokeWidth(a) ? { ...a, strokeWidth: read() } : undefined), key),
    );
  };

  const setFontSize = (value: number) =>
    update(
      'font',
      (a) => (a.kind === 'free-text' ? { ...a, fontSize: value } : undefined),
      `font:${idsKey}`,
    );

  return (
    <div className={styles.controls} data-variant={variant}>
      {colorable ? (
        <div role="radiogroup" aria-label={m.annot_color()} className={styles.swatches}>
          {SWATCHES.map((swatch, i) => (
            <button
              key={swatch}
              type="button"
              role="radio"
              aria-checked={color?.toUpperCase() === swatch}
              aria-label={SWATCH_NAMES[i]?.() ?? swatch}
              title={SWATCH_NAMES[i]?.() ?? swatch}
              disabled={disabled}
              className={styles.swatch}
              style={{ '--swatch': swatch } as CSSProperties}
              onClick={() => setColor(swatch)}
            />
          ))}
          <label className={styles.custom} title={m.annot_custom_color()}>
            <span className={styles.visuallyHidden}>{m.annot_custom_color()}</span>
            <input
              type="color"
              disabled={disabled}
              value={color && /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : '#000000'}
              onChange={(e) => setColor(e.target.value)}
            />
          </label>
        </div>
      ) : null}
      <label className={styles.slider}>
        <span className={styles.sliderLabel}>{m.annot_opacity()}</span>
        <LiveRange
          min={10}
          max={100}
          step={5}
          disabled={disabled}
          value={Math.round(opacity * 100)}
          valueText={(v) => formatPercent(v / 100)}
          onValue={(v) => setOpacity(v / 100)}
        />
      </label>
      {stroke ? (
        <label className={styles.slider}>
          <span className={styles.sliderLabel}>{m.annot_stroke_width()}</span>
          <LiveRange
            min={0.5}
            max={12}
            step={0.5}
            disabled={disabled}
            value={stroke.strokeWidth}
            valueText={(v) => m.annot_points({ value: v })}
            onValue={setStroke}
          />
        </label>
      ) : null}
      {freeText?.kind === 'free-text' ? (
        <label className={styles.select}>
          <span className={styles.sliderLabel}>{m.annot_font_size()}</span>
          <select
            value={Math.round(freeText.fontSize)}
            disabled={disabled}
            onChange={(e) => setFontSize(Number(e.target.value))}
          >
            {[...new Set([...FONT_SIZES, Math.round(freeText.fontSize)])]
              .sort((a, b) => a - b)
              .map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
          </select>
        </label>
      ) : null}
      {variant === 'bar' ? (
        <>
          <span className={styles.divider} aria-hidden="true" />
          <IconButton
            label={m.annot_comment()}
            icon={<MessageSquare />}
            disabled={disabled || editable.length !== 1}
            onClick={() => {
              if (!first) return;
              useAnnotationStore.getState().setEditor({
                kind: 'note',
                target,
                id: first.id,
                rect: first.rect,
                text: first.contents ?? '',
              });
            }}
          />
        </>
      ) : null}
      <IconButton
        label={m.annot_delete()}
        icon={<Trash2 />}
        disabled={disabled}
        onClick={() => void deleteAnnotations(target, ids)}
      />
    </div>
  );
}

/**
 * A range input that shows the value being dragged at once; the stored value (read back
 * from the engine) takes over shortly after the interaction ends.
 */
function LiveRange({
  value,
  valueText,
  onValue,
  ...rest
}: {
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly disabled: boolean;
  readonly valueText: (value: number) => string;
  readonly onValue: (value: number) => void;
}) {
  const [local, setLocal] = useState<number | null>(null);
  const timer = useRef<number | undefined>(undefined);
  // The dragged value wins until a moment after the interaction ends (the engine follows).
  const settle = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setLocal(null), 1000);
  };
  const shown = local ?? value;
  return (
    <>
      <input
        type="range"
        {...rest}
        value={shown}
        aria-valuetext={valueText(shown)}
        onChange={(e) => {
          const next = Number(e.target.value);
          setLocal(next);
          settle();
          onValue(next);
        }}
        onPointerUp={settle}
        onBlur={settle}
      />
      <span className={styles.value}>{valueText(shown)}</span>
    </>
  );
}
