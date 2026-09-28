/**
 * Export of a source with text edits (ADR-0011 §5, spec redaction-and-text-editing §2.5):
 * the edited source is saved by the engine and finalized (`finalizeTextEdits`) before
 * assembly, so the output has no `/Untitled` subset font, and the summary data counts the
 * edits. Fixture: text-edit-fonts.pdf, the Identity-H Inter subset line on y = 650 (upper
 * case other than "T" is not in the subset, so the edit is tier 1 with a bundled face).
 */
import { type EngineEdit, getActiveDocument, type SourceId } from '@pdf-editor/document-model';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import fontsUrl from '../../../../test/fixtures/text-edit-fonts.pdf?url';
import { fixtureFile } from '../../test/store-harness';
import { resetAnnotationStore } from '../annotations/annotation-store';
import { executeEdit, resetEditRunner, runAction, whenIdle } from '../annotations/edit-runner';
import { getEngineService } from '../engine/engine-service';
import { resetWorkspace, useWorkspaceStore } from '../state/workspace-store';
import { prepareExport } from './export-service';
import { summarizeReport } from './summary';

const model = () => useWorkspaceStore.getState();

/** Replaces `from` by `to` in the run on `baseline` through the edit runner. */
async function textEdit(source: SourceId, baseline: number, from: string, to: string) {
  const engine = await import('@pdf-editor/engine');
  const editor = await getEngineService().textEditor();
  const run = (await editor.locateRuns(source, 0)).find(
    (r) => Math.abs((r.glyphs[0]?.origin.y ?? 0) - baseline) < 0.01 && r.text.includes(from),
  );
  if (!run) throw new Error(`no run with "${from}" on y = ${baseline}`);
  const start = run.text.indexOf(from);
  const edit: EngineEdit = {
    id: globalThis.crypto.randomUUID(),
    source,
    pageIndex: 0,
    kind: 'text.edit',
    payload: engine.textEditPayloadOf({
      run,
      start,
      end: start + from.length,
      replacement: to,
      tier: 'auto',
      fit: 'overflow',
    }),
  };
  return runAction(async (ctx) => {
    const done = await executeEdit(ctx, edit);
    return { edits: [done.recorded], label: 'Text edited', value: done.textEdit };
  });
}

describe('export of text-edited sources', () => {
  beforeEach(() => {
    resetWorkspace();
    resetEditRunner();
    resetAnnotationStore();
  });
  afterEach(async () => {
    await whenIdle();
    resetWorkspace();
  });

  it('finalizes the edited source before assembly and reports it', async () => {
    await model().openFiles([await fixtureFile(fontsUrl, 'text-edit-fonts.pdf')]);
    const doc = getActiveDocument(model().workspace);
    const first = doc?.pages[0];
    if (!doc || first?.ref.kind !== 'source') throw new Error('not opened');
    const result = await textEdit(first.ref.source, 650, 'fox', 'FOX');
    expect(result?.tier).toBe(1);

    const prepared = await prepareExport(doc.id, { compression: null });
    if (!prepared.ok) throw new Error(prepared.error.message);
    expect(prepared.value.verification.ok).toBe(true);
    expect(prepared.value.redaction).toBeUndefined();
    expect(prepared.value.textEdits).toMatchObject({ edits: 1 });
    expect(prepared.value.textEdits?.fontsRenamed).toBeGreaterThanOrEqual(1);
    expect(prepared.value.textEdits?.sources).toEqual([
      expect.objectContaining({ name: 'text-edit-fonts.pdf', edits: 1 }),
    ]);
    const text = new TextDecoder('latin1').decode(new Uint8Array(prepared.value.bytes));
    expect(text).not.toContain('/Untitled');

    const items = summarizeReport(
      prepared.value.report,
      prepared.value.sourceNotes,
      prepared.value.outcome,
      prepared.value.textEdits ? { textEdits: prepared.value.textEdits } : {},
    );
    expect(items[0]?.id).toBe('text-edits');
    expect(items[0]?.text).toMatch(/^Text edits: 1 \(fonts renamed: [1-9]/);
    expect(items[0]?.details).toEqual(['text-edit-fonts.pdf: 1']);
  });
});
