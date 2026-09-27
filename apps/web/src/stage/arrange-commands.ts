/**
 * Light-table commands (spec §3 keyboard alternative, §4, §5). Registered next to the
 * shell's commands so they appear in the palette and the shortcut overlay.
 *
 * Mod+X / Mod+C / Mod+V act on pages only in Arrange mode; elsewhere the browser keeps
 * its clipboard shortcuts (text selection in Read mode).
 */
import { getActiveDocument, reversePages } from '@pdf-editor/document-model';

import { targetPages } from '../commands/app-commands';
import { type CommandRegistry, commandRegistry } from '../commands/registry';
import { showInArrange } from '../dnd/drop';
import { announce } from '../shell/announcer';
import { useSelectionStore } from '../state/selection-store';
import { useUiStore } from '../state/ui-store';
import { useWorkspaceStore } from '../state/workspace-store';
import {
  copyPages,
  cutPages,
  extractPages,
  insertBlankAfter,
  movePagesToEdge,
  pastePages,
  reverseSelectedPages,
  selectParity,
} from './arrange-actions';
import { sectionCommandTarget } from './section-menu';

const ui = () => useUiStore.getState();
const model = () => useWorkspaceStore.getState();
const inArrange = () => ui().viewMode === 'arrange';
const hasTargets = () => targetPages().length > 0;
const hasClipboard = () => (useSelectionStore.getState().clipboard?.pageIds.length ?? 0) > 0;
/** The section a section command acts on: the invoking section, else the active tab. */
const sectionDocument = () => {
  const ws = model().workspace;
  const id = sectionCommandTarget() ?? ws.activeDocument;
  return id === undefined ? undefined : ws.documents[id];
};

let columnsProvider: () => number = () => 1;

/** The light table reports its column count so row-edge moves work from the palette. */
export function provideArrangeColumns(provider: () => number): () => void {
  columnsProvider = provider;
  return () => {
    if (columnsProvider === provider) columnsProvider = () => 1;
  };
}

export function registerArrangeCommands(registry: CommandRegistry = commandRegistry): () => void {
  const disposers = [
    registry.register({
      id: 'pages.cut',
      title: 'Cut pages',
      group: 'Pages',
      shortcut: 'Mod+X',
      keywords: ['move', 'clipboard', 'light table'],
      note: 'Arrange mode. Paste after the focused page with Mod+V, also in another document.',
      when: () => inArrange() && hasTargets(),
      run: () => {
        cutPages();
      },
    }),
    registry.register({
      id: 'pages.copy',
      title: 'Copy pages',
      group: 'Pages',
      shortcut: 'Mod+C',
      keywords: ['clipboard', 'duplicate', 'light table'],
      note: 'Arrange mode.',
      when: () => inArrange() && hasTargets(),
      run: () => {
        copyPages();
      },
    }),
    registry.register({
      id: 'pages.paste',
      title: 'Paste pages after the focused page',
      group: 'Pages',
      shortcut: 'Mod+V',
      keywords: ['clipboard', 'move', 'insert', 'light table'],
      note: 'Arrange mode. Cut pages move; copied pages are duplicated.',
      when: () => inArrange() && hasClipboard(),
      run: () => {
        pastePages(false);
      },
    }),
    registry.register({
      id: 'pages.pasteDuplicate',
      title: 'Paste pages as duplicates',
      group: 'Pages',
      shortcut: 'Mod+Shift+V',
      keywords: ['clipboard', 'copy', 'light table'],
      note: 'Arrange mode.',
      when: () => inArrange() && hasClipboard(),
      run: () => {
        pastePages(true);
      },
    }),
    registry.register({
      id: 'pages.extract',
      title: 'Extract pages to new document',
      group: 'Pages',
      shortcut: 'Mod+Shift+E',
      keywords: ['split', 'new', 'export', 'separate'],
      when: hasTargets,
      run: () => {
        extractPages();
      },
    }),
    registry.register({
      id: 'pages.insertBlank',
      title: 'Insert blank page after',
      group: 'Pages',
      keywords: ['empty', 'new page', 'add'],
      when: hasTargets,
      run: () => {
        insertBlankAfter();
      },
    }),
    registry.register({
      id: 'pages.moveToRowStart',
      title: 'Move pages to start of row',
      group: 'Pages',
      shortcut: 'Alt+Shift+Left',
      keywords: ['reorder', 'light table'],
      when: () => inArrange() && hasTargets(),
      run: () => {
        movePagesToEdge('row-start', columnsProvider());
      },
    }),
    registry.register({
      id: 'pages.moveToRowEnd',
      title: 'Move pages to end of row',
      group: 'Pages',
      shortcut: 'Alt+Shift+Right',
      keywords: ['reorder', 'light table'],
      when: () => inArrange() && hasTargets(),
      run: () => {
        movePagesToEdge('row-end', columnsProvider());
      },
    }),
    registry.register({
      id: 'pages.moveToStart',
      title: 'Move pages to start of document',
      group: 'Pages',
      shortcut: 'Alt+Shift+Up',
      keywords: ['reorder', 'first', 'top'],
      when: hasTargets,
      run: () => {
        movePagesToEdge('section-start', columnsProvider());
      },
    }),
    registry.register({
      id: 'pages.moveToEnd',
      title: 'Move pages to end of document',
      group: 'Pages',
      shortcut: 'Alt+Shift+Down',
      keywords: ['reorder', 'last', 'bottom'],
      when: hasTargets,
      run: () => {
        movePagesToEdge('section-end', columnsProvider());
      },
    }),
    registry.register({
      id: 'pages.reverseSelection',
      title: 'Reverse selection order',
      group: 'Pages',
      keywords: ['flip', 'reorder', 'backwards'],
      when: () => targetPages().length > 1,
      run: () => {
        reverseSelectedPages();
      },
    }),
    ...(['odd', 'even'] as const).map((parity) =>
      registry.register({
        id: `pages.select.${parity}`,
        title: `Select ${parity} pages`,
        group: 'Pages',
        keywords: ['selection', parity === 'odd' ? 'front' : 'back', 'duplex'],
        when: () => (getActiveDocument(model().workspace)?.pages.length ?? 0) > 0,
        run: () => {
          const doc = getActiveDocument(model().workspace);
          if (doc) selectParity(doc.id, parity);
        },
      }),
    ),
    registry.register({
      id: 'arrange.keep',
      title: 'Keep document in Arrange',
      group: 'View',
      keywords: ['pin', 'light table', 'section', 'show'],
      when: () => {
        const active = model().workspace.activeDocument;
        return active !== undefined && !ui().arrangePinned.includes(active);
      },
      run: () => {
        const active = model().workspace.activeDocument;
        if (active !== undefined) showInArrange(active);
      },
    }),
    registry.register({
      id: 'arrange.showAll',
      title: 'Show all documents in Arrange',
      group: 'View',
      keywords: ['pin', 'light table', 'sections', 'merge'],
      when: () => model().workspace.documentOrder.length > 1,
      run: () => {
        const ws = model().workspace;
        ui().pinToArrange(ws.documentOrder);
        ui().setViewMode('arrange');
        announce(`Showing ${ws.documentOrder.length} documents in Arrange`);
      },
    }),
    registry.register({
      id: 'section.reverse',
      title: 'Reverse pages of document',
      group: 'Pages',
      keywords: ['backwards', 'flip', 'order'],
      when: () => (sectionDocument()?.pages.length ?? 0) > 1,
      run: () => {
        const doc = sectionDocument();
        if (!doc) return;
        if (model().applyOperation((ws) => reversePages(ws, doc.id), `Reverse ${doc.title}`)) {
          announce(`Reversed the pages of ${doc.title}`);
        }
      },
    }),
    registry.register({
      id: 'section.close',
      title: 'Close document',
      group: 'File',
      hiddenInPalette: true,
      when: () => sectionDocument() !== undefined,
      run: () => {
        const doc = sectionDocument();
        if (!doc) return;
        model().closeDocument(doc.id);
        ui().unpinFromArrange(doc.id);
        announce(`Closed ${doc.title}`);
      },
    }),
  ];
  return () => {
    for (const dispose of disposers) dispose();
  };
}
