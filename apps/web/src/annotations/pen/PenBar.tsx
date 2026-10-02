/**
 * The pen's presets in the Draw group (experience-redesign spec §6.2, §7.4, §10), plugged into
 * the tool bar through `registerPenSlots` (PenBar.register.ts).
 *
 * Four ink dots of their real colour: the dot's size hints the width (10, 13 or 16 px), a
 * preset below full opacity is an 18 × 9 px capsule (a highlighter), and the armed preset has
 * a 2 px accent ring, not a fill, so its colour shows. The four sit in one quiet well so they
 * read as one control. These dots are the only colour that enters the chrome through content
 * (DESIGN.md §3).
 *
 * Tap a preset to arm it; tap the armed one again for its editor, a popover rising from the
 * dot: eight swatches and a custom colour, width stops and a slider (0.25–24 pt), opacity,
 * and "Reset to default". Edits change that preset and persist per device. Nothing opens on
 * its own: arming never opens the editor.
 *
 * Keyboard: the presets are a radiogroup inside the bar's roving tabindex. Left and Right
 * move between them (past either end, on to the bar), Space or Enter arms, Space or Enter on
 * the armed preset opens its editor, and Shift+Enter opens the focused preset's editor.
 * Arming says the preset ("Blue pen, 1.5 pt").
 *
 * The options tier (`PenTier`) holds one honesty note, and only once a pen with pressure has
 * been seen: the variable width lives in the stroke's appearance, and viewers that redraw
 * ink themselves show one width (spec §6.7, §13 decision 9). Otherwise the tier stays empty
 * and hidden.
 */
import { Popover } from '@base-ui/react/popover';
import { Plus } from 'lucide-react';
import {
  type CSSProperties,
  type KeyboardEvent,
  useId,
  useState,
  useSyncExternalStore,
} from 'react';

import { formatNumber, formatPercent, m } from '../../i18n';
import { announce } from '../../shell/announcer';
import type { PenBarProps } from '../../shell/FloatingToolbar.slots';
import popoverStyles from '../../ui/Popover.module.css';
import { Range } from '../../ui/Range';
import { Tooltip } from '../../ui/Tooltip';
import { useAnnotationStore } from '../annotation-store';
import { penSession } from './ink-input';
import {
  dotSize,
  isHighlighter,
  needsDotRing,
  PEN_SWATCHES,
  type PenPreset,
  PRESET_INDICES,
  PRESET_LIMITS,
  type PresetIndex,
  presetLabel,
  presetName,
  WIDTH_STOPS,
  widthText,
} from './presets';
import styles from './PenBar.module.css';

/** `#rrggbb` at `alpha` as `rgb()`, the dot's fill. */
function inkFill(color: string, alpha: number): string {
  const n = Number.parseInt(color.slice(1), 16);
  return `rgb(${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255} / ${alpha})`;
}

function InkMark({ preset }: { readonly preset: PenPreset }) {
  return (
    <span
      className={styles.mark}
      data-shape={isHighlighter(preset) ? 'capsule' : 'dot'}
      data-ring={needsDotRing(preset) ? '' : undefined}
      style={
        {
          '--dot': `${dotSize(preset.width)}px`,
          '--ink': inkFill(preset.color, preset.opacity),
        } as CSSProperties
      }
      aria-hidden="true"
    />
  );
}

/**
 * The editor's radio groups (APG radio group): one Tab stop on the chosen radio, and the
 * arrows move to a neighbour and choose it.
 */
const RADIO_STEPS: Readonly<Record<string, number>> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
};

function onRadioKeyDown(event: KeyboardEvent<HTMLElement>): void {
  const step = RADIO_STEPS[event.key];
  if (step === undefined || event.altKey || event.ctrlKey || event.metaKey) return;
  const group = event.currentTarget.closest('[role="radiogroup"]');
  const radios = Array.from(group?.querySelectorAll<HTMLElement>('[role="radio"]') ?? []);
  const at = radios.indexOf(event.currentTarget);
  if (at < 0) return;
  event.preventDefault();
  const next = radios[(at + step + radios.length) % radios.length];
  next?.focus();
  next?.click();
}

/** The radio that holds a group's Tab stop: the chosen one, else the first. */
function radioTabIndex(checked: boolean, index: number, anyChecked: boolean): 0 | -1 {
  return checked || (!anyChecked && index === 0) ? 0 : -1;
}

/** The preset whose editor is (or was last) shown, and the dot it rises from. */
interface Editing {
  readonly index: PresetIndex;
  readonly anchor: HTMLElement;
}

export function PenBar({ armed, arm }: PenBarProps) {
  const pen = useAnnotationStore((s) => s.pen);
  const [open, setOpen] = useState(false);
  // Kept after closing, so the editor keeps its content while it fades out.
  const [editing, setEditing] = useState<Editing | null>(null);
  const hintId = useId();

  const openEditor = (index: PresetIndex, anchor: HTMLElement) => {
    setEditing({ index, anchor });
    setOpen(true);
  };

  const tap = (index: PresetIndex, anchor: HTMLElement) => {
    if (armed && index === pen.active) {
      if (open && editing?.index === index) setOpen(false);
      else openEditor(index, anchor);
      return;
    }
    // Arming opens nothing (spec §6.2).
    setOpen(false);
    useAnnotationStore.getState().armPreset(index);
    arm();
    // Said instead of the generic "Pen tool" (same key), after a closed burst if any.
    announce(presetLabel(index, useAnnotationStore.getState().pen.presets[index]), {
      key: 'tool',
    });
  };

  const onDotKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: PresetIndex) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'Enter' && event.shiftKey) {
      event.preventDefault();
      openEditor(index, event.currentTarget);
      return;
    }
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    const next = event.currentTarget
      .closest('[data-pen-presets]')
      ?.querySelector<HTMLElement>(`[data-pen-preset="${index + step}"]`);
    // Past either end the bar's roving tabindex moves on.
    if (step === 0 || !next) return;
    event.preventDefault();
    next.focus();
  };

  return (
    <>
      <div
        role="radiogroup"
        aria-label={m.pen_presets_label()}
        className={styles.presets}
        data-pen-presets=""
      >
        {PRESET_INDICES.map((i) => {
          const preset = pen.presets[i];
          const label = presetLabel(i, preset);
          const active = i === pen.active;
          return (
            <Tooltip key={i} label={label} side="top">
              <button
                type="button"
                role="radio"
                aria-checked={active}
                aria-label={label}
                aria-describedby={armed && active ? hintId : undefined}
                className={styles.dot}
                data-pen-preset={i}
                data-armed={armed && active ? '' : undefined}
                data-editing={open && editing?.index === i ? '' : undefined}
                onClick={(event) => tap(i, event.currentTarget)}
                onKeyDown={(event) => onDotKeyDown(event, i)}
              >
                <InkMark preset={preset} />
              </button>
            </Tooltip>
          );
        })}
        <span id={hintId} hidden>
          {m.pen_preset_edit_hint()}
        </span>
      </div>
      {editing ? (
        <PresetEditor
          open={open}
          editing={editing}
          onClose={(byDot) => {
            // A press on the open preset's own dot toggles it there (`tap`).
            if (!byDot) setOpen(false);
          }}
        />
      ) : null}
    </>
  );
}

function PresetEditor({
  open,
  editing,
  onClose,
}: {
  readonly open: boolean;
  readonly editing: Editing;
  /** `byDot`: the press that closes it was on the preset's own dot. */
  readonly onClose: (byDot: boolean) => void;
}) {
  const { index: i, anchor } = editing;
  const preset = useAnnotationStore((s) => s.pen.presets[i]);
  const name = presetName(i, preset);
  const edit = (patch: Partial<PenPreset>) => useAnnotationStore.getState().editPreset(i, patch);
  const swatchChosen = PEN_SWATCHES.some((swatch) => swatch.color === preset.color);
  // A colour that is none of the swatches shows in the custom control (then the chosen one).
  const custom = !swatchChosen;
  const stopChosen = WIDTH_STOPS.some((stop) => stop === preset.width);

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next, details) => {
        if (next) return;
        const target = details.event?.target;
        onClose(target instanceof Node && anchor.contains(target));
      }}
    >
      <Popover.Portal>
        <Popover.Positioner
          anchor={anchor}
          side="top"
          align="center"
          sideOffset={12}
          collisionPadding={8}
        >
          <Popover.Popup
            className={`${popoverStyles.popup} ${styles.editor}`}
            data-annotation-keep=""
            data-testid="pen-preset-editor"
            finalFocus={() => anchor}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return;
              // Only the editor closes: the pen stays armed.
              event.preventDefault();
              onClose(false);
            }}
          >
            <Popover.Title className={popoverStyles.title}>
              {m.pen_editor_label({ name })}
            </Popover.Title>

            <div role="radiogroup" aria-label={m.annot_color()} className={styles.swatches}>
              {PEN_SWATCHES.map((swatch, n) => (
                <button
                  key={swatch.color}
                  type="button"
                  role="radio"
                  aria-checked={preset.color === swatch.color}
                  tabIndex={radioTabIndex(preset.color === swatch.color, n, swatchChosen)}
                  onKeyDown={onRadioKeyDown}
                  aria-label={swatch.name()}
                  title={swatch.name()}
                  className={styles.swatch}
                  style={{ '--swatch': swatch.color } as CSSProperties}
                  onClick={() => edit({ color: swatch.color })}
                />
              ))}
              <label
                className={styles.custom}
                title={m.annot_custom_color()}
                data-custom={custom ? '' : undefined}
                style={custom ? ({ '--swatch': preset.color } as CSSProperties) : undefined}
              >
                <span className={styles.visuallyHidden}>{m.annot_custom_color()}</span>
                <span className={styles.customMark} aria-hidden="true">
                  {custom ? null : <Plus className={styles.customIcon} />}
                </span>
                <input
                  type="color"
                  aria-label={m.annot_custom_color()}
                  value={preset.color.toLowerCase()}
                  onChange={(e) => edit({ color: e.target.value })}
                />
              </label>
            </div>

            <div className={styles.row}>
              <span className={styles.rowLabel} id={`pen-width-${i}`}>
                {m.pen_editor_width()}
              </span>
              <div role="radiogroup" aria-labelledby={`pen-width-${i}`} className={styles.stops}>
                {WIDTH_STOPS.map((stop, n) => (
                  <button
                    key={stop}
                    type="button"
                    role="radio"
                    aria-checked={preset.width === stop}
                    tabIndex={radioTabIndex(preset.width === stop, n, stopChosen)}
                    onKeyDown={onRadioKeyDown}
                    aria-label={widthText(stop)}
                    className={styles.stop}
                    onClick={() => edit({ width: stop })}
                  >
                    {formatNumber(stop)}
                  </button>
                ))}
              </div>
            </div>
            <label className={styles.slider}>
              <span className={styles.rowLabel}>{m.pen_editor_width_exact()}</span>
              <Range
                className={styles.range}
                aria-label={m.pen_editor_width_exact()}
                min={PRESET_LIMITS.width.min}
                max={PRESET_LIMITS.width.max}
                step={0.25}
                value={preset.width}
                aria-valuetext={widthText(preset.width)}
                onChange={(e) => edit({ width: Number(e.target.value) })}
              />
              <span className={styles.value}>{widthText(preset.width)}</span>
            </label>
            <label className={styles.slider}>
              <span className={styles.rowLabel}>{m.annot_opacity()}</span>
              <Range
                className={styles.range}
                aria-label={m.annot_opacity()}
                min={10}
                max={100}
                step={5}
                value={Math.round(preset.opacity * 100)}
                aria-valuetext={formatPercent(preset.opacity)}
                onChange={(e) => edit({ opacity: Number(e.target.value) / 100 })}
              />
              <span className={styles.value}>{formatPercent(preset.opacity)}</span>
            </label>

            <button
              type="button"
              className={styles.reset}
              onClick={() => {
                useAnnotationStore.getState().resetPreset(i);
                const reset = useAnnotationStore.getState().pen.presets[i];
                announce(m.pen_preset_reset_done({ name: presetName(i, reset) }));
              }}
            >
              {m.pen_editor_reset()}
            </button>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

// ---------------------------------------------------------------------------
// The options tier
// ---------------------------------------------------------------------------

/** Pointer events end strokes; the session's pressure flag can only change with them. */
function subscribePointers(listener: () => void): () => void {
  window.addEventListener('pointerup', listener, { capture: true });
  window.addEventListener('pointermove', listener, { capture: true, passive: true });
  return () => {
    window.removeEventListener('pointerup', listener, { capture: true });
    window.removeEventListener('pointermove', listener, { capture: true });
  };
}

/** Whether a pen has reported real pressure in this session (ink-input.ts). */
export function usePressureSeen(): boolean {
  return useSyncExternalStore(
    subscribePointers,
    () => penSession().pressureSeen,
    () => false,
  );
}

/** The pen's options tier: the variable-width honesty note, once pressure has been seen. */
export function PenTier() {
  const pressure = usePressureSeen();
  if (!pressure) return null;
  return (
    <p className={styles.note} data-testid="pen-width-note">
      {m.pen_width_note()}
    </p>
  );
}
