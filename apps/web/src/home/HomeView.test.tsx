/**
 * Home on real PDFs (Vitest browser mode, Chromium, PDFium; experience-redesign §3, §11):
 * the cards reflect the workspace, selection by click, Shift and Mod, Combine opens the
 * merge dialog in selection order, a card dropped on another opens it as [target, dragged],
 * Compare fills A and B, the keyboard path, drops on an empty workspace, and the empty
 * variant.
 */
import '../styles/tokens.css';
import '../styles/reset.css';
import '../styles/global.css';

import type { DocumentId } from '@pdf-editor/document-model';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';

import mixedUrl from '../../../../test/fixtures/mixed-sizes.pdf?url';
import rotatedUrl from '../../../../test/fixtures/rotated-pages.pdf?url';
import simpleUrl from '../../../../test/fixtures/simple-text.pdf?url';
import { App } from '../app';
import { openDocuments } from '../commands/app-commands';
import { commandRegistry } from '../commands/registry';
import { currentPlatform } from '../commands/shortcuts';
import { resetCompareStore, useCompareStore } from '../compare/compare-store';
import {
  loadRecents,
  memoryRecentsBackend,
  type RecentFileHandle,
  recordRecent,
  setRecentsBackend,
  storedHandlesReadable,
  useRecentsStore,
} from '../files/recents';
import { setLocale } from '../i18n';
import { closeOperationDialog } from '../stage/operation-dialogs-store';
import { useAnnouncer } from '../shell/announcer';
import { stageView, useUiStore } from '../state/ui-store';
import { resetWorkspace, useWorkspaceStore } from '../state/workspace-store';
import { HOME_CARD_TYPE } from './HomeView';

const MOD = currentPlatform === 'mac' ? 'Meta' : 'Control';

async function fixture(url: string, name: string): Promise<File> {
  const bytes = await (await fetch(url)).arrayBuffer();
  return new File([bytes], name, {
    type: 'application/pdf',
    lastModified: Date.UTC(2026, 8, 1, 12),
  });
}

const FILES: Readonly<Record<string, string>> = {
  'simple-text.pdf': simpleUrl,
  'rotated-pages.pdf': rotatedUrl,
  'mixed-sizes.pdf': mixedUrl,
};

const ws = () => useWorkspaceStore.getState().workspace;
/** What the stage shows: Home or a document view. */
const shown = () => stageView(useUiStore.getState());
const titleOf = (id: DocumentId | undefined) =>
  id === undefined ? undefined : ws().documents[id]?.title;

/** Opens fixtures (tab order as given) and shows Home. */
async function openOnHome(...names: string[]): Promise<readonly DocumentId[]> {
  render(<App />);
  const ids = await openDocuments(
    await Promise.all(names.map((name) => fixture(FILES[name] ?? '', name))),
  );
  useUiStore.getState().showHome();
  await screen.findByTestId('home');
  return ids;
}

const grid = () => screen.getByRole('listbox', { name: 'Files' });
const card = (title: string) =>
  within(grid()).getByRole('option', { name: new RegExp(`^${title},`) });
const selectedTitles = () =>
  within(grid())
    .getAllByRole('option', { selected: true })
    .map((o) => o.getAttribute('aria-label')?.split(',')[0]);
const dialogRows = (dialog: HTMLElement) =>
  within(dialog)
    .getAllByTestId('merge-row')
    .map((row) => /(simple-text|rotated-pages|mixed-sizes)/.exec(row.textContent ?? '')?.[1]);

/**
 * Dispatches a native drag event carrying `data` (Testing Library's `fireEvent` copies the
 * DataTransfer into an empty one, which loses its items and drag data).
 */
function drag(target: Element, type: string, data: DataTransfer): void {
  act(() => {
    target.dispatchEvent(
      new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data }),
    );
  });
}

/** A card drag as the browser sends it: dragstart, dragenter/over the target, drop, dragend. */
function dragCard(source: HTMLElement, target: HTMLElement, drop = true): DataTransfer {
  const data = new DataTransfer();
  drag(source, 'dragstart', data);
  drag(target, 'dragenter', data);
  drag(target, 'dragover', data);
  if (!drop) return data;
  drag(target, 'drop', data);
  drag(source, 'dragend', data);
  return data;
}

describe('Home', () => {
  beforeEach(async () => {
    await page.viewport(1440, 900);
    resetWorkspace();
    resetCompareStore();
    closeOperationDialog();
    useUiStore.setState({
      destination: 'document',
      viewMode: 'read',
      documentMode: {},
      lastView: {},
      homeSelection: [],
      homeAnchor: null,
      arrangePinned: [],
      arrangeHidden: [],
      paletteOpen: false,
    });
  });
  afterEach(() => {
    closeOperationDialog();
    resetWorkspace();
  });

  it('shows one card per open document, in tab order, with pages, size and a thumbnail', async () => {
    await openOnHome('simple-text.pdf', 'rotated-pages.pdf');
    const options = within(grid()).getAllByRole('option');
    expect(options.map((o) => o.getAttribute('aria-label'))).toEqual([
      expect.stringMatching(/^simple-text, 3 pages · \d+(\.\d)? KB$/),
      expect.stringMatching(/^rotated-pages, 4 pages · \d+(\.\d)? KB$/),
    ]);
    expect(options[0]).toHaveTextContent('Modified Sep 1, 2026');
    // The first page through the shared thumbnail renderer.
    await waitFor(
      () => {
        expect(options[1]?.querySelector('canvas[data-state="rendered"]')).not.toBeNull();
      },
      { timeout: 20_000 },
    );
    expect(screen.getByText('2 files · 7 pages')).toBeVisible();

    // A closed tab leaves Home.
    const first = ws().documentOrder[0];
    if (first !== undefined) useWorkspaceStore.getState().closeDocument(first);
    await waitFor(() => {
      expect(within(grid()).getAllByRole('option')).toHaveLength(1);
    });
  }, 45_000);

  it('selects with a click, adds with Mod, extends with Shift and clears between cards', async () => {
    await openOnHome('simple-text.pdf', 'rotated-pages.pdf', 'mixed-sizes.pdf');
    await userEvent.click(card('rotated-pages'));
    expect(selectedTitles()).toEqual(['rotated-pages']);

    await userEvent.keyboard(`{${MOD}>}`);
    await userEvent.click(card('simple-text'));
    await userEvent.keyboard(`{/${MOD}}`);
    expect(selectedTitles()).toEqual(['simple-text', 'rotated-pages']);
    // Selection order, not tab order.
    expect(useUiStore.getState().homeSelection.map(titleOf)).toEqual([
      'rotated-pages',
      'simple-text',
    ]);
    expect(screen.getByText('2 selected')).toBeVisible();
    // Said for a click as for the keyboard (spec §10).
    expect(useAnnouncer.getState().message).toBe('2 files selected');

    await userEvent.keyboard('{Shift>}');
    await userEvent.click(card('mixed-sizes'));
    await userEvent.keyboard('{/Shift}');
    // The range runs from the anchor (simple-text, the last Mod-click) to mixed-sizes.
    expect(selectedTitles()).toEqual(['simple-text', 'rotated-pages', 'mixed-sizes']);

    fireEvent.click(grid());
    expect(within(grid()).queryAllByRole('option', { selected: true })).toHaveLength(0);
  });

  it('labels Combine by its scope and opens the merge dialog in selection order', async () => {
    await openOnHome('simple-text.pdf', 'rotated-pages.pdf', 'mixed-sizes.pdf');
    const combine = screen.getByTestId('home-combine');
    expect(combine).toHaveTextContent('Combine all 3 files');
    await userEvent.click(card('simple-text'));
    // One selected: nothing to combine, so no button (never a disabled one, §3).
    expect(screen.queryByTestId('home-combine')).toBeNull();

    await userEvent.click(card('mixed-sizes'));
    await userEvent.keyboard(`{${MOD}>}`);
    await userEvent.click(card('simple-text'));
    await userEvent.keyboard(`{/${MOD}}`);
    expect(screen.getByTestId('home-combine')).toHaveTextContent('Combine 2 files');
    await userEvent.click(screen.getByTestId('home-combine'));

    const dialog = await screen.findByTestId('merge-all-dialog');
    expect(
      within(dialog).getByRole('heading', { name: 'Combine 2 documents' }),
    ).toBeInTheDocument();
    expect(dialogRows(dialog)).toEqual(['mixed-sizes', 'simple-text']);
    // A new document's name, not the first file's (review F8); it follows the order until edited.
    const name = within(dialog).getByRole('textbox', { name: 'Title of the merged document' });
    expect(name).toHaveValue('Combined – mixed-sizes + simple-text');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Move simple-text up' }));
    expect(name).toHaveValue('Combined – simple-text + mixed-sizes');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Move simple-text down' }));
    expect(name).toHaveValue('Combined – mixed-sizes + simple-text');

    // Confirming makes a new document, keeps the files open and shows it in Read.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Combine' }));
    await waitFor(() => {
      expect(shown()).toBe('read');
    });
    expect(ws().documentOrder.map((id) => titleOf(id))).toEqual([
      'simple-text',
      'rotated-pages',
      'mixed-sizes',
      'Combined – mixed-sizes + simple-text',
    ]);
    expect(ws().documents[ws().activeDocument ?? ('' as DocumentId)]?.pages).toHaveLength(
      (await pageCount('mixed-sizes')) + 3,
    );
    expect(useAnnouncer.getState().message).toBe(
      `Combined 2 files into Combined – mixed-sizes + simple-text. Undo with ${
        currentPlatform === 'mac' ? 'Command Z' : 'Control Z'
      }`,
    );
    // "Combined 2 files · Undo": one step back to the three files.
    const toast = await screen.findByTestId('combined-toast');
    expect(toast).toHaveTextContent('Combined 2 files');
    await userEvent.click(within(toast).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(screen.queryByTestId('combined-toast')).toBeNull());
    expect(ws().documentOrder.map((id) => titleOf(id))).toEqual([
      'simple-text',
      'rotated-pages',
      'mixed-sizes',
    ]);
  });

  it('opens the merge dialog with [target, dragged] when a card is dropped on another', async () => {
    await openOnHome('simple-text.pdf', 'rotated-pages.pdf', 'mixed-sizes.pdf');
    const data = dragCard(card('simple-text'), card('mixed-sizes'), false);
    // The drop target is marked and says what a drop does.
    expect(card('mixed-sizes')).toHaveAttribute('data-drop-target');
    expect(screen.getByTestId('home-drop-label')).toHaveTextContent('Combine with mixed-sizes');
    drag(card('mixed-sizes'), 'drop', data);

    const dialog = await screen.findByTestId('merge-all-dialog');
    expect(dialogRows(dialog)).toEqual(['mixed-sizes', 'simple-text']);
    // The dialog is modal (the cards are hidden from the accessibility tree behind it).
    expect(document.querySelector('[data-drop-target]')).toBeNull();
    closeOperationDialog();
    await waitFor(() => {
      expect(screen.queryByTestId('merge-all-dialog')).toBeNull();
      expect(screen.getByRole('listbox', { name: 'Files' })).toBeInTheDocument();
    });

    // The other way round; nothing merged without the dialog.
    dragCard(card('rotated-pages'), card('simple-text'));
    expect(dialogRows(await screen.findByTestId('merge-all-dialog'))).toEqual([
      'simple-text',
      'rotated-pages',
    ]);
    expect(ws().documentOrder).toHaveLength(3);
  });

  it('ignores drags that are not cards and a card dropped on itself', async () => {
    await openOnHome('simple-text.pdf', 'rotated-pages.pdf');
    const text = new DataTransfer();
    text.setData('text/plain', 'hello');
    drag(card('rotated-pages'), 'dragover', text);
    expect(card('rotated-pages')).not.toHaveAttribute('data-drop-target');
    dragCard(card('rotated-pages'), card('rotated-pages'));
    expect(screen.queryByTestId('merge-all-dialog')).toBeNull();
    expect(HOME_CARD_TYPE).toMatch(/^application\//);
  });

  it('compares exactly two selected files with A and B filled in', async () => {
    await openOnHome('simple-text.pdf', 'rotated-pages.pdf', 'mixed-sizes.pdf');
    const home = () => within(screen.getByTestId('home'));
    // Shown only when it applies (exactly two selected), never disabled.
    expect(home().queryByRole('button', { name: 'Compare' })).toBeNull();
    await userEvent.click(card('mixed-sizes'));
    expect(home().queryByRole('button', { name: 'Compare' })).toBeNull();
    await userEvent.keyboard(`{${MOD}>}`);
    await userEvent.click(card('simple-text'));
    await userEvent.keyboard(`{/${MOD}}`);
    await userEvent.click(home().getByRole('button', { name: 'Compare' }));
    await waitFor(() => {
      expect(shown()).toBe('compare');
    });
    const { a, b } = useCompareStore.getState();
    expect([titleOf(a ?? undefined), titleOf(b ?? undefined)]).toEqual([
      'mixed-sizes',
      'simple-text',
    ]);
  });

  it('arranges the selection and closes selected files in one undoable step', async () => {
    await openOnHome('simple-text.pdf', 'rotated-pages.pdf', 'mixed-sizes.pdf');
    // Close waits for a selection: hidden, not disabled.
    expect(within(screen.getByTestId('home')).queryByRole('button', { name: 'Close' })).toBeNull();
    await userEvent.click(card('rotated-pages'));
    await userEvent.keyboard(`{${MOD}>}`);
    await userEvent.click(card('mixed-sizes'));
    await userEvent.keyboard(`{/${MOD}}`);
    await userEvent.click(
      within(screen.getByTestId('home')).getByRole('button', { name: 'Close' }),
    );
    await waitFor(() => {
      expect(within(grid()).getAllByRole('option')).toHaveLength(1);
    });
    expect(useWorkspaceStore.getState().history.present.label).toBe('Close 2 documents');
    useWorkspaceStore.getState().undo();
    await waitFor(() => {
      expect(within(grid()).getAllByRole('option')).toHaveLength(3);
    });

    await userEvent.click(card('mixed-sizes'));
    await userEvent.click(
      within(screen.getByTestId('home')).getByRole('button', { name: 'Arrange pages' }),
    );
    await waitFor(() => {
      expect(shown()).toBe('arrange');
    });
    expect(titleOf(ws().activeDocument ?? undefined)).toBe('mixed-sizes');
    expect(await screen.findAllByRole('grid')).toHaveLength(1);
  });

  it('moves with arrows, toggles with Space, selects all with Mod+A and opens with Enter', async () => {
    await openOnHome('simple-text.pdf', 'rotated-pages.pdf', 'mixed-sizes.pdf');
    const options = within(grid()).getAllByRole('option');
    // Roving tabindex: one card is in the tab order.
    expect(options.filter((o) => o.tabIndex === 0)).toHaveLength(1);
    options[0]?.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(card('rotated-pages')).toHaveFocus();
    expect(card('rotated-pages').tabIndex).toBe(0);
    await userEvent.keyboard(' ');
    expect(selectedTitles()).toEqual(['rotated-pages']);
    await userEvent.keyboard('{Shift>}{ArrowRight}{/Shift}');
    expect(selectedTitles()).toEqual(['rotated-pages', 'mixed-sizes']);
    await userEvent.keyboard('{Escape}');
    expect(within(grid()).queryAllByRole('option', { selected: true })).toHaveLength(0);
    await userEvent.keyboard(`{${MOD}>}a{/${MOD}}`);
    expect(selectedTitles()).toEqual(['simple-text', 'rotated-pages', 'mixed-sizes']);

    await userEvent.keyboard('{Home}{Enter}');
    await waitFor(() => {
      expect(shown()).toBe('read');
    });
    expect(titleOf(ws().activeDocument ?? undefined)).toBe('simple-text');
  });

  it('opens a card in Read on a double click; Home has no mode control', async () => {
    await openOnHome('simple-text.pdf', 'rotated-pages.pdf');
    const segment = () => screen.getByRole('radiogroup', { name: 'View mode' });
    const glyph = () => screen.getByRole('button', { name: 'Home' });
    // Home is a view of the open files (ADR-0019 §1): no Read · Edit · Arrange, no tab
    // selected, the glyph current.
    expect(screen.queryByRole('radiogroup', { name: 'View mode' })).toBeNull();
    expect(glyph()).toHaveAttribute('aria-current', 'page');
    expect(
      within(screen.getByRole('tablist', { name: 'Open documents' }))
        .getAllByRole('tab')
        .filter((tab) => tab.getAttribute('aria-selected') === 'true'),
    ).toEqual([]);
    await userEvent.dblClick(card('rotated-pages'));
    await waitFor(() => {
      expect(shown()).toBe('read');
    });
    expect(titleOf(ws().activeDocument ?? undefined)).toBe('rotated-pages');
    expect(
      within(segment())
        .getAllByRole('radio')
        .map((radio) => radio.textContent),
    ).toEqual(['Read', 'Edit', 'Arrange']);
    expect(within(segment()).getByRole('radio', { name: 'Read, locked' })).toBeChecked();
    expect(glyph()).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('tab', { name: 'rotated-pages', selected: true })).toBeVisible();

    // The app glyph and 0 lead back.
    await userEvent.click(glyph());
    expect(shown()).toBe('home');
    useUiStore.getState().setViewMode('read');
    document.body.focus();
    await userEvent.keyboard('0');
    expect(shown()).toBe('home');
  });

  it('leaves Home by a tab click for that document in its last view and mode', async () => {
    const [simple, rotated] = await openOnHome('simple-text.pdf', 'rotated-pages.pdf');
    if (simple === undefined || rotated === undefined) throw new Error('not opened');
    // rotated-pages was last shown in Arrange, in Edit.
    act(() => {
      useWorkspaceStore.getState().setActive(rotated);
      useUiStore.getState().setDocumentMode(rotated, 'edit');
      useUiStore.getState().setViewMode('arrange');
      useWorkspaceStore.getState().setActive(simple);
      useUiStore.getState().setViewMode('read');
      useUiStore.getState().showHome();
    });
    await userEvent.click(screen.getByRole('tab', { name: 'rotated-pages' }));
    expect(shown()).toBe('arrange');
    expect(titleOf(ws().activeDocument ?? undefined)).toBe('rotated-pages');
    await userEvent.keyboard('0');
    await userEvent.click(screen.getByRole('tab', { name: 'simple-text' }));
    expect(shown()).toBe('read');
    const segment = screen.getByRole('radiogroup', { name: 'View mode' });
    expect(within(segment).getByRole('radio', { name: 'Read, locked' })).toBeChecked();
    // The mode is per document: rotated-pages stays in Edit on the shared page view.
    act(() => useWorkspaceStore.getState().setActive(rotated));
    expect(within(segment).getByRole('radio', { name: 'Edit' })).toBeChecked();
    await userEvent.keyboard('1');
    expect(within(segment).getByRole('radio', { name: 'Read, locked' })).toBeChecked();
    await userEvent.keyboard('2');
    expect(within(segment).getByRole('radio', { name: 'Edit' })).toBeChecked();
  });

  it('starts over after the last document closes: Home, then the next file in Read', async () => {
    const ids = await openOnHome('simple-text.pdf');
    act(() => {
      for (const id of ids) useWorkspaceStore.getState().closeDocument(id);
    });
    expect(screen.getByTestId('home')).toHaveAttribute('data-variant', 'empty');
    expect(screen.getByRole('button', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
    expect(useUiStore.getState()).toMatchObject({
      destination: 'document',
      viewMode: 'read',
      documentMode: {},
    });
  });

  it('shows Home with the new cards selected after two files are dropped on an empty app', async () => {
    render(<App />);
    const files = await Promise.all([
      fixture(simpleUrl, 'simple-text.pdf'),
      fixture(rotatedUrl, 'rotated-pages.pdf'),
    ]);
    const data = new DataTransfer();
    for (const file of files) data.items.add(file);
    const shell = screen.getByTestId('app-shell');
    drag(shell, 'dragenter', data);
    drag(shell, 'dragover', data);
    drag(shell, 'drop', data);
    await waitFor(
      () => {
        expect(within(grid()).getAllByRole('option', { selected: true })).toHaveLength(2);
      },
      { timeout: 20_000 },
    );
    expect(shown()).toBe('home');
    expect(screen.getByTestId('home-combine')).toHaveTextContent('Combine 2 files');

    // A file dropped while Home shows joins the cards, selected.
    const more = new DataTransfer();
    more.items.add(await fixture(mixedUrl, 'mixed-sizes.pdf'));
    drag(screen.getByTestId('home'), 'drop', more);
    await waitFor(
      () => {
        expect(selectedTitles()).toEqual(['mixed-sizes']);
      },
      { timeout: 20_000 },
    );
  }, 45_000);

  it('shows Home with the new cards selected after two files are picked with "Open files"', async () => {
    const files = await Promise.all([
      fixture(simpleUrl, 'simple-text.pdf'),
      fixture(rotatedUrl, 'rotated-pages.pdf'),
    ]);
    const picker = Object.getOwnPropertyDescriptor(window, 'showOpenFilePicker');
    Object.defineProperty(window, 'showOpenFilePicker', {
      configurable: true,
      value: () => Promise.resolve(files.map((file) => ({ getFile: () => Promise.resolve(file) }))),
    });
    try {
      render(<App />);
      const empty = await screen.findByTestId('home');
      await userEvent.click(within(empty).getByRole('button', { name: 'Open files' }));
      await waitFor(
        () => {
          expect(within(grid()).getAllByRole('option', { selected: true })).toHaveLength(2);
        },
        { timeout: 20_000 },
      );
      expect(shown()).toBe('home');
      expect(screen.getByTestId('home-combine')).toHaveTextContent('Combine 2 files');
    } finally {
      if (picker) Object.defineProperty(window, 'showOpenFilePicker', picker);
      else Reflect.deleteProperty(window, 'showOpenFilePicker');
    }
  }, 45_000);

  it('opens a single dropped file in Read', async () => {
    render(<App />);
    const data = new DataTransfer();
    data.items.add(await fixture(simpleUrl, 'simple-text.pdf'));
    drag(screen.getByTestId('app-shell'), 'drop', data);
    await waitFor(
      () => {
        expect(ws().documentOrder).toHaveLength(1);
      },
      { timeout: 20_000 },
    );
    expect(shown()).toBe('read');
    expect(screen.queryByTestId('home')).toBeNull();
  }, 45_000);

  it('is the empty state with no file open: the honest text, Open files and the shortcuts', async () => {
    render(<App />);
    useUiStore.getState().showHome();
    const home = await screen.findByTestId('home');
    expect(home).toHaveAttribute('data-variant', 'empty');
    expect(within(home).getByRole('heading', { name: 'Drop PDFs to start' })).toBeVisible();
    expect(within(home).getByText(/never uploaded/)).toBeVisible();
    expect(within(home).getByRole('button', { name: 'Open files' })).toBeVisible();
    expect(within(home).getByRole('button', { name: 'Search commands' })).toBeVisible();
    expect(within(home).getByRole('button', { name: 'Keyboard shortcuts' })).toBeVisible();
    expect(within(home).queryByRole('listbox')).toBeNull();
    expect(within(home).getAllByRole('button')).toHaveLength(3);
  });

  it('is reached from the palette in both languages', async () => {
    render(<App />);
    const command = commandRegistry.list().find((c) => c.id === 'view.home');
    expect(command?.title).toBe('Show Home');
    expect(command?.keywords).toEqual(expect.arrayContaining(['overview', 'ana ekran']));
    await userEvent.keyboard(`{${MOD}>}k{/${MOD}}`);
    const input = await screen.findByRole('combobox', { name: 'Search commands' });
    await userEvent.type(input, 'ana ekran');
    await waitFor(() => {
      expect(screen.getAllByRole('option')[0]).toHaveTextContent('Show Home');
    });
    await userEvent.keyboard('{Enter}');
    await waitFor(() => {
      expect(shown()).toBe('home');
    });
  });
});

/** A file handle as Chromium hands one out, with a scripted read permission. */
function fakeHandle(
  file: File,
  permission: { readonly query: PermissionState; readonly request?: PermissionState },
): RecentFileHandle & { requested: number } {
  const handle = {
    kind: 'file' as const,
    name: file.name,
    requested: 0,
    getFile: () => Promise.resolve(file),
    queryPermission: () => Promise.resolve(permission.query),
    requestPermission: () => {
      handle.requested += 1;
      return Promise.resolve(permission.request ?? permission.query);
    },
  };
  return handle;
}

describe('Recents on Home', () => {
  const recents = () => screen.getByRole('list', { name: 'Recent files' });
  const row = (name: string) =>
    within(recents()).getByRole('button', { name: new RegExp(`^${name.replace('.', '\\.')},`) });
  const recentNames = () =>
    within(recents())
      .getAllByRole('button')
      .filter((b) => b.hasAttribute('data-recent-id'))
      .map((b) => b.getAttribute('aria-label')?.split(',')[0]);
  let restorePicker: (() => void) | undefined;

  /** Replaces the Chromium file picker with one that "chooses" `files`. */
  function stubPicker(files: readonly File[]): { calls: number } {
    const state = { calls: 0 };
    const previous = Object.getOwnPropertyDescriptor(window, 'showOpenFilePicker');
    Object.defineProperty(window, 'showOpenFilePicker', {
      configurable: true,
      value: () => {
        state.calls += 1;
        return Promise.resolve(files.map((file) => fakeHandle(file, { query: 'granted' })));
      },
    });
    restorePicker = () => {
      if (previous) Object.defineProperty(window, 'showOpenFilePicker', previous);
      else Reflect.deleteProperty(window, 'showOpenFilePicker');
    };
    return state;
  }

  beforeEach(async () => {
    await page.viewport(1440, 900);
    setRecentsBackend(memoryRecentsBackend());
    resetWorkspace();
    useUiStore.setState({
      destination: 'document',
      viewMode: 'read',
      documentMode: {},
      lastView: {},
      homeSelection: [],
      homeAnchor: null,
      paletteOpen: false,
    });
  });
  afterEach(() => {
    restorePicker?.();
    restorePicker = undefined;
    resetWorkspace();
    setRecentsBackend(undefined);
  });

  it('shows nothing while there are no recents', async () => {
    render(<App />);
    const home = await screen.findByTestId('home');
    await loadRecents();
    expect(within(home).queryByRole('heading', { name: 'Recent' })).toBeNull();
    expect(within(home).queryByRole('list', { name: 'Recent files' })).toBeNull();
  });

  it('lists recents under the drop area with no file open: name, pages, size and time', async () => {
    const now = Date.now();
    await recordRecent({ name: 'report.pdf', size: 6246, pages: 6, now: now - 5 * 60_000 });
    await recordRecent({ name: 'invoice.pdf', size: 812, now: now - 86_400_000 - 3_600_000 });
    await recordRecent({ name: 'scan.pdf', size: 2_936_013, pages: 1, now: now - 10_000 });
    render(<App />);
    const home = await screen.findByTestId('home');
    expect(home).toHaveAttribute('data-variant', 'empty');
    const heading = await within(home).findByRole('heading', { name: 'Recent' });
    // Newest first.
    expect(recentNames()).toEqual(['scan.pdf', 'report.pdf', 'invoice.pdf']);
    expect(row('report.pdf')).toHaveAccessibleName(
      'report.pdf, 6 pages · 6.1 KB, 5 minutes ago, Open again…',
    );
    expect(row('invoice.pdf')).toHaveAccessibleName('invoice.pdf, 812 B, yesterday, Open again…');
    expect(row('scan.pdf')).toHaveTextContent('now');
    // One column: the open and drop card first, the recents under it (review F17).
    const drop = within(home).getByRole('heading', { name: 'Drop PDFs to start' });
    expect(heading.compareDocumentPosition(drop) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(within(home).getByRole('button', { name: 'Clear recents' })).toBeVisible();
  });

  it('records every open, lists it under the cards once closed, in the active language', async () => {
    await openOnHome('simple-text.pdf', 'rotated-pages.pdf');
    await waitFor(() => {
      expect(useRecentsStore.getState().entries.map((e) => e.name)).toEqual([
        'rotated-pages.pdf',
        'simple-text.pdf',
      ]);
    });
    // Open files are the cards above; Recents does not repeat them.
    expect(screen.queryByRole('list', { name: 'Recent files' })).toBeNull();
    const first = ws().documentOrder[0];
    if (first !== undefined) useWorkspaceStore.getState().closeDocument(first);
    // Closing keeps the entry.
    await waitFor(() => {
      expect(recentNames()).toEqual(['simple-text.pdf']);
    });
    expect(row('simple-text.pdf')).toHaveAccessibleName(/^simple-text\.pdf, 3 pages · .+, now/);
    // Under the cards.
    expect(
      grid().compareDocumentPosition(recents()) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    act(() => {
      setLocale('tr');
    });
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Son açılanlar' })).toBeVisible();
    });
    expect(
      within(screen.getByRole('list', { name: 'Son açılan dosyalar' })).getByRole('button', {
        name: /^simple-text\.pdf, 3 sayfa · .+, şimdi, Yeniden aç…$/,
      }),
    ).toBeVisible();
    act(() => {
      setLocale('en');
    });
  }, 45_000);

  it('moves with the arrows, removes with Delete and reaches the ⋯ menu with Right', async () => {
    for (const [i, name] of ['a.pdf', 'b.pdf', 'c.pdf'].entries()) {
      await recordRecent({ name, size: 100 + i, now: Date.now() - (3 - i) * 1000 });
    }
    render(<App />);
    await screen.findByRole('list', { name: 'Recent files' });
    expect(recentNames()).toEqual(['c.pdf', 'b.pdf', 'a.pdf']);
    // One tab stop: the first row.
    expect(row('c.pdf')).toHaveAttribute('tabindex', '0');
    expect(row('b.pdf')).toHaveAttribute('tabindex', '-1');
    row('c.pdf').focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(row('b.pdf')).toHaveFocus();
    expect(row('b.pdf')).toHaveAttribute('tabindex', '0');
    await userEvent.keyboard('{End}');
    expect(row('a.pdf')).toHaveFocus();
    await userEvent.keyboard('{Home}');
    expect(row('c.pdf')).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}{Delete}');
    await waitFor(() => {
      expect(recentNames()).toEqual(['c.pdf', 'a.pdf']);
    });
    expect(useAnnouncer.getState().message).toBe('b.pdf removed from recents');
    await waitFor(() => {
      expect(row('a.pdf')).toHaveFocus();
    });

    await userEvent.keyboard('{ArrowRight}');
    const more = screen.getByRole('button', { name: 'More actions for a.pdf' });
    expect(more).toHaveFocus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(row('a.pdf')).toHaveFocus();
  });

  it('removes an entry from its ⋯ menu', async () => {
    await recordRecent({ name: 'a.pdf', size: 1, now: Date.now() - 2000 });
    await recordRecent({ name: 'b.pdf', size: 2, now: Date.now() - 1000 });
    render(<App />);
    await screen.findByRole('list', { name: 'Recent files' });
    await userEvent.click(screen.getByRole('button', { name: 'More actions for a.pdf' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Remove from recents' }));
    await waitFor(() => {
      expect(recentNames()).toEqual(['b.pdf']);
    });
    expect(useRecentsStore.getState().entries.map((e) => e.name)).toEqual(['b.pdf']);
  });

  it('clears every entry with "Clear recents", and the palette has the command', async () => {
    await recordRecent({ name: 'a.pdf', size: 1 });
    await recordRecent({ name: 'b.pdf', size: 2 });
    render(<App />);
    await screen.findByRole('list', { name: 'Recent files' });
    await userEvent.click(screen.getByRole('button', { name: 'Clear recents' }));
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Recent' })).toBeNull();
    });
    expect(useAnnouncer.getState().message).toBe('Recents cleared');

    await recordRecent({ name: 'c.pdf', size: 3 });
    await screen.findByRole('list', { name: 'Recent files' });
    const command = commandRegistry.list().find((c) => c.id === 'file.clearRecents');
    expect(command?.title).toBe('Clear recents');
    expect(command?.keywords).toEqual(expect.arrayContaining(['history', 'geçmiş']));
    await act(async () => {
      await commandRegistry.execute('file.clearRecents');
    });
    expect(screen.queryByRole('list', { name: 'Recent files' })).toBeNull();
  });

  it('says so, on Home and out loud, when the stored copy cannot be cleared', async () => {
    // Review F6: a stored database that refuses to clear (the only backend, no fallback).
    const memory = memoryRecentsBackend();
    let refuse = true;
    setRecentsBackend(
      {
        ...memory,
        clear: () => (refuse ? Promise.reject(new Error('InvalidStateError')) : memory.clear()),
      },
      { memoryFallback: false },
    );
    await recordRecent({ name: 'a.pdf', size: 1 });
    render(<App />);
    await screen.findByRole('list', { name: 'Recent files' });
    await userEvent.click(screen.getByRole('button', { name: 'Clear recents' }));
    const message =
      'Recents were cleared from the list, but the copy kept on this device could not be deleted. Try Clear recents again, or clear this site’s data in your browser.';
    const note = await screen.findByTestId('recent-clear-failed');
    expect(note).toBeVisible();
    expect(note).toHaveTextContent(message);
    expect(screen.queryByRole('list', { name: 'Recent files' })).toBeNull();
    expect(useAnnouncer.getState().alert).toBe(message);
    // Clear again, now that the database lets it: the section goes.
    refuse = false;
    await userEvent.click(screen.getByRole('button', { name: 'Clear recents' }));
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Recent' })).toBeNull();
    });
    expect(useAnnouncer.getState().message).toBe('Recents cleared');
    expect(await memory.list()).toEqual([]);
  });

  it('reopens through a kept handle, in Read, asking for permission within the click', async () => {
    const file = await fixture(simpleUrl, 'simple-text.pdf');
    const handle = fakeHandle(file, { query: 'prompt', request: 'granted' });
    // Stored by an earlier visit: after a reload Chromium asks again before reading.
    setRecentsBackend(
      memoryRecentsBackend([
        { id: 'kept', name: file.name, size: file.size, pages: 3, openedAt: 1, handle },
      ]),
    );
    render(<App />);
    await screen.findByRole('list', { name: 'Recent files' });
    if (!storedHandlesReadable()) {
      // Chromium 153 crashes on reading a stored handle back, so the row goes through the
      // file dialog instead (files/recents.ts).
      expect(row('simple-text.pdf')).toHaveAccessibleName(/, Open again…$/);
      const picker = stubPicker([file]);
      await userEvent.click(row('simple-text.pdf'));
      await waitFor(() => {
        expect(ws().documentOrder).toHaveLength(1);
      });
      expect(picker.calls).toBe(1);
      expect(handle.requested).toBe(0);
      return;
    }
    await waitFor(() => {
      expect(row('simple-text.pdf')).toHaveAccessibleName(/, Needs permission$/);
    });
    await userEvent.click(row('simple-text.pdf'));
    await waitFor(() => {
      expect(ws().documentOrder).toHaveLength(1);
    });
    expect(handle.requested).toBe(1);
    expect(titleOf(ws().activeDocument)).toBe('simple-text');
    expect(shown()).toBe('read');
    // Still one entry, now on top, with its handle.
    await waitFor(() => {
      expect(useRecentsStore.getState().entries).toHaveLength(1);
    });
    expect(useRecentsStore.getState().entries[0]?.handle).toBe(handle);
  }, 45_000);

  it('turns a row to "Open again…" when permission is denied, then opens the file dialog', async () => {
    const file = await fixture(simpleUrl, 'simple-text.pdf');
    const handle = fakeHandle(file, { query: 'prompt', request: 'denied' });
    await recordRecent({ name: file.name, size: file.size, handle, now: Date.now() });
    render(<App />);
    await screen.findByRole('list', { name: 'Recent files' });
    const picker = stubPicker([file]);

    await userEvent.click(row('simple-text.pdf'));
    const note = await screen.findByTestId('recent-note');
    expect(note).toHaveTextContent(
      '“simple-text.pdf” could not be reopened: it was moved, or access was not given. Open again… to choose it.',
    );
    expect(row('simple-text.pdf')).toHaveAccessibleName(/, Open again…$/);
    expect(ws().documentOrder).toHaveLength(0);
    expect(picker.calls).toBe(0);

    // The second click goes through the file dialog.
    await userEvent.click(row('simple-text.pdf'));
    await waitFor(() => {
      expect(ws().documentOrder).toHaveLength(1);
    });
    expect(picker.calls).toBe(1);
    expect(shown()).toBe('read');
  }, 45_000);

  it('opens the file dialog for an entry without a handle and says so in one line', async () => {
    const file = await fixture(simpleUrl, 'simple-text.pdf');
    await recordRecent({ name: file.name, size: file.size, now: Date.now() });
    render(<App />);
    await screen.findByRole('list', { name: 'Recent files' });
    let release: (files: unknown[]) => void = () => undefined;
    const previous = Object.getOwnPropertyDescriptor(window, 'showOpenFilePicker');
    Object.defineProperty(window, 'showOpenFilePicker', {
      configurable: true,
      value: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    restorePicker = () => {
      if (previous) Object.defineProperty(window, 'showOpenFilePicker', previous);
      else Reflect.deleteProperty(window, 'showOpenFilePicker');
    };

    await userEvent.click(row('simple-text.pdf'));
    // While the dialog is open, the line says why it opened.
    const note = await screen.findByTestId('recent-note');
    expect(note).toHaveTextContent(
      'This browser doesn’t keep access to files: choose “simple-text.pdf” in the file dialog.',
    );
    expect(useAnnouncer.getState().message).toBe(note.textContent);
    act(() => release([fakeHandle(file, { query: 'granted' })]));
    await waitFor(() => {
      expect(ws().documentOrder).toHaveLength(1);
    });
    await waitFor(() => {
      expect(screen.queryByTestId('recent-note')).toBeNull();
    });
    // The picked file came with a handle: the entry keeps it from now on.
    await waitFor(() => {
      expect(useRecentsStore.getState().entries[0]?.handle).toBeDefined();
    });
    expect(useRecentsStore.getState().entries).toHaveLength(1);
  }, 45_000);
});

async function pageCount(title: string): Promise<number> {
  const name = `${title}.pdf`;
  const { PDFDocument } = await import('@cantoo/pdf-lib');
  const bytes = await (await fetch(FILES[name] ?? '')).arrayBuffer();
  return (await PDFDocument.load(bytes)).getPageCount();
}
