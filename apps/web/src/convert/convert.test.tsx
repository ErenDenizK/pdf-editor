/**
 * PDF → Markdown / text in the app (spec recognize-and-compare §4): the dialog's choices,
 * the output file, and markdown-source.pdf converted through the real PDFium and analysis
 * workers to the manifest's golden, previewed in the dialog.
 */
import { parsePageRange } from '@pdf-editor/engine';
import { render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import manifest from '../../../../test/fixtures/manifest.json';
import markdownUrl from '../../../../test/fixtures/markdown-source.pdf?url';
import { fixtureFile } from '../../test/store-harness';
import { getAnalysisWorkers } from '../engine/engine-service';
import { resetWorkspace, useWorkspaceStore } from '../state/workspace-store';
import { closeToolDialog, openToolDialog } from '../tools/tools-store';
import ConvertDialog from './ConvertDialog';
import {
  choicePages,
  convertDocumentPages,
  convertOptions,
  DEFAULT_CHOICE,
  outputFile,
  previewLines,
} from './convert-run';

const golden = (
  manifest.fixtures.find((f) => f.file === 'markdown-source.pdf')?.expect as unknown as {
    markdown: { golden: string };
  }
).markdown.golden;

beforeEach(() => resetWorkspace());
afterEach(() => {
  closeToolDialog();
  resetWorkspace();
});
afterAll(() => getAnalysisWorkers().terminate());

describe('choices', () => {
  it('maps the scope to pages', () => {
    const pages = (scope: 'document' | 'page' | 'range', range = '') =>
      choicePages({ scope, range }, 5, 2, parsePageRange);
    expect(pages('document')).toEqual([0, 1, 2, 3, 4]);
    expect(pages('page')).toEqual([2]);
    expect(pages('range', '2-3, 5')).toEqual([1, 2, 4]);
    expect(pages('range', '9')).toBeNull();
    expect(choicePages({ scope: 'page', range: '' }, 3, 7, parsePageRange)).toEqual([2]);
    expect(choicePages({ scope: 'document', range: '' }, 0, 0, parsePageRange)).toBeNull();
  });

  it('maps the choices to engine options; text never carries images', () => {
    expect(convertOptions(DEFAULT_CHOICE)).toEqual({
      format: 'markdown',
      scope: 'document',
      pageBreak: 'none',
      keepHeadersFooters: false,
      joinHyphens: true,
      images: true,
    });
    expect(convertOptions({ ...DEFAULT_CHOICE, format: 'text', pageBreak: 'rule' })).toMatchObject({
      format: 'text',
      pageBreak: 'rule',
      images: false,
    });
  });

  it('names the download and cuts the preview', () => {
    const report = {
      pages: 1,
      pagesWithoutText: [],
      headings: 0,
      paragraphs: 1,
      listItems: 0,
      images: 0,
      links: 0,
      suspectedTables: 0,
      dropped: [],
      notes: [],
    };
    const md = new TextEncoder().encode('# A\n');
    expect(
      outputFile(
        {
          format: 'markdown',
          text: '# A\n',
          pageTexts: [],
          files: [{ path: 'document.md', mime: 'text/markdown', bytes: md }],
          report,
        },
        'Report: Q3.pdf',
      ),
    ).toMatchObject({ name: 'Report- Q3.md', type: 'text/markdown' });
    expect(
      outputFile({ format: 'text', text: 'a', pageTexts: [], files: [], report }, 'notes'),
    ).toMatchObject({ name: 'notes.txt', type: 'text/plain' });
    expect(
      outputFile(
        {
          format: 'markdown',
          text: '',
          pageTexts: [],
          files: [],
          zip: new Uint8Array([1]),
          report,
        },
        'x',
      ),
    ).toMatchObject({ name: 'x.zip', type: 'application/zip' });
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
    expect(previewLines(lines).text.split('\n')).toHaveLength(40);
    expect(previewLines(lines).more).toBe(true);
    expect(previewLines('a\nb').more).toBe(false);
  });
});

describe('markdown-source.pdf through the workers', () => {
  async function open() {
    const report = await useWorkspaceStore
      .getState()
      .openFiles([await fixtureFile(markdownUrl, 'markdown-source.pdf')]);
    const id = report.opened[0]?.documentId;
    if (!id) throw new Error('did not open');
    return id;
  }

  it('converts to the golden Markdown, images in a ZIP', async () => {
    const id = await open();
    const result = await convertDocumentPages(id, [0, 1], DEFAULT_CHOICE);
    expect(result.text).toBe(golden);
    const file = outputFile(result, 'markdown-source');
    expect(file.name).toBe('markdown-source.zip');
    // The ZIP holds these files (engine tests unzip it).
    expect(result.files.map((f) => f.path)).toEqual(['document.md', 'images/p1-1.png']);
    expect(new TextDecoder().decode(result.files[0]?.bytes)).toBe(golden);
    expect(String.fromCharCode(file.bytes[0] ?? 0, file.bytes[1] ?? 0)).toBe('PK');
    // Without images: one .md file, the image line left out.
    const plain = await convertDocumentPages(id, [0, 1], { ...DEFAULT_CHOICE, images: false });
    expect(outputFile(plain, 'markdown-source').name).toBe('markdown-source.md');
    expect(plain.text).not.toContain('![');
  }, 60_000);

  it('previews the conversion and its honesty notes in the dialog', async () => {
    const id = await open();
    openToolDialog('markdown', id);
    render(<ConvertDialog documentId={id} />);
    const dialog = await screen.findByTestId('convert-dialog');
    const preview = within(dialog).getByTestId('convert-preview');
    await waitFor(() => expect(preview).toHaveAttribute('data-state', 'ready'), {
      timeout: 30_000,
    });
    expect(preview.textContent).toBe(golden.split('\n').slice(0, 40).join('\n'));
    const notes = within(dialog).getByTestId('convert-notes');
    expect(notes).toHaveTextContent('Reading order and headings are reconstructed');
    expect(notes).toHaveTextContent('Tables are not detected');
    expect(notes).toHaveTextContent('4 running header, footer or page-number lines left out.');
    expect(within(dialog).getByTestId('convert-output')).toHaveTextContent(
      'Downloads markdown-source.zip',
    );
    // Plain text of the current page.
    within(dialog)
      .getByRole('radio', { name: /^Plain text/ })
      .click();
    within(dialog).getByRole('radio', { name: 'Current page (1)' }).click();
    await waitFor(
      () => {
        expect(preview).toHaveAttribute('data-state', 'ready');
        expect(within(dialog).getByTestId('convert-output')).toHaveTextContent(
          'Downloads markdown-source.txt',
        );
      },
      { timeout: 30_000 },
    );
    // One page alone has no running header to recognise: its lines stay.
    expect(preview.textContent).toContain('Working with PDF Fixtures\n\nTest fixtures are small');
    expect(preview.textContent).toContain('• Known text in a known place');
    expect(preview.textContent).not.toContain('Two columns');
  }, 60_000);
});
