/**
 * The one ink palette (craft spec §6, ADR-0021 §3): the single source of the colours the
 * annotation tools offer. Pen presets and their editor, the contextual bar, the inspector,
 * the options tier, the tool defaults and the built-in stamps all read from here; no other
 * module in `annotations/` spells these colours.
 *
 * Two bands of inks near the sRGB gamut edge (research 13 §8): writing inks pass 4.5:1 on
 * white paper, accent inks pass 3:1 (WCAG 1.4.11). Yellow is no longer an ink: it is the
 * first of four highlighter tints, drawn with Multiply at full opacity so black text on them
 * stays black (≥ 10:1). All values stay in sRGB, because the PDF stores DeviceRGB.
 *
 * Hex values are upper case `#RRGGBB`, the form the stores normalise colours to.
 *
 * The module also holds the legacy colours of the palettes it replaced, for the one-time
 * migration of stored presets and tool styles (`migrateLegacyColor`).
 */
import { m } from '../i18n';

export type InkRole = 'writing' | 'accent';
export type InkId = 'black' | 'blue' | 'red' | 'green' | 'purple' | 'orange' | 'pink' | 'cyan';
export type TintId = 'yellow' | 'green' | 'blue' | 'pink';

export interface PaletteColor {
  /** Upper case `#RRGGBB`. */
  readonly hex: string;
  /** The colour's name in the active language ("Blue"), a swatch's accessible name. */
  readonly name: () => string;
}

export interface Ink extends PaletteColor {
  readonly id: InkId;
  /** Writing inks pass 4.5:1 on white, accent inks 3:1. */
  readonly role: InkRole;
}

export interface Tint extends PaletteColor {
  readonly id: TintId;
}

/** Ink hex by id. */
export const INK = {
  black: '#1A1A1A',
  blue: '#1760EE',
  red: '#DB1C22',
  green: '#02853C',
  purple: '#8036D3',
  orange: '#E46910',
  pink: '#E02C8A',
  cyan: '#0891C9',
} as const satisfies Record<InkId, string>;

/** Highlighter tint hex by id (Multiply, opacity 1). */
export const TINT = {
  yellow: '#FFEA00',
  green: '#8CF26B',
  blue: '#8FD3FF',
  pink: '#FF9AD5',
} as const satisfies Record<TintId, string>;

/** The eight inks in swatch order: the five writing inks, then the three accent inks. */
export const INKS: readonly Ink[] = [
  { id: 'black', role: 'writing', hex: INK.black, name: m.color_black },
  { id: 'blue', role: 'writing', hex: INK.blue, name: m.color_blue },
  { id: 'red', role: 'writing', hex: INK.red, name: m.color_red },
  { id: 'green', role: 'writing', hex: INK.green, name: m.color_green },
  { id: 'purple', role: 'writing', hex: INK.purple, name: m.color_purple },
  { id: 'orange', role: 'accent', hex: INK.orange, name: m.color_orange },
  { id: 'pink', role: 'accent', hex: INK.pink, name: m.color_pink },
  { id: 'cyan', role: 'accent', hex: INK.cyan, name: m.color_cyan },
];

/** The four highlighter tints in swatch order. */
export const TINTS: readonly Tint[] = [
  { id: 'yellow', hex: TINT.yellow, name: m.color_yellow },
  { id: 'green', hex: TINT.green, name: m.color_green },
  { id: 'blue', hex: TINT.blue, name: m.color_blue },
  { id: 'pink', hex: TINT.pink, name: m.color_pink },
];

/**
 * Pure black: the black of printed text (the contrast checks of the tints) and the fill a
 * redaction mark paints. Not an ink: the ink black is `INK.black`.
 */
export const PURE_BLACK = '#000000';

/** Least contrast on white paper per ink role (WCAG 1.4.3 for writing, 1.4.11 for accents). */
export const INK_CONTRAST_MIN: Readonly<Record<InkRole, number>> = { writing: 4.5, accent: 3 };
/** Least contrast of black text on a tint, drawn with Multiply at opacity 1. */
export const TINT_CONTRAST_MIN = 10;

function upper(hex: string): string {
  return hex.toUpperCase();
}

/** The ink with this colour (any case), if it is one of the eight. */
export function inkOf(hex: string): Ink | undefined {
  const h = upper(hex);
  return INKS.find((ink) => ink.hex === h);
}

/** The tint with this colour (any case), if it is one of the four. */
export function tintOf(hex: string): Tint | undefined {
  const h = upper(hex);
  return TINTS.find((tint) => tint.hex === h);
}

/** Whether the colour (any case) is one of the eight inks, not a custom colour. */
export function isDefaultInk(hex: string): boolean {
  return inkOf(hex) !== undefined;
}

/** Whether the colour (any case) is one of the four highlighter tints. */
export function isTint(hex: string): boolean {
  return tintOf(hex) !== undefined;
}

/** The palette name of an ink or tint ("Blue"), or undefined for a custom colour. */
export function paletteName(hex: string): string | undefined {
  return (inkOf(hex) ?? tintOf(hex))?.name();
}

// --- Colour maths (WCAG 2.2 relative luminance, the same as styles/tokens.test.ts) ---

export type Rgb = readonly [number, number, number];

export const WHITE: Rgb = [255, 255, 255];

export function hexRgb(hex: string): Rgb {
  const n = Number.parseInt(hex.slice(1, 7), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** `ink` at `alpha` over `under` (source-over, sRGB, unrounded). */
export function overRgb(ink: Rgb, alpha: number, under: Rgb): Rgb {
  const mix = (a: number, b: number) => a * alpha + b * (1 - alpha);
  return [mix(ink[0], under[0]), mix(ink[1], under[1]), mix(ink[2], under[2])];
}

/** `ink` blended with Multiply at full opacity over `under` (unrounded). */
export function multiplyRgb(ink: Rgb, under: Rgb): Rgb {
  return [(ink[0] * under[0]) / 255, (ink[1] * under[1]) / 255, (ink[2] * under[2]) / 255];
}

function linear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function luminance([r, g, b]: Rgb): number {
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG contrast ratio of two opaque colours. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** OKLab (Björn Ottosson, 2020) of an sRGB colour: lightness L, axes a and b. */
function oklab(rgb: Rgb): readonly [number, number, number] {
  const [r, g, b] = rgb.map(linear) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const mm = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * mm - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * mm + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * mm - 0.808675766 * s,
  ];
}

/** The ink perceptually closest to a colour (Euclidean distance in OKLab). */
export function nearestInk(hex: string): Ink {
  const [l, a, b] = oklab(hexRgb(hex));
  let best = INKS[0] as Ink;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const ink of INKS) {
    const [il, ia, ib] = oklab(hexRgb(ink.hex));
    const distance = (l - il) ** 2 + (a - ia) ** 2 + (b - ib) ** 2;
    if (distance < bestDistance) {
      best = ink;
      bestDistance = distance;
    }
  }
  return best;
}

/** Below this OKLCH chroma a colour has no hue to match; it gets the yellow tint. */
const ACHROMATIC = 0.04;

/**
 * The tint closest in hue to a colour (OKLCH hue angle). The tints are all light, so
 * lightness says nothing about which one a dark ink "means": a red ink's tint is pink, a
 * blue ink's is blue. Greys and black get yellow, the default tint.
 */
export function nearestTint(hex: string): Tint {
  const [, a, b] = oklab(hexRgb(hex));
  const yellow = TINTS[0] as Tint;
  if (Math.hypot(a, b) < ACHROMATIC) return yellow;
  const hue = Math.atan2(b, a);
  let best = yellow;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const tint of TINTS) {
    const [, ta, tb] = oklab(hexRgb(tint.hex));
    const d = Math.abs(hue - Math.atan2(tb, ta));
    const distance = Math.min(d, 2 * Math.PI - d);
    if (distance < bestDistance) {
      best = tint;
      bestDistance = distance;
    }
  }
  return best;
}

// --- Migration of stored colours (spec §6: `…:v1` → `…:v2`) ---

/**
 * The colours of the palettes before M8 (pen presets and swatches, style swatches and tool
 * defaults), each with the ink of the same role that replaces it (the spec's "Replaces"
 * column). Yellow was an ink and a text-highlight colour; as an opaque ink it becomes cyan,
 * which took its place among the inks, and in a highlighter role it becomes a tint
 * (`migrateLegacyColor`).
 */
export const LEGACY_INKS: Readonly<Record<string, string>> = {
  '#1F1F1F': INK.black,
  '#000000': INK.black,
  '#1E5BD8': INK.blue,
  '#1E88E5': INK.blue,
  '#E53935': INK.red,
  '#43A047': INK.green,
  '#8E24AA': INK.purple,
  '#FB8C00': INK.orange,
  '#D81B60': INK.pink,
  '#FFD400': INK.cyan,
  '#FFEB3B': INK.cyan,
};

/**
 * A stored colour in the new palette: a colour of the old palettes becomes the new colour
 * of its role, in an ink role (`'ink'`) the ink that replaces it, in a highlighter role
 * (`'tint'`: the text highlight, the note) the nearest tint. Custom colours stay.
 */
export function migrateLegacyColor(hex: string, role: 'ink' | 'tint'): string {
  const h = upper(hex);
  const ink = LEGACY_INKS[h];
  if (ink === undefined) return h;
  return role === 'tint' ? nearestTint(h).hex : ink;
}
