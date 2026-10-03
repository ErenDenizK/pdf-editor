/**
 * Glyph outlines for the paragraph editor's canvas (craft spec §4.7): `glyphPaths` reads the
 * page's font by its paragraph font id and returns em-unit outlines, null for a font id the
 * page does not have, and crosses the worker through the proxy.
 */
import type { SourceId } from '@pdf-editor/document-model';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import wordUrl from '../../../../test/fixtures/text-edit-corpus/word-tagged.pdf?url';
import { sid, wasmUrl } from '../../test/helpers';
import { createPdfiumProxy } from '../worker/pdfium-proxy';
import { createHarness, fixture, type Harness } from './test-helpers';

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h.adapter.destroy();
});

async function firstFontId(id: SourceId): Promise<number> {
  const blocks = await h.editor.analyzeParagraphs(id, 0);
  const fontId = blocks
    .flatMap((b) => b.lines.flatMap((l) => l.spans))
    .find((s) => s.fontId !== undefined)?.fontId;
  if (fontId === undefined) throw new Error('no font id');
  return fontId;
}

describe('glyphPaths', () => {
  test('returns em-unit outlines of the paragraph font', async () => {
    const id = await h.open(await fixture(wordUrl));
    const fontId = await firstFontId(id);
    const paths = await h.editor.glyphPaths(id, 0, fontId, ['e', ' ']);
    const e = paths.e;
    expect(e).toBeTruthy();
    expect(e?.[0]?.kind).toBe('move');
    // Em units: a lower-case letter sits within one em of its origin.
    for (const segment of e ?? []) {
      expect(Math.abs(segment.x)).toBeLessThan(1.5);
      expect(Math.abs(segment.y)).toBeLessThan(1.5);
    }
    const top = Math.max(...(e ?? []).map((s) => s.y));
    expect(top).toBeGreaterThan(0.3);
    // A space has no outline.
    expect(paths[' ']).toBeNull();
  });

  test('a font id the page does not have gives null outlines', async () => {
    const id = await h.open(await fixture(wordUrl));
    const paths = await h.editor.glyphPaths(id, 0, 9999, ['a']);
    expect(paths).toEqual({ a: null });
  });

  test('crosses the worker through the proxy', async () => {
    const worker = new Worker(new URL('../worker/pdfium.worker.ts', import.meta.url), {
      type: 'module',
      name: 'pdfium glyph paths test',
    });
    const proxy = createPdfiumProxy(worker, { wasmUrl });
    try {
      const id: SourceId = sid('glyph-paths-proxy');
      await proxy.open(id, await fixture(wordUrl));
      const blocks = await proxy.analyzeParagraphs(id, 0);
      const fontId = blocks.flatMap((b) => b.lines.flatMap((l) => l.spans))[0]?.fontId ?? 0;
      const paths = await proxy.glyphPaths(id, 0, fontId, ['o']);
      expect(paths.o?.length).toBeGreaterThan(3);
    } finally {
      await proxy.destroy();
    }
  });
});
