/**
 * Small pdf-lib helpers shared by the scrub and the forensic check: rectangles of
 * annotations, colours, stream decoding and reachability.
 */

import {
  decodePDFRawStream,
  PDFArray,
  type PDFContext,
  PDFDict,
  PDFFlateStream,
  PDFName,
  PDFNumber,
  type PDFObject,
  PDFRawStream,
  PDFRef,
  PDFStream,
} from '@cantoo/pdf-lib';
import type { Rect } from '@pdf-editor/document-model';

/** Positive-area overlap of two rectangles (touching edges do not count). */
export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function numbers(context: PDFContext, value: PDFObject | undefined): number[] | undefined {
  const array = context.lookup(value);
  if (!(array instanceof PDFArray)) return undefined;
  const out: number[] = [];
  for (let i = 0; i < array.size(); i++) {
    const n = context.lookup(array.get(i));
    if (!(n instanceof PDFNumber) || !Number.isFinite(n.asNumber())) return undefined;
    out.push(n.asNumber());
  }
  return out;
}

/** A PDF rectangle array `[x1 y1 x2 y2]` (any corner order) as a Rect. */
export function rectOf(context: PDFContext, value: PDFObject | undefined): Rect | undefined {
  const n = numbers(context, value);
  if (n?.length !== 4) return undefined;
  const [x1, y1, x2, y2] = n as [number, number, number, number];
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

/** Bounding boxes of an annotation's /Rect and each /QuadPoints quadrilateral. */
export function annotationRects(context: PDFContext, annot: PDFDict): Rect[] {
  const out: Rect[] = [];
  const rect = rectOf(context, annot.get(PDFName.of('Rect')));
  if (rect) out.push(rect);
  const quads = numbers(context, annot.get(PDFName.of('QuadPoints'))) ?? [];
  for (let i = 0; i + 8 <= quads.length; i += 8) {
    const xs = [quads[i], quads[i + 2], quads[i + 4], quads[i + 6]] as number[];
    const ys = [quads[i + 1], quads[i + 3], quads[i + 5], quads[i + 7]] as number[];
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    out.push({ x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y });
  }
  return out;
}

/** The annotation lies (partly) in one of `areas`. */
export function annotationInAreas(context: PDFContext, annot: PDFDict, areas: readonly Rect[]) {
  const rects = annotationRects(context, annot);
  return rects.some((r) => areas.some((a) => intersects(r, a)));
}

export type Rgb = readonly [number, number, number];

/** `#rgb` / `#rrggbb` as 0..1 components; `undefined` for anything else. */
export function parseColor(value: string | undefined): Rgb | undefined {
  if (value === undefined) return undefined;
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!m?.[1]) return undefined;
  const h = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as unknown as Rgb;
}

export const BLACK: Rgb = [0, 0, 0];
export const WHITE: Rgb = [1, 1, 1];

/** White on dark colours, black on light ones (relative luminance threshold 0.5). */
export function contrastingColor(fill: Rgb): Rgb {
  const luminance = 0.2126 * fill[0] + 0.7152 * fill[1] + 0.0722 * fill[2];
  return luminance < 0.5 ? WHITE : BLACK;
}

/** Filters `decodePDFRawStream` can undo. */
const DECODABLE = new Set([
  'FlateDecode',
  'LZWDecode',
  'ASCII85Decode',
  'ASCIIHexDecode',
  'RunLengthDecode',
]);

/** Names of a stream's filters, in order. */
export function filterNames(context: PDFContext, stream: PDFStream): string[] {
  const filter = context.lookup(stream.dict.get(PDFName.of('Filter')));
  if (filter instanceof PDFName) return [filter.decodeText()];
  if (filter instanceof PDFArray) {
    const out: string[] = [];
    for (let i = 0; i < filter.size(); i++) {
      const f = context.lookup(filter.get(i));
      out.push(f instanceof PDFName ? f.decodeText() : '?');
    }
    return out;
  }
  return [];
}

/**
 * Decoded data of a stream, or `undefined` when a filter is not decodable here (DCT, JPX,
 * JBIG2, CCITT, Crypt) or the data is corrupt. Never throws.
 */
export function decodeStream(context: PDFContext, stream: PDFStream): Uint8Array | undefined {
  try {
    const filters = filterNames(context, stream);
    if (stream instanceof PDFFlateStream) return stream.getUnencodedContents();
    if (!(stream instanceof PDFRawStream)) return undefined;
    if (filters.length === 0) return stream.contents;
    if (!filters.every((f) => DECODABLE.has(f))) return undefined;
    return decodePDFRawStream(stream).decode();
  } catch {
    return undefined;
  }
}

/**
 * Indirect objects reachable from the trailer (/Root, /Info, /Encrypt), by object number
 * and generation (`"12 0"`). Iterative, with a cycle guard.
 */
export function reachableRefs(context: PDFContext): Set<string> {
  const reachable = new Set<string>();
  const stack: PDFObject[] = [];
  const { Root, Info, Encrypt } = context.trailerInfo;
  for (const root of [Root, Info, Encrypt]) if (root) stack.push(root);
  const seen = new Set<PDFObject>();
  while (stack.length > 0) {
    const value = stack.pop() as PDFObject;
    if (value instanceof PDFRef) {
      const key = refKey(value);
      if (reachable.has(key)) continue;
      reachable.add(key);
      const target = context.lookup(value);
      if (target) stack.push(target);
      continue;
    }
    if (seen.has(value)) continue;
    seen.add(value);
    if (value instanceof PDFStream) stack.push(value.dict);
    else if (value instanceof PDFDict) for (const [, child] of value.entries()) stack.push(child);
    else if (value instanceof PDFArray) {
      for (let i = 0; i < value.size(); i++) stack.push(value.get(i));
    }
  }
  return reachable;
}

export const refKey = (ref: PDFRef): string => `${ref.objectNumber} ${ref.generationNumber}`;

/** Object streams and cross-reference streams: file structure, never reachable. */
export function isStructuralStream(context: PDFContext, value: PDFObject | undefined): boolean {
  if (!(value instanceof PDFStream)) return false;
  const type = context.lookup(value.dict.get(PDFName.of('Type')));
  return type === PDFName.of('ObjStm') || type === PDFName.of('XRef');
}

/** Indirect objects sorted by object number, then generation (deterministic order). */
export function sortedObjects(context: PDFContext): [PDFRef, PDFObject][] {
  return context
    .enumerateIndirectObjects()
    .sort(([a], [b]) => a.objectNumber - b.objectNumber || a.generationNumber - b.generationNumber);
}
