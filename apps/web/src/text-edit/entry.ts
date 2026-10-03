/**
 * The one entry to the page-text editor from a point on the page (craft spec §3.5): the
 * Select tool's double-click on page text opens through `openTextEditorAt`. It locates the
 * page's runs (cached per page revision, so a page is located at most once per revision and
 * only when someone asks), takes the run under the point and opens the editor with the
 * caret there: the paragraph editor when the run belongs to a detected paragraph that does
 * not refuse paragraph mode, else the line editor (`openRunEditor`, T6). Nothing changes
 * until a key is typed; Esc leaves without a change (the editors' own behaviour).
 */
import type { Rect } from '@pdf-editor/document-model';
import type { LocatedRun } from '@pdf-editor/engine';

import type { PageTarget } from '../annotations/annotation-store';
import { m } from '../i18n';
import { announce } from '../shell/announcer';
import { blockerLabel, blockerOfRun, caretOffset } from './model';
import { openRunEditor } from './ParagraphEditor';
import { locatedRuns, pageRevision } from './runs';

/** A point this close to a run's line box (points) still takes it. */
export const RUN_SLOP_PT = 2;

/** Distance from `p` to `r` in user space (0 inside). */
function distanceToRect(r: Rect, p: { readonly x: number; readonly y: number }): number {
  const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.width));
  const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.height));
  return Math.hypot(dx, dy);
}

/** The run under `point` (user space), or the nearest within `RUN_SLOP_PT`. */
export function runAtPoint(
  runs: readonly LocatedRun[],
  point: { readonly x: number; readonly y: number },
): LocatedRun | undefined {
  let best: LocatedRun | undefined;
  let bestDistance = RUN_SLOP_PT;
  for (const run of runs) {
    const d = distanceToRect(run.lineBox, point);
    if (d <= bestDistance) {
      best = run;
      bestDistance = d;
      if (d === 0) break;
    }
  }
  return best;
}

export type OpenOutcome = 'paragraph' | 'line' | 'blocked' | 'none' | 'stale';

/**
 * Opens the text editor on `page` at `point` (unrotated user space) with the caret at the
 * point. Resolves to what happened: `paragraph` or `line` (which editor opened), `blocked`
 * (the run cannot be edited; its reason is announced), `none` (no text there), `stale` (the
 * page changed while it was located).
 */
export async function openTextEditorAt(
  page: PageTarget,
  point: { readonly x: number; readonly y: number },
): Promise<OpenOutcome> {
  const revision = pageRevision(page.source, page.pageIndex);
  let runs: readonly LocatedRun[];
  try {
    runs = await locatedRuns(page.source, page.pageIndex);
  } catch (error) {
    console.warn('Locating the text runs failed', error);
    return 'none';
  }
  if (pageRevision(page.source, page.pageIndex) !== revision) return 'stale';
  const run = runAtPoint(runs, point);
  if (!run) return 'none';
  const blocker = blockerOfRun(run);
  if (blocker) {
    announce(m.text_edit_run_blocked({ text: run.text, reason: blockerLabel(blocker) }));
    return 'blocked';
  }
  const caret = caretOffset(run, point);
  return openRunEditor({ target: page, run, revision, selection: { start: caret, end: caret } });
}
