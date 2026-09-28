/**
 * Verification of a written layer (spec §1.2–§1.3) on private scratch documents: every
 * planned word must come back from PDFium's page text in its place (within 2 pt of the box
 * it was written to, on every edge), and a render at 150 dpi of every OCR'd page must be
 * pixel-identical to the same page before (the layer is invisible, content and images
 * untouched).
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

/**
 * Finds `words` in order in a page's characters (a word PDFium placed elsewhere, e.g. at the
 * end of a skewed line, is looked for from the start of the page). Returns, per word, the
 * union of its characters' boxes, or undefined when the word is not there.
 */
export function locateWords(
  chars: readonly PageChar[],
  words: readonly string[],
): (Rect | undefined)[] {
  const text = chars.map((c) => c.text).join('');
  // Offsets of each character in `text` (a character can be two UTF-16 units).
  const starts: number[] = [];
  let offset = 0;
  for (const c of chars) {
    starts.push(offset);
    offset += c.text.length;
  }
  const charAt = new Map(starts.map((s, i) => [s, i]));
  const used = new Set<number>();
  let cursor = 0;
  return words.map((word) => {
    const find = (from: number): number => {
      let at = text.indexOf(word, from);
      while (at !== -1 && (used.has(at) || !charAt.has(at))) at = text.indexOf(word, at + 1);
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

/** Checks the layer written from `plan` (`after`) against the source it was written to. */
export async function verifyOcrLayer(
  before: ScratchDocument,
  after: ScratchDocument,
  plan: OcrLayerPlan,
): Promise<OcrLayerVerification> {
  const pages: OcrLayerPageCheck[] = [];
  const problems: string[] = [];
  for (const planned of plan.pages) {
    const { pageIndex } = planned;
    const words = planned.words.filter(writableWord);
    if (words.length === 0) continue;
    const located = locateWords(
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
  const ok = pages.every((p) => p.found === p.words && p.pixelsDiffering === 0);
  return { ok, pages, problems };
}
