/**
 * Edit text layer (redaction-and-text-editing spec §2.2), a page overlay in Edit mode.
 *
 * Its root never takes the page (craft spec §3.5, `viewer/hit-order.ts`): it lets the
 * pointer through, and only its targets are live. With the Edit text tool (E) every located
 * run (a text object's glyphs on one line) becomes a pointer target over its line box; runs
 * that cannot be edited (Type3, invisible, vertical, nested forms) are hatched on hover and
 * say why in a tooltip. The idle hover outline is the text layer's (`viewer/TextLayer.tsx`).
 * A click, or a pen used as a pointer, opens the editor over the run with the caret where it
 * was clicked (craft spec §4.2), a double-click with the clicked word selected. A finger
 * opens it with a tap until a pen has been seen, then only with a long press (fingers pan).
 * Runs and paragraphs are located again for every page revision, since references go stale
 * after any edit (spec §2.5).
 *
 * The keyboard works by paragraph (craft spec §9): each detected paragraph that does not
 * refuse paragraph mode (`analyzeParagraphs`) is one focusable target over its box, so Tab
 * moves between paragraphs and Enter (or Space) opens the paragraph editor at its start.
 * The runs inside such a paragraph are pointer targets only, out of the tab order and hidden
 * from assistive technology (a page printed by Chromium has one run per glyph). Runs in no
 * such paragraph keep their own focusable target, which opens the line editor with the
 * whole run selected. A paragraph target is at least 24 × 24 px (DESIGN §5).
 *
 * The editor itself shows wherever a session is open on the page, also when the Select
 * tool opened it by double-click (`openTextEditorAt`, `entry.ts`). A press on the page
 * outside the editor closes it without applying.
 *
 * When Enter or Esc closes the editor, the focus goes back to the target holding the run it
 * opened from (its paragraph, else the run itself); after a commit the runs are new, so it
 * goes to the target holding the run on the same line nearest to where the edited one
 * started (`focusReturnRun`), and to the layer while they are located or when none is left.
 */
import type { SourceId } from '@pdf-editor/document-model';
import type { LocatedRun, ParagraphBlock } from '@pdf-editor/engine';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
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
import { pageParagraphs, useTextEditStore } from './text-edit-store';

/** Extra hit area around a line box, CSS pixels. */
const HIT_PADDING = 2;
/** The smallest side of a paragraph's keyboard target, CSS pixels (DESIGN §5). */
export const MIN_TARGET_PX = 24;
/** Characters of a paragraph's text its target's name quotes. */
const NAME_CHARS = 60;
/** A finger held this long on a run opens it once a pen has been seen (ms). */
export const LONG_PRESS_MS = 500;
/** A finger that travels further (CSS px) is panning, not pressing. */
const TOUCH_SLOP_PX = 8;

/** Presses that keep an open editor: the editor, its header, and run targets (they reopen). */
const KEEPS_EDITOR = '[data-text-edit-input], [data-text-edit-panel], [data-text-run]';

/** A detected paragraph's keyboard target: the paragraph and its located runs, in order. */
export interface ParagraphTarget {
  readonly block: ParagraphBlock;
  readonly runs: readonly LocatedRun[];
}

/** What the layer offers the keyboard, in reading order. */
export type KeyboardItem =
  | { readonly kind: 'paragraph'; readonly target: ParagraphTarget }
  | { readonly kind: 'run'; readonly run: LocatedRun };

export interface KeyboardPlan {
  readonly items: readonly KeyboardItem[];
  /** Runs inside a paragraph target: pointer targets only. */
  readonly covered: ReadonlySet<LocatedRun>;
}

/**
 * The layer's keyboard targets (craft spec §9): one per detected paragraph that does not
 * refuse paragraph mode and has a located, editable run, then the editable runs that are in
 * no such paragraph, each where it falls in the page's run order. Paragraphs keep the
 * analysis's reading order. Runs that cannot be edited are never keyboard targets here.
 */
export function keyboardPlan(
  runs: readonly LocatedRun[],
  blocks: readonly ParagraphBlock[],
): KeyboardPlan {
  const byKey = new Map<string, { run: LocatedRun; index: number }>();
  runs.forEach((run, index) => {
    if (!blockerOfRun(run)) byKey.set(runKey(run), { run, index });
  });
  const covered = new Set<LocatedRun>();
  const paragraphs: { target: ParagraphTarget; first: number }[] = [];
  for (const block of blocks) {
    if (block.refusal) continue;
    const found = block.ref.runs.flatMap((ref) => {
      const hit = byKey.get(runKey(ref));
      return hit ? [hit] : [];
    });
    if (found.length === 0) continue;
    for (const { run } of found) covered.add(run);
    paragraphs.push({
      target: { block, runs: found.map(({ run }) => run) },
      first: Math.min(...found.map(({ index }) => index)),
    });
  }
  const items: KeyboardItem[] = [];
  let next = 0;
  runs.forEach((run, index) => {
    if (covered.has(run) || blockerOfRun(run)) return;
    while (next < paragraphs.length && (paragraphs[next]?.first ?? 0) < index) {
      const paragraph = paragraphs[next++];
      if (paragraph) items.push({ kind: 'paragraph', target: paragraph.target });
    }
    items.push({ kind: 'run', run });
  });
  for (const paragraph of paragraphs.slice(next)) {
    items.push({ kind: 'paragraph', target: paragraph.target });
  }
  return { items, covered };
}

/** A paragraph target's accessible name: its opening words. */
export function paragraphTargetLabel(block: Pick<ParagraphBlock, 'text'>): string {
  const flat = block.text.replace(/\s+/g, ' ').trim();
  const cut = flat.length > NAME_CHARS ? flat.slice(0, NAME_CHARS).replace(/\s+\S*$/, '') : flat;
  return m.text_edit_paragraph({ text: cut.length < flat.length ? `${cut}…` : cut });
}

/**
 * The page's detected paragraphs while `source` is given, at `revision`. Null while they
 * are detected; empty when detection failed (every editable run is then its own target).
 */
function usePageParagraphs(
  source: SourceId | undefined,
  pageIndex: number,
  revision: number,
): readonly ParagraphBlock[] | null {
  const key = source === undefined ? '' : `${source}:${pageIndex}:${revision}`;
  const [state, setState] = useState<{
    key: string;
    blocks: readonly ParagraphBlock[];
  } | null>(null);
  useEffect(() => {
    if (source === undefined) return;
    let live = true;
    pageParagraphs(source, pageIndex).then(
      (blocks) => {
        if (live) setState({ key, blocks });
      },
      (error: unknown) => {
        console.warn('Detecting the paragraphs failed', error);
        if (live) setState({ key, blocks: [] });
      },
    );
    return () => {
      live = false;
    };
  }, [source, pageIndex, key]);
  return state?.key === key ? state.blocks : null;
}

export function TextEditLayer(props: PageOverlayProps) {
  const { sourceId, sourceIndex, pageId, pageIndex, visible } = props;
  // Never in Read (ADR-0019 §3), even if the tool were armed.
  const editable = useCanEdit();
  const active = useToolStore((s) => s.mode === 'edit-text') && editable;
  const session = useTextEditStore((s) => (s.session?.target.pageId === pageId ? s.session : null));
  const revision = usePageRevision(sourceId, sourceIndex);
  const located = active && visible ? sourceId : undefined;
  const runs = usePageRuns(located, sourceIndex, revision);
  const blocks = usePageParagraphs(located, sourceIndex, revision);
  const plan = runs !== null && blocks !== null ? keyboardPlan(runs, blocks) : null;
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

  // An editor closed from the keyboard: focus the target holding its run again (or the
  // target holding its line's nearest run).
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
    if (runs === null || plan === null || revision === focusReturn.staleRevision) {
      // Until the page's new runs and paragraphs are located, the layer keeps the focus.
      if (document.activeElement !== layer) layer.focus({ preventScroll: true });
      return;
    }
    const run = focusReturnRun(runs, focusReturn.run);
    let target: HTMLElement | null = null;
    if (run) {
      const index = plan.items.findIndex(
        (item) => item.kind === 'paragraph' && item.target.runs.includes(run),
      );
      target =
        index >= 0
          ? layer.querySelector<HTMLElement>(`[data-text-paragraph="${index}"]`)
          : layer.querySelector<HTMLElement>(`button[data-run-key="${CSS.escape(runKey(run))}"]`);
    }
    (target ?? layer).focus({ preventScroll: true });
    useTextEditStore.getState().clearFocusReturn();
  }, [focusReturn, session, runs, plan, revision, active]);

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

  /**
   * Opens a paragraph from its keyboard target, the caret at its start. Its first run is the
   * fallback: the line editor opens on it if the paragraph's analysis refuses paragraph mode,
   * and the focus comes back to this target when the editor closes.
   */
  const openParagraph = ({ block, runs: inside }: ParagraphTarget) => {
    const first = inside[0];
    if (!first) return;
    useTextEditStore.getState().openParagraph({
      target,
      block,
      revision,
      caret: block.lines[0]?.start ?? 0,
      fallback: { target, run: first, revision, selection: { start: 0, end: first.text.length } },
    });
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
      {active && runs !== null
        ? runs.map((run, index) =>
            // Until the paragraphs are known every run waits as a pointer target only.
            plan === null || plan.covered.has(run) || blockerOfRun(run) ? (
              <RunTarget
                key={`${run.objectPath.join('.')}:${run.charStart}:${index}`}
                run={run}
                frame={frame}
                editing={session?.run === run}
                focusable={false}
                onOpen={open}
              />
            ) : null,
          )
        : null}
      {active && plan
        ? plan.items.map((item, index) =>
            item.kind === 'paragraph' ? (
              <ParagraphTargetButton
                key={`p:${item.target.block.ref.index}`}
                index={index}
                block={item.target.block}
                frame={frame}
                onOpen={() => openParagraph(item.target)}
              />
            ) : (
              <RunTarget
                key={`r:${runKey(item.run)}:${index}`}
                run={item.run}
                frame={frame}
                editing={session?.run === item.run}
                focusable
                onOpen={open}
              />
            ),
          )
        : null}
      {session && shown ? <TextEditor session={session} frame={frame} revision={revision} /> : null}
    </div>
  );
}

/**
 * A paragraph's keyboard target over its box (at least `MIN_TARGET_PX` square): Enter or
 * Space opens the paragraph editor. It takes no pointer; the runs under it do.
 */
function ParagraphTargetButton({
  index,
  block,
  frame,
  onOpen,
}: {
  readonly index: number;
  readonly block: ParagraphBlock;
  readonly frame: PageFrame;
  readonly onOpen: () => void;
}) {
  const box = rectToCss(frame, block.box);
  const width = Math.max(box.width + 2 * HIT_PADDING, MIN_TARGET_PX);
  const height = Math.max(box.height + 2 * HIT_PADDING, MIN_TARGET_PX);
  return (
    <button
      type="button"
      className={styles.paragraph}
      data-text-paragraph={index}
      aria-label={paragraphTargetLabel(block)}
      style={{
        left: box.left + box.width / 2 - width / 2,
        top: box.top + box.height / 2 - height / 2,
        width,
        height,
      }}
      onClick={onOpen}
    />
  );
}

/**
 * A run's target over its line box. `focusable`: also a keyboard target (Enter or Space
 * opens the line with the whole run selected); otherwise a pointer target only, out of the
 * tab order and hidden from assistive technology (its paragraph's target stands for it).
 */
function RunTarget({
  run,
  frame,
  editing,
  focusable,
  onOpen,
}: {
  readonly run: LocatedRun;
  readonly frame: PageFrame;
  readonly editing: boolean;
  readonly focusable: boolean;
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

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
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

  if (!focusable) {
    return (
      <span
        className={styles.run}
        data-editable=""
        data-editing={editing || undefined}
        data-text-run={run.text}
        data-run-key={runKey(run)}
        aria-hidden="true"
        style={style}
        onPointerDown={onPointerDown}
      />
    );
  }

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
