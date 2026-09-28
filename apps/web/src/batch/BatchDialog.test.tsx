/**
 * The Batch dialog in the browser: pick a built-in recipe, add files, run with the real
 * engines, see every file's status, download the ZIP; the recipe editor refuses an invalid
 * recipe with the reader's precise error; the palette command opens the dialog.
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';

import simpleUrl from '../../../../test/fixtures/simple-text.pdf?url';
import imagesUrl from '../../../../test/fixtures/images.pdf?url';
import { fixtureFile } from '../../test/store-harness';
import { commandRegistry } from '../commands/registry';
import BatchDialog from './BatchDialog';
import { registerBatchCommands } from './batch-commands';
import { closeBatchDialog, openBatchDialog, useBatchStore } from './batch-store';

beforeEach(() => {
  openBatchDialog();
});
afterEach(() => {
  closeBatchDialog();
  vi.unstubAllGlobals();
});

describe('Batch dialog', () => {
  it('runs "Number pages" over two files and offers the ZIP', async () => {
    const files = [
      await fixtureFile(simpleUrl, 'simple-text.pdf'),
      await fixtureFile(imagesUrl, 'images.pdf'),
      new File(['x'], 'readme.txt'),
    ];
    vi.stubGlobal(
      'showOpenFilePicker',
      vi.fn(() => Promise.resolve(files.map((file) => ({ getFile: () => Promise.resolve(file) })))),
    );
    const written: Blob[] = [];
    const savePicker = vi.fn((options: { suggestedName?: string }) =>
      Promise.resolve({
        name: options.suggestedName,
        createWritable: () =>
          Promise.resolve({
            write: (data: Blob) => {
              written.push(data);
              return Promise.resolve();
            },
            close: () => Promise.resolve(),
            abort: () => Promise.resolve(),
          }),
      }),
    );
    vi.stubGlobal('showSaveFilePicker', savePicker);

    render(<BatchDialog />);
    const dialog = await screen.findByTestId('batch-dialog');
    // Built-ins are listed; "Number pages" is selected by default.
    const recipe = await within(dialog).findByRole('button', { name: /Number pages/ });
    expect(recipe).toHaveAttribute('aria-pressed', 'true');
    expect(within(dialog).getByText('Built in, read-only')).toBeVisible();
    expect(within(dialog).getByTestId('batch-run')).toBeDisabled();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Add files…' }));
    // The picker filters PDFs; readme.txt never arrives.
    await waitFor(() => expect(within(dialog).getByTestId('batch-files').children).toHaveLength(2));
    expect(within(dialog).getByTestId('batch-plan').textContent).toMatch(/2 files .* will run/);

    const run = within(dialog).getByTestId('batch-run');
    expect(run).toHaveTextContent('Run on 2 files');
    await userEvent.click(run);
    const status = await within(dialog).findByTestId('batch-run-status');
    await waitFor(() => expect(status.textContent).toMatch(/^Finished: 2 done/), {
      timeout: 30_000,
    });
    const rows = within(dialog).getAllByTestId('batch-file-row');
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringMatching(/simple-text\.pdf.*Done.*simple-text-Number pages\.pdf/),
      expect.stringMatching(/images\.pdf.*Done.*images-Number pages\.pdf/),
    ]);

    await userEvent.click(within(dialog).getByTestId('batch-download-zip'));
    await waitFor(() => expect(written).toHaveLength(1));
    expect(savePicker).toHaveBeenCalledWith(
      expect.objectContaining({ suggestedName: 'Number pages.zip' }),
    );
    const zip = new Uint8Array(await (written[0] as Blob).arrayBuffer());
    expect([...zip.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  it('takes dropped files and lists what the plan skips, without letting the drop out', async () => {
    const outside = vi.fn();
    // A stand-in for the shell, whose drop handler opens files as tabs.
    render(
      <div onDrop={outside}>
        <BatchDialog />
      </div>,
    );
    const dialog = await screen.findByTestId('batch-dialog');
    const data = new DataTransfer();
    data.items.add(await fixtureFile(simpleUrl, 'simple-text.pdf'));
    data.items.add(new File(['x'], 'notes.txt', { type: 'text/plain' }));
    const fire = (type: string) =>
      dialog.dispatchEvent(
        new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data }),
      );
    fire('dragenter');
    fire('dragover');
    fire('drop');
    const list = await within(dialog).findByTestId('batch-files');
    await waitFor(() => expect(list.children).toHaveLength(2));
    expect(list).toHaveTextContent('notes.txt');
    expect(list).toHaveTextContent('not a PDF');
    expect(within(dialog).getByTestId('batch-plan').textContent).toMatch(/^1 file /);
    expect(outside).not.toHaveBeenCalled();
  });

  it('shows the reader’s error when a recipe cannot be saved', async () => {
    render(<BatchDialog />);
    const dialog = await screen.findByTestId('batch-dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'New' }));
    const editor = await within(dialog).findByTestId('batch-editor');
    await userEvent.fill(within(editor).getByRole('textbox', { name: 'Name' }), 'Trim');
    await userEvent.selectOptions(
      within(editor).getByRole('combobox', { name: 'Step to add' }),
      'crop',
    );
    await userEvent.click(within(editor).getByRole('button', { name: 'Add step' }));
    for (const side of ['Top (pt)', 'Right (pt)', 'Bottom (pt)', 'Left (pt)']) {
      await userEvent.fill(within(editor).getByRole('spinbutton', { name: side }), '0');
    }
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save recipe' }));
    expect(await within(dialog).findByTestId('batch-editor-error')).toHaveTextContent(
      'Step 1 (Crop pages): invalid value ($.steps[0].options.margins).',
    );
  });
});

describe('Batch command', () => {
  it('opens the dialog from the palette’s registry', async () => {
    closeBatchDialog();
    const dispose = registerBatchCommands(commandRegistry);
    try {
      await act(() => commandRegistry.execute('document.batch'));
      expect(useBatchStore.getState().open).toBe(true);
    } finally {
      dispose();
    }
  });
});
