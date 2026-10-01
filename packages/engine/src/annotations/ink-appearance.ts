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
 * - `formatInkWidths` / `parseInkWidths`: the `/PdfEditorInkWidths` value (`1;w w …;w w …`,
 *   two decimals, one group per path) and back, checked against `/InkList` point for point.
 *
 * The appearance is built from the widths as stored (two decimals), so the stream written at
 * creation is the one any later regeneration from the file produces.
 */
import type { InkAnnotation } from '../types';
import {
  decodeInkWidths,
  encodeInkWidths,
  type InkBounds,
  type InkPoint,
  inkAppearanceContent,
  inkOutlineBounds,
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

/**
 * The appearance, /Rect and widths string of an ink with widths, or `undefined` when it has
 * none that match its paths. Colour and opacity as written by the mapping (`#000000` and 1
 * when absent); opacity below 1 selects the ExtGState `FPDFAnnot_SetAP` adds for /CA.
 */
export function inkAppearance(a: InkAppearanceSource): InkAppearanceWrite | undefined {
  const stored = storedInkWidths(a.paths, a.widths);
  if (!stored) return undefined;
  const content = inkAppearanceContent({
    paths: a.paths,
    widths: stored,
    color: a.color ?? '#000000',
    opacity: a.opacity ?? 1,
  });
  return {
    content,
    rect: inkOutlineBounds(a.paths, stored),
    widths: encodeInkWidths(stored),
    stored,
  };
}
