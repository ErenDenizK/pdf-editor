/**
 * Tesseract's output (raster pixels, y down) to words in unrotated user space (research 07
 * §3–§4). Each word keeps its pixel box, gets its user-space ink box, and the layer
 * geometry the spike proved within 2 pt of PDFium's search rects: the origin on the line's
 * descender line under the word's left edge, the size = the line's row height, the advance =
 * the ink box's width, and the angle of the line's baseline (no `rotateAuto`: the raster's
 * own coordinates are kept, and skew comes from each line).
 */
import type { Rect } from '@pdf-editor/document-model';

import {
  OCR_LOW_CONFIDENCE,
  OCR_MIN_WORD_CONFIDENCE,
  type OcrLine,
  type OcrPixelBox,
  type OcrWord,
  type TextMatrix,
} from '../types';

/** The parts of tesseract.js's `Page` this module reads (`blocks` output). */
export interface TessWord {
  readonly text: string;
  readonly confidence: number;
  readonly bbox: OcrPixelBox;
}
export interface TessLine {
  readonly words: readonly TessWord[];
  readonly baseline: OcrPixelBox;
  readonly rowAttributes: {
    readonly ascenders: number;
    readonly descenders: number;
    readonly rowHeight: number;
  };
  readonly bbox: OcrPixelBox;
}
export interface TessBlock {
  readonly paragraphs: readonly { readonly lines: readonly TessLine[] }[];
}

export function mapPoint(m: TextMatrix, x: number, y: number): { x: number; y: number } {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

/** Axis-aligned user-space bounds of a pixel box. */
export function pixelBoxToUser(m: TextMatrix, box: OcrPixelBox): Rect {
  const corners = [
    mapPoint(m, box.x0, box.y0),
    mapPoint(m, box.x1, box.y0),
    mapPoint(m, box.x0, box.y1),
    mapPoint(m, box.x1, box.y1),
  ];
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** Points per pixel of the raster (the matrix is a similarity up to rounding). */
export function pointsPerPixel(m: TextMatrix): number {
  return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
}

export interface RecognisedWords {
  readonly words: OcrWord[];
  readonly lines: OcrLine[];
  /** Words below `OCR_MIN_WORD_CONFIDENCE`. */
  readonly dropped: number;
}

/** Kept words in reading order (blocks → paragraphs → lines → words). */
export function wordsFromBlocks(
  blocks: readonly TessBlock[],
  toUser: TextMatrix,
  minConfidence = OCR_MIN_WORD_CONFIDENCE,
): RecognisedWords {
  const s = pointsPerPixel(toUser);
  const words: OcrWord[] = [];
  const lines: OcrLine[] = [];
  let dropped = 0;
  for (const block of blocks) {
    for (const paragraph of block.paragraphs) {
      for (const line of paragraph.lines) {
        const b = line.baseline;
        const slope = b.x1 === b.x0 ? 0 : (b.y1 - b.y0) / (b.x1 - b.x0);
        // Baseline direction (pixels, y down) in user space.
        const dir = mapPoint(toUser, 1, slope);
        const origin0 = mapPoint(toUser, 0, 0);
        const angle = (Math.atan2(dir.y - origin0.y, dir.x - origin0.x) * 180) / Math.PI;
        const rowHeight =
          line.rowAttributes.rowHeight > 0
            ? line.rowAttributes.rowHeight
            : Math.max(1, line.bbox.y1 - line.bbox.y0);
        const fontSize = rowHeight * s;
        const descent = Math.abs(line.rowAttributes.descenders);
        const lineIndex = lines.length;
        let kept = 0;
        for (const word of line.words) {
          const text = word.text.trim().normalize('NFC');
          if (text === '') continue;
          if (word.confidence < minConfidence) {
            dropped++;
            continue;
          }
          const box = word.bbox;
          const baselineY = b.y0 + slope * (box.x0 - b.x0);
          const origin = mapPoint(toUser, box.x0, baselineY + descent);
          words.push({
            text,
            origin,
            width: Math.max(0, box.x1 - box.x0) * s,
            fontSize,
            angle,
            confidence: word.confidence,
            rect: pixelBoxToUser(toUser, box),
            pixelBox: box,
            line: lineIndex,
            lowConfidence: word.confidence < OCR_LOW_CONFIDENCE,
          });
          kept++;
        }
        if (kept > 0) lines.push({ baseline: b, angle, fontSize });
      }
    }
  }
  return { words, lines, dropped };
}

/** Tesseract language codes (ISO 639-2/T, with script suffixes) → BCP 47 for /Lang. */
const BCP47: Readonly<Record<string, string>> = {
  eng: 'en',
  tur: 'tr',
  deu: 'de',
  fra: 'fr',
  spa: 'es',
  ita: 'it',
  por: 'pt',
  nld: 'nl',
  rus: 'ru',
  pol: 'pl',
  ces: 'cs',
  swe: 'sv',
  dan: 'da',
  nor: 'no',
  fin: 'fi',
  ell: 'el',
  ukr: 'uk',
  ara: 'ar',
  heb: 'he',
  jpn: 'ja',
  kor: 'ko',
  chi_sim: 'zh-Hans',
  chi_tra: 'zh-Hant',
};

export function languageTag(code: string): string {
  return BCP47[code] ?? code.split('_')[0] ?? code;
}
