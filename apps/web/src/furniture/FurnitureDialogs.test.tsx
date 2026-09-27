/**
 * Furniture dialogs in the real app (Vitest browser mode, Chromium): the page-number
 * dialog previews on the pages while it is open, Cancel discards, Apply commits one
 * history entry; clicking the furniture in Read reopens its dialog; Remove is one entry.
 */
import '../styles/tokens.css';
import '../styles/reset.css';
import '../styles/global.css';

import { render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';

import rotatedUrl from '../../../../test/fixtures/rotated-pages.pdf?url';
import simpleUrl from '../../../../test/fixtures/simple-text.pdf?url';
import { App } from '../app';
import { openDocuments } from '../commands/app-commands';
import { commandRegistry } from '../commands/registry';
import { useUiStore } from '../state/ui-store';
import { resetWorkspace, useWorkspaceStore } from '../state/workspace-store';
import { lastBatesNumber } from './FurnitureDialogs';
import { furnitureOf } from './furniture-model';
import { closeFurnitureDialog, useFurnitureStore } from './furniture-store';

const model = () => useWorkspaceStore.getState();
const activeDoc = () => {
  const ws = model().workspace;
  return ws.activeDocument === undefined ? undefined : ws.documents[ws.activeDocument];
};

/** Segmented radios hide the input; the label is what users click. */
const segment = (input: HTMLElement) => input.closest('label') as HTMLElement;

/** Texts the furniture layer draws on the first page. */
function drawnTexts(): string[] {
  const first = document.querySelector('[data-page-index="0"] [data-furniture-layer]');
  return [...(first?.querySelectorAll('[data-furniture-text]') ?? [])].map(
    (g) => g.getAttribute('data-furniture-text') ?? '',
  );
}

describe('furniture dialogs', () => {
  beforeEach(async () => {
    await page.viewport(1440, 900);
    resetWorkspace();
    closeFurnitureDialog();
    useUiStore.setState({ viewMode: 'read', paletteOpen: false });
  });
  afterEach(() => {
    closeFurnitureDialog();
    resetWorkspace();
  });

  it('previews page numbers live, discards on Cancel and commits one entry on Apply', async () => {
    render(<App />);
    const bytes = await (await fetch(rotatedUrl)).arrayBuffer();
    await openDocuments([new File([bytes], 'rotated-pages.pdf', { type: 'application/pdf' })]);
    await screen.findByRole('tab', { name: 'rotated-pages' });
    const pastBefore = model().history.past.length;

    // The Document menu lists the furniture commands.
    await userEvent.click(screen.getByTestId('document-menu'));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Page numbers…' }));
    let dialog = await screen.findByTestId('furniture-dialog-page-numbers');
    await waitFor(() => expect(drawnTexts()).toEqual(['1']));
    await userEvent.click(segment(within(dialog).getByTestId('preset-page-of')));
    await waitFor(() => expect(drawnTexts()).toEqual(['Page 1 of 4']));
    // Nothing is in the model yet.
    expect(activeDoc()?.pages[0]?.overlays).toEqual([]);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(drawnTexts()).toEqual([]));
    expect(model().history.past.length).toBe(pastBefore);

    await commandRegistry.execute('document.pageNumbers');
    dialog = await screen.findByTestId('furniture-dialog-page-numbers');
    await userEvent.click(segment(within(dialog).getByTestId('preset-slash')));
    await userEvent.selectOptions(within(dialog).getByTestId('furniture-range'), 'skip-first');
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Top right' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(useFurnitureStore.getState().dialog).toBeNull());
    await waitFor(() => expect(screen.queryByTestId('furniture-dialog-page-numbers')).toBeNull());
    expect(model().history.past.length).toBe(pastBefore + 1);
    expect(model().history.present.label).toBe('Page numbers');
    const doc = activeDoc();
    expect(doc && furnitureOf(doc, 'page-numbers')).toMatchObject([
      { template: '{page} / {pages}', anchor: 'top-right', pages: { from: 2 }, startNumber: 2 },
    ]);
    // Skipped on the cover.
    expect(drawnTexts()).toEqual([]);

    // Clicking the number on page 2 opens its dialog, prefilled; Remove is one entry.
    const second = document.querySelector('[data-page-index="1"]') as HTMLElement;
    second.scrollIntoView();
    let text: SVGTextElement | null = null;
    await waitFor(() => {
      text = second.querySelector('[data-furniture-layer] text');
      expect(text).not.toBeNull();
    });
    const box = (text as unknown as SVGTextElement).getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    // A real click at that point (dispatched: the test iframe may be scaled, which offsets
    // pointer coordinates given to userEvent).
    const target = document.elementFromPoint(x, y) as HTMLElement;
    target.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }),
    );
    await waitFor(() => expect(useFurnitureStore.getState().dialog?.kind).toBe('page-numbers'));
    dialog = await screen.findByTestId('furniture-dialog-page-numbers');
    expect(within(dialog).getByTestId('preset-slash')).toBeChecked();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(useFurnitureStore.getState().dialog).toBeNull());
    expect(model().history.past.length).toBe(pastBefore + 2);
    expect(activeDoc()?.pages.every((p) => p.overlays.length === 0)).toBe(true);
  });

  it('numbers several documents with one Bates counter and remembers the last number', async () => {
    localStorage.removeItem('pdf-editor:bates-last-number');
    render(<App />);
    const file = async (url: string, name: string) =>
      new File([await (await fetch(url)).arrayBuffer()], name, { type: 'application/pdf' });
    await openDocuments([
      await file(rotatedUrl, 'rotated-pages.pdf'),
      await file(simpleUrl, 'simple-text.pdf'),
    ]);
    await screen.findByRole('tab', { name: 'simple-text' });
    const [first, second] = model().workspace.documentOrder;
    useWorkspaceStore.getState().setActive(first as never);
    await commandRegistry.execute('document.bates');
    const dialog = await screen.findByTestId('furniture-dialog-bates');
    await userEvent.type(within(dialog).getByTestId('bates-prefix'), 'ACME');
    await userEvent.click(within(dialog).getByRole('checkbox', { name: /simple-text/ }));
    expect(within(dialog).getByTestId('bates-sample')).toHaveTextContent(
      'ACME000001 to ACME000007',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(useFurnitureStore.getState().dialog).toBeNull());
    const ws = model().workspace;
    expect(ws.documents[first as never]?.bates?.start).toBe(1);
    expect(ws.documents[second as never]?.bates?.start).toBe(5);
    expect(model().history.present.label).toBe('Bates numbering');
    expect(lastBatesNumber('ACME')).toBe(7);

    // A new run with the same prefix continues from the remembered number.
    useWorkspaceStore.getState().setActive(second as never);
    await commandRegistry.execute('document.bates.remove');
    expect(model().workspace.documents[second as never]?.bates).toBeUndefined();
    await commandRegistry.execute('document.bates');
    const again = await screen.findByTestId('furniture-dialog-bates');
    const prefix = within(again).getByTestId('bates-prefix');
    await userEvent.clear(prefix);
    await userEvent.type(prefix, 'ACME');
    expect(within(again).getByTestId('bates-start')).toHaveValue(8);
  });
});
