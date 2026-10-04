/**
 * Recents (docs/specs/craft.md §3.1, §14 answer 3; ADR-0019): the files opened lately, kept
 * on this device only and always clearable.
 *
 * Stored in IndexedDB, database `pdf-editor:recents:v1`, one record per entry
 * `{ id, name, size, pages?, openedAt, handle? }`, at most `RECENTS_LIMIT` (the oldest go
 * first). No file bytes and no thumbnails are stored. `handle` is the browser's
 * `FileSystemFileHandle`, kept only when the browser handed one out (Chromium's
 * `showOpenFilePicker` and a drop's `getAsFileSystemHandle()`); elsewhere an entry is a name
 * and the file is chosen again in the file dialog ("Open again…").
 *
 * Every record is checked field by field when read, so a damaged or foreign record is
 * skipped rather than shown. When IndexedDB cannot be opened (storage disabled, some private
 * windows) the list lives in memory until the tab closes.
 */
import { create } from 'zustand';

export const RECENTS_DB_NAME = 'pdf-editor:recents:v1';
const RECENTS_DB_VERSION = 1;
const RECENTS_STORE = 'entries';
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
  readonly handle?: RecentFileHandle;
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
  list(): Promise<readonly unknown[]>;
  put(entry: RecentEntry): Promise<void>;
  remove(id: string): Promise<void>;
  clear(): Promise<void>;
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
  const { id, name, size, pages, openedAt, handle } = value;
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
  };
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

export function memoryRecentsBackend(initial: readonly unknown[] = []): RecentsBackend {
  const records = new Map<string, unknown>();
  for (const record of initial) {
    const id = isRecord(record) && typeof record.id === 'string' ? record.id : undefined;
    if (id !== undefined) records.set(id, record);
  }
  return {
    list: () => Promise.resolve([...records.values()]),
    put: (entry) => {
      records.set(entry.id, entry);
      return Promise.resolve();
    },
    remove: (id) => {
      records.delete(id);
      return Promise.resolve();
    },
    clear: () => {
      records.clear();
      return Promise.resolve();
    },
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
 * The IndexedDB store. Version 1 creates the object store from nothing; a later version
 * adds its upgrade step here. The connection closes when another tab or a reset asks to
 * upgrade or delete the database, and reopens on the next use.
 */
export function indexedDbRecentsBackend(
  factory: IDBFactory = indexedDB,
  name: string = RECENTS_DB_NAME,
): RecentsBackend {
  let connection: Promise<IDBDatabase> | undefined;
  const db = (): Promise<IDBDatabase> => {
    connection ??= new Promise<IDBDatabase>((resolve, reject) => {
      const open = factory.open(name, RECENTS_DB_VERSION);
      open.onupgradeneeded = () => {
        if (!open.result.objectStoreNames.contains(RECENTS_STORE)) {
          open.result.createObjectStore(RECENTS_STORE, { keyPath: 'id' });
        }
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
  const write = async (run: (store: IDBObjectStore) => void): Promise<void> => {
    const tx = (await db()).transaction(RECENTS_STORE, 'readwrite');
    const done = transactionDone(tx);
    run(tx.objectStore(RECENTS_STORE));
    await done;
  };
  return {
    list: async () =>
      request(
        (await db()).transaction(RECENTS_STORE, 'readonly').objectStore(RECENTS_STORE).getAll(),
      ),
    put: (entry) => write((store) => store.put(entry)),
    remove: (id) => write((store) => store.delete(id)),
    clear: () => write((store) => store.clear()),
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
}

const INITIAL: RecentsState = { entries: [], loaded: false, access: {}, note: null };

export const useRecentsStore = create<RecentsState>(() => INITIAL);

let backend: RecentsBackend | undefined;
let fallbackToMemory = true;
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
        access[entry.id] = 'unavailable';
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
  useRecentsStore.setState((s) => ({ access: { ...access, ...s.access } }));
}

/**
 * Reads the stored list once per page (later calls share the first read). Invalid records
 * are skipped and deleted; a list over the cap loses its oldest entries.
 */
export function loadRecents(): Promise<void> {
  loading ??= (async () => {
    let records: readonly unknown[];
    try {
      records = await store().list();
    } catch {
      records = [];
    }
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
  await loadRecents();
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
      const { handle: _dropped, ...withoutHandle } = entry;
      await target.put(withoutHandle);
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
  await enqueue((target) => target.remove(id));
}

/** Forgets every entry and handle ("Clear recents"). */
export async function clearRecents(): Promise<void> {
  useRecentsStore.setState({ entries: [], access: {}, note: null });
  await enqueue((target) => target.clear());
}

/** Shows (or hides, with null) the one-line note under the list. */
export function setRecentNote(note: RecentNote | null): void {
  useRecentsStore.setState({ note });
}

export type ReopenResult =
  | { readonly ok: true; readonly file: File }
  | { readonly ok: false; readonly reason: 'no-handle' | 'denied' | 'missing' };

/**
 * Reads an entry's file through its handle. Call it straight from the click (no await
 * before it): `requestPermission` needs the click's user activation. A denied permission
 * or a moved file marks the entry `unavailable` for this session; a moved file also loses
 * its stored handle.
 */
export async function reopenRecent(entry: RecentEntry): Promise<ReopenResult> {
  const handle = entry.handle;
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
    return { ok: true, file };
  } catch {
    // NotFoundError: moved, renamed or deleted. The handle is of no further use.
    setAccess('unavailable');
    const { handle: _gone, ...rest } = entry;
    useRecentsStore.setState((s) => ({
      entries: s.entries.map((existing) => (existing.id === entry.id ? rest : existing)),
    }));
    void enqueue((target) => target.put(rest));
    return { ok: false, reason: 'missing' };
  }
}
