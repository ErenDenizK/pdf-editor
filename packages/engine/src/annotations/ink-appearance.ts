/**
 * Variable-width ink in the file (ADR-0018, spec experience-redesign.md §6.7 and §9). Pure
 * functions, no PDFium; the adapter writes and reads through `pdfium/host/annot-appearance.ts`.
 *
 * A variable-width ink is a standard Ink annotation: `/InkList` holds the centre lines and
 * `/BS /W` the nominal width (both written by EmbedPDF), `/AP /N` our filled outline
 * (`ink-outline.ts`: every path in one nonzero fill, user space, /BBox = /Rect = the outline
 * bounds) and the private text string `/PdfEditorInkWidths` the per-point widths, so a later
 * session can regenerate the appearance after a move, recolour, width change or eraser split.
 *
 * - `inkAppearance`: what the adapter writes for an ink with widths (content, /Rect, the
 *   widths string), or `undefined` when its widths do not match its paths (constant width).
 * - `formatInkWidths` / `parseInkWidths`: the `/PdfEditorInkWidths` value (`2;w w …;w w …`,
 *   two decimals, one group per path) and back, checked against `/InkList` point for point.
 *
 * The appearance is built from the widths as stored (two decimals), so the stream written at
 * creation is the one any later regeneration from the file produces.
 *
 * **Per-path cache** (craft spec §5.3 item 8). The appearance is one fill of every path's
 * outline, so it is the concatenation of per-path operator strings. `inkAppearance` keeps each
 * path's operators, outline bounds and widths group in a bounded LRU keyed by the path's
 * points, its stored widths and `INK_OUTLINE_VERSION` (a 64-bit hash, checked point for point
 * on a hit). Appending a path to a burst of 64 then outlines the new path only; the others
 * cost a hash and a string join. The result is byte for byte what `inkAppearanceContent` and
 * `encodeInkWidths` build.
 */
import type { InkAnnotation } from '../types';
import {
  decodeInkWidths,
  encodeInkWidths,
  INK_OUTLINE_VERSION,
  type InkBounds,
  type InkPoint,
  inkOutlineBounds,
  inkOutlineOps,
  pdfNumber,
} from './ink-outline';

export { INK_WIDTHS_KEY } from './ink-outline';

/** The narrowest width stored (points): two decimals, and `0` would not parse back. */
export const MIN_INK_WIDTH = 0.01;

/** Ink fields the appearance depends on. */
export type InkAppearanceSource = Pick<InkAnnotation, 'paths' | 'widths' | 'color' | 'opacity'>;

/** What the adapter writes after EmbedPDF's own write of an ink with widths. */
export interface InkAppearanceWrite {
  /** The normal appearance content (user space; its /BBox is `rect`). */
  readonly content: string;
  /** The new /Rect: the outline bounds plus 0.5 pt. */
  readonly rect: InkBounds;
  /** The `/PdfEditorInkWidths` value. */
  readonly widths: string;
  /** The widths the appearance was built from (two decimals, at least `MIN_INK_WIDTH`). */
  readonly stored: number[][];
}

function storedWidth(w: number): number {
  return Math.max(MIN_INK_WIDTH, Math.round(w * 100) / 100);
}

/**
 * The widths as `/PdfEditorInkWidths` stores them, or `undefined` when they do not match
 * `paths` point for point or hold a width that is not a positive finite number.
 */
export function storedInkWidths(
  paths: readonly (readonly InkPoint[])[],
  widths: readonly (readonly number[])[] | undefined,
): number[][] | undefined {
  if (widths?.length !== paths.length) return undefined;
  const out: number[][] = [];
  for (const [k, ws] of widths.entries()) {
    if (ws.length !== paths[k]?.length) return undefined;
    if (ws.some((w) => !Number.isFinite(w) || w <= 0)) return undefined;
    out.push(ws.map(storedWidth));
  }
  return out;
}

/** The `/PdfEditorInkWidths` value for widths that match `paths` (else `undefined`). */
export function formatInkWidths(
  paths: readonly (readonly InkPoint[])[],
  widths: readonly (readonly number[])[] | undefined,
): string | undefined {
  const stored = storedInkWidths(paths, widths);
  return stored ? encodeInkWidths(stored) : undefined;
}

/**
 * The widths in a `/PdfEditorInkWidths` value, or `undefined` when it is absent, empty, of
 * another version, malformed, or does not match `paths` point for point (the ink was edited
 * by an application that does not know the key): the stroke is then constant width.
 */
export function parseInkWidths(
  value: string | undefined,
  paths: readonly (readonly InkPoint[])[],
): number[][] | undefined {
  return decodeInkWidths(value, paths);
}

// ---------------------------------------------------------------------------
// Per-path outline cache
// ---------------------------------------------------------------------------

/** Paths whose outline operators are kept (a full burst holds 64). */
export const INK_OUTLINE_CACHE_PATHS = 2048;

interface PathOutline {
  /** x, y and stored width of every point, as the entry was built from (checked on a hit). */
  readonly input: Float64Array;
  /** The outline's path-construction operators ('' for an empty path). */
  readonly ops: string;
  /** The outline's bounds without padding; undefined for an empty path. */
  readonly bounds: InkBounds | undefined;
  /** The path's group of `/PdfEditorInkWidths`. */
  readonly widths: string;
}

const outlines = new Map<string, PathOutline>();
let cacheHits = 0;
let cacheMisses = 0;
const bits = new DataView(new ArrayBuffer(8));

/**
 * The cache key of a path: its length, two independent 32-bit hashes of the bits of every
 * x, y and stored width, and the outline version.
 */
function outlineKey(path: readonly InkPoint[], widths: readonly number[]): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9747b28c;
  const n = path.length;
  for (let i = 0; i < n; i++) {
    const p = path[i] as InkPoint;
    for (let c = 0; c < 3; c++) {
      bits.setFloat64(0, c === 0 ? p.x : c === 1 ? p.y : (widths[i] ?? 0), true);
      const lo = bits.getUint32(0, true);
      const hi = bits.getUint32(4, true);
      h1 = Math.imul(Math.imul(h1 ^ lo, 0x01000193) ^ hi, 0x01000193);
      h2 = Math.imul(Math.imul(h2 ^ hi, 0x5bd1e995) ^ lo, 0x5bd1e995);
    }
  }
  return `${INK_OUTLINE_VERSION}:${n}:${(h1 >>> 0).toString(36)}:${(h2 >>> 0).toString(36)}`;
}

function sameInput(
  input: Float64Array,
  path: readonly InkPoint[],
  widths: readonly number[],
): boolean {
  const n = path.length;
  if (input.length !== n * 3) return false;
  for (let i = 0; i < n; i++) {
    const p = path[i] as InkPoint;
    if (input[i * 3] !== p.x || input[i * 3 + 1] !== p.y || input[i * 3 + 2] !== widths[i]) {
      return false;
    }
  }
  return true;
}

/** One path's outline operators, bounds and widths group, from the cache when it has them. */
function pathOutline(path: readonly InkPoint[], widths: readonly number[]): PathOutline {
  const key = outlineKey(path, widths);
  const hit = outlines.get(key);
  if (hit && sameInput(hit.input, path, widths)) {
    // Most recently used last.
    outlines.delete(key);
    outlines.set(key, hit);
    cacheHits += 1;
    return hit;
  }
  cacheMisses += 1;
  const input = new Float64Array(path.length * 3);
  for (const [i, p] of path.entries()) {
    input[i * 3] = p.x;
    input[i * 3 + 1] = p.y;
    input[i * 3 + 2] = widths[i] ?? 0;
  }
  const entry: PathOutline = {
    input,
    ops: inkOutlineOps(path, widths),
    bounds: path.length === 0 ? undefined : inkOutlineBounds([path], [widths], 0),
    widths: widths.map(pdfNumber).join(' '),
  };
  outlines.set(key, entry);
  if (outlines.size > INK_OUTLINE_CACHE_PATHS) {
    const oldest = outlines.keys().next().value;
    if (oldest !== undefined) outlines.delete(oldest);
  }
  return entry;
}

/** Tests and diagnostics: the per-path cache's size and its hits and misses so far. */
export function inkOutlineCacheStats(): {
  readonly size: number;
  readonly hits: number;
  readonly misses: number;
} {
  return { size: outlines.size, hits: cacheHits, misses: cacheMisses };
}

/** Tests: empties the per-path cache and its counters. */
export function clearInkOutlineCache(): void {
  outlines.clear();
  cacheHits = 0;
  cacheMisses = 0;
}

function rgbOperator(color: string): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  const [r, g, b] = m
    ? [m[1], m[2], m[3]].map((h) => Number.parseInt(h as string, 16) / 255)
    : [0, 0, 0];
  const c = (v: number | undefined) => (Math.round((v ?? 0) * 1000) / 1000).toString();
  return `${c(r)} ${c(g)} ${c(b)} rg`;
}

/**
 * The appearance, /Rect and widths string of an ink with widths, or `undefined` when it has
 * none that match its paths. Colour and opacity as written by the mapping (`#000000` and 1
 * when absent); opacity below 1 selects the ExtGState `FPDFAnnot_SetAP` adds for /CA. Each
 * path's outline comes from the per-path cache (see the module comment); the content equals
 * `inkAppearanceContent` and the widths `encodeInkWidths` of the stored widths.
 */
export function inkAppearance(a: InkAppearanceSource): InkAppearanceWrite | undefined {
  const stored = storedInkWidths(a.paths, a.widths);
  if (!stored) return undefined;
  const out: string[] = ['q'];
  if ((a.opacity ?? 1) < 1) out.push('/GS gs');
  out.push(rgbOperator(a.color ?? '#000000'));
  const groups: string[] = [String(INK_OUTLINE_VERSION)];
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const [k, path] of a.paths.entries()) {
    const outline = pathOutline(path, stored[k] ?? []);
    if (outline.ops !== '') out.push(outline.ops);
    groups.push(outline.widths);
    const b = outline.bounds;
    if (!b) continue;
    x1 = Math.min(x1, b.x);
    y1 = Math.min(y1, b.y);
    x2 = Math.max(x2, b.x + b.width);
    y2 = Math.max(y2, b.y + b.height);
  }
  out.push('f', 'Q');
  const pad = 0.5;
  const rect = Number.isFinite(x1)
    ? { x: x1 - pad, y: y1 - pad, width: x2 - x1 + 2 * pad, height: y2 - y1 + 2 * pad }
    : { x: 0, y: 0, width: 0, height: 0 };
  return { content: out.join('\n'), rect, widths: groups.join(';'), stored };
}
