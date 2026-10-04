/**
 * The controls shared by the contextual bar and the Properties panel (spec §2): colour
 * swatches from the one palette (craft spec §6: the eight inks, or the four highlighter
 * tints for a highlight or a note, plus custom), opacity, stroke width, font size, comment,
 * delete.
 *
 * Every style control goes through `applyStyle` (experience-redesign spec §6.3): with a
 * selection it edits the selection (slider changes coalesce into one history entry, and
 * only the latest value of a burst is sent to the engine); without one it changes the armed
 * tool's style, which persists per device. The `tool` variant shows the armed tool's style
 * (the tool bar's options tier, and the Properties panel with nothing selected), so a colour
 * or width can be set before drawing; with a selection it shows (and edits) the selection.
 */
import type { Annotation } from '@pdf-editor/engine';
import { ChevronDown, MessageSquare, Plus, Trash2 } from 'lucide-react';
import { type CSSProperties, Fragment, type ReactNode, useRef, useState } from 'react';

import { formatNumber, formatPercent, m } from '../i18n';
import { IconButton } from '../ui/IconButton';
import { Range } from '../ui/Range';
import { deleteAnnotations } from './actions';
import { deleteLassoSelection } from './lasso/edits';
import {
  activePathSelection,
  type PageTarget,
  selectedAnnotations,
  type StyleGroup,
  type ToolStyle,
  useAnnotationStore,
} from './annotation-store';
import { hasStrokeWidth, normalizeHex, primaryColor } from './colors';
import { INKS, isTint, type PaletteColor, TINTS } from './palette';
import styles from './StyleControls.module.css';

export const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72] as const;

/** Style groups coloured with a highlighter tint rather than an ink. */
const TINTED_GROUPS: ReadonlySet<StyleGroup> = new Set(['highlight', 'note']);

/**
 * The swatches for what the controls show: the four tints for a highlight or a note, or
 * for any colour that is a tint (a highlighter stroke); else the eight inks.
 */
export function swatchesFor(tinted: boolean, color: string | undefined): readonly PaletteColor[] {
  return tinted || (color !== undefined && isTint(color)) ? TINTS : INKS;
}

/** A `#rrggbb` colour, the only form the custom colour input takes. */
const HEX = /^#[0-9a-f]{6}$/i;

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
      /** Where the controls sit: the inspector (default) or the tool bar's options tier. */
      readonly placement?: 'panel' | 'tier';
      /**
       * With a selection none of which takes a stroke width, show the width disabled rather
       * than leave it out (the lasso bar, craft spec §5.5).
       */
      readonly keepStrokeWidth?: boolean;
    };

/** What the controls show, from the selection or from a tool style. */
interface Shown {
  readonly disabled: boolean;
  readonly colorable: boolean;
  /** A highlight or a note: its swatches are the highlighter tints. */
  readonly tinted: boolean;
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
    tinted: first?.kind === 'highlight' || first?.kind === 'text',
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
    tinted: TINTED_GROUPS.has(group),
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
  // A tool's controls edit the selection when there is one (applyStyle), so they show it.
  const selection = useAnnotationStore((s) => (props.variant === 'tool' ? s.selection : null));
  const pages = useAnnotationStore((s) => (props.variant === 'tool' ? s.pages : undefined));
  const toolSelection =
    selection && pages
      ? selectedAnnotations({ selection, pages }).filter((a) => !a.flags?.locked)
      : [];
  const editable =
    props.variant === 'tool' ? [] : props.annotations.filter((a) => !a.flags?.locked);
  const ids = editable.map((a) => a.id);
  const first = editable[0];
  const shown =
    props.variant === 'tool' && toolStyle
      ? toolSelection.length > 0
        ? shownForSelection(toolSelection)
        : shownForTool(props.group, toolStyle)
      : shownForSelection(editable);
  const { disabled, color, opacity } = shown;
  // The lasso bar says that nothing selected takes a width by a disabled control.
  const strokeOff =
    props.variant === 'tool' &&
    props.keepStrokeWidth === true &&
    toolSelection.length > 0 &&
    shown.strokeWidth === undefined;
  const swatches = swatchesFor(shown.tinted, color);
  // A colour that is none of the swatches shows in the custom control, which then reads as
  // the chosen one.
  const custom =
    color !== undefined && HEX.test(color) && !swatches.some((s) => s.hex === color.toUpperCase());

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

  // A bar or the options tier lays the controls out in one row; the inspector (a selection's
  // properties, or the armed tool's style) stacks them.
  const placement = props.variant === 'tool' ? (props.placement ?? 'panel') : undefined;
  const layout = variant === 'bar' || placement === 'tier' ? 'row' : 'stack';
  // The groups in reading order: colour, opacity, size (stroke width or font size). In a row
  // a hairline divider separates them.
  const groups: { key: string; node: ReactNode }[] = [];
  if (shown.colorable) {
    groups.push({
      key: 'color',
      node: (
        <div role="radiogroup" aria-label={m.annot_color()} className={styles.swatches}>
          {swatches.map((swatch) => (
            <button
              key={swatch.hex}
              type="button"
              role="radio"
              aria-checked={color?.toUpperCase() === swatch.hex}
              aria-label={swatch.name()}
              title={swatch.name()}
              disabled={disabled}
              className={styles.swatch}
              style={{ '--swatch': swatch.hex } as CSSProperties}
              onClick={() => setColor(swatch.hex)}
            />
          ))}
          <label
            className={styles.custom}
            title={m.annot_custom_color()}
            data-custom={custom ? '' : undefined}
            data-disabled={disabled ? '' : undefined}
            style={custom ? ({ '--swatch': color } as CSSProperties) : undefined}
          >
            <span className={styles.visuallyHidden}>{m.annot_custom_color()}</span>
            <span className={styles.customMark} aria-hidden="true">
              {custom ? null : <Plus className={styles.customIcon} />}
            </span>
            <input
              type="color"
              disabled={disabled}
              value={color && HEX.test(color) ? color.toLowerCase() : '#000000'}
              onChange={(e) => setColor(e.target.value)}
            />
          </label>
        </div>
      ),
    });
  }
  groups.push({
    key: 'opacity',
    node: (
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
    ),
  });
  if (shown.strokeWidth !== undefined || strokeOff) {
    groups.push({
      key: 'stroke',
      node: (
        <label
          className={styles.slider}
          title={strokeOff ? m.lasso_width_none() : undefined}
          data-stroke-off={strokeOff ? '' : undefined}
        >
          <span className={styles.sliderLabel}>{m.annot_stroke_width()}</span>
          <LiveRange
            min={0.5}
            max={12}
            step={0.5}
            disabled={disabled || strokeOff}
            value={shown.strokeWidth ?? toolStyle?.strokeWidth ?? 1}
            valueText={strokeWidthText}
            onValue={setStroke}
          />
        </label>
      ),
    });
  }
  if (shown.fontSize !== undefined) {
    groups.push({
      key: 'font-size',
      node: (
        <label className={styles.select}>
          <span className={styles.sliderLabel}>{m.annot_font_size()}</span>
          <span className={styles.selectBox}>
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
            <ChevronDown className={styles.selectChevron} aria-hidden="true" />
          </span>
        </label>
      ),
    });
  }

  return (
    <div
      className={styles.controls}
      data-variant={variant}
      data-placement={placement}
      data-flow={layout}
    >
      {groups.map(({ key, node }, i) => (
        <Fragment key={key}>
          {i > 0 && layout === 'row' ? (
            <span className={styles.divider} aria-hidden="true" />
          ) : null}
          {node}
        </Fragment>
      ))}
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
          onClick={() => {
            // A lasso selection deletes the taken strokes only, never the whole annotation.
            if (activePathSelection(useAnnotationStore.getState())) void deleteLassoSelection();
            else void deleteAnnotations(props.target, ids);
          }}
        />
      )}
    </div>
  );
}

/**
 * A stroke width as shown (review finding 12): rounded to 0.1 pt in the locale's digits, so
 * a width read back as 1.2999999523162842 says "1.3 pt".
 */
export function strokeWidthText(width: number): string {
  return m.annot_points({
    value: formatNumber(Math.round(width * 10) / 10, { maximumFractionDigits: 1 }),
  });
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
      <Range
        {...rest}
        className={styles.range}
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
