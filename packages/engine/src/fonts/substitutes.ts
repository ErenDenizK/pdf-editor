/**
 * The bundled face a character the original font lacks is set in (craft spec §4.5, ADR-0020
 * §5): pure decisions, shared by the engine (writer, layout input) and the app (the overlay's
 * CSS fallback chain). No fetch, no font parsing.
 *
 * **Class.** A font is monospaced, serif or sans, decided in this order:
 * 1. monospaced: the FixedPitch flag, PANOSE proportion 9, or a name such as Courier, Mono,
 *    Consolas, Menlo, Typewriter, Code or CMTT;
 * 2. sans: the name says "Sans" (Noto Sans, DejaVu Sans, Open Sans…), whatever the flags;
 * 3. PANOSE (Latin text, family kind 2), when the font program has it: serif styles 2–10 are
 *    serif, 11–15 (normal, obtuse, perpendicular, flared, rounded sans) are sans;
 * 4. serif: the Serif flag, or a name such as Times, Georgia, Garamond, Roman, Serif, Nimbus
 *    Roman or TeX's CMR;
 * 5. otherwise sans.
 *
 * **Faces, in order.** A font that is a copy of a bundled family (an embedded Inter subset)
 * tries that family first. Then the class's faces of the font's weight, then the class's
 * other faces, then every other bundled face (same weight first): a character the class's faces lack is
 * still set rather than refused, and only characters no bundled face has are refused.
 * - serif: Noto Serif;
 * - monospaced: JetBrains Mono;
 * - sans: Noto Sans when it has the character, else Inter. Noto Sans is bundled in regular
 *   only, so a bold sans font tries Inter Bold first (the weight matters more than the face).
 *
 * **Size.** The substitute is scaled so its x-height matches the original's: the original's
 * x-height from its font metrics (standard-14 AFM values) or measured from its "x" (or another
 * flat-topped lowercase letter); failing that, the cap heights are matched; failing both, 1.
 * The factor stays within 0.8–1.25 so a bad measurement cannot blow a glyph up.
 */
import {
  BUNDLED_FACES,
  BUNDLED_FAMILIES,
  type BundledFace,
  type BundledFamilyId,
} from './font-catalog';

export type SubstituteClass = 'serif' | 'mono' | 'sans';

/** What the class decision reads from a font (descriptor, names, program). */
export interface FontClassFacts {
  /** PostScript name, with or without its subset tag. */
  readonly baseName: string;
  /** Family name, when the font has one. */
  readonly familyName?: string;
  /** Font descriptor /Flags (ISO 32000-2 Table 121). */
  readonly flags: number;
  /** PANOSE classification (10 bytes, OS/2 table), when the font program has one. */
  readonly panose?: ArrayLike<number>;
}

/** Font descriptor flags (ISO 32000-2 Table 121). */
const FLAG_FIXED_PITCH = 1;
const FLAG_SERIF = 2;

/** PANOSE: family kind "Latin text", proportion "monospaced". */
const PANOSE_LATIN_TEXT = 2;
const PANOSE_MONOSPACED = 9;

const MONO_NAME = /mono|courier|consol|menlo|typewriter|fixed|code|^cmtt\d/;
/** Serif names; `cm…` are TeX's Computer Modern roman, bold, italic, slanted and caps faces. */
const SERIF_NAME =
  /times|serif|roman|georgia|garamond|cambria|minion|palatino|baskerville|caslon|century|didot|bodoni|charter|merriweather|nimbusrom|libertin|stix|^cm(r|bx|ti|sl|csc|mi|b)\d/;

function nameOf(facts: FontClassFacts): string {
  const base = facts.baseName.replace(/^[A-Z]{6}\+/, '');
  return `${base} ${facts.familyName ?? ''}`.toLowerCase();
}

/** The PANOSE class of a Latin text font, or undefined when it does not say. */
function panoseClass(panose: ArrayLike<number> | undefined): SubstituteClass | undefined {
  if (!panose || panose.length < 4 || panose[0] !== PANOSE_LATIN_TEXT) return undefined;
  if (panose[3] === PANOSE_MONOSPACED) return 'mono';
  const serifStyle = panose[1] ?? 0;
  if (serifStyle >= 2 && serifStyle <= 10) return 'serif';
  if (serifStyle >= 11 && serifStyle <= 15) return 'sans';
  return undefined;
}

/** Whether the font is monospaced (flag, PANOSE proportion or name). */
export function isMonospaced(facts: FontClassFacts): boolean {
  return (
    (facts.flags & FLAG_FIXED_PITCH) !== 0 ||
    (facts.panose?.[0] === PANOSE_LATIN_TEXT && facts.panose[3] === PANOSE_MONOSPACED) ||
    MONO_NAME.test(nameOf(facts))
  );
}

/** The substitute class of a font (see the module comment for the order of the rules). */
export function substituteClass(facts: FontClassFacts): SubstituteClass {
  if (isMonospaced(facts)) return 'mono';
  const name = nameOf(facts);
  if (name.includes('sans')) return 'sans';
  const byPanose = panoseClass(facts.panose);
  if (byPanose) return byPanose;
  if ((facts.flags & FLAG_SERIF) !== 0 || SERIF_NAME.test(name)) return 'serif';
  return 'sans';
}

/** The bundled families of each class, in the order they are tried. */
const CLASS_FAMILIES: Readonly<Record<SubstituteClass, readonly BundledFamilyId[]>> = {
  serif: ['noto-serif'],
  mono: ['jetbrains-mono'],
  sans: ['noto-sans', 'inter'],
};

/** The bundled families of a class, in the order they are tried. */
export function classFamilies(cls: SubstituteClass): readonly BundledFamilyId[] {
  return CLASS_FAMILIES[cls];
}

/**
 * Every bundled face, in the order a missing character tries them for a font of class `cls`
 * and weight (see the module comment). `faces` defaults to the bundle; a face that does not
 * exist is simply absent.
 */
export function substituteCandidates(
  cls: SubstituteClass,
  bold: boolean,
  faces: readonly BundledFace[] = BUNDLED_FACES,
  same?: BundledFamilyId,
): BundledFace[] {
  const weight = bold ? 700 : 400;
  const families = same
    ? [same, ...CLASS_FAMILIES[cls].filter((f) => f !== same)]
    : CLASS_FAMILIES[cls];
  const rank = (face: BundledFace): number => {
    const family = families.indexOf(face.family);
    const sameWeight = face.weight === weight;
    if (family >= 0) return (sameWeight ? 0 : 100) + family;
    return (sameWeight ? 200 : 300) + faces.indexOf(face);
  };
  return [...faces].sort((a, b) => rank(a) - rank(b) || faces.indexOf(a) - faces.indexOf(b));
}

/**
 * The bundled family a font is a copy of, by its PostScript name (`ABCDEF+Inter-Bold` →
 * `inter`, `NotoSerif-Italic` → `noto-serif`); undefined for any other font. Such a font's
 * missing characters go to its own family first, whatever its class.
 */
export function bundledFamilyOfFont(baseName: string): BundledFamilyId | undefined {
  const family = (baseName.replace(/^[A-Z]{6}\+/, '').split(/[-,]/)[0] ?? '')
    .replace(/[\s_]+/g, '')
    .toLowerCase();
  const hit = BUNDLED_FAMILIES.find((f) => f.name.replace(/\s+/g, '').toLowerCase() === family);
  return hit?.id;
}

/** Display name of a bundled face's family (`Noto Sans`), or the key itself when unknown. */
export function faceFamilyName(key: string): string {
  const face = BUNDLED_FACES.find((f) => f.key === key);
  return BUNDLED_FAMILIES.find((f) => f.id === face?.family)?.name ?? key;
}

/** x-heights and cap heights of the standard-14 fonts (AFM XHeight, CapHeight / 1000). */
const STANDARD_METRICS: Readonly<Record<string, readonly [xHeight: number, capHeight: number]>> = {
  Helvetica: [0.523, 0.718],
  'Helvetica-Oblique': [0.523, 0.718],
  'Helvetica-Bold': [0.532, 0.718],
  'Helvetica-BoldOblique': [0.532, 0.718],
  'Times-Roman': [0.448, 0.662],
  'Times-Bold': [0.461, 0.676],
  'Times-Italic': [0.441, 0.653],
  'Times-BoldItalic': [0.462, 0.669],
  Courier: [0.426, 0.562],
  'Courier-Oblique': [0.426, 0.562],
  'Courier-Bold': [0.439, 0.562],
  'Courier-BoldOblique': [0.439, 0.562],
};

/** AFM x-height and cap height of a standard-14 font by name; undefined for any other font. */
export function standardFontMetrics(
  baseName: string,
): { readonly xHeight: number; readonly capHeight: number } | undefined {
  const plain = (baseName.replace(/^[A-Z]{6}\+/, '').split(',')[0] ?? '').trim();
  const hit = Object.hasOwn(STANDARD_METRICS, plain) ? STANDARD_METRICS[plain] : undefined;
  return hit ? { xHeight: hit[0], capHeight: hit[1] } : undefined;
}

/** Letters whose top is the x-height (flat-topped lowercase), tried in this order. */
export const X_HEIGHT_LETTERS = ['x', 'z', 'v', 'w'] as const;
/** Letters whose top is the cap height (flat-topped capitals), tried in this order. */
export const CAP_HEIGHT_LETTERS = ['H', 'E', 'I', 'T'] as const;

/** Bounds of the substitute's size factor. */
export const SUBSTITUTE_SCALE_MIN = 0.8;
export const SUBSTITUTE_SCALE_MAX = 1.25;

/**
 * The size factor that matches the original's x-height (or, without one, its cap height) to
 * the face's, both as fractions of the font size; 1 when neither is known.
 */
export function substituteScale(
  original: { readonly xHeight?: number; readonly capHeight?: number },
  face: Pick<BundledFace, 'xHeight' | 'capHeight'>,
): number {
  let ratio: number | undefined;
  if (original.xHeight !== undefined && original.xHeight > 0 && face.xHeight > 0) {
    ratio = original.xHeight / face.xHeight;
  } else if (original.capHeight !== undefined && original.capHeight > 0 && face.capHeight > 0) {
    ratio = original.capHeight / face.capHeight;
  }
  if (ratio === undefined || !Number.isFinite(ratio)) return 1;
  return Math.min(SUBSTITUTE_SCALE_MAX, Math.max(SUBSTITUTE_SCALE_MIN, ratio));
}
