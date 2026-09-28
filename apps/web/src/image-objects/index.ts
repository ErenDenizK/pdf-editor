/**
 * Image objects (M4 §3): the Image tool's page layer (select, move, resize with handles,
 * nudge), its contextual bar (replace, extract, delete, size readout) and image edits as
 * history entries through the annotation edit runner. Importing this module registers the
 * page layer; the tool itself is listed with the annotation tools (annotations/tools.ts, I).
 */
import { getEngineService } from '../engine/engine-service';
import { registerPageOverlay } from '../stage/page-overlays';
import { useWorkspaceStore } from '../state/workspace-store';
import { useToolStore } from '../viewer/tool-store';
import { ImageLayer } from './ImageLayer';
import { useImageStore } from './image-store';

export { deleteImage, extractImage, replaceImage, transformImage } from './actions';
export { useImageStore } from './image-store';

registerPageOverlay(Object.assign(ImageLayer, { displayName: 'ImageLayer' }));

// Leaving the tool (Esc, another tool, Arrange mode) drops the selection.
useToolStore.subscribe((state, previous) => {
  if (state.mode !== previous.mode && state.mode !== 'image') useImageStore.getState().clear();
});

// Another document, or the source going away, too.
useWorkspaceStore.subscribe((state, previous) => {
  if (state.workspace.activeDocument !== previous.workspace.activeDocument) {
    useImageStore.getState().clear();
  }
});

getEngineService().onSourceClosed((source) => {
  if (useImageStore.getState().selection?.target.source === source) {
    useImageStore.getState().clear();
  }
});
