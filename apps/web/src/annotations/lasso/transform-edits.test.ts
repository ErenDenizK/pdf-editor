/**
 * Group resize and rotate of a lasso selection (craft spec §5.5, WP P12), with real PDFium:
 * one path of a three-path ink, an arrow and a rectangle scaled, then rotated; each is one
 * history entry that names the mix, and one undo restores everything.
 */
import '../index';

import {
  getActiveDocument,
  historyEntries,
  type SourceId,
  type VirtualDocument,
} from '@pdf-editor/document-model';
import type { InkAnnotation, NewAnnotation, ShapeAnnotation } from '@pdf-editor/engine';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import simpleUrl from '../../../../../test/fixtures/simple-text.pdf?url';
import { fixtureFile } from '../../../test/store-harness';
import { resetWorkspace, useWorkspaceStore } from '../../state/workspace-store';
import { createAnnotations } from '../actions';
import {
  activePathSelection,
  type PageTarget,
  resetAnnotationStore,
  useAnnotationStore,
} from '../annotation-store';
import { readAnnotations, resetEditRunner, whenIdle } from '../edit-runner';
import type { Point } from '../ink';
import { resetLassoEdits, transformLassoSelection, useLassoNotice } from './edits';
import { scaling } from './transform';

const model = () => useWorkspaceStore.getState();

async function open(): Promise<{ source: SourceId; target: PageTarget }> {
  const report = await model().openFiles([await fixtureFile(simpleUrl, 'simple.pdf')]);
  expect(report.skipped).toEqual([]);
  const doc = getActiveDocument(model().workspace) as VirtualDocument;
  const first = doc.pages[0];
  if (first?.ref.kind !== 'source') throw new Error('no source page');
  return {
    source: first.ref.source,
    target: { source: first.ref.source, pageIndex: 0, pageId: first.id, position: 1 },
  };
}

function stroke(x: number, y: number): Point[] {
  return [0, 20, 40].map((dx) => ({ x: x + dx, y }));
}

const drafts: NewAnnotation[] = [
  {
    kind: 'ink',
    pageIndex: 0,
    rect: { x: 0, y: 0, width: 1, height: 1 },
    color: '#1A1A1A',
    opacity: 1,
    strokeWidth: 1.5,
    paths: [stroke(100, 600), stroke(100, 560), stroke(100, 520)],
    widths: [
      [1.5, 2, 1.5],
      [1.5, 2, 1.5],
      [1.5, 2, 1.5],
    ],
  },
  {
    kind: 'line',
    pageIndex: 0,
    rect: { x: 194, y: 494, width: 112, height: 22 },
    vertices: [
      { x: 200, y: 500 },
      { x: 300, y: 510 },
    ],
    lineEndings: { start: 'none', end: 'open-arrow' },
    color: '#1A1A1A',
    strokeWidth: 2,
  },
  {
    kind: 'square',
    pageIndex: 0,
    rect: { x: 320, y: 500, width: 40, height: 30 },
    color: '#1A1A1A',
    strokeWidth: 1,
  },
  {
    kind: 'stamp',
    pageIndex: 0,
    rect: { x: 100, y: 420, width: 90, height: 30 },
    name: 'Approved',
  },
];

const labels = () => historyEntries(model().history).map((e) => e.label);

async function setUp(withStamp = false) {
  const { source, target } = await open();
  for (const draft of withStamp ? drafts : drafts.slice(0, 3)) {
    await createAnnotations(target, [draft]);
  }
  await whenIdle();
  await useAnnotationStore.getState().reloadPage(source, 0);
  const list = await readAnnotations(source, 0);
  const ink = list.find((a): a is InkAnnotation => a.kind === 'ink');
  const arrow = list.find((a): a is ShapeAnnotation => a.kind === 'line');
  const square = list.find((a): a is ShapeAnnotation => a.kind === 'square');
  const stamp = list.find((a) => a.kind === 'stamp');
  if (!ink || !arrow || !square) throw new Error('annotations missing');
  const whole = [arrow.id, square.id, ...(stamp ? [stamp.id] : [])];
  // The lasso took the middle stroke of the ink, the arrow and the rectangle.
  useAnnotationStore.getState().selectPaths(target, { [ink.id]: [1] }, undefined, whole);
  return { source, ink, arrow, square, stamp };
}

describe('lasso group resize and rotate', () => {
  beforeEach(() => {
    resetWorkspace();
    resetEditRunner();
    resetAnnotationStore();
    resetLassoEdits();
  });
  afterEach(async () => {
    await whenIdle();
    resetAnnotationStore();
    resetWorkspace();
  });

  it('scales ink, an arrow and a rectangle in one entry; one undo restores all', async () => {
    const { source, ink, arrow, square } = await setUp();
    const before = labels().length;

    await transformLassoSelection('resize', scaling({ x: 100, y: 500 }, 2, 2));
    await whenIdle();
    const after = await readAnnotations(source, 0);
    const inks = after.filter((a): a is InkAnnotation => a.kind === 'ink');
    expect(inks).toHaveLength(2);
    // The taken stroke split off, scaled about (100, 500) with its widths × 2.
    const taken = inks.find((a) => a.id !== ink.id);
    expect(taken?.paths[0]?.map((p) => [p.x, p.y])).toEqual([
      [100, 620],
      [140, 620],
      [180, 620],
    ]);
    expect(taken?.widths?.[0]?.[1]).toBeCloseTo(4, 2);
    expect(taken?.strokeWidth).toBeCloseTo(3, 2);
    // The rest keeps its id and its paths.
    expect(inks.find((a) => a.id === ink.id)?.paths.map((p) => p[0]?.y)).toEqual([600, 520]);
    const line = after.find((a): a is ShapeAnnotation => a.id === arrow.id);
    expect(line?.vertices).toEqual([
      { x: 300, y: 500 },
      { x: 500, y: 520 },
    ]);
    expect(line?.lineEndings?.end).toBe('open-arrow');
    const rect = after.find((a) => a.id === square.id)?.rect;
    expect(rect?.x).toBeCloseTo(540, 0);
    expect(rect?.width).toBeCloseTo(80, 0);
    expect(rect?.height).toBeCloseTo(60, 0);
    expect(labels()).toHaveLength(before + 1);
    expect(labels().at(-1)).toBe('Resize 1 stroke, 1 arrow, and 1 rectangle');

    // The selection follows the split stroke and keeps the whole ones.
    await vi.waitFor(() => {
      const selection = activePathSelection(useAnnotationStore.getState());
      expect(selection?.paths).toEqual({ [taken?.id ?? '']: [0] });
      expect(selection?.whole).toEqual([arrow.id, square.id]);
    });

    model().undo();
    await whenIdle();
    const undone = await readAnnotations(source, 0);
    const back = undone.filter((a): a is InkAnnotation => a.kind === 'ink');
    expect(back).toHaveLength(1);
    expect(back[0]?.paths).toHaveLength(3);
    expect(undone.find((a): a is ShapeAnnotation => a.id === arrow.id)?.vertices).toEqual(
      arrow.vertices,
    );
    expect(undone.find((a) => a.id === square.id)?.rect.x).toBeCloseTo(square.rect.x, 1);
  });

  it('rotates ink and an arrow, orbits the rectangle; a key series is one entry', async () => {
    const { source, ink, arrow, square } = await setUp();
    const before = labels().length;
    // A clockwise quarter turn about (200, 500) in user space (y up).
    const quarter = { a: 0, b: -1, c: 1, d: 0, e: 200 - 500, f: 500 + 200 };
    // Two presses in a row: one entry.
    await transformLassoSelection('rotate', quarter);
    await whenIdle();
    const split = (await readAnnotations(source, 0)).find(
      (a): a is InkAnnotation => a.kind === 'ink' && a.id !== ink.id,
    );
    await vi.waitFor(() =>
      expect(activePathSelection(useAnnotationStore.getState())?.paths).toEqual({
        [split?.id ?? '']: [0],
      }),
    );
    await transformLassoSelection('rotate', quarter);
    await whenIdle();
    const after = await readAnnotations(source, 0);
    // Half a turn about (200, 500): (100, 560) → (300, 440).
    const taken = after.find((a): a is InkAnnotation => a.id === split?.id);
    expect(taken?.paths[0]?.[0]).toEqual({ x: 300, y: 440 });
    expect(taken?.widths?.[0]).toEqual([1.5, 2, 1.5]);
    const line = after.find((a): a is ShapeAnnotation => a.id === arrow.id);
    expect(line?.vertices).toEqual([
      { x: 200, y: 500 },
      { x: 100, y: 490 },
    ]);
    // The rectangle orbits unrotated: centre (340, 515) → (60, 485), same size.
    const rect = after.find((a) => a.id === square.id)?.rect;
    expect(rect?.width).toBeCloseTo(40, 0);
    expect(rect?.height).toBeCloseTo(30, 0);
    expect((rect?.x ?? 0) + (rect?.width ?? 0) / 2).toBeCloseTo(60, 0);
    expect((rect?.y ?? 0) + (rect?.height ?? 0) / 2).toBeCloseTo(485, 0);
    expect(labels()).toHaveLength(before + 1);
    expect(labels().at(-1)).toBe('Rotate 1 stroke, 1 arrow, and 1 rectangle');
    expect(useLassoNotice.getState().message).toBeNull();

    model().undo();
    await whenIdle();
    const undone = await readAnnotations(source, 0);
    expect(undone.filter((a) => a.kind === 'ink')).toHaveLength(1);
    expect(undone.find((a): a is ShapeAnnotation => a.id === arrow.id)?.vertices).toEqual(
      arrow.vertices,
    );
  });

  it('a stamp in a rotation keeps its orientation and the bar says so once', async () => {
    const { source, stamp } = await setUp(true);
    if (!stamp) throw new Error('no stamp');
    const turn = { a: 0, b: -1, c: 1, d: 0, e: 200 - 500, f: 500 + 200 };
    await transformLassoSelection('rotate', turn);
    await whenIdle();
    expect(useLassoNotice.getState().message).toBe('Stamps keep their orientation');
    const moved = (await readAnnotations(source, 0)).find((a) => a.id === stamp.id)?.rect;
    expect(moved?.width).toBeCloseTo(stamp.rect.width, 0);
    expect(moved?.height).toBeCloseTo(stamp.rect.height, 0);
  });
});
