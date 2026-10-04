/**
 * The paragraph writer (craft spec §4.4–§4.6, ADR-0020 §3–§6) on the text-edit corpus
 * (test/fixtures/text-edit-corpus/) and synthetic pages: a typo fix changes one line and
 * nothing else; an insertion grows into the empty space below; justified lines stay
 * justified with one object per word; a deletion pulls a word up; tightening is reported
 * and applied; a missing character is set in the bundled substitute; dry runs leave the
 * source untouched; refusals; `text.editParagraph` replays byte-identically and undoes
 * through reopen + replay; annotations move with their words; timings as `[t5]` lines.
 */
import { PDFDocument, PDFName, PDFString } from '@cantoo/pdf-lib';
import type { EngineEdit, Rect, SourceId } from '@pdf-editor/document-model';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import taggedUrl from '../../../../test/fixtures/tagged.pdf?url';
import latexUrl from '../../../../test/fixtures/text-edit-corpus/latex-justified.pdf?url';
import twoColumnUrl from '../../../../test/fixtures/text-edit-corpus/two-column.pdf?url';
import wordUrl from '../../../../test/fixtures/text-edit-corpus/word-tagged.pdf?url';
import { sid, toBuffer, wasmUrl } from '../../test/helpers';
import {
  applyEngineEditWithResult,
  type EditTarget,
  isReplayRequired,
  paragraphEditPayloadOf,
  readParagraphEditPayload,
  replayEngineEdits,
} from '../edits';
import type { ParagraphBlock, ParagraphEdit, ParagraphEditResult } from '../types';
import { createPdfiumProxy } from '../worker/pdfium-proxy';
import { textEditFailureReason } from './errors';
import { finalizeTextEdits } from './finalize';
import { layoutParagraph } from './linebreak';
import { decideOverflow } from './overflow';
import { paragraphRefusalReason } from './paragraph-input';
import { createHarness, fixture, type Harness, rawPdf, rejection, sameBytes } from './test-helpers';

let h: Harness;
let target: EditTarget;

beforeAll(async () => {
  h = await createHarness();
  target = {
    applyParagraphEdit: h.editor.applyParagraphEdit.bind(h.editor),
  } as unknown as EditTarget;
});

afterAll(async () => {
  await h.adapter.destroy();
});

async function blocksOf(source: SourceId, pageIndex = 0): Promise<readonly ParagraphBlock[]> {
  return h.editor.analyzeParagraphs(source, pageIndex);
}

/** Replaces the `occurrence`-th `word` of the paragraph by `replacement`. */
function replace(block: ParagraphBlock, word: string, replacement: string): ParagraphEdit {
  const start = block.text.indexOf(word);
  if (start < 0) throw new Error(`"${word}" not in "${block.text}"`);
  const end = start + word.length;
  return {
    ref: block.ref,
    text: block.text.slice(0, start) + replacement + block.text.slice(end),
    caretSpan: { start, end },
  };
}

/** RGBA pixels of a page rendering. */
async function pixels(source: SourceId, scale = 2): Promise<ImageData> {
  const { bitmap, width, height } = await h.adapter.renderPage(source, 0, {
    scale,
    withAnnotations: false,
  });
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return ctx.getImageData(0, 0, width, height);
}

/** Pixels that differ outside `rect` (user space, page without rotation, height `pageHeight`). */
function changedOutside(
  a: ImageData,
  b: ImageData,
  rect: Rect,
  pageHeight: number,
  scale = 2,
): number {
  const x0 = Math.floor(rect.x * scale) - 2;
  const x1 = Math.ceil((rect.x + rect.width) * scale) + 2;
  const y0 = Math.floor((pageHeight - rect.y - rect.height) * scale) - 2;
  const y1 = Math.ceil((pageHeight - rect.y) * scale) + 2;
  let changed = 0;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      if (x >= x0 && x < x1 && y >= y0 && y < y1) continue;
      const i = (y * a.width + x) * 4;
      if (
        a.data[i] !== b.data[i] ||
        a.data[i + 1] !== b.data[i + 1] ||
        a.data[i + 2] !== b.data[i + 2]
      ) {
        changed++;
      }
    }
  }
  return changed;
}

function ms(start: number): string {
  return `${(performance.now() - start).toFixed(1)} ms`;
}

function lineStatuses(result: ParagraphEditResult): string[] {
  return result.layout.lines.map((l) => l.status);
}

describe('corpus edits', () => {
  test('a typo fix in word-tagged.pdf changes one line and nothing else', async () => {
    const id = await h.open(await fixture(wordUrl));
    const [, block] = await blocksOf(id);
    if (!block) throw new Error('no paragraph');
    const before = await pixels(id);
    const edit = replace(block, 'quay', 'quai');

    let t = performance.now();
    const dry = await h.editor.applyParagraphEdit(id, 0, edit, { commit: false });
    console.warn(`[t5] word-tagged typo dry run: ${ms(t)}`);
    expect(dry.committed).toBe(false);
    expect(lineStatuses(dry)).toEqual(['rewritten', 'reused', 'reused']);
    expect(dry.decision.kind).toBe('commit');
    expect(dry.tier).toBe(2);
    expect(dry.honesty).toBe('same-font');
    expect(dry.verification.changedPixelsOutside).toBe(0);
    expect(dry.verification.maxDrift).toBeLessThanOrEqual(0.01);
    expect(dry.verification.maxBoxError).toBeLessThanOrEqual(0.05);
    expect(dry.verification.objectsMoved).toBe(0);

    t = performance.now();
    const done = await h.editor.applyParagraphEdit(id, 0, edit, { commit: true });
    console.warn(`[t5] word-tagged typo commit: ${ms(t)}`);
    expect(done.committed).toBe(true);
    expect(done.layout).toEqual(dry.layout);

    // Read back: the paragraph's text, and nothing else on the page changed.
    const after = await blocksOf(id);
    expect(after.map((b) => b.text)).toEqual(
      (await blocksOf(await h.open(await fixture(wordUrl)))).map((b, i) =>
        i === 1 ? edit.text : b.text,
      ),
    );
    // No pixel outside the first line changed.
    const line = after[1]!.lines[0]!;
    const lineBox = {
      x: line.x0 - 2,
      y: line.baseline - 4,
      width: line.x1 - line.x0 + 4,
      height: 14,
    };
    expect(changedOutside(before, await pixels(id), lineBox, 841.92)).toBe(0);
    // MCIDs intact: every run of the paragraph keeps its marked-content id.
    const runs = await h.editor.locateRuns(id, 0);
    const mine = runs.filter((r) => after[1]!.ref.runs.some((x) => x.charStart === r.charStart));
    expect(new Set(mine.map((r) => r.mcid))).toEqual(new Set([1]));
    expect(after[1]!.source).toBe('tags');
    const finalized = await finalizeTextEdits(await h.adapter.save(id));
    expect(finalized.mcidsReassigned).toBe(0);
    await h.adapter.close(id);
  });

  test('an insertion that adds a line grows into the empty space below (two-column, untagged)', async () => {
    const id = await h.open(await fixture(twoColumnUrl));
    const blocks = await blocksOf(id);
    // The left column's last paragraph: nothing below it but the margin.
    const block = blocks.find((b) => b.text.startsWith('Sorting is done'));
    if (!block) throw new Error('no paragraph');
    const edit = replace(
      block,
      'the three.',
      'the three, as everyone who has ever sorted pears in the long barn will tell you.',
    );
    const result = await h.editor.applyParagraphEdit(id, 0, edit, { commit: true });
    expect(result.decision.kind).toBe('grow');
    expect(result.layout.lineDelta).toBe(1);
    expect(result.verification.changedPixelsOutside).toBe(0);
    const after = (await blocksOf(id)).find((b) => b.text.startsWith('Sorting is done'));
    expect(after?.text).toBe(edit.text);
    expect(after?.lines).toHaveLength(block.lines.length + 1);
    // The new line sits one leading below the old last line, in the same column.
    const last = after!.lines[after!.lines.length - 1]!;
    expect(last.baseline).toBeCloseTo(
      block.lines[block.lines.length - 1]!.baseline - block.leading,
      1,
    );
    expect(last.x0).toBeCloseTo(block.measure.left, 1);
    // The right column did not move.
    const right = blocks.filter((b) => b.measure.left > 300).map((b) => b.text);
    expect((await blocksOf(id)).filter((b) => b.measure.left > 300).map((b) => b.text)).toEqual(
      right,
    );
    await h.adapter.close(id);
  });

  test('a justified LaTeX-like line stays justified, one object per word', async () => {
    const id = await h.open(await fixture(latexUrl));
    const block = (await blocksOf(id)).find((b) => b.text.startsWith('The tidal gauge'));
    if (!block) throw new Error('no paragraph');
    expect(block.align).toBe('justify');
    const edit = replace(block, 'western', 'eastern');
    const result = await h.editor.applyParagraphEdit(id, 0, edit, { commit: true });
    const first = result.layout.lines[0]!;
    expect(first.status).toBe('rewritten');
    expect(first.justified).toBe(true);
    expect(first.x + first.width).toBeCloseTo(block.measure.right, 2);
    // One object per word on the rewritten justified lines.
    const rewrittenWords = result.layout.lines
      .filter((l) => l.status === 'rewritten')
      .reduce((n, l) => n + l.words.length, 0);
    expect(result.verification.objectsWritten).toBe(rewrittenWords);
    const runs = await h.editor.locateRuns(id, 0);
    const line = runs.filter((r) => Math.abs((r.baseline ?? 0) - block.lines[0]!.baseline) < 0.1);
    expect(line.length).toBe(first.words.length);
    expect((await blocksOf(id)).find((b) => b.text.startsWith('The tidal gauge'))?.text).toBe(
      edit.text,
    );
    await h.adapter.close(id);
  });

  test('a deletion pulls a word up', async () => {
    const id = await h.open(await fixture(wordUrl));
    const [, block] = await blocksOf(id);
    if (!block) throw new Error('no paragraph');
    const edit = replace(block, 'from green to grey ', '');
    const result = await h.editor.applyParagraphEdit(id, 0, edit, { commit: true });
    expect(result.layout.lineDelta).toBe(-1);
    expect(result.decision.kind).toBe('commit');
    expect(result.layout.lines[1]?.text.endsWith('sky.')).toBe(true);
    const after = (await blocksOf(id))[1];
    expect(after?.text).toBe(edit.text);
    expect(after?.lines).toHaveLength(2);
    await h.adapter.close(id);
  });

  test('an overflow is tightened by word spacing, reported and applied', async () => {
    const id = await h.open(await fixture(wordUrl));
    const [, , block] = await blocksOf(id);
    if (!block) throw new Error('no paragraph');
    const analysis = await h.editor.analyzeParagraphLayout(block.ref);
    expect(analysis.paragraphGap).toBeGreaterThan(0);
    // The shortest addition at the end that makes the paragraph grow past the gap.
    const words =
      ' and then the crew went home along the harbour wall in the evening light, talking about the weather and the price of apples on the island';
    let edit: ParagraphEdit | undefined;
    for (let n = 1; n <= words.length && !edit; n++) {
      const inserted = words.slice(0, n);
      if (inserted.endsWith(' ')) continue;
      const at = block.text.length - 1;
      const layoutEdit = { start: at, end: at, text: inserted };
      const layout = layoutParagraph(analysis.input, layoutEdit);
      if (layout.lineDelta <= 0) continue;
      const decision = decideOverflow(
        layout,
        { input: analysis.input, edit: layoutEdit, paragraphGap: analysis.paragraphGap },
        analysis.gapBelow,
      );
      if (decision.kind === 'tighten') {
        edit = {
          ref: block.ref,
          text: block.text.slice(0, at) + inserted + block.text.slice(at),
          caretSpan: { start: at, end: at },
        };
      }
    }
    if (!edit) throw new Error('no tightening case');
    const result = await h.editor.applyParagraphEdit(id, 0, edit, { commit: true });
    expect(result.decision.kind).toBe('tighten');
    if (result.decision.kind !== 'tighten') return;
    expect(result.decision.wordSpacing).toBeLessThan(1);
    expect(result.decision.wordSpacing).toBeGreaterThanOrEqual(0.85);
    expect(result.decision.percent).toBeGreaterThanOrEqual(1);
    expect(result.layout.wordSpacing).toBe(result.decision.wordSpacing);
    expect(result.layout.lineDelta).toBe(0);
    expect((await blocksOf(id))[2]?.text).toBe(edit.text);
    await h.adapter.close(id);
  });

  test('a character the font lacks is written in the bundled face and reported', async () => {
    const bytes = await rawPdf({
      size: [400, 300],
      content: [
        'BT /F1 12 Tf 1 0 0 1 40 250 Tm (The harbour master walked along the quay) Tj ET',
        'BT /F1 12 Tf 1 0 0 1 40 235.6 Tm (and counted the boats that came in with) Tj ET',
        'BT /F1 12 Tf 1 0 0 1 40 221.2 Tm (the evening tide.) Tj ET',
      ].join('\n'),
    });
    const id = await h.open(bytes);
    const [block] = await blocksOf(id);
    if (!block) throw new Error('no paragraph');
    expect(block.lines).toHaveLength(3);
    const edit = replace(block, 'master', 'ağa');
    const result = await h.editor.applyParagraphEdit(id, 0, edit, { commit: true });
    expect(result.tier).toBe(1);
    expect(result.honesty).toBe('font-substituted');
    expect(result.substitutions).toEqual([
      { char: 'ğ', font: 'NotoSans-Regular', family: 'Noto Sans' },
    ]);
    expect((await blocksOf(id))[0]?.text).toBe(edit.text);
    const runs = await h.editor.locateRuns(id, 0);
    const g = runs.find((r) => r.text.includes('ğ'));
    expect(g?.font.baseName).not.toBe('Helvetica');
    await h.adapter.close(id);
  });
});

describe('dry runs and previews', () => {
  test('a dry run leaves the source untouched', async () => {
    const id = await h.open(await fixture(wordUrl));
    const saved = await h.adapter.save(id);
    const [, block] = await blocksOf(id);
    if (!block) throw new Error('no paragraph');
    const result = await h.editor.applyParagraphEdit(id, 0, replace(block, 'gulls', 'grey gulls'), {
      commit: false,
    });
    expect(result.committed).toBe(false);
    expect(sameBytes(await h.adapter.save(id), saved)).toBe(true);
    expect((await blocksOf(id))[1]?.text).toBe(block.text);
    await h.adapter.close(id);
  });

  test('an edit that changes nothing writes nothing', async () => {
    const id = await h.open(await fixture(wordUrl));
    const saved = await h.adapter.save(id);
    const [, block] = await blocksOf(id);
    if (!block) throw new Error('no paragraph');
    const result = await h.editor.applyParagraphEdit(
      id,
      0,
      { ref: block.ref, text: block.text, caretSpan: { start: 4, end: 4 } },
      { commit: true },
    );
    expect(result.committed).toBe(false);
    expect(result.layout.lines.every((l) => l.status === 'kept')).toBe(true);
    expect(sameBytes(await h.adapter.save(id), saved)).toBe(true);
    await h.adapter.close(id);
  });

  test('the preview renders the paragraph area of the dry-run page', async () => {
    const id = await h.open(await fixture(wordUrl));
    const [, block] = await blocksOf(id);
    if (!block) throw new Error('no paragraph');
    const t = performance.now();
    const preview = await h.editor.renderParagraphPreview(
      id,
      0,
      replace(block, 'gulls', 'grey gulls'),
      1.5,
    );
    console.warn(`[t5] word-tagged preview (dry run + render): ${ms(t)}`);
    expect(preview.clip).toEqual(preview.result.box);
    expect(preview.width).toBe(
      Math.ceil((preview.clip.x + preview.clip.width) * 1.5) - Math.floor(preview.clip.x * 1.5),
    );
    expect(preview.bitmap.width).toBe(preview.width);
    preview.bitmap.close();
    await h.adapter.close(id);
  });
});

describe('refusals', () => {
  test('text in a form XObject is refused (tier 1 per line only)', async () => {
    const bytes = await rawPdf({
      content: 'q 1 0 0 1 0 0 cm /Fm1 Do Q',
      forms: {
        Fm1: 'BT /F1 12 Tf 1 0 0 1 40 150 Tm (Inside the form the text) Tj ET\nBT /F1 12 Tf 1 0 0 1 40 135.6 Tm (runs over two lines.) Tj ET',
      },
    });
    const id = await h.open(bytes);
    const [block] = await blocksOf(id);
    if (!block) throw new Error('no paragraph');
    const error = await rejection(
      h.editor.applyParagraphEdit(id, 0, replace(block, 'form', 'box'), { commit: false }),
    );
    expect(paragraphRefusalReason(error)).toBe('in-form');
    expect(textEditFailureReason(error)).toBe('not-editable');
    expect((await h.editor.analyzeParagraphLayout(block.ref)).refusal).toBe('in-form');
    await h.adapter.close(id);
  });

  test('what detection refuses stays refused (invisible text)', async () => {
    const bytes = await rawPdf({
      content: [
        'BT 3 Tr /F1 12 Tf 1 0 0 1 40 150 Tm (Recognised text that nobody) Tj ET',
        'BT 3 Tr /F1 12 Tf 1 0 0 1 40 135.6 Tm (can see on the page.) Tj ET',
      ].join('\n'),
    });
    const id = await h.open(bytes);
    const [block] = await blocksOf(id);
    if (!block) throw new Error('no paragraph');
    expect(block.refusal).toBe('invisible');
    const error = await rejection(
      h.editor.applyParagraphEdit(id, 0, replace(block, 'nobody', 'no one'), { commit: true }),
    );
    expect(paragraphRefusalReason(error)).toBe('invisible');
    await h.adapter.close(id);
  });

  test('a clip the rewritten glyphs would leave is refused', async () => {
    const bytes = await rawPdf({
      content: [
        'q 40 130 120 40 re W n',
        'BT /F1 12 Tf 1 0 0 1 40 150 Tm (The clipped line of text goes) Tj ET',
        'BT /F1 12 Tf 1 0 0 1 40 135.6 Tm (on past the window.) Tj ET',
        'Q',
      ].join('\n'),
    });
    const id = await h.open(bytes);
    const [block] = await blocksOf(id);
    if (!block) throw new Error('no paragraph');
    const error = await rejection(
      h.editor.applyParagraphEdit(id, 0, replace(block, 'The', 'Here the'), { commit: false }),
    );
    expect(paragraphRefusalReason(error)).toBe('clipped');
    await h.adapter.close(id);
  });

  test('a paragraph that changed since it was detected fails with stale-run', async () => {
    const id = await h.open(await fixture(wordUrl));
    const [, block] = await blocksOf(id);
    if (!block) throw new Error('no paragraph');
    const edit = replace(block, 'quay', 'quai');
    await h.editor.applyParagraphEdit(id, 0, edit, { commit: true });
    const error = await rejection(h.editor.applyParagraphEdit(id, 0, edit, { commit: false }));
    expect(textEditFailureReason(error)).toBe('stale-run');
    await h.adapter.close(id);
  });

  test('an edit whose text does not match its caret span is refused', async () => {
    const id = await h.open(await fixture(wordUrl));
    const [, block] = await blocksOf(id);
    if (!block) throw new Error('no paragraph');
    const error = await rejection(
      h.editor.applyParagraphEdit(
        id,
        0,
        { ref: block.ref, text: 'Something else', caretSpan: { start: 0, end: 3 } },
        { commit: false },
      ),
    );
    expect(textEditFailureReason(error)).toBe('invalid-range');
    await h.adapter.close(id);
  });
});

describe('text.editParagraph', () => {
  test('replay is byte-identical, and undo goes through reopen + replay', async () => {
    const original = await fixture(wordUrl);
    const id = await h.open(original);
    const untouched = await h.adapter.save(id);
    const [, block] = await blocksOf(id);
    if (!block) throw new Error('no paragraph');
    const edit: EngineEdit = {
      id: 'para-1',
      source: id,
      pageIndex: 0,
      kind: 'text.editParagraph',
      payload: paragraphEditPayloadOf(replace(block, 'the gulls followed it', 'gulls followed')),
    };
    const t = performance.now();
    const applied = await applyEngineEditWithResult(target, edit);
    console.warn(`[t5] word-tagged paragraph edit through the edit log: ${ms(t)}`);
    expect(applied.paragraphEdit?.committed).toBe(true);
    const payload = readParagraphEditPayload(applied.applied.payload);
    expect(payload.layout?.text).toBe(payload.text);
    expect(payload.tier).toBe(2);
    expect(isReplayRequired(applied.inverse)).toBe(true);
    expect(
      textEditFailureReason(await rejection(applyEngineEditWithResult(target, applied.inverse))),
    ).toBe('replay-required');
    const session = await h.adapter.save(id);
    await h.adapter.close(id);

    // Save → reopen → replay → the same bytes (the log survives JSON).
    const log = JSON.parse(JSON.stringify([applied.applied])) as EngineEdit[];
    const fresh = await h.open(original);
    const replayed = await replayEngineEdits(
      target,
      log.map((e) => ({ ...e, source: fresh })),
    );
    expect(replayed.failed).toEqual([]);
    expect(sameBytes(await h.adapter.save(fresh), session)).toBe(true);
    await h.adapter.close(fresh);

    // Undo: reopen the original and replay what remains (nothing).
    const undone = await h.open(original);
    expect((await replayEngineEdits(target, [])).applied).toEqual([]);
    expect(sameBytes(await h.adapter.save(undone), untouched)).toBe(true);
    await h.adapter.close(undone);
  });

  test('payloads are validated', () => {
    const good = {
      paragraph: { index: 1, runs: [{ objectPath: [3], charStart: 0, charCount: 1, text: 'T' }] },
      text: 'The',
      caretSpan: { start: 0, end: 1 },
    };
    expect(readParagraphEditPayload(good)).toEqual(good);
    for (const bad of [
      null,
      { ...good, paragraph: { index: -1, runs: good.paragraph.runs } },
      { ...good, paragraph: { index: 1, runs: [] } },
      { ...good, caretSpan: { start: 'a', end: 1 } },
      { ...good, tier: 3 },
      { ...good, layout: { text: 'other', lines: [] } },
    ]) {
      expect(() => readParagraphEditPayload(bad)).toThrow(/Invalid text.editParagraph payload/);
    }
  });
});

describe('marked content and annotations', () => {
  test('new lines in a tagged paragraph get one MCID per line under the original element', async () => {
    const id = await h.open(await fixture(wordUrl));
    const block = (await blocksOf(id))[5];
    if (!block) throw new Error('no paragraph');
    expect(block.tag).toBe('LI');
    const at = block.text.length - 1;
    // The capital "A" is not in the embedded subset: the second line mixes two fonts, so it
    // is written as three objects (three marked-content sequences before the export pass).
    const inserted =
      ', and to the ferry, the gulls, the quay, the sky, the keeper, the sailor, the harbour, the ferry. Also every day, very early';
    const edit: ParagraphEdit = {
      ref: block.ref,
      text: block.text.slice(0, at) + inserted + block.text.slice(at),
      caretSpan: { start: at, end: at },
    };
    const result = await h.editor.applyParagraphEdit(id, 0, edit, { commit: true });
    expect(result.decision.kind).toBe('grow');
    expect(result.layout.lineDelta).toBe(1);
    expect(result.tier).toBe(1);
    expect(result.verification.objectsWritten).toBeGreaterThan(result.layout.lines.length);
    const finalized = await finalizeTextEdits(await h.adapter.save(id));
    expect(finalized.mcidsReassigned).toBe(1);
    const reopened = await h.open(finalized.bytes);
    const after = (await blocksOf(reopened))[5];
    // Still one list item from the structure tree, with the new text.
    expect(after?.source).toBe('tags');
    expect(after?.text).toBe(edit.text);
    const runs = (await h.editor.locateRuns(reopened, 0)).filter((r) =>
      after!.ref.runs.some((x) => x.charStart === r.charStart),
    );
    const perLine = after!.lines.map(
      (line) =>
        new Set(
          line.spans.map(
            (s) => runs.find((r) => r.charStart === after!.ref.runs[s.run]?.charStart)?.mcid,
          ),
        ),
    );
    expect(perLine.map((ids) => ids.size)).toEqual([1, 1]);
    expect(perLine[0]).toEqual(new Set([5]));
    expect(perLine[1]).not.toEqual(new Set([5]));
    await h.adapter.close(reopened);
    await h.adapter.close(id);
  });

  test('a typo fix in tagged.pdf keeps the /P and its MCID', async () => {
    const id = await h.open(await fixture(taggedUrl));
    const [block] = await blocksOf(id);
    if (!block) throw new Error('no paragraph');
    expect(block.tag).toBe('P');
    const edit = replace(block, 'paragraph', 'paragraf');
    const result = await h.editor.applyParagraphEdit(id, 0, edit, { commit: true });
    expect(result.honesty).toBe('same-font-not-embedded');
    expect(result.verification.readback.replace(/\s+/g, '')).toBe(edit.text.replace(/\s+/g, ''));
    const finalized = await finalizeTextEdits(await h.adapter.save(id));
    expect(finalized.mcidsReassigned).toBe(0);
    const reopened = await h.open(finalized.bytes);
    const [after] = await blocksOf(reopened);
    expect(after).toMatchObject({ source: 'tags', tag: 'P', text: edit.text });
    expect((await h.editor.locateRuns(reopened, 0))[0]?.mcid).toBe(0);
    await h.adapter.close(reopened);
    await h.adapter.close(id);
  });

  test('a link over a word that moves moves with it, and is listed', async () => {
    const base = await rawPdf({
      size: [400, 300],
      content: [
        'BT /F1 12 Tf 1 0 0 1 40 250 Tm (The harbour master walked along the quay) Tj ET',
        'BT /F1 12 Tf 1 0 0 1 40 235.6 Tm (and counted the boats that came in with) Tj ET',
        'BT /F1 12 Tf 1 0 0 1 40 221.2 Tm (the evening tide.) Tj ET',
      ].join('\n'),
    });
    const doc = await PDFDocument.load(base);
    const page = doc.getPage(0);
    // A link over "evening" on the last line.
    const link = doc.context.register(
      doc.context.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [58, 218, 102, 232],
        NM: PDFString.of('link-1'),
        Border: [0, 0, 0],
      }),
    );
    // A highlight over "boats" on the second line (quad points: top left, top right, bottom
    // left, bottom right).
    const highlight = doc.context.register(
      doc.context.obj({
        Type: 'Annot',
        Subtype: 'Highlight',
        Rect: [124, 232, 156, 247],
        QuadPoints: [124, 247, 156, 247, 124, 232, 156, 232],
        NM: PDFString.of('highlight-1'),
        C: [1, 1, 0],
      }),
    );
    page.node.set(PDFName.of('Annots'), doc.context.obj([link, highlight]));
    const id = await h.open(toBuffer(await doc.save()));
    const [block] = await blocksOf(id);
    if (!block) throw new Error('no paragraph');
    // A long insertion on line 1 pushes a line down: the last line is reused one leading lower.
    const edit = replace(block, 'walked', 'walked slowly and thoughtfully, as he did every day,');
    const result = await h.editor.applyParagraphEdit(id, 0, edit, { commit: true });
    expect(result.moved.map((m) => m.id).sort()).toEqual(['highlight-1', 'link-1']);
    const moved = result.moved.find((m) => m.id === 'link-1')!;
    expect(moved).toMatchObject({ id: 'link-1', subtype: 'link' });
    expect(moved.to.y).toBeLessThan(moved.from.y);
    const annotations = await h.adapter.listAnnotations(id, 0);
    const rect = annotations.find((a) => a.id === 'link-1')?.rect;
    expect(rect?.y).toBeCloseTo(moved.to.y, 1);
    // The highlight's quad moved with "boats".
    const marked = annotations.find((a) => a.id === 'highlight-1');
    const boats = (await h.editor.locateRuns(id, 0)).find((r) => r.text.includes('boats'));
    const b0 = boats?.glyphs[boats.text.indexOf('boats')];
    const quad = marked?.kind === 'highlight' ? marked.quads[0] : undefined;
    expect(quad).toBeDefined();
    expect(b0!.origin.x).toBeGreaterThanOrEqual(quad!.x - 0.5);
    expect(b0!.origin.y).toBeGreaterThan(quad!.y);
    expect(b0!.origin.y).toBeLessThan(quad!.y + quad!.height);
    const evening = (await h.editor.locateRuns(id, 0)).find((r) => r.text.includes('evening'));
    const glyph = evening?.glyphs[evening.text.indexOf('evening')];
    expect(glyph!.origin.y).toBeGreaterThan(moved.to.y);
    expect(glyph!.origin.y).toBeLessThan(moved.to.y + moved.to.height);
    await h.adapter.close(id);
  });
});

describe('timings and the worker', () => {
  test('[t5] dry run and commit on corpus pages (warm)', async () => {
    for (const [name, url, index, word, replacement] of [
      ['word-tagged.pdf', wordUrl, 1, 'quay', 'quai'],
      ['two-column.pdf', twoColumnUrl, 3, 'cider press', 'apple press'],
      ['latex-justified.pdf', latexUrl, 1, 'western', 'eastern'],
    ] as const) {
      const id = await h.open(await fixture(url));
      const block = (await blocksOf(id))[index];
      if (!block) throw new Error(`no paragraph in ${name}`);
      const edit = replace(block, word, replacement);
      await h.editor.applyParagraphEdit(id, 0, edit, { commit: false }); // warm-up
      let t = performance.now();
      await h.editor.analyzeParagraphLayout(block.ref);
      const analyse = ms(t);
      t = performance.now();
      const dry = await h.editor.applyParagraphEdit(id, 0, edit, { commit: false });
      const dryTime = ms(t);
      t = performance.now();
      const done = await h.editor.applyParagraphEdit(id, 0, edit, { commit: true });
      console.warn(
        `[t5] ${name}: analysis ${analyse}, dry run ${dryTime}, commit ${ms(t)} (${done.verification.objectsWritten} objects written, ${done.layout.lines.filter((l) => l.status === 'rewritten').length} lines rewritten)`,
      );
      expect(done.layout).toEqual(dry.layout);
      await h.adapter.close(id);
    }
  });

  test('crosses the worker through the proxy (preview bitmap transferred)', async () => {
    const worker = new Worker(new URL('../worker/pdfium.worker.ts', import.meta.url), {
      type: 'module',
      name: 'pdfium paragraph writer test',
    });
    const proxy = createPdfiumProxy(worker, { wasmUrl });
    try {
      const id: SourceId = sid('paragraph-writer-proxy');
      await proxy.open(id, await fixture(latexUrl));
      const block = (await proxy.analyzeParagraphs(id, 0))[1];
      if (!block) throw new Error('no paragraph');
      const analysis = await proxy.analyzeParagraphLayout(block.ref);
      expect(analysis.input.align).toBe('justify');
      expect(analysis.text).toBe(block.text);
      const edit = replace(block, 'western', 'eastern');
      const preview = await proxy.renderParagraphPreview(id, 0, edit, 1);
      expect(preview.bitmap.width).toBe(preview.width);
      expect(preview.result.committed).toBe(false);
      preview.bitmap.close();
      const done = await proxy.applyParagraphEdit(id, 0, edit, { commit: true });
      expect(done.committed).toBe(true);
      expect((await proxy.analyzeParagraphs(id, 0))[1]?.text).toBe(edit.text);
      const error = await rejection(proxy.applyParagraphEdit(id, 0, edit, { commit: false }));
      expect(textEditFailureReason(error)).toBe('stale-run');
    } finally {
      await proxy.destroy();
    }
  });
});
