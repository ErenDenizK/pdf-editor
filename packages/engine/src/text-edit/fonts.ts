/**
 * Fonts for text editing (spec §2.3, §2.5): classification of a run's font, the bundled
 * face that substitutes it in tier 1 (name and flag heuristics), and the fontkit subset
 * loaded into PDFium with `FPDFText_LoadCidType2Font` (research 05 §3 step 3).
 *
 * Faces are the bundle in assets/fonts (Inter, JetBrains Mono, Noto Serif, Noto Sans; Latin,
 * Greek, Cyrillic; subset by the `pyftsubset` runs recorded in its LICENSES.md). The class
 * decision and the per-character face order of the paragraph editor live in
 * `fonts/substitutes.ts` (craft §4.5); the single-line editor keeps `substituteFace` and
 * `faceCandidates` below. Characters no face covers fail with `unsupported-chars`. Italics
 * are synthesised (12° skew), as in page furniture.
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
import { substituteClass } from '../fonts/substitutes';
import type { TextFontKind, TextRunFont } from '../types';
import type { FontFacts, RawText } from './raw';

/** Font descriptor flags (ISO 32000-2 Table 121). */
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
  const cls = substituteClass(facts);
  const monospace = cls === 'mono';
  const serif = cls === 'serif';
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

/** Largest font program read for its PANOSE bytes (bigger programs are left unread). */
const PANOSE_READ_LIMIT = 8 * 1024 * 1024;

/**
 * The PANOSE bytes of a TrueType or OpenType program (the `OS/2` table, offset 32), or
 * undefined: bare CFF, Type 1, a missing table, or all zeros ("any").
 */
export function panoseOfProgram(bytes: Uint8Array): number[] | undefined {
  if (bytes.length < 12) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = view.getUint32(0);
  // 0x00010000 (TrueType), 'OTTO' (CFF-flavoured OpenType), 'true' (Apple TrueType).
  if (tag !== 0x00010000 && tag !== 0x4f54544f && tag !== 0x74727565) return undefined;
  const tables = view.getUint16(4);
  for (let i = 0; i < tables; i++) {
    const record = 12 + i * 16;
    if (record + 16 > bytes.length) return undefined;
    if (view.getUint32(record) !== 0x4f532f32) continue; // 'OS/2'
    const offset = view.getUint32(record + 8);
    if (offset + 42 > bytes.length) return undefined;
    const panose = Array.from(bytes.subarray(offset + 32, offset + 42));
    return panose.some((b) => b !== 0) ? panose : undefined;
  }
  return undefined;
}

/** The PANOSE bytes of `font`'s program as PDFium holds it (`FPDFFont_GetFontData`). */
export function readPanose(raw: RawText, font: number, dataBytes: number): number[] | undefined {
  if (dataBytes <= 0 || dataBytes > PANOSE_READ_LIMIT) return undefined;
  const { mem, m } = raw;
  return mem.withMem(dataBytes, (buffer) =>
    mem.withMem(8, (length) => {
      if (!m.FPDFFont_GetFontData(font, buffer, dataBytes, length)) return undefined;
      const read = Math.min(dataBytes, mem.u32(length));
      return panoseOfProgram(mem.heap().HEAPU8.slice(buffer, buffer + read));
    }),
  );
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
