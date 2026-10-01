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

import {
  clearAnnotationTools,
  hasAnnotationToolState,
  registerAnnotationCommands,
} from '../annotations';
import { registerCompareCommands } from '../compare/compare-commands';
import { registerConvertCommands } from '../convert/convert-commands';
import type { EngineFailure } from '../engine/engine-service';
import { partitionFiles, pickFiles } from '../files/open-files';
import { registerFurnitureCommands } from '../furniture';
import { registerFormCommands } from '../forms';
import { m } from '../i18n';
import { registerLanguageCommands } from '../i18n/language-commands';
import { registerOcrCommands } from '../ocr';
import { announce } from '../shell/announcer';
import { useAuthorPrompt } from '../shell/comment-author';
import { openImagesAsDocument } from '../stage/section-operations';
import { selectAllOf, useSelectionStore } from '../state/selection-store';
import { ARRANGE_SIZES, useUiStore } from '../state/ui-store';
import { useWorkspaceStore } from '../state/workspace-store';
import { registerToolCommands } from '../tools/tool-commands';
import { registerViewerCommands } from '../viewer/viewer-commands';
import { registerExportCommands } from './export-commands';
import { type CommandRegistry, commandRegistry } from './registry';
import { currentPlatform } from './shortcuts';

const ui = () => useUiStore.getState();
const model = () => useWorkspaceStore.getState();
const selection = () => useSelectionStore.getState();
const activeDocument = () => getActiveDocument(model().workspace);

function failureReason(error: EngineFailure): string {
  switch (error.code) {
    case 'password-cancelled':
    case 'password-required':
    case 'password-incorrect':
      return m.failure_no_password();
    case 'unsupported-encryption':
      return m.failure_unsupported_encryption();
    case 'corrupt':
      return m.failure_corrupt();
    case 'read-failed':
      return m.failure_read_failed();
    case 'unsupported':
      return m.failure_unsupported();
    case 'out-of-memory':
      return m.failure_out_of_memory();
    case 'aborted':
    case 'internal':
      return m.failure_engine();
  }
}

/**
 * Opens files as tabs (in the given order) and announces the outcome. PDFs open one tab
 * each; images (PNG, JPEG, WebP) become the pages of one new document.
 */
export async function openDocuments(files: readonly File[]): Promise<void> {
  if (files.length === 0) return;
  const { pdfs, images } = partitionFiles(files);
  if (images.length > 0) await openImagesAsDocument(images);
  if (pdfs.length === 0) return;
  const { opened, skipped } = await model().openFiles(pdfs);
  const parts: string[] = [];
  if (opened.length === 1) parts.push(m.announce_opened({ name: opened[0]?.name ?? '' }));
  else if (opened.length > 1) parts.push(m.announce_opened_many({ count: opened.length }));
  for (const skip of skipped) {
    parts.push(m.announce_skipped({ name: skip.name, reason: failureReason(skip.error) }));
  }
  if (parts.length > 0) announce(parts.join('. '));
}

/** "Open files…" and the tab bar's "+": PDFs and images (images become one document). */
export async function openFilesFromPicker(): Promise<void> {
  const files = await pickFiles('openable');
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
    const count = pages.length;
    announce(delta > 0 ? m.announce_rotated_right({ count }) : m.announce_rotated_left({ count }));
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
    announce(m.announce_deleted({ count: pages.length, shortcut: undoHint() }));
  }
}

function undoHint(): string {
  return currentPlatform === 'mac' ? m.undo_hint_mac() : m.undo_hint_other();
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
  announce(m.announce_moved({ count: ids.length, position, title: doc.title }));
  return true;
}

export function arrangeSizeMessage(): string {
  const size = ARRANGE_SIZES[ui().arrangeSize] ?? ARRANGE_SIZES[1];
  return m.announce_thumbnail_size({ size: size.label });
}

/**
 * Registers all shell commands; returns a disposer (safe under StrictMode re-runs). Titles
 * and groups are read in the active language, so a language switch re-registers them.
 */
export function registerAppCommands(registry: CommandRegistry = commandRegistry): () => void {
  const disposers = [
    registry.register({
      id: 'file.open',
      title: m.cmd_open_files(),
      group: m.group_file(),
      shortcut: 'Mod+O',
      keywords: ['add', 'import', 'pdf', 'load'],
      allowInInputs: true,
      run: openFilesFromPicker,
    }),
    registry.register({
      id: 'tab.close',
      title: m.cmd_close_tab(),
      group: m.group_file(),
      shortcut: 'Mod+W',
      keywords: ['document', 'close'],
      note: m.cmd_close_tab_note(),
      when: () => activeDocument() !== undefined,
      run: () => {
        const doc = activeDocument();
        if (!doc) return;
        model().closeDocument(doc.id);
        announce(m.announce_closed({ name: doc.title }));
      },
    }),
    registry.register({
      id: 'view.palette',
      title: m.cmd_palette(),
      group: m.group_general(),
      shortcut: 'Mod+K',
      allowInInputs: true,
      hiddenInPalette: true,
      run: () => ui().setPaletteOpen(!ui().paletteOpen),
    }),
    registry.register({
      id: 'help.shortcuts',
      title: m.cmd_shortcuts(),
      group: m.group_general(),
      shortcut: '?',
      keywords: ['help', 'keys', 'keymap', 'hotkeys'],
      run: () => ui().setShortcutsOpen(!ui().shortcutsOpen),
    }),
    registry.register({
      id: 'selection.clear',
      title: m.cmd_clear_selection(),
      group: m.group_general(),
      shortcut: 'Escape',
      hiddenInPalette: true,
      when: () => hasAnnotationToolState() || selection().selected.size > 0,
      run: () => {
        // Esc returns to Select and drops the annotation selection first (spec §2).
        if (clearAnnotationTools()) return;
        selection().clear();
      },
    }),
    // Before the page commands: in Read mode R, Delete, ... act on annotations.
    registerAnnotationCommands(registry),
    // The author name is asked once at the first comment; this asks again (§4.1).
    registry.register({
      id: 'comments.setAuthor',
      title: m.cmd_set_author(),
      group: m.group_edit(),
      run: () => {
        useUiStore.setState({ leftPanelOpen: true, leftPanelView: 'comments' });
        useAuthorPrompt.getState().edit();
      },
    }),
    registry.register({
      id: 'edit.undo',
      title: m.cmd_undo(),
      group: m.group_edit(),
      shortcut: 'Mod+Z',
      keywords: ['revert', 'back'],
      when: () => canUndo(model().history),
      run: () => {
        const label = model().undo();
        if (label) announce(m.announce_undid({ label }));
      },
    }),
    registry.register({
      id: 'edit.redo',
      title: m.cmd_redo(),
      group: m.group_edit(),
      shortcut: ['Mod+Shift+Z', 'Mod+Y'],
      keywords: ['again', 'forward'],
      when: () => canRedo(model().history),
      run: () => {
        const label = model().redo();
        if (label) announce(m.announce_redid({ label }));
      },
    }),
    registry.register({
      id: 'pages.selectAll',
      title: m.cmd_select_all(),
      group: m.group_pages(),
      shortcut: 'Mod+A',
      keywords: ['selection', 'everything'],
      when: () => (activeDocument()?.pages.length ?? 0) > 0,
      run: () => {
        const doc = activeDocument();
        if (!doc) return;
        const order = doc.pages.map((p) => p.id);
        selection().apply(selectAllOf(order, selection().focused));
        announce(m.announce_selected({ count: order.length }));
      },
    }),
    registry.register({
      id: 'pages.rotateRight',
      title: m.cmd_rotate_right(),
      group: m.group_pages(),
      shortcut: 'R',
      keywords: ['clockwise', 'turn', '90'],
      when: hasTargets,
      run: () => rotate(90),
    }),
    registry.register({
      id: 'pages.rotateLeft',
      title: m.cmd_rotate_left(),
      group: m.group_pages(),
      shortcut: 'Shift+R',
      keywords: ['counterclockwise', 'anticlockwise', 'turn', '90'],
      when: hasTargets,
      run: () => rotate(-90),
    }),
    registry.register({
      id: 'pages.delete',
      title: m.cmd_delete_pages(),
      group: m.group_pages(),
      shortcut: ['Delete', 'Backspace'],
      keywords: ['remove'],
      when: hasTargets,
      run: deleteTargets,
    }),
    registry.register({
      id: 'pages.duplicate',
      title: m.cmd_duplicate_pages(),
      group: m.group_pages(),
      shortcut: 'Mod+D',
      keywords: ['copy', 'clone'],
      note: m.cmd_duplicate_pages_note(),
      when: hasTargets,
      run: () => {
        const pages = targetPages();
        if (model().duplicatePages(pages)) announce(m.announce_duplicated({ count: pages.length }));
      },
    }),
    registry.register({
      id: 'pages.moveBackward',
      title: m.cmd_move_backward(),
      group: m.group_pages(),
      shortcut: 'Alt+Left',
      keywords: ['reorder', 'earlier', 'left'],
      when: hasTargets,
      run: () => {
        moveSelectionBy(-1);
      },
    }),
    registry.register({
      id: 'pages.moveForward',
      title: m.cmd_move_forward(),
      group: m.group_pages(),
      shortcut: 'Alt+Right',
      keywords: ['reorder', 'later', 'right'],
      when: hasTargets,
      run: () => {
        moveSelectionBy(1);
      },
    }),
    registry.register({
      id: 'view.toggleLeftPanel',
      title: m.cmd_toggle_left_panel(),
      group: m.group_view(),
      shortcut: 'Mod+B',
      keywords: ['sidebar', 'pages', 'outline', 'files'],
      run: () => ui().toggleLeftPanel(),
    }),
    registry.register({
      id: 'view.toggleRightPanel',
      title: m.cmd_toggle_right_panel(),
      group: m.group_view(),
      shortcut: 'Mod+Alt+B',
      keywords: ['inspector', 'properties', 'history', 'info'],
      run: () => ui().toggleRightPanel(),
    }),
    ...(['pages', 'outline', 'files'] as const).map((view) =>
      registry.register({
        id: `view.show.${view}`,
        title: { pages: m.cmd_show_pages, outline: m.cmd_show_outline, files: m.cmd_show_files }[
          view
        ](),
        group: m.group_view(),
        keywords: ['panel', 'sidebar'],
        run: () => useUiStore.setState({ leftPanelOpen: true, leftPanelView: view }),
      }),
    ),
    registry.register({
      id: 'mode.read',
      title: m.cmd_mode_read(),
      group: m.group_view(),
      shortcut: '1',
      keywords: ['mode', 'viewer', 'continuous'],
      run: () => {
        ui().setViewMode('read');
        announce(m.mode_read_long());
      },
    }),
    registry.register({
      id: 'mode.arrange',
      title: m.cmd_mode_arrange(),
      group: m.group_view(),
      shortcut: '2',
      keywords: ['mode', 'light table', 'grid', 'organize', 'reorder'],
      run: () => {
        ui().setViewMode('arrange');
        announce(m.mode_arrange_long());
      },
    }),
    registry.register({
      id: 'zoom.in',
      title: m.cmd_zoom_in(),
      group: m.group_zoom(),
      shortcut: 'Mod+=',
      keywords: ['magnify', 'bigger'],
      run: () => ui().zoomIn(),
    }),
    registry.register({
      id: 'zoom.out',
      title: m.cmd_zoom_out(),
      group: m.group_zoom(),
      shortcut: 'Mod+-',
      keywords: ['smaller'],
      run: () => ui().zoomOut(),
    }),
    registry.register({
      id: 'zoom.fit',
      title: m.cmd_zoom_fit(),
      group: m.group_zoom(),
      shortcut: 'Mod+0',
      keywords: ['reset', 'fit'],
      run: () => ui().zoomFit(),
    }),
    registry.register({
      id: 'zoom.fitPage',
      title: m.cmd_zoom_fit_page(),
      group: m.group_zoom(),
      keywords: ['whole', 'fit', 'page'],
      run: () => ui().zoomFitPage(),
    }),
    registry.register({
      id: 'zoom.actual',
      title: m.cmd_zoom_actual(),
      group: m.group_zoom(),
      keywords: ['100%', 'reset', 'real'],
      run: () => ui().zoomActual(),
    }),
    registry.register({
      id: 'arrange.larger',
      title: m.cmd_thumbnails_larger(),
      group: m.group_zoom(),
      keywords: ['light table', 'cell size', 'bigger'],
      note: m.cmd_thumbnails_note(),
      when: () => ui().arrangeSize < ARRANGE_SIZES.length - 1,
      run: () => {
        if (ui().stepArrangeSize(1)) announce(arrangeSizeMessage());
      },
    }),
    registry.register({
      id: 'arrange.smaller',
      title: m.cmd_thumbnails_smaller(),
      group: m.group_zoom(),
      keywords: ['light table', 'cell size'],
      note: m.cmd_thumbnails_note(),
      when: () => ui().arrangeSize > 0,
      run: () => {
        if (ui().stepArrangeSize(-1)) announce(arrangeSizeMessage());
      },
    }),
    registerLanguageCommands(registry),
    registerExportCommands(registry),
    registerViewerCommands(registry),
    registerToolCommands(registry),
    registerConvertCommands(registry),
    registerOcrCommands(registry),
    registerCompareCommands(registry),
    registerFurnitureCommands(registry),
    registerFormCommands(registry),
  ];
  return () => {
    for (const dispose of disposers) dispose();
  };
}
