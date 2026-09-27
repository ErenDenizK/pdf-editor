/**
 * Section operations on real PDFs (Vitest browser mode, Chromium): split every N pages and
 * by ranges through the dialog, merge into another document from the section menu, merge
 * all open documents in a chosen order, interleave in duplex order, rename in place, and
 * images as pages followed by an export whose page count includes the image pages.
 */
import '../styles/tokens.css';
import '../styles/reset.css';
import '../styles/global.css';

import { PDFDocument } from '@cantoo/pdf-lib';
import type { DocumentId, Workspace } from '@pdf-editor/document-model';
import { render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';

import outlineUrl from '../../../../test/fixtures/outline-named-dests.pdf?url';
import rotatedUrl from '../../../../test/fixtures/rotated-pages.pdf?url';
import simpleUrl from '../../../../test/fixtures/simple-text.pdf?url';
import { App } from '../app';
import { openDocuments } from '../commands/app-commands';
import { commandRegistry } from '../commands/registry';
import { prepareExport } from '../export/export-service';
import { useSelectionStore } from '../state/selection-store';
import { useUiStore } from '../state/ui-store';
import { resetWorkspace, useWorkspaceStore } from '../state/workspace-store';
import { closeOperationDialog } from './operation-dialogs-store';
import { runSectionCommand } from './section-menu';
import { insertImagesInto } from './section-operations';

async function fixture(url: string, name: string): Promise<File> {
  const bytes = await (await fetch(url)).arrayBuffer();
  return new File([bytes], name, { type: 'application/pdf' });
}

async function generatedImage(type: string, width: number, height: number, name: string) {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('no 2d context');
  context.fillStyle = '#2a6';
  context.fillRect(0, 0, width, height);
  context.fillStyle = '#fff';
  context.fillRect(width / 4, height / 4, width / 2, height / 2);
  return new File([await canvas.convertToBlob({ type })], name, { type });
}

const model = () => useWorkspaceStore.getState();
const ws = (): Workspace => model().workspace;
const titles = () => ws().documentOrder.map((id) => ws().documents[id]?.title);
const lastLabel = () => model().history.present.label;

/** Source page (file stem + 1-based index) of every page of a document. */
function pageNames(id: DocumentId | undefined): string[] {
  const doc = id === undefined ? undefined : ws().documents[id];
  return (doc?.pages ?? []).map((p) => {
    if (p.ref.kind !== 'source') return p.ref.kind;
    const name = ws().sources[p.ref.source]?.name.replace(/\.pdf$/, '') ?? '?';
    return `${name[0] ?? '?'}${p.ref.index + 1}`;
  });
}

async function open(...files: [string, string][]) {
  render(<App />);
  await openDocuments(await Promise.all(files.map(([url, name]) => fixture(url, name))));
  const order = ws().documentOrder;
  useUiStore.getState().pinToArrange(order);
  useUiStore.getState().setViewMode('arrange');
  expect(await screen.findAllByRole('grid')).toHaveLength(order.length);
  return order;
}

async function openSectionMenu(title: string) {
  await userEvent.click(screen.getByRole('button', { name: `${title} actions` }));
  return screen.findByTestId('section-menu');
}

describe('section operations', () => {
  beforeEach(async () => {
    await page.viewport(1440, 900);
    resetWorkspace();
    closeOperationDialog();
    useSelectionStore.getState().apply({ selected: new Set(), anchor: null, focused: null });
    useUiStore.setState({
      viewMode: 'read',
      arrangePinned: [],
      arrangeCollapsed: [],
      paletteOpen: false,
      arrangeSize: 1,
      renaming: null,
    });
  });
  afterEach(() => {
    closeOperationDialog();
    resetWorkspace();
  });

  it('splits every N pages from the section menu, with a live preview', async () => {
    await open([outlineUrl, 'outline-named-dests.pdf']);
    const menu = await openSectionMenu('outline-named-dests');
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Split…' }));
    const dialog = await screen.findByTestId('split-dialog');
    await waitFor(() => {
      expect(
        within(dialog).getByRole('heading', { name: 'Split outline-named-dests' }),
      ).toBeVisible();
    });
    // Default: two parts. The outline option is available (the file has bookmarks); the
    // selection option is not (nothing selected).
    expect(within(dialog).getByTestId('split-preview')).toHaveTextContent(
      'Creates 2 documents: 3, 3 pages',
    );
    expect(within(dialog).getByRole('radio', { name: /At top-level bookmarks/ })).toBeEnabled();
    expect(within(dialog).getByRole('radio', { name: /Before each selected page/ })).toBeDisabled();

    // Ranges: inline errors, then a valid list with pages left behind.
    await userEvent.click(within(dialog).getByRole('radio', { name: /Page ranges/ }));
    const ranges = within(dialog).getByTestId('split-ranges');
    await userEvent.type(ranges, '1-3, 9, 4-2');
    expect(within(dialog).getByTestId('split-range-errors')).toHaveTextContent(
      '“9”: the document has 6 pages.“4-2”: the range runs backwards.',
    );
    expect(within(dialog).getByRole('button', { name: 'Split' })).toBeDisabled();
    await userEvent.clear(ranges);
    await userEvent.type(ranges, '1-3, 5');
    expect(within(dialog).getByTestId('split-preview')).toHaveTextContent(
      'Creates 2 documents: 3, 1 pages2 pages stay in outline-named-dests.',
    );

    // Every 4 pages.
    const every = within(dialog).getByRole('spinbutton', { name: 'Pages per document' });
    await userEvent.clear(every);
    await userEvent.type(every, '4');
    expect(within(dialog).getByTestId('split-preview')).toHaveTextContent(
      'Creates 2 documents: 4, 2 pages',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Split' }));

    await waitFor(() => {
      expect(titles()).toEqual(['outline-named-dests (1 of 2)', 'outline-named-dests (2 of 2)']);
    });
    expect(ws().documentOrder.map((id) => ws().documents[id]?.pages.length)).toEqual([4, 2]);
    expect(lastLabel()).toBe('Split outline-named-dests into 2');
    await waitFor(() => {
      expect(screen.queryByTestId('split-dialog')).toBeNull();
    });
    // Both parts stay on the light table.
    expect(await screen.findAllByRole('grid')).toHaveLength(2);

    await userEvent.keyboard('{Control>}z{/Control}');
    await waitFor(() => {
      expect(titles()).toEqual(['outline-named-dests']);
    });
  }, 40_000);

  it('merges a document into another from the section menu, and hints when it cannot', async () => {
    const [simple, rotated] = await open(
      [simpleUrl, 'simple-text.pdf'],
      [rotatedUrl, 'rotated-pages.pdf'],
    );
    let menu = await openSectionMenu('simple-text');
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Merge into…' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'rotated-pages' }));

    await waitFor(() => {
      expect(titles()).toEqual(['rotated-pages']);
    });
    const merged = ws().documentOrder[0];
    expect(pageNames(merged)).toEqual(['r1', 'r2', 'r3', 'r4', 's1', 's2', 's3']);
    expect(lastLabel()).toBe('Merge simple-text into rotated-pages');
    expect(ws().documents[simple ?? ('' as DocumentId)]).toBeUndefined();
    expect(ws().documents[rotated ?? ('' as DocumentId)]).toBeUndefined();

    // Only one document left: the item is disabled and says why.
    await userEvent.keyboard('{Escape}');
    menu = await openSectionMenu('rotated-pages');
    const item = within(menu).getByRole('menuitem', { name: /Merge into…/ });
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(item).toHaveTextContent('Needs another open document');
  }, 40_000);

  it('merges all open documents in the order chosen in the dialog', async () => {
    await open([simpleUrl, 'simple-text.pdf'], [rotatedUrl, 'rotated-pages.pdf']);
    await commandRegistry.execute('documents.mergeAll');
    const dialog = await screen.findByTestId('merge-all-dialog');
    const rows = () =>
      within(dialog)
        .getAllByTestId('merge-row')
        .map((r) => r.textContent);
    expect(rows()[0]).toContain('simple-text');
    expect(within(dialog).getByRole('button', { name: 'Move simple-text up' })).toBeDisabled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Move rotated-pages up' }));
    expect(rows()[0]).toContain('rotated-pages');
    expect(within(dialog).getByRole('status')).toHaveTextContent(
      'Creates one document from 2 documents with 7 pages.',
    );
    const name = within(dialog).getByRole('textbox', { name: 'Title of the merged document' });
    await userEvent.clear(name);
    expect(within(dialog).getByText('The title cannot be empty.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Merge' })).toBeDisabled();
    await userEvent.type(name, 'Combined');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Merge' }));

    await waitFor(() => {
      expect(titles()).toEqual(['Combined']);
    });
    const merged = ws().documentOrder[0];
    expect(pageNames(merged)).toEqual(['r1', 'r2', 'r3', 'r4', 's1', 's2', 's3']);
    expect(lastLabel()).toBe('Merge 2 documents');
    // Both sources are still open in the engine: the merged document exports.
    if (merged === undefined) throw new Error('no merged document');
    const result = await prepareExport(merged);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.verification.ok).toBe(true);
    expect(result.value.pageCount).toBe(7);
  }, 40_000);

  it('interleaves two documents in duplex order (second document reversed)', async () => {
    const [simple] = await open([simpleUrl, 'simple-text.pdf'], [rotatedUrl, 'rotated-pages.pdf']);
    if (simple === undefined) throw new Error('not opened');
    await runSectionCommand('section.interleave', simple);
    const dialog = await screen.findByTestId('interleave-dialog');
    expect(within(dialog).getByRole('radio', { name: /rotated-pages/ })).toBeChecked();
    await userEvent.click(within(dialog).getByRole('radio', { name: /Duplex scan/ }));
    const preview = within(dialog).getByTestId('interleave-preview');
    expect(
      within(preview)
        .getAllByRole('listitem')
        .map((item) => item.getAttribute('aria-label') ?? item.textContent),
    ).toEqual([
      'simple-text, page 1',
      'rotated-pages, page 4',
      'simple-text, page 2',
      'rotated-pages, page 3',
      'simple-text, page 3',
      'rotated-pages, page 2',
      '+1 more',
    ]);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Interleave' }));

    await waitFor(() => {
      expect(titles()).toEqual(['simple-text + rotated-pages']);
    });
    expect(pageNames(ws().documentOrder[0])).toEqual(['s1', 'r4', 's2', 'r3', 's3', 'r2', 'r1']);
    expect(lastLabel()).toBe('Interleave simple-text with rotated-pages');
  }, 40_000);

  it('renames in place from the section header and the tab, validating the title', async () => {
    await open([simpleUrl, 'simple-text.pdf']);
    await userEvent.dblClick(screen.getByRole('heading', { name: 'simple-text' }));
    const input = await screen.findByRole('textbox', { name: 'Document title' });
    expect(input).toHaveFocus();
    await userEvent.clear(input);
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('The title cannot be empty.');
    await userEvent.type(input, 'Contract');
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByRole('tab', { name: 'Contract' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Contract' })).toBeVisible();
    expect(lastLabel()).toBe('Rename to Contract');

    // F2 on the focused tab; Escape cancels.
    const tab = screen.getByRole('tab', { name: 'Contract' });
    tab.focus();
    await userEvent.keyboard('{F2}');
    const tabInput = await screen.findByRole('textbox', { name: 'Document title' });
    await userEvent.type(tabInput, 'Other');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Contract' })).toHaveFocus();
    });
    expect(lastLabel()).toBe('Rename to Contract');
  }, 40_000);

  it('copies selected pages to a new document, leaving the originals in place', async () => {
    const [simple] = await open([simpleUrl, 'simple-text.pdf']);
    if (simple === undefined) throw new Error('not opened');
    const cells = within(screen.getByRole('grid', { name: 'simple-text' })).getAllByRole(
      'gridcell',
    );
    await userEvent.click(cells[0]!);
    await userEvent.click(cells[2]!, { modifiers: ['Shift'] });
    const past = model().history.past.length;
    await commandRegistry.execute('pages.copyToNew');
    await waitFor(() => {
      expect(titles()).toEqual(['simple-text', 'simple-text (copy)']);
    });
    expect(pageNames(simple)).toEqual(['s1', 's2', 's3']);
    expect(pageNames(ws().documentOrder[1])).toEqual(['s1', 's2', 's3']);
    expect(model().history.past.length).toBe(past + 1);
    expect(lastLabel()).toBe('Copy 3 pages to new document');
    expect(commandRegistry.get('pages.extract')?.title).toBe('Move pages to new document');
  }, 40_000);

  it('inserts images as pages (WebP re-encoded) and exports them', async () => {
    const [simple] = await open([simpleUrl, 'simple-text.pdf']);
    if (simple === undefined) throw new Error('not opened');
    const past = model().history.past.length;

    // One image within A4: no question, page size = pixels at 72 dpi.
    const png = await generatedImage('image/png', 200, 100, 'generated.png');
    const placed = await insertImagesInto(simple, [png], 1);
    expect(placed).toHaveLength(1);
    expect(model().history.past.length).toBe(past + 1);
    expect(lastLabel()).toBe('Insert 1 page from generated.png');
    const imagePage = ws().documents[simple]?.pages[1];
    expect(imagePage?.ref).toMatchObject({ kind: 'image', size: { width: 200, height: 100 } });
    expect(
      within(screen.getByRole('grid', { name: 'simple-text' })).getAllByRole('gridcell')[1],
    ).toHaveAccessibleName('Page 2 of 4, from generated.png');

    // Two images: the size question; a wide WebP is stored as PNG.
    const pending = insertImagesInto(simple, [
      await generatedImage('image/webp', 1200, 600, 'wide.webp'),
      await generatedImage('image/jpeg', 300, 400, 'photo.jpg'),
    ]);
    const question = await screen.findByTestId('image-size-dialog');
    await waitFor(() => {
      expect(within(question).getByRole('heading', { name: 'Insert 2 images' })).toBeVisible();
    });
    expect(within(question).getByRole('radio', { name: /Fit to A4 width/ })).toBeChecked();
    await userEvent.click(within(question).getByRole('button', { name: 'Insert' }));
    expect(await pending).toHaveLength(2);
    const doc = ws().documents[simple];
    expect(doc?.pages).toHaveLength(6);
    const wide = doc?.pages[4]?.ref;
    if (wide?.kind !== 'image') throw new Error('expected an image page');
    expect(wide.size.width).toBeCloseTo(595.28, 1);
    expect(model().blobs[wide.blob]?.type).toBe('image/png');
    expect(lastLabel()).toBe('Insert 2 pages from 2 files');

    // The export path gets the blobs; the verified output has every page.
    const result = await prepareExport(simple);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.verification.ok).toBe(true);
    expect(result.value.pageCount).toBe(6);
    const pdf = await PDFDocument.load(result.value.bytes, { updateMetadata: false });
    expect(pdf.getPageCount()).toBe(6);
    const size = pdf.getPage(1).getSize();
    expect([Math.round(size.width), Math.round(size.height)]).toEqual([200, 100]);
  }, 60_000);
});
