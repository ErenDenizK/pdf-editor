/**
 * Strokes and the floating bar (review finding 5, craft spec §3.5): while a stroke is in
 * progress on a page, and for `STROKE_LINGER_MS` after the last pointer lifts, the bar and
 * its options tier fade to 20 % and take no pointer (FloatingToolbar.module.css,
 * `[data-stroking]`), so writing near the bottom of the view never lands on a preset, and a
 * stroke that passes over the bar keeps drawing on the page beneath it.
 *
 * A stroke is a primary press on a page of the page view (`[data-read-viewport]
 * [data-page-id]`) in Edit with a drawing tool armed (the pens and the Highlighter, the
 * eraser, the lasso, the shapes), the pen's eraser end or barrel button with any tool, or the
 * pen's tip with Select armed while "Pen draws in Edit" is on. Presses on chrome over the page
 * (contextual bars, editors, fields) are not strokes.
 *
 * The press is seen on the window in the capture phase, before the page's own handlers (which
 * may stop it), so the bar fades in the same task as the stroke begins. The listeners are
 * installed while something subscribes (the bar) and removed with the last subscriber.
 */
import { useSyncExternalStore } from 'react';

import { canEditActive } from '../state/ui-store';
import { penDrawsNow } from '../viewer/edit-policy';
import { type ToolMode, useToolStore } from '../viewer/tool-store';

/** How long the bar stays faded after the last stroke ends (ms). */
export const STROKE_LINGER_MS = 1000;

/** Tools whose press on a page is a stroke. */
export const STROKE_TOOLS: ReadonlySet<ToolMode> = new Set<ToolMode>([
  'ink',
  'eraser',
  'lasso',
  'rectangle',
  'ellipse',
  'line',
  'arrow',
]);

/** Where a stroke starts: a page of the page view. */
const PAGE = '[data-read-viewport] [data-page-id]';
/** Chrome over a page: a press there is not a stroke. */
const PAGE_CHROME =
  '[data-annotation-keep], input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="dialog"]';

/** The pen's eraser end (`buttons & 32`) and barrel button (`buttons & 2`). */
const PEN_BUTTONS = 32 | 2;

/** Whether a press starts a stroke (module header). */
export function isStrokePress(event: PointerEvent): boolean {
  const target = event.target;
  if (!(target instanceof Element) || target.closest(PAGE) === null) return false;
  if (target.closest(PAGE_CHROME) !== null) return false;
  if (!canEditActive()) return false;
  const pen = event.pointerType === 'pen';
  if (pen && (event.buttons & PEN_BUTTONS) !== 0) return true;
  if (event.button !== 0) return false;
  const mode = useToolStore.getState().mode;
  if (STROKE_TOOLS.has(mode)) return true;
  return pen && mode === 'select' && penDrawsNow();
}

const listeners = new Set<() => void>();
const pressed = new Set<number>();
let lingering = false;
let lingerTimer: ReturnType<typeof setTimeout> | undefined;
let active = false;

function update(): void {
  const next = pressed.size > 0 || lingering;
  if (next === active) return;
  active = next;
  for (const listener of listeners) listener();
}

function onDown(event: PointerEvent): void {
  if (!isStrokePress(event)) return;
  pressed.add(event.pointerId);
  clearTimeout(lingerTimer);
  lingering = false;
  update();
}

function onUp(event: PointerEvent): void {
  if (!pressed.delete(event.pointerId) || pressed.size > 0) return;
  lingering = true;
  clearTimeout(lingerTimer);
  lingerTimer = setTimeout(() => {
    lingering = false;
    update();
  }, STROKE_LINGER_MS);
  update();
}

function install(): void {
  window.addEventListener('pointerdown', onDown, { capture: true, passive: true });
  window.addEventListener('pointerup', onUp, { capture: true, passive: true });
  window.addEventListener('pointercancel', onUp, { capture: true, passive: true });
}

function uninstall(): void {
  window.removeEventListener('pointerdown', onDown, { capture: true });
  window.removeEventListener('pointerup', onUp, { capture: true });
  window.removeEventListener('pointercancel', onUp, { capture: true });
  resetStrokeState();
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0 && typeof window !== 'undefined') install();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== 'undefined') uninstall();
  };
}

/** Whether a stroke is in progress or just ended (module header). */
export function strokeInProgress(): boolean {
  return active;
}

/** The same as a hook: the bar re-renders when it changes. */
export function useStrokeInProgress(): boolean {
  return useSyncExternalStore(subscribe, strokeInProgress, () => false);
}

/** Forgets every press and the linger (tests, and when the bar unmounts). */
export function resetStrokeState(): void {
  pressed.clear();
  clearTimeout(lingerTimer);
  lingering = false;
  update();
}
