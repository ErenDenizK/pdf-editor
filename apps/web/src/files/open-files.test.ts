import { afterEach, describe, expect, it } from 'vitest';

import type { FileHandleLike } from './file-filters';
import {
  dragHasFiles,
  fileHandleOf,
  filesFromDataTransfer,
  filesFromItems,
  pickFiles,
} from './open-files';

describe('filesFromDataTransfer (real browser DataTransfer)', () => {
  it('falls back through the tiers and keeps only PDFs', async () => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['%PDF-1.7'], 'a.pdf', { type: 'application/pdf' }));
    transfer.items.add(new File(['hello'], 'notes.txt', { type: 'text/plain' }));
    transfer.items.add(new File(['%PDF-1.4'], 'B.PDF', { type: '' }));
    transfer.items.add('just text', 'text/plain');
    const files = await filesFromDataTransfer(transfer);
    expect(files.map((f) => f.name)).toEqual(['a.pdf', 'B.PDF']);
  });

  it('detects file drags', () => {
    const transfer = new DataTransfer();
    expect(dragHasFiles(transfer)).toBe(false);
    transfer.items.add(new File(['x'], 'x.pdf', { type: 'application/pdf' }));
    expect(dragHasFiles(transfer)).toBe(true);
    expect(dragHasFiles(null)).toBe(false);
  });
});

describe('file handles kept for Recents', () => {
  const handleFor = (file: File): FileHandleLike => ({
    kind: 'file',
    name: file.name,
    getFile: () => Promise.resolve(file),
  });
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  it('keeps the handle of each file the Chromium picker returns', async () => {
    const pdf = new File(['%PDF-1.7'], 'a.pdf', { type: 'application/pdf' });
    const handle = handleFor(pdf);
    const previous = Object.getOwnPropertyDescriptor(window, 'showOpenFilePicker');
    Object.defineProperty(window, 'showOpenFilePicker', {
      configurable: true,
      value: () => Promise.resolve([handle]),
    });
    restore = () => {
      if (previous) Object.defineProperty(window, 'showOpenFilePicker', previous);
      else Reflect.deleteProperty(window, 'showOpenFilePicker');
    };
    const [file] = await pickFiles('pdf');
    expect(file).toBe(pdf);
    expect(fileHandleOf(pdf)).toBe(handle);
  });

  it('keeps the handle of a dropped file where the browser gives one, and none elsewhere', async () => {
    const withHandle = new File(['%PDF-1.7'], 'a.pdf', { type: 'application/pdf' });
    const plain = new File(['%PDF-1.7'], 'b.pdf', { type: 'application/pdf' });
    const handle = handleFor(withHandle);
    const items = [
      {
        kind: 'file',
        getAsFileSystemHandle: () => Promise.resolve(handle),
        webkitGetAsEntry: () => null,
        getAsFile: () => withHandle,
      },
      { kind: 'file', webkitGetAsEntry: () => null, getAsFile: () => plain },
    ] as unknown as DataTransferItem[];
    const files = await filesFromItems(items);
    expect(files).toEqual([withHandle, plain]);
    expect(fileHandleOf(withHandle)).toBe(handle);
    expect(fileHandleOf(plain)).toBeUndefined();
  });
});
