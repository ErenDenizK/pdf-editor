/**
 * Page text as one searchable string with a glyph behind every character, so a pattern
 * match (an offset range) becomes redaction quads, and the text under a mark becomes its
 * snippet. Runs on one line are joined with a space, lines with a newline (patterns do not
 * cross lines).
 */
import type { Rect } from '@pdf-editor/document-model';
import type { TextRun } from '@pdf-editor/engine';

import { type GlyphRef, quadsForGlyphs, textForGlyphs } from '../annotations/quads';

export interface PageTextIndex {
  readonly text: string;
  /** The glyph each UTF-16 unit of `text` comes from; null for inserted separators. */
  readonly refs: readonly (GlyphRef | null)[];
}

function sameLine(a: Rect, b: Rect): boolean {
  const overlap = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  const band = Math.min(a.height, b.height);
  return band > 0 && overlap / band >= 0.5;
}

export function indexPageText(runs: readonly TextRun[]): PageTextIndex {
  let text = '';
  const refs: (GlyphRef | null)[] = [];
  let previous: Rect | undefined;
  runs.forEach((run, r) => {
    if (run.glyphs.length === 0) return;
    if (previous) {
      const separator = sameLine(previous, run.rect) ? ' ' : '\n';
      if (!(separator === ' ' && /\s$/.test(text))) {
        text += separator;
        refs.push(null);
      }
    }
    run.glyphs.forEach((glyph, g) => {
      for (const ch of glyph.text) {
        if (ch === '\r') continue;
        text += ch;
        // One ref per UTF-16 unit: pattern offsets are UTF-16 offsets.
        const ref = { run: r, glyph: g };
        refs.push(...Array.from({ length: ch.length }, () => ref));
      }
    });
    previous = run.rect;
  });
  return { text, refs };
}

/** The distinct glyphs behind `text.slice(start, end)`, in order. */
export function glyphsInRange(index: PageTextIndex, start: number, end: number): GlyphRef[] {
  const out: GlyphRef[] = [];
  let last: GlyphRef | undefined;
  for (let i = Math.max(0, start); i < Math.min(end, index.refs.length); i++) {
    const ref = index.refs[i];
    if (!ref || (last?.run === ref.run && last.glyph === ref.glyph)) continue;
    out.push(ref);
    last = ref;
  }
  return out;
}

/** Quads (one per line) covering `text.slice(start, end)`. */
export function quadsForTextRange(
  runs: readonly TextRun[],
  index: PageTextIndex,
  start: number,
  end: number,
): Rect[] {
  return quadsForGlyphs(runs, glyphsInRange(index, start, end));
}

/** Minimum overlap (points, on both axes) for a glyph to count as under a mark. */
const TOUCH = 0.5;

/**
 * Glyphs a redaction would remove: PDFium removes a whole glyph whenever its box meets the
 * area (docs/research/06-redaction-spike.md §2 (c)), so this is "touching", not "centre
 * inside" as for text selection.
 */
export function glyphsUnderQuads(runs: readonly TextRun[], quads: readonly Rect[]): GlyphRef[] {
  const out: GlyphRef[] = [];
  runs.forEach((run, r) => {
    run.glyphs.forEach((glyph, g) => {
      const b = glyph.rect;
      if (b.width <= 0 && b.height <= 0) return;
      const hit = quads.some((q) => {
        const w = Math.min(q.x + q.width, b.x + b.width) - Math.max(q.x, b.x);
        const h = Math.min(q.y + q.height, b.y + b.height) - Math.max(q.y, b.y);
        return w > TOUCH && h > TOUCH;
      });
      if (hit) out.push({ run: r, glyph: g });
    });
  });
  return out;
}

/** The text under a mark, whitespace collapsed (the panel's snippet). */
export function textUnderQuads(runs: readonly TextRun[], quads: readonly Rect[]): string {
  return textForGlyphs(runs, glyphsUnderQuads(runs, quads)).replace(/\s+/g, ' ').trim();
}
