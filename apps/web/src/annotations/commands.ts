/**
 * Annotation commands: one per tool (spec §2 shortcuts), built-in stamps, delete, and the
 * Comments panel. Registered by `registerAppCommands` before the page commands so that
 * in Read mode R is the rectangle tool and Delete removes the selected annotation; in
 * Arrange mode the tools are unavailable and the page commands keep those keys.
 *
 * The Read lock (ADR-0019 §3): a tool key, button or palette entry pressed while the
 * document is in Read switches it to Edit and arms the tool, announced "Edit mode. Pen
 * tool"; over selected text a markup or redact key only switches, keeping the selection, so
 * marking takes a second press. Delete does nothing in Read.
 */
// Registers the Edit text page layer (the tool itself is in ANNOTATION_TOOLS).
import '../text-edit';
// Registers the Image tool's page layer (the tool itself is in ANNOTATION_TOOLS).
import '../image-objects';
// Registers the Read selection bar (Copy, "Mark up…"; ADR-0019 §3).
import './ReadSelectionBar';

import { pickFiles } from '../files/open-files';
import { deleteImage, useImageStore } from '../image-objects';
import { m } from '../i18n';
import { announce } from '../shell/announcer';
import type { CommandRegistry } from '../commands/registry';
import { registerRedactionCommands } from '../redaction/commands';
import { markSelection } from '../redaction/marks';
import { canEdit, canEditActive, isPageView, useUiStore } from '../state/ui-store';
import { useWorkspaceStore } from '../state/workspace-store';
import { useToolStore } from '../viewer/tool-store';
import { deleteAnnotations } from './actions';
import { commitOpenEditor } from './InlineEditors';
import { deleteLassoSelection } from './lasso/edits';
import { activateHighlighter } from './pen/highlighter';
import { activePathSelection, useAnnotationStore } from './annotation-store';
import { hasTextSelection, markupFromSelection } from './selection-markup';
import { BUILTIN_STAMPS, builtinPendingStamp, imageStamp } from './stamps';
import { ANNOTATION_TOOLS, isMarkupMode, type ToolDefinition } from './tools';

const readMode = () =>
  isPageView(useUiStore.getState()) &&
  useWorkspaceStore.getState().workspace.documentOrder.length > 0;

/**
 * Before a tool arms: a document in Read switches to Edit, said first so that the tool named
 * next follows it ("Edit mode. Blue pen"). False when there is no document to edit.
 */
export function enterEditForTool(): boolean {
  const id = useWorkspaceStore.getState().workspace.activeDocument;
  if (id === undefined) return false;
  if (canEdit(id)) return true;
  useUiStore.getState().setDocumentMode(id, 'edit');
  announce(m.mode_edit_long());
  return true;
}

/** Asks for an image and arms the stamp tool with it. Needs a user gesture. */
export async function pickImageStamp(kind: 'image' | 'signature' = 'image'): Promise<boolean> {
  if (!enterEditForTool()) return false;
  const [file] = await pickFiles('images');
  if (!file) return false;
  try {
    const stamp = await imageStamp(file, kind);
    useAnnotationStore.getState().setPendingStamp(stamp);
    useToolStore.getState().setMode(kind === 'image' ? 'stamp' : 'signature');
    announce(m.annot_place_stamp());
    return true;
  } catch (error) {
    console.warn('Could not read the image', error);
    announce(m.annot_image_failed({ name: file.name }));
    return false;
  }
}

/** Activates a tool the way its button and shortcut do. */
export async function activateTool(tool: ToolDefinition): Promise<void> {
  const tools = useToolStore.getState();
  const store = useAnnotationStore.getState();
  const id = useWorkspaceStore.getState().workspace.activeDocument;
  if (id !== undefined && !canEdit(id)) {
    // Select is the idle tool of both modes: V in Read changes nothing.
    if (tool.mode === 'select') return;
    // Read (ADR-0019 §3): switch to Edit and arm, synchronously so that both are said in
    // one announcement. Selected text stays selected and is marked by a second press.
    enterEditForTool();
    if ((isMarkupMode(tool.mode) || tool.mode === 'redact') && hasTextSelection()) return;
  } else {
    if (isMarkupMode(tool.mode) && (await markupFromSelection(tool.mode))) return;
    // Redact: selected text becomes a mark (redaction spec §1.1); else the tool arms.
    if (tool.mode === 'redact' && (await markSelection())) return;
  }
  if (tool.mode === 'stamp') {
    const pending = store.pendingStamp;
    if (!pending || pending.kind === 'signature') {
      await pickImageStamp('image');
      return;
    }
  }
  if (tool.mode === 'signature') {
    if (store.pendingStamp?.kind !== 'signature') {
      store.setSignatureDialogOpen(true);
      return;
    }
  }
  if (tool.mode !== 'select') store.select(null);
  tools.setMode(tool.mode);
  // Keyed: a more precise word said with it (the armed pen preset) replaces it.
  announce(m.announce_tool({ tool: tool.title() }), { key: 'tool' });
}

export function registerAnnotationCommands(registry: CommandRegistry): () => void {
  const disposers = [
    ...ANNOTATION_TOOLS.map((tool) =>
      registry.register({
        id: `tool.${tool.mode}`,
        title: m.cmd_tool({ tool: tool.title() }),
        group: m.group_tools(),
        ...(tool.shortcut === undefined ? {} : { shortcut: tool.shortcut }),
        keywords: ['tool', 'annotate', 'annotation', ...(tool.keywords ?? [])],
        when: readMode,
        run: () => activateTool(tool),
      }),
    ),
    // Highlight (H) arms the Highlighter preset (craft spec §5.4, pen/highlighter.ts).
    registry.register({
      id: 'tool.highlighter',
      title: m.cmd_tool({ tool: m.tool_highlighter() }),
      group: m.group_tools(),
      shortcut: 'H',
      keywords: ['tool', 'annotate', 'annotation', 'highlight'],
      when: readMode,
      run: () => activateHighlighter(activateTool),
    }),
    ...BUILTIN_STAMPS.map((stamp) =>
      registry.register({
        id: `stamp.${stamp.name.toLowerCase()}`,
        title: m.cmd_stamp({ name: stamp.label() }),
        group: m.group_tools(),
        keywords: ['stamp', 'annotate', stamp.name],
        when: readMode,
        run: () => {
          if (!enterEditForTool()) return;
          useAnnotationStore.getState().setPendingStamp(builtinPendingStamp(stamp.name));
          useToolStore.getState().setMode('stamp');
          announce(m.annot_place_stamp());
        },
      }),
    ),
    registry.register({
      id: 'stamp.image',
      title: m.cmd_stamp_image(),
      group: m.group_tools(),
      keywords: ['stamp', 'image', 'picture', 'logo'],
      when: readMode,
      run: () => pickImageStamp('image').then(() => undefined),
    }),
    registry.register({
      id: 'annotation.delete',
      title: m.cmd_delete_annotation(),
      group: m.group_edit(),
      shortcut: ['Delete', 'Backspace'],
      keywords: ['remove', 'annotation', 'comment'],
      when: () => readMode() && canEditActive() && useAnnotationStore.getState().selection !== null,
      run: async () => {
        const state = useAnnotationStore.getState();
        // A lasso selection deletes the taken strokes only (lasso/edits.ts).
        if (activePathSelection(state)) await deleteLassoSelection();
        else if (state.selection) await deleteAnnotations(state.selection, state.selection.ids);
      },
    }),
    registry.register({
      id: 'image.delete',
      title: m.cmd_delete_image(),
      group: m.group_edit(),
      shortcut: ['Delete', 'Backspace'],
      keywords: ['remove', 'image', 'picture'],
      when: () => readMode() && canEditActive() && useImageStore.getState().selection !== null,
      run: async () => {
        const selection = useImageStore.getState().selection;
        if (selection) await deleteImage(selection.target, selection.image);
      },
    }),
    registry.register({
      id: 'view.show.comments',
      title: m.cmd_show_comments(),
      group: m.group_view(),
      keywords: ['panel', 'sidebar', 'annotations', 'notes'],
      run: () => useUiStore.setState({ leftPanelOpen: true, leftPanelView: 'comments' }),
    }),
    registerRedactionCommands(registry),
    watchReadLock(),
  ];
  return () => {
    for (const dispose of disposers) dispose();
  };
}

/**
 * Entering Read (`1`, the control, a tab whose document is in Read) commits an open inline
 * editor and drops the annotation and image selections, so nothing stays half-edited behind
 * the lock (the tool store disarms the tool itself).
 */
function watchReadLock(): () => void {
  const lock = () => {
    if (canEditActive()) return;
    const store = useAnnotationStore.getState();
    if (store.editor !== null) {
      commitOpenEditor();
      useAnnotationStore.getState().setEditor(null);
    }
    if (useAnnotationStore.getState().selection !== null) store.select(null);
    if (useImageStore.getState().selection !== null) useImageStore.getState().select(null);
  };
  const offUi = useUiStore.subscribe((state, previous) => {
    if (state.documentMode !== previous.documentMode) lock();
  });
  const offWorkspace = useWorkspaceStore.subscribe((state, previous) => {
    if (state.workspace.activeDocument !== previous.workspace.activeDocument) lock();
  });
  return () => {
    offUi();
    offWorkspace();
  };
}

/** Escape: back to Select, drop the annotation selection and any open editor. */
export function clearAnnotationTools(): boolean {
  const tools = useToolStore.getState();
  const store = useAnnotationStore.getState();
  const active = tools.mode !== 'select' || store.selection !== null || store.editor !== null;
  if (tools.mode !== 'select') tools.setMode('select');
  if (store.selection !== null) store.select(null);
  if (store.editor !== null) store.setEditor(null);
  return active;
}

export function hasAnnotationToolState(): boolean {
  const store = useAnnotationStore.getState();
  return (
    useToolStore.getState().mode !== 'select' || store.selection !== null || store.editor !== null
  );
}
