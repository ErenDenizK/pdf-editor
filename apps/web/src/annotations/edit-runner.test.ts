/**
 * Edit runner robustness (review M2), through the real engine: export waits for queued
 * edits, failing actions leave nothing behind, failed replays are recorded as such,
 * actions overtaken by a history move are dropped, dirty sources follow the edits, closed
 * sources are forgotten, and stamp images are kept once, outside the edit payloads.
 */
import { getActiveDocument, historyEntries, type SourceId } from '@pdf-editor/document-model';
import type { NewAnnotation } from '@pdf-editor/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import simpleUrl from '../../../../test/fixtures/simple-text.pdf?url';
import { fixtureFile, pngBlob } from '../../test/store-harness';
import { getEngineService } from '../engine/engine-service';
import { prepareExport } from '../export/export-service';
import { useAnnouncer } from '../shell/announcer';
import { resetWorkspace, useWorkspaceStore } from '../state/workspace-store';
import { createAnnotations, deleteAnnotations, updateAnnotations } from './actions';
import {
  type PageTarget,
  pageKey,
  resetAnnotationStore,
  useAnnotationStore,
} from './annotation-store';
import { appliedEditIds, readAnnotations, resetEditRunner, whenIdle } from './edit-runner';

const model = () => useWorkspaceStore.getState();

async function open(): Promise<{ source: SourceId; target: PageTarget; doc: string }> {
  await model().openFiles([await fixtureFile(simpleUrl, 'simple.pdf')]);
  const doc = getActiveDocument(model().workspace);
  const first = doc?.pages[0];
  if (!doc || first?.ref.kind !== 'source') throw new Error('not opened');
  const source = first.ref.source;
  return {
    source,
    doc: doc.id,
    target: { source, pageIndex: 0, pageId: first.id, position: 1 },
  };
}

const text = (y: number, value: string): NewAnnotation => ({
  kind: 'free-text',
  pageIndex: 0,
  rect: { x: 72, y, width: 200, height: 20 },
  text: value,
  fontSize: 12,
  textColor: '#000000',
});

/** Annotations on page 1 of exported bytes, as PDFium reads them. */
async function exportedCount(bytes: ArrayBuffer): Promise<number> {
  const service = getEngineService();
  const opened = await service.open(new File([bytes.slice(0)], 'out.pdf'));
  if (!opened.ok) throw new Error(opened.error.message);
  const list = await (await service.editor()).listAnnotations(opened.value.id, 0);
  await service.close(opened.value.id);
  return list.length;
}

const entries = () => historyEntries(model().history).length;

describe('edit runner robustness', () => {
  beforeEach(() => {
    resetWorkspace();
    resetEditRunner();
    resetAnnotationStore();
  });
  afterEach(async () => {
    await whenIdle();
    resetWorkspace();
  });

  it('export right after undo waits for the engine to follow the model', async () => {
    const { target, doc } = await open();
    await createAnnotations(
      target,
      Array.from({ length: 30 }, (_, i) => text(700 - i * 20, `A${i}`)),
    );
    model().undo();
    const result = await prepareExport(doc as never);
    if (!result.ok) throw new Error(result.error.message);
    expect(model().workspace.engineEdits).toHaveLength(0);
    expect(await exportedCount(result.value.bytes)).toBe(0);
  });

  it('export while an action is queued includes the action whole or not at all', async () => {
    const { target, doc } = await open();
    await createAnnotations(target, [text(500, 'A')]);
    const pending = createAnnotations(
      target,
      Array.from({ length: 20 }, (_, i) => text(700 - i * 20, `B${i}`)),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    const result = await prepareExport(doc as never);
    await pending;
    if (!result.ok) throw new Error(result.error.message);
    // The export was queued after the pending action: it sees all 21.
    expect(await exportedCount(result.value.bytes)).toBe(21);
  });

  it('an action failing part-way reverts what it executed and adds no history', async () => {
    const { source, target } = await open();
    const a = (await createAnnotations(target, [text(500, 'A')]))?.[0];
    const b = (await createAnnotations(target, [text(400, 'B')]))?.[0];
    if (!a || !b) throw new Error('not created');
    const before = entries();
    let failure: unknown;
    await updateAnnotations(
      target,
      [a.id, b.id],
      (x) => (x.kind === 'free-text' ? { ...x, text: x.id === a.id ? 'A2' : 'B中' } : x),
      { action: 'text' },
    ).catch((error: unknown) => {
      failure = error;
    });
    expect(failure).toBeDefined();
    expect(entries()).toBe(before);
    const texts = (await readAnnotations(source, 0)).map((x) =>
      x.kind === 'free-text' ? x.text : '',
    );
    expect(texts.sort()).toEqual(['A', 'B']);
    expect(useAnnouncer.getState().message).toMatch(/could not be applied/);
  });

  it('a replay the engine refuses is not recorded as applied', async () => {
    const { source, target } = await open();
    const created = (await createAnnotations(target, [text(500, 'A')]))?.[0];
    if (!created) throw new Error('not created');
    const createEdit = model().workspace.engineEdits[0]?.id;
    // Someone removes it behind the runner's back: undoing the create cannot delete it.
    await (await getEngineService().editor()).deleteAnnotation(source, 0, created.id);
    model().undo();
    await whenIdle();
    expect(appliedEditIds(source)).toEqual([createEdit]);
    expect(useAnnouncer.getState().message).toMatch(/could not be undone or redone/);
  });

  it('an action overtaken by an undo is dropped instead of committed', async () => {
    const { source, target } = await open();
    const a = (await createAnnotations(target, [text(500, 'A')]))?.[0];
    const b = (await createAnnotations(target, [text(400, 'B')]))?.[0];
    if (!a || !b) throw new Error('not created');
    const labelsBefore = historyEntries(model().history).map((e) => e.label);
    const moved = await updateAnnotations(
      target,
      [a.id],
      (x) => {
        // Mod+Z while the drag's update is on its way to the engine.
        model().undo();
        return { ...x, rect: { ...x.rect, x: x.rect.x + 50 } };
      },
      { action: 'move' },
    );
    await whenIdle();
    expect(moved).toBeUndefined();
    // The undo stands (B gone, redo available) and A did not move.
    expect(historyEntries(model().history).map((e) => e.label)).toEqual(labelsBefore);
    expect(model().history.future).toHaveLength(1);
    const list = await readAnnotations(source, 0);
    expect(list.map((x) => x.id)).toEqual([a.id]);
    expect(list[0]?.rect.x).toBeCloseTo(a.rect.x, 1);
  });

  it('dirty sources follow the edits the engine holds', async () => {
    const { source, target } = await open();
    await createAnnotations(target, [text(500, 'A')]);
    expect(model().dirtySources.has(source)).toBe(true);
    model().undo();
    await whenIdle();
    expect(model().dirtySources.has(source)).toBe(false);
  });

  it('forgets a source when the engine closes it', async () => {
    const { source, target } = await open();
    await createAnnotations(target, [text(500, 'A')]);
    useAnnotationStore.getState().ensurePage(source, 0);
    await whenIdle();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(useAnnotationStore.getState().pages[pageKey(source, 0)]).toBeDefined();
    await getEngineService().close(source);
    expect(appliedEditIds(source)).toEqual([]);
    expect(useAnnotationStore.getState().pages[pageKey(source, 0)]).toBeUndefined();
    expect(useAnnotationStore.getState().selection).toBeNull();
    expect(getEngineService().pageRevision(source, 0)).toBe(0);
  });

  it('keeps stamp images once, by id, and restores a deleted stamp', async () => {
    const { source, target } = await open();
    const png = await pngBlob('logo.png', 60, 30);
    const stamp = (
      await createAnnotations(target, [
        {
          kind: 'stamp',
          pageIndex: 0,
          rect: { x: 100, y: 300, width: 120, height: 60 },
          imageBlob: new Blob([png.bytes], { type: 'image/png' }),
        },
      ])
    )?.[0];
    if (!stamp) throw new Error('not created');
    await deleteAnnotations(target, [stamp.id]);
    const log = JSON.stringify(model().workspace.engineEdits);
    expect(log).not.toContain('base64');
    expect(Object.keys(model().editBlobs).length).toBeGreaterThan(0);
    model().undo();
    await whenIdle();
    const back = (await readAnnotations(source, 0)).find((a) => a.id === stamp.id);
    expect(back?.kind).toBe('stamp');
  });
});
