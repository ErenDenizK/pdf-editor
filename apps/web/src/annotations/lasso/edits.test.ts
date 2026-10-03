/**
 * Lasso edits across kinds (craft spec §5.5, §10), with real PDFium: a selection of some ink
 * paths, an arrow and a note is recoloured, restyled, moved and deleted, each as one history
 * entry that names the mix, and one undo restores everything.
 */
import '../index';

import {
  getActiveDocument,
  historyEntries,
  type SourceId,
  type VirtualDocument,
} from '@pdf-editor/document-model';
import type { Annotation, InkAnnotation, NewAnnotation } from '@pdf-editor/engine';
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
import { deleteLassoSelection, moveLassoSelection, resetLassoEdits } from './edits';

const model = () => useWorkspaceStore.getState();

async function open(): Promise<{ source: SourceId; target: PageTarget }> {
  const report = await model().openFiles([await fixtureFile(simpleUrl, 'simple.pdf')]);
  expect(report.skipped).toEqual([]);
  const doc = getActiveDocument(model().workspace) as VirtualDocument;
  const first = doc.pages[0];
  if (first?.ref.kind !== 'source') throw new Error('no source page');
  const target: PageTarget = {
    source: first.ref.source,
    pageIndex: 0,
    pageId: first.id,
    position: 1,
  };
  return { source: first.ref.source, target };
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
    kind: 'text',
    pageIndex: 0,
    rect: { x: 350, y: 500, width: 20, height: 20 },
    contents: 'A note',
    color: '#FFEA00',
    icon: 'Comment',
  },
];

interface Made {
  readonly ink: InkAnnotation;
  readonly arrow: Annotation;
  readonly note: Annotation;
}

async function make(target: PageTarget, source: SourceId): Promise<Made> {
  for (const draft of drafts) await createAnnotations(target, [draft]);
  await whenIdle();
  // The page cache, as a mounted layer keeps it: the selection follows edits through it.
  await useAnnotationStore.getState().reloadPage(source, 0);
  const list = await readAnnotations(source, 0);
  const ink = list.find((a): a is InkAnnotation => a.kind === 'ink');
  const arrow = list.find((a) => a.kind === 'line');
  const note = list.find((a) => a.kind === 'text');
  if (!ink || !arrow || !note) throw new Error('annotations missing');
  // The lasso took the middle stroke of the ink, the arrow and the note.
  useAnnotationStore
    .getState()
    .selectPaths(target, { [ink.id]: [1] }, undefined, [arrow.id, note.id]);
  return { ink, arrow, note };
}

const labels = () => historyEntries(model().history).map((e) => e.label);

describe('lasso edits across kinds', () => {
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

  it('recolours ink paths, an arrow and a note as one history entry; one undo restores all', async () => {
    const { source, target } = await open();
    const { ink, arrow, note } = await make(target, source);
    expect(activePathSelection(useAnnotationStore.getState())?.whole).toEqual([arrow.id, note.id]);
    const before = labels().length;

    useAnnotationStore.getState().applyStyle({ color: '#DB1C22' });
    await whenIdle();
    const after = await readAnnotations(source, 0);
    const inks = after.filter((a): a is InkAnnotation => a.kind === 'ink');
    // The taken stroke split off with the new colour; the rest keeps its id and colour.
    expect(inks).toHaveLength(2);
    expect(inks.find((a) => a.id === ink.id)?.color?.toUpperCase()).toBe('#1A1A1A');
    expect(inks.find((a) => a.id !== ink.id)?.color?.toUpperCase()).toBe('#DB1C22');
    expect(after.find((a) => a.id === arrow.id)?.color?.toUpperCase()).toBe('#DB1C22');
    expect(after.find((a) => a.id === note.id)?.color?.toUpperCase()).toBe('#DB1C22');
    expect(labels()).toHaveLength(before + 1);
    expect(labels().at(-1)).toBe('Recolor 1 stroke, 1 arrow, and 1 note');

    model().undo();
    await whenIdle();
    const undone = await readAnnotations(source, 0);
    const inksBack = undone.filter((a): a is InkAnnotation => a.kind === 'ink');
    expect(inksBack).toHaveLength(1);
    expect(inksBack[0]?.paths).toHaveLength(3);
    expect(inksBack[0]?.color?.toUpperCase()).toBe('#1A1A1A');
    expect(undone.find((a) => a.id === arrow.id)?.color?.toUpperCase()).toBe('#1A1A1A');
    expect(undone.find((a) => a.id === note.id)?.color?.toUpperCase()).toBe('#FFEA00');
  });

  it('a width applies to the stroke and the arrow, not to the note', async () => {
    const { source, target } = await open();
    const { arrow, note } = await make(target, source);
    useAnnotationStore.getState().applyStyle({ strokeWidth: 4 });
    await whenIdle();
    const after = await readAnnotations(source, 0);
    const split = after.find((a) => a.kind === 'ink' && a.paths.length === 1);
    expect(split?.kind === 'ink' && split.strokeWidth).toBe(4);
    const line = after.find((a) => a.id === arrow.id);
    expect(line?.kind === 'line' && line.strokeWidth).toBe(4);
    expect(after.find((a) => a.id === note.id)?.modified).toBe(note.modified);
    expect(labels().at(-1)).toBe('Change width of 1 stroke and 1 arrow');
  });

  it('moves everything by the same delta in one entry, and deletes it all in another', async () => {
    const { source, target } = await open();
    const { ink, arrow, note } = await make(target, source);
    const before = labels().length;
    await moveLassoSelection(10, -5);
    await whenIdle();
    let after = await readAnnotations(source, 0);
    const moved = after.find((a) => a.kind === 'ink' && a.id !== ink.id);
    expect(moved?.kind === 'ink' && moved.paths[0]?.[0]).toEqual({ x: 110, y: 555 });
    const line = after.find((a) => a.id === arrow.id);
    expect(line?.kind === 'line' && line.vertices?.[0]).toEqual({ x: 210, y: 495 });
    const movedNote = after.find((a) => a.id === note.id);
    expect(movedNote?.rect.x).toBeCloseTo(note.rect.x + 10, 1);
    expect(movedNote?.rect.y).toBeCloseTo(note.rect.y - 5, 1);
    expect(labels()).toHaveLength(before + 1);
    expect(labels().at(-1)).toBe('Move 1 stroke, 1 arrow, and 1 note');

    // The selection follows the split stroke to its new ink and keeps the whole ones.
    await vi.waitFor(() => {
      const selection = activePathSelection(useAnnotationStore.getState());
      expect(selection?.paths).toEqual({ [moved?.id ?? '']: [0] });
      expect(selection?.whole).toEqual([arrow.id, note.id]);
    });
    expect(useAnnotationStore.getState().selection?.ids).toEqual([moved?.id, arrow.id, note.id]);

    await deleteLassoSelection();
    await whenIdle();
    after = await readAnnotations(source, 0);
    expect(after.map((a) => a.id)).toEqual([ink.id]);
    expect(labels()).toHaveLength(before + 2);
    expect(labels().at(-1)).toBe('Delete 1 stroke, 1 arrow, and 1 note');
    expect(useAnnotationStore.getState().selection).toBeNull();

    model().undo();
    await whenIdle();
    after = await readAnnotations(source, 0);
    expect(after).toHaveLength(4);
  });
});
