/**
 * Edit text (M4, redaction-and-text-editing spec §2.2, §2.5): the tool's page layer, the
 * inline editor with the honesty badge, and text edits as history entries through the
 * annotation edit runner (undo = reopen + replay). Importing this module registers the page
 * layer; the tool itself is listed with the annotation tools (annotations/tools.ts, E).
 */
import { getEngineService } from '../engine/engine-service';
import { registerPageOverlay } from '../stage/page-overlays';
import { useWorkspaceStore } from '../state/workspace-store';
import { useToolStore } from '../viewer/tool-store';
import { TextEditLayer } from './TextEditLayer';
import { useTextEditStore } from './text-edit-store';

export { commitTextEdit, type TextEditCommit, type TextEditOutcome } from './actions';
export { useTextEditStore } from './text-edit-store';

registerPageOverlay(Object.assign(TextEditLayer, { displayName: 'TextEditLayer' }));

// Leaving the tool (Esc, another tool, Arrange mode) closes the editor without applying.
useToolStore.subscribe((state, previous) => {
  if (state.mode !== previous.mode && state.mode !== 'edit-text') {
    useTextEditStore.getState().close();
  }
});

// Another document, or the source going away, also closes it.
useWorkspaceStore.subscribe((state, previous) => {
  if (state.workspace.activeDocument !== previous.workspace.activeDocument) {
    useTextEditStore.getState().close();
  }
});

getEngineService().onSourceClosed((source) => {
  if (useTextEditStore.getState().session?.target.source === source) {
    useTextEditStore.getState().close();
  }
});
