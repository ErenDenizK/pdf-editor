/**
 * Pen presets (experience-redesign spec §6.2, §9): four inks in the Draw group, each a colour,
 * a nominal width and an opacity. One preset is armed at a time; the pen draws with it. Edits
 * change that preset and persist per device under `PEN_PRESETS_STORAGE_KEY`; anything
 * unreadable falls back to the defaults field by field (like `parseToolStyles`).
 *
 * The settings may also carry the burst limits (spec §6.4: pause 300–5,000 ms, gap 6–144 pt);
 * they have no UI. The store slice lives in annotation-store.ts (`pen`, `armPreset`,
 * `editPreset`, `resetPreset`); this module is pure.
 */
import { formatNumber, m } from '../../i18n';

/** Per device, under the `ui:` namespace with its own version (spec §9). */
export const PEN_PRESETS_STORAGE_KEY = 'pdf-editor:ui:pen-presets:v1';

export interface PenPreset {
  /** #RRGGBB. */
  readonly color: string;
  /** Nominal width, points. */
  readonly width: number;
  /** 0.1–1. */
  readonly opacity: number;
}

export type PresetIndex = 0 | 1 | 2 | 3;

export type PenPresets = readonly [PenPreset, PenPreset, PenPreset, PenPreset];

export interface PenSettings {
  readonly v: 1;
  /** The armed preset. */
  readonly active: PresetIndex;
  readonly presets: PenPresets;
  /** Burst pause override, ms (no UI). */
  readonly burstPauseMs?: number;
  /** Burst gap override, points (no UI). */
  readonly burstGapPt?: number;
}

export const PRESET_INDICES: readonly PresetIndex[] = [0, 1, 2, 3];

/** Black and blue 1.5 pt, red 2 pt, a yellow 12 pt highlighter at 40 % (spec §6.2). */
export const DEFAULT_PRESETS: PenPresets = [
  { color: '#1F1F1F', width: 1.5, opacity: 1 },
  { color: '#1E5BD8', width: 1.5, opacity: 1 },
  { color: '#E53935', width: 2, opacity: 1 },
  { color: '#FFD400', width: 12, opacity: 0.4 },
];

export const DEFAULT_PEN_SETTINGS: PenSettings = { v: 1, active: 0, presets: DEFAULT_PRESETS };

export const PRESET_LIMITS = {
  width: { min: 0.25, max: 24 },
  opacity: { min: 0.1, max: 1 },
  burstPauseMs: { min: 300, max: 5000 },
  burstGapPt: { min: 6, max: 144 },
} as const;

/** The editor's width stops, points (spec §6.2). */
export const WIDTH_STOPS = [0.5, 1, 1.5, 2, 3, 5, 8, 12] as const;

/** The editor's eight swatches: the four default inks first, then four more. */
export const PEN_SWATCHES: readonly { readonly color: string; readonly name: () => string }[] = [
  { color: '#1F1F1F', name: m.color_black },
  { color: '#1E5BD8', name: m.color_blue },
  { color: '#E53935', name: m.color_red },
  { color: '#FFD400', name: m.color_yellow },
  { color: '#43A047', name: m.color_green },
  { color: '#FB8C00', name: m.color_orange },
  { color: '#8E24AA', name: m.color_purple },
  { color: '#D81B60', name: m.color_pink },
];

interface Range {
  readonly min: number;
  readonly max: number;
}

function clamp(x: unknown, range: Range): number | undefined {
  return typeof x === 'number' && Number.isFinite(x)
    ? Math.min(range.max, Math.max(range.min, x))
    : undefined;
}

/** `current` with the valid fields of `patch` applied (colour #RRGGBB, numbers clamped). */
export function validPreset(current: PenPreset, patch: unknown): PenPreset {
  if (typeof patch !== 'object' || patch === null) return current;
  const p = patch as Record<string, unknown>;
  return {
    color:
      typeof p.color === 'string' && /^#[0-9a-f]{6}$/i.test(p.color)
        ? p.color.toUpperCase()
        : current.color,
    // Widths on a quarter point, opacities on a hundredth: what the controls can set.
    width: Math.round((clamp(p.width, PRESET_LIMITS.width) ?? current.width) * 4) / 4,
    opacity: Math.round((clamp(p.opacity, PRESET_LIMITS.opacity) ?? current.opacity) * 100) / 100,
  };
}

function isPresetIndex(x: unknown): x is PresetIndex {
  return x === 0 || x === 1 || x === 2 || x === 3;
}

/**
 * Reads stored pen settings field by field: an unknown version keeps every default; a bad
 * preset field keeps that field's default; a bad active index arms the first preset; burst
 * limits are clamped to their ranges and dropped when not numbers.
 */
export function parsePenSettings(value: unknown): PenSettings {
  if (typeof value !== 'object' || value === null) return DEFAULT_PEN_SETTINGS;
  const v = value as Record<string, unknown>;
  if (v.v !== 1) return DEFAULT_PEN_SETTINGS;
  const stored = Array.isArray(v.presets) ? (v.presets as unknown[]) : [];
  const presets = DEFAULT_PRESETS.map((preset, i) => validPreset(preset, stored[i])) as [
    PenPreset,
    PenPreset,
    PenPreset,
    PenPreset,
  ];
  const pause = clamp(v.burstPauseMs, PRESET_LIMITS.burstPauseMs);
  const gap = clamp(v.burstGapPt, PRESET_LIMITS.burstGapPt);
  return {
    v: 1,
    active: isPresetIndex(v.active) ? v.active : 0,
    presets,
    ...(pause === undefined ? {} : { burstPauseMs: pause }),
    ...(gap === undefined ? {} : { burstGapPt: gap }),
  };
}

/** The settings with preset `index` replaced. */
export function withPreset(
  settings: PenSettings,
  index: PresetIndex,
  preset: PenPreset,
): PenSettings {
  const presets = settings.presets.map((p, i) => (i === index ? preset : p)) as [
    PenPreset,
    PenPreset,
    PenPreset,
    PenPreset,
  ];
  return { ...settings, presets };
}

export function samePreset(a: PenPreset, b: PenPreset): boolean {
  return a.color === b.color && a.width === b.width && a.opacity === b.opacity;
}

/** The tool style fields a preset sets (the pen's `styles.ink`). */
export function presetStyle(p: PenPreset): {
  color: string;
  strokeWidth: number;
  opacity: number;
} {
  return { color: p.color, strokeWidth: p.width, opacity: p.opacity };
}

/** A preset patch from tool style fields (`applyStyle` with the pen armed). */
export function presetPatch(style: {
  readonly color?: string;
  readonly strokeWidth?: number;
  readonly opacity?: number;
}): Partial<PenPreset> {
  return {
    ...(style.color === undefined ? {} : { color: style.color }),
    ...(style.strokeWidth === undefined ? {} : { width: style.strokeWidth }),
    ...(style.opacity === undefined ? {} : { opacity: style.opacity }),
  };
}

/** Dot diameter in the bar (spec §7.4): 8, 11 or 14 px for widths ≤ 1, ≤ 3 and > 3 pt. */
export function dotSize(width: number): 8 | 11 | 14 {
  if (width <= 1) return 8;
  if (width <= 3) return 11;
  return 14;
}

/** A preset below full opacity is a highlighter (drawn as a short capsule in the bar). */
export function isHighlighter(p: PenPreset): boolean {
  return p.opacity < 1;
}

/**
 * The preset's name: its colour when that is one of the swatches ("Blue pen", "Yellow
 * highlighter"), else its place ("Pen 3"), so a name never claims a colour it does not have.
 */
export function presetName(index: number, p: PenPreset): string {
  const swatch = PEN_SWATCHES.find((s) => s.color === p.color.toUpperCase());
  if (!swatch) {
    return isHighlighter(p)
      ? m.pen_preset_highlighter_numbered({ number: index + 1 })
      : m.pen_preset_numbered({ number: index + 1 });
  }
  const color = swatch.name();
  return isHighlighter(p) ? m.pen_preset_highlighter({ color }) : m.pen_preset_pen({ color });
}

/** Width in the active language ("1.5 pt"). */
export function widthText(width: number): string {
  return m.annot_points({ value: formatNumber(width, { maximumFractionDigits: 2 }) });
}

/** Name and width, the preset's accessible name and its arming announcement ("Blue pen, 1.5 pt"). */
export function presetLabel(index: number, p: PenPreset): string {
  return m.pen_preset_label({ name: presetName(index, p), width: widthText(p.width) });
}
