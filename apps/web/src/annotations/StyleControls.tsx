/**
 * The controls shared by the contextual bar and the Properties panel (spec §2): colour
 * swatches (8 fixed + custom), opacity, stroke width, font size, comment, delete.
 *
 * Every style control goes through `applyStyle` (experience-redesign spec §6.3): with a
 * selection it edits the selection (slider changes coalesce into one history entry, and
 * only the latest value of a burst is sent to the engine); without one it changes the armed
 * tool's style, which persists per device. The `tool` variant shows the armed tool's style
 * (Properties panel with nothing selected), so a colour or width can be set before drawing.
 */
import type { Annotation } from '@pdf-editor/engine';
import { MessageSquare, Trash2 } from 'lucide-react';
import { type CSSProperties, useRef, useState } from 'react';

import { formatPercent, m } from '../i18n';
import { IconButton } from '../ui/IconButton';
import { deleteAnnotations } from './actions';
import {
  type PageTarget,
  type StyleGroup,
  SWATCHES,
  type ToolStyle,
  useAnnotationStore,
} from './annotation-store';
import { hasStrokeWidth, normalizeHex, primaryColor } from './colors';
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

/** Style groups whose annotations have a stroke width (ink and shapes). */
const STROKED_GROUPS: ReadonlySet<StyleGroup> = new Set(['ink', 'shape']);

export type StyleControlsProps =
  | {
      /** The selected annotations, in the contextual bar or the Properties panel. */
      readonly variant: 'bar' | 'panel';
      readonly target: PageTarget;
      readonly annotations: readonly Annotation[];
    }
  | {
      /** The armed tool's style (nothing selected): what the next annotation gets. */
      readonly variant: 'tool';
      readonly group: StyleGroup;
    };

/** What the controls show, from the selection or from a tool style. */
interface Shown {
  readonly disabled: boolean;
  readonly colorable: boolean;
  readonly color: string | undefined;
  readonly opacity: number;
  readonly strokeWidth: number | undefined;
  readonly fontSize: number | undefined;
}

function shownForSelection(editable: readonly Annotation[]): Shown {
  const first = editable[0];
  const stroke = editable.find(hasStrokeWidth);
  const freeText = editable.find((a) => a.kind === 'free-text');
  return {
    disabled: first === undefined,
    colorable: editable.some((a) => primaryColor(a) !== undefined || a.kind !== 'stamp'),
    color: first ? primaryColor(first) : undefined,
    opacity: first?.opacity ?? 1,
    strokeWidth: stroke?.strokeWidth,
    fontSize: freeText?.kind === 'free-text' ? freeText.fontSize : undefined,
  };
}

function shownForTool(group: StyleGroup, style: ToolStyle): Shown {
  return {
    disabled: false,
    colorable: true,
    color: style.color,
    opacity: style.opacity,
    strokeWidth: STROKED_GROUPS.has(group) ? style.strokeWidth : undefined,
    fontSize: group === 'text' ? style.fontSize : undefined,
  };
}

export function StyleControls(props: StyleControlsProps) {
  const { variant } = props;
  const applyStyle = useAnnotationStore((s) => s.applyStyle);
  const toolStyle = useAnnotationStore((s) =>
    props.variant === 'tool' ? s.styles[props.group] : undefined,
  );
  const editable =
    props.variant === 'tool' ? [] : props.annotations.filter((a) => !a.flags?.locked);
  const ids = editable.map((a) => a.id);
  const first = editable[0];
  const shown =
    props.variant === 'tool' && toolStyle
      ? shownForTool(props.group, toolStyle)
      : shownForSelection(editable);
  const { disabled, color, opacity } = shown;

  const setColor = (value: string) => {
    applyStyle({ color: normalizeHex(value) });
  };
  const setOpacity = (value: number) => {
    applyStyle({ opacity: value });
  };
  const setStroke = (value: number) => {
    applyStyle({ strokeWidth: value });
  };
  const setFontSize = (value: number) => {
    applyStyle({ fontSize: value });
  };

  return (
    <div className={styles.controls} data-variant={variant}>
      {shown.colorable ? (
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
      {shown.strokeWidth !== undefined ? (
        <label className={styles.slider}>
          <span className={styles.sliderLabel}>{m.annot_stroke_width()}</span>
          <LiveRange
            min={0.5}
            max={12}
            step={0.5}
            disabled={disabled}
            value={shown.strokeWidth}
            valueText={(v) => m.annot_points({ value: v })}
            onValue={setStroke}
          />
        </label>
      ) : null}
      {shown.fontSize !== undefined ? (
        <label className={styles.select}>
          <span className={styles.sliderLabel}>{m.annot_font_size()}</span>
          <select
            value={Math.round(shown.fontSize)}
            disabled={disabled}
            onChange={(e) => setFontSize(Number(e.target.value))}
          >
            {[...new Set([...FONT_SIZES, Math.round(shown.fontSize)])]
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
                target: props.target,
                id: first.id,
                rect: first.rect,
                text: first.contents ?? '',
              });
            }}
          />
        </>
      ) : null}
      {props.variant === 'tool' ? null : (
        <IconButton
          label={m.annot_delete()}
          icon={<Trash2 />}
          disabled={disabled}
          onClick={() => void deleteAnnotations(props.target, ids)}
        />
      )}
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
