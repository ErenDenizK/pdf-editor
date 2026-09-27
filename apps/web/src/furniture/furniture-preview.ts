/**
 * Preview geometry: what FurnitureLayer draws, computed with the same layout function the
 * assembler uses (`layoutOverlay` from `@pdf-editor/engine/overlay-geometry`). Display
 * space (points, y up, origin bottom-left of the page as shown) becomes SVG user space
 * (points, y down) with a single flip, `svgY = pageHeight - y`.
 */
import {
  type BatesConfig,
  type DocumentId,
  effectiveBates,
  type OverlayOp,
  type OverlayRole,
  type Size,
  type Workspace,
} from '@pdf-editor/document-model';
import {
  layoutOverlay,
  type LaidOutOverlay,
  type OverlayBox,
  type OverlayMeasure,
  SYNTHETIC_ITALIC_DEGREES,
} from '@pdf-editor/engine/overlay-geometry';

import { replaceFurniture } from './furniture-model';
import type { FurniturePreview } from './furniture-store';

/** The overlays a page shows: committed, or with the open dialog's preview swapped in. */
export function overlaysForPage(
  overlays: readonly OverlayOp[],
  documentId: DocumentId | undefined,
  preview: FurniturePreview | null,
): readonly OverlayOp[] {
  if (!preview || documentId === undefined || !preview.documents.includes(documentId)) {
    return overlays;
  }
  return replaceFurniture(overlays, preview.kind, preview.overlays);
}

/**
 * Bates numbering in effect for a document: the open dialog's preview, else the
 * document's own with the run's start resolved from the current page counts.
 */
export function batesFor(
  ws: Workspace,
  documentId: DocumentId,
  preview: FurniturePreview | null,
): BatesConfig | undefined {
  return preview?.bates?.[documentId] ?? effectiveBates(ws, documentId);
}

export interface PagePreviewInput {
  readonly index: number;
  readonly count: number;
  /** Displayed page size in points. */
  readonly page: Size;
  readonly label: string;
  readonly title: string;
  readonly date: Date;
  readonly locale?: string;
  readonly bates?: BatesConfig;
}

export function layoutPage(
  overlays: readonly OverlayOp[],
  input: PagePreviewInput,
  measure: OverlayMeasure,
): LaidOutOverlay[] {
  const text = {
    label: input.label,
    title: input.title,
    date: input.date,
    ...(input.locale ? { locale: input.locale } : {}),
    ...(input.bates ? { bates: input.bates } : {}),
  };
  const out: LaidOutOverlay[] = [];
  for (const overlay of overlays) {
    const laid = layoutOverlay(
      overlay,
      { index: input.index, count: input.count, page: input.page, text },
      measure,
    );
    if (laid) out.push(laid);
  }
  return out;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * SVG transform placing a box: turned `rotate` degrees counter-clockwise around its centre
 * (SVG rotates clockwise, y down), then translated to its lower-left corner (the text
 * baseline origin), optionally skewed for a synthesized italic.
 */
export function boxTransform(box: OverlayBox, pageHeight: number, italic = false): string {
  const cx = box.x + box.width / 2;
  const cy = pageHeight - (box.y + box.height / 2);
  const parts: string[] = [];
  if (box.rotate % 360 !== 0) parts.push(`rotate(${round(-box.rotate)} ${round(cx)} ${round(cy)})`);
  parts.push(`translate(${round(box.x)} ${round(pageHeight - box.y)})`);
  if (italic) parts.push(`skewX(${-SYNTHETIC_ITALIC_DEGREES})`);
  return parts.join(' ');
}

/**
 * Whether a display-space point hits a box (with `slop` points of tolerance), rotation
 * included.
 */
export function boxContains(box: OverlayBox, point: { x: number; y: number }, slop = 3): boolean {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const rad = (-box.rotate * Math.PI) / 180;
  const dx = point.x - cx;
  const dy = point.y - cy;
  const lx = dx * Math.cos(rad) - dy * Math.sin(rad);
  const ly = dx * Math.sin(rad) + dy * Math.cos(rad);
  return Math.abs(lx) <= box.width / 2 + slop && Math.abs(ly) <= box.height / 2 + slop;
}

/** The furniture role under a display-space point (last drawn wins), if any. */
export function roleAt(
  laid: readonly LaidOutOverlay[],
  point: { x: number; y: number },
): OverlayRole | undefined {
  for (let i = laid.length - 1; i >= 0; i--) {
    const item = laid[i] as LaidOutOverlay;
    const role = item.overlay.role;
    if (role === undefined) continue;
    // Text boxes are cap height; include descenders and a little air.
    if (item.boxes.some((box) => boxContains(box, point, item.kind === 'text' ? 4 : 1))) {
      return role;
    }
  }
  return undefined;
}
