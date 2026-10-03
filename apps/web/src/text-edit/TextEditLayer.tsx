/**
 * Edit text layer (redaction-and-text-editing spec §2.2), a page overlay in Edit mode.
 *
 * Its root never takes the page (craft spec §3.5, `viewer/hit-order.ts`): it lets the
 * pointer through, and only its targets are live. With the Edit text tool (E) every located
 * run (a text object's glyphs on one line) becomes a target over its line box; runs that
 * cannot be edited (Type3, invisible, vertical, nested forms) are hatched on hover and say
 * why in a tooltip. The idle hover outline is the text layer's (`viewer/TextLayer.tsx`). A
 * click, or a pen used as a pointer, opens the inline editor over the run with the caret
 * where it was clicked (craft spec §4.2), a double-click with the clicked word selected;
 * Enter or Space on a focused run opens it with the whole line selected. A finger opens it
 * with a tap until a pen has been seen, then only with a long press (fingers pan). Runs are
 * located again for every page revision, since references go stale after any edit (spec
 * §2.5).
 *
 * The editor itself shows wherever a session is open on the page, also when the Select
 * tool opened it by double-click (`openTextEditorAt`, `entry.ts`). A press on the page
 * outside the editor closes it without applying.
 *
 * When Enter or Esc closes the editor, the focus goes back to the run's target; after a
 * commit the runs are new, so it goes to the run on the same line nearest to where the
 * edited one started (`focusReturnRun`), and to the layer while they are located or when
 * none is left.
 */
import type { LocatedRun } from '@pdf-editor/engine';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
} from 'react';

import type { PageTarget } from '../annotations/annotation-store';
import { cssPointToUser, type PageFrame, rectToCss } from '../annotations/geometry';
import { penSession } from '../annotations/pen/ink-input';
import { m } from '../i18n';
import type { PageOverlayProps } from '../stage/page-overlays';
import { useCanEdit } from '../state/ui-store';
import { Tooltip } from '../ui/Tooltip';
import { HIT_LAYER_Z } from '../viewer/hit-order';
import { pageFrame } from '../viewer/page-frame';
import { useToolStore } from '../viewer/tool-store';
import { blockerLabel, blockerOfRun, caretOffset, focusReturnRun, runKey, wordAt } from './model';
import { openRunEditor } from './ParagraphEditor';
import { usePageRevision, usePageRuns } from './runs';
import styles from './TextEdit.module.css';
import { TextEditor } from './TextEditor';
import { useTextEditStore } from './text-edit-store';

/** Extra hit area around a line box, CSS pixels. */
const HIT_PADDING = 2;
/** A finger held this long on a run opens it once a pen has been seen (ms). */
export const LONG_PRESS_MS = 500;
/** A finger that travels further (CSS px) is panning, not pressing. */
const TOUCH_SLOP_PX = 8;

/** Presses that keep an open editor: the editor, its header, and run targets (they reopen). */
const KEEPS_EDITOR = '[data-text-edit-input], [data-text-edit-panel], [data-text-run]';

export function TextEditLayer(props: PageOverlayProps) {
  const { sourceId, sourceIndex, pageId, pageIndex, visible } = props;
  // Never in Read (ADR-0019 §3), even if the tool were armed.
  const editable = useCanEdit();
  const active = useToolStore((s) => s.mode === 'edit-text') && editable;
  const session = useTextEditStore((s) => (s.session?.target.pageId === pageId ? s.session : null));
  const revision = usePageRevision(sourceId, sourceIndex);
  const runs = usePageRuns(active && visible ? sourceId : undefined, sourceIndex, revision);
  const focusReturn = useTextEditStore((s) =>
    s.focusReturn?.pageId === pageId ? s.focusReturn : null,
  );
  const layerRef = useRef<HTMLDivElement>(null);
  const shown = session !== null && editable;

  // The Read lock: an editor open when the document leaves Edit closes, unapplied.
  useEffect(() => {
    if (session && !editable) useTextEditStore.getState().close();
  }, [session, editable]);

  // A press on the page outside the editor closes it (nothing is applied). The root lets
  // presses through, so this listens on the window, before any layer handles the press.
  useEffect(() => {
    if (!shown) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || !target.closest('[data-read-viewport]')) return;
      if (target.closest(KEEPS_EDITOR)) return;
      useTextEditStore.getState().close();
    };
    window.addEventListener('pointerdown', onPointerDown, { capture: true });
    return () => window.removeEventListener('pointerdown', onPointerDown, { capture: true });
  }, [shown]);

  // The editor closed from the keyboard: focus the run again (or its line's nearest run).
  useLayoutEffect(() => {
    const layer = layerRef.current;
    if (!focusReturn || session) return;
    if (!active) {
      // Opened by double-click with Select: there are no run targets; the pages take it.
      layer?.closest<HTMLElement>('[data-read-viewport]')?.focus({ preventScroll: true });
      useTextEditStore.getState().clearFocusReturn();
      return;
    }
    if (!layer) return;
    const located = runs !== null && revision !== focusReturn.staleRevision;
    if (!located) {
      // Until the page's new runs are located, the layer keeps the focus.
      if (document.activeElement !== layer) layer.focus({ preventScroll: true });
      return;
    }
    const run = focusReturnRun(runs, focusReturn.run);
    const target = run
      ? layer.querySelector<HTMLElement>(`[data-run-key="${CSS.escape(runKey(run))}"]`)
      : null;
    (target ?? layer).focus({ preventScroll: true });
    useTextEditStore.getState().clearFocusReturn();
  }, [focusReturn, session, runs, revision, active]);

  if ((!active && !shown) || sourceId === undefined) return null;
  const frame = pageFrame(props);
  const target: PageTarget = {
    source: sourceId,
    pageIndex: sourceIndex,
    pageId,
    position: pageIndex + 1,
  };

  const open = (run: LocatedRun, selection: { start: number; end: number }) => {
    // A run of a detected paragraph opens the paragraph editor, others the line editor (T6).
    void openRunEditor({ target, run, revision, selection });
  };

  return (
    <div
      ref={layerRef}
      className={styles.layer}
      data-text-edit-layer={pageIndex}
      role="group"
      aria-label={m.text_edit_layer_label({ page: pageIndex + 1 })}
      tabIndex={-1}
      style={{ zIndex: HIT_LAYER_Z.textRun }}
    >
      {(active ? (runs ?? []) : []).map((run, index) => (
        <RunTarget
          key={`${run.objectPath.join('.')}:${run.charStart}:${index}`}
          run={run}
          frame={frame}
          editing={session?.run === run}
          onOpen={open}
        />
      ))}
      {session && shown ? <TextEditor session={session} frame={frame} revision={revision} /> : null}
    </div>
  );
}

function RunTarget({
  run,
  frame,
  editing,
  onOpen,
}: {
  readonly run: LocatedRun;
  readonly frame: PageFrame;
  readonly editing: boolean;
  readonly onOpen: (run: LocatedRun, selection: { start: number; end: number }) => void;
}) {
  const box = rectToCss(frame, run.lineBox);
  const blocker = blockerOfRun(run);
  const style = {
    left: box.left - HIT_PADDING,
    top: box.top - HIT_PADDING,
    width: box.width + 2 * HIT_PADDING,
    height: box.height + 2 * HIT_PADDING,
  };

  if (blocker) {
    const reason = blockerLabel(blocker);
    return (
      <Tooltip label={reason} side="top">
        <span
          className={styles.run}
          data-blocked=""
          data-text-run={run.text}
          role="img"
          aria-label={m.text_edit_run_blocked({ text: run.text, reason })}
          style={style}
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        />
      </Tooltip>
    );
  }

  /** The caret offset under a viewport point. */
  const caretAt = (element: Element, point: { clientX: number; clientY: number }) => {
    const layer = element.parentElement?.getBoundingClientRect();
    const local = layer
      ? { x: point.clientX - layer.left, y: point.clientY - layer.top }
      : { x: 0, y: 0 };
    return caretOffset(run, cssPointToUser(frame, local));
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    if (event.pointerType === 'touch') {
      // Fingers scroll over text; a tap (before any pen) or a long press (after) opens.
      const element = event.currentTarget;
      watchTouch(event.nativeEvent, penSession().penSeen, (at) => {
        const caret = caretAt(element, at);
        onOpen(run, { start: caret, end: caret });
      });
      return;
    }
    // Keep the press from starting a selection or reaching the page; open with the caret
    // at the click (a second press of a double-click: the clicked word selected).
    event.preventDefault();
    event.stopPropagation();
    const caret = caretAt(event.currentTarget, event);
    onOpen(run, event.detail >= 2 ? wordAt(run.text, caret) : { start: caret, end: caret });
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onOpen(run, { start: 0, end: run.text.length });
  };

  return (
    <button
      type="button"
      className={styles.run}
      data-editable=""
      data-editing={editing || undefined}
      data-text-run={run.text}
      data-run-key={runKey(run)}
      aria-label={m.text_edit_run({ text: run.text })}
      style={style}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    />
  );
}

/**
 * Follows a finger's press on a run: `open` at the press point after `LONG_PRESS_MS` when
 * `longPress`, else at the lift of a tap. Travel beyond `TOUCH_SLOP_PX`, a cancel (the
 * browser took the pan) or a second finger drops it.
 */
function watchTouch(
  down: PointerEvent,
  longPress: boolean,
  open: (at: { clientX: number; clientY: number }) => void,
): void {
  const start = { clientX: down.clientX, clientY: down.clientY };
  let timer: number | undefined;
  const stop = () => {
    window.clearTimeout(timer);
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', stop);
    window.removeEventListener('pointerdown', other);
  };
  const move = (e: PointerEvent) => {
    if (e.pointerId !== down.pointerId) return;
    if (Math.hypot(e.clientX - start.clientX, e.clientY - start.clientY) > TOUCH_SLOP_PX) stop();
  };
  const up = (e: PointerEvent) => {
    if (e.pointerId !== down.pointerId) return;
    stop();
    if (!longPress) open(start);
  };
  const other = (e: PointerEvent) => {
    if (e.pointerId !== down.pointerId) stop();
  };
  if (longPress) {
    timer = window.setTimeout(() => {
      stop();
      open(start);
    }, LONG_PRESS_MS);
  }
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', stop);
  window.addEventListener('pointerdown', other);
}
