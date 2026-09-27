/**
 * Runtime capability probes for engine behaviour the annotation tools depend on
 * (ADR-0007: detect capabilities, do not assume versions). Each probe runs once, lazily,
 * against a tiny synthetic document opened next to the user's files and closed again.
 *
 * - `rotatedRectReadBack`: EmbedPDF 2.15 reports annotation /Rect on /Rotate 90/180/270
 *   pages from the (left, top) corner with the *unrotated* size, so an adapter that maps
 *   it like other device rects returns a transposed / shifted rect (writes are correct).
 *   When the adapter reads back what it wrote, no correction is applied.
 */
import type { Rect, SourceId } from '@pdf-editor/document-model';
import type { Annotation, PdfEditor, PdfRenderer } from '@pdf-editor/engine';

/** A one-page PDF (200 × 100 pt MediaBox) with the given /Rotate. */
export function syntheticPdf(rotate: 0 | 90 | 180 | 270): ArrayBuffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Rotate ${rotate} /Resources << >> >>`,
  ];
  let body = '%PDF-1.7\n';
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(body).buffer;
}

export type RectFix = (rect: Rect, quarterTurns: number) => Rect;

const identity: RectFix = (rect) => rect;

/** Inverts the faulty read-back (see the module comment) for a page turned `quarterTurns`. */
export const correctRotatedRect: RectFix = (out, quarterTurns) => {
  switch (quarterTurns & 3) {
    case 1:
      return { x: out.x, y: out.y - out.width, width: out.height, height: out.width };
    case 2:
      return { x: out.x + out.width, y: out.y - out.height, width: out.width, height: out.height };
    case 3:
      return {
        x: out.x + out.width,
        y: out.y + out.height - out.width,
        width: out.height,
        height: out.width,
      };
    default:
      return out;
  }
};

const near = (a: Rect, b: Rect) =>
  Math.abs(a.x - b.x) < 0.5 &&
  Math.abs(a.y - b.y) < 0.5 &&
  Math.abs(a.width - b.width) < 0.5 &&
  Math.abs(a.height - b.height) < 0.5;

let rectFix: Promise<RectFix> | undefined;

type ProbeEngine = PdfEditor & Partial<Pick<PdfRenderer, 'open' | 'close'>>;

/**
 * How to read annotation rects from this engine: identity when it reads back what it
 * wrote, `correctRotatedRect` when it shows the EmbedPDF quirk.
 */
export function rotatedRectFix(editor: ProbeEngine): Promise<RectFix> {
  rectFix ??= (async () => {
    if (!editor.open || !editor.close) return identity;
    const id = `annotation-probe-${Math.random().toString(36).slice(2)}` as SourceId;
    try {
      await editor.open(id, syntheticPdf(90));
      const wanted: Rect = { x: 10, y: 20, width: 40, height: 16 };
      const created: Annotation = await editor.createAnnotation(id, {
        kind: 'square',
        pageIndex: 0,
        rect: wanted,
        strokeWidth: 1,
      });
      if (near(created.rect, wanted)) return identity;
      if (near(correctRotatedRect(created.rect, 1), wanted)) return correctRotatedRect;
      console.warn('Unexpected annotation rect read-back on rotated pages', created.rect);
      return identity;
    } catch (error) {
      console.warn('Annotation rect probe failed', error);
      return identity;
    } finally {
      await editor.close(id).catch(() => undefined);
    }
  })();
  return rectFix;
}

/** Tests: forget the probe result. */
export function resetEngineQuirks(): void {
  rectFix = undefined;
}
