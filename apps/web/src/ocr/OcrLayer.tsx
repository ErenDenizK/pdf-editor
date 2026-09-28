/**
 * The focused OCR word on its page (spec recognize-and-compare §1.3, DESIGN.md §3): a 1px
 * accent ring around the word the OCR section focused (J / K or a click). Only that word is
 * marked; the page is never tinted.
 */
import type { PageOverlayProps } from '../stage/page-overlays';
import { userRectToCss } from '../viewer/geometry';
import { pageFrame } from '../viewer/page-frame';
import styles from './Ocr.module.css';
import { useOcrStore } from './ocr-store';

export function OcrLayer(props: PageOverlayProps) {
  const focus = useOcrStore((s) => s.focus);
  if (focus?.pageId !== props.pageId) return null;
  const box = userRectToCss(pageFrame(props), focus.rect);
  return (
    <div className={styles.layer} aria-hidden="true" data-testid="ocr-focus-layer">
      <div
        className={styles.ring}
        data-testid="ocr-focus-ring"
        style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
      />
    </div>
  );
}
