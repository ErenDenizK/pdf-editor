/**
 * Pen presets (experience-redesign spec §6.2, §9): four inks in the Draw group, each a colour,
 * a nominal width and an opacity; the fourth is the Highlighter (craft spec §5.4, `kind`).
 * One preset is armed at a time; the pen draws with it. Edits
 * change that preset and persist per device under `PEN_PRESETS_STORAGE_KEY`; anything
 * unreadable falls back to the defaults field by field (like `parseToolStyles`).
 *
 * The settings may also carry the burst limits (spec §6.4: pause 300–5,000 ms, gap 6–144 pt);
 * they have no UI. The store slice lives in annotation-store.ts (`pen`, `armPreset`,
 * `editPreset`, `resetPreset`); this module is pure.
 *
 * Colours come from the one palette (craft spec §6, `../palette.ts`). Version 2 of the
 * stored settings holds palette colours; version 1 (the palette before M8) is migrated once
 * when read (`parsePenSettings`).
 */
import { formatNumber, m } from '../../i18n';
import {
  contrastRatio,
  hexRgb,
  INK,
  INKS,
  migrateLegacyColor,
  nearestTint,
  overRgb,
  paletteName,
  TINT,
  TINTS,
} from '../palette';

export { contrastRatio, hexRgb, overRgb, type Rgb } from '../palette';

/** Per device, under the `ui:` namespace with its own version (spec §9). */
export const PEN_PRESETS_STORAGE_KEY = 'pdf-editor:ui:pen-presets:v2';
/** The settings before the M8 palette, read once when no version 2 is stored. */
export const LEGACY_PEN_PRESETS_STORAGE_KEY = 'pdf-editor:ui:pen-presets:v1';

export interface PenPreset {
  /** #RRGGBB. */
  readonly color: string;
  /** Nominal width, points. */
  readonly width: number;
  /** 0.1–1 (always 1 for the Highlighter). */
  readonly opacity: number;
  /**
   * `highlighter`: the Highlighter profile (craft spec §5.4, `highlighter.ts`): constant
   * width of `HIGHLIGHTER_LIMITS.width`, a tint at full opacity drawn with Multiply, and on
   * release a Highlight when the stroke runs along text. Absent: a pen.
   */
  readonly kind?: 'highlighter';
}

export type PresetIndex = 0 | 1 | 2 | 3;

export type PenPresets = readonly [PenPreset, PenPreset, PenPreset, PenPreset];

export interface PenSettings {
  readonly v: 2;
  /** The armed preset. */
  readonly active: PresetIndex;
  readonly presets: PenPresets;
  /** Burst pause override, ms (no UI). */
  readonly burstPauseMs?: number;
  /** Burst gap override, points (no UI). */
  readonly burstGapPt?: number;
}

export const PRESET_INDICES: readonly PresetIndex[] = [0, 1, 2, 3];

/**
 * Black and blue 1.5 pt, red 2 pt, and the Highlighter in the yellow tint, 12 pt, at full
 * opacity (craft spec §5.4, §6).
 */
export const DEFAULT_PRESETS: PenPresets = [
  { color: INK.black, width: 1.5, opacity: 1 },
  { color: INK.blue, width: 1.5, opacity: 1 },
  { color: INK.red, width: 2, opacity: 1 },
  { color: TINT.yellow, width: 12, opacity: 1, kind: 'highlighter' },
];

export const DEFAULT_PEN_SETTINGS: PenSettings = { v: 2, active: 0, presets: DEFAULT_PRESETS };

export const PRESET_LIMITS = {
  width: { min: 0.25, max: 24 },
  opacity: { min: 0.1, max: 1 },
  burstPauseMs: { min: 300, max: 5000 },
  burstGapPt: { min: 6, max: 144 },
} as const;

/** The Highlighter's range (craft spec §5.4): constant width, 6–18 pt, opaque. */
export const HIGHLIGHTER_LIMITS = {
  width: { min: 6, max: 18 },
} as const;

/** The editor's width stops, points (spec §6.2). */
export const WIDTH_STOPS = [0.5, 1, 1.5, 2, 3, 5, 8, 12] as const;

/** The editor's width stops for the Highlighter, points. */
export const HIGHLIGHTER_WIDTH_STOPS = [6, 8, 10, 12, 15, 18] as const;

/** The width stops the editor offers for a preset. */
export function presetWidthStops(p: PenPreset): readonly number[] {
  return isHighlighter(p) ? HIGHLIGHTER_WIDTH_STOPS : WIDTH_STOPS;
}

/** The width range the editor's slider offers for a preset, points. */
export function presetWidthLimits(p: PenPreset): { readonly min: number; readonly max: number } {
  return isHighlighter(p) ? HIGHLIGHTER_LIMITS.width : PRESET_LIMITS.width;
}

export interface PenSwatch {
  readonly color: string;
  readonly name: () => string;
}

/** The editor's swatches for a pen: the eight inks of the palette. */
export const PEN_SWATCHES: readonly PenSwatch[] = INKS.map(({ hex, name }) => ({
  color: hex,
  name,
}));

/** The editor's swatches for the highlighter: the four tints of the palette. */
export const HIGHLIGHTER_SWATCHES: readonly PenSwatch[] = TINTS.map(({ hex, name }) => ({
  color: hex,
  name,
}));

/** The swatches the editor offers for a preset (a custom colour is always offered too). */
export function presetSwatches(p: PenPreset): readonly PenSwatch[] {
  return isHighlighter(p) ? HIGHLIGHTER_SWATCHES : PEN_SWATCHES;
}

interface Range {
  readonly min: number;
  readonly max: number;
}

function clamp(x: unknown, range: Range): number | undefined {
  return typeof x === 'number' && Number.isFinite(x)
    ? Math.min(range.max, Math.max(range.min, x))
    : undefined;
}

/**
 * `current` with the valid fields of `patch` applied (colour #RRGGBB, numbers clamped). The
 * kind stays unless `patch` names one; the Highlighter keeps its profile (craft spec §5.4):
 * width within `HIGHLIGHTER_LIMITS`, full opacity.
 */
export function validPreset(current: PenPreset, patch: unknown): PenPreset {
  if (typeof patch !== 'object' || patch === null) return current;
  const p = patch as Record<string, unknown>;
  const highlighter =
    p.kind === 'highlighter' || (p.kind !== 'pen' && current.kind === 'highlighter');
  const widthRange = highlighter ? HIGHLIGHTER_LIMITS.width : PRESET_LIMITS.width;
  const color =
    typeof p.color === 'string' && /^#[0-9a-f]{6}$/i.test(p.color)
      ? p.color.toUpperCase()
      : current.color;
  // Widths on a quarter point, opacities on a hundredth: what the controls can set.
  const width =
    Math.round((clamp(p.width, widthRange) ?? clamp(current.width, widthRange) ?? 0) * 4) / 4;
  if (highlighter) return { color, width, opacity: 1, kind: 'highlighter' };
  return {
    color,
    width,
    opacity: Math.round((clamp(p.opacity, PRESET_LIMITS.opacity) ?? current.opacity) * 100) / 100,
  };
}

function isPresetIndex(x: unknown): x is PresetIndex {
  return x === 0 || x === 1 || x === 2 || x === 3;
}

/**
 * A version 1 preset in the palette (craft spec §5.4, §6): a translucent preset becomes the
 * Highlighter with the nearest tint (full opacity, its width within the Highlighter's
 * range); an old default or swatch colour becomes the ink of its role; a custom colour
 * stays. A pen's width and opacity stay.
 */
export function migratePreset(p: PenPreset): PenPreset {
  if (isHighlighter(p) || p.opacity < 1) {
    return validPreset(p, { color: nearestTint(p.color).hex, kind: 'highlighter' });
  }
  const color = migrateLegacyColor(p.color, 'ink');
  return color === p.color ? p : { ...p, color };
}

/**
 * Reads stored pen settings field by field: an unknown version keeps every default; a bad
 * preset field keeps that field's default; a bad active index arms the first preset; burst
 * limits are clamped to their ranges and dropped when not numbers. Version 1 settings are
 * migrated to the palette (`migratePreset`).
 */
export function parsePenSettings(value: unknown): PenSettings {
  if (typeof value !== 'object' || value === null) return DEFAULT_PEN_SETTINGS;
  const v = value as Record<string, unknown>;
  if (v.v !== 1 && v.v !== 2) return DEFAULT_PEN_SETTINGS;
  const legacy = v.v === 1;
  const stored = Array.isArray(v.presets) ? (v.presets as unknown[]) : [];
  const presets = DEFAULT_PRESETS.map((preset, i) => {
    const raw = stored[i];
    if (!legacy) return validPreset(preset, raw);
    // Version 1 had no kinds: a stored preset is read as a pen and its opacity decides.
    if (typeof raw !== 'object' || raw === null) return preset;
    const { kind: _kind, ...pen } = preset;
    return migratePreset(validPreset(pen, raw));
  }) as [PenPreset, PenPreset, PenPreset, PenPreset];
  const pause = clamp(v.burstPauseMs, PRESET_LIMITS.burstPauseMs);
  const gap = clamp(v.burstGapPt, PRESET_LIMITS.burstGapPt);
  return {
    v: 2,
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
  return a.color === b.color && a.width === b.width && a.opacity === b.opacity && a.kind === b.kind;
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

/**
 * Dot diameter in the bar (spec §7.4, enlarged 2026-10-02 so the presets read as ink, not
 * specks): 10, 13 or 16 px for widths ≤ 1, ≤ 3 and > 3 pt.
 */
export function dotSize(width: number): 10 | 13 | 16 {
  if (width <= 1) return 10;
  if (width <= 3) return 13;
  return 16;
}

/** The Highlighter (craft spec §5.4; drawn as a short capsule in the bar). */
export function isHighlighter(p: PenPreset): boolean {
  return p.kind === 'highlighter';
}

/**
 * The tool bar's fill behind the dots (tokens.css: the `--glass` tint rgb(48 51 58 / 0.66)
 * over a backdrop at `brightness(0.45)`): over the canvas (`--surface-0`) and over a white
 * page (`--page-background`). PenBar.test.tsx derives them from the tokens again.
 */
export const PEN_BAR_FILLS: readonly string[] = ['#212328', '#47494d'];
/** Least contrast of a dot against the bar (WCAG 1.4.11, non-text). */
export const DOT_CONTRAST_MIN = 3;

/**
 * Whether the preset's dot gets the light ring (spec §7.4): its ink, at its opacity, is
 * below `DOT_CONTRAST_MIN` against the bar over the canvas or over a page (every ink of the
 * palette, and a tint at 40 %; only a tint at full opacity goes without), so the dot's edge
 * shows wherever the bar floats.
 */
export function needsDotRing(p: PenPreset, fills: readonly string[] = PEN_BAR_FILLS): boolean {
  const ink = hexRgb(p.color);
  return fills.some((fill) => {
    const under = hexRgb(fill);
    return contrastRatio(overRgb(ink, p.opacity, under), under) < DOT_CONTRAST_MIN;
  });
}

/**
 * The preset's name: its colour when that is an ink or tint of the palette ("Blue pen",
 * "Yellow highlighter"), else its place ("Pen 3"), so a name never claims a colour it does
 * not have.
 */
export function presetName(index: number, p: PenPreset): string {
  const color = paletteName(p.color);
  if (color === undefined) {
    return isHighlighter(p)
      ? m.pen_preset_highlighter_numbered({ number: index + 1 })
      : m.pen_preset_numbered({ number: index + 1 });
  }
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
