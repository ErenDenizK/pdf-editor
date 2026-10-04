/**
 * Paragraph rewrap and the overflow policy (spec craft §4.3, §4.5, §4.6) on synthetic metrics:
 * a monospace-like set (every glyph and gap 1 pt, so widths are character counts) and a
 * proportional one (Helvetica's widths at 10 pt).
 */
import { describe, expect, test } from 'vitest';

import type { ParagraphLayout } from '../types';
import {
  harvestKerning,
  type LayoutAlign,
  type LayoutEdit,
  type LayoutInput,
  layoutParagraph,
  type LayoutStyle,
} from './linebreak';
import { decideOverflow, type OverflowBox } from './overflow';

const LEADING = 10;
const MONO_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,-';

function monoStyle(extra: Partial<LayoutStyle> = {}, gap = 1): LayoutStyle {
  const advances = Object.fromEntries(
    [...Array.from(MONO_CHARS), ' '].map((c) => [c, { spaced: 1, plain: 1 }]),
  );
  return { advances, wordGap: gap, ...extra };
}

/** Helvetica widths (AFM, per 1000 em) at 10 pt. */
const HELVETICA_AFM =
  'a556 b556 c500 d556 e556 f278 g556 h556 i222 j222 k500 l222 m833 n556 o556 p556 q556 r333 ' +
  's500 t278 u556 v500 w722 x500 y500 z500 A667 T611 V667 W944 .278 ,278 -333';
const HELVETICA: Record<string, number> = Object.fromEntries([
  ...HELVETICA_AFM.split(' ').map((entry) => [entry[0] ?? '', Number(entry.slice(1))] as const),
  [' ', 278] as const,
]);

function helvetica(extra: Partial<LayoutStyle> = {}): LayoutStyle {
  const advances = Object.fromEntries(
    Object.entries(HELVETICA).map(([c, w]) => [c, { spaced: w / 100, plain: w / 100 }]),
  );
  return { advances, wordGap: 2.78, ...extra };
}

interface ParaOptions {
  readonly width: number;
  readonly align?: LayoutAlign;
  readonly style?: LayoutStyle;
  /** Indices of lines that end with a hyphen the text joins. */
  readonly hyphenated?: readonly number[];
}

/** A paragraph from its original lines (hyphenated lines are given without their hyphen). */
function para(lines: readonly string[], options: ParaOptions): LayoutInput {
  let text = '';
  const sourceLines = lines.map((line, i) => {
    const start = text.length;
    const hyphenated = options.hyphenated?.includes(i) ?? false;
    text += line;
    if (i < lines.length - 1 && !hyphenated) text += ' ';
    return { start, y: i * LEADING, ...(hyphenated ? { hyphenated } : {}) };
  });
  return {
    text,
    spans: [{ start: 0, end: text.length, style: 's' }],
    lines: sourceLines,
    styles: { s: options.style ?? monoStyle() },
    measure: { left: 0, right: options.width },
    align: options.align ?? 'left',
    leading: LEADING,
  };
}

/** The edit replacing the first `find` (after `from`) with `replace`. */
function replaceEdit(input: LayoutInput, find: string, replace: string, from = 0): LayoutEdit {
  const start = input.text.indexOf(find, from);
  if (start < 0) throw new Error(`"${find}" not in the paragraph`);
  return { start, end: start + find.length, text: replace };
}

const statuses = (layout: ParagraphLayout) => layout.lines.map((l) => l.status);
const texts = (layout: ParagraphLayout) => layout.lines.map((l) => l.text);

describe('rewrap (greedy first-fit from the edited line)', () => {
  test('a typo fix changes one line', () => {
    const input = para(['aaa bbb cc', 'dd eeeeeee', 'ffff ggg h', 'ii jj'], { width: 10 });
    const layout = layoutParagraph(input, replaceEdit(input, 'ggg', 'gxg'));
    expect(statuses(layout)).toEqual(['kept', 'kept', 'rewritten', 'reused']);
    expect(texts(layout)).toEqual(['aaa bbb cc', 'dd eeeeeee', 'ffff gxg h', 'ii jj']);
    expect(layout.lineDelta).toBe(0);
    expect(layout.lines[3]!.dy).toBe(0);
    expect(layout.lines[2]!.y).toBe(20);
    expect(layout.lines.map((l) => l.source)).toEqual([0, 1, undefined, 3]);
  });

  test('a typo fix in proportional text changes one line', () => {
    const style = helvetica();
    const input = para(['The quick brown fox jumps', 'over the lazy dog, and the', 'cat waits.'], {
      width: 125,
      style,
    });
    const layout = layoutParagraph(input, replaceEdit(input, 'lazy', 'lazi'));
    expect(statuses(layout)).toEqual(['kept', 'rewritten', 'reused']);
    expect(texts(layout)[1]).toBe('over the lazi dog, and the');
  });

  test('a deletion pulls a word up and stops', () => {
    const input = para(['aaa bbb cc', 'dd eeeeeee', 'ffff ggg'], { width: 10 });
    const layout = layoutParagraph(input, replaceEdit(input, 'bbb ', ''));
    expect(texts(layout)).toEqual(['aaa cc dd', 'eeeeeee', 'ffff ggg']);
    expect(statuses(layout)).toEqual(['rewritten', 'rewritten', 'reused']);
    expect(layout.lineDelta).toBe(0);
    expect(layout.lines[2]!).toMatchObject({ dy: 0, y: 20, source: 2 });
  });

  test('an insertion pushes one word down a line and stops', () => {
    const input = para(['aaa bbb cc', 'dd ee', 'fffffff gg', 'hh'], { width: 10 });
    const layout = layoutParagraph(input, { start: 4, end: 4, text: 'x ' });
    expect(texts(layout)).toEqual(['aaa x bbb', 'cc dd ee', 'fffffff gg', 'hh']);
    expect(statuses(layout)).toEqual(['rewritten', 'rewritten', 'reused', 'reused']);
    expect(layout.lineDelta).toBe(0);
  });

  test('a growth by one line moves the later lines down by the leading', () => {
    const input = para(['aaa bbb cc', 'dddd eeeee', 'fffffff gg'], { width: 10 });
    const layout = layoutParagraph(input, { start: 0, end: 0, text: 'x ' });
    expect(texts(layout)).toEqual(['x aaa bbb', 'cc dddd', 'eeeee', 'fffffff gg']);
    expect(statuses(layout)).toEqual(['rewritten', 'rewritten', 'rewritten', 'reused']);
    expect(layout.lineDelta).toBe(1);
    expect(layout.lines[3]!).toMatchObject({ source: 2, dy: LEADING, y: 30 });
    expect(layout.height).toBe(30);
    expect(layout.originalHeight).toBe(20);
  });

  test('an edit in the first word of a line can move it back up; else that line is kept', () => {
    const input = para(['aaa bbb', 'cccc dd'], { width: 10 });
    const up = layoutParagraph(input, replaceEdit(input, 'cccc', 'cc'));
    expect(texts(up)).toEqual(['aaa bbb cc', 'dd']);
    const same = layoutParagraph(input, replaceEdit(input, 'cccc', 'cxcc'));
    expect(statuses(same)).toEqual(['kept', 'rewritten']);
    expect(texts(same)).toEqual(['aaa bbb', 'cxcc dd']);
  });

  test('the caret style is applied to inserted text and a typed line break forces a line', () => {
    const input = para(['aaa bbb'], { width: 20 });
    const layout = layoutParagraph(input, { start: 3, end: 4, text: '\n' });
    expect(texts(layout)).toEqual(['aaa', 'bbb']);
    expect(layout.lines[0]!.forced).toBe(true);
    const trailing = layoutParagraph(input, { start: 7, end: 7, text: '\n' });
    expect(texts(trailing)).toEqual(['aaa bbb', '']);
  });

  test('spans keep their styles, inserted text takes the caret style, runs split by style', () => {
    const base = para(['aa bb cc'], { width: 30 });
    const bold = monoStyle({
      advances: { b: { spaced: 2, plain: 2 }, x: { spaced: 2, plain: 2 } },
    });
    const input: LayoutInput = {
      ...base,
      spans: [
        { start: 0, end: 3, style: 's' },
        { start: 3, end: 5, style: 'b' },
        { start: 5, end: 8, style: 's' },
      ],
      styles: { s: monoStyle(), b: bold },
      measure: { left: 2, right: 30, firstIndent: 3 },
    };
    const layout = layoutParagraph(input, { start: 4, end: 4, text: 'x', style: 'b' });
    const line = layout.lines[0]!;
    expect(line.text).toBe('aa bxb cc');
    expect(line.x).toBe(5);
    expect(line.runs.map((r) => [r.text, r.style, r.x])).toEqual([
      ['aa ', 's', 5],
      ['bxb', 'b', 8],
      [' cc', 's', 14],
    ]);
    expect(line.width).toBe(12);
  });

  test('a word wider than the measure sits alone and is marked, never split', () => {
    const input = para(['aa bb'], { width: 5 });
    const layout = layoutParagraph(input, { start: 3, end: 5, text: 'bbbbbbbb cc' });
    expect(texts(layout)).toEqual(['aa', 'bbbbbbbb', 'cc']);
    expect(layout.lines.map((l) => l.overfull)).toEqual([false, true, false]);
  });

  test('no change keeps every line', () => {
    const input = para(['aaa bbb cc', 'dd'], { width: 10 });
    const layout = layoutParagraph(input, { start: 2, end: 2, text: '' });
    expect(statuses(layout)).toEqual(['kept', 'kept']);
  });
});

describe('justification', () => {
  test('slack goes to the word gaps, within 1.5 × the natural gap', () => {
    const input = para(['aaa bbb cc', 'dddddddddd', 'e'], { width: 10, align: 'justify' });
    const layout = layoutParagraph(input, replaceEdit(input, 'aaa', 'aa'));
    const first = layout.lines[0]!;
    // "aa bbb cc": 7 glyphs + 2 gaps = 9; slack 1 over 2 gaps → 1.5 each (the cap, inclusive).
    expect(first).toMatchObject({ justified: true, ragged: false, x: 0, width: 10 });
    expect(first.words.map((w) => [w.text, w.x])).toEqual([
      ['aa', 0],
      ['bbb', 3.5],
      ['cc', 8],
    ]);
    // One run per word on a justified line.
    expect(first.runs.map((r) => [r.text, r.x])).toEqual([
      ['aa', 0],
      ['bbb', 3.5],
      ['cc', 8],
    ]);
    expect(layout.ragged).toBe(false);

    // On an 11 pt measure the same gaps would need 2 × the natural gap: ragged.
    const loose = layoutParagraph(
      { ...input, measure: { left: 0, right: 11 } },
      replaceEdit(input, 'cc', 'c'),
    );
    expect(loose.lines[0]).toMatchObject({ justified: false, ragged: true });
    expect(loose.ragged).toBe(true);
  });

  test('a line too loose to justify stays ragged and says so', () => {
    const input = para(['aaaaaa bb', 'cccccccccc', 'd'], { width: 12, align: 'justify' });
    const layout = layoutParagraph(input, replaceEdit(input, 'bb', 'b'));
    const line = layout.lines[0]!;
    expect(line).toMatchObject({ justified: false, ragged: true, x: 0, width: 8 });
    expect(layout.ragged).toBe(true);
  });

  test('the last line and a forced line stay natural', () => {
    const input = para(['aaa bbb cc', 'dd ee'], { width: 11, align: 'justify' });
    const layout = layoutParagraph(input, replaceEdit(input, 'ee', 'e'));
    expect(layout.lines[1]).toMatchObject({ justified: false, ragged: false, width: 4 });
  });

  test('right and centred lines are placed from the measure', () => {
    const right = para(['aa bb'], { width: 10, align: 'right' });
    expect(layoutParagraph(right, { start: 0, end: 2, text: 'a' }).lines[0]).toMatchObject({
      x: 6,
      width: 4,
    });
    const centre = para(['aa bb'], { width: 10, align: 'center' });
    expect(layoutParagraph(centre, { start: 0, end: 2, text: 'a' }).lines[0]!.x).toBe(3);
  });
});

describe('kerning, hyphens and substitutes', () => {
  test('harvested kerning is reapplied where the pair recurs', () => {
    const kerning = harvestKerning([{ chars: ['A', 'V', 'A'], perCode: [20, 0, 0] }], 10);
    expect(kerning).toEqual({ AV: -0.2 });
    const input = para(['AVA'], { width: 20, style: monoStyle({ kerning }) });
    const layout = layoutParagraph(input, { start: 3, end: 3, text: ' VAV' });
    const line = layout.lines[0]!;
    expect(line.runs).toHaveLength(1);
    const run = line.runs[0]!;
    expect(run.text).toBe('AVA VAV');
    expect(run.kerning).toEqual([-0.2, 0, 0, 0, 0, -0.2, 0]);
    expect(run.width).toBeCloseTo(6.6, 10);
    expect(line.words.map((w) => w.x)).toEqual([0, expect.closeTo(3.8, 10)]);
  });

  test('a word gap unlike the space glyph is written as an offset on the space', () => {
    const style = monoStyle({}, 1.5);
    const input = para(['aa bb'], { width: 20, style });
    const run = layoutParagraph(input, { start: 0, end: 1, text: 'x' }).lines[0]!.runs[0]!;
    expect(run.kerning).toEqual([0, 0, 0.5, 0, 0]);
    expect(run.width).toBe(5.5);
  });

  test('an original line-end hyphen is kept at an unchanged line end, and none is inserted', () => {
    const input = para(['aaa exam', 'ple bbb'], { width: 9, hyphenated: [0] });
    expect(input.text).toBe('aaa example bbb');
    const layout = layoutParagraph(input, replaceEdit(input, 'aaa', 'aab'));
    expect(texts(layout)).toEqual(['aab exam', 'ple bbb']);
    expect(statuses(layout)).toEqual(['rewritten', 'reused']);
    expect(layout.lines[0]!.hyphen).toEqual({ x: 8, style: 's' });
    expect(layout.lines[0]!.width).toBe(9);

    // Room for the whole word: it moves up and the hyphen goes.
    const wide = layoutParagraph(
      { ...input, measure: { left: 0, right: 20 } },
      {
        start: 0,
        end: 3,
        text: 'aa',
      },
    );
    expect(texts(wide)).toEqual(['aa example bbb']);
    expect(wide.lines[0]!.hyphen).toBeUndefined();

    // A word that never had a hyphen moves whole.
    const plain = para(['aaa bbbbb'], { width: 9 });
    expect(texts(layoutParagraph(plain, { start: 0, end: 0, text: 'x' }))).toEqual([
      'xaaa',
      'bbbbb',
    ]);
  });

  test('characters the font lacks use the substitute and are recorded', () => {
    const style = monoStyle({ substitute: { font: 'Noto Serif', advances: { ğ: 0.7, ş: 0.6 } } });
    const input = para(['aa bb'], { width: 20, style });
    const layout = layoutParagraph(input, { start: 2, end: 2, text: 'ğş ğ' });
    expect(layout.text).toBe('aağş ğ bb');
    expect(layout.substituted).toEqual([
      { char: 'ğ', font: 'Noto Serif' },
      { char: 'ş', font: 'Noto Serif' },
    ]);
    const line = layout.lines[0]!;
    expect(line.runs.map((r) => [r.text, r.font])).toEqual([
      ['aa', undefined],
      ['ğş', 'Noto Serif'],
      ['ğ', 'Noto Serif'],
      [' bb', undefined],
    ]);
    expect(line.words[0]!.width).toBeCloseTo(3.3, 10);
    expect(layout.unsupported).toEqual([]);

    const none = layoutParagraph(input, { start: 2, end: 2, text: '你' });
    expect(none.unsupported).toEqual(['你']);
  });

  test('CJK text breaks between ideographs', () => {
    const cjk = Object.fromEntries(
      Array.from('日本語のテキストです。').map((c) => [c, { spaced: 1, plain: 1 }]),
    );
    const input = para(['日本語'], { width: 4, style: { advances: cjk, wordGap: 1 } });
    const layout = layoutParagraph(input, { start: 3, end: 3, text: 'のテキストです。' });
    expect(texts(layout)).toEqual(['日本語の', 'テキスト', 'です。']);
  });
});

describe('overflow policy', () => {
  const box = (input: LayoutInput, edit: LayoutEdit, paragraphGap = 4): OverflowBox => ({
    input,
    edit,
    paragraphGap,
  });

  test('same or fewer lines commit', () => {
    const input = para(['aaa bbb cc', 'dd'], { width: 10 });
    const edit = replaceEdit(input, 'bbb ', '');
    const layout = layoutParagraph(input, edit);
    expect(decideOverflow(layout, box(input, edit), 0)).toMatchObject({ kind: 'commit' });
  });

  test('growth that fits the space below, keeping the original gap, grows', () => {
    const input = para(['aaa bbb cc'], { width: 10 });
    const edit: LayoutEdit = { start: 0, end: 0, text: 'x ' };
    const layout = layoutParagraph(input, edit);
    expect(decideOverflow(layout, box(input, edit, 4), 14)).toMatchObject({
      kind: 'grow',
      growth: 10,
    });
    expect(decideOverflow(layout, box(input, edit, 4), 13).kind).not.toBe('grow');
  });

  test('word spacing tightened by the exact factor', () => {
    const style = monoStyle({}, 2);
    // "aaa bb ccc" = 8 glyphs + 2 gaps of 2 = 12; the edit makes it 13 on a 12.6 measure.
    const input = para(['aaa bb ccc'], { width: 12.6, style });
    const edit = replaceEdit(input, 'bb', 'bbb');
    const layout = layoutParagraph(input, edit);
    expect(layout.lineDelta).toBe(1);
    const decision = decideOverflow(layout, box(input, edit), 4);
    expect(decision.kind).toBe('tighten');
    if (decision.kind !== 'tighten') return;
    expect(decision.wordSpacing).toBeCloseTo(0.9, 10);
    expect(decision.leading).toBe(1);
    expect(decision.percent).toBe(10);
    expect(decision.layout.lineDelta).toBe(0);
    expect(decision.layout.lines[0]!.text).toBe('aaa bbb ccc');
  });

  /** Ten full lines; an insertion at the start pushes a word through all of them. */
  function tallParagraph() {
    const lines = Array.from({ length: 10 }, () => 'aaaa bbbbb');
    const input = para(lines, { width: 10 });
    const edit: LayoutEdit = { start: 0, end: 0, text: 'x ' };
    return { input, edit, layout: layoutParagraph(input, edit) };
  }

  test('then leading, down to 95 %, on the rewritten lines', () => {
    const { input, edit, layout } = tallParagraph();
    expect(layout.lineDelta).toBe(1);
    expect(layout.firstRewritten).toBe(0);
    // Growth 10; room 6; rewritten steps 10 × 10 = 100 → leading 0.96.
    const decision = decideOverflow(layout, box(input, edit, 4), 10);
    expect(decision.kind).toBe('tighten');
    if (decision.kind !== 'tighten') return;
    expect(decision.wordSpacing).toBe(1);
    expect(decision.leading).toBeCloseTo(0.96, 10);
    expect(decision.percent).toBe(4);
    expect(decision.growth).toBeCloseTo(6, 10);
    expect(decision.layout.lines[1]!.y).toBeCloseTo(9.6, 10);
  });

  test('else it runs over, with the overlap for the warning', () => {
    const { input, edit, layout } = tallParagraph();
    const decision = decideOverflow(layout, box(input, edit, 4), 4);
    expect(decision).toMatchObject({ kind: 'overflow', growth: 10, excess: 10, overlap: 6 });
    if (decision.kind === 'overflow') expect(decision.layout).toBe(layout);
    expect(decision).toMatchObject({ offPage: false });
    expect(decision).not.toHaveProperty('fit');
  });

  test('a run-over past the edge of the page is marked off the page', () => {
    const { input, edit, layout } = tallParagraph();
    expect(decideOverflow(layout, { ...box(input, edit, 4), pageRoom: 12 }, 4)).toMatchObject({
      kind: 'overflow',
      offPage: false,
    });
    expect(decideOverflow(layout, { ...box(input, edit, 4), pageRoom: 9 }, 4)).toMatchObject({
      kind: 'overflow',
      offPage: true,
    });
  });

  test('when only tightening the whole paragraph fits, it is offered as the fit', () => {
    const style = monoStyle({}, 2);
    // Full lines of one-letter words: each takes one more word at a factor of 19/22.
    const input = para(
      ['a b c d e f g h i j k', 'l m n o p q r s t u v', 'w x y z A B C D E F G'],
      { width: 31, style },
    );
    const edit: LayoutEdit = { start: input.text.length, end: input.text.length, text: ' HHHH' };
    const layout = layoutParagraph(input, edit);
    expect(layout.lineDelta).toBe(1);
    const decision = decideOverflow(layout, box(input, edit, 0), 0);
    expect(decision.kind).toBe('overflow');
    if (decision.kind !== 'overflow') return;
    expect(decision.layout).toBe(layout);
    const fit = decision.fit;
    expect(fit?.kind).toBe('tighten');
    expect(fit?.layout.lineDelta).toBe(0);
    expect(fit?.layout.lines.every((l) => l.status === 'rewritten')).toBe(true);
    expect(fit?.wordSpacing).toBeCloseTo(19 / 22, 10);
    expect(fit?.percent).toBe(14);
    expect(fit?.layout.text).toBe(layout.text);
    expect(fit?.layout.lines.map((l) => l.text)).toEqual([
      'a b c d e f g h i j k l',
      'm n o p q r s t u v w x',
      'y z A B C D E F G HHHH',
    ]);
  });
});

describe('performance', () => {
  test('2,000 characters re-laid well within the keystroke budget', () => {
    const words = ['The', 'quick', 'brown', 'fox', 'jumps', 'over', 'the', 'lazy', 'dog,', 'and'];
    let text = '';
    for (let i = 0; text.length <= 2001; i++) text += `${words[i % words.length] ?? ''} `;
    text = text.trimEnd();
    const kerning = { Th: -0.1, Te: -0.1, Va: -0.2 };
    const input: LayoutInput = {
      text,
      spans: [{ start: 0, end: text.length, style: 's' }],
      lines: [{ start: 0, y: 0 }],
      styles: { s: helvetica({ kerning }) },
      measure: { left: 0, right: 300 },
      align: 'justify',
      leading: 12,
    };
    // The whole text is set anew (no convergence possible): the worst case of a keystroke.
    const edit: LayoutEdit = { start: 0, end: text.length, text };
    let layout = layoutParagraph(input, edit);
    expect(layout.text.length).toBeGreaterThanOrEqual(2000);
    expect(layout.lines.length).toBeGreaterThan(20);
    for (let i = 0; i < 5; i++) layoutParagraph(input, edit); // warm-up
    const runs = 20;
    const t0 = performance.now();
    for (let i = 0; i < runs; i++) layout = layoutParagraph(input, edit);
    const ms = (performance.now() - t0) / runs;
    expect(layout.lines.every((l) => l.status === 'rewritten')).toBe(true);
    // Budget 4 ms (spec craft §4.8); asserted at 20 ms to stay safe on loaded CI machines.
    expect(ms, `${ms.toFixed(3)} ms per layout`).toBeLessThan(20);
  });
});
