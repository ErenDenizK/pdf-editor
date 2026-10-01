/**
 * Edits of the lasso selection (experience-redesign spec §6.5): style through `applyStyle`
 * (colour, opacity, width), move, nudge and delete. Each acts on the taken paths only,
 * splitting an Ink when only some of its paths are taken (`split.ts`, `editInkPaths`).
 *
 * After an edit the selection follows the edited paths: a split renames them (the new Ink),
 * so the selection moves to them under the same lasso `key` when the page next loads
 * (`followPaths`), never pointing at an Ink the page cache does not hold yet. Edits of one control under one
 * key coalesce into one history entry (800 ms window), so a slider drag that first splits an
 * Ink and then restyles the new one is one entry; while an edit waits in the queue, newer
 * values of the same control replace its value. The paths an edit takes are read when it
 * runs, so an edit queued behind a split acts on the split's result.
 */
import { m } from '../../i18n';
import { announce } from '../../shell/announcer';
import { editInkPaths } from '../actions';
import {
  activePathSelection,
  type PageTarget,
  type ToolStyle,
  useAnnotationStore,
} from '../annotation-store';
import type { PathEdit } from './split';

type Control = 'color' | 'opacity' | 'stroke' | 'move' | 'delete';

const LABELS: Record<Control, (count: number) => string> = {
  color: (count) => m.lasso_history_color({ count }),
  opacity: (count) => m.lasso_history_opacity({ count }),
  stroke: (count) => m.lasso_history_width({ count }),
  move: (count) => m.lasso_history_move({ count }),
  delete: (count) => m.lasso_history_delete({ count }),
};

/** Latest-value slots per control and lasso key (a slider drag sends one edit at a time). */
const pending = new Map<string, { change: PathEdit }>();

/** Tests: forget queued values. */
export function resetLassoEdits(): void {
  pending.clear();
}

function run(control: Control, change: PathEdit): Promise<void> {
  const state = useAnnotationStore.getState();
  const selection = state.selection;
  const captured = activePathSelection(state);
  if (!selection || !captured) return Promise.resolve();
  const target: PageTarget = {
    source: selection.source,
    pageIndex: selection.pageIndex,
    pageId: selection.pageId,
    position: selection.position,
  };
  const key = `lasso:${control}:${captured.key}`;
  const slot = pending.get(key);
  if (slot && control !== 'move') {
    slot.change = change;
    return Promise.resolve();
  }
  const fresh = { change };
  if (control !== 'move') pending.set(key, fresh);
  // The paths are read when the edit runs: an edit behind a split acts on its result.
  const picks = () => {
    const now = activePathSelection(useAnnotationStore.getState());
    return now?.key === captured.key ? (now.next ?? now.paths) : (captured.next ?? captured.paths);
  };
  return editInkPaths(
    target,
    picks,
    () => {
      // From here on a newer value queues a new edit.
      if (pending.get(key) === fresh) pending.delete(key);
      return fresh.change;
    },
    {
      label: LABELS[control],
      coalesceKey: key,
      onEdited: (after) => {
        const store = useAnnotationStore.getState();
        const now = activePathSelection(store);
        if (now?.key !== captured.key) return;
        if (change.kind === 'delete') store.select(null);
        else store.followPaths(captured.key, after);
      },
    },
  )
    .then((done) => {
      // Not committed (reverted): the paths stay where they were.
      if (done === undefined) useAnnotationStore.getState().followPaths(captured.key, undefined);
    })
    .finally(() => {
      if (pending.get(key) === fresh) pending.delete(key);
    });
}

/** `applyStyle` with a lasso selection: colour, opacity and width of the taken paths. */
export function styleLassoSelection(patch: Partial<ToolStyle>): void {
  if (patch.color !== undefined)
    void run('color', { kind: 'style', patch: { color: patch.color } });
  if (patch.opacity !== undefined) {
    void run('opacity', { kind: 'style', patch: { opacity: patch.opacity } });
  }
  if (patch.strokeWidth !== undefined) {
    void run('stroke', { kind: 'style', patch: { strokeWidth: patch.strokeWidth } });
  }
}

/** Moves the taken paths by (dx, dy), user space; consecutive moves within 800 ms join. */
export function moveLassoSelection(dx: number, dy: number): Promise<void> {
  if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return Promise.resolve();
  return run('move', { kind: 'move', dx, dy });
}

/** Deletes the taken paths (an Ink with none left goes) and clears the selection. */
export function deleteLassoSelection(): Promise<void> {
  return run('delete', { kind: 'delete' });
}

/** Says how many strokes the lasso took ("3 strokes selected"), or that it took none. */
export function announceLasso(count: number): void {
  announce(count === 0 ? m.lasso_none() : m.lasso_selected({ count }));
}
