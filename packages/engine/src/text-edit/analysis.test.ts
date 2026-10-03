/**
 * The editor's one-off run analysis and the beta.1 speed-ups (craft spec §4.8): advances
 * measured once agree with the engine's check, blockers and refusals are known up front, the
 * free space at the end of a line stops at its column, read-only calls queue behind renders,
 * and an analysis racing a close or reopen only fails.
 */
import type { SourceId } from '@pdf-editor/document-model';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import fontsUrl from '../../../../test/fixtures/text-edit-fonts.pdf?url';
import markdownUrl from '../../../../test/fixtures/markdown-source.pdf?url';
import type { LocatedRun, TextRunAnalysis } from '../types';
import {
  createHarness,
  fixture,
  type Harness,
  onBaseline,
  pageText,
  rawPdf,
  rejection,
  runWith,
  span,
} from './test-helpers';

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h.adapter.destroy();
});

const FOX = 'The quick brown fox jumps over the lazy dog';

/** Sum of the tier-2 advances of `text` (undefined when a character is not measured). */
function tier2Width(analysis: TextRunAnalysis, text: string): number | undefined {
  let width = 0;
  for (const ch of text) {
    const advance = analysis.tier2.advances[ch];
    if (!advance) return undefined;
    width += advance.spaced;
  }
  return width;
}

function tier1Width(analysis: TextRunAnalysis, text: string): number | undefined {
  let width = 0;
  for (const ch of text) {
    const advance = analysis.tier1?.advances[ch];
    if (advance === undefined) return undefined;
    width += advance;
  }
  return width;
}

/** Right edge of a run's ink, user space (horizontal text). */
const rightOf = (run: LocatedRun) => run.lineBox.x + run.lineBox.width;
const baselineOf = (run: LocatedRun) => run.glyphs[0]?.origin.y ?? 0;

describe('run analysis', () => {
  test('measures once what the check measures per keystroke (Helvetica, standard 14)', async () => {
    const id = await h.open(await fixture(fontsUrl));
    const run = await runWith(h, id, 0, 'fox', onBaseline(700));
    const analysis = await h.editor.analyzeRun(run);
    expect(analysis.blocker).toBeUndefined();
    expect(analysis.honesty).toEqual({
      tier2: 'same-font-not-embedded',
      tier1: 'font-substituted',
    });
    expect(analysis.tier2.refusal).toBeUndefined();
    expect(analysis.tier1?.substitute).toBe('Inter-Regular');
    // Outside WinAnsi: refused up front, as the check's pre-check does.
    expect(analysis.tier2.refused['ğ']).toBe('outside-winansi');
    expect(analysis.tier2.advances['ğ']).toBeUndefined();

    for (const replacement of ['wolf', 'Wolves & co.', 'a b']) {
      const check = await h.editor.checkEditability({
        run,
        ...span(run, 'fox'),
        replacement,
      });
      expect(tier2Width(analysis, replacement)).toBeCloseTo(check.fit.tier2!.width, 3);
      expect(tier1Width(analysis, replacement)).toBeCloseTo(check.fit.tier1!.width, 3);
    }
    // The line's end: the run's advance and the free space to the page edge (one line).
    const dog = await h.editor.checkEditability({
      run,
      ...span(run, 'dog'),
      replacement: 'doggies',
    });
    const dogStart = run.glyphs[FOX.indexOf('dog')]!.origin.x - run.glyphs[0]!.origin.x;
    expect(analysis.lineBound).toBe('page');
    expect(analysis.lineEnd - dogStart).toBeCloseTo(dog.fit.available, 3);
    expect(analysis.runEnd - dogStart).toBeCloseTo(dog.fit.replaced, 3);
    await h.adapter.close(id);
  });

  test('a subset font: characters it lacks are refused, the substitute measures them', async () => {
    const id = await h.open(await fixture(fontsUrl));
    const run = await runWith(h, id, 0, 'fox', onBaseline(650));
    const analysis = await h.editor.analyzeRun(run);
    expect(analysis.honesty.tier2).toBe('same-font');
    expect(analysis.tier2.refused.F).toBe('missing-glyphs');
    expect(analysis.tier2.advances.f).toBeDefined();
    expect(analysis.tier1?.advances.F).toBeGreaterThan(0);
    const check = await h.editor.checkEditability({
      run,
      ...span(run, 'fox'),
      replacement: 'cat',
    });
    expect(tier2Width(analysis, 'cat')).toBeCloseTo(check.fit.tier2!.width, 3);
    await h.adapter.close(id);
  });

  test('blocked runs say so without measuring', async () => {
    const bytes = await rawPdf({ content: 'BT /F1 12 Tf 3 Tr 20 100 Td (Hidden OCR text) Tj ET' });
    const id = await h.open(bytes);
    const run = await runWith(h, id, 0, 'Hidden');
    const analysis = await h.editor.analyzeRun(run);
    expect(analysis.blocker).toBe('invisible');
    expect(analysis.tier2).toEqual({ refusal: 'blocked', advances: {}, refused: {} });
    expect(analysis.tier1).toBeUndefined();
    await h.adapter.close(id);
  });

  test('leaves the page as it was', async () => {
    const id = await h.open(await fixture(fontsUrl));
    const before = await pageText(h, id, 0);
    const saved = await h.adapter.save(id);
    const run = await runWith(h, id, 0, 'fox', onBaseline(700));
    await h.editor.analyzeRun(run);
    expect(await pageText(h, id, 0)).toEqual(before);
    expect(new Uint8Array(await h.adapter.save(id))).toEqual(new Uint8Array(saved));
    await h.adapter.close(id);
  });

  test('timing: one analysis against one dry run per keystroke', async () => {
    const id = await h.open(await fixture(fontsUrl));
    const run = await runWith(h, id, 0, 'fox', onBaseline(700));
    await h.editor.analyzeRun(run); // warm-up (faces, pdf-lib)
    let t = performance.now();
    const analysis = await h.editor.analyzeRun(run);
    const analyse = performance.now() - t;
    const typed = 'The quick brown cat';
    t = performance.now();
    for (let k = 1; k <= typed.length; k++) {
      await h.editor.checkEditability({ run, start: 0, end: 3, replacement: typed.slice(0, k) });
    }
    const checks = (performance.now() - t) / typed.length;
    t = performance.now();
    let width = 0;
    for (let n = 0; n < 1000; n++) width += tier2Width(analysis, typed) ?? 0;
    const arithmetic = (performance.now() - t) / 1000;
    expect(width).toBeGreaterThan(0);
    // Measurements for the report (warn: the only level the lint allows in tests).
    console.warn(
      'text-edit timing',
      JSON.stringify({
        analyzeRunMs: +analyse.toFixed(2),
        checkEditabilityPerKeystrokeMs: +checks.toFixed(2),
        arithmeticPerKeystrokeMs: +arithmetic.toFixed(4),
      }),
    );
    await h.adapter.close(id);
  });
});

describe('free space bounded by the column', () => {
  test('two columns on shared baselines (markdown-source.pdf page 2)', async () => {
    const id = await h.open(await fixture(markdownUrl));
    const runs = (await h.editor.locateRuns(id, 1)).filter((r) => r.fontSize === 11);
    const right = runs.filter((r) => (r.glyphs[0]?.origin.x ?? 0) > 300);
    const left = runs.filter((r) => (r.glyphs[0]?.origin.x ?? 0) < 100);
    expect(right.length).toBeGreaterThan(1);
    expect(left.length).toBeGreaterThan(1);
    const edgeOf = (column: LocatedRun[]) => Math.max(...column.map(rightOf));
    // 11 pt body: the space may run half a line height past the column's longest line.
    for (const column of [right, left]) {
      const last = [...column].sort((a, b) => baselineOf(a) - baselineOf(b))[0]!;
      const words = last.text.trim().split(/\s+/);
      const word = words[words.length - 1]!;
      const check = await h.editor.checkEditability({
        run: last,
        ...span(last, word),
        replacement: `${word} and more words`,
      });
      const start = last.glyphs[last.text.lastIndexOf(word)]!.origin.x;
      if (check.fit.boundedBy === 'glyph') continue; // the other column's glyph came first
      expect(check.fit.boundedBy).toBe('column');
      expect(check.fit.boundedByGlyph).toBe(false);
      // The edge: the column's furthest ink, or the line's own advance when it is the longest.
      const edge = Math.max(edgeOf(column), start + check.fit.replaced);
      expect(check.fit.available).toBeCloseTo(edge + 5.5 - start, 2);
      // Not to the page edge (612 pt) any more.
      expect(start + check.fit.available).toBeLessThan(edge + 6);
    }
    await h.adapter.close(id);
  });

  test('a ragged column: the edge is its longest line; the gutter beats the next column', async () => {
    const line = (x: number, y: number, text: string) =>
      `BT /F1 12 Tf ${x} ${y} Td (${text}) Tj ET`;
    const bytes = await rawPdf({
      size: [612, 400],
      content: [
        line(72, 300, 'Left column line one is long'),
        line(72, 286, 'Left two'),
        line(72, 272, 'Left three ends'),
        line(324, 300, 'Right column first line text'),
        line(324, 286, 'Right second line'),
        line(324, 272, 'Right end'),
        line(72, 200, 'A lone heading'),
      ].join('\n'),
    });
    const id = await h.open(bytes);
    const runs = await h.editor.locateRuns(id, 0);
    const byText = (text: string) => runs.find((r) => r.text === text)!;
    const rightEdge = rightOf(byText('Right column first line text'));
    const leftEdge = rightOf(byText('Left column line one is long'));

    const end = byText('Right end');
    const endCheck = await h.editor.checkEditability({
      run: end,
      ...span(end, 'end'),
      replacement: 'end of it',
    });
    const endStart = end.glyphs[6]!.origin.x;
    expect(endCheck.fit).toMatchObject({ boundedBy: 'column', boundedByGlyph: false });
    expect(endCheck.fit.available).toBeCloseTo(rightEdge + 6 - endStart, 2);

    // "Left two" has the right column's glyph on its baseline at x 324; its column ends first.
    const two = byText('Left two');
    const twoCheck = await h.editor.checkEditability({
      run: two,
      ...span(two, 'two'),
      replacement: 'two more',
    });
    expect(twoCheck.fit.boundedBy).toBe('column');
    expect(twoCheck.fit.available).toBeCloseTo(leftEdge + 6 - two.glyphs[5]!.origin.x, 2);

    // A line with no neighbours keeps the page edge.
    const lone = byText('A lone heading');
    const loneCheck = await h.editor.checkEditability({
      run: lone,
      ...span(lone, 'heading'),
      replacement: 'heading again',
    });
    expect(loneCheck.fit.boundedBy).toBe('page');
    expect(lone.glyphs[7]!.origin.x + loneCheck.fit.available).toBeCloseTo(612, 2);

    // The analysis reports the same bound.
    const analysis = await h.editor.analyzeRun(end);
    expect(analysis.lineBound).toBe('column');
    expect(analysis.lineEnd + end.glyphs[0]!.origin.x).toBeCloseTo(rightEdge + 6, 2);
    await h.adapter.close(id);
  });
});

describe('queueing', () => {
  /** Holds the orchestrator's single slot for `ms`. */
  function busy(id: SourceId, ms: number): Promise<void> {
    return h.host.withRawTask(id, () => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  test('read-only analysis and dry runs wait behind a render queued after them', async () => {
    const id = await h.open(await fixture(fontsUrl));
    const run = await runWith(h, id, 0, 'fox', onBaseline(700));
    const order: string[] = [];
    const slot = busy(id, 80);
    const analysis = h.editor.analyzeRun(run).then(() => order.push('analyzeRun'));
    const check = h.editor
      .checkEditability({ run, ...span(run, 'fox'), replacement: 'cat' })
      .then(() => order.push('checkEditability'));
    const located = h.editor.locateRuns(id, 0).then(() => order.push('locateRuns'));
    // Queued after them (the analysis and check are in the queue once their lock is taken).
    await new Promise((resolve) => setTimeout(resolve, 20));
    const render = h.adapter.renderPage(id, 0, { scale: 0.5 }).then(() => order.push('render'));
    await Promise.all([slot, analysis, check, located, render]);
    expect(order[0]).toBe('render');
    expect(order).toHaveLength(4);
    await h.adapter.close(id);
  });

  test('an edit still goes ahead of renders', async () => {
    const id = await h.open(await fixture(fontsUrl));
    const run = await runWith(h, id, 0, 'fox', onBaseline(700));
    const order: string[] = [];
    const slot = busy(id, 80);
    const render = h.adapter.renderPage(id, 0, { scale: 0.5 }).then(() => order.push('render'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const edit = h.editor
      .applyTextEdit({ run, ...span(run, 'fox'), replacement: 'cat', tier: 'auto', fit: 'keep' })
      .then(() => order.push('edit'));
    await Promise.all([slot, render, edit]);
    expect(order).toEqual(['edit', 'render']);
    await h.adapter.close(id);
  });

  test('an analysis racing a close and reopen only fails; the reopened page is intact', async () => {
    const bytes = await fixture(fontsUrl);
    const id = await h.open(bytes);
    const run = await runWith(h, id, 0, 'fox', onBaseline(700));
    const before = await pageText(h, id, 0);
    // Closed: the analysis fails.
    await h.adapter.close(id);
    expect(await rejection(h.editor.analyzeRun(run))).toBeInstanceOf(Error);
    // Racing the reopen: it resolves for the page it saw or fails, never anything else.
    const racing = h.editor.analyzeRun(run).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await h.adapter.open(id, bytes.slice(0));
    const outcome = await racing;
    if (outcome.ok) expect(outcome.value.run.text).toBe(FOX);
    else expect(outcome.error).toBeInstanceOf(Error);
    expect(await pageText(h, id, 0)).toEqual(before);
    const again = await h.editor.analyzeRun(await runWith(h, id, 0, 'fox', onBaseline(700)));
    expect(again.blocker).toBeUndefined();
    await h.adapter.close(id);
  });
});
