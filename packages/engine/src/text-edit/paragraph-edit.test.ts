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

  test('a dry run that empties the paragraph renders the page under it (the editor plate)', async () => {
    const id = await h.open(await rawPdf({ size: [400, 300], content: THREE_LINES }));
    const [block] = await blocksOf(id);
    if (!block) throw new Error('no paragraph');
    const preview = await h.editor.renderParagraphPreview(
      id,
      0,
      { ref: block.ref, text: '', caretSpan: { start: 0, end: block.text.length } },
      2,
    );
    expect(preview.result.committed).toBe(false);
    expect(preview.result.verification.readback).toBe('');
    expect(preview.clip.width).toBeGreaterThan(0);
    const canvas = new OffscreenCanvas(preview.width, preview.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.drawImage(preview.bitmap, 0, 0);
    preview.bitmap.close();
    const data = ctx.getImageData(0, 0, preview.width, preview.height).data;
    // No ink is left: the paragraph's area is page white.
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) if ((data[i] ?? 255) < 128) dark++;
    expect(dark).toBe(0);
    // The source is untouched.
    expect((await blocksOf(id))[0]?.text).toBe(block.text);
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

// ---------------------------------------------------------------------------
// Several changes in one session, the page edge, annotations over several lines
// ---------------------------------------------------------------------------

const THREE_LINES = [
  'BT /F1 12 Tf 1 0 0 1 40 250 Tm (The harbour master walked along the quay) Tj ET',
  'BT /F1 12 Tf 1 0 0 1 40 235.6 Tm (and counted the boats that came in with) Tj ET',
  'BT /F1 12 Tf 1 0 0 1 40 221.2 Tm (the evening tide.) Tj ET',
].join('\n');

/** A page with Helvetica as /F1 and Helvetica-Bold as /F2. */
async function twoFontPdf(content: string): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const page = doc.addPage([400, 300]);
  const font = (name: string) =>
    ctx.register(
      ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: name, Encoding: 'WinAnsiEncoding' }),
    );
  page.node.set(
    PDFName.of('Resources'),
    ctx.obj({ Font: { F1: font('Helvetica'), F2: font('Helvetica-Bold') } }),
  );
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.stream(content)));
  return toBuffer(await doc.save());
}

/**
 * Several separate changes typed in one editor session, sent as the web editor sends them:
 * one replacement from the first change to the last, with per-character style spans (typed
 * text in the style before the caret, untouched characters with their source offset).
 */
function sessionEdit(
  block: ParagraphBlock,
  spans: readonly { readonly start: number; readonly end: number; readonly style: string }[],
  changes: readonly (readonly [string, string])[],
): ParagraphEdit {
  const original = block.text;
  let text = original;
  let styles = Array.from(
    original,
    (_, i) => spans.find((s) => s.start <= i && i < s.end)?.style ?? 's0',
  );
  let origins = Array.from(original, (_, i) => i);
  for (const [word, replacement] of changes) {
    const at = text.indexOf(word);
    if (at < 0) throw new Error(`"${word}" not in "${text}"`);
    const typed = styles[at - 1] ?? styles[at] ?? 's0';
    text = text.slice(0, at) + replacement + text.slice(at + word.length);
    styles = [
      ...styles.slice(0, at),
      ...Array.from(replacement, () => typed),
      ...styles.slice(at + word.length),
    ];
    origins = [
      ...origins.slice(0, at),
      ...Array.from(replacement, () => -1),
      ...origins.slice(at + word.length),
    ];
  }
  let start = 0;
  while (start < text.length && origins[start] === start) start++;
  let suffix = 0;
  while (
    suffix < text.length - start &&
    origins[text.length - 1 - suffix] === original.length - 1 - suffix
  ) {
    suffix++;
  }
  const end = original.length - suffix;
  const out: { start: number; end: number; style: string; source?: number }[] = [];
  for (let i = start; i < text.length - suffix; i++) {
    const k = i - start;
    const style = styles[i] ?? 's0';
    const source = (origins[i] ?? -1) >= 0 ? origins[i] : undefined;
    const last = out[out.length - 1];
    const follows =
      last?.end === k &&
      last.style === style &&
      (source === undefined
        ? last.source === undefined
        : last.source !== undefined && last.source + (last.end - last.start) === source);
    if (last && follows) last.end = k + 1;
    else out.push({ start: k, end: k + 1, style, ...(source === undefined ? {} : { source }) });
  }
  return {
    ref: block.ref,
    text,
    caretSpan: { start, end },
    ...(out[0] ? { style: out[0].style } : {}),
    spans: out,
  };
}

/** The layout's view of a paragraph edit: the replaced range and the inserted text. */
function layoutEditFor(block: ParagraphBlock, edit: ParagraphEdit) {
  const { start, end } = edit.caretSpan;
  const inserted = edit.text.length - (block.text.length - (end - start));
  return { start, end, text: edit.text.slice(start, start + inserted) };
}

describe('several changes in one session', () => {
  const BOLD_LINE = [
    'BT /F1 12 Tf 1 0 0 1 40 250 Tm (The harbour ) Tj /F2 12 Tf (master) Tj /F1 12 Tf ( walked along the quay) Tj ET',
    'BT /F1 12 Tf 1 0 0 1 40 235.6 Tm (and counted the boats that came in with) Tj ET',
    'BT /F1 12 Tf 1 0 0 1 40 221.2 Tm (the evening tide.) Tj ET',
  ].join('\n');

  test('two fixes around a bold word keep the bold word bold, and replay byte-identically', async () => {
    const bytes = await twoFontPdf(BOLD_LINE);
    const id = await h.open(bytes);
    const [block] = await blocksOf(id);
    if (!block) throw new Error('no paragraph');
    const analysis = await h.editor.analyzeParagraphLayout(block.ref);
    const edit = sessionEdit(block, analysis.input.spans, [
      ['The', 'A'],
      ['quay', 'pier'],
    ]);
    expect(edit.caretSpan).toEqual({ start: 0, end: block.text.indexOf('quay') + 4 });
    const applied = await applyEngineEditWithResult(target, {
      id: 'two-fixes',
      source: id,
      pageIndex: 0,
      kind: 'text.editParagraph',
      payload: paragraphEditPayloadOf(edit),
    });
    expect(applied.paragraphEdit?.committed).toBe(true);
    const runs = await h.editor.locateRuns(id, 0);
    const fontOf = (word: string) => runs.find((r) => r.text.includes(word))?.font.baseName;
    expect(fontOf('master')).toBe('Helvetica-Bold');
    expect(fontOf('pier')).toBe('Helvetica');
    expect(fontOf('harbour')).toBe('Helvetica');
    expect((await blocksOf(id))[0]?.text).toBe(edit.text);
    const session = await h.adapter.save(id);
    await h.adapter.close(id);

    // The recorded spans survive JSON and replay writes the same bytes.
    const log = JSON.parse(JSON.stringify([applied.applied])) as EngineEdit[];
    expect(readParagraphEditPayload(log[0]?.payload).spans).toEqual(edit.spans);
    const fresh = await h.open(bytes);
    const replayed = await replayEngineEdits(
      target,
      log.map((e) => ({ ...e, source: fresh })),
    );
    expect(replayed.failed).toEqual([]);
    expect(sameBytes(await h.adapter.save(fresh), session)).toBe(true);
    await h.adapter.close(fresh);
  });

  test('a coloured, Span-tagged word between two fixes keeps its colour and MCID', async () => {
    const content = [
      'BT /F1 12 Tf 1 0 0 1 40 250 Tm /P <</MCID 0>> BDC (The harbour ) Tj EMC',
      '/Span <</MCID 1>> BDC 1 0 0 rg (master) Tj 0 g EMC',
      '/P <</MCID 2>> BDC ( walked along the quay) Tj EMC ET',
      'BT /F1 12 Tf 1 0 0 1 40 235.6 Tm /P <</MCID 3>> BDC (and counted the boats that came in with) Tj EMC ET',
      'BT /F1 12 Tf 1 0 0 1 40 221.2 Tm /P <</MCID 4>> BDC (the evening tide.) Tj EMC ET',
    ].join('\n');
    const id = await h.open(await rawPdf({ size: [400, 300], content }));
    const [block] = await blocksOf(id);
    if (!block) throw new Error('no paragraph');
    const analysis = await h.editor.analyzeParagraphLayout(block.ref);
    const edit = sessionEdit(block, analysis.input.spans, [
      ['The', 'A'],
      ['quay', 'pier'],
    ]);
    const result = await h.editor.applyParagraphEdit(id, 0, edit, { commit: true });
    expect(result.committed).toBe(true);
    const runs = await h.editor.locateRuns(id, 0);
    const master = runs.find((r) => r.text.includes('master'));
    expect(master?.mcid).toBe(1);
    expect(master?.fill?.slice(0, 3)).toEqual([255, 0, 0]);
    const pier = runs.find((r) => r.text.includes('pier'));
    expect(pier?.mcid).not.toBe(1);
    expect(pier?.fill?.slice(0, 3)).toEqual([0, 0, 0]);
    await h.adapter.close(id);
  });

  test('a layout that restyles an untouched character is refused before anything is written', async () => {
    const id = await h.open(await twoFontPdf(BOLD_LINE));
    const [block] = await blocksOf(id);
    if (!block) throw new Error('no paragraph');
    const analysis = await h.editor.analyzeParagraphLayout(block.ref);
    const edit = sessionEdit(block, analysis.input.spans, [
      ['The', 'A'],
      ['quay', 'pier'],
    ]);
    // The single-replacement model of the first release: one style for the whole range.
    const flattened = layoutParagraph(analysis.input, {
      ...layoutEditFor(block, edit),
      style: 's0',
    });
    const before = await h.adapter.save(id);
    const error = await rejection(
      h.editor.applyParagraphEdit(id, 0, { ...edit, layout: flattened }, { commit: true }),
    );
    expect(textEditFailureReason(error)).toBe('verification-failed');
    expect(String(error)).toMatch(/would change from s1 to s0/);
    // Spans claiming a source with another style are refused the same way.
    const lying: ParagraphEdit = {
      ...edit,
      spans: (edit.spans ?? []).map((s) => (s.style === 's1' ? { ...s, style: 's0' } : s)),
    };
    expect(
      textEditFailureReason(
        await rejection(h.editor.applyParagraphEdit(id, 0, lying, { commit: true })),
      ),
    ).toBe('verification-failed');
    // Spans naming characters the original does not have there are an invalid range.
    const shifted: ParagraphEdit = {
      ...edit,
      spans: (edit.spans ?? []).map((s) =>
        s.source === undefined ? s : { ...s, source: s.source + 1 },
      ),
    };
    expect(
      textEditFailureReason(
        await rejection(h.editor.applyParagraphEdit(id, 0, shifted, { commit: true })),
      ),
    ).toBe('invalid-range');
    expect(sameBytes(await h.adapter.save(id), before)).toBe(true);
    await h.adapter.close(id);
  });

  test('payloads with spans are validated; payloads without them still read', () => {
    const good = {
      paragraph: { index: 0, runs: [{ objectPath: [0], charStart: 0, charCount: 3, text: 'abc' }] },
      text: 'xbc',
      caretSpan: { start: 0, end: 1 },
      style: 's0',
    };
    expect(readParagraphEditPayload(good)).toEqual(good);
    const withSpans = { ...good, spans: [{ start: 0, end: 1, style: 's0' }] };
    expect(readParagraphEditPayload(withSpans)).toEqual(withSpans);
    for (const spans of [
      'nope',
      [{ start: 1, end: 1, style: 's0' }],
      [{ start: 0, end: 1, style: '' }],
      [{ start: 0, end: 1, style: 's0', source: -1 }],
      [
        { start: 0, end: 2, style: 's0' },
        { start: 1, end: 3, style: 's0' },
      ],
    ]) {
      expect(() => readParagraphEditPayload({ ...good, spans })).toThrow(
        /Invalid text.editParagraph payload/,
      );
    }
  });
});

describe('the page edge', () => {
  test('a paragraph near the bottom that would grow off the page is refused, nothing written', async () => {
    const content = [
      'BT /F1 12 Tf 1 0 0 1 40 40 Tm (The harbour master walked along the quay) Tj ET',
      'BT /F1 12 Tf 1 0 0 1 40 25.6 Tm (and counted the boats that came in with) Tj ET',
      'BT /F1 12 Tf 1 0 0 1 40 11.2 Tm (the evening tide.) Tj ET',
    ].join('\n');
    const id = await h.open(await rawPdf({ size: [400, 300], content }));
    const [block] = await blocksOf(id);
    if (!block) throw new Error('no paragraph');
    const analysis = await h.editor.analyzeParagraphLayout(block.ref);
    expect(analysis.pageRoom).toBeGreaterThan(0);
    expect(analysis.pageRoom).toBeLessThan(11.2);
    const edit = replace(
      block,
      'tide.',
      'tide, and then the fishing boats, and the ferry, and the small dinghies of the boys who rowed out to the buoys every evening to fish for mackerel.',
    );
    // The overflow policy says so before any write.
    const layoutEdit = layoutEditFor(block, edit);
    const layout = layoutParagraph(analysis.input, layoutEdit);
    const decision = decideOverflow(
      layout,
      {
        input: analysis.input,
        edit: layoutEdit,
        paragraphGap: analysis.paragraphGap,
        pageRoom: analysis.pageRoom,
      },
      analysis.gapBelow,
    );
    expect(decision).toMatchObject({ kind: 'overflow', offPage: true });
    const before = await h.adapter.save(id);
    for (const commit of [false, true]) {
      const error = await rejection(h.editor.applyParagraphEdit(id, 0, edit, { commit }));
      expect(paragraphRefusalReason(error)).toBe('off-page');
      expect(textEditFailureReason(error)).toBe('does-not-fit');
    }
    // A layout passed in (the overlay's) is checked against the page box as well.
    const forced = await rejection(
      h.editor.applyParagraphEdit(id, 0, { ...edit, layout }, { commit: true }),
    );
    expect(paragraphRefusalReason(forced)).toBe('off-page');
    expect(sameBytes(await h.adapter.save(id), before)).toBe(true);
    // A shorter text that stays on the page still commits.
    const short = replace(block, 'tide.', 'tide again.');
    expect((await h.editor.applyParagraphEdit(id, 0, short, { commit: true })).committed).toBe(
      true,
    );
    await h.adapter.close(id);
  });

  test('running over into content below that stays on the page keeps the warning', async () => {
    const content = [
      THREE_LINES,
      'BT /F1 12 Tf 1 0 0 1 40 190 Tm (A second paragraph sits right below the first one.) Tj ET',
    ].join('\n');
    const id = await h.open(await rawPdf({ size: [400, 300], content }));
    const [block] = await blocksOf(id);
    if (!block) throw new Error('no paragraph');
    const edit = replace(
      block,
      'tide.',
      'tide, and then the fishing boats, and the ferry, and the small dinghies of the boys who rowed out to the buoys every evening to fish for mackerel and herring.',
    );
    const result = await h.editor.applyParagraphEdit(id, 0, edit, { commit: false });
    expect(result.decision).toMatchObject({ kind: 'overflow', offPage: false });
    await h.adapter.close(id);
  });
});

describe('annotations over several lines', () => {
  test('a highlight over two words on two lines moves per quad with each word', async () => {
    const doc = await PDFDocument.load(await rawPdf({ size: [400, 300], content: THREE_LINES }));
    const page = doc.getPage(0);
    // Quads over "quay" (end of line 1) and "and" (start of line 2).
    const annot = doc.context.obj({
      Type: 'Annot',
      Subtype: 'Highlight',
      Rect: [40, 232, 275, 259],
      QuadPoints: [
        241, 259, 275, 259, 241, 247, 275, 247, 40, 244.6, 60, 244.6, 40, 232.6, 60, 232.6,
      ],
      C: [1, 1, 0],
      NM: PDFString.of('hl-1'),
    });
    page.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(annot)]));
    const id = await h.open(toBuffer(await doc.save()));
    const [block] = await blocksOf(id);
    if (!block) throw new Error('no paragraph');
    // Deleting "harbour " moves "quay" left and pulls "and" up onto line 1.
    const result = await h.editor.applyParagraphEdit(id, 0, replace(block, 'harbour ', ''), {
      commit: true,
    });
    expect(result.moved.map((m) => m.id)).toEqual(['hl-1']);
    const runs = await h.editor.locateRuns(id, 0);
    const glyphOf = (word: string) => {
      const run = runs.find((r) => r.text.includes(word));
      const at = run?.text.indexOf(word) ?? -1;
      return run?.glyphs.slice(at, at + word.length) ?? [];
    };
    const marked = (await h.adapter.listAnnotations(id, 0)).find((a) => a.id === 'hl-1');
    const quads = marked?.kind === 'highlight' ? marked.quads : [];
    expect(quads.length).toBeGreaterThanOrEqual(2);
    for (const word of ['quay', 'and ']) {
      for (const g of glyphOf(word.trim())) {
        const cx = g.rect.x + g.rect.width / 2;
        const cy = g.rect.y + g.rect.height / 2;
        const inside = quads.some(
          (q) =>
            cx >= q.x - 0.5 &&
            cx <= q.x + q.width + 0.5 &&
            cy >= q.y - 0.5 &&
            cy <= q.y + q.height + 0.5,
        );
        expect(inside, `"${g.text}" of "${word}" under a quad`).toBe(true);
      }
    }
    // The appearance is drawn again from the moved quads: yellow under every quad.
    const { bitmap, width, height } = await h.adapter.renderPage(id, 0, {
      scale: 2,
      withAnnotations: true,
    });
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const image = ctx.getImageData(0, 0, width, height);
    for (const q of quads) {
      let yellow = 0;
      let total = 0;
      for (let y = Math.ceil((300 - q.y - q.height) * 2); y < (300 - q.y) * 2; y++) {
        for (let x = Math.ceil(q.x * 2); x < (q.x + q.width) * 2; x++) {
          const i = (y * width + x) * 4;
          total++;
          const [r, g, b] = [image.data[i] ?? 0, image.data[i + 1] ?? 0, image.data[i + 2] ?? 0];
          if (r > 200 && g > 200 && b < 120) yellow++;
        }
      }
      expect(yellow / total, `quad at ${q.x.toFixed(1)} is highlighted`).toBeGreaterThan(0.3);
    }
    // Every quad and the /Rect stay on the page, the /Rect around the quads.
    const rect = marked?.rect;
    for (const q of quads) {
      expect(q.x).toBeGreaterThanOrEqual(0);
      expect(rect!.x).toBeLessThanOrEqual(q.x + 0.01);
      expect(rect!.x + rect!.width).toBeGreaterThanOrEqual(q.x + q.width - 0.01);
    }
    await h.adapter.close(id);
  });

  test('a link whose words rewrap onto two lines gets a quad per line', async () => {
    const doc = await PDFDocument.load(await rawPdf({ size: [400, 300], content: THREE_LINES }));
    const page = doc.getPage(0);
    // A link with quads over "along the quay" at the end of line 1.
    const link = doc.context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [168, 246, 262, 260],
      QuadPoints: [168, 260, 262, 260, 168, 246, 262, 246],
      Border: [0, 0, 0],
      NM: PDFString.of('link-2'),
    });
    page.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(link)]));
    const id = await h.open(toBuffer(await doc.save()));
    const [block] = await blocksOf(id);
    if (!block) throw new Error('no paragraph');
    // A longer word early in line 1 pushes "quay" (and perhaps "the") onto line 2.
    const edit = replace(block, 'master', 'harbourmaster');
    const result = await h.editor.applyParagraphEdit(id, 0, edit, { commit: true });
    expect(result.moved.map((m) => m.id)).toEqual(['link-2']);
    const runs = await h.editor.locateRuns(id, 0);
    const marked = (await h.adapter.listAnnotations(id, 0)).find((a) => a.id === 'link-2');
    const rect = marked?.rect;
    expect(rect).toBeDefined();
    for (const word of ['along', 'quay']) {
      const run = runs.find((r) => r.text.includes(word));
      const at = run?.text.indexOf(word) ?? -1;
      for (const g of run?.glyphs.slice(at, at + word.length) ?? []) {
        const cx = g.rect.x + g.rect.width / 2;
        const cy = g.rect.y + g.rect.height / 2;
        expect(cx).toBeGreaterThanOrEqual(rect!.x - 0.5);
        expect(cx).toBeLessThanOrEqual(rect!.x + rect!.width + 0.5);
        expect(cy).toBeGreaterThanOrEqual(rect!.y - 0.5);
        expect(cy).toBeLessThanOrEqual(rect!.y + rect!.height + 0.5);
      }
    }
    // "along" and "quay" are now on different lines.
    const lineOf = (word: string) => runs.find((r) => r.text.includes(word))?.baseline;
    expect(lineOf('along')).not.toBe(lineOf('quay'));
    await h.adapter.close(id);
  });
});

describe('tightening the whole paragraph', () => {
  test('when only the whole paragraph fits tightened, the overflow offers it and the writer takes it', async () => {
    const line = (y: number) =>
      `BT /F1 12 Tf 1 0 0 1 40 ${y} Tm (${Array.from({ length: 30 }, () => 'o').join(' ')}) Tj ET`;
    const content = [
      line(250),
      line(235.6),
      line(221.2),
      'BT /F1 12 Tf 1 0 0 1 40 191.2 Tm (The next paragraph starts here and stays put.) Tj ET',
    ].join('\n');
    const id = await h.open(await rawPdf({ size: [400, 300], content }));
    const [block] = await blocksOf(id);
    if (!block) throw new Error('no paragraph');
    expect(block.lines).toHaveLength(3);
    const analysis = await h.editor.analyzeParagraphLayout(block.ref);
    const at = block.text.length;
    const edit: ParagraphEdit = {
      ref: block.ref,
      text: `${block.text} o o`,
      caretSpan: { start: at, end: at },
    };
    const layoutEdit = layoutEditFor(block, edit);
    const decision = decideOverflow(
      layoutParagraph(analysis.input, layoutEdit),
      {
        input: analysis.input,
        edit: layoutEdit,
        paragraphGap: analysis.paragraphGap,
        pageRoom: analysis.pageRoom,
      },
      analysis.gapBelow,
    );
    expect(decision.kind).toBe('overflow');
    if (decision.kind !== 'overflow') return;
    expect(decision.offPage).toBe(false);
    const fit = decision.fit;
    if (!fit) throw new Error('no whole-paragraph fit');
    expect(fit.layout.lineDelta).toBe(0);
    expect(fit.layout.lines.every((l) => l.status === 'rewritten')).toBe(true);
    // The engine on its own runs over (the fit is the user's choice) ...
    const dry = await h.editor.applyParagraphEdit(id, 0, edit, { commit: false });
    expect(dry.decision.kind).toBe('overflow');
    // ... and writes the fit when it is chosen, verified, as a tightening.
    const result = await h.editor.applyParagraphEdit(
      id,
      0,
      { ...edit, layout: fit.layout },
      { commit: true },
    );
    expect(result.committed).toBe(true);
    expect(result.decision).toMatchObject({ kind: 'tighten', percent: fit.percent });
    const after = await blocksOf(id);
    expect(after[0]?.text).toBe(edit.text);
    expect(after[0]?.lines).toHaveLength(3);
    expect(after[1]?.text).toBe('The next paragraph starts here and stays put.');
    await h.adapter.close(id);
  });
});
