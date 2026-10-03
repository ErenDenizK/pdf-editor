/**
 * Edits of the lasso selection (craft spec §5.5, after experience-redesign spec §6.5): style
 * through `applyStyle` (colour, opacity, width, and font size for text boxes), move, nudge
 * and delete. Each acts on the taken paths and the annotations taken whole, in one history
 * entry, splitting an Ink when only some of its paths are taken (`split.ts`) and editing the
 * rest in place (`whole.ts`; `editLassoSelection`).
 *
 * After an edit the selection follows the edited paths: a split renames them (the new Ink),
 * so the selection moves to them under the same lasso `key` when the page next loads
 * (`followPaths`), never pointing at an Ink the page cache does not hold yet. Edits of one control under one
 * key coalesce into one history entry (800 ms window), so a slider drag that first splits an
 * Ink and then restyles the new one is one entry; while an edit waits in the queue, newer
 * values of the same control replace its value. The paths an edit takes are read when it
 * runs, so an edit queued behind a split acts on the split's result.
 *
 * Resize and rotate (`transformLassoSelection`, `transform.ts`) queue like a move: each
 * drag or key press is its own edit, and a series under one key within 800 ms is one entry.
 * A rotation that includes a stamp says once, in the bar, that stamps keep their orientation
 * (`useLassoNotice`).
 */
import { create } from 'zustand';

import { m } from '../../i18n';
import { announce } from '../../shell/announcer';
import { editLassoSelection } from '../actions';
import {
  activePathSelection,
  type PageTarget,
  pageKey,
  type ToolStyle,
  useAnnotationStore,
} from '../annotation-store';
import { type KindCounts, lassoItems, onlyStrokes } from '../labels';
import { type LassoPicks, pickedWhole } from './geometry';
import type { Affine, LassoEdit } from './transform';
import type { PageFrame } from '../geometry';

type Control = 'color' | 'opacity' | 'stroke' | 'font' | 'move' | 'resize' | 'rotate' | 'delete';

/** Controls whose edits all apply in turn (a value slot would drop all but the last). */
const STEPS: ReadonlySet<Control> = new Set(['move', 'resize', 'rotate']);

/** History labels for strokes only ("Recolor 3 strokes"). */
const STROKE_LABELS: Record<Exclude<Control, 'font'>, (count: number) => string> = {
  color: (count) => m.lasso_history_color({ count }),
  opacity: (count) => m.lasso_history_opacity({ count }),
  stroke: (count) => m.lasso_history_width({ count }),
  move: (count) => m.lasso_history_move({ count }),
  resize: (count) => m.lasso_history_resize({ count }),
  rotate: (count) => m.lasso_history_rotate({ count }),
  delete: (count) => m.lasso_history_delete({ count }),
};

/** History labels naming a mix ("Recolor 3 strokes and 1 arrow"). */
const MIX_LABELS: Record<Control, (items: string) => string> = {
  color: (items) => m.lasso_history_color_items({ items }),
  opacity: (items) => m.lasso_history_opacity_items({ items }),
  stroke: (items) => m.lasso_history_width_items({ items }),
  font: (items) => m.lasso_history_font_items({ items }),
  move: (items) => m.lasso_history_move_items({ items }),
  resize: (items) => m.lasso_history_resize_items({ items }),
  rotate: (items) => m.lasso_history_rotate_items({ items }),
  delete: (items) => m.lasso_history_delete_items({ items }),
};

/** The history label of a lasso edit of what `counts` holds. */
export function lassoHistoryLabel(control: Control, counts: KindCounts): string {
  if (control !== 'font' && onlyStrokes(counts)) return STROKE_LABELS[control](counts.ink ?? 0);
  return MIX_LABELS[control](lassoItems(counts, 'sentence'));
}

/** Latest-value slots per control and lasso key (a slider drag sends one edit at a time). */
const pending = new Map<string, { change: LassoEdit }>();

/** A line the lasso bar shows for one selection (its lasso key). */
interface LassoNotice {
  readonly key: string | null;
  readonly message: string | null;
}

/** The bar's notice: "Stamps keep their orientation", once per selection. */
export const useLassoNotice = create<LassoNotice>()(() => ({ key: null, message: null }));

/** Tests: forget queued values and notices. */
export function resetLassoEdits(): void {
  pending.clear();
  useLassoNotice.setState({ key: null, message: null });
}

function run(control: Control, change: LassoEdit): Promise<void> {
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
  if (slot && !STEPS.has(control)) {
    slot.change = change;
    return Promise.resolve();
  }
  const fresh = { change };
  if (!STEPS.has(control)) pending.set(key, fresh);
  // The paths are read when the edit runs: an edit behind a split acts on its result.
  const picks = (): LassoPicks => {
    const now = activePathSelection(useAnnotationStore.getState());
    const at = now?.key === captured.key ? now : captured;
    return { paths: at.next ?? at.paths, whole: at.whole };
  };
  return editLassoSelection(
    target,
    picks,
    () => {
      // From here on a newer value queues a new edit.
      if (pending.get(key) === fresh) pending.delete(key);
      return fresh.change;
    },
    {
      label: (counts) => lassoHistoryLabel(control, counts),
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

/**
 * `applyStyle` with a lasso selection: colour, opacity and width of what it took (a width
 * applies to kinds with a stroke width), and the font size of its text boxes.
 */
export function styleLassoSelection(patch: Partial<ToolStyle>): void {
  if (patch.color !== undefined)
    void run('color', { kind: 'style', patch: { color: patch.color } });
  if (patch.opacity !== undefined) {
    void run('opacity', { kind: 'style', patch: { opacity: patch.opacity } });
  }
  if (patch.strokeWidth !== undefined) {
    void run('stroke', { kind: 'style', patch: { strokeWidth: patch.strokeWidth } });
  }
  if (patch.fontSize !== undefined) {
    void run('font', { kind: 'style', patch: { fontSize: patch.fontSize } });
  }
}

/** Moves what the lasso took by (dx, dy), user space; consecutive moves within 800 ms join. */
export function moveLassoSelection(dx: number, dy: number): Promise<void> {
  if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return Promise.resolve();
  return run('move', { kind: 'move', dx, dy });
}

/**
 * Resizes or rotates what the lasso took by `matrix` (user space, `transform.ts`); `frame`
 * places note icons. Consecutive edits of one kind within 800 ms join. A rotation that
 * includes a stamp says once per selection that stamps keep their orientation.
 */
export function transformLassoSelection(
  kind: 'resize' | 'rotate',
  matrix: Affine,
  frame?: PageFrame,
): Promise<void> {
  if (kind === 'rotate') noteStampOrientation();
  return run(kind, { kind: 'transform', matrix, ...(frame ? { frame } : {}) });
}

/** Shows (and announces) the stamp notice when the selection holds a stamp, once per key. */
function noteStampOrientation(): void {
  const state = useAnnotationStore.getState();
  const selection = activePathSelection(state);
  if (!selection || useLassoNotice.getState().key === selection.key) return;
  const at = state.selection;
  const page = at ? state.pages[pageKey(at.source, at.pageIndex)] : undefined;
  const whole = pickedWhole(page?.annotations ?? [], selection.whole);
  if (!whole.some((a) => a.kind === 'stamp')) return;
  const message = m.lasso_stamps_keep_orientation();
  useLassoNotice.setState({ key: selection.key, message });
  announce(message);
}

/**
 * Deletes what the lasso took (an Ink with no path left goes) and clears the selection.
 */
export function deleteLassoSelection(): Promise<void> {
  return run('delete', { kind: 'delete' });
}

/** Says what the lasso took ("3 strokes and 1 arrow selected"), or that it took none. */
export function announceLasso(counts: KindCounts): void {
  if (Object.values(counts).every((n) => !n)) announce(m.lasso_none());
  else if (onlyStrokes(counts)) announce(m.lasso_selected({ count: counts.ink ?? 0 }));
  else announce(m.lasso_selected_items({ items: lassoItems(counts, 'sentence') }));
}
