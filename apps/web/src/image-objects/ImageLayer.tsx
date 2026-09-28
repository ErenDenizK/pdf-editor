/**
 * Image layer (M4 §3), a page overlay in Read mode. With the Image tool (I) it takes the
 * page: every image object of the page becomes a target over its bounds; hovering the page
 * outlines them and fills the one under the pointer. A click selects an image (a selection
 * box with eight handles and the contextual bar); dragging it moves it, dragging a handle
 * resizes it (Shift keeps the aspect ratio, Alt resizes from the centre). Each committed
 * drag is one history entry. With the selection focused, arrow keys nudge by 1 pt (Shift:
 * 10 pt), Mod+Arrow resizes it keeping the aspect ratio (Right / Up grow, Left / Down
 * shrink the longer side by 1 pt, Shift: 10 pt; the new size is announced), Delete removes
 * the image and Esc deselects.
 *
 * Images are located again for every page revision (object paths go stale after any
 * edit); after an edit the layer selects the image again where it expects it.
 */
import type { LocatedImage } from '@pdf-editor/engine';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';

import type { PageTarget } from '../annotations/annotation-store';
import { currentPlatform, parseShortcut, toAriaKeyShortcut } from '../commands/shortcuts';
import { type Box, cssBoxToUser, type PageFrame, rectToCss } from '../annotations/geometry';
import { m } from '../i18n';
import type { PageOverlayProps } from '../stage/page-overlays';
import { usePageRevision } from '../text-edit/runs';
import { pageFrame } from '../viewer/page-frame';
import { useToolStore } from '../viewer/tool-store';
import { deleteImage, transformImage } from './actions';
import {
  boxChanged,
  HANDLES,
  type Handle,
  handlePoint,
  keyResizeBox,
  moveBox,
  nudgeOffset,
  resizeBox,
} from './handles';
import { ImageBar } from './ImageBar';
import { usePageImages } from './images';
import styles from './ImageObjects.module.css';
import { type ImageSelection, useImageStore } from './image-store';
import { formatPt, sameImage } from './readout';

/** Pointer travel before a press on an image becomes a move, CSS pixels. */
const DRAG_THRESHOLD = 3;
/** Size of a handle square, CSS pixels. */
const HANDLE_SIZE = 8;
/** `aria-keyshortcuts` of the selection. */
const SELECTION_KEYS = [
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  ...['Up', 'Down', 'Left', 'Right'].map((key) =>
    toAriaKeyShortcut(parseShortcut(`Mod+${key}`), currentPlatform),
  ),
  'Delete',
  'Escape',
].join(' ');

interface Gesture {
  readonly kind: 'move' | 'resize';
  readonly box: Box;
}

export function ImageLayer(props: PageOverlayProps) {
  const { sourceId, sourceIndex, pageId, pageIndex, visible } = props;
  const active = useToolStore((s) => s.mode === 'image');
  const selection = useImageStore((s) =>
    s.selection?.target.pageId === pageId ? s.selection : null,
  );
  const busy = useImageStore((s) => s.busy);
  /** The rect of an edit in flight: shown until the page is located again. */
  const expected = useImageStore((s) => (s.expect?.target.pageId === pageId ? s.expect : null));
  const revision = usePageRevision(sourceId, sourceIndex);
  const images = usePageImages(active && visible ? sourceId : undefined, sourceIndex, revision);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const selectionRef = useRef<HTMLButtonElement>(null);
  const keysId = useId();

  // Located again (after an edit, undo or redo): keep or restore the selection.
  useEffect(() => {
    if (!images || sourceId === undefined) return;
    const store = useImageStore.getState();
    const wanted = store.expect;
    if (wanted?.target.pageId === pageId) {
      // Wait for the revision the edit made (the images of the old one are still shown).
      if (busy) return;
      const found = images.find((i) => sameImage(i.bounds, wanted.bounds));
      store.select(found ? { target: wanted.target, image: found, revision } : null);
      store.setExpect(null);
      return;
    }
    const current = store.selection;
    if (current?.target.pageId === pageId && current.revision !== revision) {
      const found = images.find(
        (i) =>
          sameImage(i.bounds, current.image.bounds) &&
          i.pixelWidth === current.image.pixelWidth &&
          i.pixelHeight === current.image.pixelHeight,
      );
      store.select(found ? { ...current, image: found, revision } : null);
    }
  }, [images, revision, pageId, sourceId, busy]);

  // A new selection on this page takes the keyboard focus (arrows, Delete, Esc).
  const selectedKey = selection
    ? `${selection.revision}:${selection.image.objectPath.join('.')}`
    : '';
  useEffect(() => {
    if (selectedKey) selectionRef.current?.focus({ preventScroll: true });
  }, [selectedKey]);

  if (!active || sourceId === undefined) return null;
  const frame = pageFrame(props);
  const target: PageTarget = {
    source: sourceId,
    pageIndex: sourceIndex,
    pageId,
    position: pageIndex + 1,
  };

  const localPoint = (event: { clientX: number; clientY: number }) => {
    const r = rootRef.current?.getBoundingClientRect();
    return r ? { x: event.clientX - r.left, y: event.clientY - r.top } : { x: 0, y: 0 };
  };

  /** Follows the pointer on the window until release (works across the page edge). */
  const track = (
    onMove: (dx: number, dy: number, e: PointerEvent) => void,
    onEnd: (dx: number, dy: number, e: PointerEvent) => void,
    start: { x: number; y: number },
  ) => {
    const delta = (e: PointerEvent) => {
      const p = localPoint(e);
      return [p.x - start.x, p.y - start.y] as const;
    };
    const move = (e: PointerEvent) => onMove(...delta(e), e);
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
    };
    const up = (e: PointerEvent) => {
      stop();
      onEnd(...delta(e), e);
    };
    const cancel = () => {
      stop();
      setGesture(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  };

  const commitBox = (
    sel: ImageSelection,
    from: Box,
    box: Box,
    announcement?: (rect: ReturnType<typeof roundRect>) => string,
  ) => {
    setGesture(null);
    if (!boxChanged(from, box)) return;
    const rect = roundRect(cssBoxToUser(frame, box));
    void transformImage(sel.target, sel.image, rect, announcement?.(rect));
  };

  const select = (image: LocatedImage): ImageSelection => {
    const next: ImageSelection = { target, image, revision };
    const store = useImageStore.getState();
    if (store.selection?.image !== image) store.select(next);
    return next;
  };

  const onImagePointerDown = (event: ReactPointerEvent, image: LocatedImage) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    if (busy) return;
    const sel = select(image);
    const from = rectToCss(frame, image.bounds);
    let moving = false;
    track(
      (dx, dy) => {
        if (!moving && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        moving = true;
        setGesture({ kind: 'move', box: moveBox(from, dx, dy) });
      },
      (dx, dy) => {
        if (!moving) return;
        commitBox(sel, from, moveBox(from, dx, dy));
      },
      localPoint(event),
    );
  };

  const onHandlePointerDown = (event: ReactPointerEvent, handle: Handle) => {
    if (event.button !== 0 || !selection) return;
    event.preventDefault();
    event.stopPropagation();
    if (busy) return;
    const sel = selection;
    const from = rectToCss(frame, sel.image.bounds);
    const next = (dx: number, dy: number, e: PointerEvent) =>
      resizeBox(from, handle, dx, dy, { keepAspect: e.shiftKey, fromCenter: e.altKey });
    track(
      (dx, dy, e) => setGesture({ kind: 'resize', box: next(dx, dy, e) }),
      (dx, dy, e) => commitBox(sel, from, next(dx, dy, e)),
      localPoint(event),
    );
  };

  const onSelectionKeyDown = (event: ReactKeyboardEvent) => {
    if (!selection) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      useImageStore.getState().select(null);
      rootRef.current?.focus({ preventScroll: true });
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      event.stopPropagation();
      if (!busy) void deleteImage(selection.target, selection.image);
      return;
    }
    const mod = currentPlatform === 'mac' ? event.metaKey : event.ctrlKey;
    if (mod && !event.altKey) {
      const from = rectToCss(frame, selection.image.bounds);
      const next = keyResizeBox(from, event.key, event.shiftKey, frame.scale);
      if (!next) return;
      event.preventDefault();
      event.stopPropagation();
      if (busy) return;
      commitBox(selection, from, next, (rect) =>
        m.image_object_resized_to({ width: formatPt(rect.width), height: formatPt(rect.height) }),
      );
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const offset = nudgeOffset(event.key, event.shiftKey, frame.scale);
    if (!offset) return;
    event.preventDefault();
    event.stopPropagation();
    if (busy) return;
    const from = rectToCss(frame, selection.image.bounds);
    commitBox(selection, from, moveBox(from, offset.dx, offset.dy));
  };

  const shown = selection
    ? (gesture?.box ??
      (expected ? rectToCss(frame, expected.bounds) : rectToCss(frame, selection.image.bounds)))
    : null;

  return (
    <div
      ref={rootRef}
      className={styles.layer}
      data-image-layer={pageIndex}
      role="group"
      aria-label={m.image_object_layer_label({ page: pageIndex + 1 })}
      tabIndex={-1}
      onPointerDown={(event) => {
        // A press on the page outside any image deselects.
        if (event.target === event.currentTarget) useImageStore.getState().select(null);
      }}
    >
      {(images ?? []).map((image) => (
        <ImageTarget
          key={image.objectPath.join('.')}
          image={image}
          frame={frame}
          selected={selection?.image === image}
          onPointerDown={onImagePointerDown}
          onActivate={(i) => {
            select(i);
          }}
        />
      ))}
      {selection && shown ? (
        <>
          <button
            ref={selectionRef}
            type="button"
            className={styles.selection}
            data-testid="image-selection"
            data-busy={busy || undefined}
            aria-roledescription={m.image_object_name()}
            aria-label={m.image_object_selected({
              width: formatPt(selection.image.bounds.width),
              height: formatPt(selection.image.bounds.height),
            })}
            aria-keyshortcuts={SELECTION_KEYS}
            aria-describedby={keysId}
            style={{ left: shown.left, top: shown.top, width: shown.width, height: shown.height }}
            onKeyDown={onSelectionKeyDown}
            onPointerDown={(e) => onImagePointerDown(e, selection.image)}
          >
            {HANDLES.map((handle) => {
              const p = handlePoint(
                { left: 0, top: 0, width: shown.width, height: shown.height },
                handle,
              );
              return (
                <span
                  key={handle}
                  className={styles.handle}
                  data-handle={handle}
                  aria-hidden="true"
                  style={{
                    left: p.x - HANDLE_SIZE / 2,
                    top: p.y - HANDLE_SIZE / 2,
                    width: HANDLE_SIZE,
                    height: HANDLE_SIZE,
                  }}
                  onPointerDown={(e) => onHandlePointerDown(e, handle)}
                />
              );
            })}
          </button>
          <span id={keysId} className="visually-hidden">
            {m.image_object_resize_keys({ mod: currentPlatform === 'mac' ? 'Command' : 'Ctrl' })}
          </span>
          {gesture === null ? (
            <ImageBar selection={selection} frame={frame} box={shown} />
          ) : (
            <ImageBar selection={selection} frame={frame} box={shown} preview={gesture.box} />
          )}
        </>
      ) : null}
    </div>
  );
}

function roundRect(r: { x: number; y: number; width: number; height: number }) {
  const q = (v: number) => Math.round(v * 1000) / 1000;
  return { x: q(r.x), y: q(r.y), width: q(r.width), height: q(r.height) };
}

function ImageTarget({
  image,
  frame,
  selected,
  onPointerDown,
  onActivate,
}: {
  readonly image: LocatedImage;
  readonly frame: PageFrame;
  readonly selected: boolean;
  readonly onPointerDown: (event: ReactPointerEvent, image: LocatedImage) => void;
  readonly onActivate: (image: LocatedImage) => void;
}) {
  const box = rectToCss(frame, image.bounds);
  const { x, y, width, height } = image.bounds;
  return (
    <button
      type="button"
      className={styles.target}
      data-image-object=""
      data-image-rect={[x, y, width, height].map((v) => Math.round(v * 100) / 100).join(' ')}
      data-selected={selected || undefined}
      aria-label={m.image_object_target({ width: image.pixelWidth, height: image.pixelHeight })}
      aria-pressed={selected}
      style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
      onPointerDown={(event) => onPointerDown(event, image)}
      onClick={(event) => {
        // Keyboard activation (Enter / Space); pointer presses select on pointerdown.
        if (event.detail === 0) onActivate(image);
      }}
    />
  );
}
