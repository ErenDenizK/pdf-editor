/**
 * Hard line breaks and the box-bounded measure through layout and writer (craft spec §4.1,
 * §4.3): an address set as one paragraph with line breaks keeps its lines when one of them is
 * edited, a typed line break is a hard break the next analysis finds again, a justified
 * paragraph leaves its hard-break lines ragged, and the rewrap stays inside the shaded box.
 * Detection goldens for the same pages are in `blocks.test.ts`.
 */
import type { SourceId } from '@pdf-editor/document-model';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import demoUrl from '../../../../test/fixtures/demo/demo-agreement.pdf?url';
import addressUrl from '../../../../test/fixtures/text-edit-corpus/address-boxes.pdf?url';
import type { ParagraphBlock, ParagraphEdit, ParagraphLayout } from '../types';
import { type LayoutInput, layoutParagraph, type LayoutStyle } from './linebreak';
import { createHarness, fixture, type Harness } from './test-helpers';

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h.adapter.destroy();
});

const statuses = (layout: ParagraphLayout) => layout.lines.map((l) => l.status);
const texts = (layout: ParagraphLayout) => layout.lines.map((l) => l.text);

/** Every glyph and gap 1 pt wide, so widths are character counts. */
const MONO: LayoutStyle = {
  advances: Object.fromEntries(
    Array.from('abcdefghijklmnopqrstuvwxyz0123456789 ').map((c) => [c, { spaced: 1, plain: 1 }]),
  ),
  wordGap: 1,
};

/** A paragraph whose original lines are joined by `\n` (hard breaks) or a space. */
function para(
  lines: readonly (readonly [string, 'forced' | 'space'])[],
  width: number,
  align: LayoutInput['align'] = 'left',
): LayoutInput {
  let text = '';
  const source = lines.map(([line, end], i) => {
    const start = text.length;
    text += line;
    if (i < lines.length - 1) text += end === 'forced' ? '\n' : ' ';
    return { start, y: i * 10 };
  });
  return {
    text,
    spans: [{ start: 0, end: text.length, style: 's' }],
    lines: source,
    styles: { s: MONO },
    measure: { left: 0, right: width },
    align,
    leading: 10,
  };
}

/** Inserts `inserted` right after `after` in the paragraph text. */
function insertAfter(block: ParagraphBlock, after: string, inserted: string): ParagraphEdit {
  const at = block.text.indexOf(after);
  if (at < 0) throw new Error(`"${after}" not in "${block.text}"`);
  const start = at + after.length;
  return {
    ref: block.ref,
    text: block.text.slice(0, start) + inserted + block.text.slice(start),
    caretSpan: { start, end: start },
  };
}

async function blockWith(source: SourceId, text: string): Promise<ParagraphBlock> {
  const blocks = await h.editor.analyzeParagraphs(source, 0);
  const block = blocks.find((b) => b.text.includes(text));
  if (!block) throw new Error(`no paragraph with "${text}"`);
  return block;
}

describe('layout across hard breaks', () => {
  test('rewrap stops at a hard break: lines after it are reused, even when the edit adds a line', () => {
    const input = para(
      [
        ['elena marsh', 'forced'],
        ['14 quayside terrace', 'forced'],
        ['port allery pa2 4ln', 'forced'],
        ['44 20 7946 0958', 'space'],
      ],
      40,
    );
    const at = input.text.indexOf('terrace') + 'terrace'.length;
    const short = layoutParagraph(input, { start: at, end: at, text: ' flat 2' });
    expect(statuses(short)).toEqual(['kept', 'rewritten', 'reused', 'reused']);
    expect(texts(short)).toEqual([
      'elena marsh',
      '14 quayside terrace flat 2',
      'port allery pa2 4ln',
      '44 20 7946 0958',
    ]);
    expect(short.lines.map((l) => l.dy)).toEqual([0, 0, 0, 0]);
    expect(short.lines[1]?.forced).toBe(true);

    // Longer than the measure: the edited line wraps inside its own stretch only.
    const long = layoutParagraph(input, {
      start: at,
      end: at,
      text: ' flat 2 second floor harbour view',
    });
    expect(texts(long)).toEqual([
      'elena marsh',
      '14 quayside terrace flat 2 second floor',
      'harbour view',
      'port allery pa2 4ln',
      '44 20 7946 0958',
    ]);
    expect(statuses(long)).toEqual(['kept', 'rewritten', 'rewritten', 'reused', 'reused']);
    expect(long.lines[3]?.dy).toBe(10);
    expect(long.lineDelta).toBe(1);
  });

  test('a deletion never pulls words up across a hard break, but does across a soft one', () => {
    const input = para(
      [
        ['aaa bbb ccc', 'forced'],
        ['ddd eee', 'space'],
        ['fff ggg', 'space'],
      ],
      20,
    );
    const layout = layoutParagraph(input, {
      start: input.text.indexOf(' ccc'),
      end: input.text.indexOf(' ccc') + 4,
      text: '',
    });
    expect(texts(layout)).toEqual(['aaa bbb', 'ddd eee', 'fff ggg']);
    const soft = layoutParagraph(input, {
      start: input.text.indexOf(' eee'),
      end: input.text.indexOf(' eee') + 4,
      text: '',
    });
    expect(texts(soft)).toEqual(['aaa bbb ccc', 'ddd fff ggg']);
  });

  test('a justified paragraph leaves its hard-break line ragged and justifies the others', () => {
    const input = para(
      [
        ['aaaa bbbb cccc dddd', 'space'],
        ['eeee ffff', 'forced'],
        ['gggg hhhh iiii jjjj', 'space'],
        ['kkkk', 'space'],
      ],
      19,
      'justify',
    );
    const layout = layoutParagraph(input, { start: 0, end: 4, text: 'aaa' });
    expect(texts(layout)).toEqual([
      'aaa bbbb cccc dddd',
      'eeee ffff',
      'gggg hhhh iiii jjjj',
      'kkkk',
    ]);
    expect(statuses(layout)).toEqual(['rewritten', 'reused', 'reused', 'reused']);
    expect(layout.lines[0]?.justified).toBe(true);
    expect(layout.lines[0]?.width).toBeCloseTo(19, 6);
    // Rewritten up to the hard break: the line before it stays natural, not stretched.
    const through = layoutParagraph(input, { start: 0, end: 4, text: 'aaaaaaa' });
    expect(texts(through)).toEqual([
      'aaaaaaa bbbb cccc',
      'dddd eeee ffff',
      'gggg hhhh iiii jjjj',
      'kkkk',
    ]);
    expect(statuses(through)).toEqual(['rewritten', 'rewritten', 'reused', 'reused']);
    expect(through.lines[1]?.forced).toBe(true);
    expect(through.lines[1]?.justified).toBe(false);
    expect(through.lines[1]?.ragged).toBe(false);
    expect(through.lines[1]?.width).toBe(14);
  });
});

describe('writing an address block', () => {
  test('typing " Flat 2" after the first address line keeps the other lines and stays in the box (address-boxes.pdf, tagged)', async () => {
    const id = await h.open(await fixture(addressUrl));
    const block = await blockWith(id, '14 Quayside Terrace');
    expect(block.lines.map((l) => l.end)).toEqual(['forced', 'forced', 'forced', 'forced', 'end']);
    const wrapRight = block.wrapRight ?? block.measure.right;
    const layoutInput = (await h.editor.analyzeParagraphLayout(block.ref)).input;
    expect(layoutInput.measure.right).toBeCloseTo(wrapRight, 3);

    const edit = insertAfter(block, '14 Quayside Terrace', ' Flat 2');
    // The overlay's layout of the same edit.
    const planned = layoutParagraph(layoutInput, {
      start: edit.caretSpan.start,
      end: edit.caretSpan.end,
      text: ' Flat 2',
    });
    expect(statuses(planned)).toEqual(['kept', 'rewritten', 'reused', 'reused', 'reused']);

    const result = await h.editor.applyParagraphEdit(id, 0, edit, { commit: true });
    expect(result.committed).toBe(true);
    expect(statuses(result.layout)).toEqual(['kept', 'rewritten', 'reused', 'reused', 'reused']);
    expect(result.layout.lineDelta).toBe(0);
    expect(result.decision.kind).toBe('commit');
    expect(result.verification.changedPixelsOutside).toBe(0);

    const after = await blockWith(id, '14 Quayside Terrace Flat 2');
    expect(after.text).toBe(edit.text);
    expect(after.lines.map((l) => l.text)).toEqual([
      'Elena Marsh',
      '14 Quayside Terrace Flat 2',
      'Port Allery PA2 4LN',
      'elena.marsh@example.com',
      '+44 20 7946 0958',
    ]);
    expect(after.lines.map((l) => l.end)).toEqual(['forced', 'forced', 'forced', 'forced', 'end']);
    // The other lines did not move.
    for (const i of [0, 2, 3, 4]) {
      const was = block.lines[i];
      const now = after.lines[i];
      expect(now?.baseline).toBeCloseTo(was?.baseline ?? 0, 2);
      expect(now?.x0).toBeCloseTo(was?.x0 ?? 0, 2);
      expect(now?.x1).toBeCloseTo(was?.x1 ?? 0, 2);
    }
    // The edited line is inside the box's padding.
    expect(after.lines[1]?.x1 ?? 0).toBeLessThanOrEqual(wrapRight + 0.01);
    await h.adapter.close(id);
  });

  test('the reported case: " Flat 2" in the Hirer box of demo-agreement.pdf (untagged)', async () => {
    const id = await h.open(await fixture(demoUrl));
    const block = await blockWith(id, '14 Quayside Terrace');
    expect(block.lines.map((l) => l.end)).toEqual(['forced', 'forced', 'forced', 'end']);
    // The shaded box runs from x = 304.64 to 531.28 and the text starts 14 pt inside it.
    expect(block.wrapRight).toBeCloseTo(531.28 - 14, 1);

    const edit = insertAfter(block, '14 Quayside Terrace', ' Flat 2');
    const result = await h.editor.applyParagraphEdit(id, 0, edit, { commit: true });
    expect(statuses(result.layout)).toEqual(['rewritten', 'reused', 'reused', 'reused']);
    expect(result.verification.changedPixelsOutside).toBe(0);

    const after = await blockWith(id, 'Flat 2');
    expect(after.lines.map((l) => l.text)).toEqual([
      '14 Quayside Terrace Flat 2',
      'Port Allery PA2 4LN',
      'elena.marsh@example.com',
      '+44 20 7946 0958',
    ]);
    for (const i of [1, 2, 3]) {
      expect(after.lines[i]?.baseline).toBeCloseTo(block.lines[i]?.baseline ?? 0, 2);
      expect(after.lines[i]?.x1).toBeCloseTo(block.lines[i]?.x1 ?? 0, 2);
    }
    expect(after.lines[0]?.x1 ?? 0).toBeLessThanOrEqual(531.28 - 14);
    await h.adapter.close(id);
  });

  test('Enter inserts a hard break that the next analysis finds again', async () => {
    const id = await h.open(await fixture(addressUrl));
    const block = await blockWith(id, '14 Quayside Terrace');
    const edit = insertAfter(block, '14 Quayside Terrace', '\nFlat 2');
    const result = await h.editor.applyParagraphEdit(id, 0, edit, { commit: true });
    expect(result.committed).toBe(true);
    expect(result.layout.lineDelta).toBe(1);
    expect(result.layout.lines[1]?.forced).toBe(true);
    expect(result.layout.lines.slice(3).every((l) => l.status === 'reused')).toBe(true);

    const after = await blockWith(id, 'Flat 2');
    expect(after.text).toBe(edit.text);
    expect(after.lines.map((l) => l.end)).toEqual([
      'forced',
      'forced',
      'forced',
      'forced',
      'forced',
      'end',
    ]);
    await h.adapter.close(id);
  });
});
