/**
 * Field creation (spec redaction-and-text-editing §3): "Add field" in the Forms panel (and
 * the command palette) arms a kind; a click or drag on a page places it (CreatedFieldLayer,
 * registered by forms/index.ts after the form layer). "Edit fields" turns created fields
 * into selectable, movable objects with a properties popover.
 *
 * Placing and editing end when leaving Read mode, switching documents or picking another
 * tool; Esc cancels placing. A ToolMode for placing fields can be added to the tool store
 * later; until then the Forms panel drives it.
 *
 * Keyboard path: arming focuses the current page's layer once the menu or palette that
 * armed it has given the focus back to its control (remembered as the invoker); there
 * Enter or Space places the field (arrows move it first, CreatedFieldLayer), and Esc
 * cancels and returns the focus to the invoker.
 */
import { type CreatedFieldKind, getActiveDocument } from '@pdf-editor/document-model';

import type { CommandRegistry } from '../../commands/registry';
import { m } from '../../i18n';
import { announce } from '../../shell/announcer';
import { canEditActive, isPageView, stageView, useUiStore } from '../../state/ui-store';
import { useViewStore } from '../../state/view-store';
import { useWorkspaceStore } from '../../state/workspace-store';
import { useToolStore } from '../../viewer/tool-store';
import { useFormStore } from '../form-store';
import { useCreateStore } from './create-store';
import { kindName } from './field-actions';

export { CreatedFieldLayer } from './CreatedFieldLayer';
export { resetCreateStore, useCreateStore } from './create-store';
export { kindName } from './field-actions';

export const FIELD_KINDS: readonly CreatedFieldKind[] = [
  'text',
  'checkbox',
  'radio',
  'dropdown',
  'listbox',
  'signature',
  'button',
];

/** Popups that give the focus back to their control when they close (menu, palette). */
const POPUP = '[role="menu"], [role="dialog"], [role="alertdialog"], [role="listbox"]';
/** How long arming waits for such a popup to close before taking the focus anyway. */
const SETTLE_MS = 1000;

/** The control that armed placing (focus goes back there on Esc). */
let placingInvoker: HTMLElement | null = null;
let settleFrame = 0;

/** The placing layer of the current page (else the first one shown). */
function currentPlacingLayer(): HTMLElement | null {
  const page = useViewStore.getState().currentPage;
  return (
    document.querySelector<HTMLElement>(`[data-created-field-layer="${page}"][data-placing]`) ??
    document.querySelector<HTMLElement>('[data-created-field-layer][data-placing]')
  );
}

/**
 * Focuses the current page's placing layer once the focus has left the popup that armed
 * placing (the menu or palette returns it to its control first, which becomes the invoker).
 */
function focusPlacingLayer(): void {
  if (typeof window === 'undefined') return;
  cancelAnimationFrame(settleFrame);
  const started = performance.now();
  const step = () => {
    if (useCreateStore.getState().placing === null) return;
    const waiting = performance.now() - started < SETTLE_MS;
    const active = document.activeElement;
    const inPopup = active instanceof HTMLElement && active.closest(POPUP) !== null;
    const layer = currentPlacingLayer();
    if ((inPopup || !layer) && waiting) {
      settleFrame = requestAnimationFrame(step);
      return;
    }
    if (!layer) return;
    if (active !== layer) {
      placingInvoker =
        active instanceof HTMLElement && active !== document.body && !inPopup ? active : null;
    }
    layer.focus({ preventScroll: true });
  };
  settleFrame = requestAnimationFrame(step);
}

/** Esc while a placing layer has the focus: back to the control that armed placing. */
function returnPlacingFocus(): void {
  if (typeof document === 'undefined') return;
  cancelAnimationFrame(settleFrame);
  const invoker = placingInvoker;
  placingInvoker = null;
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !active.matches('[data-created-field-layer]')) return;
  const target = invoker?.isConnected
    ? invoker
    : document.querySelector<HTMLElement>('[data-read-viewport]');
  target?.focus({ preventScroll: true });
}

/**
 * Arms placing `kind`: the page view, Select tool, the field editor closed. A new field is
 * a page edit: never in Read (ADR-0019 §3; the command is disabled there).
 */
export function startPlacing(kind: CreatedFieldKind): void {
  if (!getActiveDocument(useWorkspaceStore.getState().workspace)) return;
  if (!canEditActive()) return;
  const ui = useUiStore.getState();
  if (!isPageView(ui)) ui.setViewMode('read');
  useToolStore.getState().setMode('select');
  useFormStore.getState().setActive(null);
  const store = useCreateStore.getState();
  store.select(null);
  store.setPlacing(kind);
  announce(m.forms_create_placing({ kind: kindName(kind) }));
  focusPlacingLayer();
}

export function cancelPlacing(): void {
  if (useCreateStore.getState().placing === null) return;
  returnPlacingFocus();
  useCreateStore.getState().setPlacing(null);
  announce(m.forms_create_placing_cancelled());
}

/** Turns "Edit fields" on or off (on only in Edit: it moves and resizes fields). */
export function setDesign(on: boolean): void {
  const store = useCreateStore.getState();
  if (store.design === on) return;
  if (on && !canEditActive()) return;
  if (on) {
    const ui = useUiStore.getState();
    if (!isPageView(ui)) ui.setViewMode('read');
    useToolStore.getState().setMode('select');
    useFormStore.getState().setActive(null);
  }
  store.setDesign(on);
  announce(on ? m.forms_design_on() : m.forms_design_off());
}

const stop = () => {
  const store = useCreateStore.getState();
  if (store.placing !== null) store.setPlacing(null);
  if (store.design) store.setDesign(false);
};

useUiStore.subscribe((state, previous) => {
  if (stageView(state) !== stageView(previous)) stop();
  // The document left Edit: placing and editing fields stop.
  else if (state.documentMode !== previous.documentMode && !canEditActive()) stop();
});
// Placing ended (placed, cancelled, stopped): forget the invoker.
useCreateStore.subscribe((state, previous) => {
  if (state.placing === null && previous.placing !== null) {
    if (typeof window !== 'undefined') cancelAnimationFrame(settleFrame);
    placingInvoker = null;
  }
});
useToolStore.subscribe((state, previous) => {
  if (state.mode !== previous.mode && state.mode !== 'select') stop();
});
useWorkspaceStore.subscribe((state, previous) => {
  if (state.workspace.activeDocument !== previous.workspace.activeDocument) stop();
});

if (typeof window !== 'undefined') {
  window.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Escape' || useCreateStore.getState().placing === null) return;
      event.preventDefault();
      event.stopPropagation();
      cancelPlacing();
    },
    { capture: true },
  );
}

export function registerCreateFieldCommands(registry: CommandRegistry): () => void {
  // Adding and editing fields are page edits: disabled in Read (ADR-0019 §3).
  const hasDocument = () =>
    (getActiveDocument(useWorkspaceStore.getState().workspace)?.pages.length ?? 0) > 0 &&
    canEditActive();
  const disposers = [
    ...FIELD_KINDS.map((kind) =>
      registry.register({
        id: `forms.add.${kind}`,
        title: m.cmd_forms_add({ kind: kindName(kind) }),
        group: m.group_tools(),
        keywords: ['form', 'field', 'add', 'create', 'new', kind],
        when: hasDocument,
        run: () => startPlacing(kind),
      }),
    ),
    registry.register({
      id: 'forms.design',
      title: m.cmd_forms_design(),
      group: m.group_tools(),
      keywords: ['form', 'fields', 'edit', 'move', 'resize', 'properties', 'prepare'],
      when: hasDocument,
      run: () => setDesign(!useCreateStore.getState().design),
    }),
  ];
  return () => {
    for (const dispose of disposers) dispose();
  };
}
