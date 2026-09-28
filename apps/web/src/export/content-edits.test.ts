/**
 * Export of a source with text edits (ADR-0011 §5, spec redaction-and-text-editing §2.5):
 * the edited source is saved by the engine and finalized (`finalizeTextEdits`) before
 * assembly, so the output has no `/Untitled` subset font, and the summary data counts the
 * edits by font outcome (spec §2.1, §5.3). Fixture: text-edit-fonts.pdf, the Identity-H Inter
 * subset line on y = 650 (upper case other than "T" is not in the subset, so the edit is
 * tier 1 with a bundled face), the whole JetBrains Mono line on y = 600 (tier 2) and the
 * Helvetica line on y = 700 (tier 2, not embedded).
 *
 * An export after a replay the engine refused is blocked (the engine lacks edits the history
 * shows), and allowed again once a replay succeeds.
 */
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  type PDFObject,
  PDFRawStream,
  PDFRef,
} from '@cantoo/pdf-lib';
import {
  addFormField,
  type EngineEdit,
  formFieldId,
  getActiveDocument,
  newFormField,
  type SourceId,
} from '@pdf-editor/document-model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import imagesUrl from '../../../../test/fixtures/images.pdf?url';
import simpleTextUrl from '../../../../test/fixtures/simple-text.pdf?url';
import fontsUrl from '../../../../test/fixtures/text-edit-fonts.pdf?url';
import { fixtureFile } from '../../test/store-harness';
import { resetAnnotationStore } from '../annotations/annotation-store';
import {
  appliedEditIds,
  EditsNotAppliedError,
  engineContext,
  executeEdit,
  resetEditRunner,
  runAction,
  runExclusive,
  whenIdle,
} from '../annotations/edit-runner';
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
    // The recorded edit carries the outcome the summary reports.
    expect(model().workspace.engineEdits[0]?.payload).toMatchObject({
      tier: 1,
      face: result?.substitute,
      honesty: 'font-substituted',
      fellBack: false,
    });
    // Tier 2 in the embedded JetBrains Mono, and in the Helvetica the file does not embed.
    expect(await textEdit(first.ref.source, 600, 'fox', 'cat')).toMatchObject({
      tier: 2,
      honesty: 'same-font',
    });
    expect(await textEdit(first.ref.source, 700, 'fox', 'cat')).toMatchObject({
      tier: 2,
      honesty: 'same-font-not-embedded',
    });

    const prepared = await prepareExport(doc.id, { compression: null });
    if (!prepared.ok) throw new Error(prepared.error.message);
    expect(prepared.value.verification.ok).toBe(true);
    expect(prepared.value.redaction).toBeUndefined();
    expect(prepared.value.textEdits).toMatchObject({ edits: 3 });
    expect(prepared.value.textEdits?.fontsRenamed).toBeGreaterThanOrEqual(1);
    expect(prepared.value.textEdits?.sources).toEqual([
      expect.objectContaining({
        name: 'text-edit-fonts.pdf',
        edits: 3,
        fonts: {
          sameFont: 1,
          sameFontNotEmbedded: 1,
          substituted: { [result?.substitute ?? '?']: 1 },
          fellBack: {},
          movedOutOfForm: 0,
        },
      }),
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
    expect(items[0]?.text).toMatch(/^Text edits: 3 \(fonts renamed: [1-9]/);
    expect(items[0]?.details).toEqual(['text-edit-fonts.pdf: 3']);
    expect(items[1]).toEqual({
      id: 'text-edit-fonts-0',
      tone: 'changed',
      text:
        'text-edit-fonts.pdf: 1 in the original font; 1 in the original font (not embedded); ' +
        '1 with a substituted font (Inter).',
    });
  });
});

/** The text of page 1 of `bytes`, opened as a new source of the engine service. */
async function pageTextOf(bytes: ArrayBuffer): Promise<string> {
  const service = getEngineService();
  const opened = await service.open(new File([bytes], 'out.pdf', { type: 'application/pdf' }));
  if (!opened.ok) throw new Error(opened.error.message);
  const runs = await service.getPageText(opened.value.id, 0);
  await service.close(opened.value.id);
  if (!runs.ok) throw new Error(runs.error.message);
  return runs.value.map((r) => r.text).join(' | ');
}

describe('export after a replay the engine refused', () => {
  beforeEach(() => {
    resetWorkspace();
    resetEditRunner();
    resetAnnotationStore();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await whenIdle();
    resetWorkspace();
  });

  it('is blocked while the engine lacks an edit of the history, and heals once a replay succeeds', async () => {
    await model().openFiles([await fixtureFile(fontsUrl, 'text-edit-fonts.pdf')]);
    const doc = getActiveDocument(model().workspace);
    const first = doc?.pages[0];
    if (!doc || first?.ref.kind !== 'source') throw new Error('not opened');
    const source = first.ref.source;
    expect((await textEdit(source, 650, 'fox', 'FOX'))?.tier).toBe(1);
    expect(await textEdit(source, 600, 'fox', 'cat')).toBeDefined();
    const [kept] = model().workspace.engineEdits;
    if (!kept) throw new Error('no edit recorded');

    // The engine refuses text edits from now on (a worker hiccup, a font that fails to load).
    const ctx = await engineContext();
    const refuse = vi
      .spyOn(
        ctx.editor as unknown as { applyTextEdit: (...a: unknown[]) => unknown },
        'applyTextEdit',
      )
      .mockRejectedValue(new Error('injected: engine refused'));
    // Undo the second edit: reopen + replay of the first, which fails.
    model().undo();
    await whenIdle();
    expect(refuse).toHaveBeenCalled();
    expect(model().workspace.engineEdits.map((e) => e.id)).toEqual([kept.id]);
    expect(appliedEditIds(source)).toEqual([]);

    // Persistent failure: the export does not run (the replay is tried again and fails).
    const calls = refuse.mock.calls.length;
    const blocked = await prepareExport(doc.id, { compression: null });
    expect(blocked.ok).toBe(false);
    if (blocked.ok) throw new Error('exported');
    expect(blocked.error.message).toMatch(/edits could not be re-applied.*export is blocked/);
    expect(refuse.mock.calls.length).toBeGreaterThan(calls);
    // Any exclusive task is refused the same way, and never runs.
    const task = vi.fn(() => Promise.resolve(true));
    await expect(runExclusive(task)).rejects.toBeInstanceOf(EditsNotAppliedError);
    expect(task).not.toHaveBeenCalled();

    // Transient failure: once the engine accepts the edit again, the export replays it first.
    refuse.mockRestore();
    const prepared = await prepareExport(doc.id, { compression: null });
    if (!prepared.ok) throw new Error(prepared.error.message);
    expect(appliedEditIds(source)).toEqual([kept.id]);
    expect(prepared.value.verification.ok).toBe(true);
    expect(prepared.value.textEdits).toMatchObject({ edits: 1 });
    const text = await pageTextOf(prepared.value.bytes);
    expect(text).toContain('The quick brown FOX jumps');
    expect(text).not.toContain('brown cat');
  });
});

/**
 * Indirect objects not reachable from the trailer's /Root or /Info (object and cross-
 * reference streams are file structure, not content, and are left out).
 */
function unreachable(doc: PDFDocument): PDFRef[] {
  const { context } = doc;
  const reachable = new Set<string>();
  const stack: PDFObject[] = [];
  const { Root, Info } = context.trailerInfo;
  if (Root) stack.push(Root);
  if (Info) stack.push(Info);
  const seen = new Set<PDFObject>();
  while (stack.length > 0) {
    const value = stack.pop() as PDFObject;
    if (value instanceof PDFRef) {
      if (reachable.has(value.toString())) continue;
      reachable.add(value.toString());
      const target = context.lookup(value);
      if (target) stack.push(target);
    } else if (!seen.has(value)) {
      seen.add(value);
      if (value instanceof PDFRawStream) stack.push(value.dict);
      else if (value instanceof PDFDict) for (const [, child] of value.entries()) stack.push(child);
      else if (value instanceof PDFArray)
        for (let i = 0; i < value.size(); i++) stack.push(value.get(i));
    }
  }
  const structural = (o: PDFObject) =>
    o instanceof PDFRawStream &&
    [PDFName.of('ObjStm'), PDFName.of('XRef')].includes(o.dict.get(PDFName.of('Type')) as PDFName);
  return context
    .enumerateIndirectObjects()
    .filter(([ref, o]) => !reachable.has(ref.toString()) && !structural(o))
    .map(([ref]) => ref);
}

function imageStreams(doc: PDFDocument): number {
  return doc.context
    .enumerateIndirectObjects()
    .filter(
      ([, o]) =>
        o instanceof PDFRawStream && o.dict.get(PDFName.of('Subtype')) === PDFName.of('Image'),
    ).length;
}

describe('export of image-edited sources', () => {
  beforeEach(() => {
    resetWorkspace();
    resetEditRunner();
    resetAnnotationStore();
  });
  afterEach(async () => {
    await whenIdle();
    resetWorkspace();
  });

  it('an export after image.remove has no unreachable object and no trace of the image', async () => {
    await model().openFiles([await fixtureFile(imagesUrl, 'images.pdf')]);
    const doc = getActiveDocument(model().workspace);
    const second = doc?.pages[1];
    if (!doc || second?.ref.kind !== 'source') throw new Error('not opened');
    const source = second.ref.source;
    const engine = await import('@pdf-editor/engine');
    const editor = await getEngineService().imageEditor();
    // Two edits of the page: a move (its GenerateContent orphans a stream), then a removal.
    for (const kind of ['image.transform', 'image.remove'] as const) {
      const [image] = await editor.locateImages(source, 1);
      if (!image) throw new Error('images.pdf page 2 has an image');
      const edit: EngineEdit = {
        id: globalThis.crypto.randomUUID(),
        source,
        pageIndex: 1,
        kind,
        payload: {
          image: engine.imageRefJson(image),
          ...(kind === 'image.transform' ? { rect: { x: 20, y: 20, width: 36, height: 27 } } : {}),
        },
      };
      await runAction(async (ctx) => {
        const done = await executeEdit(ctx, edit);
        return { edits: [done.recorded], label: kind, value: true };
      });
    }
    expect(await editor.locateImages(source, 1)).toEqual([]);

    const prepared = await prepareExport(doc.id, { compression: null });
    if (!prepared.ok) throw new Error(prepared.error.message);
    expect(prepared.value.verification.ok).toBe(true);
    expect(prepared.value.textEdits).toBeUndefined();
    const out = await PDFDocument.load(prepared.value.bytes, { updateMetadata: false });
    expect(unreachable(out)).toEqual([]);
    // images.pdf: page 1 has an image and its soft mask, page 3 a JPEG; page 2's is gone.
    expect(imageStreams(out)).toBe(3);
    const page2 = out.getPage(1).node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict);
    expect(page2?.keys().length ?? 0).toBe(0);
  });
});

describe('export of created form fields', () => {
  beforeEach(() => {
    resetWorkspace();
    resetEditRunner();
    resetAnnotationStore();
  });
  afterEach(async () => {
    await whenIdle();
    resetWorkspace();
  });

  it('a flattened export of a created text field has no fields and shows the value', async () => {
    await model().openFiles([await fixtureFile(simpleTextUrl, 'simple-text.pdf')]);
    const doc = getActiveDocument(model().workspace);
    const first = doc?.pages[0];
    if (!doc || !first) throw new Error('not opened');
    const added = model().applyOperation(
      (ws) =>
        addFormField(
          ws,
          doc.id,
          newFormField(
            'text',
            formFieldId('flatten-me'),
            'Name',
            [{ page: first.id, rect: { x: 72, y: 500, width: 220, height: 24 } }],
            { value: 'Hello Flatten' },
          ),
        ),
      'Add field',
    );
    expect(added).toBe(true);

    const prepared = await prepareExport(doc.id, { compression: null, flattenForms: true });
    if (!prepared.ok) throw new Error(prepared.error.message);
    expect(prepared.value.verification.ok).toBe(true);
    const out = await PDFDocument.load(prepared.value.bytes, { updateMetadata: false });
    expect(out.getForm().getFields()).toHaveLength(0);

    // The value is part of the page now: open the output and read its text.
    await model().openFiles([
      new File([prepared.value.bytes], 'flattened.pdf', { type: 'application/pdf' }),
    ]);
    const reopened = getActiveDocument(model().workspace)?.pages[0];
    if (reopened?.ref.kind !== 'source') throw new Error('output not opened');
    const runs = await (await getEngineService().textEditor()).locateRuns(reopened.ref.source, 0);
    expect(runs.map((r) => r.text).join(' ')).toContain('Hello Flatten');
  });
});
