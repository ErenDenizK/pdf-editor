/**
 * The fonts page furniture can use, shared by the assembler (embedding) and the app's live
 * preview (CSS @font-face). Pure data and functions: no fetch, no pdf-lib.
 *
 * Bundled families (SIL OFL 1.1, subset to Latin, Latin Extended, Greek and Cyrillic; see
 * packages/engine/assets/fonts/LICENSES.md):
 * - Inter: regular and bold;
 * - JetBrains Mono: regular only (bold is synthesized: fill + stroke);
 * - Noto Serif: regular and bold;
 * - Noto Sans: regular only, with a wider Latin, Greek and Cyrillic repertoire (IPA, Greek
 *   Extended, Latin Extended C–E, Cyrillic Extended). It is not offered to page furniture
 *   (`FONT_FAMILIES` in the app); the paragraph editor sets characters in it (craft §4.5).
 * No italic files are bundled: italic is synthesized by skewing the glyphs by
 * `SYNTHETIC_ITALIC_DEGREES`, in the PDF (text matrix) and in the preview (SVG skewX).
 *
 * Any other family falls back to the matching standard-14 font (Helvetica, Times,
 * Courier), which only covers WinAnsi; the assembler then substitutes the closest bundled
 * family for text the standard font cannot encode.
 */
import type { FontSpec } from '@pdf-editor/document-model';

export type BundledFamilyId = 'inter' | 'jetbrains-mono' | 'noto-serif' | 'noto-sans';

export interface BundledFamily {
  readonly id: BundledFamilyId;
  /** The `FontSpec.family` value the UI writes. */
  readonly name: string;
  /** Generic CSS fallback while the face loads. */
  readonly generic: 'sans-serif' | 'monospace' | 'serif';
}

export const BUNDLED_FAMILIES: readonly BundledFamily[] = [
  { id: 'inter', name: 'Inter', generic: 'sans-serif' },
  { id: 'jetbrains-mono', name: 'JetBrains Mono', generic: 'monospace' },
  { id: 'noto-serif', name: 'Noto Serif', generic: 'serif' },
  { id: 'noto-sans', name: 'Noto Sans', generic: 'sans-serif' },
];

export interface BundledFace {
  /** Stable key, also the file stem in assets/fonts (e.g. "Inter-Bold"). */
  readonly key: string;
  readonly family: BundledFamilyId;
  readonly weight: 400 | 700;
  /** Cap height as a fraction of the font size (OS/2 sCapHeight / unitsPerEm). */
  readonly capHeight: number;
  /** x-height as a fraction of the font size (OS/2 sxHeight / unitsPerEm). */
  readonly xHeight: number;
}

export const BUNDLED_FACES: readonly BundledFace[] = [
  {
    key: 'Inter-Regular',
    family: 'inter',
    weight: 400,
    capHeight: 1490 / 2048,
    xHeight: 1118 / 2048,
  },
  { key: 'Inter-Bold', family: 'inter', weight: 700, capHeight: 1490 / 2048, xHeight: 1118 / 2048 },
  {
    key: 'JetBrainsMono-Regular',
    family: 'jetbrains-mono',
    weight: 400,
    capHeight: 0.73,
    xHeight: 0.55,
  },
  { key: 'NotoSerif-Regular', family: 'noto-serif', weight: 400, capHeight: 0.714, xHeight: 0.536 },
  { key: 'NotoSerif-Bold', family: 'noto-serif', weight: 700, capHeight: 0.714, xHeight: 0.536 },
  { key: 'NotoSans-Regular', family: 'noto-sans', weight: 400, capHeight: 0.714, xHeight: 0.536 },
];

/** Skew angle (degrees, glyph tops lean right) of synthesized italics. */
export const SYNTHETIC_ITALIC_DEGREES = 12;
/** Stroke width, as a fraction of the font size, of synthesized bold. */
export const SYNTHETIC_BOLD_STROKE = 0.03;

export type StandardFamily = 'Helvetica' | 'Times' | 'Courier';

/** Cap heights of the standard-14 families (AFM CapHeight / 1000). */
const STANDARD_CAP_HEIGHT: Readonly<Record<StandardFamily, number>> = {
  Helvetica: 0.718,
  Times: 0.662,
  Courier: 0.571,
};

export type ResolvedFont =
  | {
      readonly kind: 'bundled';
      readonly face: BundledFace;
      readonly family: BundledFamily;
      readonly syntheticBold: boolean;
      readonly syntheticItalic: boolean;
      readonly capHeight: number;
    }
  | {
      readonly kind: 'standard';
      readonly family: StandardFamily;
      readonly bold: boolean;
      readonly italic: boolean;
      readonly capHeight: number;
      /** Bundled family used for text the standard font cannot encode. */
      readonly substitute: BundledFamilyId;
    };

function normalizeFamily(family: string): string {
  return family
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ');
}

/** The bundled family a `FontSpec.family` names, or undefined. */
export function bundledFamilyOf(family: string): BundledFamily | undefined {
  const key = normalizeFamily(family);
  return BUNDLED_FAMILIES.find(
    (f) => normalizeFamily(f.name) === key || normalizeFamily(f.id) === key,
  );
}

function standardFamilyOf(family: string): StandardFamily {
  const key = normalizeFamily(family);
  if (key.includes('courier') || key.includes('mono')) return 'Courier';
  if ((key.includes('times') || key.includes('serif')) && !key.includes('sans')) return 'Times';
  return 'Helvetica';
}

const SUBSTITUTE: Readonly<Record<StandardFamily, BundledFamilyId>> = {
  Helvetica: 'inter',
  Times: 'noto-serif',
  Courier: 'jetbrains-mono',
};

/** The closest bundled face for a family and weight (bold falls back to regular). */
export function bundledFace(family: BundledFamilyId, weight: 400 | 700): BundledFace {
  const faces = BUNDLED_FACES.filter((f) => f.family === family);
  const face = faces.find((f) => f.weight === weight) ?? faces[0];
  if (!face) throw new Error(`No bundled face for ${family}`);
  return face;
}

/** Resolves a FontSpec to a bundled face (with synthesis flags) or a standard font. */
export function resolveFont(spec: FontSpec): ResolvedFont {
  const weight = spec.weight === 700 ? 700 : 400;
  const italic = spec.italic === true;
  const family = bundledFamilyOf(spec.family);
  if (family) {
    const face = bundledFace(family.id, weight);
    return {
      kind: 'bundled',
      face,
      family,
      syntheticBold: weight === 700 && face.weight !== 700,
      syntheticItalic: italic,
      capHeight: face.capHeight,
    };
  }
  const standard = standardFamilyOf(spec.family);
  return {
    kind: 'standard',
    family: standard,
    bold: weight === 700,
    italic,
    capHeight: STANDARD_CAP_HEIGHT[standard],
    substitute: SUBSTITUTE[standard],
  };
}

/** Resolution used for text the standard font cannot encode. */
export function substituteFont(spec: FontSpec): ResolvedFont {
  const resolved = resolveFont(spec);
  if (resolved.kind === 'bundled') return resolved;
  const family = BUNDLED_FAMILIES.find((f) => f.id === resolved.substitute);
  return resolveFont({ ...spec, family: family?.name ?? 'Inter' });
}
