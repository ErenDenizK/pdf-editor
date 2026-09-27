/**
 * Annotation tools (M2, spec viewer-annotations §2–§5, §9). Importing this module
 * registers the annotation page overlay and keeps the annotation selection honest:
 * pointer presses outside annotation chrome deselect, and switching documents or modes
 * resets the tool.
 */
import { registerPageOverlay } from '../stage/page-overlays';
import { useUiStore } from '../state/ui-store';
import { useWorkspaceStore } from '../state/workspace-store';
import { useToolStore } from '../viewer/tool-store';
import { AnnotationLayer } from './AnnotationLayer';
import { useAnnotationStore } from './annotation-store';

export {
  activateTool,
  clearAnnotationTools,
  hasAnnotationToolState,
  pickImageStamp,
  registerAnnotationCommands,
} from './commands';
export { ANNOTATION_TOOLS, type ToolDefinition } from './tools';

registerPageOverlay(AnnotationLayer);

/** Elements whose presses keep the annotation selection (chrome that edits it). */
const KEEP_SELECTOR =
  '[data-annotation-keep], #right-panel, [role="dialog"], [data-comments-panel]';

if (typeof window !== 'undefined') {
  window.addEventListener(
    'pointerdown',
    (event) => {
      const store = useAnnotationStore.getState();
      if (store.selection === null) return;
      const target = event.target;
      if (target instanceof Element && target.closest(KEEP_SELECTOR)) return;
      store.select(null);
    },
    { capture: true },
  );
}

// Arrange mode has no annotation tools; a new active document starts with nothing selected.
useUiStore.subscribe((state, previous) => {
  if (state.viewMode !== previous.viewMode && state.viewMode !== 'read') {
    useToolStore.getState().setMode('select');
    useAnnotationStore.getState().select(null);
    useAnnotationStore.getState().setEditor(null);
  }
});

useWorkspaceStore.subscribe((state, previous) => {
  if (state.workspace.activeDocument !== previous.workspace.activeDocument) {
    useAnnotationStore.getState().select(null);
    useAnnotationStore.getState().setEditor(null);
  }
});
