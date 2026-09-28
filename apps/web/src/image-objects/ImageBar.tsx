/**
 * Contextual bar of the selected image (M4 §3): Replace… (PNG, JPEG or WebP), Extract (the
 * original JPEG or a PNG), Delete, and the size readout (points on the page, pixels and
 * effective dpi, live while resizing). An image inside a Form XObject shows that changes
 * may reach other pages. Placed above the selection (below it at the top of the page),
 * upright whatever the page rotation. One Tab stop (roving tabindex, DESIGN.md §5): arrow
 * keys, Home and End move between its buttons.
 */
import { Download, ImageUp, Layers, Trash2 } from 'lucide-react';
import { type KeyboardEvent, useLayoutEffect, useRef, useState } from 'react';

import { type Box, cssBoxToUser, type PageFrame } from '../annotations/geometry';
import { pickFiles } from '../files/open-files';
import { formatNumber, m } from '../i18n';
import { useWorkspaceStore } from '../state/workspace-store';
import { deleteImage, extractImage, replaceImage } from './actions';
import styles from './ImageObjects.module.css';
import type { ImageSelection } from './image-store';
import { formatPt, sizeReadout } from './readout';

const BAR_HEIGHT = 40;
const GAP = 12;
/** Width assumed before the bar has been measured. */
const INITIAL_WIDTH = 420;

export function ImageBar({
  selection,
  frame,
  box,
  preview,
}: {
  readonly selection: ImageSelection;
  readonly frame: PageFrame;
  /** The selection box shown, CSS pixels. */
  readonly box: Box;
  /** The box being dragged, for the live readout. */
  readonly preview?: Box;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(INITIAL_WIDTH);
  const [working, setWorking] = useState(false);
  /** The button that is the bar's Tab stop. */
  const [focusIndex, setFocusIndex] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      if (element.offsetWidth > 0) setWidth(element.offsetWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const title = useWorkspaceStore((s) => {
    const id = s.workspace.activeDocument;
    return (id ? s.workspace.documents[id]?.title : undefined) ?? '';
  });

  const { image, target } = selection;
  const size = sizeReadout(image, preview ? cssBoxToUser(frame, preview) : image.bounds);
  const pageWidth =
    (frame.rotation === 90 || frame.rotation === 270 ? frame.size.height : frame.size.width) *
    frame.scale;
  const above = box.top - BAR_HEIGHT - GAP >= -BAR_HEIGHT;
  const y = above ? box.top - BAR_HEIGHT - GAP : box.top + box.height + GAP;
  const x =
    width >= pageWidth
      ? (pageWidth - width) / 2
      : Math.min(Math.max(box.left + box.width / 2 - width / 2, 0), pageWidth - width);

  const run = async (task: () => Promise<unknown>) => {
    if (working) return;
    setWorking(true);
    try {
      await task();
    } finally {
      setWorking(false);
    }
  };

  const disabled = working || preview !== undefined;
  // Buttons in order: Replace, Extract, Delete (enabled or disabled together).
  const tabFor = (index: number) => (index === focusIndex ? 0 : -1);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const buttons = Array.from(
      ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [],
    );
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0 || event.altKey || event.ctrlKey || event.metaKey) return;
    let next: number | null = null;
    if (event.key === 'ArrowRight') next = (index + 1) % buttons.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + buttons.length) % buttons.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = buttons.length - 1;
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    const button = buttons[next];
    if (!button) return;
    const all = Array.from(ref.current?.querySelectorAll('button') ?? []);
    setFocusIndex(all.indexOf(button));
    button.focus();
  };

  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label={m.image_object_bar_label()}
      className={styles.bar}
      data-testid="image-bar"
      style={{ left: x, top: y }}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={onKeyDown}
    >
      <span className={styles.readout} data-testid="image-size">
        <span>
          {m.image_object_size({ width: formatPt(size.width), height: formatPt(size.height) })}
        </span>
        <span className={styles.readoutDetail}>
          {m.image_object_pixels({
            width: formatNumber(size.pixelWidth),
            height: formatNumber(size.pixelHeight),
            dpi: formatNumber(size.dpi),
          })}
        </span>
      </span>
      {image.inForm ? (
        <span className={styles.note} data-testid="image-in-form">
          <Layers aria-hidden="true" />
          {m.image_object_in_form()}
        </span>
      ) : null}
      <span className={styles.divider} aria-hidden="true" />
      <button
        type="button"
        className={styles.action}
        disabled={disabled}
        tabIndex={tabFor(0)}
        onFocus={() => setFocusIndex(0)}
        onClick={() =>
          run(async () => {
            const [file] = await pickFiles('images');
            if (file) await replaceImage(target, image, file);
          })
        }
      >
        <ImageUp aria-hidden="true" />
        {m.image_object_replace()}
      </button>
      <button
        type="button"
        className={styles.action}
        title={
          image.filters.length === 1 && image.filters[0] === 'DCT' && !image.hasSMask
            ? m.image_object_extract_jpeg()
            : m.image_object_extract_png()
        }
        disabled={disabled}
        tabIndex={tabFor(1)}
        onFocus={() => setFocusIndex(1)}
        onClick={() => run(() => extractImage(target, image, title))}
      >
        <Download aria-hidden="true" />
        {m.image_object_extract()}
      </button>
      <button
        type="button"
        className={styles.action}
        data-tone="danger"
        disabled={disabled}
        tabIndex={tabFor(2)}
        onFocus={() => setFocusIndex(2)}
        onClick={() => run(() => deleteImage(target, image))}
      >
        <Trash2 aria-hidden="true" />
        {m.image_object_delete()}
      </button>
    </div>
  );
}
