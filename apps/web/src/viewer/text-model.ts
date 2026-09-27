/**
 * Text layer model: engine text runs → positioned lines, and selection → clipboard text.
 *
 * Copy rules (spec §1): the pieces of one visual row are joined with a space, rows with a
 * newline, and pages with a blank line. Visual rows are computed from geometry, because
 * the engine may split one printed line into several runs (separate text objects).
 */
import type { Rect, Rotation } from '@pdf-editor/document-model';
import type { TextRun } from '@pdf-editor/engine';

import { type Box, lineAngle, orientedPlacement, type PageFrame, userRectToCss } from './geometry';

export interface TextLine {
  readonly text: string;
  /** Visual row on the page; consecutive lines with the same row share a printed line. */
  readonly row: number;
  /** Displayed box in CSS pixels. */
  readonly box: Box;
  /** Reading direction on screen. */
  readonly angle: Rotation;
  /** Where the span's top-left corner goes before it is turned by `angle`. */
  readonly left: number;
  readonly top: number;
  /** Extent along the reading direction and across it (the font size), CSS pixels. */
  readonly length: number;
  readonly thickness: number;
}

function userDirection(glyphs: readonly { readonly rect: Rect }[]): 'h' | 'v' {
  const first = glyphs[0];
  const last = glyphs[glyphs.length - 1];
  if (!first || !last || first === last) return 'h';
  const dx = Math.abs(last.rect.x - first.rect.x);
  const dy = Math.abs(last.rect.y - first.rect.y);
  return dx >= dy ? 'h' : 'v';
}

function overlapRatio(a0: number, a1: number, b0: number, b1: number): number {
  const overlap = Math.min(a1, b1) - Math.max(a0, b0);
  const smaller = Math.min(a1 - a0, b1 - b0);
  return smaller <= 0 ? 0 : overlap / smaller;
}

/**
 * Visual row per run, in engine order: a run continues the previous row when it reads in
 * the same direction and their bands (across the reading direction) mostly overlap.
 */
export function assignRows(runs: readonly Pick<TextRun, 'rect' | 'glyphs'>[]): number[] {
  const rows: number[] = [];
  let row = -1;
  let previous: { dir: 'h' | 'v'; lo: number; hi: number } | undefined;
  for (const run of runs) {
    const dir = userDirection(run.glyphs);
    const lo = dir === 'h' ? run.rect.y : run.rect.x;
    const hi = dir === 'h' ? run.rect.y + run.rect.height : run.rect.x + run.rect.width;
    if (previous?.dir !== dir || overlapRatio(previous.lo, previous.hi, lo, hi) < 0.5) {
      row += 1;
    }
    rows.push(row);
    previous = { dir, lo, hi };
  }
  return rows;
}

/** Positions every run of a page for the text layer. Runs without text are dropped. */
export function layoutTextLines(runs: readonly TextRun[], frame: PageFrame): TextLine[] {
  const rows = assignRows(runs);
  const lines: TextLine[] = [];
  runs.forEach((run, i) => {
    if (run.text === '' || run.glyphs.length === 0) return;
    const box = userRectToCss(frame, run.rect);
    const angle = lineAngle(frame, run.glyphs);
    const placement = orientedPlacement(box, angle);
    lines.push({ text: run.text, row: rows[i] ?? i, box, angle, ...placement });
  });
  return lines;
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

export interface CopyPiece {
  /** Document page index. */
  readonly page: number;
  readonly row: number;
  readonly text: string;
}

/** Joins selected pieces (in reading order) into clipboard text. */
export function assembleCopyText(pieces: readonly CopyPiece[]): string {
  let out = '';
  let last: CopyPiece | undefined;
  for (const piece of pieces) {
    if (piece.text === '') continue;
    if (last) {
      if (piece.page !== last.page) out += '\n\n';
      else if (piece.row !== last.row) out += '\n';
      else if (!/\s$/.test(out) && !/^\s/.test(piece.text)) out += ' ';
    }
    out += piece.text;
    last = piece;
  }
  return out;
}

/** Attribute names shared by the text layer DOM and the copy handler. */
export const TEXT_LAYER_ATTR = 'data-text-layer';
export const TEXT_ROW_ATTR = 'data-row';

function offsetIn(span: Element, container: Node, offset: number, atEnd: boolean): number {
  const length = span.textContent?.length ?? 0;
  if (container.nodeType === Node.TEXT_NODE) return Math.min(offset, length);
  // An element boundary: before or after the span's only text node.
  if (container === span) return offset === 0 ? 0 : length;
  return atEnd ? length : 0;
}

/**
 * The selected parts of every text-layer line under `root`, in DOM order. Lines are the
 * elements carrying `data-row` inside an element carrying `data-text-layer="<page>"`.
 */
export function selectedPieces(range: Range, root: ParentNode = document): CopyPiece[] {
  const pieces: CopyPiece[] = [];
  for (const span of root.querySelectorAll<HTMLElement>(
    `[${TEXT_LAYER_ATTR}] [${TEXT_ROW_ATTR}]`,
  )) {
    if (!range.intersectsNode(span)) continue;
    const text = span.textContent ?? '';
    let start = 0;
    let end = text.length;
    if (span.contains(range.startContainer)) {
      start = offsetIn(span, range.startContainer, range.startOffset, false);
    }
    if (span.contains(range.endContainer)) {
      end = offsetIn(span, range.endContainer, range.endOffset, true);
    }
    if (end <= start) continue;
    const layer = span.closest<HTMLElement>(`[${TEXT_LAYER_ATTR}]`);
    pieces.push({
      page: Number(layer?.getAttribute(TEXT_LAYER_ATTR) ?? 0),
      row: Number(span.getAttribute(TEXT_ROW_ATTR) ?? 0),
      text: text.slice(start, end),
    });
  }
  return pieces;
}

/** Clipboard text for the current selection, or undefined when it holds no page text. */
export function selectionCopyText(selection: Selection | null): string | undefined {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return undefined;
  const pieces: CopyPiece[] = [];
  for (let i = 0; i < selection.rangeCount; i++) {
    pieces.push(...selectedPieces(selection.getRangeAt(i)));
  }
  return pieces.length === 0 ? undefined : assembleCopyText(pieces);
}
