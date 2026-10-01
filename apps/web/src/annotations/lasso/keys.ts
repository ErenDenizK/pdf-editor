/**
 * Keys of the lasso selection (experience-redesign spec §6.5), while the Lasso is armed:
 * Esc clears the selection and keeps the Lasso armed (with nothing selected it falls through
 * to the global Escape, which disarms); Delete or Backspace removes the taken paths; arrows
 * nudge them by 1 pt on screen, Shift by 10 pt. One listener on the document, in the bubble
 * phase, so focused widgets handle their own keys first; it claims a key with
 * `preventDefault()`, which the global shortcuts then skip (`dispatchShortcut`).
 */
import type { PageId } from '@pdf-editor/document-model';

import { isEditableTarget } from '../../commands/use-shortcuts';
import { useToolStore } from '../../viewer/tool-store';
import { activePathSelection, useAnnotationStore } from '../annotation-store';
import { cssPointToUser } from '../geometry';
import { mountedLayers } from '../layer-registry';
import { deleteLassoSelection, moveLassoSelection } from './edits';

/** Nudge steps in points on screen. */
export const NUDGE_PT = 1;
export const NUDGE_LARGE_PT = 10;

const ARROWS: Readonly<Record<string, readonly [number, number]>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/** Widgets that use arrow keys themselves (sliders, swatch groups, menus, tool bars). */
const ARROW_OWNERS =
  'input, select, textarea, [role="radiogroup"], [role="menu"], [role="listbox"], [role="tablist"], [role="slider"], [role="toolbar"]';

/**
 * The user-space move of a nudge of (dx, dy) points on screen on page `pageId`; screen
 * axes when the page is not mounted (no rotation known).
 */
export function nudgeDelta(
  pageId: PageId,
  dx: number,
  dy: number,
): { readonly x: number; readonly y: number } {
  const frame = mountedLayers.get(pageId)?.frame;
  if (!frame) return { x: dx, y: -dy };
  const s = frame.scale;
  const origin = cssPointToUser(frame, { x: 0, y: 0 });
  const moved = cssPointToUser(frame, { x: dx * s, y: dy * s });
  return { x: moved.x - origin.x, y: moved.y - origin.y };
}

export function onLassoKeyDown(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.isComposing) return;
  if (useToolStore.getState().mode !== 'lasso') return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target;
  if (isEditableTarget(target)) return;
  if (target instanceof Element && target.closest('[aria-modal="true"]')) return;
  const store = useAnnotationStore.getState();
  if (event.key === 'Escape') {
    if (!store.selection && !store.editor) return;
    event.preventDefault();
    if (store.selection) store.select(null);
    if (store.editor) store.setEditor(null);
    return;
  }
  const paths = activePathSelection(store);
  if (!paths) return;
  if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault();
    void deleteLassoSelection();
    return;
  }
  const arrow = ARROWS[event.key];
  if (!arrow) return;
  const grip = target instanceof Element && target.closest('[data-lasso-move]') !== null;
  if (!grip && target instanceof Element && target.closest(ARROW_OWNERS)) return;
  event.preventDefault();
  const step = event.shiftKey ? NUDGE_LARGE_PT : NUDGE_PT;
  const delta = nudgeDelta(paths.pageId, arrow[0] * step, arrow[1] * step);
  void moveLassoSelection(delta.x, delta.y);
}

let installs = 0;

/** Installs the listener while at least one page has the Lasso attached. */
export function installLassoKeys(): () => void {
  if (installs++ === 0) document.addEventListener('keydown', onLassoKeyDown);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (--installs === 0) document.removeEventListener('keydown', onLassoKeyDown);
  };
}
