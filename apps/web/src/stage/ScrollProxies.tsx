/**
 * Scroll bars for the full-bleed Read viewport (craft spec §7). The viewport covers the app
 * shell, so its own bars would sit under the inspector and the status bar; it hides them, and
 * these native bars stand in for them where they used to be, at the edges of the unobscured
 * rectangle. Each is an empty scroller whose content has the page column's size, so its range
 * and thumb are the old bar's, and its position follows the viewport both ways, one pixel for
 * one pixel. Pointer only (decorative for assistive technology): the viewport keeps keyboard
 * scrolling and its focus stop.
 */
import { useEffect, useLayoutEffect, useRef } from 'react';

import styles from './ReadView.module.css';
import type { Size } from './stage-bleed';

/** A thickness to hover and drag where bars overlay the content (no classic bar size). */
const OVERLAY_THICKNESS = 12;

export function ScrollProxies({
  target,
  content,
  vertical,
  horizontal,
  size,
}: {
  /** The viewport the bars scroll. */
  readonly target: HTMLElement | null;
  /** The page column's size without the frame's insets: the old scroll content. */
  readonly content: Size;
  readonly vertical: boolean;
  readonly horizontal: boolean;
  /** Classic scroll bar thickness, 0 for overlay bars. */
  readonly size: number;
}) {
  const verticalRef = useRef<HTMLDivElement>(null);
  const horizontalRef = useRef<HTMLDivElement>(null);
  // The position each bar was last given from the viewport: its own scroll event then is an
  // echo, not the user, and must not drag the viewport back while it is still moving.
  const written = useRef({ top: Number.NaN, left: Number.NaN });

  const follow = () => {
    const bar = verticalRef.current;
    const across = horizontalRef.current;
    if (!target) return;
    if (bar && Math.abs(bar.scrollTop - target.scrollTop) >= 0.5) {
      bar.scrollTop = target.scrollTop;
      written.current.top = bar.scrollTop;
    }
    if (across && Math.abs(across.scrollLeft - target.scrollLeft) >= 0.5) {
      across.scrollLeft = target.scrollLeft;
      written.current.left = across.scrollLeft;
    }
  };

  // After every render: the content size may have changed the bars' range.
  useLayoutEffect(follow);

  useEffect(() => {
    if (!target) return;
    const bar = verticalRef.current;
    const across = horizontalRef.current;
    const fromVertical = () => {
      if (!bar || Math.abs(bar.scrollTop - written.current.top) < 1) return;
      written.current.top = Number.NaN;
      if (Math.abs(target.scrollTop - bar.scrollTop) >= 1) target.scrollTop = bar.scrollTop;
    };
    const fromHorizontal = () => {
      if (!across || Math.abs(across.scrollLeft - written.current.left) < 1) return;
      written.current.left = Number.NaN;
      if (Math.abs(target.scrollLeft - across.scrollLeft) >= 1) {
        target.scrollLeft = across.scrollLeft;
      }
    };
    target.addEventListener('scroll', follow, { passive: true });
    bar?.addEventListener('scroll', fromVertical, { passive: true });
    across?.addEventListener('scroll', fromHorizontal, { passive: true });
    return () => {
      target.removeEventListener('scroll', follow);
      bar?.removeEventListener('scroll', fromVertical);
      across?.removeEventListener('scroll', fromHorizontal);
    };
    // `follow` reads only refs and `target`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, vertical, horizontal]);

  const thickness = size > 0 ? size : OVERLAY_THICKNESS;
  return (
    <>
      {vertical ? (
        <div
          ref={verticalRef}
          className={styles.barVertical}
          style={{ width: thickness, bottom: horizontal ? size : 0 }}
          aria-hidden="true"
          tabIndex={-1}
          data-scroll-proxy="vertical"
        >
          <div style={{ width: 1, height: content.height }} />
        </div>
      ) : null}
      {horizontal ? (
        <div
          ref={horizontalRef}
          className={styles.barHorizontal}
          style={{ height: thickness, right: vertical ? size : 0 }}
          aria-hidden="true"
          tabIndex={-1}
          data-scroll-proxy="horizontal"
        >
          <div style={{ width: content.width, height: 1 }} />
        </div>
      ) : null}
    </>
  );
}
