/**
 * Text drawn by content streams, read lexically (review finding M1): the byte grep misses a
 * redacted string written kerned across TJ elements (`[(SECRET-)-10(7731)] TJ`), with octal
 * escapes (`(\123ECRET)`) or as spaced hex (`<53 45 43>`). The lexer tokenises a content
 * stream, decodes the string operands of `Tj`, `TJ`, `'` and `"` (literal-string escapes,
 * hex strings with whitespace), joins the elements of a TJ array ignoring its numeric
 * adjustments, and joins consecutive text-showing operators.
 *
 * Positioning does not break the joined text: glyph-by-glyph layouts place every character
 * with its own `Td`, and matching ignores whitespace, so the joined text of a stream
 * behaves like the extracted text of a page. Character codes are read as Latin-1 bytes and,
 * for even-length strings, as UTF-16BE (a font's own encoding is not applied: text in
 * custom encodings is covered by the page-text checks and the blank-region gate only).
 *
 * `contentStreams` finds the streams worth lexing: page contents, Form XObjects (annotation
 * appearances included), tiling patterns and Type3 glyph procedures.
 */

import {
  PDFArray,
  type PDFContext,
  PDFDict,
  type PDFDocument,
  PDFName,
  type PDFObject,
  PDFStream,
} from '@cantoo/pdf-lib';

import { forEachDict } from '../pdflib/metadata-walk';
import { normalizeForMatch } from './strings';

/** The shown text of a stream in both readings of its character codes. */
export interface ShownText {
  /** Every code as one Latin-1 character. */
  readonly latin1: string;
  /** Even-length strings as UTF-16BE (a leading byte-order mark dropped). */
  readonly utf16: string;
}

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
/** `( ) < > [ ] { } / %` */
const DELIMITERS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

const isRegular = (b: number) => !WHITESPACE.has(b) && !DELIMITERS.has(b);

function hexValue(b: number): number {
  if (b >= 0x30 && b <= 0x39) return b - 0x30;
  if (b >= 0x41 && b <= 0x46) return b - 0x37;
  if (b >= 0x61 && b <= 0x66) return b - 0x57;
  return -1;
}

/** An operand: a string's bytes, an array of operands, or anything else (`null`). */
type Operand = Uint8Array | Operand[] | null;

/**
 * Reads a literal string starting after its `(` at `start`; returns the decoded bytes and
 * the index after the closing `)`.
 */
function literalString(data: Uint8Array, start: number): [Uint8Array, number] {
  const out: number[] = [];
  let depth = 1;
  let i = start;
  while (i < data.length) {
    const b = data[i] as number;
    if (b === 0x5c) {
      const next = data[i + 1];
      i += 2;
      if (next === undefined) break;
      switch (next) {
        case 0x6e: // n
          out.push(0x0a);
          break;
        case 0x72: // r
          out.push(0x0d);
          break;
        case 0x74: // t
          out.push(0x09);
          break;
        case 0x62: // b
          out.push(0x08);
          break;
        case 0x66: // f
          out.push(0x0c);
          break;
        case 0x0d: // line continuation (CR or CR LF)
          if (data[i] === 0x0a) i++;
          break;
        case 0x0a: // line continuation (LF)
          break;
        default:
          if (next >= 0x30 && next <= 0x37) {
            let value = next - 0x30;
            for (let k = 0; k < 2; k++) {
              const d = data[i];
              if (d === undefined || d < 0x30 || d > 0x37) break;
              value = value * 8 + (d - 0x30);
              i++;
            }
            out.push(value & 0xff);
          } else out.push(next); // \( \) \\ and unknown escapes: the character itself
      }
      continue;
    }
    if (b === 0x28) depth++;
    else if (b === 0x29 && --depth === 0) return [Uint8Array.from(out), i + 1];
    out.push(b);
    i++;
  }
  return [Uint8Array.from(out), i];
}

/** Reads a hex string starting after its `<`; whitespace (and junk) between digits ignored. */
function hexString(data: Uint8Array, start: number): [Uint8Array, number] {
  const out: number[] = [];
  let high = -1;
  let i = start;
  for (; i < data.length; i++) {
    const b = data[i] as number;
    if (b === 0x3e) {
      i++;
      break;
    }
    const v = hexValue(b);
    if (v < 0) continue;
    if (high < 0) high = v;
    else {
      out.push(high * 16 + v);
      high = -1;
    }
  }
  if (high >= 0) out.push(high * 16); // odd digit count: a trailing 0 is implied
  return [Uint8Array.from(out), i];
}

/** Index after the `EI` that ends the inline image data starting at `start`. */
function skipInlineImage(data: Uint8Array, start: number): number {
  // Find the `ID` operator, then `EI` between whitespace (or at the end).
  let i = start;
  for (; i + 1 < data.length; i++) {
    if (
      data[i] === 0x49 &&
      data[i + 1] === 0x44 &&
      WHITESPACE.has(data[i - 1] ?? 0x20) &&
      (i + 2 >= data.length || WHITESPACE.has(data[i + 2] as number))
    ) {
      i += 3;
      break;
    }
  }
  for (; i + 1 < data.length; i++) {
    if (
      data[i] === 0x45 &&
      data[i + 1] === 0x49 &&
      WHITESPACE.has(data[i - 1] ?? 0x20) &&
      (i + 2 >= data.length || WHITESPACE.has(data[i + 2] as number))
    ) {
      return i + 2;
    }
  }
  return data.length;
}

function latin1(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return s;
}

function utf16be(bytes: Uint8Array): string {
  if (bytes.length % 2 !== 0) return '';
  let from = bytes[0] === 0xfe && bytes[1] === 0xff ? 2 : 0;
  let s = '';
  const units: number[] = [];
  for (; from + 1 < bytes.length; from += 2) {
    units.push(((bytes[from] as number) << 8) | (bytes[from + 1] as number));
    if (units.length === 0x4000) {
      s += String.fromCharCode(...units);
      units.length = 0;
    }
  }
  return s + String.fromCharCode(...units);
}

/** The text shown by content stream `data` (see the module comment). Never throws. */
export function shownText(data: Uint8Array): ShownText {
  const parts: Uint8Array[] = [];
  const stack: Operand[][] = [[]];
  const top = () => stack[stack.length - 1] as Operand[];
  const push = (operand: Operand) => {
    top().push(operand); // bounded by the stream length: no cap that padding could exploit
  };
  const lastString = (): Uint8Array | undefined => {
    const list = top();
    const last = list[list.length - 1];
    return last instanceof Uint8Array ? last : undefined;
  };
  const show = (operand: Operand | undefined) => {
    if (operand instanceof Uint8Array) parts.push(operand);
    else if (Array.isArray(operand)) for (const item of operand) show(item);
  };

  let i = 0;
  const n = data.length;
  while (i < n) {
    const b = data[i] as number;
    if (WHITESPACE.has(b)) {
      i++;
    } else if (b === 0x25) {
      while (i < n && data[i] !== 0x0a && data[i] !== 0x0d) i++;
    } else if (b === 0x28) {
      const [bytes, next] = literalString(data, i + 1);
      push(bytes);
      i = next;
    } else if (b === 0x3c) {
      if (data[i + 1] === 0x3c) {
        push(null); // dictionary (marked-content properties): its contents are not text
        i += 2;
      } else {
        const [bytes, next] = hexString(data, i + 1);
        push(bytes);
        i = next;
      }
    } else if (b === 0x3e) {
      i += data[i + 1] === 0x3e ? 2 : 1;
    } else if (b === 0x5b) {
      if (stack.length < 32) stack.push([]);
      i++;
    } else if (b === 0x5d) {
      if (stack.length > 1) {
        const array = stack.pop() as Operand[];
        push(array);
      }
      i++;
    } else if (b === 0x2f) {
      i++;
      while (i < n && isRegular(data[i] as number)) i++;
      push(null);
    } else if (b === 0x7b || b === 0x7d || b === 0x29) {
      i++;
    } else {
      const start = i;
      while (i < n && isRegular(data[i] as number)) i++;
      // Numbers (and malformed tokens starting like one) are operands; operators are short.
      if ((b >= 0x30 && b <= 0x39) || b === 0x2b || b === 0x2d || b === 0x2e) {
        push(null);
        continue;
      }
      const length = i - start;
      const second = data[start + 1];
      if (length === 1 && (b === 0x27 || b === 0x22)) {
        show(lastString()); // ' and "
      } else if (length === 2 && b === 0x54 && second === 0x6a) {
        show(lastString()); // Tj
      } else if (length === 2 && b === 0x54 && second === 0x4a) {
        const operands = top();
        show(operands[operands.length - 1]); // TJ
      } else if (length === 2 && b === 0x42 && second === 0x49) {
        i = skipInlineImage(data, i); // BI … ID <binary> EI
      }
      // Any operator ends the operand list (one inside an array is malformed: reset too).
      stack.length = 1;
      stack[0] = [];
    }
  }
  return {
    latin1: parts.map(latin1).join(''),
    utf16: parts.map(utf16be).join(''),
  };
}

/** Normalised forms of the shown text of `data`, for needle tests. */
export function normalizedShownText(data: Uint8Array): string[] {
  const text = shownText(data);
  const out = [normalizeForMatch(text.latin1)];
  if (text.utf16 !== '') out.push(normalizeForMatch(text.utf16));
  return out;
}

/** What a content-bearing stream is, for messages. */
export type ContentStreamKind =
  | 'page content'
  | 'form XObject'
  | 'annotation appearance'
  | 'tiling pattern'
  | 'Type3 glyph procedure';

/**
 * Every content-bearing stream of `doc`: page contents, Form XObjects (a /BBox without
 * /Subtype counts: some appearance streams omit it), tiling patterns, the streams of
 * annotation appearance dictionaries and Type3 /CharProcs.
 */
export function contentStreams(doc: PDFDocument): Map<PDFStream, ContentStreamKind> {
  const { context } = doc;
  const out = new Map<PDFStream, ContentStreamKind>();
  const add = (value: PDFObject | undefined, kind: ContentStreamKind) => {
    const stream = context.lookup(value);
    if (stream instanceof PDFStream && !out.has(stream)) out.set(stream, kind);
  };
  for (const page of doc.getPages()) {
    const contents = context.lookup(page.node.get(PDFName.of('Contents')));
    if (contents instanceof PDFArray) {
      for (let i = 0; i < contents.size(); i++) add(contents.get(i), 'page content');
    } else add(contents, 'page content');
  }
  forEachDict(doc, ({ dict, stream }) => {
    if (stream) {
      const subtype = context.lookup(dict.get(PDFName.of('Subtype')));
      const image = subtype === PDFName.of('Image');
      if (
        subtype === PDFName.of('Form') ||
        (!image && subtype === undefined && dict.has(PDFName.of('BBox')))
      ) {
        if (dict.has(PDFName.of('PatternType'))) add(stream, 'tiling pattern');
        else add(stream, 'form XObject');
      } else if (dict.has(PDFName.of('PatternType'))) add(stream, 'tiling pattern');
      return;
    }
    const charProcs = context.lookup(dict.get(PDFName.of('CharProcs')));
    if (charProcs instanceof PDFDict) {
      for (const [, proc] of charProcs.entries()) add(proc, 'Type3 glyph procedure');
    }
    const ap = context.lookup(dict.get(PDFName.of('AP')));
    if (ap instanceof PDFDict) {
      for (const [, entry] of ap.entries())
        appearanceStreams(context, entry, (s) => add(s, 'annotation appearance'));
    }
  });
  return out;
}

function appearanceStreams(
  context: PDFContext,
  entry: PDFObject | undefined,
  visit: (s: PDFStream) => void,
) {
  const value = context.lookup(entry);
  if (value instanceof PDFStream) visit(value);
  else if (value instanceof PDFDict) {
    for (const [, state] of value.entries()) {
      const s = context.lookup(state);
      if (s instanceof PDFStream) visit(s);
    }
  }
}
