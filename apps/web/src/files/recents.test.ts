/**
 * Recents store (craft §3.1, WP M5): validation field by field, the cap of 12, a database
 * created from nothing, the optional handle (a real OPFS `FileSystemFileHandle` round-trips
 * through IndexedDB), clear, and reopening through a handle.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  addRecentEntry,
  clearRecents,
  indexedDbRecentsBackend,
  loadRecents,
  memoryRecentsBackend,
  parseRecentEntry,
  RECENTS_DB_NAME,
  RECENTS_LIMIT,
  type RecentEntry,
  type RecentFileHandle,
  type RecentsBackend,
  recordRecent,
  removeRecent,
  reopenRecent,
  setRecentsBackend,
  useRecentsStore,
} from './recents';

const entry = (id: string, openedAt: number, extra: Partial<RecentEntry> = {}): RecentEntry => ({
  id,
  name: `${id}.pdf`,
  size: 1000,
  openedAt,
  ...extra,
});

/** A handle as the File System Access API hands it out, with a scripted permission. */
function fakeHandle(
  file: File,
  permission: { query: PermissionState; request?: PermissionState; missing?: boolean },
): RecentFileHandle & { requested: number } {
  const handle = {
    kind: 'file' as const,
    name: file.name,
    requested: 0,
    getFile: () =>
      permission.missing
        ? Promise.reject(new DOMException('gone', 'NotFoundError'))
        : Promise.resolve(file),
    queryPermission: () => Promise.resolve(permission.query),
    requestPermission: () => {
      handle.requested += 1;
      return Promise.resolve(permission.request ?? permission.query);
    },
  };
  return handle;
}

const testDbs: string[] = [];
function testDbName(): string {
  const name = `pdf-editor:recents:test-${crypto.randomUUID()}`;
  testDbs.push(name);
  return name;
}

afterEach(() => {
  setRecentsBackend(undefined);
  for (const name of testDbs.splice(0)) indexedDB.deleteDatabase(name);
});

describe('parseRecentEntry', () => {
  it('keeps a valid record and drops unknown fields', () => {
    const parsed = parseRecentEntry({
      id: 'a',
      name: 'report.pdf',
      size: 6144,
      pages: 6,
      openedAt: 1_700_000_000_000,
      bytes: new Uint8Array(4),
      thumbnail: 'data:',
    });
    expect(parsed).toEqual({
      id: 'a',
      name: 'report.pdf',
      size: 6144,
      pages: 6,
      openedAt: 1_700_000_000_000,
    });
  });

  it('refuses a record with a missing or mistyped required field', () => {
    const good = { id: 'a', name: 'x.pdf', size: 1, openedAt: 1 };
    expect(parseRecentEntry(good)).not.toBeNull();
    for (const bad of [
      null,
      'x.pdf',
      [good],
      { ...good, id: '' },
      { ...good, id: 7 },
      { ...good, name: '' },
      { ...good, name: 3 },
      { ...good, size: -1 },
      { ...good, size: 1.5 },
      { ...good, size: '1' },
      { ...good, openedAt: Number.NaN },
      { ...good, openedAt: undefined },
    ]) {
      expect(parseRecentEntry(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('drops a malformed optional field but keeps the entry', () => {
    const parsed = parseRecentEntry({
      id: 'a',
      name: 'x.pdf',
      size: 1,
      openedAt: 1,
      pages: 'six',
      handle: { kind: 'directory', name: 'x' },
    });
    expect(parsed).toEqual({ id: 'a', name: 'x.pdf', size: 1, openedAt: 1 });
    const handle = fakeHandle(new File(['x'], 'x.pdf'), { query: 'granted' });
    expect(parseRecentEntry({ id: 'a', name: 'x.pdf', size: 1, openedAt: 1, handle })?.handle).toBe(
      handle,
    );
  });
});

describe('addRecentEntry', () => {
  it('puts the new entry first and replaces the same file (name and size)', () => {
    const list = [entry('a', 3), entry('b', 2, { name: 'same.pdf' }), entry('c', 1)];
    const { entries, removed } = addRecentEntry(list, entry('d', 4, { name: 'same.pdf' }));
    expect(entries.map((e) => e.id)).toEqual(['d', 'a', 'c']);
    expect(removed).toEqual(['b']);
  });

  it('keeps a file of the same name but another size, unless it is the one replaced', () => {
    const list = [entry('a', 2, { name: 'same.pdf', size: 1 })];
    expect(addRecentEntry(list, entry('b', 3, { name: 'same.pdf', size: 2 })).entries).toHaveLength(
      2,
    );
    const replaced = addRecentEntry(list, entry('b', 3, { name: 'same.pdf', size: 2 }), {
      replaces: 'a',
    });
    expect(replaced.entries.map((e) => e.id)).toEqual(['b']);
    expect(replaced.removed).toEqual(['a']);
  });

  it('caps the list at 12, dropping the oldest', () => {
    const list = Array.from({ length: RECENTS_LIMIT }, (_, i) => entry(`e${i}`, i));
    const { entries, removed } = addRecentEntry(list, entry('new', 100));
    expect(RECENTS_LIMIT).toBe(12);
    expect(entries).toHaveLength(12);
    expect(entries[0]?.id).toBe('new');
    expect(removed).toEqual(['e0']);
  });
});

describe('IndexedDB backend', () => {
  it('names the database pdf-editor:recents:v1', () => {
    expect(RECENTS_DB_NAME).toBe('pdf-editor:recents:v1');
  });

  it('creates the store from nothing and lists no entries', async () => {
    const backend = indexedDbRecentsBackend(indexedDB, testDbName());
    expect(await backend.list()).toEqual([]);
  });

  it('puts, lists, removes and clears entries', async () => {
    const backend = indexedDbRecentsBackend(indexedDB, testDbName());
    await backend.put(entry('a', 1));
    await backend.put(entry('b', 2, { pages: 3 }));
    expect((await backend.list()).map((r) => parseRecentEntry(r)?.id).sort()).toEqual(['a', 'b']);
    await backend.remove('a');
    expect((await backend.list()).map((r) => parseRecentEntry(r)?.id)).toEqual(['b']);
    await backend.clear();
    expect(await backend.list()).toEqual([]);
  });

  it('keeps a real FileSystemFileHandle and reads the file through it again', async () => {
    const root = await navigator.storage.getDirectory();
    const name = `recents-${crypto.randomUUID()}.pdf`;
    const handle = await root.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write('%PDF-1.7 recents');
    await writable.close();
    try {
      const dbName = testDbName();
      await indexedDbRecentsBackend(indexedDB, dbName).put(
        entry('a', 1, { name, handle: handle as unknown as RecentFileHandle }),
      );
      // A new connection, as after a reload.
      const [record] = await indexedDbRecentsBackend(indexedDB, dbName).list();
      const parsed = parseRecentEntry(record);
      expect(parsed?.handle?.kind).toBe('file');
      const file = await parsed?.handle?.getFile();
      expect(await file?.text()).toBe('%PDF-1.7 recents');
    } finally {
      await root.removeEntry(name);
    }
  });
});

describe('the recents store', () => {
  let backend: RecentsBackend;
  beforeEach(() => {
    backend = memoryRecentsBackend();
    setRecentsBackend(backend);
  });

  it('loads valid entries newest first, at most 12, and deletes the rest', async () => {
    const stored: unknown[] = Array.from({ length: 14 }, (_, i) => entry(`e${i}`, i));
    stored.push({ id: 'broken', name: 42 }, 'not a record');
    backend = memoryRecentsBackend(stored);
    setRecentsBackend(backend);
    await loadRecents();
    const { entries } = useRecentsStore.getState();
    expect(entries.map((e) => e.id)).toEqual(Array.from({ length: 12 }, (_, i) => `e${13 - i}`));
    await recordRecent({ name: 'x.pdf', size: 1, now: 100 });
    const left = (await backend.list()).map((r) => (r as { id: string }).id);
    expect(left).not.toContain('broken');
    expect(left).not.toContain('e0');
    expect(left).not.toContain('e1');
  });

  it('starts empty when nothing was ever stored', async () => {
    await loadRecents();
    expect(useRecentsStore.getState()).toMatchObject({ entries: [], loaded: true });
  });

  it('records name, size and pages, with a handle only when one is given', async () => {
    const file = new File(['%PDF'], 'b.pdf');
    const handle = fakeHandle(file, { query: 'granted' });
    await recordRecent({ name: 'a.pdf', size: 10, pages: 2, now: 1 });
    await recordRecent({ name: 'b.pdf', size: 4, handle, now: 2 });
    const [b, a] = useRecentsStore.getState().entries;
    expect(a).toMatchObject({ name: 'a.pdf', size: 10, pages: 2, openedAt: 1 });
    expect(a && 'handle' in a).toBe(false);
    expect(b?.handle).toBe(handle);
    expect(useRecentsStore.getState().access).toMatchObject({
      [a?.id ?? '']: 'unavailable',
      [b?.id ?? '']: 'granted',
    });
    const stored = (await backend.list()).map((r) => parseRecentEntry(r));
    expect(stored.map((e) => e?.name).sort()).toEqual(['a.pdf', 'b.pdf']);
    // Never the bytes, never a thumbnail.
    for (const record of await backend.list()) {
      expect(Object.keys(record as object).sort()).toEqual(
        expect.arrayContaining(['id', 'name', 'openedAt', 'size']),
      );
      expect(Object.keys(record as object)).not.toContain('bytes');
    }
  });

  it('opening the same file again moves it to the top instead of adding a row', async () => {
    await recordRecent({ name: 'a.pdf', size: 10, now: 1 });
    await recordRecent({ name: 'b.pdf', size: 10, now: 2 });
    await recordRecent({ name: 'a.pdf', size: 10, now: 3 });
    expect(useRecentsStore.getState().entries.map((e) => e.name)).toEqual(['a.pdf', 'b.pdf']);
    expect(await backend.list()).toHaveLength(2);
  });

  it('removes one entry and clears them all, in memory and in storage', async () => {
    const a = await recordRecent({ name: 'a.pdf', size: 1, now: 1 });
    await recordRecent({ name: 'b.pdf', size: 1, now: 2 });
    await removeRecent(a?.id ?? '');
    expect(useRecentsStore.getState().entries.map((e) => e.name)).toEqual(['b.pdf']);
    expect(await backend.list()).toHaveLength(1);
    await clearRecents();
    expect(useRecentsStore.getState().entries).toEqual([]);
    expect(await backend.list()).toEqual([]);
  });

  it('stores the name without the handle when the handle cannot be stored', async () => {
    const indexed = indexedDbRecentsBackend(indexedDB, testDbName());
    setRecentsBackend(indexed, { memoryFallback: false });
    // A script object with methods is not structured-cloneable (DataCloneError).
    const handle = fakeHandle(new File(['x'], 'x.pdf'), { query: 'granted' });
    await recordRecent({ name: 'x.pdf', size: 1, handle, now: 1 });
    const [record] = await indexed.list();
    expect(parseRecentEntry(record)).toMatchObject({ name: 'x.pdf', size: 1 });
    expect(parseRecentEntry(record)?.handle).toBeUndefined();
  });

  it('reads the probe of each handle on load: granted, prompt, or none', async () => {
    const file = new File(['x'], 'x.pdf');
    backend = memoryRecentsBackend([
      entry('granted', 3, { handle: fakeHandle(file, { query: 'granted' }) }),
      entry('prompt', 2, { handle: fakeHandle(file, { query: 'prompt' }) }),
      entry('none', 1),
    ]);
    setRecentsBackend(backend);
    await loadRecents();
    expect(useRecentsStore.getState().access).toEqual({
      granted: 'granted',
      prompt: 'prompt',
      none: 'unavailable',
    });
  });
});

// Review F6: "Clear recents" must be final, and must reach the stored copy even after a
// write failure switched the list to memory.
describe('clearing recents', () => {
  /** `list()` waits for `release()`, as a slow IndexedDB read would. */
  function slowList(memory: RecentsBackend) {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const backend: RecentsBackend = {
      ...memory,
      list: async () => {
        const records = await memory.list();
        await gate;
        return records;
      },
    };
    return { backend, release };
  }

  /** A stored backend whose writes fail while `failing.put` / `failing.clear` are set. */
  function flaky(records: readonly unknown[]) {
    const memory = memoryRecentsBackend(records);
    const failing = { put: false, clear: false };
    const backend: RecentsBackend = {
      ...memory,
      put: (record) =>
        failing.put ? Promise.reject(new Error('QuotaExceededError')) : memory.put(record),
      clear: () =>
        failing.clear ? Promise.reject(new Error('InvalidStateError')) : memory.clear(),
    };
    return { backend, memory, failing };
  }

  it('a clear pressed while the list is loading is not undone by the load', async () => {
    const memory = memoryRecentsBackend([
      { id: 'a', name: 'secret-contract.pdf', size: 10, openedAt: 1 },
    ]);
    const slow = slowList(memory);
    setRecentsBackend(slow.backend);
    const loading = loadRecents();
    expect(await clearRecents()).toBe(true);
    slow.release();
    await loading;
    expect(useRecentsStore.getState().entries).toEqual([]);
    expect(useRecentsStore.getState().access).toEqual({});
    expect(useRecentsStore.getState().loaded).toBe(true);
    expect(await memory.list()).toEqual([]);
  });

  it('an open recorded before the clear does not come back after it; later ones do', async () => {
    const memory = memoryRecentsBackend([entry('old', 1)]);
    const slow = slowList(memory);
    setRecentsBackend(slow.backend);
    const before = recordRecent({ name: 'before.pdf', size: 1, now: 2 });
    await clearRecents();
    const after = recordRecent({ name: 'after.pdf', size: 1, now: 3 });
    slow.release();
    expect(await before).toBeNull();
    await after;
    expect(useRecentsStore.getState().entries.map((e) => e.name)).toEqual(['after.pdf']);
    expect((await memory.list()).map((r) => parseRecentEntry(r)?.name)).toEqual(['after.pdf']);
  });

  it('after a failure switched to memory, Remove and Clear still reach the stored copy', async () => {
    const stored = flaky([entry('old', 1), entry('older', 0)]);
    setRecentsBackend(stored.backend);
    await loadRecents();
    stored.failing.put = true;
    await recordRecent({ name: 'new.pdf', size: 1, now: 2 });
    // The list carries on in memory for this tab.
    expect(useRecentsStore.getState().entries.map((e) => e.name)).toEqual([
      'new.pdf',
      'old.pdf',
      'older.pdf',
    ]);
    await removeRecent('old');
    expect((await stored.memory.list()).map((r) => parseRecentEntry(r)?.id)).toEqual(['older']);
    expect(await clearRecents()).toBe(true);
    expect(await stored.memory.list()).toEqual([]);
    expect(useRecentsStore.getState().clearFailed).toBe(false);
    // The stored database is used again once it is cleared.
    stored.failing.put = false;
    await recordRecent({ name: 'next.pdf', size: 1, now: 3 });
    expect((await stored.memory.list()).map((r) => parseRecentEntry(r)?.name)).toEqual([
      'next.pdf',
    ]);
  });

  it('says so when the stored copy cannot be cleared, and a later clear tries again', async () => {
    const stored = flaky([entry('old', 1)]);
    setRecentsBackend(stored.backend);
    await loadRecents();
    stored.failing.put = true;
    stored.failing.clear = true;
    await recordRecent({ name: 'new.pdf', size: 1, now: 2 });
    expect(await clearRecents()).toBe(false);
    expect(useRecentsStore.getState()).toMatchObject({ entries: [], clearFailed: true });
    expect(await stored.memory.list()).toHaveLength(1);
    stored.failing.clear = false;
    expect(await clearRecents()).toBe(true);
    expect(useRecentsStore.getState().clearFailed).toBe(false);
    expect(await stored.memory.list()).toEqual([]);
  });

  it('says so when the only backend refuses to clear', async () => {
    const stored = flaky([entry('old', 1)]);
    setRecentsBackend(stored.backend, { memoryFallback: false });
    await loadRecents();
    stored.failing.clear = true;
    expect(await clearRecents()).toBe(false);
    expect(useRecentsStore.getState()).toMatchObject({ entries: [], clearFailed: true });
  });
});

describe('reopenRecent', () => {
  beforeEach(() => setRecentsBackend(memoryRecentsBackend()));

  it('reads the file at once when permission is granted', async () => {
    const file = new File(['%PDF'], 'a.pdf');
    const handle = fakeHandle(file, { query: 'granted' });
    const result = await reopenRecent(entry('a', 1, { handle }));
    expect(result).toEqual({ ok: true, file });
    expect(handle.requested).toBe(0);
  });

  it('asks for read permission when the browser says prompt', async () => {
    const file = new File(['%PDF'], 'a.pdf');
    const handle = fakeHandle(file, { query: 'prompt', request: 'granted' });
    expect(await reopenRecent(entry('a', 1, { handle }))).toEqual({ ok: true, file });
    expect(handle.requested).toBe(1);
  });

  it('marks the entry unavailable when permission is denied', async () => {
    const handle = fakeHandle(new File(['x'], 'a.pdf'), { query: 'prompt', request: 'denied' });
    expect(await reopenRecent(entry('a', 1, { handle }))).toEqual({ ok: false, reason: 'denied' });
    expect(useRecentsStore.getState().access.a).toBe('unavailable');
  });

  it('forgets the handle of a moved file', async () => {
    const backend = memoryRecentsBackend();
    setRecentsBackend(backend);
    const handle = fakeHandle(new File(['x'], 'a.pdf'), { query: 'granted', missing: true });
    const recorded = await recordRecent({ name: 'a.pdf', size: 1, handle, now: 1 });
    if (recorded === null) throw new Error('not recorded');
    expect(await reopenRecent(recorded)).toEqual({ ok: false, reason: 'missing' });
    expect(useRecentsStore.getState().entries[0]?.handle).toBeUndefined();
    expect(useRecentsStore.getState().access[recorded.id]).toBe('unavailable');
    // Writes run in order: once a later record has landed, the handle-less put has too.
    await recordRecent({ name: 'other.pdf', size: 9, now: 2 });
    const stored = (await backend.list()).map((r) => parseRecentEntry(r));
    const a = stored.find((e) => e?.name === 'a.pdf');
    expect(a).toBeDefined();
    expect(a?.handle).toBeUndefined();
  });

  it('says no-handle for an entry without one', async () => {
    expect(await reopenRecent(entry('a', 1))).toEqual({ ok: false, reason: 'no-handle' });
  });
});
