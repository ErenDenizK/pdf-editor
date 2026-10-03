/**
 * The rename to Recto (ADR-0015, presentation spec §7) changes the names people read, not
 * the names browsers store things under. Renaming a storage name would orphan what users
 * keep on their device (offline packs, recipes, settings), so ADR-0015 §3 keeps them. This
 * test pins those names, plus the display name, so a later search-and-replace cannot move
 * them by accident.
 */
import { RECIPE_FORMAT } from '@pdf-editor/document-model';
import { OCR_CACHE_NAME } from '@pdf-editor/engine';
import { describe, expect, it } from 'vitest';

import viteConfigSource from '../../../vite.config.ts?raw';
import recipesStoreSource from '../../batch/recipes-store.ts?raw';
import openFilesSource from '../../files/open-files.ts?raw';
import { PRODUCT_NAME, REPOSITORY_URL } from './build-info';

/** Every application source file (not tests, not generated messages), as text. */
const appSources = import.meta.glob<string>(
  ['../../**/*.{ts,tsx}', '!../../**/*.test.{ts,tsx}', '!../../i18n/paraglide/**'],
  {
    query: '?raw',
    import: 'default',
    eager: true,
  },
);

/** The quoted string literals in `source` that start with `prefix`. */
function literals(source: string, prefix: string): string[] {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`['"\`](${escaped}[^'"\`\\s]*)['"\`]`, 'g');
  return [...source.matchAll(pattern)].map((match) => match[1] ?? '');
}

describe('names kept by ADR-0015 §3', () => {
  it('shows the product as Recto', () => {
    expect(PRODUCT_NAME).toBe('Recto');
    expect(REPOSITORY_URL).toBe('https://github.com/ErenDenizK/recto');
  });

  it('keeps the three runtime Cache Storage names', () => {
    const cacheNames = [...viteConfigSource.matchAll(/cacheName:\s*'([^']+)'/g)].map(
      (match) => match[1],
    );
    expect(cacheNames).toEqual(['pdf-editor-ocr', 'pdf-editor-wasm', 'pdf-editor-fonts']);
    // The OCR pack loader writes the same cache the service worker reads.
    expect(OCR_CACHE_NAME).toBe('pdf-editor-ocr');
  });

  it('renames the manifest but not the description', () => {
    expect(viteConfigSource).toMatch(/\bname: 'Recto',/);
    expect(viteConfigSource).toMatch(/\bshort_name: 'Recto',/);
  });

  it('keeps the recipe store names: IndexedDB database and OPFS folder', () => {
    expect(recipesStoreSource).toMatch(/const DB_NAME = 'pdf-editor-recipes';/);
    expect(recipesStoreSource).toMatch(/getDirectoryHandle\('recipes'/);
  });

  it('keeps the recipe format identifier that shared recipe files carry', () => {
    expect(RECIPE_FORMAT).toBe('pdf-editor-recipe');
  });

  it('keeps the file-picker ids that remember folders', () => {
    expect(literals(openFilesSource, 'pdf-editor-').sort()).toEqual([
      'pdf-editor-images',
      'pdf-editor-open',
    ]);
  });

  it('keeps every persisted localStorage key under pdf-editor:', () => {
    expect(Object.keys(appSources).length).toBeGreaterThan(100);
    const keys = new Set<string>();
    for (const [file, source] of Object.entries(appSources)) {
      for (const key of literals(source, 'pdf-editor:')) keys.add(key);
      // A key under a new prefix would be a rename (ADR-0015 §3).
      expect(literals(source, 'recto:'), `${file} stores under recto:`).toEqual([]);
    }
    expect([...keys].sort()).toEqual([
      'pdf-editor:annotations:author-asked:v1',
      'pdf-editor:annotations:author:v1',
      'pdf-editor:appearance:v1',
      'pdf-editor:bates-last-number',
      'pdf-editor:dev:ink-stats',
      'pdf-editor:locale:v1',
      'pdf-editor:ui:pen-presets:v1',
      'pdf-editor:ui:pen-presets:v2',
      'pdf-editor:ui:tool-styles:v1',
      'pdf-editor:ui:tool-styles:v2',
      'pdf-editor:ui:v1',
      'pdf-editor:ui:v2',
      'pdf-editor:viewer:positions:v1',
    ]);
  });
});
