/**
 * Scrub step 6 (research 06 §3 step 4.6): the fill, drawn by us because the engine applies
 * with no /IC and never draws /OverlayText.
 *
 * Per page with areas, the existing content is wrapped in q/Q and a new content stream is
 * appended after it, so the fill paints over everything the page draws and starts from the
 * initial graphics state (identity CTM). The stream sets its own ExtGState (opaque, Normal
 * blend, no soft mask) and draws each area as `re f` in the fill colour, then the overlay
 * text in Helvetica (a standard font, WinAnsi), centred, as large as fits (70 % of the
 * area's height, 90 % of its width). On a page with /Rotate the text is turned with the
 * page so it reads upright on screen. Areas are in unrotated user space.
 */

import { type PDFDocument, PDFArray, type PDFFont, PDFName, StandardFonts } from '@cantoo/pdf-lib';

import type { RedactionArea } from '../types';
import type { Rgb } from './pdf-util';
import type { RedactedStringMatcher } from './strings';

export interface FillOptions {
  readonly fill: Rgb;
  readonly overlayColor: Rgb;
  /** Default overlay text (an area's own text wins). */
  readonly overlayText?: string;
  readonly matcher: RedactedStringMatcher;
  readonly warnings: string[];
}

/** Helvetica cap height (per 1000 units): the overlay is centred on it. */
const CAP_HEIGHT = 0.718;
/** Overlay text smaller than this is not drawn (it would be unreadable). */
const MIN_FONT_SIZE = 2;

const num = (n: number): string => {
  const s = n.toFixed(3).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
};
const rgb = (c: Rgb): string => c.map(num).join(' ');

/** Draws the fills of `areas` (grouped by page) into `doc`. */
export async function drawFills(
  doc: PDFDocument,
  areasByPage: ReadonlyMap<number, readonly (RedactionArea & { readonly index: number })[]>,
  options: FillOptions,
): Promise<void> {
  const { context } = doc;
  let font: PDFFont | undefined;
  const pages = doc.getPages();
  for (const [pageIndex, areas] of areasByPage) {
    const page = pages[pageIndex];
    if (!page || areas.length === 0) continue;
    const rotation = ((page.getRotation().angle % 360) + 360) % 360;
    const gs = context.register(
      context.obj({ Type: 'ExtGState', CA: 1, ca: 1, BM: 'Normal', SMask: 'None', AIS: false }),
    );
    const gsName = page.node.newExtGState('RedactGS', gs);
    let fontName: PDFName | undefined;
    const ops: string[] = ['q', `${gsName.toString()} gs`];
    for (const area of areas) {
      const { x, y, width, height } = area.rect;
      ops.push(`${rgb(options.fill)} rg`, `${num(x)} ${num(y)} ${num(width)} ${num(height)} re f`);
      const text = (area.overlayText ?? options.overlayText ?? '').trim();
      if (text === '') continue;
      if (options.matcher.matches(text)) {
        options.warnings.push(
          `Overlay text of area ${area.index} contains a redacted string; not drawn`,
        );
        continue;
      }
      font ??= await doc.embedFont(StandardFonts.Helvetica);
      let encoded: string;
      let unitWidth: number;
      try {
        encoded = font.encodeText(text).toString();
        unitWidth = font.widthOfTextAtSize(text, 1);
      } catch {
        options.warnings.push(
          `Overlay text of area ${area.index} has characters Helvetica cannot draw; not drawn`,
        );
        continue;
      }
      const sideways = rotation === 90 || rotation === 270;
      const along = sideways ? height : width;
      const across = sideways ? width : height;
      const size = Math.min(across * 0.7, unitWidth > 0 ? (along * 0.9) / unitWidth : 0);
      if (!(size >= MIN_FONT_SIZE)) {
        options.warnings.push(
          `Overlay text of area ${area.index} does not fit the area; not drawn`,
        );
        continue;
      }
      fontName ??= page.node.newFontDictionary('RedactF', font.ref);
      const theta = (rotation * Math.PI) / 180;
      const cos = Math.round(Math.cos(theta));
      const sin = Math.round(Math.sin(theta));
      const u = -(unitWidth * size) / 2;
      const v = -(CAP_HEIGHT * size) / 2;
      const tx = x + width / 2 + u * cos - v * sin;
      const ty = y + height / 2 + u * sin + v * cos;
      ops.push(
        'BT',
        `${fontName.toString()} ${num(size)} Tf`,
        `${rgb(options.overlayColor)} rg 0 Tr 0 Tc 0 Tw 100 Tz 0 Ts`,
        `${num(cos)} ${num(sin)} ${num(-sin)} ${num(cos)} ${num(tx)} ${num(ty)} Tm`,
        `${encoded} Tj`,
        'ET',
      );
    }
    ops.push('Q');
    appendContent(doc, pageIndex, ops.join('\n'));
  }
}

/** Wraps the page's content in q/Q and appends `ops` as a new stream after it. */
function appendContent(doc: PDFDocument, pageIndex: number, ops: string): void {
  const { context } = doc;
  const page = doc.getPages()[pageIndex];
  if (!page) return;
  const node = page.node;
  const contents = node.get(PDFName.of('Contents'));
  const resolved = context.lookup(contents);
  const existing: ReturnType<PDFArray['get']>[] = [];
  if (resolved instanceof PDFArray) {
    for (let i = 0; i < resolved.size(); i++) existing.push(resolved.get(i));
  } else if (contents) existing.push(contents);
  const push = context.register(context.stream('q\n'));
  const pop = context.register(context.stream('\nQ\n'));
  const fill = context.register(context.flateStream(`${ops}\n`));
  node.set(PDFName.of('Contents'), context.obj([push, ...existing, pop, fill]));
}
