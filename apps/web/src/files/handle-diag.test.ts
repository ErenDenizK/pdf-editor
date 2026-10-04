// Diagnostic only: which step of an OPFS handle round-trip through IndexedDB ends the browser.
// Each step is its own test, in order; the last one reported passed is the last that survived.
import { expect, it } from 'vitest';

import { indexedDbRecentsBackend, parseRecentEntry, type RecentEntry } from './recents';

let root: FileSystemDirectoryHandle;
let handle: FileSystemFileHandle;
const name = `diag-${crypto.randomUUID()}.pdf`;
const dbName = `diag-${crypto.randomUUID()}`;
let parsed: RecentEntry | null | undefined;

it('step 1: writes an OPFS file', async () => {
  root = await navigator.storage.getDirectory();
  handle = await root.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write('%PDF-1.7 diag');
  await writable.close();
});

it('step 2: structuredClone of the handle', () => {
  expect(structuredClone(handle).kind).toBe('file');
});

it('step 3: puts the handle into IndexedDB', async () => {
  await indexedDbRecentsBackend(indexedDB, dbName).put({
    id: 'a',
    name,
    size: 1,
    openedAt: 1,
    handle,
  });
});

it('step 4: lists it back on a new connection', async () => {
  const [record] = await indexedDbRecentsBackend(indexedDB, dbName).list();
  parsed = parseRecentEntry(record);
  expect(parsed?.handle?.kind).toBe('file');
});

it('step 5: reads the file through the stored handle', async () => {
  const file = await parsed?.handle?.getFile();
  expect(await file?.text()).toBe('%PDF-1.7 diag');
});

it('step 6: removes the OPFS file', async () => {
  await root.removeEntry(name);
});

it('step 7: waits a second', async () => {
  await new Promise((resolve) => setTimeout(resolve, 1000));
});
