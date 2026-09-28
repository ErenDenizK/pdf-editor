/**
 * Field creation (spec redaction-and-text-editing §3): "Add field" in the Forms panel (and
 * the command palette) arms a kind; a click or drag on a page places it (CreatedFieldLayer,
 * registered by forms/index.ts after the form layer). "Edit fields" turns created fields
 * into selectable, movable objects with a properties popover.
 *
 * Placing and editing end when leaving Read mode, switching documents or picking another
 * tool; Esc cancels placing. A ToolMode for placing fields can be added to the tool store
 * later; until then the Forms panel drives it.
 */
import { type CreatedFieldKind, getActiveDocument } from '@pdf-editor/document-model';

import type { CommandRegistry } from '../../commands/registry';
import { m } from '../../i18n';
import { announce } from '../../shell/announcer';
import { useUiStore } from '../../state/ui-store';
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

/** Arms placing `kind`: Read mode, Select tool, the field editor closed. */
export function startPlacing(kind: CreatedFieldKind): void {
  if (!getActiveDocument(useWorkspaceStore.getState().workspace)) return;
  const ui = useUiStore.getState();
  if (ui.viewMode !== 'read') ui.setViewMode('read');
  useToolStore.getState().setMode('select');
  useFormStore.getState().setActive(null);
  const store = useCreateStore.getState();
  store.select(null);
  store.setPlacing(kind);
  announce(m.forms_create_placing({ kind: kindName(kind) }));
}

export function cancelPlacing(): void {
  if (useCreateStore.getState().placing === null) return;
  useCreateStore.getState().setPlacing(null);
  announce(m.forms_create_placing_cancelled());
}

/** Turns "Edit fields" on or off. */
export function setDesign(on: boolean): void {
  const store = useCreateStore.getState();
  if (store.design === on) return;
  if (on) {
    const ui = useUiStore.getState();
    if (ui.viewMode !== 'read') ui.setViewMode('read');
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
  if (state.viewMode !== previous.viewMode) stop();
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
  const hasDocument = () =>
    (getActiveDocument(useWorkspaceStore.getState().workspace)?.pages.length ?? 0) > 0;
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
