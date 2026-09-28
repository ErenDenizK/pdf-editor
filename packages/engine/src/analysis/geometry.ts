/**
 * Page frames for the analysis worker: pixels of a render in display orientation (top-left
 * origin, y down, after /Rotate and the view rotation) to user space (unrotated, bottom-left
 * origin, absolute coordinates), and rect helpers.
 */
import type { Rect, Size } from '@pdf-editor/document-model';

import { deviceToUserRect, type PageGeometry, unionRect } from '../pdfium/coords';
import type { ComparePageGeometry } from '../types';

export { unionRect };

/** The page as displayed: size in points after rotation. */
export function displaySizeOf(page: ComparePageGeometry): Size {
  const quarter = (page.rotation / 90) % 2 === 1;
  return quarter
    ? { width: page.size.height, height: page.size.width }
    : { width: page.size.width, height: page.size.height };
}

export function geometryOf(page: ComparePageGeometry): PageGeometry {
  const display = displaySizeOf(page);
  return {
    quarterTurns: ((page.rotation / 90) % 4) as 0 | 1 | 2 | 3,
    displayWidth: display.width,
    displayHeight: display.height,
    originX: page.origin?.x ?? 0,
    originY: page.origin?.y ?? 0,
  };
}

/**
 * Maps a pixel box of a render (`pixelWidth` × `pixelHeight` px of the whole displayed
 * page) to user space, clipped to the page. Undefined when the box lies outside the page.
 */
export function pixelBoxToUser(
  page: ComparePageGeometry,
  pixelWidth: number,
  pixelHeight: number,
  box: { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number },
): Rect | undefined {
  const g = geometryOf(page);
  const sx = g.displayWidth / pixelWidth;
  const sy = g.displayHeight / pixelHeight;
  const x0 = Math.max(0, box.x0 * sx);
  const y0 = Math.max(0, box.y0 * sy);
  const x1 = Math.min(g.displayWidth, box.x1 * sx);
  const y1 = Math.min(g.displayHeight, box.y1 * sy);
  if (x1 <= x0 || y1 <= y0) return undefined;
  return roundRect(
    deviceToUserRect(g, { origin: { x: x0, y: y0 }, size: { width: x1 - x0, height: y1 - y0 } }),
  );
}

/** Rounds to hundredths of a point (stable JSON, no float noise). */
export function roundRect(r: Rect): Rect {
  const round = (v: number) => Math.round(v * 100) / 100;
  return { x: round(r.x), y: round(r.y), width: round(r.width), height: round(r.height) };
}

export function rectCenter(r: Rect): { x: number; y: number } {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

export function containsPoint(r: Rect, p: { x: number; y: number }, pad = 0): boolean {
  return (
    p.x >= r.x - pad &&
    p.x <= r.x + r.width + pad &&
    p.y >= r.y - pad &&
    p.y <= r.y + r.height + pad
  );
}

/**
 * Merges rects that sit on the same line (vertical overlap over half the smaller height)
 * and touch or nearly touch horizontally: one rect per line of a multi-word span.
 */
export function mergeLineRects(rects: readonly Rect[], gap = 6): Rect[] {
  const out: Rect[] = [];
  for (const r of rects) {
    const last = out[out.length - 1];
    if (last) {
      const overlap = Math.min(last.y + last.height, r.y + r.height) - Math.max(last.y, r.y);
      const sameLine = overlap > Math.min(last.height, r.height) * 0.5;
      const near = r.x <= last.x + last.width + gap && r.x + r.width >= last.x - gap;
      if (sameLine && near) {
        out[out.length - 1] = unionRect([last, r]) as Rect;
        continue;
      }
    }
    out.push(r);
  }
  return out;
}
