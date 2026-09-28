/**
 * The Batch dialog in the browser: pick a built-in recipe, add files, run with the real
 * engines, see every file's status, download the ZIP; build a plain-text recipe and
 * download its .txt; build an OCR step from the language packs on offer; the recipe editor
 * refuses an invalid recipe with the reader's precise error; the palette command opens the
 * dialog.
 */
import type { OcrLanguagePack } from '@pdf-editor/engine';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';

import simpleUrl from '../../../../test/fixtures/simple-text.pdf?url';
import imagesUrl from '../../../../test/fixtures/images.pdf?url';
import { fixtureFile } from '../../test/store-harness';
import { commandRegistry } from '../commands/registry';
import { setOcrDependencies } from '../ocr/ocr-deps';
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

  it('builds a plain-text recipe, runs it and downloads the .txt', async () => {
    const files = [await fixtureFile(simpleUrl, 'simple-text.pdf')];
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
    await userEvent.click(within(dialog).getByRole('button', { name: 'New' }));
    const editor = await within(dialog).findByTestId('batch-editor');
    await userEvent.fill(within(editor).getByRole('textbox', { name: 'Name' }), 'Text notes');
    await userEvent.selectOptions(
      within(editor).getByRole('combobox', { name: 'Step to add' }),
      'export',
    );
    await userEvent.click(within(editor).getByRole('button', { name: 'Add step' }));
    await userEvent.selectOptions(within(editor).getByRole('combobox', { name: 'Output' }), 'text');
    // The export dialog's options: page breaks, running lines, hyphens (no images for text).
    await userEvent.selectOptions(
      within(editor).getByRole('combobox', { name: 'Between pages' }),
      'rule',
    );
    await userEvent.click(
      within(editor).getByRole('checkbox', {
        name: 'Keep running headers, footers and page numbers',
      }),
    );
    expect(
      within(editor).getByRole('checkbox', { name: 'Join words hyphenated at line ends' }),
    ).toBeChecked();
    expect(within(editor).queryByRole('combobox', { name: 'Images' })).toBeNull();
    expect(editor).not.toHaveTextContent('arrives in a later update');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save recipe' }));

    const steps = await within(dialog).findByTestId('batch-recipe-steps');
    expect(steps).toHaveTextContent('Plain text · A rule (---) · Running lines kept');
    expect(steps).not.toHaveTextContent('arrives in a later update');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add files…' }));
    await waitFor(() => expect(within(dialog).getByTestId('batch-files').children).toHaveLength(1));
    expect(within(dialog).queryByTestId('batch-blocked')).toBeNull();
    await userEvent.click(within(dialog).getByTestId('batch-run'));
    const status = await within(dialog).findByTestId('batch-run-status');
    await waitFor(() => expect(status.textContent).toMatch(/^Finished: 1 done/), {
      timeout: 30_000,
    });
    const row = within(dialog).getByTestId('batch-file-row');
    expect(row.textContent).toMatch(/Done with notes.*simple-text-Text notes\.txt/);
    expect(row).toHaveTextContent('Reading order and headings are reconstructed');

    await userEvent.click(within(dialog).getByTestId('batch-download'));
    await waitFor(() => expect(written).toHaveLength(1));
    expect(savePicker).toHaveBeenCalledWith(
      expect.objectContaining({ suggestedName: 'simple-text-Text notes.txt' }),
    );
    const text = await (written[0] as Blob).text();
    expect(text).toContain('This is page 1 of a three-page US Letter document');
    // Kept: the running "PAGE n OF simple-text" line the defaults leave out.
    expect(text).toContain('PAGE 1 OF simple-text');
    expect(text).toContain('This is page 3 of a three-page US Letter document');
  });

  it('builds an OCR step from the languages on offer, with quality, pages and replace', async () => {
    const packs: OcrLanguagePack[] = [
      { code: 'eng', source: 'origin', bytes: 4_110_000, downloadBytes: 0, onDevice: true },
      { code: 'deu', source: 'origin', bytes: 1_530_000, downloadBytes: 850_000, onDevice: false },
    ];
    setOcrDependencies({
      facts: () => Promise.reject(new Error('not used')),
      packs: () =>
        Promise.resolve({
          list: () => Promise.resolve(packs),
          keepOffline: () => Promise.resolve(),
          remove: () => Promise.resolve(),
          importFile: () => Promise.reject(new Error('not used')),
        }),
      engineFiles: () => Promise.resolve([]),
    });
    try {
      render(<BatchDialog />);
      const dialog = await screen.findByTestId('batch-dialog');
      await userEvent.click(within(dialog).getByRole('button', { name: 'New' }));
      const editor = await within(dialog).findByTestId('batch-editor');
      await userEvent.fill(within(editor).getByRole('textbox', { name: 'Name' }), 'Searchable');
      await userEvent.selectOptions(
        within(editor).getByRole('combobox', { name: 'Step to add' }),
        'ocr',
      );
      await userEvent.click(within(editor).getByRole('button', { name: 'Add step' }));
      // The OCR dialog's list: name, size and whether the pack is on this device.
      const english = await within(editor).findByRole('checkbox', { name: /English/ });
      expect(english).toBeChecked();
      expect(english.closest('label')).toHaveTextContent('On this device · 4.1 MB');
      const german = within(editor).getByRole('checkbox', { name: /German/ });
      expect(german.closest('label')).toHaveTextContent('Downloads 0.9 MB');
      await userEvent.click(german);
      expect(editor).toHaveTextContent('Recognized as eng+deu; the first language leads.');
      await userEvent.selectOptions(
        within(editor).getByRole('combobox', { name: 'Quality' }),
        'high',
      );
      await userEvent.selectOptions(within(editor).getByRole('combobox', { name: 'Pages' }), 'all');
      await userEvent.selectOptions(
        within(editor).getByRole('combobox', { name: 'Existing invisible text' }),
        'none',
      );
      await userEvent.click(within(dialog).getByRole('button', { name: 'Save recipe' }));

      const steps = await within(dialog).findByTestId('batch-recipe-steps');
      expect(steps).toHaveTextContent(
        'Recognize text (OCR)eng+deu · High · 400 dpi · All pages · Keeps invisible text',
      );
    } finally {
      setOcrDependencies(undefined);
    }
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
