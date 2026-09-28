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

import styles from './ResizedContent.module.css';

/** Where a resized page's content shows, plus the content's displayed size in points. */
export interface ContentFrame extends ContentPlacement {
  readonly widthPt: number;
  readonly heightPt: number;
}

/** The content frame of a resized page; undefined for pages without a resize. Never throws. */
export function contentFrame(ws: Workspace, page: VirtualPage): ContentFrame | undefined {
  if (page.resize === undefined) return undefined;
  try {
    const placement = pageContentPlacement(ws, page);
    if (placement === undefined) return undefined;
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
