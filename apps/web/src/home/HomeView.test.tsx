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
    expect(
      within(dialog).getByRole('textbox', { name: 'Title of the merged document' }),
    ).toHaveValue('mixed-sizes');

    // Confirming merges and opens the new document in Read.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Merge' }));
    await waitFor(() => {
      expect(shown()).toBe('read');
    });
    expect(
      ws()
        .documentOrder.map((id) => titleOf(id))
        .sort(),
    ).toEqual(['mixed-sizes', 'rotated-pages']);
    expect(ws().documents[ws().activeDocument ?? ('' as DocumentId)]?.pages).toHaveLength(
      (await pageCount('mixed-sizes')) + 3,
    );
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

async function pageCount(title: string): Promise<number> {
  const name = `${title}.pdf`;
  const { PDFDocument } = await import('@cantoo/pdf-lib');
  const bytes = await (await fetch(FILES[name] ?? '')).arrayBuffer();
  return (await PDFDocument.load(bytes)).getPageCount();
}
