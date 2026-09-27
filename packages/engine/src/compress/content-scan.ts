/**
 * Finds where image XObjects are drawn: a minimal content-stream scanner that tracks the
 * CTM through `q`, `Q` and `cm` and records every `Do` of an image, descending into form
 * XObjects (their /Matrix and /Resources). Everything else (text, paths, inline images,
 * strings) is tokenized and ignored. Used for the effective DPI of each image.
 */
import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  type PDFDocument,
  PDFName,
  PDFNumber,
  type PDFObject,
  PDFRawStream,
  PDFRef,
  PDFStream,
} from '@cantoo/pdf-lib';

export type Matrix = readonly [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** m1 then m2 (PDF convention: [a b c d e f], row vectors). */
export function multiply(m1: Matrix, m2: Matrix): Matrix {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + b1 * c2,
    a1 * b2 + b1 * d2,
    c1 * a2 + d1 * c2,
    c1 * b2 + d1 * d2,
    e1 * a2 + f1 * c2 + e2,
    e1 * b2 + f1 * d2 + f2,
  ];
}

export interface Placement {
  /** Image stream reference, "n g". */
  readonly ref: string;
  readonly page: number;
  /** CTM at the `Do`: the unit square maps to the image's placed box. */
  readonly ctm: Matrix;
}

const MAX_FORM_DEPTH = 12;
const MAX_TOKENS_PER_STREAM = 20_000_000;

type Token =
  | { kind: 'num'; value: number }
  | { kind: 'name'; value: string }
  | { kind: 'op'; value: string };

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITERS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

function isRegular(byte: number): boolean {
  return !WHITESPACE.has(byte) && !DELIMITERS.has(byte);
}

/** Tokens of a content stream: numbers, names and operators; the rest is skipped. */
export function* tokenize(data: Uint8Array): Generator<Token> {
  let i = 0;
  let count = 0;
  const n = data.length;
  while (i < n) {
    if (++count > MAX_TOKENS_PER_STREAM) return;
    const c = data[i] as number;
    if (WHITESPACE.has(c)) {
      i++;
    } else if (c === 0x25) {
      // % comment to end of line
      while (i < n && data[i] !== 0x0a && data[i] !== 0x0d) i++;
    } else if (c === 0x28) {
      // literal string with nesting and escapes
      let depth = 1;
      i++;
      while (i < n && depth > 0) {
        const s = data[i];
        if (s === 0x5c) i += 2;
        else {
          if (s === 0x28) depth++;
          else if (s === 0x29) depth--;
          i++;
        }
      }
    } else if (c === 0x3c) {
      if (data[i + 1] === 0x3c)
        i += 2; // dictionary open
      else {
        while (i < n && data[i] !== 0x3e) i++;
        i++;
      }
    } else if (c === 0x3e) {
      i += data[i + 1] === 0x3e ? 2 : 1;
    } else if (c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d) {
      i++;
    } else if (c === 0x2f) {
      let j = i + 1;
      while (j < n && isRegular(data[j] as number)) j++;
      const raw = String.fromCharCode(...data.subarray(i + 1, j));
      yield {
        kind: 'name',
        value: raw.replace(/#([0-9a-fA-F]{2})/g, (_, hex: string) =>
          String.fromCharCode(Number.parseInt(hex, 16)),
        ),
      };
      i = j;
    } else {
      let j = i;
      while (j < n && isRegular(data[j] as number)) j++;
      if (j === i) {
        i++;
        continue;
      }
      const word = String.fromCharCode(...data.subarray(i, j));
      i = j;
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) {
        yield { kind: 'num', value: Number(word) };
      } else if (word === 'BI') {
        // Inline image: skip to the EI that follows whitespace after ID's binary data.
        const id = indexOfOp(data, 'ID', i);
        if (id < 0) return;
        let k = id + 3;
        while (k < n) {
          if (
            data[k] === 0x45 &&
            data[k + 1] === 0x49 &&
            WHITESPACE.has(data[k - 1] as number) &&
            (k + 2 >= n || WHITESPACE.has(data[k + 2] as number))
          ) {
            break;
          }
          k++;
        }
        i = k + 2;
      } else {
        yield { kind: 'op', value: word };
      }
    }
  }
}

function indexOfOp(data: Uint8Array, op: string, from: number): number {
  const a = op.charCodeAt(0);
  const b = op.charCodeAt(1);
  for (let k = from; k < data.length - 1; k++) {
    if (
      data[k] === a &&
      data[k + 1] === b &&
      WHITESPACE.has(data[k - 1] as number) &&
      (k + 2 >= data.length || WHITESPACE.has(data[k + 2] as number))
    ) {
      return k;
    }
  }
  return -1;
}

function streamBytes(stream: PDFObject | undefined): Uint8Array | undefined {
  if (!(stream instanceof PDFRawStream)) return undefined;
  try {
    return decodePDFRawStream(stream).decode();
  } catch {
    return undefined;
  }
}

function numbers(array: PDFArray | undefined): number[] | undefined {
  if (!array) return undefined;
  const out: number[] = [];
  for (let i = 0; i < array.size(); i++) {
    const v = array.get(i);
    if (!(v instanceof PDFNumber)) return undefined;
    out.push(v.asNumber());
  }
  return out;
}

export const refKey = (ref: PDFRef): string => `${ref.objectNumber} ${ref.generationNumber}`;

/** Scans every page; returns the placements of image XObjects. */
export function findPlacements(doc: PDFDocument): Placement[] {
  const { context } = doc;
  const placements: Placement[] = [];
  const pages = doc.getPages();

  const scan = (
    data: Uint8Array,
    resources: PDFDict | undefined,
    base: Matrix,
    page: number,
    depth: number,
    visiting: Set<string>,
  ) => {
    const xobjects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
    let ctm = base;
    const stack: Matrix[] = [];
    const operands: Token[] = [];
    for (const token of tokenize(data)) {
      if (token.kind !== 'op') {
        operands.push(token);
        if (operands.length > 16) operands.shift();
        continue;
      }
      switch (token.value) {
        case 'q':
          stack.push(ctm);
          break;
        case 'Q':
          ctm = stack.pop() ?? base;
          break;
        case 'cm': {
          const six = operands.slice(-6);
          if (six.length === 6 && six.every((t) => t.kind === 'num')) {
            const m = six.map((t) => (t as { value: number }).value) as unknown as Matrix;
            ctm = multiply(m, ctm);
          }
          break;
        }
        case 'Do': {
          const name = operands.at(-1);
          if (name?.kind !== 'name' || !xobjects) break;
          const raw = xobjects.get(PDFName.of(name.value));
          if (!(raw instanceof PDFRef)) break;
          const target = context.lookup(raw);
          if (!(target instanceof PDFStream)) break;
          const subtype = target.dict.get(PDFName.of('Subtype'));
          if (subtype === PDFName.of('Image')) {
            placements.push({ ref: refKey(raw), page, ctm });
          } else if (subtype === PDFName.of('Form') && depth < MAX_FORM_DEPTH) {
            const key = refKey(raw);
            if (visiting.has(key)) break;
            const bytes = streamBytes(target);
            if (!bytes) break;
            const matrix = numbers(target.dict.lookupMaybe(PDFName.of('Matrix'), PDFArray));
            const formMatrix = matrix?.length === 6 ? (matrix as unknown as Matrix) : IDENTITY;
            const formResources =
              target.dict.lookupMaybe(PDFName.of('Resources'), PDFDict) ?? resources;
            visiting.add(key);
            scan(bytes, formResources, multiply(formMatrix, ctm), page, depth + 1, visiting);
            visiting.delete(key);
          }
          break;
        }
        default:
          break;
      }
      operands.length = 0;
    }
  };

  pages.forEach((page, index) => {
    const contents = page.node.Contents();
    const parts: Uint8Array[] = [];
    if (contents instanceof PDFArray) {
      for (let i = 0; i < contents.size(); i++) {
        const bytes = streamBytes(context.lookup(contents.get(i)));
        if (bytes) parts.push(bytes);
      }
    } else {
      const bytes = streamBytes(contents);
      if (bytes) parts.push(bytes);
    }
    // Content arrays are one stream split anywhere between tokens: join with a space.
    const total = parts.reduce((sum, p) => sum + p.length + 1, 0);
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      joined.set(part, offset);
      offset += part.length;
      joined[offset++] = 0x20;
    }
    scan(joined, page.node.Resources(), IDENTITY, index, 0, new Set());
  });
  return placements;
}

/** Effective pixels per inch of an image of `width` × `height` pixels drawn with `ctm`. */
export function placementDpi(
  width: number,
  height: number,
  ctm: Matrix,
): { readonly x: number; readonly y: number } | null {
  const [a, b, c, d] = ctm;
  const w = Math.hypot(a, b) / 72;
  const h = Math.hypot(c, d) / 72;
  if (w <= 1e-6 || h <= 1e-6) return null;
  return { x: width / w, y: height / h };
}
