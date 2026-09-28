/**
 * The pure helpers of the Markdown / text output: the conversion a step asks for, the
 * honesty notes of the conversion report, and the output name of what was produced.
 */
import type { ConvertReport } from '@pdf-editor/engine';
import { describe, expect, it } from 'vitest';

import { DEFAULT_CHOICE } from '../convert/convert-run';
import { convertChoiceFor, convertNotices, withProducedExtension } from './steps';

const report: ConvertReport = {
  pages: 3,
  pagesWithoutText: [],
  headings: 0,
  paragraphs: 3,
  listItems: 0,
  images: 0,
  links: 0,
  suspectedTables: 0,
  dropped: [],
  notes: [],
};

describe('Markdown and text output', () => {
  it('asks for the whole document with the step’s options, the dialog’s defaults otherwise', () => {
    expect(convertChoiceFor({ format: 'markdown' })).toEqual(DEFAULT_CHOICE);
    expect(
      convertChoiceFor({
        format: 'markdown',
        pageBreaks: 'rule',
        keepHeadersFooters: true,
        joinHyphens: false,
        images: false,
      }),
    ).toEqual({
      ...DEFAULT_CHOICE,
      pageBreak: 'rule',
      keepHeadersFooters: true,
      joinHyphens: false,
      images: false,
    });
    // Text never carries images.
    expect(convertChoiceFor({ format: 'text', pageBreaks: 'comment' })).toEqual({
      ...DEFAULT_CHOICE,
      format: 'text',
      pageBreak: 'comment',
      images: false,
    });
  });

  it('carries the dialog’s honesty notes', () => {
    expect(convertNotices(report, DEFAULT_CHOICE).map((n) => n.code)).toEqual([
      'convert.reading-order',
      'convert.tables',
    ]);
    const notices = convertNotices(
      {
        ...report,
        suspectedTables: 2,
        pagesWithoutText: [1, 2],
        dropped: [{ page: 0, text: 'Page 1', reason: 'page-number' }],
      },
      DEFAULT_CHOICE,
    );
    expect(notices.map((n) => n.message)).toEqual([
      expect.stringMatching(/^Reading order and headings are reconstructed/),
      expect.stringMatching(/2/),
      '1 running header, footer or page-number line left out.',
      'Pages without extractable text (scans): 2, 3. Run OCR first to include them.',
    ]);
    // Lines kept on purpose are not a note.
    expect(
      convertNotices(
        { ...report, dropped: [{ page: 0, text: 'x', reason: 'running-header' }] },
        { ...DEFAULT_CHOICE, keepHeadersFooters: true },
      ).map((n) => n.code),
    ).not.toContain('convert.dropped');
  });

  it('names the output after the plan, with the produced file’s extension', () => {
    expect(withProducedExtension('report-Notes.md', 'report.zip')).toBe('report-Notes.zip');
    expect(withProducedExtension('report-Notes.md', 'x.md')).toBe('report-Notes.md');
    expect(withProducedExtension('a.b (2).txt', 'a.txt')).toBe('a.b (2).txt');
  });
});
