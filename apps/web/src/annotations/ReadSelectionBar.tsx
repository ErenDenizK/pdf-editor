/**
 * The contextual bar of a text selection (ADR-0019 §3 item 4 and §4, craft spec §3.4–§3.5).
 *
 * - **Read** (the Read row): Copy, and "Mark up…", which switches the document to Edit and
 *   keeps the selection, so the Edit bar below takes over (and H, U or S marks it with the
 *   next press). Nothing is marked from Read.
 * - **Edit, with Select armed** (the Select row): Highlight, Underline, Strikeout, Squiggly,
 *   each through `markupFromSelection` with the tool's remembered style, and Comment, which
 *   opens a new note's editor at the end of the selection's first line.
 *
 * One per page, registered as a page overlay: the bar shows on the page where the selection
 * starts, above its first line (below it near the top of the page), once the pointer is up.
 * A click elsewhere ends the selection and the bar; Esc clears the selection.
 */
import { ClipboardCopy, MessageSquarePlus, Pencil } from 'lucide-react';
import { type PointerEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { commandRegistry } from '../commands/registry';
import { showDocumentMode } from '../home/home-actions';
import { m } from '../i18n';
import { announce } from '../shell/announcer';
import { useRovingTabindex } from '../shell/FloatingToolbar.roving';
import { registerPageOverlay, type PageOverlayProps } from '../stage/page-overlays';
import { useCanEdit } from '../state/ui-store';
import { IconButton } from '../ui/IconButton';
import { Tooltip } from '../ui/Tooltip';
import { selectionCopyText } from '../viewer/text-model';
import { useToolStore } from '../viewer/tool-store';
import { useAnnotationStore } from './annotation-store';
import { cssPointToUser } from './geometry';
import { mountedLayers } from './layer-registry';
import styles from './ReadSelectionBar.module.css';
import { markupFromSelection } from './selection-markup';
import { MARKUP_MODES, type MarkupMode, toolDefinition } from './tools';

const BAR_HEIGHT = 36;
const GAP = 8;

interface Placement {
  readonly x: number;
  readonly y: number;
}

/** The client rects of the selection's first range, empty when nothing is selected. */
function selectedRects(): DOMRect[] {
  const selection = globalThis.getSelection?.() ?? null;
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return [];
  return [...selection.getRangeAt(0).getClientRects()].filter((r) => r.width > 0 && r.height > 0);
}

/**
 * Comment (craft spec §3.5): a new note's editor at the end of the selection's first line on
 * this page, as the Note tool opens one where it is clicked. The selection goes; typing and
 * leaving the editor creates the note, Esc creates nothing.
 */
function commentOnSelection(props: PageOverlayProps): boolean {
  const layer = mountedLayers.get(props.pageId);
  const first = selectedRects()[0];
  if (!layer || !first) return false;
  const bounds = layer.element.getBoundingClientRect();
  const p = cssPointToUser(layer.frame, {
    x: first.right - bounds.left,
    y: first.top - bounds.top,
  });
  globalThis.getSelection?.()?.removeAllRanges();
  const store = useAnnotationStore.getState();
  store.select(null);
  store.setEditor({
    kind: 'note',
    target: layer.target,
    rect: { x: Math.round(p.x), y: Math.round(p.y - 20), width: 20, height: 20 },
    text: '',
  });
  return true;
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

export function TextSelectionBar(props: PageOverlayProps) {
  const editable = useCanEdit();
  // In Edit only the Select tool selects text for the bar (a markup tool marks the drag).
  const selecting = useToolStore((s) => s.mode === 'select');
  const shown = !editable || selecting;
  const rootRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const roving = useRovingTabindex(barRef);
  /** Set by "Mark up…" pressed from the keyboard: the Edit bar that replaces it takes the focus. */
  const focusEditBar = useRef(false);

  useEffect(() => {
    if (!shown) return;
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
    // Esc clears the selection (DESIGN §4: Esc clears tool and selection), so the bar goes;
    // from the bar, the focus stays on the page.
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !barRef.current) return;
      const target = event.target;
      const onPage =
        target === document.body ||
        (target instanceof Element && target.closest('[data-read-viewport]') !== null);
      if (!onPage) return;
      const fromBar = barRef.current.contains(document.activeElement);
      globalThis.getSelection?.()?.removeAllRanges();
      setPlacement(null);
      if (fromBar) rootRef.current?.closest<HTMLElement>('[data-read-viewport]')?.focus();
    };
    document.addEventListener('selectionchange', update);
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('pointerup', up, true);
    document.addEventListener('pointercancel', up, true);
    document.addEventListener('keydown', escape);
    update();
    return () => {
      document.removeEventListener('selectionchange', update);
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('pointerup', up, true);
      document.removeEventListener('pointercancel', up, true);
      document.removeEventListener('keydown', escape);
    };
  }, [shown]);

  // Zoom moves the text under the bar: place it again.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (shown && root && props.cssScale > 0) setPlacement(placementOn(root));
  }, [shown, props.cssScale]);

  // "Mark up…" from the keyboard: on to the first markup of the Edit bar.
  useLayoutEffect(() => {
    if (!editable || !focusEditBar.current) return;
    focusEditBar.current = false;
    barRef.current?.querySelector<HTMLElement>('button')?.focus();
  }, [editable]);

  if (!shown) return null;

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
    focusEditBar.current = barRef.current?.contains(document.activeElement) === true;
    showDocumentMode('edit');
    announce(m.selection_mark_up_hint());
  };

  const markupButton = (kind: MarkupMode) => {
    const tool = toolDefinition(kind);
    return (
      <IconButton
        key={kind}
        label={tool.title()}
        icon={<tool.Icon />}
        tooltipSide="top"
        // U and S say their key; H arms the Highlighter, whose tint may differ (craft §5.4).
        shortcut={
          kind === 'highlight' ? undefined : commandRegistry.get(`tool.${kind}`)?.shortcuts[0]
        }
        data-markup={kind}
        onPointerDown={keep}
        onClick={() => void markupFromSelection(kind)}
      />
    );
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
          data-selection-mode={editable ? 'edit' : 'read'}
          onKeyDown={roving.onKeyDown}
          onFocus={roving.onFocus}
        >
          {editable ? (
            <>
              {MARKUP_MODES.map(markupButton)}
              <span className={styles.divider} aria-hidden="true" />
              <Tooltip label={m.selection_comment_tooltip()} side="top">
                <button
                  type="button"
                  className={styles.action}
                  data-comment=""
                  onPointerDown={keep}
                  onClick={() => void commentOnSelection(props)}
                >
                  <MessageSquarePlus aria-hidden="true" />
                  {m.selection_comment()}
                </button>
              </Tooltip>
            </>
          ) : (
            <>
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
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

TextSelectionBar.displayName = 'TextSelectionBar';

registerPageOverlay(TextSelectionBar);
