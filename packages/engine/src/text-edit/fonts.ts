/**
 * Fonts for text editing (spec §2.3, §2.5): classification of a run's font, the bundled
 * face that substitutes it in tier 1 (name and flag heuristics), and the fontkit subset
 * loaded into PDFium with `FPDFText_LoadCidType2Font` (research 05 §3 step 3).
 *
 * Faces are the M3 bundle (Inter, JetBrains Mono, Noto Serif; Latin, Greek, Cyrillic).
 * Noto Sans (spec §2.3, wider coverage) is a follow-up: the bundle is produced by a manual
 * `pyftsubset` run (assets/fonts/LICENSES.md), not by a script in the repository, so adding
 * a face is not reproducible here yet. A face listed in `BUNDLED_FACES` is used as soon as
 * it exists; characters no face covers fail with `unsupported-chars`. Italics are
 * synthesised (12° skew), as in page furniture.
 */
import fontkit, { type Font } from '@cantoo/fontkit';

import { loadBundledFont } from '../fonts/bundled-fonts';
import {
  BUNDLED_FACES,
  BUNDLED_FAMILIES,
  type BundledFace,
  type BundledFamilyId,
  bundledFace,
  SYNTHETIC_ITALIC_DEGREES,
} from '../fonts/font-catalog';
import type { TextFontKind, TextRunFont } from '../types';
import type { FontFacts } from './raw';

/** Font descriptor flags (ISO 32000-2 Table 121). */
const FLAG_FIXED_PITCH = 1;
const FLAG_SERIF = 2;
const FLAG_ITALIC = 64;
const FLAG_FORCE_BOLD = 1 << 18;

const STANDARD_14 = new Set([
  'Courier',
  'Courier-Bold',
  'Courier-Oblique',
  'Courier-BoldOblique',
  'Helvetica',
  'Helvetica-Bold',
  'Helvetica-Oblique',
  'Helvetica-BoldOblique',
  'Times-Roman',
  'Times-Bold',
  'Times-Italic',
  'Times-BoldItalic',
  'Symbol',
  'ZapfDingbats',
]);

/** Standard-14 fonts without a WinAnsi (StandardEncoding) text encoding. */
const SYMBOLIC_STANDARD = new Set(['Symbol', 'ZapfDingbats']);

/** `ABCDEF+Name` → `Name`. */
export function stripSubsetTag(name: string): string {
  return name.replace(/^[A-Z]{6}\+/, '');
}

function standardName(baseName: string): string | undefined {
  const plain = stripSubsetTag(baseName).split(',')[0] ?? '';
  return STANDARD_14.has(plain) ? plain : undefined;
}

/** Whether a (non-embedded) standard-14 font is Symbol or ZapfDingbats. */
export function isSymbolicStandard(baseName: string): boolean {
  const name = standardName(baseName);
  return name !== undefined && SYMBOLIC_STANDARD.has(name);
}

const MONO = /mono|courier|consol|menlo|typewriter|fixed|code/;
const SERIF =
  /times|serif|roman|georgia|garamond|cambria|minion|palatino|baskerville|caslon|century|didot|bodoni|charter|merriweather/;
const BOLD = /bold|black|heavy|semibold|demibold|extrabold|ultrabold/;
const ITALIC = /italic|oblique|slanted/;

/** Kind and style heuristics of a run's font (research 05 §5: Type3 has no program). */
export function classifyFont(facts: FontFacts): TextRunFont {
  let kind: TextFontKind;
  if (facts.embedded && facts.dataBytes === 0) kind = 'type3';
  else if (facts.embedded) kind = 'embedded';
  else if (standardName(facts.baseName) !== undefined) kind = 'standard14';
  else kind = 'not-embedded';
  const name = `${stripSubsetTag(facts.baseName)} ${facts.familyName}`.toLowerCase();
  const monospace = (facts.flags & FLAG_FIXED_PITCH) !== 0 || MONO.test(name);
  const serif =
    !monospace && !name.includes('sans') && ((facts.flags & FLAG_SERIF) !== 0 || SERIF.test(name));
  return {
    baseName: facts.baseName,
    embedded: facts.embedded,
    kind,
    flags: facts.flags,
    bold: BOLD.test(name) || facts.weight >= 600 || (facts.flags & FLAG_FORCE_BOLD) !== 0,
    italic: ITALIC.test(name) || (facts.flags & FLAG_ITALIC) !== 0 || facts.italicAngle !== 0,
    monospace,
    serif,
  };
}

/** Characters WinAnsiEncoding can encode (ISO 32000-2 Annex D). */
const WIN_ANSI_EXTRA = new Set(
  Array.from('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ').map((c) => c.codePointAt(0) ?? 0),
);

export function isWinAnsi(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  return (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff) || WIN_ANSI_EXTRA.has(cp);
}

/** Whitespace is drawn without an outline, so the glyph-path pre-check skips it. */
export function isBlank(ch: string): boolean {
  return /\s/u.test(ch);
}

// ---------------------------------------------------------------------------
// Bundled faces
// ---------------------------------------------------------------------------

/** The bundled face whose family and weight match the original (spec §2.3). */
export function substituteFace(font: TextRunFont): BundledFace {
  const family: BundledFamilyId = font.monospace
    ? 'jetbrains-mono'
    : font.serif
      ? 'noto-serif'
      : 'inter';
  return bundledFace(family, font.bold ? 700 : 400);
}

/** Display name of a face's family (`Inter`, `JetBrains Mono`, `Noto Serif`). */
export function familyName(face: BundledFace): string {
  return BUNDLED_FAMILIES.find((f) => f.id === face.family)?.name ?? face.key;
}

/** Faces to try, the preferred one first, for characters it lacks. */
export function faceCandidates(preferred: BundledFace): BundledFace[] {
  const rest = BUNDLED_FACES.filter((f) => f !== preferred).sort(
    (a, b) =>
      Number(b.weight === preferred.weight) - Number(a.weight === preferred.weight) ||
      BUNDLED_FACES.indexOf(a) - BUNDLED_FACES.indexOf(b),
  );
  return [preferred, ...rest];
}

export function faceByKey(key: string): BundledFace | undefined {
  return BUNDLED_FACES.find((f) => f.key === key);
}

/** Loads bundled face programs (bytes) on demand; tests may inject their own loader. */
export type FaceLoader = (face: BundledFace) => Promise<Uint8Array>;

/** Parsed bundled faces, loaded once per realm (the worker). */
export class FaceCache {
  private readonly parsed = new Map<string, Promise<Font>>();

  constructor(private readonly load: FaceLoader = loadBundledFont) {}

  get(face: BundledFace): Promise<Font> {
    let pending = this.parsed.get(face.key);
    if (!pending) {
      pending = this.load(face).then((bytes) => fontkit.create(bytes) as Font);
      pending.catch(() => this.parsed.delete(face.key));
      this.parsed.set(face.key, pending);
    }
    return pending;
  }
}

/** Characters of `text` the face has no glyph for. */
export function missingInFace(font: Font, text: string): string[] {
  const missing = new Set<string>();
  for (const ch of text) {
    const glyph = font.glyphForCodePoint(ch.codePointAt(0) ?? 0);
    if (!glyph || glyph.id === 0) missing.add(ch);
  }
  return [...missing];
}

/** Advance width of `text` in `font` at size 1 (no kerning: one glyph per code point). */
export function faceAdvance(font: Font, text: string): number {
  let width = 0;
  for (const ch of text) {
    const glyph = font.glyphForCodePoint(ch.codePointAt(0) ?? 0);
    width += (glyph?.advanceWidth ?? 0) / font.unitsPerEm;
  }
  return width;
}

/** Tangent of the synthetic italic skew. */
export const ITALIC_SKEW = Math.tan((SYNTHETIC_ITALIC_DEGREES * Math.PI) / 180);

// ---------------------------------------------------------------------------
// Subsets for FPDFText_LoadCidType2Font
// ---------------------------------------------------------------------------

export interface FaceSubset {
  /** The TrueType program holding .notdef and the glyphs of the text. */
  readonly program: Uint8Array;
  /** One CID (= subset glyph id) per code point of the text. */
  readonly codes: readonly number[];
  readonly toUnicode: string;
  /** Identity CIDToGIDMap up to the largest CID (big-endian uint16 per CID). */
  readonly cidToGid: Uint8Array;
}

/** Subset of `font` covering `text` (throws when a glyph is missing). */
export function buildSubset(font: Font, text: string): FaceSubset {
  const subset = font.createSubset();
  const codes: number[] = [];
  const unicodeOf = new Map<number, string>();
  for (const ch of text) {
    const glyph = font.glyphForCodePoint(ch.codePointAt(0) ?? 0);
    if (!glyph || glyph.id === 0) throw new Error(`The bundled face has no glyph for ${ch}`);
    const cid = subset.includeGlyph(glyph);
    codes.push(cid);
    if (!unicodeOf.has(cid)) unicodeOf.set(cid, ch);
  }
  const program = subset.encode();
  const maxCid = Math.max(0, ...codes);
  const cidToGid = new Uint8Array((maxCid + 1) * 2);
  for (let cid = 0; cid <= maxCid; cid++) {
    cidToGid[2 * cid] = cid >> 8;
    cidToGid[2 * cid + 1] = cid & 0xff;
  }
  return { program, codes, toUnicode: toUnicodeCMap(unicodeOf), cidToGid };
}

function hex(n: number, width: number): string {
  return n.toString(16).toUpperCase().padStart(width, '0');
}

/** A ToUnicode CMap mapping 2-byte CIDs to UTF-16BE. */
export function toUnicodeCMap(unicodeOf: ReadonlyMap<number, string>): string {
  const entries = [...unicodeOf.entries()].sort((a, b) => a[0] - b[0]);
  const lines = entries.map(([cid, ch]) => {
    let utf16 = '';
    for (let i = 0; i < ch.length; i++) utf16 += hex(ch.charCodeAt(i), 4);
    return `<${hex(cid, 4)}> <${utf16}>`;
  });
  const blocks: string[] = [];
  // At most 100 entries per bfchar block (PDF CMap syntax).
  for (let i = 0; i < lines.length; i += 100) {
    const chunk = lines.slice(i, i + 100);
    blocks.push(`${chunk.length} beginbfchar`, ...chunk, 'endbfchar');
  }
  return [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
    ...blocks,
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
  ].join('\n');
}
