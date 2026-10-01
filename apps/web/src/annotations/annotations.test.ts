/**
 * Annotation edits through the real engine (Vitest browser mode, PDFium): creation,
 * history (undo / redo re-apply through the engine and keep the /NM), coalescing, and
 * coordinates on rotated pages.
 */
import {
  getActiveDocument,
  historyEntries,
  type PageId,
  type SourceId,
} from '@pdf-editor/document-model';
import { PDFArray, PDFDict, PDFDocument, PDFName, type PDFNumber } from '@cantoo/pdf-lib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import annotationsUrl from '../../../../test/fixtures/annotations.pdf?url';
import rotatedUrl from '../../../../test/fixtures/rotated-pages.pdf?url';
import simpleUrl from '../../../../test/fixtures/simple-text.pdf?url';
import { fixtureFile } from '../../test/store-harness';
import { getEngineService } from '../engine/engine-service';
import { resetWorkspace, useWorkspaceStore } from '../state/workspace-store';
import { createAnnotations, deleteAnnotations, updateAnnotations } from './actions';
import { type PageTarget, resetAnnotationStore } from './annotation-store';
import { annotationIds, readAnnotations, resetEditRunner, whenIdle } from './edit-runner';
import { cssBoxToUser } from './geometry';
import { pageText } from './page-text';
import { glyphIndexAt, quadsForRange } from './quads';

const model = () => useWorkspaceStore.getState();

async function open(url: string, name: string): Promise<{ source: SourceId; pages: PageId[] }> {
  const report = await model().openFiles([await fixtureFile(url, name)]);
  expect(report.skipped).toEqual([]);
  const doc = getActiveDocument(model().workspace);
  if (!doc) throw new Error('no document');
  const first = doc.pages[0];
  if (first?.ref.kind !== 'source') throw new Error('not a source page');
  return { source: first.ref.source, pages: doc.pages.map((p) => p.id) };
}

function target(source: SourceId, pages: PageId[], pageIndex: number): PageTarget {
  return { source, pageIndex, pageId: pages[pageIndex] as PageId, position: pageIndex + 1 };
}

/** What the engine itself reports (engine ids, not the ids the UI shows). */
async function rawList(source: SourceId, pageIndex: number) {
  return (await getEngineService().editor()).listAnnotations(source, pageIndex);
}

function labels(): string[] {
  return historyEntries(model().history).map((e) => e.label);
}

describe('annotations through the engine', () => {
  beforeEach(() => {
    resetWorkspace();
    resetEditRunner();
    resetAnnotationStore();
  });
  afterEach(async () => {
    await whenIdle();
    resetWorkspace();
  });

  it('creates a highlight from text quads; the engine lists it with its quads', async () => {
    const { source, pages } = await open(simpleUrl, 'simple.pdf');
    const runs = await pageText(source, 0);
    const first = runs[0];
    if (!first) throw new Error('no text');
    const g0 = first.glyphs[0]?.rect;
    const g1 = first.glyphs[first.glyphs.length - 1]?.rect;
    if (!g0 || !g1) throw new Error('no glyphs');
    const from = glyphIndexAt(runs, { x: g0.x + 1, y: g0.y + 1 });
    const to = glyphIndexAt(runs, { x: g1.x + 1, y: g1.y + 1 });
    const quads = quadsForRange(runs, from, to);
    expect(quads).toHaveLength(1);
    const created = await createAnnotations(target(source, pages, 0), [
      {
        kind: 'highlight',
        pageIndex: 0,
        quads,
        rect: quads[0] as (typeof quads)[number],
        color: '#FFEB3B',
        opacity: 1,
      },
    ]);
    expect(created).toHaveLength(1);
    const listed = await readAnnotations(source, 0);
    const highlight = listed.find((a) => a.kind === 'highlight');
    expect(highlight?.kind === 'highlight' && highlight.quads).toHaveLength(1);
    const q = highlight?.kind === 'highlight' ? highlight.quads[0] : undefined;
    expect(q?.x).toBeCloseTo(quads[0]?.x ?? 0, 1);
    expect(q?.width).toBeCloseTo(quads[0]?.width ?? 0, 1);
    expect(labels()).toContain('Highlight on page 1');
    expect(model().dirtySources.has(source)).toBe(true);

    // The saved file carries /QuadPoints in the order UL, UR, LL, LR.
    const saved = await getEngineService().saveSource(source);
    if (!saved.ok) throw new Error(saved.error.message);
    const pdf = await PDFDocument.load(saved.value);
    const annots = pdf.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
    const dict = annots
      .asArray()
      .map((ref) => pdf.context.lookup(ref, PDFDict))
      .find((d) => d.get(PDFName.of('Subtype'))?.toString() === '/Highlight');
    const points = dict
      ?.lookup(PDFName.of('QuadPoints'), PDFArray)
      .asArray()
      .map((n) => (n as PDFNumber).asNumber());
    if (!points || !q) throw new Error('no QuadPoints');
    const [x1, y1, x2, y2, x3, y3, x4, y4] = points;
    expect(x1).toBeCloseTo(q.x, 0);
    expect(y1).toBeCloseTo(q.y + q.height, 0);
    expect(x2).toBeCloseTo(q.x + q.width, 0);
    expect(y2).toBeCloseTo(q.y + q.height, 0);
    expect(x3).toBeCloseTo(q.x, 0);
    expect(y3).toBeCloseTo(q.y, 0);
    expect(x4).toBeCloseTo(q.x + q.width, 0);
    expect(y4).toBeCloseTo(q.y, 0);
  });

  it('ink: create, delete, undo restores the stroke with the same /NM; redo deletes it', async () => {
    const { source, pages } = await open(simpleUrl, 'simple.pdf');
    const t = target(source, pages, 0);
    const path = [
      { x: 100, y: 400 },
      { x: 150, y: 450 },
      { x: 200, y: 400 },
    ];
    const created = await createAnnotations(t, [
      {
        kind: 'ink',
        pageIndex: 0,
        paths: [path],
        rect: { x: 99, y: 399, width: 102, height: 52 },
        strokeWidth: 2,
        color: '#E53935',
      },
    ]);
    const id = created?.[0]?.id;
    if (!id) throw new Error('not created');
    expect(await deleteAnnotations(t, [id])).toBe(1);
    expect((await readAnnotations(source, 0)).some((a) => a.id === id)).toBe(false);
    expect(labels().at(-1)).toMatch(/^Delete (ink|pen)$/);

    model().undo();
    await whenIdle();
    const restored = (await readAnnotations(source, 0)).find((a) => a.id === id);
    expect(restored?.kind).toBe('ink');
    expect(restored?.kind === 'ink' && restored.paths[0]).toEqual(path);
    // The engine writes the original /NM (or, if it cannot, the id map says so).
    const raw = await rawList(source, 0);
    const engineId = annotationIds.engineId(source, id);
    expect(raw.some((a) => a.id === engineId)).toBe(true);
    expect(engineId).toBe(id);

    model().redo();
    await whenIdle();
    expect((await readAnnotations(source, 0)).some((a) => a.id === id)).toBe(false);
    // Undo twice: the stroke comes back, then the create is undone too.
    model().undo();
    model().undo();
    await whenIdle();
    expect((await readAnnotations(source, 0)).some((a) => a.kind === 'ink')).toBe(false);
  });

  it('free text: consecutive edits with one coalescing key are one history entry', async () => {
    const { source, pages } = await open(simpleUrl, 'simple.pdf');
    const t = target(source, pages, 0);
    const created = await createAnnotations(t, [
      {
        kind: 'free-text',
        pageIndex: 0,
        rect: { x: 72, y: 500, width: 200, height: 20 },
        text: 'First',
        fontSize: 12,
        textColor: '#000000',
      },
    ]);
    const id = created?.[0]?.id;
    if (!id) throw new Error('not created');
    const before = labels().length;
    for (const size of [14, 16, 18]) {
      await updateAnnotations(
        t,
        [id],
        (a) => (a.kind === 'free-text' ? { ...a, fontSize: size } : undefined),
        { action: 'font', coalesceKey: `font:${id}` },
      );
    }
    expect(labels().length).toBe(before + 1);
    expect(labels().at(-1)).toBe('Change text box font size');
    // One merged edit in the log, whose inverse is the state before the first change.
    const edits = model().workspace.engineEdits;
    expect(edits).toHaveLength(2);
    const now = (await readAnnotations(source, 0)).find((a) => a.id === id);
    expect(now?.kind === 'free-text' && now.fontSize).toBe(18);

    model().undo();
    await whenIdle();
    const undone = (await readAnnotations(source, 0)).find((a) => a.id === id);
    expect(undone?.kind === 'free-text' && undone.fontSize).toBe(12);
    expect(undone?.kind === 'free-text' && undone.text).toBe('First');
  });

  it('a rectangle drawn on a /Rotate 90 page lands at the expected user-space rect', async () => {
    const { source, pages } = await open(rotatedUrl, 'rotated.pdf');
    const service = getEngineService();
    const crop = service.pageCropBox(source, 1);
    // rotated-pages.pdf page 2: A4 portrait with /Rotate 90, shown landscape.
    const frame = {
      size: { width: 595.28, height: 841.89 },
      originX: crop?.x ?? 0,
      originY: crop?.y ?? 0,
      rotation: 90 as const,
      scale: 1,
    };
    // Drawn from CSS (200, 100) to (280, 140) on the displayed page.
    const rect = cssBoxToUser(frame, { left: 200, top: 100, width: 80, height: 40 });
    expect(rect).toEqual({ x: 100, y: 200, width: 40, height: 80 });
    await createAnnotations(target(source, pages, 1), [
      {
        kind: 'square',
        pageIndex: 1,
        rect,
        strokeWidth: 2,
        color: '#E53935',
        interiorColor: '#E53935',
      },
    ]);
    const square = (await readAnnotations(source, 1)).find((a) => a.kind === 'square');
    expect(square?.rect.x).toBeCloseTo(100, 1);
    expect(square?.rect.y).toBeCloseTo(200, 1);
    expect(square?.rect.width).toBeCloseTo(40, 1);
    expect(square?.rect.height).toBeCloseTo(80, 1);
    // And PDFium draws it under the CSS box it was drawn in.
    const bitmap = await service.renderPage({
      sourceId: source,
      index: 1,
      rotation: 0,
      bucket: 1,
      priority: 3,
    });
    if (!bitmap.ok) throw new Error(bitmap.error.message);
    const canvas = new OffscreenCanvas(bitmap.value.width, bitmap.value.height);
    const g = canvas.getContext('2d');
    if (!g) throw new Error('no 2d');
    g.drawImage(bitmap.value.bitmap, 0, 0);
    const [r, gr, b] = g.getImageData(240, 120, 1, 1).data;
    expect([r, gr, b]).toEqual([229, 57, 53]);
  });

  it('existing annotations from the file keep their ids through delete and undo', async () => {
    const { source, pages } = await open(annotationsUrl, 'annotations.pdf');
    const t = target(source, pages, 1);
    const note = (await readAnnotations(source, 1)).find((a) => a.kind === 'text');
    expect(note?.id).toBe('fixture-annot-text-1');
    await deleteAnnotations(t, ['fixture-annot-text-1']);
    model().undo();
    await whenIdle();
    const back = (await readAnnotations(source, 1)).find((a) => a.kind === 'text');
    expect(back?.id).toBe('fixture-annot-text-1');
    expect(back?.contents).toBe('Sticky note text on page 2');
  });
});
