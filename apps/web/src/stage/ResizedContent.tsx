/**
 * Shows a resized page (`VirtualPage.resize`) on screen the way the export draws it: the
 * page sheet takes the new displayed size (`displaySize`), and the page bitmap, which the
 * engine renders for the *content* box, sits inside it at `pageContentPlacement` (the
 * model's resize math, shared with the assembler). Margins show the sheet's paper colour;
 * content cut off by `scale` or a shrinking canvas is clipped by the sheet
 * (`overflow: hidden`).
 *
 * Any surface that draws page bitmaps (Arrange cells, the resize dialog preview; Read mode
 * and the Pages panel can adopt it) wraps its `PageCanvas` in `ResizedContent` and passes
 * the canvas the content size from `contentFrame` so the bitmap scale is chosen for it.
 *
 * A cropped page (`VirtualPage.cropBox`, crop/display.ts) is placed the same way: the
 * engine renders the whole page box, which `contentFrame` places relative to the crop
 * (composed with the resize placement when the page is also resized), and the sheet clips.
 */
import {
  pageContentPlacement,
  pageContentSize,
  pageTotalRotation,
  type ContentPlacement,
  type VirtualPage,
  type Workspace,
} from '@pdf-editor/document-model';
import type { ReactNode } from 'react';

import { cropFrame } from '../crop/display';
import { composePlacement } from '../crop/geometry';
import styles from './ResizedContent.module.css';

/** Where a resized page's content shows, plus the content's displayed size in points. */
export interface ContentFrame extends ContentPlacement {
  readonly widthPt: number;
  readonly heightPt: number;
}

/**
 * The content frame of a resized or cropped page: where the page bitmap goes on the sheet
 * and the size in points the bitmap covers; undefined for pages without either. Never
 * throws.
 */
export function contentFrame(ws: Workspace, page: VirtualPage): ContentFrame | undefined {
  const cropped = cropFrame(ws, page);
  if (page.resize === undefined) return cropped;
  try {
    const placement = pageContentPlacement(ws, page);
    if (placement === undefined) return cropped;
    if (cropped !== undefined) {
      const { widthPt, heightPt, ...inner } = cropped;
      return { ...composePlacement(placement, inner), widthPt, heightPt };
    }
    const content = pageContentSize(ws, page);
    const rotation = pageTotalRotation(ws, page);
    const quarter = rotation === 90 || rotation === 270;
    return {
      ...placement,
      widthPt: quarter ? content.height : content.width,
      heightPt: quarter ? content.width : content.height,
    };
  } catch {
    return undefined;
  }
}

const percent = (fraction: number) => `${fraction * 100}%`;
const pixels = (value: number) => `${value}px`;

/**
 * Positions `children` (a `PageCanvas`) over the content box of a resized page; without a
 * frame the children fill the sheet as before. `unit: 'px'` takes the box in CSS pixels
 * (Read mode snaps it to device pixels so the exact-scale bitmap is drawn 1:1); otherwise
 * it is in fractions of the sheet (`ContentPlacement`).
 */
export function ResizedContent({
  frame,
  unit = 'fraction',
  children,
}: {
  readonly frame: Pick<ContentPlacement, 'left' | 'top' | 'width' | 'height'> | undefined;
  readonly unit?: 'fraction' | 'px';
  readonly children: ReactNode;
}) {
  if (frame === undefined) return children;
  const at = unit === 'px' ? pixels : percent;
  return (
    <div
      className={styles.content}
      data-resized=""
      style={{
        left: at(frame.left),
        top: at(frame.top),
        width: at(frame.width),
        height: at(frame.height),
      }}
    >
      {children}
    </div>
  );
}
