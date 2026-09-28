/**
 * Small pdf-lib helpers shared by the scrub and the forensic check: rectangles of
 * annotations, colours, stream decoding and reachability.
 */

import {
  decodePDFRawStream,
  PDFArray,
  type PDFContext,
  PDFDict,
  type PDFDocument,
  PDFFlateStream,
  PDFName,
  PDFNumber,
  type PDFObject,
  PDFRawStream,
  PDFRef,
  PDFStream,
} from '@cantoo/pdf-lib';
import type { Rect } from '@pdf-editor/document-model';

import {
  annotationSubtype,
  catalogNameTree,
  forEachDict,
  NAMES,
  nameTreeEntries,
  pageAnnotations,
  textOf,
} from '../pdflib/metadata-walk';

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

/** /DecodeParms of filter `index` (a dictionary, or one entry of an array). */
function decodeParms(
  context: PDFContext,
  stream: PDFStream,
  index: number,
  count: number,
): PDFDict | undefined {
  const parms = context.lookup(stream.dict.get(PDFName.of('DecodeParms')));
  if (parms instanceof PDFDict) return count === 1 || index === 0 ? parms : undefined;
  if (parms instanceof PDFArray) return context.lookupMaybe(parms.get(index), PDFDict);
  return undefined;
}

/** Predictor parameters of a Flate or LZW filter (ISO 32000-2 §7.4.4.4). */
export interface PredictorParams {
  readonly predictor: number;
  readonly colors: number;
  readonly bitsPerComponent: number;
  readonly columns: number;
}

function predictorParams(context: PDFContext, parms: PDFDict | undefined): PredictorParams {
  const num = (key: string, fallback: number) => {
    const v = context.lookup(parms?.get(PDFName.of(key)));
    return v instanceof PDFNumber ? v.asNumber() : fallback;
  };
  return {
    predictor: num('Predictor', 1),
    colors: num('Colors', 1),
    bitsPerComponent: num('BitsPerComponent', 8),
    columns: num('Columns', 1),
  };
}

/**
 * Undoes a PNG (10–15) or TIFF (2) predictor. Returns the reason instead when the
 * parameters are not supported (or not valid).
 */
export function undoPredictor(
  data: Uint8Array,
  params: PredictorParams,
): { data: Uint8Array } | { reason: string } {
  const { predictor, colors, bitsPerComponent: bpc, columns } = params;
  if (predictor === 1) return { data };
  if (
    ![1, 2, 4, 8, 16].includes(bpc) ||
    !Number.isInteger(colors) ||
    colors < 1 ||
    colors > 32 ||
    !Number.isInteger(columns) ||
    columns < 1 ||
    columns > 1_000_000
  ) {
    return {
      reason: `predictor ${predictor} with Colors ${colors}, BitsPerComponent ${bpc}, Columns ${columns}`,
    };
  }
  const rowBytes = Math.ceil((colors * bpc * columns) / 8);
  if (predictor >= 10 && predictor <= 15) {
    const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
    const rows = Math.ceil(data.length / (rowBytes + 1));
    const out = new Uint8Array(rows * rowBytes);
    let outLength = 0;
    for (let r = 0, at = 0; at < data.length; r++, at += rowBytes + 1) {
      const type = data[at] as number;
      const row = data.subarray(at + 1, Math.min(at + 1 + rowBytes, data.length));
      const base = r * rowBytes;
      for (let j = 0; j < row.length; j++) {
        const raw = row[j] as number;
        const left = j >= bpp ? (out[base + j - bpp] as number) : 0;
        const up = r > 0 ? (out[base - rowBytes + j] as number) : 0;
        const upLeft = r > 0 && j >= bpp ? (out[base - rowBytes + j - bpp] as number) : 0;
        let value: number;
        switch (type) {
          case 0:
            value = raw;
            break;
          case 1:
            value = raw + left;
            break;
          case 2:
            value = raw + up;
            break;
          case 3:
            value = raw + ((left + up) >> 1);
            break;
          case 4: {
            const p = left + up - upLeft;
            const pa = Math.abs(p - left);
            const pb = Math.abs(p - up);
            const pc = Math.abs(p - upLeft);
            value = raw + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
            break;
          }
          default:
            return { reason: `PNG predictor row filter ${type} (corrupt data)` };
        }
        out[base + j] = value & 0xff;
      }
      outLength = base + row.length;
    }
    return { data: out.subarray(0, outLength) };
  }
  if (predictor === 2) {
    const out = data.slice();
    const max = (1 << bpc) - 1;
    for (let at = 0; at < out.length; at += rowBytes) {
      const end = Math.min(at + rowBytes, out.length);
      if (bpc === 8) {
        for (let j = at + colors; j < end; j++)
          out[j] = ((out[j] as number) + (out[j - colors] as number)) & 0xff;
      } else if (bpc === 16) {
        for (let j = at + 2 * colors; j + 1 < end; j += 2) {
          const prev = ((out[j - 2 * colors] as number) << 8) | (out[j - 2 * colors + 1] as number);
          const cur = (((out[j] as number) << 8) | (out[j + 1] as number)) + prev;
          out[j] = (cur >> 8) & 0xff;
          out[j + 1] = cur & 0xff;
        }
      } else {
        // Sub-byte samples: unpack, accumulate per component, repack.
        const samples = Math.floor(((end - at) * 8) / bpc);
        const get = (k: number) => {
          const bit = k * bpc;
          const byte = out[at + (bit >> 3)] as number;
          return (byte >> (8 - bpc - (bit & 7))) & max;
        };
        const set = (k: number, v: number) => {
          const bit = k * bpc;
          const shift = 8 - bpc - (bit & 7);
          const i = at + (bit >> 3);
          out[i] = ((out[i] as number) & ~(max << shift)) | ((v & max) << shift);
        };
        for (let k = colors; k < samples; k++) set(k, get(k) + get(k - colors));
      }
    }
    return { data: out };
  }
  return { reason: `predictor ${predictor} is not defined` };
}

/** Decoded data of a stream, or why it could not be decoded. */
export type DecodeOutcome = { readonly data: Uint8Array } | { readonly reason: string };

/**
 * Decoded data of a stream, predictors (PNG and TIFF) undone, or the reason it could not
 * be decoded: a filter not decodable here (DCT, JPX, JBIG2, CCITT, Crypt), corrupt data, or
 * unsupported predictor parameters. Never throws.
 */
export function decodeStreamOutcome(context: PDFContext, stream: PDFStream): DecodeOutcome {
  let filters: string[] = [];
  try {
    filters = filterNames(context, stream);
    if (stream instanceof PDFFlateStream) return { data: stream.getUnencodedContents() };
    if (!(stream instanceof PDFRawStream)) return { reason: 'not readable' };
    if (filters.length === 0 && !stream.transform) return { data: stream.contents };
    const undecodable = filters.filter((f) => !DECODABLE.has(f));
    if (undecodable.length > 0) {
      return { reason: `${undecodable.join(', ')} not decodable here` };
    }
    const params = filters.map((_, i) =>
      predictorParams(context, decodeParms(context, stream, i, filters.length)),
    );
    const predicted = (i: number) =>
      (filters[i] === 'FlateDecode' || filters[i] === 'LZWDecode') &&
      (params[i]?.predictor ?? 1) > 1;
    if (!filters.some((_, i) => predicted(i))) return { data: decodePDFRawStream(stream).decode() };
    // Filter by filter, undoing each predictor (pdf-lib ignores them).
    let data = stream.transform
      ? decodePDFRawStream(
          PDFRawStream.of(context.obj({}), stream.contents, stream.transform),
        ).decode()
      : stream.contents;
    for (const [i, filter] of filters.entries()) {
      data = decodePDFRawStream(PDFRawStream.of(context.obj({ Filter: filter }), data)).decode();
      if (predicted(i)) {
        const undone = undoPredictor(data, params[i] as PredictorParams);
        if ('reason' in undone) return { reason: `${filter}: ${undone.reason}` };
        data = undone.data;
      }
    }
    return { data };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { reason: `${filters.join(', ') || 'unfiltered'}: corrupt data (${detail})` };
  }
}

/**
 * Decoded data of a stream (see `decodeStreamOutcome`), or `undefined` when it cannot be
 * decoded. Never throws.
 */
export function decodeStream(context: PDFContext, stream: PDFStream): Uint8Array | undefined {
  const outcome = decodeStreamOutcome(context, stream);
  return 'data' in outcome ? outcome.data : undefined;
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

/** An embedded file's data stream, with the name of a file specification that holds it. */
export interface EmbeddedFileStream {
  readonly ref: PDFRef;
  readonly stream: PDFStream;
  /** /UF or /F of a file specification whose /EF names this stream. */
  readonly name?: string;
}

/**
 * Every embedded file stream of `doc`, reachable or not, in object order: streams with
 * /Type /EmbeddedFile, and streams named by any /EF dictionary (file specifications in the
 * /EmbeddedFiles tree, /AF, FileAttachment annotations, GoToR/GoToE actions, portfolios,
 * RichMedia assets, or anywhere else).
 */
export function embeddedFileStreams(doc: PDFDocument): EmbeddedFileStream[] {
  const { context } = doc;
  const names = new Map<string, string | undefined>();
  forEachDict(doc, ({ dict }) => {
    const ef = context.lookup(dict.get(NAMES.EF));
    if (!(ef instanceof PDFDict)) return;
    const name =
      textOf(context.lookup(dict.get(NAMES.UF))) ?? textOf(context.lookup(dict.get(NAMES.F)));
    for (const [, value] of ef.entries()) {
      if (!(value instanceof PDFRef)) continue;
      const key = refKey(value);
      if (names.get(key) === undefined) names.set(key, name);
    }
  });
  const out: EmbeddedFileStream[] = [];
  for (const [ref, object] of sortedObjects(context)) {
    if (!(object instanceof PDFStream)) continue;
    const key = refKey(ref);
    const typed = context.lookup(object.dict.get(NAMES.Type)) === PDFName.of('EmbeddedFile');
    if (!typed && !names.has(key)) continue;
    const name = names.get(key);
    out.push(name === undefined ? { ref, stream: object } : { ref, stream: object, name });
  }
  return out;
}

/**
 * Names of embedded file streams not held by the /EmbeddedFiles tree or a file attachment
 * annotation (already listed by name): "name (embedded file, object N)". With `reachable`,
 * only streams in that set are listed.
 */
export function otherEmbeddedFiles(doc: PDFDocument, reachable?: ReadonlySet<string>): string[] {
  const { context } = doc;
  const listed = new Set<string>();
  const specStreams = (spec: PDFObject | undefined) => {
    const dict = context.lookup(spec);
    const ef = dict instanceof PDFDict ? context.lookup(dict.get(NAMES.EF)) : undefined;
    if (!(ef instanceof PDFDict)) return;
    for (const [, value] of ef.entries()) if (value instanceof PDFRef) listed.add(refKey(value));
  };
  const tree = catalogNameTree(doc, NAMES.EmbeddedFiles);
  for (const [, spec] of tree ? nameTreeEntries(doc, tree) : []) specStreams(spec);
  for (const { annots } of pageAnnotations(doc)) {
    for (let i = 0; i < annots.size(); i++) {
      const annot = context.lookupMaybe(annots.get(i), PDFDict);
      if (annot && annotationSubtype(doc, annot) === 'FileAttachment') {
        specStreams(annot.get(NAMES.FS));
      }
    }
  }
  return embeddedFileStreams(doc)
    .filter(({ ref }) => !listed.has(refKey(ref)) && (reachable?.has(refKey(ref)) ?? true))
    .map(
      ({ ref, name }) => `${name ?? 'unnamed file'} (embedded file, object ${ref.objectNumber})`,
    );
}
