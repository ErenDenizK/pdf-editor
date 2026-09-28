/**
 * Workspace store lifetimes (Vitest browser mode, real PDFium): sources and image blobs
 * that an operation is still preparing are protected from garbage collection by the
 * operation that created them, and only by it, while other operations commit.
 */
import {
  type BlobId,
  createSequentialIdGenerator,
  createWorkspace,
  getDocument,
  type ImageOverlay,
  insertImagePage,
  newEmptyDocument,
  setDocumentFurniture,
  type SourceId,
} from '@pdf-editor/document-model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import outlineUrl from '../../../../test/fixtures/outline-named-dests.pdf?url';
import simpleUrl from '../../../../test/fixtures/simple-text.pdf?url';
import { deferred, fixtureFile, gateEngine, pngBlob } from '../../test/store-harness';
import { getEngineService, RENDER_PRIORITY } from '../engine/engine-service';
import { blobsOfDocument, resetWorkspace, useWorkspaceStore } from './workspace-store';

const model = () => useWorkspaceStore.getState();
const fileNames = () => Object.values(model().files).map((f) => f.name);

/** The source is usable: its bytes are kept for export and a thumbnail renders. */
async function expectUsable(id: SourceId): Promise<void> {
  const service = getEngineService();
  expect((await service.sourceBytes(id)).ok).toBe(true);
  const render = await service.renderPage({
    sourceId: id,
    index: 0,
    rotation: 0,
    bucket: 0.25,
    priority: RENDER_PRIORITY.page,
  });
  expect(render.ok).toBe(true);
}

describe('workspace store: protection of work in progress', () => {
  beforeEach(() => {
    resetWorkspace();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetWorkspace();
  });

  it('an image insert that finishes first never releases PDFs another operation is opening', async () => {
    const engine = gateEngine(['a.pdf', 'b.pdf']);
    // Two PDFs dropped on the tab bar start opening …
    const opening = model().openFiles([
      await fixtureFile(simpleUrl, 'a.pdf'),
      await fixtureFile(outlineUrl, 'b.pdf'),
    ]);
    // … an image insert starts meanwhile (its sizing question keeps the prelude running) …
    const answered = deferred();
    const blob = await pngBlob('photo.png');
    let stored: BlobId | undefined;
    const inserting = model().applyComposed(
      async (lease) => {
        stored = model().addBlob(blob, lease);
        await answered.promise;
        return stored;
      },
      (ws, ids, id) => {
        const made = newEmptyDocument(ws, ids, { title: 'photo' });
        return insertImagePage(
          made.workspace,
          { document: made.documentId, index: 0, blob: id, size: { width: 120, height: 80 } },
          ids,
        );
      },
      'Insert photo.png',
    );
    // … a.pdf finishes opening (registered, not committed yet: b.pdf is still opening) …
    engine.release('a.pdf');
    await vi.waitFor(
      () => {
        expect(fileNames()).toContain('a.pdf');
      },
      { timeout: 10_000 },
    );
    // … and the image insert commits first.
    answered.resolve();
    expect(await inserting).toBe(true);
    expect(engine.closed).toEqual([]);
    expect(fileNames()).toContain('a.pdf');

    engine.release('b.pdf');
    const report = await opening;
    expect(report.opened.map((o) => o.name)).toEqual(['a.pdf', 'b.pdf']);
    expect(report.skipped).toEqual([]);
    expect(engine.closed).toEqual([]);
    const sources = Object.keys(model().workspace.sources) as SourceId[];
    expect(sources).toHaveLength(2);
    for (const id of sources) await expectUsable(id);
    expect(stored !== undefined && model().blobs[stored] !== undefined).toBe(true);
  });

  it('PDFs opened by one operation stay open while another one commits and collects', async () => {
    const engine = gateEngine(['late.pdf']);
    const report = await model().openFiles([await fixtureFile(simpleUrl, 'first.pdf')]);
    const firstId = report.opened[0]?.documentId;
    const first = firstId === undefined ? undefined : model().workspace.documents[firstId];
    const pageId = first?.pages[0]?.id;
    if (pageId === undefined) throw new Error('first.pdf did not open');

    let loadedId: SourceId | undefined;
    const answered = deferred();
    const composed = model().applyComposed(
      async (lease) => {
        const { loaded } = await model().loadSources(
          [await fixtureFile(outlineUrl, 'late.pdf')],
          lease,
        );
        loadedId = loaded[0]?.source.id;
        await answered.promise;
        return loaded[0]?.source;
      },
      (ws) => ws, // commits nothing: the source must still be released afterwards
      'Nothing',
    );
    const id = await engine.opened('late.pdf');
    // Other commits run garbage collection while late.pdf is loading.
    expect(model().rotatePages([pageId], 90)).toBe(true);
    engine.release('late.pdf');
    await vi.waitFor(() => {
      expect(loadedId).toBe(id);
    });
    expect(model().rotatePages([pageId], 90)).toBe(true);
    expect(engine.closed).not.toContain(id);
    expect(fileNames()).toContain('late.pdf');
    answered.resolve();
    // The owner gave up (nothing committed): now, and only now, the source is closed.
    expect(await composed).toBe(false);
    expect(engine.closed).toEqual([id]);
    expect(fileNames()).toEqual(['first.pdf']);
  });

  it('a blob added by a prelude that is cancelled is dropped with it', async () => {
    const blob = await pngBlob('cancelled.png');
    let stored: BlobId | undefined;
    const committed = await model().applyComposed(
      (lease) => {
        stored = model().addBlob(blob, lease);
        return Promise.resolve(undefined);
      },
      (ws) => ws,
      'Never',
    );
    expect(committed).toBe(false);
    expect(stored).toBeDefined();
    expect(model().blobs).toEqual({});
  });
});

describe('blobs a document needs at export', () => {
  it('include an image watermark in the document-level furniture', () => {
    const ids = createSequentialIdGenerator('t');
    const made = newEmptyDocument(createWorkspace(), ids, { title: 'stamped' });
    const withPage = insertImagePage(
      made.workspace,
      {
        document: made.documentId,
        index: 0,
        blob: 'page-blob' as BlobId,
        size: { width: 120, height: 80 },
      },
      ids,
    );
    const watermark: ImageOverlay = {
      kind: 'image',
      layer: 'over',
      blob: 'watermark-blob' as BlobId,
      anchor: 'center',
      offset: { x: 0, y: 0 },
      scale: 0.5,
      opacity: 0.3,
      role: 'watermark',
    };
    const ws = setDocumentFurniture(withPage, made.documentId, [watermark]);
    expect([...blobsOfDocument(getDocument(ws, made.documentId))].sort()).toEqual([
      'page-blob',
      'watermark-blob',
    ]);
  });
});
