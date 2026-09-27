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
import { announce } from '../shell/announcer';
import { pickPdfFiles } from '../files/open-files';
import { type ToolId, useUiStore } from '../state/ui-store';
import { closeDocument, openDocuments, useWorkspaceStore } from '../state/workspace-store';
import { type CommandRegistry, commandRegistry } from './registry';

const ui = () => useUiStore.getState();
const hasDocument = () => useWorkspaceStore.getState().documents.length > 0;

export async function openFilesFromPicker(): Promise<void> {
  const files = await pickPdfFiles();
  if (files.length === 0) return;
  openDocuments(files);
  announce(
    files.length === 1 ? `Opened ${files[0]?.name ?? 'file'}` : `Opened ${files.length} files`,
  );
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
      when: () => ui().activeTabId !== null,
      run: () => {
        const id = ui().activeTabId;
        if (id === null) return;
        const name = useWorkspaceStore.getState().documents.find((d) => d.id === id)?.name;
        closeDocument(id);
        if (name) announce(`Closed ${name}`);
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
      when: () => ui().tool !== 'select',
      run: () => ui().setTool('select'),
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
