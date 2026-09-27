/**
 * OS files dropped on a light-table section (Vitest browser mode, real PDFium): image
 * bytes survive commits made while the drop is still opening its PDFs, a section that
 * closes meanwhile does not swallow the files, and a dropped PDF's bookmarks come along.
 */
import { countNodes, type DocumentId, type PageId } from '@pdf-editor/document-model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import outlineUrl from '../../../../test/fixtures/outline-named-dests.pdf?url';
import simpleUrl from '../../../../test/fixtures/simple-text.pdf?url';
import { fixtureFile, gateEngine, pngFile } from '../../test/store-harness';
import { prepareExport } from '../export/export-service';
import { useAnnouncer } from '../shell/announcer';
import { resetWorkspace, useWorkspaceStore } from '../state/workspace-store';
import { insertFilesAt } from './drop';

const model = () => useWorkspaceStore.getState();
const ws = () => model().workspace;
const doc = (id: DocumentId) => ws().documents[id];
const titles = () => ws().documentOrder.map((id) => ws().documents[id]?.title);

async function openSimple(): Promise<{ id: DocumentId; pages: PageId[] }> {
  const report = await model().openFiles([await fixtureFile(simpleUrl, 'simple-text.pdf')]);
  const id = report.opened[0]?.documentId;
  if (id === undefined) throw new Error('simple-text.pdf did not open');
  return { id, pages: doc(id)?.pages.map((p) => p.id) ?? [] };
}

describe('insertFilesAt', () => {
  beforeEach(() => {
    resetWorkspace();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetWorkspace();
  });

  it('keeps image bytes created during the drop when another edit commits meanwhile', async () => {
    const { id, pages } = await openSimple();
    const engine = gateEngine(['late.pdf']);
    const dropping = insertFilesAt(
      [await pngFile('photo.png'), await fixtureFile(outlineUrl, 'late.pdf')],
      { document: id, index: 1 },
    );
    // The image is decoded and stored while the PDF is still opening …
    await engine.opened('late.pdf');
    await vi.waitFor(() => {
      expect(Object.keys(model().blobs)).toHaveLength(1);
    });
    // … and an unrelated rotate commits (and collects garbage) in that window.
    expect(model().rotatePages([pages[0] as PageId], 90)).toBe(true);
    expect(Object.keys(model().blobs)).toHaveLength(1);
    engine.release('late.pdf');

    const placed = await dropping;
    expect(placed).toHaveLength(7);
    const image = doc(id)?.pages.find((p) => p.ref.kind === 'image');
    if (image?.ref.kind !== 'image') throw new Error('no image page');
    expect(model().blobs[image.ref.blob]).toBeDefined();
    const exported = await prepareExport(id);
    if (!exported.ok) throw new Error(exported.error.message);
    expect(exported.value.pageCount).toBe(10);
  });

  it('opens the files as new tabs when the section closes while they open', async () => {
    const { id } = await openSimple();
    const engine = gateEngine(['late.pdf']);
    const dropping = insertFilesAt(
      [await fixtureFile(outlineUrl, 'late.pdf'), await pngFile('photo.png')],
      { document: id, index: 0 },
    );
    await engine.opened('late.pdf');
    model().closeDocument(id);
    expect(ws().documentOrder).toEqual([]);
    engine.release('late.pdf');

    const placed = await dropping;
    expect(titles()).toEqual(['late', 'photo']);
    expect(placed).toHaveLength(7);
    expect(ws().activeDocument).toBe(ws().documentOrder[0]);
    expect(model().history.present.label).toBe('Open 2 files');
    expect(useAnnouncer.getState().message).toBe(
      'The section closed while the files were opening; opened 2 files in new tabs',
    );
    // One undo step removes both tabs again.
    model().undo();
    expect(ws().documentOrder).toEqual([]);
  });

  it("carries a dropped PDF's bookmarks under a node named after the file", async () => {
    const { id } = await openSimple();
    const before = doc(id)?.outline ?? [];
    const placed = await insertFilesAt([await fixtureFile(outlineUrl, 'outline-named-dests.pdf')], {
      document: id,
      index: 1,
    });
    expect(placed).toHaveLength(6);
    const outline = doc(id)?.outline ?? [];
    expect(outline.slice(0, before.length)).toEqual(before);
    const wrapper = outline[before.length];
    expect(wrapper?.title).toBe('outline-named-dests.pdf');
    expect(wrapper?.destination).toEqual({ kind: 'page', page: placed[0] });
    const carried = countNodes(wrapper?.children ?? []);
    expect(carried).toBeGreaterThan(0);
    // Every carried page target is one of the inserted pages.
    const targets: PageId[] = [];
    const walk = (nodes: typeof outline) => {
      for (const node of nodes) {
        if (node.destination?.kind === 'page') targets.push(node.destination.page);
        walk(node.children);
      }
    };
    walk(wrapper?.children ?? []);
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.every((page) => placed.includes(page))).toBe(true);
    expect(useAnnouncer.getState().message).toBe(
      `Inserted 6 pages and ${carried} bookmarks from outline-named-dests.pdf at position 2 in simple-text`,
    );
    // One history entry: undo restores the outline as it was.
    model().undo();
    expect(doc(id)?.outline).toEqual(before);
  });
});
