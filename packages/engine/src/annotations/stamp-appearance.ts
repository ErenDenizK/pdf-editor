/**
 * Text-only appearances for named stamps. PDFium draws no appearance for /Name stamps and
 * viewers disagree on whether (and how) they draw one themselves, so the engine generates
 * a one-page PDF (a bordered label in Helvetica-Bold) that EmbedPDF turns into the stamp's
 * /AP (`EPDFAnnot_SetAppearanceFromPage`).
 */

import { PDFDocument, rgb, StandardFonts } from '@cantoo/pdf-lib';

/** Stamps drawn in green; every other name is drawn in red. */
const POSITIVE = new Set(['Approved', 'Final', 'Completed', 'Accepted', 'ForPublicRelease']);

/** `NotForPublicRelease` → `NOT FOR PUBLIC RELEASE`. */
export function stampLabel(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .toUpperCase();
}

function parseHex(color: string | undefined): { r: number; g: number; b: number } | undefined {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color ?? '');
  if (!m) return undefined;
  return {
    r: Number.parseInt(m[1] as string, 16) / 255,
    g: Number.parseInt(m[2] as string, 16) / 255,
    b: Number.parseInt(m[3] as string, 16) / 255,
  };
}

/**
 * A PDF with one page of `width` × `height` points showing the stamp label, scaled to fit.
 * `color` (#RRGGBB) overrides the default green/red.
 */
export async function namedStampAppearance(
  name: string,
  width: number,
  height: number,
  color?: string,
): Promise<ArrayBuffer> {
  const w = Math.max(width, 1);
  const h = Math.max(height, 1);
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([w, h]);
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const c =
    parseHex(color) ??
    (POSITIVE.has(name) ? { r: 0.13, g: 0.55, b: 0.13 } : { r: 0.8, g: 0.1, b: 0.1 });
  const ink = rgb(c.r, c.g, c.b);
  const border = Math.max(1, Math.min(w, h) * 0.06);
  page.drawRectangle({
    x: border / 2,
    y: border / 2,
    width: w - border,
    height: h - border,
    borderColor: ink,
    borderWidth: border,
  });
  const label = stampLabel(name);
  const inner = { width: w - 4 * border, height: h - 4 * border };
  const unit = font.widthOfTextAtSize(label, 1);
  const size = Math.max(1, Math.min(inner.width / unit, inner.height * 0.7));
  const textWidth = unit * size;
  page.drawText(label, {
    x: (w - textWidth) / 2,
    y: (h - font.heightAtSize(size, { descender: false })) / 2,
    size,
    font,
    color: ink,
  });
  const bytes = await doc.save({ useObjectStreams: false });
  return bytes.slice().buffer;
}
