/**
 * Recipe storage: the list (built-ins first, read-only), save, rename, duplicate, delete,
 * last used, import with the reader's precise errors, export, and the three backends
 * (OPFS and IndexedDB in this Chromium, memory). Everything written to a backend is a
 * recipe file that `assertNoSecrets` accepts, even after a run with a password.
 */
import {
  assertNoSecrets,
  BUILT_IN_RECIPES,
  isRecipeError,
  RECIPE_FORMAT,
  RECIPE_VERSION,
  type Recipe,
  readRecipe,
} from '@pdf-editor/document-model';
import { describe, expect, it } from 'vitest';

import { recipeErrorText } from './labels';
import {
  createRecipeStore,
  indexedDbBackend,
  memoryBackend,
  opfsBackend,
  type RecipeBackend,
  type StoredRecipeRecord,
} from './recipes-store';
import { buildZip, crc32, zipEntry } from './zip';

/** A backend that records every write. */
function recording(inner: RecipeBackend = memoryBackend()): {
  backend: RecipeBackend;
  writes: StoredRecipeRecord[];
} {
  const writes: StoredRecipeRecord[] = [];
  return {
    writes,
    backend: {
      kind: inner.kind,
      list: () => inner.list(),
      put: async (record) => {
        writes.push(record);
        await inner.put(record);
      },
      remove: (id) => inner.remove(id),
    },
  };
}

const shareSafely = BUILT_IN_RECIPES.find((b) => b.id === 'share-safely')?.recipe as Recipe;

function storeWith(backend: RecipeBackend, clock = { t: 1000 }) {
  return createRecipeStore(() => Promise.resolve(backend), {
    now: () => ++clock.t,
    persist: () => Promise.resolve(true),
  });
}

describe('recipe store', () => {
  it('lists built-ins read-only and keeps saved recipes, secret-free, through every operation', async () => {
    const { backend, writes } = recording();
    const store = storeWith(backend);
    const list = await store.list();
    expect(list.map((e) => e.id)).toEqual(BUILT_IN_RECIPES.map((b) => `builtin:${b.id}`));
    expect(list.every((e) => e.builtIn)).toBe(true);
    await expect(store.remove('builtin:number-pages')).rejects.toThrow(/read-only/);
    await expect(store.rename('builtin:number-pages', 'x')).rejects.toThrow(/read-only/);

    const copy = await store.duplicate('builtin:share-safely', (name) => `${name} (copy)`);
    const mine = await store.save({ ...shareSafely, name: 'Mine' });
    await store.rename(mine, '  Renamed  ');
    await store.markUsed(copy);
    const saved = (await store.list()).filter((e) => !e.builtIn);
    // Most recently used first.
    expect(saved.map((e) => e.recipe.name)).toEqual(['Share safely (copy)', 'Renamed']);
    expect(saved[0]?.lastUsedAt).toBeGreaterThan(0);
    expect(saved[0]?.recipe.steps).toEqual(shareSafely.steps);

    const exported = await store.exportText(copy);
    expect(readRecipe(exported.text)).toEqual({ ...shareSafely, name: 'Share safely (copy)' });

    await store.remove(mine);
    expect((await store.list()).filter((e) => !e.builtIn)).toHaveLength(1);

    // A run of this recipe used this password; nothing stored may contain it.
    const password = 'Batch-Secret-7788';
    expect(writes.length).toBeGreaterThan(3);
    for (const record of writes) assertNoSecrets(record.text, [password]);
    // The store refuses to write a recipe that carries a secret.
    const smuggled = {
      ...shareSafely,
      steps: [{ kind: 'security', options: { ...shareSafely.steps[2]?.options, password } }],
    } as unknown as Recipe;
    await expect(store.save(smuggled)).rejects.toSatisfy((e) => isRecipeError(e, 'secret'));
    for (const record of writes) assertNoSecrets(record.text, [password]);
  });

  it('imports recipe files and explains precisely what is wrong with bad ones', async () => {
    const store = storeWith(memoryBackend());
    const good = await store.importText(
      JSON.stringify({
        format: RECIPE_FORMAT,
        version: RECIPE_VERSION,
        name: 'Imported',
        steps: [{ kind: 'flatten', options: { annotations: true, forms: false } }],
      }),
    );
    expect(good.ok).toBe(true);
    expect((await store.list()).some((e) => e.recipe.name === 'Imported')).toBe(true);

    const bad = async (value: unknown) => {
      const result = await store.importText(
        typeof value === 'string' ? value : JSON.stringify(value),
      );
      if (result.ok) throw new Error('imported');
      return result.error;
    };
    const base = { format: RECIPE_FORMAT, version: RECIPE_VERSION, name: 'x' };
    expect((await bad('{not json')).problem).toBe('not-json');
    expect((await bad({ ...base, format: 'other' })).problem).toBe('not-recipe');
    const newer = await bad({ ...base, version: 99, steps: [] });
    expect(newer.problem).toBe('newer-version');
    expect(recipeErrorText(newer)).toMatch(/format 99/);
    const unknownKey = await bad({
      ...base,
      steps: [
        { kind: 'rotate', options: { quarterTurns: 1, pages: 'all' } },
        {
          kind: 'compress',
          options: { preset: 'ebook', images: true, flattenAlpha: false, speed: 2 },
        },
      ],
    });
    expect(unknownKey).toMatchObject({ problem: 'unknown-key', stepIndex: 1, key: 'speed' });
    expect(recipeErrorText(unknownKey)).toBe(
      'Step 2 (Compress): unknown option “speed” ($.steps[1].options.speed).',
    );
    const secret = await bad({
      ...base,
      steps: [{ kind: 'security', options: { requirePassword: true, userPassword: 'x' } }],
    });
    expect(secret.problem).toBe('secret');
    expect(recipeErrorText(secret)).not.toContain('"x"');
    // Nothing bad was stored.
    expect((await store.list()).filter((e) => !e.builtIn)).toHaveLength(1);
  });

  it('stores in OPFS and IndexedDB in this browser', async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(`recipes-test-${Date.now()}`, { create: true });
    for (const backend of [opfsBackend(dir), await indexedDbBackend()]) {
      const store = storeWith(backend);
      const id = await store.save({ ...shareSafely, name: `On ${backend.kind}` });
      await store.markUsed(id);
      const entry = (await store.list()).find((e) => e.id === id);
      expect(entry?.recipe.name).toBe(`On ${backend.kind}`);
      expect(entry?.lastUsedAt).toBeGreaterThan(0);
      await store.remove(id);
      expect((await store.list()).find((e) => e.id === id)).toBeUndefined();
    }
    await root.removeEntry(dir.name, { recursive: true });
  });
});

describe('ZIP writer', () => {
  it('writes stored entries a reader can walk, with correct checksums', async () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    const a = new TextEncoder().encode('first file');
    const b = new TextEncoder().encode('ğüşiöç – second');
    const zip = buildZip([zipEntry('a.pdf', a.buffer), zipEntry('ğ ü.pdf', b.buffer)]);
    const bytes = new Uint8Array(await zip.arrayBuffer());
    const view = new DataView(bytes.buffer);
    // End of central directory: two entries.
    const end = bytes.length - 22;
    expect(view.getUint32(end, true)).toBe(0x06054b50);
    expect(view.getUint16(end + 10, true)).toBe(2);
    let offset = 0;
    const names: string[] = [];
    const bodies: string[] = [];
    while (view.getUint32(offset, true) === 0x04034b50) {
      const size = view.getUint32(offset + 18, true);
      const nameLength = view.getUint16(offset + 26, true);
      const name = new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + nameLength));
      const body = bytes.subarray(offset + 30 + nameLength, offset + 30 + nameLength + size);
      expect(view.getUint32(offset + 14, true)).toBe(crc32(body));
      names.push(name);
      bodies.push(new TextDecoder().decode(body));
      offset += 30 + nameLength + size;
    }
    expect(names).toEqual(['a.pdf', 'ğ ü.pdf']);
    expect(bodies).toEqual(['first file', 'ğüşiöç – second']);
  });
});
