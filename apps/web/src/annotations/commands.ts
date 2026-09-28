/**
 * Annotation commands: one per tool (spec §2 shortcuts), built-in stamps, delete, and the
 * Comments panel. Registered by `registerAppCommands` before the page commands so that
 * in Read mode R is the rectangle tool and Delete removes the selected annotation; in
 * Arrange mode the tools are unavailable and the page commands keep those keys.
 */
import { pickFiles } from '../files/open-files';
import { m } from '../i18n';
import { announce } from '../shell/announcer';
import type { CommandRegistry } from '../commands/registry';
import { registerRedactionCommands } from '../redaction/commands';
import { markSelection } from '../redaction/marks';
import { useUiStore } from '../state/ui-store';
import { useWorkspaceStore } from '../state/workspace-store';
import { useToolStore } from '../viewer/tool-store';
import { deleteAnnotations } from './actions';
import { useAnnotationStore } from './annotation-store';
import { markupFromSelection } from './selection-markup';
import { BUILTIN_STAMPS, builtinPendingStamp, imageStamp } from './stamps';
import { ANNOTATION_TOOLS, isMarkupMode, type ToolDefinition } from './tools';

const readMode = () =>
  useUiStore.getState().viewMode === 'read' &&
  useWorkspaceStore.getState().workspace.documentOrder.length > 0;

/** Asks for an image and arms the stamp tool with it. Needs a user gesture. */
export async function pickImageStamp(kind: 'image' | 'signature' = 'image'): Promise<boolean> {
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
  if (isMarkupMode(tool.mode) && (await markupFromSelection(tool.mode))) return;
  // Redact: selected text becomes a mark (redaction spec §1.1); else the tool arms.
  if (tool.mode === 'redact' && (await markSelection())) return;
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
  announce(m.announce_tool({ tool: tool.title() }));
}

export function registerAnnotationCommands(registry: CommandRegistry): () => void {
  const disposers = [
    ...ANNOTATION_TOOLS.map((tool) =>
      registry.register({
        id: `tool.${tool.mode}`,
        title: m.cmd_tool({ tool: tool.title() }),
        group: m.group_tools(),
        ...(tool.shortcut === undefined ? {} : { shortcut: tool.shortcut }),
        keywords: ['tool', 'annotate', 'annotation'],
        when: readMode,
        run: () => activateTool(tool),
      }),
    ),
    ...BUILTIN_STAMPS.map((stamp) =>
      registry.register({
        id: `stamp.${stamp.name.toLowerCase()}`,
        title: m.cmd_stamp({ name: stamp.label() }),
        group: m.group_tools(),
        keywords: ['stamp', 'annotate', stamp.name],
        when: readMode,
        run: () => {
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
      when: () => readMode() && useAnnotationStore.getState().selection !== null,
      run: async () => {
        const selection = useAnnotationStore.getState().selection;
        if (selection) await deleteAnnotations(selection, selection.ids);
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
  ];
  return () => {
    for (const dispose of disposers) dispose();
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
