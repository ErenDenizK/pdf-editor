/**
 * "Resize pages…" on real PDFs (Vitest browser mode, Chromium): the dialog from the
 * palette command and the section menu, its preview and summary, keyboard use of the
 * anchor grid, the committed history entry (and undo), the resized light-table cell, and
 * an export whose verified page sizes are the new ones.
 */
import '../styles/tokens.css';
import '../styles/reset.css';
import '../styles/global.css';

import { PDFDocument } from '@cantoo/pdf-lib';
import {
  type DocumentId,
  PAPER_SIZES,
  pageDisplaySize,
  type Workspace,
} from '@pdf-editor/document-model';
import { render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';

import mixedUrl from '../../../../test/fixtures/mixed-sizes.pdf?url';
import rotatedUrl from '../../../../test/fixtures/rotated-pages.pdf?url';
import { App } from '../app';
import { openDocuments } from '../commands/app-commands';
import { commandRegistry } from '../commands/registry';
import { prepareExport } from '../export/export-service';
import { useSelectionStore } from '../state/selection-store';
import { useUiStore } from '../state/ui-store';
import { resetWorkspace, useWorkspaceStore } from '../state/workspace-store';
import { closeOperationDialog } from './operation-dialogs-store';
import { fromUnit, sizeLabel, toUnit } from './ResizeDialog';
import { runSectionCommand } from './section-menu';

async function fixture(url: string, name: string): Promise<File> {
  const bytes = await (await fetch(url)).arrayBuffer();
  return new File([bytes], name, { type: 'application/pdf' });
}

const model = () => useWorkspaceStore.getState();
const ws = (): Workspace => model().workspace;
const lastLabel = () => model().history.present.label;
const A4 = PAPER_SIZES.a4;

async function open(url: string, name: string): Promise<DocumentId> {
  render(<App />);
  await openDocuments([await fixture(url, name)]);
  const id = ws().documentOrder[0];
  if (id === undefined) throw new Error('not opened');
  useUiStore.getState().pinToArrange([id]);
  useUiStore.getState().setViewMode('arrange');
  expect(await screen.findAllByRole('grid')).toHaveLength(1);
  return id;
}

function shownSizes(id: DocumentId): [number, number][] {
  const doc = ws().documents[id];
  return (doc?.pages ?? []).map((p) => {
    const size = pageDisplaySize(ws(), p);
    return [Math.round(size.width), Math.round(size.height)];
  });
}

describe('units and labels', () => {
  it('converts and names sizes', () => {
    expect(toUnit(A4.width, 'mm')).toBe(210);
    expect(toUnit(612, 'in')).toBe(8.5);
    expect(fromUnit(297, 'mm')).toBeCloseTo(841.89, 1);
    expect(sizeLabel(A4, 'mm')).toBe('A4 (210 × 297 mm)');
    expect(sizeLabel({ width: 792, height: 612 }, 'in')).toBe('Letter (11 × 8.5 in)');
    expect(sizeLabel({ width: 200, height: 300 }, 'pt')).toBe('200 × 300 pt');
  });
});

describe('resize pages dialog', () => {
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

  it('resizes the selected page to Letter (fit), shows it in the cell, undoes', async () => {
    const id = await open(rotatedUrl, 'rotated-pages.pdf');
    const doc = ws().documents[id];
    const second = doc?.pages[1];
    if (second === undefined) throw new Error('no page');
    useSelectionStore
      .getState()
      .apply({ selected: new Set([second.id]), anchor: second.id, focused: second.id });
    await commandRegistry.execute('pages.resize');
    const dialog = await screen.findByTestId('resize-dialog');
    await waitFor(() => {
      expect(within(dialog).getByRole('heading', { name: 'Resize pages' })).toBeVisible();
    });
    // Page 2 shows landscape (/Rotate 90): the dialog starts in landscape, A4, Fit.
    expect(within(dialog).getByRole('radio', { name: 'Landscape' })).toBeChecked();
    expect(within(dialog).getByRole('radio', { name: /^Fit/ })).toBeChecked();
    expect(within(dialog).getByRole('radio', { name: 'Selected pages (1)' })).toBeChecked();
    expect(
      within(dialog).getByRole('radio', { name: 'All pages of rotated-pages (4)' }),
    ).toBeEnabled();
    // Every A4 page, in either orientation.
    expect(
      within(dialog).getByRole('radio', { name: 'Every page sized A4 (297 × 210 mm) (4)' }),
    ).toBeEnabled();
    expect(within(dialog).getByTestId('resize-summary')).toHaveTextContent(
      '1 page will become A4 (297 × 210 mm)',
    );

    // Custom size in millimetres; the summary follows.
    const width = within(dialog).getByTestId('resize-width');
    await userEvent.clear(width);
    await userEvent.type(width, '300');
    expect(within(dialog).getByTestId('resize-preset')).toHaveValue('custom');
    expect(within(dialog).getByTestId('resize-summary')).toHaveTextContent(
      '1 page will become 300 × 210 mm',
    );
    // The page is A4 already: take Letter (landscape, like the page).
    await userEvent.selectOptions(within(dialog).getByTestId('resize-preset'), 'letter');
    expect(within(dialog).getByTestId('resize-summary')).toHaveTextContent(
      '1 page will become Letter (279.4 × 215.9 mm)',
    );

    // Anchor grid: keyboard moves in two dimensions.
    const center = within(dialog).getByRole('radio', { name: 'Center' });
    expect(center).toHaveAttribute('aria-checked', 'true');
    center.focus();
    await userEvent.keyboard('{ArrowUp}{ArrowLeft}');
    expect(within(dialog).getByRole('radio', { name: 'Top left' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(within(dialog).getByRole('radio', { name: 'Top left' })).toHaveFocus();
    // Stretch disables the anchor.
    await userEvent.click(within(dialog).getByRole('radio', { name: /^Scale/ }));
    await userEvent.click(within(dialog).getByRole('checkbox', { name: /Stretch/ }));
    expect(within(dialog).getByTestId('resize-anchor')).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(within(dialog).getByRole('radio', { name: /^Fit/ }));

    const sheet = within(dialog).getByTestId('resize-preview-sheet');
    const box = sheet.getBoundingClientRect();
    expect(box.width / box.height).toBeCloseTo(792 / 612, 1);
    expect(sheet.querySelector('[data-resized]')).not.toBeNull();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Resize' }));
    await waitFor(() => expect(screen.queryByTestId('resize-dialog')).toBeNull());
    expect(lastLabel()).toBe('Resize 1 page');
    expect(shownSizes(id)[1]).toEqual([792, 612]);
    const resized = ws().documents[id]?.pages[1]?.resize;
    // Stored unrotated: A4 portrait, the displayed top-left is the unrotated bottom-left.
    expect(resized).toMatchObject({ mode: 'fit', anchor: 'bottom-left' });
    const cell = document.querySelector(`[data-page-id="${second.id}"] [data-thumb]`);
    await waitFor(() => expect(cell?.querySelector('[data-resized]')).not.toBeNull());
    const thumb = cell?.getBoundingClientRect();
    expect((thumb?.width ?? 0) / (thumb?.height ?? 1)).toBeCloseTo(792 / 612, 1);

    model().undo();
    expect(ws().documents[id]?.pages[1]?.resize).toBeUndefined();
  }, 40_000);

  it('resizes all pages of a section to A4 and exports the new sizes', async () => {
    const id = await open(mixedUrl, 'mixed-sizes.pdf');
    await runSectionCommand('section.resize', id);
    const dialog = await screen.findByTestId('resize-dialog');
    expect(
      within(dialog).getByRole('radio', { name: 'All pages of mixed-sizes (5)' }),
    ).toBeChecked();
    // Keep each page's orientation (default): landscape pages become A4 landscape.
    expect(
      within(dialog).getByRole('checkbox', { name: /Keep each page’s orientation/ }),
    ).toBeChecked();
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Portrait' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Resize' }));
    await waitFor(() => expect(screen.queryByTestId('resize-dialog')).toBeNull());
    expect(lastLabel()).toBe('Resize 5 pages');
    // A4 portrait, Letter portrait, landscape (/Rotate 90), landscape (MediaBox), square.
    expect(shownSizes(id)).toEqual([
      [595, 842],
      [595, 842],
      [842, 595],
      [842, 595],
      [595, 842],
    ]);
    const result = await prepareExport(id);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.verification.ok).toBe(true);
    const out = await PDFDocument.load(result.value.bytes, { updateMetadata: false });
    const sizes = out.getPages().map((p) => {
      const quarter = p.getRotation().angle % 180 !== 0;
      const [w, h] = [p.getWidth(), p.getHeight()];
      return quarter ? [Math.round(h), Math.round(w)] : [Math.round(w), Math.round(h)];
    });
    expect(sizes).toEqual(shownSizes(id));
  }, 40_000);
});
