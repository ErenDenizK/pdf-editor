/**
 * Text edits through the real engine (spec §2.5): a commit is one history entry through the
 * edit runner with the label from the result; undo of a text edit reopens the source's
 * original bytes and replays the remaining edits; redo applies the edit again; the source
 * is dirty so export takes the edited bytes. Fixture: text-edit-fonts.pdf, whose Helvetica
 * line sits on the baseline y = 700 and whose Identity-H Inter subset line on y = 650.
 */
import { getActiveDocument, historyEntries, type SourceId } from '@pdf-editor/document-model';
import type { LocatedRun } from '@pdf-editor/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import fontsUrl from '../../../../test/fixtures/text-edit-fonts.pdf?url';
import { fixtureFile } from '../../test/store-harness';
import type { PageTarget } from '../annotations/annotation-store';
import { resetAnnotationStore } from '../annotations/annotation-store';
import { appliedEditIds, resetEditRunner, whenIdle } from '../annotations/edit-runner';
import { getEngineService } from '../engine/engine-service';
import { prepareExport } from '../export/export-service';
import { resetWorkspace, useWorkspaceStore } from '../state/workspace-store';
import { commitTextEdit } from './actions';
import { editRange } from './model';
import { locatedRuns } from './runs';

const FOX = 'The quick brown fox jumps over the lazy dog';
const model = () => useWorkspaceStore.getState();

async function open(): Promise<{ source: SourceId; target: PageTarget; doc: string }> {
  await model().openFiles([await fixtureFile(fontsUrl, 'text-edit-fonts.pdf')]);
  const doc = getActiveDocument(model().workspace);
  const first = doc?.pages[0];
  if (!doc || first?.ref.kind !== 'source') throw new Error('not opened');
  const source = first.ref.source;
  return { source, doc: doc.id, target: { source, pageIndex: 0, pageId: first.id, position: 1 } };
}

/** The runs on a baseline (the fixture's lines, README table), left to right. */
async function runsOn(source: SourceId, baseline: number): Promise<LocatedRun[]> {
  const runs = await locatedRuns(source, 0);
  return runs
    .filter((r) => Math.abs((r.glyphs[0]?.origin.y ?? 0) - baseline) < 0.01)
    .sort((a, b) => (a.glyphs[0]?.origin.x ?? 0) - (b.glyphs[0]?.origin.x ?? 0));
}

/**
 * The run on a baseline that contains `word`. An edit splits the line's text object around
 * the replaced characters, so an edited line is several runs.
 */
async function lineOn(source: SourceId, baseline: number, word = ''): Promise<LocatedRun> {
  const run = (await runsOn(source, baseline)).find((r) => r.text.includes(word));
  if (!run) throw new Error(`No run with "${word}" on y = ${baseline}`);
  return run;
}

/** The text of a line, joined over its runs. */
async function lineText(source: SourceId, baseline: number): Promise<string> {
  return (await runsOn(source, baseline)).map((r) => r.text).join('');
}

/** The page's text runs as the engine extracts them now. */
async function pageTexts(source: SourceId): Promise<string[]> {
  const result = await getEngineService().getPageText(source, 0);
  if (!result.ok) throw new Error(result.error.message);
  return result.value.map((r) => r.text);
}

async function helveticaText(source: SourceId): Promise<string> {
  return lineText(source, 700);
}

async function replace(
  target: PageTarget,
  run: LocatedRun,
  from: string,
  to: string,
  fit: 'keep' | 'shrink' | 'overflow' = 'keep',
) {
  const range = editRange(run, run.text.replace(from, to));
  if (!range) throw new Error('no change');
  return commitTextEdit({ target, run, ...range, fit });
}

describe('text edits through the edit runner', () => {
  beforeEach(() => {
    resetWorkspace();
    resetEditRunner();
    resetAnnotationStore();
  });
  afterEach(async () => {
    await whenIdle();
    resetWorkspace();
  });

  it('commits one history entry labelled from the result; the page reads back the new text', async () => {
    const { source, target } = await open();
    const before = historyEntries(model().history).length;
    const run = await lineOn(source, 700);
    expect(run.text).toBe(FOX);
    expect(run.font).toMatchObject({ baseName: 'Helvetica', embedded: false });
    const outcome = await replace(target, run, 'fox', 'cat');
    expect(outcome).toMatchObject({ ok: true, label: 'Text edited (same font, not embedded)' });
    expect(historyEntries(model().history)).toHaveLength(before + 1);
    expect(model().history.present.label).toBe('Text edited (same font, not embedded)');
    expect(model().workspace.engineEdits.map((e) => e.kind)).toEqual(['text.edit']);
    expect(model().dirtySources.has(source)).toBe(true);
    // Run references were located again for the new revision; the text reads back.
    expect(await helveticaText(source)).toBe(FOX.replace('fox', 'cat'));
    expect(await pageTexts(source)).toContain(FOX.replace('fox', 'cat'));
    // The old run reference is stale now: committing it again fails and adds nothing.
    const stale = await replace(target, run, 'fox', 'owl');
    expect(stale).toMatchObject({ ok: false, reason: 'stale-run' });
    expect(historyEntries(model().history)).toHaveLength(before + 1);
  });

  it('undo reopens and replays: two edits on one page, undo one, redo it', async () => {
    const { source, target } = await open();
    const first = await replace(target, await lineOn(source, 700), 'fox', 'cat');
    expect(first.ok).toBe(true);
    const afterFirst = await pageTexts(source);
    const second = await replace(
      target,
      await lineOn(source, 700, 'lazy'),
      'lazy',
      'idle',
      'overflow',
    );
    expect(second.ok).toBe(true);
    const both = FOX.replace('fox', 'cat').replace('lazy', 'idle');
    expect(await helveticaText(source)).toBe(both);
    const [firstEdit, secondEdit] = model().workspace.engineEdits;
    expect(appliedEditIds(source)).toEqual([firstEdit?.id, secondEdit?.id]);

    // Undo the second edit: the inverse is "replay required"; the page equals the first result.
    expect(model().undo()).toMatch(/^Text edited/);
    await whenIdle();
    expect(appliedEditIds(source)).toEqual([firstEdit?.id]);
    expect(await helveticaText(source)).toBe(FOX.replace('fox', 'cat'));
    expect(await pageTexts(source)).toEqual(afterFirst);

    // Redo applies the recorded forward edit again.
    model().redo();
    await whenIdle();
    expect(appliedEditIds(source)).toEqual([firstEdit?.id, secondEdit?.id]);
    expect(await helveticaText(source)).toBe(both);

    // Undo both: back to the original page.
    model().undo();
    model().undo();
    await whenIdle();
    expect(appliedEditIds(source)).toEqual([]);
    expect(await helveticaText(source)).toBe(FOX);
    expect(model().dirtySources.has(source)).toBe(false);
  });

  it('export takes the edited bytes', async () => {
    const { source, target, doc } = await open();
    expect((await replace(target, await lineOn(source, 700), 'fox', 'cat')).ok).toBe(true);
    const exported = await prepareExport(doc as never);
    if (!exported.ok) throw new Error(exported.error.message);
    const service = getEngineService();
    const reopened = await service.open(new File([exported.value.bytes.slice(0)], 'out.pdf'));
    if (!reopened.ok) throw new Error(reopened.error.message);
    const runs = await (await service.textEditor()).locateRuns(reopened.value.id, 0);
    const helvetica = runs
      .filter((r) => Math.abs((r.glyphs[0]?.origin.y ?? 0) - 700) < 0.01)
      .map((r) => r.text)
      .join('');
    expect(helvetica).toBe(FOX.replace('fox', 'cat'));
    const onEditedLine = (hits: readonly { rects: readonly { y: number; height: number }[] }[]) =>
      hits.filter((hit) => hit.rects.some((r) => r.y < 700 && r.y + r.height > 700)).length;
    const fox = await service.search(reopened.value.id, 'fox');
    const cat = await service.search(reopened.value.id, 'cat');
    if (!fox.ok || !cat.ok) throw new Error('search failed');
    // "fox" is still on the other lines of the fixture, never on the edited one.
    expect(fox.value.length).toBeGreaterThan(0);
    expect(onEditedLine(fox.value)).toBe(0);
    expect(onEditedLine(cat.value)).toBe(1);
    await service.close(reopened.value.id);
  });

  it('a character the Identity-H subset lacks is typeset in the substitute (tier 1)', async () => {
    const { source, target } = await open();
    const run = await lineOn(source, 650);
    expect(run.font).toMatchObject({ embedded: true });
    const outcome = await replace(target, run, 'fox', 'Fox', 'overflow');
    expect(outcome).toMatchObject({ ok: true, label: 'Text edited (font substituted: Inter)' });
    expect(await lineText(source, 650)).toBe(FOX.replace('fox', 'Fox'));
  });
});
