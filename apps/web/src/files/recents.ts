/**
 * Recents (docs/specs/craft.md §3.1, §14 answer 3; ADR-0019): the files opened lately, kept
 * on this device only and always clearable.
 *
 * Stored in IndexedDB, database `pdf-editor:recents:v1`, one record per entry
 * `{ id, name, size, pages?, openedAt, handleStored? }`, at most `RECENTS_LIMIT` (the oldest
 * go first). No file bytes and no thumbnails are stored. The browser's `FileSystemFileHandle`
 * is kept only when the browser handed one out (Chromium's `showOpenFilePicker` and a drop's
 * `getAsFileSystemHandle()`); elsewhere an entry is a name and the file is chosen again in
 * the file dialog ("Open again…").
 *
 * Handles live in a store of their own and are read one at a time, only when a row is
 * clicked, never when the list loads: Chromium 153 ends the whole browser when IndexedDB
 * hands a stored handle back (seen in CI, also reported for macOS), so a list that carried
 * handles would take the browser down on every visit to Home. On Chromium 153 stored handles
 * are not read at all and such rows reopen through the file dialog.
 *
 * Every record is checked field by field when read, so a damaged or foreign record is
 * skipped rather than shown. When IndexedDB cannot be opened (storage disabled, some private
 * windows) the list lives in memory until the tab closes.
 *
 * "Clear recents" is final: a read or a record that began before it never brings entries
 * back after it (`clears`). After a write failure switched the list to memory, Clear and
 * Remove still try the stored database, and Clear says when it could not be cleared.
 */
import { create } from 'zustand';

export const RECENTS_DB_NAME = 'pdf-editor:recents:v1';
/** Version 2 moved handles out of the entries into `handles` (see above). */
const RECENTS_DB_VERSION = 2;
const RECENTS_STORE = 'entries';
const HANDLES_STORE = 'handles';
/** At most this many entries are kept (spec M5: 12). */
export const RECENTS_LIMIT = 12;
const MAX_NAME_LENGTH = 1024;

/**
 * The parts of `FileSystemFileHandle` Recents uses. The permission methods are part of the
 * File System Access API (Chromium), not of the DOM library types.
 */
export interface RecentFileHandle {
  readonly kind: 'file';
  readonly name: string;
  getFile(): Promise<File>;
  queryPermission?(descriptor: { mode: 'read' }): Promise<PermissionState>;
  requestPermission?(descriptor: { mode: 'read' }): Promise<PermissionState>;
}

export interface RecentEntry {
  readonly id: string;
  readonly name: string;
  /** Bytes, as opened. */
  readonly size: number;
  readonly pages?: number;
  /** When it was last opened (ms since the epoch). */
  readonly openedAt: number;
  /** The handle, when this session holds it (recorded or read back on a click). */
  readonly handle?: RecentFileHandle;
  /** A handle for this entry is stored beside it, to be read on a click (`readHandle`). */
  readonly handleStored?: true;
}

/**
 * What this session knows about reaching an entry's file: `granted` reopens at once,
 * `prompt` asks for permission on the click, `unavailable` (no handle, permission denied,
 * file moved) goes through the file dialog.
 */
export type RecentAccess = 'granted' | 'prompt' | 'unavailable';

/** The one-line note Home shows after an entry could not reopen by itself. */
export interface RecentNote {
  readonly id: string;
  readonly name: string;
  /** `open-again`: the browser keeps no handle; `unavailable`: the handle failed. */
  readonly kind: 'open-again' | 'unavailable';
}

/** Where the entries live; tests pass their own. */
export interface RecentsBackend {
  /** The stored entries, without their handles. */
  list(): Promise<readonly unknown[]>;
  /** Stores the entry; its `handle`, if any, is stored apart and marked `handleStored`. */
  put(entry: RecentEntry): Promise<void>;
  remove(id: string): Promise<void>;
  clear(): Promise<void>;
  /** The handle stored for one entry, or undefined. Only ever called from a click. */
  readHandle(id: string): Promise<unknown>;
}

/**
 * False on Chromium 153, whose browser process crashes when IndexedDB returns a stored
 * file handle (with or without a reload, top-level page or frame, headless or not).
 */
export function storedHandlesReadable(
  nav: Pick<Navigator, 'userAgent'> & {
    readonly userAgentData?: { readonly brands?: readonly { brand: string; version: string }[] };
  } = navigator,
): boolean {
  const brand = nav.userAgentData?.brands?.find((b) => b.brand === 'Chromium')?.version;
  const version = brand ?? /\bChrom(?:e|ium)\/(\d+)/.exec(nav.userAgent)?.[1];
  return version === undefined || Number.parseInt(version, 10) !== 153;
}

/** True when a click on the entry can try its handle rather than the file dialog. */
export function canReopenRecent(entry: RecentEntry): boolean {
  return entry.handle !== undefined || (entry.handleStored === true && storedHandlesReadable());
}

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFileHandle(value: unknown): value is RecentFileHandle {
  if (typeof value !== 'object' || value === null) return false;
  const handle = value as Partial<Record<keyof RecentFileHandle, unknown>>;
  return (
    handle.kind === 'file' &&
    typeof handle.name === 'string' &&
    typeof handle.getFile === 'function'
  );
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/**
 * A stored record as an entry, or null when any field is missing or of the wrong kind.
 * Unknown fields are dropped; a malformed optional field (`pages`, `handle`) is dropped
 * without losing the entry.
 */
export function parseRecentEntry(value: unknown): RecentEntry | null {
  if (!isRecord(value)) return null;
  const { id, name, size, pages, openedAt, handle, handleStored } = value;
  if (typeof id !== 'string' || id.length === 0 || id.length > 128) return null;
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME_LENGTH) return null;
  if (!isCount(size)) return null;
  if (typeof openedAt !== 'number' || !Number.isFinite(openedAt) || openedAt < 0) return null;
  return {
    id,
    name,
    size,
    ...(isCount(pages) && pages > 0 ? { pages } : {}),
    openedAt,
    ...(isFileHandle(handle) ? { handle } : {}),
    ...(handleStored === true ? { handleStored } : {}),
  };
}

/** The entry as its stored record: the handle goes to its own store, a mark stays. */
function withoutHandle(entry: RecentEntry): RecentEntry {
  const { handle, handleStored: _mark, ...rest } = entry;
  return handle === undefined && entry.handleStored !== true
    ? rest
    : { ...rest, handleStored: true };
}

/** Newest first; ties keep their order. */
export function sortRecents(entries: readonly RecentEntry[]): RecentEntry[] {
  return [...entries].sort((a, b) => b.openedAt - a.openedAt);
}

/** True when two entries name the same file as far as Recents can tell: name and size. */
export function sameRecentFile(
  a: Pick<RecentEntry, 'name' | 'size'>,
  b: Pick<RecentEntry, 'name' | 'size'>,
): boolean {
  return a.name === b.name && a.size === b.size;
}

/**
 * Adds `entry` at the top: an earlier entry for the same file (or the entry `replaces`
 * names) gives way, and the list is cut to `limit`. Returns the list and the ids that left.
 */
export function addRecentEntry(
  entries: readonly RecentEntry[],
  entry: RecentEntry,
  options: { readonly limit?: number; readonly replaces?: string } = {},
): { readonly entries: RecentEntry[]; readonly removed: string[] } {
  const limit = Math.max(1, options.limit ?? RECENTS_LIMIT);
  const removed: string[] = [];
  const kept: RecentEntry[] = [];
  for (const existing of sortRecents(entries)) {
    if (existing.id === entry.id) continue;
    if (existing.id === options.replaces || sameRecentFile(existing, entry)) {
      removed.push(existing.id);
      continue;
    }
    kept.push(existing);
  }
  const next = [entry, ...kept];
  for (const dropped of next.splice(limit)) removed.push(dropped.id);
  return { entries: next, removed };
}

// ---------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------

/** Like the IndexedDB store, in memory: handles apart from the entries. */
export function memoryRecentsBackend(initial: readonly unknown[] = []): RecentsBackend {
  const records = new Map<string, unknown>();
  const handles = new Map<string, unknown>();
  for (const record of initial) {
    const id = isRecord(record) && typeof record.id === 'string' ? record.id : undefined;
    if (id === undefined || !isRecord(record)) continue;
    const { handle, ...rest } = record;
    if (handle === undefined) {
      records.set(id, record);
    } else {
      records.set(id, { ...rest, handleStored: true });
      handles.set(id, handle);
    }
  }
  return {
    list: () => Promise.resolve([...records.values()]),
    put: (entry) => {
      records.set(entry.id, withoutHandle(entry));
      if (entry.handle !== undefined) handles.set(entry.id, entry.handle);
      else if (entry.handleStored !== true) handles.delete(entry.id);
      return Promise.resolve();
    },
    remove: (id) => {
      records.delete(id);
      handles.delete(id);
      return Promise.resolve();
    },
    clear: () => {
      records.clear();
      handles.clear();
      return Promise.resolve();
    },
    readHandle: (id) => Promise.resolve(handles.get(id)),
  };
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
  });
}

/**
 * The IndexedDB store: `entries` (keyed by id) and `handles` (the handle under the entry's
 * id). Version 2 creates both from nothing; a version 1 store, whose records carried their
 * handles inline, is dropped unread rather than read (Recents never shipped with it). The
 * connection closes when another tab or a reset asks to upgrade or delete the database, and
 * reopens on the next use.
 */
export function indexedDbRecentsBackend(
  factory: IDBFactory = indexedDB,
  name: string = RECENTS_DB_NAME,
): RecentsBackend {
  let connection: Promise<IDBDatabase> | undefined;
  const db = (): Promise<IDBDatabase> => {
    connection ??= new Promise<IDBDatabase>((resolve, reject) => {
      const open = factory.open(name, RECENTS_DB_VERSION);
      open.onupgradeneeded = (event) => {
        // `objectStoreNames` is a snapshot: read it again after each change.
        const has = (store: string) => open.result.objectStoreNames.contains(store);
        if (event.oldVersion < 2 && has(RECENTS_STORE))
          open.result.deleteObjectStore(RECENTS_STORE);
        if (!has(RECENTS_STORE)) open.result.createObjectStore(RECENTS_STORE, { keyPath: 'id' });
        if (!has(HANDLES_STORE)) open.result.createObjectStore(HANDLES_STORE);
      };
      open.onsuccess = () => {
        const result = open.result;
        result.onversionchange = () => {
          result.close();
          connection = undefined;
        };
        result.onclose = () => {
          connection = undefined;
        };
        resolve(result);
      };
      open.onerror = () => reject(open.error ?? new Error('IndexedDB open failed'));
      open.onblocked = () => reject(new Error('IndexedDB open blocked'));
    }).catch((error: unknown) => {
      connection = undefined;
      throw error;
    });
    return connection;
  };
  const write = async (
    run: (entries: IDBObjectStore, handles: IDBObjectStore) => void,
  ): Promise<void> => {
    const tx = (await db()).transaction([RECENTS_STORE, HANDLES_STORE], 'readwrite');
    const done = transactionDone(tx);
    try {
      run(tx.objectStore(RECENTS_STORE), tx.objectStore(HANDLES_STORE));
    } catch (error) {
      // A handle that cannot be cloned throws here: nothing of this write may land.
      done.catch(() => undefined);
      tx.abort();
      throw error;
    }
    await done;
  };
  return {
    // Entries only: a stored handle is never deserialized here (see the module comment).
    list: async () =>
      request(
        (await db()).transaction(RECENTS_STORE, 'readonly').objectStore(RECENTS_STORE).getAll(),
      ),
    put: (entry) =>
      write((entries, handles) => {
        if (entry.handle !== undefined) handles.put(entry.handle, entry.id);
        else if (entry.handleStored !== true) handles.delete(entry.id);
        entries.put(withoutHandle(entry));
      }),
    remove: (id) =>
      write((entries, handles) => {
        entries.delete(id);
        handles.delete(id);
      }),
    clear: () =>
      write((entries, handles) => {
        entries.clear();
        handles.clear();
      }),
    readHandle: async (id): Promise<unknown> =>
      request<unknown>(
        (await db()).transaction(HANDLES_STORE, 'readonly').objectStore(HANDLES_STORE).get(id),
      ),
  };
}

function defaultBackend(): RecentsBackend {
  try {
    if (typeof indexedDB !== 'undefined') return indexedDbRecentsBackend();
  } catch {
    // IndexedDB refused: memory below.
  }
  return memoryRecentsBackend();
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface RecentsState {
  /** Newest first, at most `RECENTS_LIMIT`. */
  readonly entries: readonly RecentEntry[];
  readonly loaded: boolean;
  /** Session only: what reopening each entry needs (see `RecentAccess`). */
  readonly access: Readonly<Record<string, RecentAccess>>;
  readonly note: RecentNote | null;
  /** The last "Clear recents" emptied the list but not the copy stored on this device. */
  readonly clearFailed: boolean;
}

const INITIAL: RecentsState = {
  entries: [],
  loaded: false,
  access: {},
  note: null,
  clearFailed: false,
};

export const useRecentsStore = create<RecentsState>(() => INITIAL);

let backend: RecentsBackend | undefined;
let fallbackToMemory = true;
/** The stored backend a write failure switched away from: Clear and Remove still try it. */
let abandoned: RecentsBackend | undefined;
/** Bumped by every clear (and backend reset): reads and records begun earlier are void. */
let clears = 0;
let loading: Promise<void> | undefined;
/** Writes run one after another, so a cap never deletes what a later put just wrote. */
let queue: Promise<void> = Promise.resolve();

const store = (): RecentsBackend => (backend ??= defaultBackend());

/** Runs a backend write after the earlier ones; a failure switches to memory once. */
function enqueue(run: (target: RecentsBackend) => Promise<void>): Promise<void> {
  queue = queue
    .then(() => run(store()))
    .catch(() => {
      if (!fallbackToMemory) return;
      // IndexedDB failed (quota, storage disabled): keep the list for this tab instead.
      abandoned = backend;
      backend = memoryRecentsBackend(useRecentsStore.getState().entries);
      fallbackToMemory = false;
    });
  return queue;
}

/**
 * Uses `next` for storage from now on and forgets the loaded list (tests, and the reset
 * between test files). `memoryFallback: false` keeps a failing backend in place.
 */
export function setRecentsBackend(
  next: RecentsBackend | undefined,
  options: { readonly memoryFallback?: boolean } = {},
): void {
  backend = next;
  fallbackToMemory = options.memoryFallback ?? true;
  abandoned = undefined;
  clears += 1;
  loading = undefined;
  queue = Promise.resolve();
  useRecentsStore.setState(INITIAL);
}

const ids = (): string => globalThis.crypto.randomUUID();

async function probeAccess(entries: readonly RecentEntry[]): Promise<void> {
  const access: Record<string, RecentAccess> = {};
  await Promise.all(
    entries.map(async (entry) => {
      if (entry.handle === undefined) {
        // A stored handle is not read until the click, so its permission is not known yet;
        // after a reload the browser usually asks again.
        access[entry.id] = canReopenRecent(entry) ? 'prompt' : 'unavailable';
        return;
      }
      try {
        const state = (await entry.handle.queryPermission?.({ mode: 'read' })) ?? 'granted';
        access[entry.id] = state === 'denied' ? 'unavailable' : state;
      } catch {
        access[entry.id] = 'prompt';
      }
    }),
  );
  useRecentsStore.setState((s) => {
    // Entries cleared or removed while the probe ran get nothing.
    const kept = new Set(s.entries.map((entry) => entry.id));
    const probed = Object.fromEntries(Object.entries(access).filter(([id]) => kept.has(id)));
    return { access: { ...probed, ...s.access } };
  });
}

/**
 * Reads the stored list once per page (later calls share the first read). Invalid records
 * are skipped and deleted; a list over the cap loses its oldest entries. A read that a
 * "Clear recents" overtook shows nothing of what it read.
 */
export function loadRecents(): Promise<void> {
  loading ??= (async () => {
    const generation = clears;
    let records: readonly unknown[];
    try {
      records = await store().list();
    } catch {
      records = [];
    }
    if (clears !== generation) records = [];
    const valid: RecentEntry[] = [];
    const invalid: string[] = [];
    for (const record of records) {
      const entry = parseRecentEntry(record);
      if (entry !== null) valid.push(entry);
      else if (isRecord(record) && typeof record.id === 'string') invalid.push(record.id);
    }
    const sorted = sortRecents(valid);
    const over = sorted.splice(RECENTS_LIMIT).map((entry) => entry.id);
    // Entries recorded while the list was loading stay on top.
    const current = useRecentsStore.getState().entries;
    let merged = sorted;
    for (const entry of [...current].reverse()) {
      merged = addRecentEntry(merged, entry).entries;
    }
    useRecentsStore.setState({ entries: merged, loaded: true });
    const stale = [...invalid, ...over];
    if (stale.length > 0) {
      void enqueue(async (target) => {
        for (const id of stale) await target.remove(id);
      });
    }
    await probeAccess(merged);
  })();
  return loading;
}

function withoutKeys<T>(
  record: Readonly<Record<string, T>>,
  keys: readonly string[],
): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)));
}

export interface RecordRecentInput {
  readonly name: string;
  readonly size: number;
  readonly pages?: number;
  readonly handle?: RecentFileHandle;
  /** The entry this open came from (a reopen), replaced even if the size changed. */
  readonly replaces?: string;
  readonly now?: number;
}

/** Records that a file was opened: it moves to the top of Recents. */
export async function recordRecent(input: RecordRecentInput): Promise<RecentEntry | null> {
  if (input.name.length === 0 || !isCount(input.size)) return null;
  const entry: RecentEntry = {
    id: ids(),
    name: input.name.slice(0, MAX_NAME_LENGTH),
    size: input.size,
    ...(input.pages !== undefined && isCount(input.pages) && input.pages > 0
      ? { pages: input.pages }
      : {}),
    openedAt: input.now ?? Date.now(),
    ...(input.handle === undefined ? {} : { handle: input.handle }),
  };
  const generation = clears;
  await loadRecents();
  // Recents were cleared since this open: it is forgotten with the rest.
  if (clears !== generation) return null;
  const state = useRecentsStore.getState();
  const { entries, removed } = addRecentEntry(state.entries, entry, {
    ...(input.replaces === undefined ? {} : { replaces: input.replaces }),
  });
  const access = withoutKeys(state.access, removed);
  access[entry.id] = entry.handle === undefined ? 'unavailable' : 'granted';
  const note = state.note !== null && removed.includes(state.note.id) ? null : state.note;
  useRecentsStore.setState({ entries, access, note });
  await enqueue(async (target) => {
    try {
      await target.put(entry);
    } catch (error) {
      // A handle that cannot be stored (DataCloneError) still leaves the name.
      if (entry.handle === undefined) throw error;
      const { handle: _dropped, ...nameOnly } = entry;
      await target.put(nameOnly);
    }
    for (const id of removed) await target.remove(id);
  });
  return entry;
}

/** Removes one entry ("Remove from recents", Delete on a row). */
export async function removeRecent(id: string): Promise<void> {
  const state = useRecentsStore.getState();
  if (!state.entries.some((entry) => entry.id === id)) return;
  const access = withoutKeys(state.access, [id]);
  useRecentsStore.setState({
    entries: state.entries.filter((entry) => entry.id !== id),
    access,
    note: state.note?.id === id ? null : state.note,
  });
  await enqueue(async (target) => {
    await target.remove(id);
    // After a switch to memory the stored copy still holds it: try there too.
    const stored = abandoned;
    if (stored !== undefined && stored !== target) await stored.remove(id).catch(() => undefined);
  });
}

/**
 * Forgets every entry and handle ("Clear recents"), on screen at once and in storage. A
 * read or a record begun before it does not bring anything back. After a write failure
 * switched the list to memory, the stored database is cleared too, and used again once it
 * is. Resolves false when the copy stored on this device could not be cleared (the list on
 * screen is empty either way; `clearFailed` tells Home).
 */
export async function clearRecents(): Promise<boolean> {
  clears += 1;
  useRecentsStore.setState({ entries: [], access: {}, note: null, clearFailed: false });
  let cleared = false;
  await enqueue(async (target) => {
    await target.clear();
    const stored = abandoned;
    if (stored === undefined || stored === target) {
      cleared = true;
      return;
    }
    try {
      await stored.clear();
    } catch {
      return;
    }
    // Both are empty now: the stored database takes over again.
    cleared = true;
    backend = stored;
    abandoned = undefined;
    fallbackToMemory = true;
  });
  if (!cleared) useRecentsStore.setState({ clearFailed: true });
  return cleared;
}

/** Shows (or hides, with null) the one-line note under the list. */
export function setRecentNote(note: RecentNote | null): void {
  useRecentsStore.setState({ note });
}

export type ReopenResult =
  | { readonly ok: true; readonly file: File; readonly handle: RecentFileHandle }
  | { readonly ok: false; readonly reason: 'no-handle' | 'denied' | 'missing' };

/** The entry's handle: the one this session holds, else the stored one, read now. */
async function handleOf(entry: RecentEntry): Promise<RecentFileHandle | undefined> {
  if (entry.handle !== undefined) return entry.handle;
  if (!canReopenRecent(entry)) return undefined;
  try {
    const stored = await store().readHandle(entry.id);
    return isFileHandle(stored) ? stored : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads an entry's file through its handle, reading a stored handle first. Call it straight
 * from the click (no await before it): `requestPermission` needs the click's user
 * activation, which a short IndexedDB read keeps. A denied permission or a moved file marks
 * the entry `unavailable` for this session; a moved file also loses its stored handle.
 */
export async function reopenRecent(entry: RecentEntry): Promise<ReopenResult> {
  const handle = await handleOf(entry);
  if (handle === undefined) return { ok: false, reason: 'no-handle' };
  const setAccess = (value: RecentAccess) =>
    useRecentsStore.setState((s) => ({ access: { ...s.access, [entry.id]: value } }));
  try {
    let state = (await handle.queryPermission?.({ mode: 'read' })) ?? 'granted';
    if (state === 'prompt') state = (await handle.requestPermission?.({ mode: 'read' })) ?? state;
    if (state !== 'granted') {
      // Denied, or the prompt dismissed: the file dialog is the way back this session.
      setAccess('unavailable');
      return { ok: false, reason: 'denied' };
    }
  } catch {
    setAccess('unavailable');
    return { ok: false, reason: 'denied' };
  }
  try {
    const file = await handle.getFile();
    setAccess('granted');
    // Held for the rest of the session, so the next click does not read storage again.
    useRecentsStore.setState((s) => ({
      entries: s.entries.map((existing) =>
        existing.id === entry.id ? { ...existing, handle } : existing,
      ),
    }));
    return { ok: true, file, handle };
  } catch {
    // NotFoundError: moved, renamed or deleted. The handle is of no further use.
    setAccess('unavailable');
    const { handle: _gone, handleStored: _mark, ...rest } = entry;
    useRecentsStore.setState((s) => ({
      entries: s.entries.map((existing) => (existing.id === entry.id ? rest : existing)),
    }));
    void enqueue((target) => target.put(rest));
    return { ok: false, reason: 'missing' };
  }
}
