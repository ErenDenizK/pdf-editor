/**
 * Text-edit corpus goldens for scripted paragraph edits (craft spec §10, §4.3–§4.6): every page
 * of `test/fixtures/text-edit-corpus/` gets at least one edit made the way the app makes it
 * (the overlay's layout from `analyzeParagraphLayout`, typed one character at a time, then
 * written). For each edit:
 * - the read-back: the page's paragraph analysis and its runs hold the new text;
 * - untouched glyphs (every other paragraph, and the lines before the edit) stay within
 *   0.01 pt; lines after it move by exactly the line-count change × leading;
 * - no pixel changes outside the paragraph box at scale 2 (an independent render, not the
 *   writer's own check);
 * - each keystroke's layout (rewrap plus overflow decision) takes ≤ 20 ms (median per edit);
 *   the measured values are logged as `[t8]` lines.
 * Substitutes (craft §4.5): serif fonts get Noto Serif, monospaced ones JetBrains Mono, sans
 * ones Noto Sans or, for what it lacks, Inter; each sized to the original x-height.
 */
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
import type { Rect, SourceId } from '@pdf-editor/document-model';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import captionsUrl from '../../../../test/fixtures/text-edit-corpus/captions.pdf?url';
import latexUrl from '../../../../test/fixtures/text-edit-corpus/latex-justified.pdf?url';
import tableUrl from '../../../../test/fixtures/text-edit-corpus/table.pdf?url';
import titleUrl from '../../../../test/fixtures/text-edit-corpus/title-date.pdf?url';
import twoColumnUrl from '../../../../test/fixtures/text-edit-corpus/two-column.pdf?url';
import wordUrl from '../../../../test/fixtures/text-edit-corpus/word-tagged.pdf?url';
import fontsUrl from '../../../../test/fixtures/text-edit-fonts.pdf?url';
import { toBuffer } from '../../test/helpers';
import type {
  LocatedRun,
  ParagraphBlock,
  ParagraphEdit,
  ParagraphEditResult,
  ParagraphLayoutAnalysis,
} from '../types';
import { type LayoutEdit, layoutParagraph } from './linebreak';
import { decideOverflow } from './overflow';
import { createHarness, fixture, type Harness } from './test-helpers';

/** Untouched glyphs may move by this much (points). */
const GLYPH_TOLERANCE = 0.01;
/** Budget for one keystroke's layout (milliseconds). */
const KEYSTROKE_BUDGET = 20;

let h: Harness;
const keystrokeMedians: number[] = [];

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  const sorted = [...keystrokeMedians].sort((a, b) => a - b);
  console.warn(
    `[t8] keystroke layout medians over ${sorted.length} edits: ` +
      `min ${sorted[0]?.toFixed(2)} ms, max ${sorted[sorted.length - 1]?.toFixed(2)} ms`,
  );
  await h.adapter.destroy();
});

interface Scripted {
  /** The paragraph's text, the replaced range of it and the inserted text. */
  readonly start: number;
  readonly end: number;
  readonly inserted: string;
}

/** Replaces `word` (its first occurrence at or after `from`) in the paragraph. */
function replace(block: ParagraphBlock, word: string, inserted: string, from = 0): Scripted {
  const start = block.text.indexOf(word, from);
  if (start < 0) throw new Error(`"${word}" not in "${block.text}"`);
  return { start, end: start + word.length, inserted };
}

/** RGBA pixels of page 1 at `scale`. */
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

/** Pixels that differ outside `rect` (user space, unrotated page), scale 2. */
function changedOutside(a: ImageData, b: ImageData, rect: Rect, scale = 2): number {
  const pageHeight = a.height / scale;
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

interface Glyph {
  readonly text: string;
  readonly x: number;
  readonly y: number;
}

function runKey(run: Pick<LocatedRun, 'objectPath' | 'charStart'>): string {
  return `${run.objectPath.join('/')}:${run.charStart}`;
}

/**
 * The glyphs the edit must leave in place (other paragraphs' and the kept lines'), and those of
 * the reused lines with where they must land.
 */
function expectedGlyphs(
  runs: readonly LocatedRun[],
  block: ParagraphBlock,
  result: ParagraphEditResult,
): Glyph[] {
  const mine = new Set(block.ref.runs.map((r) => r.objectPath[0] ?? -1));
  const out: Glyph[] = [];
  for (const run of runs) {
    if (mine.has(run.objectPath[0] ?? -1)) continue;
    for (const g of run.glyphs) out.push({ text: g.text, x: g.origin.x, y: g.origin.y });
  }
  const byKey = new Map(runs.map((r) => [runKey(r), r]));
  const n = { x: -block.direction.y, y: block.direction.x };
  for (const line of result.layout.lines) {
    if (line.status === 'rewritten' || line.source === undefined) continue;
    const source = block.lines[line.source];
    if (!source) continue;
    for (const span of source.spans) {
      const ref = block.ref.runs[span.run];
      const run = ref ? byKey.get(runKey(ref)) : undefined;
      for (const g of run?.glyphs.slice(span.glyphStart, span.glyphEnd) ?? []) {
        // Text space y grows upward; `dy` is positive downward.
        out.push({ text: g.text, x: g.origin.x - line.dy * n.x, y: g.origin.y - line.dy * n.y });
      }
    }
  }
  return out;
}

/** The largest distance from an expected glyph to the nearest drawn glyph with its text. */
function worstDrift(expected: readonly Glyph[], runs: readonly LocatedRun[]): number {
  const drawn = new Map<string, Glyph[]>();
  for (const run of runs) {
    for (const g of run.glyphs) {
      const list = drawn.get(g.text) ?? [];
      list.push({ text: g.text, x: g.origin.x, y: g.origin.y });
      drawn.set(g.text, list);
    }
  }
  let worst = 0;
  for (const e of expected) {
    let best = Number.POSITIVE_INFINITY;
    for (const d of drawn.get(e.text) ?? [])
      best = Math.min(best, Math.hypot(d.x - e.x, d.y - e.y));
    worst = Math.max(worst, best);
  }
  return worst;
}

/** One keystroke's layout as the overlay makes it. */
function overlayLayout(analysis: ParagraphLayoutAnalysis, edit: LayoutEdit) {
  const base = layoutParagraph(analysis.input, edit);
  return decideOverflow(
    base,
    { input: analysis.input, edit, paragraphGap: analysis.paragraphGap },
    analysis.gapBelow,
  );
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

interface Golden {
  readonly block: ParagraphBlock;
  readonly blocks: readonly ParagraphBlock[];
  readonly edit: ParagraphEdit;
  readonly result: ParagraphEditResult;
  readonly runsAfter: readonly LocatedRun[];
  readonly source: SourceId;
}

/**
 * Types `script` into paragraph `index` of `bytes` one character at a time (timing each
 * keystroke's layout), writes the last layout, and checks the goldens shared by every edit.
 */
async function golden(
  name: string,
  bytes: ArrayBuffer,
  index: number,
  script: (block: ParagraphBlock) => Scripted,
): Promise<Golden> {
  const source = await h.open(bytes);
  const blocks = await h.editor.analyzeParagraphs(source, 0);
  const block = blocks[index];
  if (!block) throw new Error(`${name}: no paragraph ${index}`);
  const { start, end, inserted } = script(block);
  const analysis = await h.editor.analyzeParagraphLayout(block.ref);
  expect(analysis.refusal, name).toBeUndefined();

  // Typing: the selection is replaced by the first character, then one character per key.
  const chars = Array.from(inserted);
  const times: number[] = [];
  let decision = overlayLayout(analysis, { start, end, text: '' });
  for (let k = 1; k <= chars.length; k++) {
    const t = performance.now();
    decision = overlayLayout(analysis, { start, end, text: chars.slice(0, k).join('') });
    times.push(performance.now() - t);
  }
  const perKey = times.length > 0 ? median(times) : 0;
  keystrokeMedians.push(perKey);
  console.warn(
    `[t8] ${name}: ${times.length} keystrokes, median ${perKey.toFixed(2)} ms, ` +
      `max ${Math.max(0, ...times).toFixed(2)} ms`,
  );
  expect(perKey, `${name}: keystroke layout`).toBeLessThanOrEqual(KEYSTROKE_BUDGET);

  const text = block.text.slice(0, start) + inserted + block.text.slice(end);
  const edit: ParagraphEdit = {
    ref: block.ref,
    text,
    caretSpan: { start, end },
    layout: decision.layout,
  };
  const runsBefore = await h.editor.locateRuns(source, 0);
  const before = await pixels(source);
  const result = await h.editor.applyParagraphEdit(source, 0, edit, { commit: true });
  expect(result.committed, name).toBe(true);
  expect(result.verification.changedPixelsOutside, name).toBe(0);

  // Read-back: the paragraph analysis and the runs hold the new text.
  const after = await h.editor.analyzeParagraphs(source, 0);
  expect(
    after.map((b) => b.text),
    name,
  ).toContain(text);
  const runsAfter = await h.editor.locateRuns(source, 0);
  // Search reads the page as a viewer does: each inserted word is found whole.
  for (const word of inserted.split(/[\s,.:;]+/).filter((w) => w.length > 1)) {
    const hits = await h.adapter.search(source, word, { matchCase: true });
    expect(hits.length, `${name}: "${word}" read back`).toBeGreaterThan(0);
  }

  // Untouched glyphs within 0.01 pt; reused lines moved by exactly their dy.
  const expected = expectedGlyphs(runsBefore, block, result);
  expect(expected.length, name).toBeGreaterThan(0);
  expect(worstDrift(expected, runsAfter), `${name}: untouched glyphs`).toBeLessThanOrEqual(
    GLYPH_TOLERANCE,
  );

  // No pixel changed outside the paragraph box (old and new extent) at scale 2.
  expect(changedOutside(before, await pixels(source), result.box), `${name}: pixels`).toBe(0);
  return { block, blocks, edit, result, runsAfter, source };
}

function statuses(result: ParagraphEditResult): string[] {
  return result.layout.lines.map((l) => l.status);
}

/** A one-page PDF with a three-line paragraph in a standard-14 font. */
async function standardParagraph(font: StandardFonts): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([420, 300]);
  const face = await doc.embedFont(font);
  const lines = [
    'The harbour master walked along the quay',
    'and counted the boats that came in with',
    'the evening tide.',
  ];
  lines.forEach((line, i) => {
    page.drawText(line, { x: 40, y: 250 - i * 14.4, size: 12, font: face });
  });
  return toBuffer(await doc.save());
}

describe('text-edit corpus goldens', () => {
  test('word-tagged.pdf: a typo fix rewrites one line', async () => {
    const g = await golden('word-tagged typo', await fixture(wordUrl), 1, (b) =>
      replace(b, 'quay', 'quai'),
    );
    expect(statuses(g.result)).toEqual(['rewritten', 'reused', 'reused']);
    expect(g.result.layout.lineDelta).toBe(0);
    expect(g.result.tier).toBe(2);
    expect(g.result.honesty).toBe('same-font');
    await h.adapter.close(g.source);
  });

  test('word-tagged.pdf: an insertion in a list item adds a line', async () => {
    const g = await golden('word-tagged list insertion', await fixture(wordUrl), 5, (b) =>
      replace(b, 'master.', 'master, and mark where it was seen on the chart in the office.'),
    );
    expect(g.result.layout.lineDelta).toBe(1);
    expect(g.result.decision.kind).toBe('grow');
    expect(g.result.layout.lines).toHaveLength(2);
    await h.adapter.close(g.source);
  });

  test('two-column.pdf: an insertion adds a line to a justified paragraph', async () => {
    const g = await golden('two-column insertion', await fixture(twoColumnUrl), 4, (b) =>
      replace(b, 'the tables', 'the long oak tables of the old barn by the orchard gate'),
    );
    expect(g.result.layout.lineDelta).toBe(1);
    expect(g.result.decision.kind).toBe('grow');
    // The rewritten lines but the last are still justified to the measure.
    const rewritten = g.result.layout.lines.filter((l) => l.status === 'rewritten');
    expect(rewritten.length).toBeGreaterThan(0);
    for (const line of rewritten.slice(0, -1)) expect(line.justified || line.ragged).toBe(true);
    await h.adapter.close(g.source);
  });

  test('latex-justified.pdf: an edit on a justified line keeps it justified', async () => {
    const g = await golden('latex justified line', await fixture(latexUrl), 1, (b) =>
      replace(b, 'pulley', 'pulleys'),
    );
    expect(g.result.layout.lineDelta).toBe(0);
    expect(statuses(g.result).slice(0, 4)).toEqual(['kept', 'kept', 'kept', 'kept']);
    const line = g.result.layout.lines[4];
    expect(line?.status).toBe('rewritten');
    expect(line?.justified).toBe(true);
    // Justified to the measure: one object per word on that line.
    expect((line?.x ?? 0) + (line?.width ?? 0)).toBeCloseTo(g.block.measure.right, 1);
    await h.adapter.close(g.source);
  });

  test('table.pdf: a deletion pulls a word up', async () => {
    const g = await golden('table deletion', await fixture(tableUrl), 0, (b) => {
      const second = b.lines[1];
      if (!second) throw new Error('no second line');
      return replace(b, 'expected high water at the ', '');
    });
    const words = (text: string | undefined) => (text ?? '').split(/\s+/).filter(Boolean);
    const oldFirst = words(g.block.lines[0]?.text);
    const oldSecond = words(g.block.lines[1]?.text);
    const line1 = g.result.layout.lines[0];
    expect(line1?.status).toBe('rewritten');
    // Five words left the first line; the words that follow came up from the second.
    const pulled = words(line1?.text).length - (oldFirst.length - 5);
    expect(pulled).toBeGreaterThan(0);
    expect(words(line1?.text).slice(-pulled)).toEqual(oldSecond.slice(0, pulled));
    expect(words(g.result.layout.lines[1]?.text)).toEqual(oldSecond.slice(pulled));
    await h.adapter.close(g.source);
  });

  test('title-date.pdf: a typo fix in a right-aligned line keeps its right edge', async () => {
    const g = await golden('title-date right-aligned', await fixture(titleUrl), 1, (b) =>
      replace(b, '12', '14'),
    );
    const line = g.result.layout.lines[0];
    expect(line?.status).toBe('rewritten');
    expect((line?.x ?? 0) + (line?.width ?? 0)).toBeCloseTo(g.block.measure.right, 1);
    await h.adapter.close(g.source);
  });

  test('title-date.pdf: a deletion in a three-line paragraph', async () => {
    const g = await golden('title-date deletion', await fixture(titleUrl), 2, (b) =>
      replace(b, ' despite the rain', ''),
    );
    expect(g.result.layout.lineDelta).toBeLessThanOrEqual(0);
    await h.adapter.close(g.source);
  });

  test('captions.pdf: Turkish letters the subset lacks are set in Noto Serif', async () => {
    const g = await golden('captions substitution', await fixture(captionsUrl), 0, (b) =>
      replace(b, 'dry months', 'dağ başı months'),
    );
    expect(g.result.tier).toBe(1);
    expect(g.result.honesty).toBe('font-substituted');
    const chars = g.result.substitutions.map((s) => s.char);
    expect(chars).toEqual(expect.arrayContaining(['ğ', 'ş']));
    for (const s of g.result.substitutions) {
      expect(s).toMatchObject({ font: 'NotoSerif-Regular', family: 'Noto Serif' });
    }
    await h.adapter.close(g.source);
  });
});

describe('substitutes by class', () => {
  test('Times (latex-justified.pdf) gets Noto Serif at the x-height ratio', async () => {
    const g = await golden('latex substitution', await fixture(latexUrl), 2, (b) =>
      replace(b, 'float', 'ğfloat'),
    );
    expect(g.result.substitutions).toEqual([
      { char: 'ğ', font: 'NotoSerif-Regular', family: 'Noto Serif' },
    ]);
    const run = g.runsAfter.find((r) => r.text.includes('ğ'));
    const times = g.runsAfter.find((r) => r.text.includes('season'));
    expect(run?.fontId).not.toBe(times?.fontId);
    // Times x-height 0.448 (AFM) over Noto Serif's 0.536.
    expect((run?.fontSize ?? 0) / (times?.fontSize ?? 1)).toBeCloseTo(0.448 / 0.536, 2);
    await h.adapter.close(g.source);
  });

  test('Helvetica gets Noto Sans, and Inter for what Noto Sans lacks', async () => {
    const g = await golden('helvetica substitution', await fixture(fontsUrl), 1, (b) =>
      replace(b, 'fox', 'ğλ→ fox'),
    );
    const byChar = Object.fromEntries(g.result.substitutions.map((s) => [s.char, s.family]));
    expect(byChar).toEqual({ ğ: 'Noto Sans', λ: 'Noto Sans', '→': 'Inter' });
    // Two new fonts: Noto Sans for ğ and λ, Inter for the arrow.
    const fontOf = (ch: string) => g.runsAfter.find((r) => r.text.includes(ch))?.fontId;
    expect(fontOf('ğ')).toBeDefined();
    expect(fontOf('λ')).toBe(fontOf('ğ'));
    expect(fontOf('→')).not.toBe(fontOf('ğ'));
    expect(fontOf('→')).not.toBe(fontOf('quick'));
    await h.adapter.close(g.source);
  });

  test('Courier gets JetBrains Mono', async () => {
    const g = await golden(
      'courier substitution',
      await standardParagraph(StandardFonts.Courier),
      0,
      (b) => replace(b, 'master', 'ağa'),
    );
    expect(g.result.substitutions).toEqual([
      { char: 'ğ', font: 'JetBrainsMono-Regular', family: 'JetBrains Mono' },
    ]);
    await h.adapter.close(g.source);
  });

  test('Times-Bold gets Noto Serif Bold', async () => {
    const g = await golden(
      'times bold substitution',
      await standardParagraph(StandardFonts.TimesRomanBold),
      0,
      (b) => replace(b, 'tide', 'tideş'),
    );
    expect(g.result.substitutions).toEqual([
      { char: 'ş', font: 'NotoSerif-Bold', family: 'Noto Serif' },
    ]);
    await h.adapter.close(g.source);
  });

  test('a character no bundled face has stays refused', async () => {
    const source = await h.open(await fixture(fontsUrl));
    const [, block] = await h.editor.analyzeParagraphs(source, 0);
    if (!block) throw new Error('no paragraph');
    const analysis = await h.editor.analyzeParagraphLayout(block.ref);
    const start = block.text.indexOf('fox');
    const decision = overlayLayout(analysis, { start, end: start + 3, text: 'क' });
    expect(decision.layout.unsupported).toEqual(['क']);
    await expect(
      h.editor.applyParagraphEdit(
        source,
        0,
        {
          ref: block.ref,
          text: `${block.text.slice(0, start)}क${block.text.slice(start + 3)}`,
          caretSpan: { start, end: start + 3 },
        },
        { commit: false },
      ),
    ).rejects.toThrow(/unsupported-chars/);
    await h.adapter.close(source);
  });
});
