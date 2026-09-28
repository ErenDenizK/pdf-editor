/**
 * Saved recipes (ADR-0014 §3, spec §5 "Storage"): each recipe is a file in the origin
 * private file system (OPFS), `recipes/<id>.json`, holding exactly what "Export" writes
 * (`writeRecipe`: validated, canonical, secret-free), next to `recipes/<id>.meta.json` with
 * the save and last-use times (the recipe format has no room for them, by design). The
 * first save asks for persistent storage (`navigator.storage.persist()`), so the browser
 * does not evict the recipes under storage pressure.
 *
 * Backends, chosen once per page load:
 * - **OPFS** where `navigator.storage.getDirectory()` and `FileSystemFileHandle.createWritable()`
 *   exist on the main thread: Chromium (Chrome, Edge) 86+, Firefox 111+, Safari 26+.
 * - **IndexedDB** elsewhere (Safari before 26 has OPFS without `createWritable` outside
 *   workers; some private windows refuse OPFS): database `pdf-editor-recipes`, one record
 *   per recipe with the same text and times.
 * - **Memory** when neither opens (e.g. storage disabled): the recipes last until reload,
 *   and `persistent` is false so the UI can say so.
 *
 * Every write goes through `writeRecipe`, which refuses secrets (`assertNoSecrets`); reads
 * go through `readRecipe`, so a stored file edited by hand is checked like an import.
 * Built-in recipes (`BUILT_IN_RECIPES`) are listed first, read-only; "Duplicate" turns one
 * into a saved recipe.
 */
import {
  BUILT_IN_RECIPES,
  MAX_RECIPE_NAME_LENGTH,
  type Recipe,
  RecipeError,
  readRecipe,
  writeRecipe,
} from '@pdf-editor/document-model';

export type RecipeBackendKind = 'opfs' | 'indexeddb' | 'memory';

/** One stored recipe as the backend keeps it. */
export interface StoredRecipeRecord {
  readonly id: string;
  /** The recipe file's text (`writeRecipe`). */
  readonly text: string;
  readonly savedAt: number;
  readonly lastUsedAt?: number;
}

/** Where recipes live; tests pass their own. */
export interface RecipeBackend {
  readonly kind: RecipeBackendKind;
  list(): Promise<StoredRecipeRecord[]>;
  put(record: StoredRecipeRecord): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface RecipeListEntry {
  /** `builtin:<id>` for built-ins, else the stored id. */
  readonly id: string;
  readonly builtIn: boolean;
  /** Built-ins: the translation key (`BuiltInRecipe.id`). */
  readonly builtInId?: string;
  readonly recipe: Recipe;
  readonly savedAt?: number;
  readonly lastUsedAt?: number;
}

const BUILT_IN_PREFIX = 'builtin:';

export function isBuiltInId(id: string): boolean {
  return id.startsWith(BUILT_IN_PREFIX);
}

// ---------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------

export function memoryBackend(): RecipeBackend {
  const records = new Map<string, StoredRecipeRecord>();
  return {
    kind: 'memory',
    list: () => Promise.resolve([...records.values()]),
    put: (record) => {
      records.set(record.id, record);
      return Promise.resolve();
    },
    remove: (id) => {
      records.delete(id);
      return Promise.resolve();
    },
  };
}

interface Meta {
  readonly savedAt: number;
  readonly lastUsedAt?: number;
}

/** The directory handle's async iteration (DOM.AsyncIterable is not in the app's libs). */
interface IterableDirectory {
  keys(): AsyncIterable<string>;
}

async function readText(dir: FileSystemDirectoryHandle, name: string): Promise<string> {
  const handle = await dir.getFileHandle(name);
  return (await handle.getFile()).text();
}

async function writeText(dir: FileSystemDirectoryHandle, name: string, text: string) {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(text);
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => undefined);
    throw error;
  }
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function opfsBackend(dir: FileSystemDirectoryHandle): RecipeBackend {
  return {
    kind: 'opfs',
    list: async () => {
      const records: StoredRecipeRecord[] = [];
      for await (const name of (dir as unknown as IterableDirectory).keys()) {
        const match = /^([A-Za-z0-9_-]{1,64})\.json$/.exec(name);
        const id = match?.[1];
        if (id === undefined) continue;
        try {
          const text = await readText(dir, name);
          let meta: Meta = { savedAt: 0 };
          try {
            meta = JSON.parse(await readText(dir, `${id}.meta.json`)) as Meta;
          } catch {
            // No or unreadable times: the recipe still lists.
          }
          records.push({
            id,
            text,
            savedAt: typeof meta.savedAt === 'number' ? meta.savedAt : 0,
            ...(typeof meta.lastUsedAt === 'number' ? { lastUsedAt: meta.lastUsedAt } : {}),
          });
        } catch {
          // A file removed meanwhile.
        }
      }
      return records;
    },
    put: async (record) => {
      if (!SAFE_ID.test(record.id)) throw new Error('Invalid recipe id');
      await writeText(dir, `${record.id}.json`, record.text);
      const meta: Meta = {
        savedAt: record.savedAt,
        ...(record.lastUsedAt === undefined ? {} : { lastUsedAt: record.lastUsedAt }),
      };
      await writeText(dir, `${record.id}.meta.json`, JSON.stringify(meta));
    },
    remove: async (id) => {
      for (const name of [`${id}.json`, `${id}.meta.json`]) {
        await dir.removeEntry(name).catch(() => undefined);
      }
    },
  };
}

const DB_NAME = 'pdf-editor-recipes';
const DB_STORE = 'recipes';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

export async function indexedDbBackend(factory: IDBFactory = indexedDB): Promise<RecipeBackend> {
  const open = factory.open(DB_NAME, 1);
  open.onupgradeneeded = () => {
    if (!open.result.objectStoreNames.contains(DB_STORE)) {
      open.result.createObjectStore(DB_STORE, { keyPath: 'id' });
    }
  };
  const db = await request(open);
  const store = (mode: IDBTransactionMode) => db.transaction(DB_STORE, mode).objectStore(DB_STORE);
  return {
    kind: 'indexeddb',
    list: async () => (await request(store('readonly').getAll())) as StoredRecipeRecord[],
    put: async (record) => {
      await request(store('readwrite').put(record));
    },
    remove: async (id) => {
      await request(store('readwrite').delete(id));
    },
  };
}

/** The best backend this browser offers (see the module comment). */
export async function detectBackend(): Promise<RecipeBackend> {
  try {
    const storage = navigator.storage as StorageManager | undefined;
    const canWrite =
      typeof FileSystemFileHandle !== 'undefined' &&
      typeof (FileSystemFileHandle.prototype as Partial<FileSystemFileHandle>).createWritable ===
        'function';
    if (typeof storage?.getDirectory === 'function' && canWrite) {
      const root = await storage.getDirectory();
      return opfsBackend(await root.getDirectoryHandle('recipes', { create: true }));
    }
  } catch {
    // OPFS refused (private window, policy): try IndexedDB.
  }
  try {
    if (typeof indexedDB !== 'undefined') return await indexedDbBackend();
  } catch {
    // IndexedDB refused too.
  }
  return memoryBackend();
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export type ImportResult =
  | { readonly ok: true; readonly id: string; readonly recipe: Recipe }
  | { readonly ok: false; readonly error: RecipeError };

export interface RecipeStore {
  /** Which backend holds the saved recipes. */
  backend(): Promise<RecipeBackendKind>;
  /** Built-ins first (in their order), then saved recipes, most recently used first. */
  list(): Promise<RecipeListEntry[]>;
  /** Saves `recipe` (validated and secret-free) under `id`, or a new id; returns the id. */
  save(recipe: Recipe, id?: string): Promise<string>;
  rename(id: string, name: string): Promise<void>;
  /** A saved copy of a built-in or saved recipe, named "… (copy)" by `copyName`. */
  duplicate(id: string, copyName: (name: string) => string): Promise<string>;
  remove(id: string): Promise<void>;
  /** Records that a recipe ran now (the list's "last used"). */
  markUsed(id: string): Promise<void>;
  /** Reads a recipe file; a valid one is saved as a new recipe. */
  importText(text: string): Promise<ImportResult>;
  /** The recipe as a file (`writeRecipe`), for "Export". */
  exportText(id: string): Promise<{ readonly name: string; readonly text: string }>;
}

function newId(): string {
  return globalThis.crypto.randomUUID().replaceAll('-', '');
}

function builtInEntries(): RecipeListEntry[] {
  return BUILT_IN_RECIPES.map((b) => ({
    id: `${BUILT_IN_PREFIX}${b.id}`,
    builtIn: true,
    builtInId: b.id,
    recipe: b.recipe,
  }));
}

function clampName(name: string): string {
  const trimmed = name.trim();
  return trimmed.length > MAX_RECIPE_NAME_LENGTH
    ? trimmed.slice(0, MAX_RECIPE_NAME_LENGTH).trimEnd()
    : trimmed;
}

export function createRecipeStore(
  backendFactory: () => Promise<RecipeBackend> = detectBackend,
  options: { readonly now?: () => number; readonly persist?: () => Promise<unknown> } = {},
): RecipeStore {
  let backendPromise: Promise<RecipeBackend> | undefined;
  const backend = () => (backendPromise ??= backendFactory());
  const now = options.now ?? Date.now;
  let persistAsked = false;
  const persist = async () => {
    if (persistAsked) return;
    persistAsked = true;
    try {
      await (options.persist ?? (() => navigator.storage.persist()))();
    } catch {
      // Best effort: without it the recipes are still saved.
    }
  };

  const records = async () => {
    const all = await (await backend()).list();
    return new Map(all.map((r) => [r.id, r]));
  };
  const saved = async (id: string) => {
    const record = (await records()).get(id);
    if (record === undefined) throw new Error('Recipe not found');
    return record;
  };
  const recipeOf = async (id: string): Promise<Recipe> => {
    if (isBuiltInId(id)) {
      const found = BUILT_IN_RECIPES.find((b) => `${BUILT_IN_PREFIX}${b.id}` === id);
      if (found === undefined) throw new Error('Recipe not found');
      return found.recipe;
    }
    return readRecipe((await saved(id)).text);
  };
  const put = async (id: string, recipe: Recipe, keep?: StoredRecipeRecord) => {
    // writeRecipe validates and refuses secrets: nothing else is ever written.
    const text = writeRecipe(recipe);
    await (await backend()).put({
      id,
      text,
      savedAt: now(),
      ...(keep?.lastUsedAt === undefined ? {} : { lastUsedAt: keep.lastUsedAt }),
    });
    await persist();
  };

  return {
    backend: async () => (await backend()).kind,
    list: async () => {
      const entries: RecipeListEntry[] = [];
      for (const record of (await records()).values()) {
        try {
          entries.push({
            id: record.id,
            builtIn: false,
            recipe: readRecipe(record.text),
            savedAt: record.savedAt,
            ...(record.lastUsedAt === undefined ? {} : { lastUsedAt: record.lastUsedAt }),
          });
        } catch {
          // A stored file that no longer reads (edited by hand, a newer app's format) is
          // left alone rather than listed half-understood.
        }
      }
      entries.sort(
        (a, b) =>
          (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) ||
          (b.savedAt ?? 0) - (a.savedAt ?? 0) ||
          a.recipe.name.localeCompare(b.recipe.name),
      );
      return [...builtInEntries(), ...entries];
    },
    save: async (recipe, id) => {
      if (id !== undefined && isBuiltInId(id)) throw new Error('Built-in recipes are read-only');
      const target = id ?? newId();
      const keep = id === undefined ? undefined : (await records()).get(id);
      await put(target, recipe, keep);
      return target;
    },
    rename: async (id, name) => {
      if (isBuiltInId(id)) throw new Error('Built-in recipes are read-only');
      const record = await saved(id);
      const recipe = readRecipe(record.text);
      await put(id, { ...recipe, name: clampName(name) }, record);
    },
    duplicate: async (id, copyName) => {
      const recipe = await recipeOf(id);
      const target = newId();
      await put(target, { ...recipe, name: clampName(copyName(recipe.name)) });
      return target;
    },
    remove: async (id) => {
      if (isBuiltInId(id)) throw new Error('Built-in recipes are read-only');
      await (await backend()).remove(id);
    },
    markUsed: async (id) => {
      if (isBuiltInId(id)) return;
      const record = (await records()).get(id);
      if (record === undefined) return;
      await (await backend()).put({ ...record, lastUsedAt: now() });
    },
    importText: async (text) => {
      let recipe: Recipe;
      try {
        recipe = readRecipe(text);
      } catch (error) {
        if (error instanceof RecipeError) return { ok: false, error };
        throw error;
      }
      const id = newId();
      await put(id, recipe);
      return { ok: true, id, recipe };
    },
    exportText: async (id) => {
      const recipe = await recipeOf(id);
      return { name: recipe.name, text: writeRecipe(recipe) };
    },
  };
}

let instance: RecipeStore | undefined;

/** The app's recipe store (backend detected on first use). */
export function getRecipeStore(): RecipeStore {
  instance ??= createRecipeStore();
  return instance;
}
