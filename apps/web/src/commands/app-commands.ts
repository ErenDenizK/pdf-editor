/**
 * The shell's commands. Everything here is reachable from the palette (Mod+K) and listed
 * in the shortcut overlay (?).
 *
 * Browser caveats, documented once here and surfaced via `note`:
 * - Mod+W (close tab) and Mod+T/N are reserved by browsers in a normal tab and never
 *   reach the page. In an installed PWA window Chromium delivers some of them. Keyboard
 *   users can always close the focused tab with Delete in the tab bar.
 * - Mod+=/-/0 override the browser's page zoom; `preventDefault` is honoured by Chromium,
 *   Firefox and Safari for keydown, so the document zooms instead of the UI.
 */
import { canRedo, canUndo, getActiveDocument, type PageId } from '@pdf-editor/document-model';

import type { EngineFailure } from '../engine/engine-service';
import { pickPdfFiles } from '../files/open-files';
import { announce } from '../shell/announcer';
import { selectAllOf, useSelectionStore } from '../state/selection-store';
import { ARRANGE_SIZES, type ToolId, useUiStore } from '../state/ui-store';
import { pagesPhrase, useWorkspaceStore } from '../state/workspace-store';
import { type CommandRegistry, commandRegistry } from './registry';
import { currentPlatform } from './shortcuts';

const ui = () => useUiStore.getState();
const model = () => useWorkspaceStore.getState();
const selection = () => useSelectionStore.getState();
const hasDocument = () => model().workspace.documentOrder.length > 0;
const activeDocument = () => getActiveDocument(model().workspace);

function failureReason(error: EngineFailure): string {
  switch (error.code) {
    case 'password-cancelled':
    case 'password-required':
    case 'password-incorrect':
      return 'no password';
    case 'unsupported-encryption':
      return 'unsupported encryption';
    case 'corrupt':
      return 'the file is damaged';
    case 'read-failed':
      return 'the file could not be read';
    case 'unsupported':
      return 'unsupported file';
    case 'out-of-memory':
      return 'not enough memory';
    case 'aborted':
    case 'internal':
      return 'the engine failed';
  }
}

/** Opens files as tabs (in the given order) and announces the outcome. */
export async function openDocuments(files: readonly File[]): Promise<void> {
  if (files.length === 0) return;
  const { opened, skipped } = await model().openFiles(files);
  const parts: string[] = [];
  if (opened.length === 1) parts.push(`Opened ${opened[0]?.name ?? 'file'}`);
  else if (opened.length > 1) parts.push(`Opened ${opened.length} files`);
  for (const skip of skipped) parts.push(`Skipped ${skip.name}: ${failureReason(skip.error)}`);
  if (parts.length > 0) announce(parts.join('. '));
}

export async function openFilesFromPicker(): Promise<void> {
  const files = await pickPdfFiles();
  await openDocuments(files);
}

/**
 * Pages the page commands act on: the selection; in Arrange mode, the keyboard-focused
 * page when nothing is selected.
 */
export function targetPages(): PageId[] {
  const { selected, focused } = selection();
  if (selected.size > 0) {
    // Keep document order so announcements and moves read naturally.
    const ws = model().workspace;
    const ordered: PageId[] = [];
    for (const id of ws.documentOrder) {
      for (const page of ws.documents[id]?.pages ?? []) {
        if (selected.has(page.id)) ordered.push(page.id);
      }
    }
    return ordered;
  }
  if (focused !== null && ui().viewMode === 'arrange') return [focused];
  return [];
}

const hasTargets = () => targetPages().length > 0;

function rotate(delta: 90 | -90): void {
  const pages = targetPages();
  if (model().rotatePages(pages, delta)) {
    announce(`Rotated ${pagesPhrase(pages.length)} ${delta > 0 ? 'right' : 'left'}`);
  }
}

function deleteTargets(): void {
  const pages = targetPages();
  if (pages.length === 0) return;
  // Focus the page after the deleted block (else before it) so keyboard work continues.
  const doc = activeDocument();
  const deleted = new Set(pages);
  let nextFocus: PageId | null = null;
  if (doc) {
    const indices = doc.pages.flatMap((p, i) => (deleted.has(p.id) ? [i] : []));
    const last = indices[indices.length - 1] ?? -1;
    const first = indices[0] ?? -1;
    nextFocus =
      doc.pages.slice(last + 1).find((p) => !deleted.has(p.id))?.id ??
      doc.pages
        .slice(0, Math.max(0, first))
        .reverse()
        .find((p) => !deleted.has(p.id))?.id ??
      null;
  }
  if (model().deletePages(pages)) {
    useSelectionStore.getState().apply({
      selected: new Set(),
      anchor: null,
      focused: nextFocus,
    });
    announce(`Deleted ${pagesPhrase(pages.length)}. Undo with ${undoHint()}`);
  }
}

function undoHint(): string {
  return currentPlatform === 'mac' ? 'Command Z' : 'Control Z';
}

/**
 * Moves the selected pages of the active document by `delta` slots (±1, or ±columns in
 * the light table). Consecutive moves of the same pages coalesce into one undo step.
 */
export function moveSelectionBy(delta: number): boolean {
  const doc = activeDocument();
  if (!doc || delta === 0) return false;
  const targets = new Set(targetPages());
  const indices = doc.pages.flatMap((p, i) => (targets.has(p.id) ? [i] : []));
  const first = indices[0];
  const last = indices[indices.length - 1];
  if (first === undefined || last === undefined) return false;
  const count = doc.pages.length;
  const gap = delta > 0 ? Math.min(count, last + 1 + delta) : Math.max(0, first + delta);
  const ids = indices.flatMap((i) => {
    const id = doc.pages[i]?.id;
    return id === undefined ? [] : [id];
  });
  const moved = model().movePages(
    ids,
    { document: doc.id, index: gap },
    { coalesceKey: `move:${[...ids].sort().join(',')}` },
  );
  if (!moved) return false;
  const after = getActiveDocument(model().workspace);
  const position = (after?.pages.findIndex((p) => p.id === ids[0]) ?? 0) + 1;
  announce(`Moved ${pagesPhrase(ids.length)} to position ${position} in ${doc.title}`);
  return true;
}

export function arrangeSizeMessage(): string {
  const size = ARRANGE_SIZES[ui().arrangeSize] ?? ARRANGE_SIZES[1];
  return `Thumbnail size ${size.label}`;
}

export const TOOLS: readonly { id: ToolId; title: string; shortcut: string }[] = [
  { id: 'select', title: 'Select', shortcut: 'V' },
  { id: 'highlight', title: 'Highlight', shortcut: 'H' },
  { id: 'ink', title: 'Ink', shortcut: 'P' },
  { id: 'text', title: 'Text', shortcut: 'T' },
  { id: 'shapes', title: 'Shapes', shortcut: 'U' },
  { id: 'note', title: 'Note', shortcut: 'N' },
];

/** Registers all shell commands; returns a disposer (safe under StrictMode re-runs). */
export function registerAppCommands(registry: CommandRegistry = commandRegistry): () => void {
  const disposers = [
    registry.register({
      id: 'file.open',
      title: 'Open files…',
      group: 'File',
      shortcut: 'Mod+O',
      keywords: ['add', 'import', 'pdf', 'load'],
      allowInInputs: true,
      run: openFilesFromPicker,
    }),
    registry.register({
      id: 'tab.close',
      title: 'Close tab',
      group: 'File',
      shortcut: 'Mod+W',
      keywords: ['document', 'close'],
      note: 'Browsers usually keep this key; press Delete on a focused tab instead.',
      when: () => activeDocument() !== undefined,
      run: () => {
        const doc = activeDocument();
        if (!doc) return;
        model().closeDocument(doc.id);
        announce(`Closed ${doc.title}`);
      },
    }),
    registry.register({
      id: 'view.palette',
      title: 'Command palette',
      group: 'General',
      shortcut: 'Mod+K',
      allowInInputs: true,
      hiddenInPalette: true,
      run: () => ui().setPaletteOpen(!ui().paletteOpen),
    }),
    registry.register({
      id: 'help.shortcuts',
      title: 'Keyboard shortcuts',
      group: 'General',
      shortcut: '?',
      keywords: ['help', 'keys', 'keymap', 'hotkeys'],
      run: () => ui().setShortcutsOpen(!ui().shortcutsOpen),
    }),
    registry.register({
      id: 'selection.clear',
      title: 'Clear tool and selection',
      group: 'General',
      shortcut: 'Escape',
      hiddenInPalette: true,
      when: () => ui().tool !== 'select' || selection().selected.size > 0,
      run: () => {
        ui().setTool('select');
        selection().clear();
      },
    }),
    registry.register({
      id: 'edit.undo',
      title: 'Undo',
      group: 'Edit',
      shortcut: 'Mod+Z',
      keywords: ['revert', 'back'],
      when: () => canUndo(model().history),
      run: () => {
        const label = model().undo();
        if (label) announce(`Undid ${label}`);
      },
    }),
    registry.register({
      id: 'edit.redo',
      title: 'Redo',
      group: 'Edit',
      shortcut: ['Mod+Shift+Z', 'Mod+Y'],
      keywords: ['again', 'forward'],
      when: () => canRedo(model().history),
      run: () => {
        const label = model().redo();
        if (label) announce(`Redid ${label}`);
      },
    }),
    registry.register({
      id: 'pages.selectAll',
      title: 'Select all pages',
      group: 'Pages',
      shortcut: 'Mod+A',
      keywords: ['selection', 'everything'],
      when: () => (activeDocument()?.pages.length ?? 0) > 0,
      run: () => {
        const doc = activeDocument();
        if (!doc) return;
        const order = doc.pages.map((p) => p.id);
        selection().apply(selectAllOf(order, selection().focused));
        announce(`Selected ${pagesPhrase(order.length)}`);
      },
    }),
    registry.register({
      id: 'pages.rotateRight',
      title: 'Rotate pages right',
      group: 'Pages',
      shortcut: 'R',
      keywords: ['clockwise', 'turn', '90'],
      when: hasTargets,
      run: () => rotate(90),
    }),
    registry.register({
      id: 'pages.rotateLeft',
      title: 'Rotate pages left',
      group: 'Pages',
      shortcut: 'Shift+R',
      keywords: ['counterclockwise', 'anticlockwise', 'turn', '90'],
      when: hasTargets,
      run: () => rotate(-90),
    }),
    registry.register({
      id: 'pages.delete',
      title: 'Delete pages',
      group: 'Pages',
      shortcut: ['Delete', 'Backspace'],
      keywords: ['remove'],
      when: hasTargets,
      run: deleteTargets,
    }),
    registry.register({
      id: 'pages.duplicate',
      title: 'Duplicate pages',
      group: 'Pages',
      shortcut: 'Mod+D',
      keywords: ['copy', 'clone'],
      note: 'Some browsers keep Mod+D for bookmarks outside the light table.',
      when: hasTargets,
      run: () => {
        const pages = targetPages();
        if (model().duplicatePages(pages)) announce(`Duplicated ${pagesPhrase(pages.length)}`);
      },
    }),
    registry.register({
      id: 'pages.moveBackward',
      title: 'Move pages back one slot',
      group: 'Pages',
      shortcut: 'Alt+Left',
      keywords: ['reorder', 'earlier', 'left'],
      when: hasTargets,
      run: () => {
        moveSelectionBy(-1);
      },
    }),
    registry.register({
      id: 'pages.moveForward',
      title: 'Move pages forward one slot',
      group: 'Pages',
      shortcut: 'Alt+Right',
      keywords: ['reorder', 'later', 'right'],
      when: hasTargets,
      run: () => {
        moveSelectionBy(1);
      },
    }),
    registry.register({
      id: 'view.toggleLeftPanel',
      title: 'Toggle left panel',
      group: 'View',
      shortcut: 'Mod+B',
      keywords: ['sidebar', 'pages', 'outline', 'files'],
      run: () => ui().toggleLeftPanel(),
    }),
    registry.register({
      id: 'view.toggleRightPanel',
      title: 'Toggle right panel',
      group: 'View',
      shortcut: 'Mod+Alt+B',
      keywords: ['inspector', 'properties', 'history', 'info'],
      run: () => ui().toggleRightPanel(),
    }),
    ...(['pages', 'outline', 'files'] as const).map((view) =>
      registry.register({
        id: `view.show.${view}`,
        title: `Show ${view}`,
        group: 'View',
        keywords: ['panel', 'sidebar'],
        run: () => useUiStore.setState({ leftPanelOpen: true, leftPanelView: view }),
      }),
    ),
    registry.register({
      id: 'mode.read',
      title: 'Switch to Read',
      group: 'View',
      shortcut: '1',
      keywords: ['mode', 'viewer', 'continuous'],
      run: () => {
        ui().setViewMode('read');
        announce('Read mode');
      },
    }),
    registry.register({
      id: 'mode.arrange',
      title: 'Switch to Arrange',
      group: 'View',
      shortcut: '2',
      keywords: ['mode', 'light table', 'grid', 'organize', 'reorder'],
      run: () => {
        ui().setViewMode('arrange');
        announce('Arrange mode');
      },
    }),
    registry.register({
      id: 'zoom.in',
      title: 'Zoom in',
      group: 'Zoom',
      shortcut: 'Mod+=',
      keywords: ['magnify', 'bigger'],
      run: () => ui().zoomIn(),
    }),
    registry.register({
      id: 'zoom.out',
      title: 'Zoom out',
      group: 'Zoom',
      shortcut: 'Mod+-',
      keywords: ['smaller'],
      run: () => ui().zoomOut(),
    }),
    registry.register({
      id: 'zoom.fit',
      title: 'Zoom to fit width',
      group: 'Zoom',
      shortcut: 'Mod+0',
      keywords: ['reset', 'fit'],
      run: () => ui().zoomFit(),
    }),
    registry.register({
      id: 'zoom.fitPage',
      title: 'Zoom to fit page',
      group: 'Zoom',
      keywords: ['whole', 'fit', 'page'],
      run: () => ui().zoomFitPage(),
    }),
    registry.register({
      id: 'zoom.actual',
      title: 'Actual size',
      group: 'Zoom',
      keywords: ['100%', 'reset', 'real'],
      run: () => ui().zoomActual(),
    }),
    registry.register({
      id: 'arrange.larger',
      title: 'Larger thumbnails',
      group: 'Zoom',
      keywords: ['light table', 'cell size', 'bigger'],
      note: 'Mod+Scroll in Arrange mode',
      when: () => ui().arrangeSize < ARRANGE_SIZES.length - 1,
      run: () => {
        if (ui().stepArrangeSize(1)) announce(arrangeSizeMessage());
      },
    }),
    registry.register({
      id: 'arrange.smaller',
      title: 'Smaller thumbnails',
      group: 'Zoom',
      keywords: ['light table', 'cell size'],
      note: 'Mod+Scroll in Arrange mode',
      when: () => ui().arrangeSize > 0,
      run: () => {
        if (ui().stepArrangeSize(-1)) announce(arrangeSizeMessage());
      },
    }),
    ...TOOLS.map((tool) =>
      registry.register({
        id: `tool.${tool.id}`,
        title: `${tool.title} tool`,
        group: 'Tools',
        shortcut: tool.shortcut,
        keywords: ['tool', 'annotate'],
        when: hasDocument,
        run: () => ui().setTool(tool.id),
      }),
    ),
  ];
  return () => {
    for (const dispose of disposers) dispose();
  };
}
