/**
 * `text.edit` as an engine edit (spec §2.5): applied edits record the tier, face and size
 * used; undo is reopen + replay and reproduces the bytes exactly; replay re-checks the run;
 * the export post-pass renames subset fonts, repairs repeated MCIDs (tagged.pdf) and drops
 * the content stream a second edit orphaned. Also the worker round trip through the proxy.
 */
import type { PDFNumber } from '@cantoo/pdf-lib';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef, StandardFonts } from '@cantoo/pdf-lib';
import type { EngineEdit, SourceId } from '@pdf-editor/document-model';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import simpleTextUrl from '../../../../test/fixtures/simple-text.pdf?url';
import taggedUrl from '../../../../test/fixtures/tagged.pdf?url';
import { toBuffer, wasmUrl } from '../../test/helpers';
import {
  applyEngineEditWithResult,
  type EditTarget,
  isReplayRequired,
  readTextEditPayload,
  replayEngineEdits,
  type TextEditPayload,
  textEditPayloadOf,
} from '../edits';
import { createPdfiumProxy } from '../worker/pdfium-proxy';
import type { LocatedRun, TextEditRequest } from '../types';
import { textEditFailureReason } from './errors';
import { finalizeTextEdits } from './finalize';
import {
  createHarness,
  fixture,
  type Harness,
  inflatedContent,
  rawPdf,
  runWith,
  sameBytes,
  span,
  streamsContaining,
} from './test-helpers';

let h: Harness;
let target: EditTarget;

beforeAll(async () => {
  h = await createHarness();
  // `text.edit` only needs `applyTextEdit` (PdfiumProxy has every EditTarget method).
  target = {
    applyTextEdit: (request: TextEditRequest) => h.editor.applyTextEdit(request),
  } as unknown as EditTarget;
});

afterAll(async () => {
  await h.adapter.destroy();
});

const FOX = 'The quick brown fox jumps over the lazy dog.';
let editCounter = 0;

function textEdit(
  run: LocatedRun,
  word: string,
  replacement: string,
  tier: TextEditPayload['tier'] = 'auto',
): EngineEdit {
  return {
    id: `te-${++editCounter}`,
    source: run.source,
    pageIndex: run.pageIndex,
    kind: 'text.edit',
    payload: textEditPayloadOf({ run, ...span(run, word), replacement, tier, fit: 'overflow' }),
  };
}

describe('text.edit engine edits', () => {
  test('applying records tier, face and size; the inverse means "reopen and replay"', async () => {
    const id = await h.open(await fixture(simpleTextUrl));
    const run = await runWith(h, id, 0, 'fox');
    const edit = textEdit(run, 'fox', 'wolf', 1);
    const result = await applyEngineEditWithResult(target, edit);
    expect(result.textEdit).toMatchObject({ tier: 1, honesty: 'font-substituted' });
    expect(result.applied.payload).toMatchObject({
      tier: 1,
      face: 'Inter-Regular',
      fontSize: result.textEdit!.fontSize,
      replacement: 'wolf',
      run: { objectPath: run.objectPath, charStart: run.charStart, text: run.text },
    });
    expect(result.inverse).toMatchObject({
      id: `${edit.id}:undo`,
      kind: 'text.edit',
      payload: { replayRequired: true, of: edit.id },
    });
    expect(isReplayRequired(result.inverse)).toBe(true);
    expect(isReplayRequired(result.applied)).toBe(false);
    expect(result.inverse.inverse).toEqual(result.applied);
    // The history layer must reopen instead; applying the inverse says so.
    let error: unknown;
    try {
      await applyEngineEditWithResult(target, result.inverse);
    } catch (caught) {
      error = caught;
    }
    expect(textEditFailureReason(error)).toBe('replay-required');
    await h.adapter.close(id);
  });

  test('undo = reopen + replay: byte-identical to the session, per prefix of the edit list', async () => {
    const original = await fixture(simpleTextUrl);
    const id = await h.open(original);
    const steps: { edit: EngineEdit; bytes: ArrayBuffer }[] = [];
    const plan: [number, string, string, TextEditPayload['tier']][] = [
      [0, 'fox', 'cat', 'auto'],
      [0, 'lazy', 'sleepy', 1],
      [1, 'quick', 'slow', 2],
    ];
    for (const [page, word, replacement, tier] of plan) {
      const run = await runWith(h, id, page, word);
      const applied = await applyEngineEditWithResult(
        target,
        textEdit(run, word, replacement, tier),
      );
      steps.push({ edit: applied.applied, bytes: await h.adapter.save(id) });
    }
    await h.adapter.close(id);
    // The log survives JSON (workspace persistence) and replays onto the original bytes.
    const log = JSON.parse(JSON.stringify(steps.map((s) => s.edit))) as EngineEdit[];
    for (let n = 1; n <= log.length; n++) {
      const fresh = await h.open(original);
      const replayed = await replayEngineEdits(
        target,
        log.slice(0, n).map((e) => ({ ...e, source: fresh })),
      );
      expect(replayed.failed).toEqual([]);
      expect(sameBytes(await h.adapter.save(fresh), steps[n - 1]!.bytes)).toBe(true);
      await h.adapter.close(fresh);
    }
  });

  test('payloads are validated before anything runs', () => {
    const good = {
      run: { objectPath: [1], charStart: 0, charCount: 3, text: 'fox' },
      start: 0,
      end: 3,
      replacement: 'cat',
      tier: 'auto',
      fit: 'keep',
    };
    expect(readTextEditPayload(good)).toEqual(good);
    for (const bad of [
      null,
      { ...good, run: { ...good.run, objectPath: [] } },
      { ...good, tier: 3 },
      { ...good, fit: 'squeeze' },
      { ...good, replacement: 7 },
      { ...good, fontSize: -1 },
    ]) {
      expect(() => readTextEditPayload(bad)).toThrow(/Invalid text.edit payload/);
    }
    expect(textEditFailureReason(new Error('plain'))).toBeUndefined();
    expect(textEditFailureReason('[text-edit:stale-run] not an Error')).toBeUndefined();
  });

  test('replay re-checks the run: a changed page fails with stale-run', async () => {
    const id = await h.open(await fixture(simpleTextUrl));
    const run = await runWith(h, id, 0, 'fox');
    const edit = (await applyEngineEditWithResult(target, textEdit(run, 'fox', 'cat', 2))).applied;
    // Replaying the same edit onto the already edited source: "fox" is gone.
    const replayed = await replayEngineEdits(target, [edit]);
    expect(replayed.applied).toEqual([]);
    expect(replayed.failed).toHaveLength(1);
    expect(textEditFailureReason(replayed.failed[0]!.error)).toBe('stale-run');
    expect(replayed.failed[0]!.error.message).toContain('changed');
    await h.adapter.close(id);
  });
});

describe('finalizeTextEdits (export post-pass)', () => {
  test('a second edit on a page orphans the first stream; the GC pass removes it (inflated byte grep)', async () => {
    const bytes = await rawPdf({ content: `BT /F1 12 Tf 20 100 Td (${FOX}) Tj ET` });
    const id = await h.open(bytes);
    for (const [from, to] of [
      ['fox', 'cat'],
      ['cat', 'owl'],
    ] as const) {
      const run = await runWith(h, id, 0, from);
      await h.editor.applyTextEdit({
        run,
        ...span(run, from),
        replacement: to,
        tier: 2,
        fit: 'overflow',
      });
    }
    const saved = await h.adapter.save(id);
    await h.adapter.close(id);
    expect(await streamsContaining(saved, 'owl')).toBe(1);
    expect(await streamsContaining(saved, 'cat')).toBe(1); // unreachable, still written
    const finalized = await finalizeTextEdits(saved);
    expect(finalized.unreachableRemoved).toBeGreaterThan(0);
    expect(await streamsContaining(finalized.bytes, 'cat')).toBe(0);
    expect(await streamsContaining(finalized.bytes, 'fox')).toBe(0);
    expect(await streamsContaining(finalized.bytes, 'owl')).toBe(1);
    const reopened = await h.open(finalized.bytes);
    expect((await h.adapter.getPageText(reopened, 0)).map((r) => r.text)).toEqual([
      FOX.replace('fox', 'owl'),
    ]);
    await h.adapter.close(reopened);
  });

  test('subset fonts: /Untitled becomes a tagged name of the matched face (serif bold, mono, italic)', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 200]);
    const fonts = [
      [StandardFonts.TimesRomanBold, 150, 'NotoSerif-Bold'],
      [StandardFonts.Courier, 110, 'JetBrainsMono-Regular'],
      [StandardFonts.HelveticaOblique, 70, 'Inter-Regular'],
    ] as const;
    for (const [name, y] of fonts) {
      page.drawText(`Face test ${y}`, { x: 20, y, size: 12, font: await doc.embedFont(name) });
    }
    const id = await h.open(toBuffer(await doc.save()));
    for (const [, y, face] of fonts) {
      const run = await runWith(h, id, 0, `Face test ${y}`);
      const result = await h.editor.applyTextEdit({
        run,
        ...span(run, 'test'),
        replacement: 'Ωmega',
        tier: 'auto',
        fit: 'overflow',
      });
      expect(result).toMatchObject({ tier: 1, substitute: face, tier2Refusal: 'outside-winansi' });
    }
    const saved = await h.adapter.save(id);
    await h.adapter.close(id);
    const names = async (bytes: ArrayBuffer) => {
      const pdf = await PDFDocument.load(bytes);
      const out: string[] = [];
      for (const [, obj] of pdf.context.enumerateIndirectObjects()) {
        if (obj instanceof PDFDict && obj.get(PDFName.of('Subtype')) === PDFName.of('Type0')) {
          out.push(String(obj.get(PDFName.of('BaseFont'))));
        }
      }
      return out.sort();
    };
    expect(await names(saved)).toEqual(['/Untitled', '/Untitled', '/Untitled']);
    const finalized = await finalizeTextEdits(saved);
    expect(finalized.fontsRenamed).toBe(3);
    const renamed = await names(finalized.bytes);
    expect(renamed.map((n) => n.replace(/^\/[A-Z]{6}\+/, '')).sort()).toEqual([
      'Inter-Regular',
      'JetBrainsMono-Regular',
      'NotoSerif-Bold',
    ]);
    expect(renamed.every((n) => /^\/[A-Z]{6}\+/.test(n))).toBe(true);
    // Descendant and descriptor carry the same name; nothing is left untitled.
    expect(new TextDecoder('latin1').decode(finalized.bytes)).not.toContain('/Untitled');
  });

  test('tagged.pdf: split runs get fresh MCIDs under the original structure element', async () => {
    const original = await fixture(taggedUrl);
    const id = await h.open(original);
    const run = await runWith(h, id, 0, 'paragraph');
    expect(run.mcid).toBe(0);
    await h.editor.applyTextEdit({
      run,
      ...span(run, 'paragraph'),
      replacement: 'sentence',
      tier: 1,
      fit: 'overflow',
    });
    const saved = await h.adapter.save(id);
    await h.adapter.close(id);
    const before = (await inflatedContent(saved, 0)).page;
    expect(before.match(/MCID \d+/g)).toEqual(['MCID 0', 'MCID 0', 'MCID 0']);
    const finalized = await finalizeTextEdits(saved);
    expect(finalized.mcidsReassigned).toBe(2);
    const after = await inflatedContent(finalized.bytes, 0);
    expect(after.page.match(/MCID \d+/g)).toEqual(['MCID 0', 'MCID 1', 'MCID 2']);
    expect(after.page).toContain('/Artifact');
    // Page 2 is untouched.
    expect((await inflatedContent(finalized.bytes, 1)).page.match(/MCID \d+/g)).toEqual(['MCID 0']);
    const pdf = await PDFDocument.load(finalized.bytes);
    const root = pdf.catalog.lookup(PDFName.of('StructTreeRoot'), PDFDict);
    const nums = root
      .lookup(PDFName.of('ParentTree'), PDFDict)
      .lookup(PDFName.of('Nums'), PDFArray);
    const page0 = nums.lookup(1, PDFArray);
    expect(page0.size()).toBe(3);
    const owner = page0.get(0);
    expect(owner).toBeInstanceOf(PDFRef);
    expect([page0.get(1), page0.get(2)]).toEqual([owner, owner]);
    const paragraph = pdf.context.lookup(owner, PDFDict);
    const kids = paragraph.lookup(PDFName.of('K'), PDFArray);
    expect(kids.asArray().map((k) => (k as PDFNumber).asNumber())).toEqual([0, 1, 2]);
    // The text still reads in order.
    const reopened = await h.open(finalized.bytes);
    expect((await h.adapter.getPageText(reopened, 0))[0]?.text).toBe(
      'Tagged sentence on page 1 of tagged.',
    );
    await h.adapter.close(reopened);
  });
});

describe('PdfiumProxy (worker)', () => {
  test('locate, check and apply cross the worker; failure reasons survive the boundary', async () => {
    const worker = new Worker(new URL('../worker/pdfium.worker.ts', import.meta.url), {
      type: 'module',
      name: 'pdfium text-edit test',
    });
    const proxy = createPdfiumProxy(worker, { wasmUrl });
    try {
      const id = 'proxy-te' as SourceId;
      await proxy.open(id, await fixture(simpleTextUrl));
      const runs = await proxy.locateRuns(id, 0);
      const run = runs.find((r) => r.text.includes('fox'))!;
      expect(run.font).toMatchObject({ baseName: 'Helvetica', kind: 'standard14' });
      const check = await proxy.checkEditability({ run, ...span(run, 'fox'), replacement: 'cat' });
      expect(check).toMatchObject({ tier: 2, honesty: 'same-font-not-embedded' });
      const result = await proxy.applyTextEdit({
        run,
        ...span(run, 'fox'),
        replacement: 'cat',
        tier: 'auto',
        fit: 'keep',
      });
      expect(result.tier).toBe(2);
      expect((await proxy.getPageText(id, 0)).map((r) => r.text)).toContain(
        FOX.replace('fox', 'cat'),
      );
      let error: unknown;
      try {
        await proxy.applyTextEdit({
          run,
          ...span(run, 'fox'),
          replacement: 'owl',
          tier: 2,
          fit: 'keep',
        });
      } catch (caught) {
        error = caught;
      }
      expect(textEditFailureReason(error)).toBe('stale-run');
      // The EngineEdit path works against the proxy too.
      const fresh = (await proxy.locateRuns(id, 0)).find((r) => r.text.includes('lazy'))!;
      const applied = await applyEngineEditWithResult(proxy, textEdit(fresh, 'lazy', 'idle'));
      expect(applied.textEdit?.tier).toBe(2);
    } finally {
      await proxy.destroy();
    }
  });
});
