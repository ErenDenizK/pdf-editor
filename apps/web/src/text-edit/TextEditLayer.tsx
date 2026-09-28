/**
 * Edit text layer (redaction-and-text-editing spec §2.2), a page overlay in Read mode.
 *
 * With the Edit text tool (E) it takes the page: every located run (a text object's glyphs
 * on one line) becomes a target over its line box. Hovering the page outlines the editable
 * runs and fills the one under the pointer; runs that cannot be edited (Type3, invisible,
 * vertical, nested forms) are hatched and say why in a tooltip. A click opens the inline
 * editor over the run with the clicked character selected; Enter or Space on a focused run
 * opens it with the whole line selected. Runs are located again for every page revision,
 * since references go stale after any edit (spec §2.5).
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
  useLayoutEffect,
  useRef,
} from 'react';

import type { PageTarget } from '../annotations/annotation-store';
import { cssPointToUser, type PageFrame, rectToCss } from '../annotations/geometry';
import { m } from '../i18n';
import type { PageOverlayProps } from '../stage/page-overlays';
import { Tooltip } from '../ui/Tooltip';
import { pageFrame } from '../viewer/page-frame';
import { useToolStore } from '../viewer/tool-store';
import {
  blockerLabel,
  blockerOfRun,
  focusReturnRun,
  glyphIndexAt,
  glyphSelection,
  runKey,
} from './model';
import { usePageRevision, usePageRuns } from './runs';
import styles from './TextEdit.module.css';
import { TextEditor } from './TextEditor';
import { useTextEditStore } from './text-edit-store';

/** Extra hit area around a line box, CSS pixels. */
const HIT_PADDING = 2;

export function TextEditLayer(props: PageOverlayProps) {
  const { sourceId, sourceIndex, pageId, pageIndex, visible } = props;
  const active = useToolStore((s) => s.mode === 'edit-text');
  const session = useTextEditStore((s) => (s.session?.target.pageId === pageId ? s.session : null));
  const revision = usePageRevision(sourceId, sourceIndex);
  const runs = usePageRuns(active && visible ? sourceId : undefined, sourceIndex, revision);
  const focusReturn = useTextEditStore((s) =>
    s.focusReturn?.pageId === pageId ? s.focusReturn : null,
  );
  const layerRef = useRef<HTMLDivElement>(null);

  // The editor closed from the keyboard: focus the run again (or its line's nearest run).
  useLayoutEffect(() => {
    const layer = layerRef.current;
    if (!focusReturn || session || !layer) return;
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
  }, [focusReturn, session, runs, revision]);

  if (!active || sourceId === undefined) return null;
  const frame = pageFrame(props);
  const target: PageTarget = {
    source: sourceId,
    pageIndex: sourceIndex,
    pageId,
    position: pageIndex + 1,
  };

  const open = (run: LocatedRun, selection: { start: number; end: number }) => {
    useTextEditStore.getState().open({ target, run, revision, selection });
  };

  return (
    <div
      ref={layerRef}
      className={styles.layer}
      data-text-edit-layer={pageIndex}
      role="group"
      aria-label={m.text_edit_layer_label({ page: pageIndex + 1 })}
      tabIndex={-1}
      onPointerDown={(event) => {
        // A press on the page outside any run closes the editor (nothing is applied).
        if (event.target === event.currentTarget) useTextEditStore.getState().close();
      }}
    >
      {(runs ?? []).map((run, index) => (
        <RunTarget
          key={`${run.objectPath.join('.')}:${run.charStart}:${index}`}
          run={run}
          frame={frame}
          editing={session?.run === run}
          onOpen={open}
        />
      ))}
      {session ? <TextEditor session={session} frame={frame} revision={revision} /> : null}
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

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    // Keep the press from starting a selection or reaching the page; open on the glyph.
    event.preventDefault();
    event.stopPropagation();
    const layer = event.currentTarget.parentElement?.getBoundingClientRect();
    const local = layer
      ? { x: event.clientX - layer.left, y: event.clientY - layer.top }
      : { x: 0, y: 0 };
    const glyph = glyphIndexAt(run, cssPointToUser(frame, local));
    onOpen(run, glyphSelection(run, glyph));
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
