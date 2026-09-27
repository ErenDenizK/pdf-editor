import { describe, expect, it } from 'vitest';

import {
  collectFromEntries,
  collectFromHandles,
  type DirectoryEntryLike,
  type DirectoryHandleLike,
  type EntryLike,
  type FileEntryLike,
  type FileHandleLike,
  filterPdfFiles,
  formatBytes,
  isPdfFile,
} from './file-filters';

const pdf = (name: string) => new File(['%PDF-1.7'], name, { type: 'application/pdf' });
const other = (name: string, type = 'text/plain') => new File(['x'], name, { type });

describe('isPdfFile', () => {
  it.each([
    [{ name: 'a.pdf', type: 'application/pdf' }, true],
    [{ name: 'A.PDF', type: '' }, true],
    [{ name: 'scan.pdf', type: 'application/octet-stream' }, true],
    [{ name: 'no-extension', type: 'application/pdf' }, true],
    [{ name: 'legacy', type: 'application/x-pdf' }, true],
    [{ name: 'notes.txt', type: 'text/plain' }, false],
    [{ name: 'report.pdf.zip', type: 'application/zip' }, false],
    [{ name: '._report.pdf', type: 'application/pdf' }, false],
    [{ name: '.hidden.pdf', type: '' }, false],
  ])('%o -> %s', (file, expected) => {
    expect(isPdfFile(file)).toBe(expected);
  });

  it('filters lists and keeps order', () => {
    const files = [pdf('b.pdf'), other('c.txt'), pdf('a.pdf')];
    expect(filterPdfFiles(files).map((f) => f.name)).toEqual(['b.pdf', 'a.pdf']);
  });
});

function fileEntry(file: File): FileEntryLike {
  return {
    isFile: true,
    isDirectory: false,
    name: file.name,
    file: (ok) => {
      ok(file);
    },
  };
}

/** Returns children in batches of two, like Chromium's 100-entry batches. */
function dirEntry(name: string, children: EntryLike[]): DirectoryEntryLike {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => {
      let offset = 0;
      return {
        readEntries: (ok) => {
          const batch = children.slice(offset, offset + 2);
          offset += batch.length;
          ok(batch);
        },
      };
    },
  };
}

describe('collectFromEntries', () => {
  it('walks folders recursively, reads every batch, sorts naturally, keeps PDFs only', async () => {
    const tree = dirEntry('root', [
      fileEntry(pdf('page10.pdf')),
      fileEntry(other('readme.md')),
      fileEntry(pdf('page2.pdf')),
      dirEntry('sub', [fileEntry(pdf('nested.pdf')), fileEntry(pdf('._nested.pdf'))]),
      dirEntry('.git', [fileEntry(pdf('ignored.pdf'))]),
    ]);
    const files = await collectFromEntries([tree, fileEntry(pdf('top.pdf'))]);
    expect(files.map((f) => f.name)).toEqual(['page2.pdf', 'page10.pdf', 'nested.pdf', 'top.pdf']);
  });

  it('honours maxFiles and maxDepth', async () => {
    const deep = dirEntry('a', [dirEntry('b', [fileEntry(pdf('deep.pdf'))])]);
    expect(await collectFromEntries([deep], { maxDepth: 1 })).toEqual([]);
    const many = dirEntry('m', [fileEntry(pdf('1.pdf')), fileEntry(pdf('2.pdf'))]);
    expect(await collectFromEntries([many], { maxFiles: 1 })).toHaveLength(1);
  });

  it('skips entries whose file() fails', async () => {
    const broken: FileEntryLike = {
      isFile: true,
      isDirectory: false,
      name: 'broken.pdf',
      file: (_ok, fail) => fail?.(new Error('gone')),
    };
    expect(await collectFromEntries([broken, fileEntry(pdf('ok.pdf'))])).toHaveLength(1);
  });
});

describe('collectFromHandles', () => {
  const fileHandle = (file: File): FileHandleLike => ({
    kind: 'file',
    name: file.name,
    getFile: () => Promise.resolve(file),
  });
  const dirHandle = (name: string, children: FileHandleLike[]): DirectoryHandleLike => ({
    kind: 'directory',
    name,
    async *values() {
      await Promise.resolve();
      yield* children;
    },
  });

  it('walks directory handles and filters to PDFs', async () => {
    const files = await collectFromHandles([
      dirHandle('dir', [fileHandle(pdf('b.pdf')), fileHandle(other('x.png', 'image/png'))]),
      fileHandle(pdf('a.pdf')),
    ]);
    expect(files.map((f) => f.name)).toEqual(['b.pdf', 'a.pdf']);
  });
});

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [1023, '1023 B'],
    [1024, '1.0 KB'],
    [1536, '1.5 KB'],
    [5 * 1024 * 1024, '5.0 MB'],
    [250 * 1024 * 1024, '250 MB'],
    [-1, '—'],
  ])('%d -> %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });
});
