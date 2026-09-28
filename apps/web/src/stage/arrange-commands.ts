/**
 * Light-table commands (spec §3 keyboard alternative, §4, §5). Registered next to the
 * shell's commands so they appear in the palette and the shortcut overlay. Titles, notes
 * and groups are read in the active language; `app.tsx` re-registers on a language switch.
 *
 * Mod+X / Mod+C / Mod+V act on pages only in Arrange mode; elsewhere the browser keeps
 * its clipboard shortcuts (text selection in Read mode).
 */
import {
  type DocumentId,
  findPageLocation,
  getActiveDocument,
  type PageId,
  reversePages,
} from '@pdf-editor/document-model';

import { targetPages } from '../commands/app-commands';
import { type CommandRegistry, commandRegistry } from '../commands/registry';
import { showInArrange } from '../dnd/drop';
import { pickFiles } from '../files/open-files';
import { m } from '../i18n';
import { announce } from '../shell/announcer';
import { useSelectionStore } from '../state/selection-store';
import { useUiStore } from '../state/ui-store';
import { tabItems, useWorkspaceStore } from '../state/workspace-store';
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
import { openOperationDialog } from './operation-dialogs-store';
import {
  copyPagesToNewDocument,
  insertImagesInto,
  mergeInto,
  startRename,
} from './section-operations';
import {
  provideMergeTargets,
  registerSectionMenuItem,
  sectionCommandOrigin,
  sectionCommandTarget,
} from './section-menu';

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
const otherDocuments = (id: DocumentId) =>
  model().workspace.documentOrder.filter((other) => other !== id);

let columnsProvider: () => number = () => 1;

/** The light table reports its column count so row-edge moves work from the palette. */
export function provideArrangeColumns(provider: () => number): () => void {
  columnsProvider = provider;
  return () => {
    if (columnsProvider === provider) columnsProvider = () => 1;
  };
}

/**
 * "Resize pages…" from the palette, the context menu or the section menu: the selected
 * pages (of the invoking section, when a section menu ran it), else the whole document.
 */
function openResizeDialog(): void {
  openPagesDialog('resize');
}

/** "Crop pages…" (crop/): the same pages as "Resize pages…". */
function openCropDialog(): void {
  openPagesDialog('crop');
}

function openPagesDialog(kind: 'resize' | 'crop'): void {
  const ws = model().workspace;
  const fromSection = sectionCommandTarget();
  let pages: PageId[] = targetPages();
  if (fromSection !== null) {
    pages = pages.filter((id) => findPageLocation(ws, id)?.document === fromSection);
  }
  const documentId =
    fromSection ??
    (pages[0] === undefined ? undefined : findPageLocation(ws, pages[0])?.document) ??
    ws.activeDocument;
  if (documentId === undefined || ws.documents[documentId] === undefined) return;
  openOperationDialog({ kind, documentId, pageIds: pages });
}

/** Other open documents as "Merge into…" submenu entries, in tab order. */
function mergeTargetEntries(documentId: DocumentId) {
  const { workspace, documentColors } = model();
  return tabItems(workspace, documentColors)
    .filter((tab) => tab.id !== documentId)
    .map((tab) => ({
      key: tab.id,
      label: tab.title,
      colorIndex: tab.colorIndex,
      run: () => {
        mergeInto(documentId, tab.id);
      },
    }));
}

export function registerArrangeCommands(registry: CommandRegistry = commandRegistry): () => void {
  const pages = m.group_pages();
  const documents = m.group_documents();
  const view = m.group_view();
  const file = m.group_file();
  const disposers = [
    provideMergeTargets(mergeTargetEntries),
    registerSectionMenuItem({ command: 'section.resize', label: m.section_resize, group: 'pages' }),
    registerSectionMenuItem({ command: 'section.crop', label: m.section_crop, group: 'pages' }),
    registry.register({
      id: 'pages.cut',
      title: m.cmd_cut_pages(),
      group: pages,
      shortcut: 'Mod+X',
      keywords: ['move', 'clipboard', 'light table'],
      note: m.cmd_cut_pages_note(),
      when: () => inArrange() && hasTargets(),
      run: () => {
        cutPages();
      },
    }),
    registry.register({
      id: 'pages.copy',
      title: m.cmd_copy_pages(),
      group: pages,
      shortcut: 'Mod+C',
      keywords: ['clipboard', 'duplicate', 'light table'],
      note: m.cmd_arrange_only_note(),
      when: () => inArrange() && hasTargets(),
      run: () => {
        copyPages();
      },
    }),
    registry.register({
      id: 'pages.paste',
      title: m.cmd_paste_pages(),
      group: pages,
      shortcut: 'Mod+V',
      keywords: ['clipboard', 'move', 'insert', 'light table'],
      note: m.cmd_paste_pages_note(),
      when: () => inArrange() && hasClipboard(),
      run: () => {
        pastePages(false);
      },
    }),
    registry.register({
      id: 'pages.pasteDuplicate',
      title: m.cmd_paste_duplicates(),
      group: pages,
      shortcut: 'Mod+Shift+V',
      keywords: ['clipboard', 'copy', 'light table'],
      note: m.cmd_arrange_only_note(),
      when: () => inArrange() && hasClipboard(),
      run: () => {
        pastePages(true);
      },
    }),
    registry.register({
      id: 'pages.extract',
      title: m.cmd_move_to_new_document(),
      group: pages,
      shortcut: 'Mod+Shift+E',
      keywords: ['extract', 'split', 'new', 'separate'],
      when: hasTargets,
      run: () => {
        extractPages();
      },
    }),
    registry.register({
      id: 'pages.copyToNew',
      title: m.cmd_copy_to_new_document(),
      group: pages,
      keywords: ['extract', 'duplicate', 'new', 'copy'],
      when: hasTargets,
      run: () => {
        copyPagesToNewDocument();
      },
    }),
    registry.register({
      id: 'pages.insertBlank',
      title: m.cmd_insert_blank(),
      group: pages,
      keywords: ['empty', 'new page', 'add'],
      when: hasTargets,
      run: () => {
        insertBlankAfter();
      },
    }),
    registry.register({
      id: 'pages.resize',
      title: m.cmd_resize_pages(),
      group: pages,
      keywords: ['page size', 'scale', 'fit', 'canvas', 'a4', 'letter', 'paper', 'dimensions'],
      when: () => hasTargets() || (getActiveDocument(model().workspace)?.pages.length ?? 0) > 0,
      run: openResizeDialog,
    }),
    registry.register({
      id: 'pages.crop',
      title: m.cmd_crop_pages(),
      group: pages,
      keywords: ['cropbox', 'trim', 'margins', 'cut', 'discard', 'remove content'],
      when: () => hasTargets() || (getActiveDocument(model().workspace)?.pages.length ?? 0) > 0,
      run: openCropDialog,
    }),
    registry.register({
      id: 'pages.moveToRowStart',
      title: m.cmd_move_row_start(),
      group: pages,
      shortcut: 'Alt+Shift+Left',
      keywords: ['reorder', 'light table'],
      when: () => inArrange() && hasTargets(),
      run: () => {
        movePagesToEdge('row-start', columnsProvider());
      },
    }),
    registry.register({
      id: 'pages.moveToRowEnd',
      title: m.cmd_move_row_end(),
      group: pages,
      shortcut: 'Alt+Shift+Right',
      keywords: ['reorder', 'light table'],
      when: () => inArrange() && hasTargets(),
      run: () => {
        movePagesToEdge('row-end', columnsProvider());
      },
    }),
    registry.register({
      id: 'pages.moveToStart',
      title: m.cmd_move_document_start(),
      group: pages,
      shortcut: 'Alt+Shift+Up',
      keywords: ['reorder', 'first', 'top'],
      when: hasTargets,
      run: () => {
        movePagesToEdge('section-start', columnsProvider());
      },
    }),
    registry.register({
      id: 'pages.moveToEnd',
      title: m.cmd_move_document_end(),
      group: pages,
      shortcut: 'Alt+Shift+Down',
      keywords: ['reorder', 'last', 'bottom'],
      when: hasTargets,
      run: () => {
        movePagesToEdge('section-end', columnsProvider());
      },
    }),
    registry.register({
      id: 'pages.reverseSelection',
      title: m.cmd_reverse_selection(),
      group: pages,
      keywords: ['flip', 'reorder', 'backwards'],
      when: () => targetPages().length > 1,
      run: () => {
        reverseSelectedPages();
      },
    }),
    ...(['odd', 'even'] as const).map((parity) =>
      registry.register({
        id: `pages.select.${parity}`,
        title: parity === 'odd' ? m.cmd_select_odd() : m.cmd_select_even(),
        group: pages,
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
      title: m.cmd_keep_in_arrange(),
      group: view,
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
      title: m.cmd_show_all_in_arrange(),
      group: view,
      keywords: ['pin', 'light table', 'sections', 'merge'],
      when: () => model().workspace.documentOrder.length > 1,
      run: () => {
        const ws = model().workspace;
        ui().pinToArrange(ws.documentOrder);
        ui().setViewMode('arrange');
        announce(m.announce_showing_all({ count: ws.documentOrder.length }));
      },
    }),
    registry.register({
      id: 'section.reverse',
      title: m.cmd_reverse_document(),
      group: documents,
      keywords: ['backwards', 'flip', 'order'],
      when: () => (sectionDocument()?.pages.length ?? 0) > 1,
      run: () => {
        const doc = sectionDocument();
        if (!doc) return;
        if (
          model().applyOperation(
            (ws) => reversePages(ws, doc.id),
            m.history_reverse({ title: doc.title }),
          )
        ) {
          announce(m.announce_reversed_document({ title: doc.title }));
        }
      },
    }),
    registry.register({
      id: 'section.split',
      title: m.cmd_split_document(),
      group: documents,
      keywords: ['separate', 'chunks', 'ranges', 'bookmarks', 'every'],
      when: () => (sectionDocument()?.pages.length ?? 0) > 1,
      run: () => {
        const doc = sectionDocument();
        if (doc) openOperationDialog({ kind: 'split', documentId: doc.id });
      },
    }),
    registry.register({
      id: 'section.merge',
      title: m.cmd_merge_into(),
      group: documents,
      keywords: ['append', 'combine', 'join'],
      when: () => {
        const doc = sectionDocument();
        return doc !== undefined && otherDocuments(doc.id).length > 0;
      },
      run: () => {
        const doc = sectionDocument();
        if (doc) openOperationDialog({ kind: 'merge-into', documentId: doc.id });
      },
    }),
    registry.register({
      id: 'documents.mergeAll',
      title: m.cmd_merge_all(),
      group: documents,
      keywords: ['combine', 'join', 'concatenate', 'append', 'one file'],
      when: () => model().workspace.documentOrder.length > 1,
      run: () => {
        openOperationDialog({ kind: 'merge-all' });
      },
    }),
    registry.register({
      id: 'section.interleave',
      title: m.cmd_interleave(),
      group: documents,
      keywords: ['duplex', 'scan', 'odd even', 'collate', 'zip'],
      when: () => {
        const doc = sectionDocument();
        return doc !== undefined && otherDocuments(doc.id).length > 0;
      },
      run: () => {
        const doc = sectionDocument();
        if (doc) openOperationDialog({ kind: 'interleave', documentId: doc.id });
      },
    }),
    registry.register({
      id: 'section.resize',
      title: m.cmd_resize_document_pages(),
      group: documents,
      // The section and tab menus run it; the palette has "Resize pages…" (pages.resize).
      hiddenInPalette: true,
      keywords: ['page size', 'scale', 'fit', 'canvas', 'a4', 'letter', 'paper', 'dimensions'],
      when: () => (sectionDocument()?.pages.length ?? 0) > 0,
      run: openResizeDialog,
    }),
    registry.register({
      id: 'section.crop',
      title: m.cmd_crop_document_pages(),
      group: documents,
      // The section and tab menus run it; the palette has "Crop pages…" (pages.crop).
      hiddenInPalette: true,
      keywords: ['cropbox', 'trim', 'margins', 'cut', 'discard', 'remove content'],
      when: () => (sectionDocument()?.pages.length ?? 0) > 0,
      run: openCropDialog,
    }),
    registry.register({
      id: 'section.rename',
      title: m.cmd_rename_document(),
      group: documents,
      shortcut: 'F2',
      keywords: ['title', 'name'],
      note: m.cmd_rename_document_note(),
      when: () => sectionDocument() !== undefined,
      run: () => {
        const doc = sectionDocument();
        if (doc) startRename(doc.id, sectionCommandOrigin() ?? undefined);
      },
    }),
    registry.register({
      id: 'section.insertImages',
      title: m.cmd_insert_images(),
      group: documents,
      keywords: ['picture', 'photo', 'png', 'jpeg', 'jpg', 'webp', 'scan', 'add'],
      when: () => sectionDocument() !== undefined,
      run: async () => {
        const doc = sectionDocument();
        if (!doc) return;
        const id = doc.id;
        // The picker needs this click's user activation: no await before it.
        const files = await pickFiles('images');
        if (files.length > 0) await insertImagesInto(id, files);
      },
    }),
    registry.register({
      id: 'section.close',
      title: m.section_close(),
      group: file,
      hiddenInPalette: true,
      when: () => sectionDocument() !== undefined,
      run: () => {
        const doc = sectionDocument();
        if (!doc) return;
        model().closeDocument(doc.id);
        ui().unpinFromArrange(doc.id);
        announce(m.announce_closed({ name: doc.title }));
      },
    }),
  ];
  return () => {
    for (const dispose of disposers) dispose();
  };
}
