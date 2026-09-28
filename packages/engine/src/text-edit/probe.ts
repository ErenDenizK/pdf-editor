/**
 * Reading codes through PDFium (review M3). PDFium has no call that maps a character code to
 * its Unicode value or glyph, so the editor draws probe objects: each code twice, in the
 * object's font, alone on its own line (off the page, where nothing else is), and reads them
 * on a fresh text page. The text page is the same reader the read-back uses, so what a probe
 * says a code reads as is what the verification will see.
 *
 * The text page folds a run of spaces on a line into one character, so a probe of a space
 * code shows one character and no advance.
 */
import type { Rect } from '@pdf-editor/document-model';

import type { RawAccess } from '../pdfium/host/hosted-engine';
import type { RawText } from './raw';

/** Font size of the probes (large enough to tell glyphs apart). */
const PROBE_SIZE = 24;
/** Scale of the probe renderings compared by `sameRendering`. */
const RENDER_SCALE = 2;
/** Vertical distance between probe lines, points. */
const LINE_STEP = 60;
/** Where the probes start: far below the page, so they never share a line with page text. */
const PROBE_ORIGIN_Y = -100_000;

/** What a code reads as and how it draws. */
export interface CodeProbe {
  readonly code: number;
  /** Text of the code (several characters for a ligature, `\0` for none). */
  readonly text: string;
  /** PDFium derived the text from the code number (the font maps it to nothing). */
  readonly mapError: boolean;
  /** Advance at `PROBE_SIZE` in unscaled text space; NaN when not measurable (spaces). */
  readonly advance: number;
  /** Glyph box relative to the origin, at `PROBE_SIZE`. */
  readonly box: Rect;
}

export interface CodeProbes {
  readonly results: ReadonlyMap<number, CodeProbe>;
  /** Whether two probed codes render identically (pixel for pixel, at the same phase). */
  sameRendering(a: number, b: number): boolean;
  /** Removes the probe objects from the page. */
  dispose(): void;
}

/** Probes `codes` of `font` on the page; call `dispose` before anything else changes it. */
export function probeCodes(
  access: RawAccess,
  raw: RawText,
  pagePtr: number,
  font: number,
  codes: Iterable<number>,
): CodeProbes {
  const { m } = raw;
  const objects = new Map<number, number>();
  const byObj = new Map<number, number>();
  const dispose = () => {
    for (const obj of objects.values()) {
      if (m.FPDFPage_RemoveObject(pagePtr, obj)) m.FPDFPageObj_Destroy(obj);
    }
    objects.clear();
  };
  try {
    let line = 0;
    for (const code of new Set(codes)) {
      const obj = raw.createCharcodes(access.docPtr, font, PROBE_SIZE, [code, code]);
      // Whole-point positions: renderings of equal glyphs are then equal pixel for pixel.
      raw.setMatrix(obj, [1, 0, 0, 1, 0, PROBE_ORIGIN_Y - LINE_STEP * line]);
      line += 1;
      m.FPDFPage_InsertObject(pagePtr, obj);
      objects.set(code, obj);
      byObj.set(obj, code);
    }
    const results = new Map<number, CodeProbe>();
    raw.withTextPage(pagePtr, (textPage) => {
      const found = new Map<
        number,
        {
          origin: { x: number; y: number };
          text: string;
          mapError: boolean;
          box: Rect;
          advance: number;
        }
      >();
      const count = raw.charCount(textPage);
      for (let i = 0; i < count; i++) {
        const code = byObj.get(raw.charObject(textPage, i));
        if (code === undefined || raw.isGenerated(textPage, i)) continue;
        const origin = raw.charOrigin(textPage, i);
        const first = found.get(code);
        if (!first) {
          const box = raw.charBox(textPage, i);
          found.set(code, {
            origin,
            text: raw.charText(textPage, i),
            mapError: raw.unicodeMapError(textPage, i),
            box: { x: box.x - origin.x, y: box.y - origin.y, width: box.width, height: box.height },
            advance: Number.NaN,
          });
        } else if (Number.isNaN(first.advance)) {
          if (origin.x === first.origin.x && origin.y === first.origin.y) {
            first.text += raw.charText(textPage, i); // more characters of the first code
          } else {
            first.advance = origin.x - first.origin.x;
          }
        }
      }
      for (const [code, f] of found) {
        results.set(code, {
          code,
          text: f.text,
          mapError: f.mapError,
          advance: f.advance,
          box: f.box,
        });
      }
    });
    const renderings = new Map<number, ReturnType<RawText['renderedText']>>();
    const rendering = (code: number) => {
      if (!renderings.has(code)) {
        const obj = objects.get(code);
        renderings.set(
          code,
          obj ? raw.renderedText(access.docPtr, pagePtr, obj, RENDER_SCALE) : undefined,
        );
      }
      return renderings.get(code);
    };
    return {
      results,
      sameRendering(a, b) {
        const x = rendering(a);
        const y = rendering(b);
        if (!x || !y) return !x && !y;
        if (x.width !== y.width || x.height !== y.height || x.bytes.length !== y.bytes.length) {
          return false;
        }
        for (let i = 0; i < x.bytes.length; i++) if (x.bytes[i] !== y.bytes[i]) return false;
        return true;
      },
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
