/**
 * AcroForm filling (M3, spec document-tools §1). Importing this module registers the form
 * page overlay (after the annotation layer, so it draws above it) and closes the field
 * editor when leaving Read mode, switching documents or picking a drawing tool.
 */
import { getActiveDocument } from '@pdf-editor/document-model';

import '../annotations';
import type { CommandRegistry } from '../commands/registry';
import { m } from '../i18n';
import { announce } from '../shell/announcer';
import { registerPageOverlay } from '../stage/page-overlays';
import { canEditActive, stageView, useUiStore } from '../state/ui-store';
import { useWorkspaceStore } from '../state/workspace-store';
import { useToolStore } from '../viewer/tool-store';
import { clearAllFields } from './actions';
import { clearCreatedFields } from './create/field-actions';
import { documentSources, useFormStore } from './form-store';
import { CreatedFieldLayer, registerCreateFieldCommands } from './create';
import { FormLayer } from './FormLayer';

export { clearAllFields, fieldLabel, fillField } from './actions';
export { useFormStore } from './form-store';

registerPageOverlay(FormLayer);
// Created fields draw above the source fields' targets (forms/create).
registerPageOverlay(CreatedFieldLayer);

const close = () => {
  if (useFormStore.getState().active !== null) useFormStore.getState().setActive(null);
};

useUiStore.subscribe((state, previous) => {
  if (stageView(state) !== stageView(previous)) close();
});
useToolStore.subscribe((state, previous) => {
  if (state.mode !== previous.mode && state.mode !== 'select') close();
});
useWorkspaceStore.subscribe((state, previous) => {
  if (state.workspace.activeDocument !== previous.workspace.activeDocument) close();
});

const activeDocument = () => getActiveDocument(useWorkspaceStore.getState().workspace);

let clears = 0;

/**
 * Clears every field of the active document: its sources' fields (engine edits) and the
 * fields created in the app (model), as one history entry. A page edit: never in Read
 * (ADR-0019 §3; the command is disabled there).
 */
export async function clearActiveForm(): Promise<number> {
  const doc = activeDocument();
  if (!doc || !canEditActive()) return 0;
  close();
  const key = `forms-clear-${++clears}`;
  const engine = await clearAllFields(documentSources(doc), key);
  const created = clearCreatedFields(doc.id, engine > 0 ? key : undefined);
  const count = engine + created;
  announce(count === 0 ? m.forms_nothing_to_clear() : m.forms_cleared({ count }));
  return count;
}

export function registerFormCommands(registry: CommandRegistry): () => void {
  const disposers = [
    registerCreateFieldCommands(registry),
    registry.register({
      id: 'view.show.forms',
      title: m.cmd_show_forms(),
      group: m.group_view(),
      keywords: ['panel', 'sidebar', 'form', 'fields', 'acroform'],
      run: () => useUiStore.setState({ leftPanelOpen: true, leftPanelView: 'forms' }),
    }),
    registry.register({
      id: 'forms.highlight',
      title: m.cmd_forms_highlight(),
      group: m.group_tools(),
      keywords: ['form', 'fields', 'highlight', 'show'],
      run: () => {
        const on = !useFormStore.getState().highlight;
        useFormStore.getState().setHighlight(on);
        announce(on ? m.forms_highlight_on() : m.forms_highlight_off());
      },
    }),
    registry.register({
      id: 'forms.clear',
      title: m.cmd_forms_clear(),
      group: m.group_edit(),
      keywords: ['form', 'fields', 'reset', 'empty'],
      when: () => activeDocument() !== undefined && canEditActive(),
      run: () => {
        void clearActiveForm();
      },
    }),
  ];
  return () => {
    for (const dispose of disposers) dispose();
  };
}
