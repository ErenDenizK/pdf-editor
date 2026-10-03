/**
 * The contextual bar of a text selection in Read (ADR-0019 §3 item 4, craft spec §3.5, the
 * Read row): Copy, and "Mark up…", which switches the document to Edit and keeps the
 * selection, so H, U or S marks it with the next press. Nothing is marked from Read.
 *
 * One per page, registered as a page overlay: the bar shows on the page where the selection
 * starts, above its first line (below it near the top of the page), once the pointer is up.
 * In Edit it renders nothing; the Edit selection bar is the tool bar's work (craft §3.4).
 */
import { ClipboardCopy, Pencil } from 'lucide-react';
import { type PointerEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { showDocumentMode } from '../home/home-actions';
import { m } from '../i18n';
import { announce } from '../shell/announcer';
import { useRovingTabindex } from '../shell/FloatingToolbar.roving';
import { registerPageOverlay, type PageOverlayProps } from '../stage/page-overlays';
import { useCanEdit } from '../state/ui-store';
import { Tooltip } from '../ui/Tooltip';
import { selectionCopyText } from '../viewer/text-model';
import styles from './ReadSelectionBar.module.css';

const BAR_HEIGHT = 36;
const GAP = 8;

interface Placement {
  readonly x: number;
  readonly y: number;
}

/** Where the bar goes on this page, or null when the selection does not start on it. */
function placementOn(root: HTMLElement): Placement | null {
  const selection = globalThis.getSelection?.() ?? null;
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const page = root.parentElement?.parentElement;
  if (!page) return null;
  const range = selection.getRangeAt(0);
  // Only a selection of this page's text (the text layer), never of chrome or an editor.
  const start = range.startContainer;
  const startElement = start instanceof Element ? start : start.parentElement;
  if (!startElement || !page.contains(startElement)) return null;
  if (startElement.closest('input, textarea, [contenteditable="true"]')) return null;
  const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
  const first = rects[0];
  const last = rects[rects.length - 1];
  if (!first || !last) return null;
  const bounds = root.getBoundingClientRect();
  const top = first.top - bounds.top;
  const y = top - BAR_HEIGHT - GAP >= 0 ? top - BAR_HEIGHT - GAP : last.bottom - bounds.top + GAP;
  return { x: first.left - bounds.left, y };
}

export function ReadSelectionBar(props: PageOverlayProps) {
  const editable = useCanEdit();
  const rootRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const roving = useRovingTabindex(barRef);

  useEffect(() => {
    if (editable) return;
    let pressed = false;
    const update = () => {
      const root = rootRef.current;
      setPlacement(!pressed && root ? placementOn(root) : null);
    };
    const down = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Element && event.target.closest('[data-read-selection-bar]')) {
        return;
      }
      pressed = true;
      setPlacement(null);
    };
    const up = () => {
      pressed = false;
      update();
    };
    document.addEventListener('selectionchange', update);
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('pointerup', up, true);
    document.addEventListener('pointercancel', up, true);
    update();
    return () => {
      document.removeEventListener('selectionchange', update);
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('pointerup', up, true);
      document.removeEventListener('pointercancel', up, true);
    };
  }, [editable]);

  // Zoom moves the text under the bar: place it again.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!editable && root && props.cssScale > 0) setPlacement(placementOn(root));
  }, [editable, props.cssScale]);

  if (editable) return null;

  // A press on the bar keeps the selection (and the focus where it is).
  const keep = (event: PointerEvent) => event.preventDefault();

  const copy = async () => {
    const selection = globalThis.getSelection?.() ?? null;
    const text = selectionCopyText(selection) ?? selection?.toString() ?? '';
    if (text === '') return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // No clipboard permission: Ctrl+C still copies the selection.
      return;
    }
    announce(m.selection_copied());
  };

  const markUp = () => {
    showDocumentMode('edit');
    announce(m.selection_mark_up_hint());
  };

  return (
    <div ref={rootRef} className={styles.root} data-read-selection-root="">
      {placement ? (
        <div
          ref={barRef}
          role="toolbar"
          aria-label={m.selection_bar_label()}
          className={styles.bar}
          data-read-selection-bar=""
          data-annotation-keep=""
          style={{ left: Math.max(0, placement.x), top: placement.y }}
          onKeyDown={roving.onKeyDown}
          onFocus={roving.onFocus}
        >
          <button
            type="button"
            className={styles.action}
            onPointerDown={keep}
            onClick={() => void copy()}
          >
            <ClipboardCopy aria-hidden="true" />
            {m.action_copy()}
          </button>
          <Tooltip label={m.selection_mark_up_tooltip()} side="top">
            <button
              type="button"
              className={styles.action}
              aria-keyshortcuts="2"
              onPointerDown={keep}
              onClick={markUp}
            >
              <Pencil aria-hidden="true" />
              {m.selection_mark_up()}
            </button>
          </Tooltip>
        </div>
      ) : null}
    </div>
  );
}

ReadSelectionBar.displayName = 'ReadSelectionBar';

registerPageOverlay(ReadSelectionBar);
