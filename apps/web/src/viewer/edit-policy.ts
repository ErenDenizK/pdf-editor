/**
 * The Edit-mode pointer policy's shared state (craft spec §3.5): the pointer log the page
 * layers consult (`hit-order.ts`), the first pen sighting that turns "Pen draws in Edit"
 * on, the Space pan, and the palette command "Toggle pen draws in Edit". Importing this
 * module installs the window listeners once.
 */
import { penSession } from '../annotations/pen/ink-input';
import type { CommandRegistry } from '../commands/registry';
import { m } from '../i18n';
import { announce } from '../shell/announcer';
import { penDrawsInEdit, useEditPolicyStore } from '../state/edit-policy-store';
import { createPointerLog, watchPointers } from './hit-order';
import { installSpacePan } from './space-pan';

/** The page's pointer log (last press type, last pen lift). */
export const pointerLog = createPointerLog();

/** A pen was seen (hovering or touching): fingers pan from now on, and "auto" turns on. */
export function notePenSeen(): void {
  penSession().penSeen = true;
  useEditPolicyStore.getState().notePen();
}

/** Whether a pen draws with Select armed, now. */
export function penDrawsNow(): boolean {
  return penDrawsInEdit(useEditPolicyStore.getState(), penSession().penSeen);
}

/**
 * The same as a hook, false unless `relevant` (the caller's tool is Select): a layer with
 * the pen armed does not re-render when the first pen sighting turns "auto" on mid-stroke.
 */
export function usePenDrawsInEdit(relevant = true): boolean {
  return useEditPolicyStore((s) => relevant && penDrawsInEdit(s, penSession().penSeen));
}

/** Turns "Pen draws in Edit" on or off and says so. */
export function setPenDrawsInEdit(on: boolean): void {
  useEditPolicyStore.getState().setPenDrawsInEdit(on);
  announce(on ? m.announce_pen_draws_in_edit_on() : m.announce_pen_draws_in_edit_off());
}

export function registerEditPolicyCommands(registry: CommandRegistry): () => void {
  return registry.register({
    id: 'view.penDrawsInEdit',
    title: m.cmd_view_pen_draws_in_edit(),
    group: m.group_view(),
    keywords: ['pen', 'stylus', 'draw', 'select', 'kalem', 'çiz', 'settings', 'ayarlar'],
    run: () => setPenDrawsInEdit(!penDrawsNow()),
  });
}

let installed = false;

/** Installs the window listeners (pointer log, pen sighting, Space pan) once. */
export function installEditPolicy(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  watchPointers(window, pointerLog, notePenSeen);
  installSpacePan(window);
}

installEditPolicy();
