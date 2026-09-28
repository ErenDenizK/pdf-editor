/**
 * Verification of a written layer (spec §1.2–§1.3) on private scratch documents. It fails
 * closed: `ok` only when every planned word comes back from PDFium's page text as a whole
 * word in its place (within 2 pt of the box it was written to, on every edge), no invisible
 * text the plan asked to remove is left, and a render at 150 dpi of every page the run touched
 * (every planned page, including one with no new words whose content `removeInvisibleText`
 * regenerated or whose earlier layer was dropped) is pixel-identical to the same page before
 * (the layer is invisible, content and images untouched).
 */
import type { Rect } from '@pdf-editor/document-model';

import { deviceToUserRect, pageGeometry } from '../pdfium/coords';
import type { PageChar, ScratchDocument } from '../redaction/engine-session';
import type { OcrLayerPageCheck, OcrLayerPlan, OcrLayerVerification, OcrLayerWord } from '../types';
import { writableWord } from './layer';

/** Edge tolerance of a word's PDFium box against the box it was written to, points. */
export const OCR_RECT_TOLERANCE = 2;
/** Resolution of the before/after render comparison. */
const RENDER_DPI = 150;

/** The box a layer word occupies: origin, advance along the angle, one em up. */
export function layerWordRect(w: OcrLayerWord): Rect {
  const rad = (w.angle * Math.PI) / 180;
  const dx = Math.cos(rad);
  const dy = Math.sin(rad);
  const { x, y } = w.origin;
  const points = [
    [x, y],
    [x + dx * w.width, y + dy * w.width],
    [x - dy * w.fontSize, y + dx * w.fontSize],
    [x + dx * w.width - dy * w.fontSize, y + dy * w.width + dx * w.fontSize],
  ] as const;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}

/** Largest difference between the edges of two rects. */
export function edgeDeviation(a: Rect, b: Rect): number {
  return Math.max(
    Math.abs(a.x - b.x),
    Math.abs(a.y - b.y),
    Math.abs(a.x + a.width - (b.x + b.width)),
    Math.abs(a.y + a.height - (b.y + b.height)),
  );
}

function union(rects: readonly Rect[]): Rect | undefined {
  if (rects.length === 0) return undefined;
  const x0 = Math.min(...rects.map((r) => r.x));
  const y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.width));
  const y1 = Math.max(...rects.map((r) => r.y + r.height));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Letters, marks and digits: what a word may not continue into on either side. */
const WORD_START = /^[\p{L}\p{M}\p{N}]/u;
const WORD_END = /[\p{L}\p{M}\p{N}]$/u;

/**
 * Finds `words` in order in a page's characters (a word PDFium placed elsewhere, e.g. at the
 * end of a skewed line, is looked for from the start of the page). A match is a whole word:
 * it starts and ends on character boundaries, and where the word begins (ends) with a letter,
 * mark or digit, the page text before (after) it is not one, so "in" is not found inside
 * "within" (the layer writes a space after every word but the page's last; PDFium replaces
 * that space by a generated line break at a line end). Returns, per word, the union of its
 * characters' boxes, or undefined when the word is not there.
 */
export function locateWords(
  chars: readonly PageChar[],
  words: readonly string[],
): (Rect | undefined)[] {
  // A generated character PDFium gives no text (the line break it puts where a line's
  // trailing space was) still separates words: it reads as a line break here, or the last
  // word of a line would run into the first of the next.
  const texts = chars.map((c) => (c.text === '' && !c.rect ? '\n' : c.text));
  const text = texts.join('');
  // Offsets of each character in `text` (a character can be two UTF-16 units).
  const starts: number[] = [];
  let offset = 0;
  for (const t of texts) {
    starts.push(offset);
    offset += t.length;
  }
  const charAt = new Map(starts.map((s, i) => [s, i]));
  const boundary = (at: number) => at === text.length || charAt.has(at);
  const used = new Set<number>();
  let cursor = 0;
  return words.map((word) => {
    const wordStart = WORD_START.test(word);
    const wordEnd = WORD_END.test(word);
    // Two UTF-16 units on each side hold the neighbouring code point (the regexps are `u`).
    const whole = (at: number): boolean => {
      const end = at + word.length;
      if (!charAt.has(at) || !boundary(end)) return false;
      if (wordStart && WORD_END.test(text.slice(Math.max(0, at - 2), at))) return false;
      if (wordEnd && WORD_START.test(text.slice(end, end + 2))) return false;
      return true;
    };
    const find = (from: number): number => {
      let at = word === '' ? -1 : text.indexOf(word, from);
      while (at !== -1 && (used.has(at) || !whole(at))) at = text.indexOf(word, at + 1);
      return at;
    };
    let at = find(cursor);
    if (at === -1) at = find(0);
    if (at === -1) return undefined;
    used.add(at);
    cursor = at + word.length;
    const first = charAt.get(at) ?? 0;
    const rects: Rect[] = [];
    for (let i = first; i < chars.length && (starts[i] ?? 0) < at + word.length; i++) {
      const rect = chars[i]?.rect;
      if (rect) rects.push(rect);
    }
    return union(rects);
  });
}

async function pixelsDiffering(
  before: ScratchDocument,
  after: ScratchDocument,
  pageIndex: number,
): Promise<number> {
  const page = after.page(pageIndex);
  const box = deviceToUserRect(pageGeometry(page), {
    origin: { x: 0, y: 0 },
    size: { width: page.size.width, height: page.size.height },
  });
  const scale = RENDER_DPI / 72;
  const a = await before.renderArea(pageIndex, box, scale);
  const b = await after.renderArea(pageIndex, box, scale);
  if (a.width !== b.width || a.height !== b.height) return a.width * a.height;
  let differing = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (
      a.data[i] !== b.data[i] ||
      a.data[i + 1] !== b.data[i + 1] ||
      a.data[i + 2] !== b.data[i + 2] ||
      a.data[i + 3] !== b.data[i + 3]
    ) {
      differing++;
    }
  }
  return differing;
}

/** What `removeInvisibleText` left on a page (`replace: 'all-invisible'`). */
export interface OcrRemovalOutcome {
  readonly pageIndex: number;
  /** Invisible characters still on the page after the removal (must be 0). */
  readonly remaining: number;
}

export interface VerifyOcrLayerOptions {
  /** The removal outcome per page, when the plan asked for `all-invisible`. */
  readonly removal?: readonly OcrRemovalOutcome[];
}

/**
 * Checks the layer written from `plan` (`after`) against the source it was written to
 * (`before`). Every planned page is rendered on both sides, with or without new words: a
 * page whose words were all dropped may still have had its content regenerated
 * (`all-invisible`) or its earlier layer removed (`ours`).
 */
export async function verifyOcrLayer(
  before: ScratchDocument,
  after: ScratchDocument,
  plan: OcrLayerPlan,
  options: VerifyOcrLayerOptions = {},
): Promise<OcrLayerVerification> {
  const pages: OcrLayerPageCheck[] = [];
  const problems: string[] = [];
  let removalLeft = false;
  for (const { pageIndex, remaining } of options.removal ?? []) {
    if (remaining > 0) {
      removalLeft = true;
      problems.push(
        `Page ${pageIndex + 1}: ${remaining} invisible character(s) could not be removed`,
      );
    }
  }
  for (const planned of plan.pages) {
    const { pageIndex } = planned;
    const words = planned.words.filter(writableWord);
    const located =
      words.length === 0
        ? []
        : locateWords(
            await after.chars(pageIndex),
            words.map((w) => w.text),
          );
    let found = 0;
    let within = 0;
    let worst = 0;
    const missing: string[] = [];
    located.forEach((rect, i) => {
      const word = words[i];
      if (!word) return;
      if (!rect) {
        missing.push(word.text);
        return;
      }
      found++;
      const deviation = edgeDeviation(rect, layerWordRect(word));
      worst = Math.max(worst, deviation);
      if (deviation <= OCR_RECT_TOLERANCE) within++;
    });
    const differing = await pixelsDiffering(before, after, pageIndex);
    pages.push({
      pageIndex,
      words: words.length,
      found,
      within2pt: within,
      worstDeviation: Math.round(worst * 100) / 100,
      pixelsDiffering: differing,
    });
    if (missing.length > 0) {
      problems.push(
        `Page ${pageIndex + 1}: ${missing.length} word(s) not found in the text layer ` +
          `(${missing.slice(0, 5).join(', ')})`,
      );
    }
    if (within < found) {
      problems.push(
        `Page ${pageIndex + 1}: ${found - within} word(s) more than ${OCR_RECT_TOLERANCE} pt ` +
          `from their place (worst ${worst.toFixed(2)} pt)`,
      );
    }
    if (differing > 0) {
      problems.push(`Page ${pageIndex + 1}: the render changed (${differing} pixels at 150 dpi)`);
    }
  }
  const ok =
    !removalLeft &&
    pages.every((p) => p.found === p.words && p.within2pt === p.found && p.pixelsDiffering === 0);
  return { ok, pages, problems };
}
