/**
 * Character codes of a text object (review M3): the codes of the operator that drew it,
 * decoded with the font's code-space ranges, and matched to the glyphs PDFium reports
 * (a code whose /ToUnicode value has several characters, such as a ligature, shows as
 * several text-page characters on one origin). Also the /ToUnicode map of Type0 fonts, the
 * source of tier-2 code candidates for them.
 */
import {
  decodePDFRawStream,
  type PDFDict,
  type PDFDocument,
  PDFName,
  type PDFObject,
  PDFRawStream,
  PDFRef,
} from '@cantoo/pdf-lib';
import type { Rect } from '@pdf-editor/document-model';

import type { CharInfo } from './locate';
import type { Point } from './raw';

/** One drawn glyph: its code and the text-page characters it produced. */
export interface GlyphInfo {
  readonly code: number;
  /** What the code reads as (probe.ts). */
  readonly text: string;
  /** Index into `ObjectInfo.chars` of its first character (-1 when not shown). */
  readonly first: number;
  /**
   * Its characters on the text page: several for a ligature, 0 for a space the text page
   * folded into the space before it (it keeps one space of a run).
   */
  readonly count: number;
  /** Origin and box of its first character (undefined when not shown). */
  readonly origin?: Point;
  readonly box?: Rect;
}

function lookup(doc: PDFDocument, value: PDFObject | undefined): PDFObject | undefined {
  return value instanceof PDFRef ? doc.context.lookup(value) : value;
}

function latin1(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return s;
}

function streamText(doc: PDFDocument, value: PDFObject | undefined): string | undefined {
  const stream = lookup(doc, value);
  if (!(stream instanceof PDFRawStream)) return undefined;
  try {
    return latin1(decodePDFRawStream(stream).decode());
  } catch {
    return undefined;
  }
}

/** A code-space range: `bytes`-byte codes from `low` to `high` (byte-wise). */
interface CodeSpace {
  readonly bytes: number;
  readonly low: readonly number[];
  readonly high: readonly number[];
}

function hexBytes(hex: string): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < hex.length; i += 2) out.push(Number.parseInt(hex.slice(i, i + 2), 16));
  return out;
}

function codeSpaces(cmap: string): CodeSpace[] {
  const out: CodeSpace[] = [];
  for (const block of cmap.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/g)) {
    for (const m of (block[1] ?? '').matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const low = hexBytes(m[1] ?? '');
      const high = hexBytes(m[2] ?? '');
      if (low.length > 0 && low.length === high.length) out.push({ bytes: low.length, low, high });
    }
  }
  return out;
}

/** How a font's strings split into codes (undefined: the bytes do not fit the code space). */
type CodeSplitter = (bytes: Uint8Array) => number[] | undefined;

const oneByte: CodeSplitter = (bytes) => Array.from(bytes);

function fixed(width: number): CodeSplitter {
  return (bytes) => {
    if (bytes.length % width !== 0) return undefined;
    const out: number[] = [];
    for (let i = 0; i < bytes.length; i += width) {
      let code = 0;
      for (let k = 0; k < width; k++) code = code * 256 + (bytes[i + k] ?? 0);
      out.push(code);
    }
    return out;
  };
}

function bySpaces(spaces: readonly CodeSpace[]): CodeSplitter {
  const widths = [...new Set(spaces.map((s) => s.bytes))].sort((a, b) => a - b);
  return (bytes) => {
    const out: number[] = [];
    let i = 0;
    while (i < bytes.length) {
      let matched = 0;
      for (const n of widths) {
        if (i + n > bytes.length) break;
        const hit = spaces.some(
          (s) =>
            s.bytes === n &&
            s.low.every((lo, k) => {
              const b = bytes[i + k] ?? 0;
              return b >= lo && b <= (s.high[k] ?? 0);
            }),
        );
        if (hit) {
          matched = n;
          break;
        }
      }
      if (matched === 0) return undefined;
      let code = 0;
      for (let k = 0; k < matched; k++) code = code * 256 + (bytes[i + k] ?? 0);
      out.push(code);
      i += matched;
    }
    return out;
  };
}

/** Whether `font` is a composite (Type0) font. */
export function isType0(font: PDFDict | undefined): boolean {
  return font?.get(PDFName.of('Subtype')) === PDFName.of('Type0');
}

/**
 * The code splitter for a font dictionary; `undefined` for a Type0 font with a predefined
 * CMap we do not ship (the caller then assumes codes of one width).
 */
function splitterOf(doc: PDFDocument, font: PDFDict | undefined): CodeSplitter | undefined {
  if (!isType0(font)) return oneByte;
  const encoding = lookup(doc, font?.get(PDFName.of('Encoding')));
  if (encoding instanceof PDFName) {
    const name = encoding.decodeText();
    return name === 'Identity-H' || name === 'Identity-V' || /UCS2-[HV]$/.test(name)
      ? fixed(2)
      : undefined;
  }
  const cmap = streamText(doc, encoding);
  const spaces = cmap ? codeSpaces(cmap) : [];
  return spaces.length > 0 ? bySpaces(spaces) : undefined;
}

/**
 * The codes a text operator draws, as candidate decodings: one for fonts whose code space is
 * known, else one per plausible code width (the caller keeps the one that matches the text
 * page).
 */
export function codesOf(
  doc: PDFDocument,
  font: PDFDict | undefined,
  strings: readonly Uint8Array[],
): number[][] {
  const split = splitterOf(doc, font);
  const splitters = split ? [split] : [2, 1, 3, 4].map(fixed);
  const out: number[][] = [];
  for (const splitter of splitters) {
    // A code never spans two strings.
    const codes: number[] = [];
    let ok = true;
    for (const s of strings) {
      const part = splitter(s);
      if (!part) {
        ok = false;
        break;
      }
      codes.push(...part);
    }
    if (ok) out.push(codes);
  }
  return out;
}

/**
 * Matches an object's codes to its text-page characters: each code shows its text as one or
 * more characters, except a space the text page folded into the space before it; spaces the
 * text page generated for gaps belong to no code. Undefined when they do not match (the
 * text page dropped or reordered something).
 */
export function alignGlyphs(
  chars: readonly CharInfo[],
  codes: readonly number[],
  textOf: (code: number) => string | undefined,
): GlyphInfo[] | undefined {
  const out: GlyphInfo[] = [];
  let j = 0;
  const skipGenerated = () => {
    while (chars[j]?.generated) j++;
  };
  for (const code of codes) {
    const text = textOf(code);
    if (text === undefined || text.length === 0) return undefined;
    skipGenerated();
    let k = j;
    let shown = '';
    while (k < chars.length && shown.length < text.length) {
      shown += chars[k]?.text ?? '';
      k++;
    }
    const first = chars[j];
    if (first && shown === text) {
      out.push({ code, text, first: j, count: k - j, origin: first.origin, box: first.box });
      j = k;
    } else if (text === ' ') {
      out.push({ code, text, first: -1, count: 0 });
    } else {
      return undefined;
    }
  }
  skipGenerated();
  return j === chars.length ? out : undefined;
}

// ---------------------------------------------------------------------------
// ToUnicode
// ---------------------------------------------------------------------------

function utf16(hex: string): string {
  let s = '';
  for (let i = 0; i + 4 <= hex.length; i += 4) {
    s += String.fromCharCode(Number.parseInt(hex.slice(i, i + 4), 16));
  }
  return s;
}

function codeValue(hex: string): number {
  return Number.parseInt(hex || '0', 16);
}

/** Code → text of a /ToUnicode CMap (bfchar, bfrange with a start value or an array). */
export function parseToUnicodeCMap(cmap: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of (block[1] ?? '').matchAll(/<([0-9A-Fa-f]*)>\s*<([0-9A-Fa-f]*)>/g)) {
      out.set(codeValue(m[1] ?? ''), utf16(m[2] ?? ''));
    }
  }
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const body = block[1] ?? '';
    for (const m of body.matchAll(
      /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]*)>|\[([^\]]*)\])/g,
    )) {
      const lo = codeValue(m[1] ?? '');
      const hi = codeValue(m[2] ?? '');
      if (hi < lo || hi - lo > 0xffff) continue;
      if (m[4] !== undefined) {
        const items = [...m[4].matchAll(/<([0-9A-Fa-f]*)>/g)].map((x) => utf16(x[1] ?? ''));
        items.forEach((text, k) => {
          if (lo + k <= hi) out.set(lo + k, text);
        });
        continue;
      }
      const start = utf16(m[3] ?? '');
      if (start.length === 0) continue;
      const head = start.slice(0, -1);
      const tail = start.charCodeAt(start.length - 1);
      for (let code = lo; code <= hi; code++) {
        out.set(code, head + String.fromCharCode(tail + code - lo));
      }
    }
  }
  return out;
}

/** The font's /ToUnicode map, or undefined when it has none. */
export function toUnicodeOf(
  doc: PDFDocument,
  font: PDFDict | undefined,
): Map<number, string> | undefined {
  const cmap = streamText(doc, font?.get(PDFName.of('ToUnicode')));
  return cmap === undefined ? undefined : parseToUnicodeCMap(cmap);
}

/** Whether a Type0 font's codes are CIDs of an Identity encoding. */
export function isIdentityType0(doc: PDFDocument, font: PDFDict | undefined): boolean {
  if (!isType0(font)) return false;
  const encoding = lookup(doc, font?.get(PDFName.of('Encoding')));
  return encoding instanceof PDFName && /^Identity-[HV]$/.test(encoding.decodeText());
}
