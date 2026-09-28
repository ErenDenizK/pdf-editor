/**
 * A `getPageText` run's characters paired with its glyph boxes. The run's text may hold
 * characters without a glyph (generated spaces) and its glyphs may have no text (PDFium's
 * line-end soft-hyphen marker, U+FFFE, comes through as an empty glyph); the two are walked
 * in step so every character knows its box and glyph, and a trailing hyphenation mark is
 * reported. Shared by the comparison tokens and the Markdown layout.
 */
import type { Rect } from '@pdf-editor/document-model';

import type { TextRun } from '../types';

/** Characters PDFium or producers use for a discretionary hyphen. */
export const SOFT_HYPHENS = new Set(['\u00ad', '\ufffe']);

export interface LineChars {
  readonly text: string;
  /** Box of each UTF-16 unit of `text` (undefined for generated characters). */
  readonly boxes: readonly (Rect | undefined)[];
  /** Index into the run's glyphs of each UTF-16 unit of `text` (-1 for generated characters). */
  readonly glyphIndex: Int32Array;
  /** The line ended in a hyphenation mark (soft marker, or a hard hyphen after a letter). */
  readonly hyphen: 'soft' | 'hard' | undefined;
}

/** Pairs a run's characters with its glyph boxes. */
export function lineChars(run: TextRun): LineChars {
  const text = run.text;
  const boxes: (Rect | undefined)[] = new Array<Rect | undefined>(text.length).fill(undefined);
  const glyphIndex = new Int32Array(text.length).fill(-1);
  let gi = 0;
  let marker = false;
  const glyphs = run.glyphs;
  for (let i = 0; i < text.length; ) {
    while (gi < glyphs.length && (glyphs[gi]?.text ?? '') === '') gi++;
    const glyph = glyphs[gi];
    if (glyph && text.startsWith(glyph.text, i)) {
      for (let k = 0; k < glyph.text.length; k++) {
        boxes[i + k] = glyph.rect;
        glyphIndex[i + k] = gi;
      }
      i += glyph.text.length;
      gi++;
    } else {
      i++;
    }
  }
  // Glyphs left after the text: PDFium's soft-hyphen marker has a box but no text.
  for (; gi < glyphs.length; gi++) {
    const t = glyphs[gi]?.text ?? '';
    if (t === '' || SOFT_HYPHENS.has(t)) marker = true;
  }
  let body = text.replace(/\s+$/u, '');
  let hyphen: LineChars['hyphen'];
  const last = body.at(-1) ?? '';
  if (marker || SOFT_HYPHENS.has(last)) {
    hyphen = 'soft';
    if (SOFT_HYPHENS.has(last)) body = body.slice(0, -1);
  } else if ((last === '-' || last === '\u2010') && /\p{L}/u.test(body.at(-2) ?? '')) {
    hyphen = 'hard';
  }
  return {
    text: body,
    boxes: boxes.slice(0, body.length),
    glyphIndex: glyphIndex.slice(0, body.length),
    hyphen,
  };
}
