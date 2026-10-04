/**
 * The paragraph editor's model (craft spec §4.2, §4.8): text operations with span
 * inheritance, one edit against the original text, caret moves across lines from the
 * layout's geometry, select all, and the per-keystroke budget (≤ 4 ms for 2,000 characters).
 */
import { decideOverflow, layoutParagraph } from '@pdf-editor/engine';
import { describe, expect, it } from 'vitest';

import { buildScene } from './glyph-canvas';
import { ADVANCE, LEADING, LEFT, monoStyle, paragraph, TOP } from './paragraph-fixtures';
import {
  caretAt,
  caretLines,
  deleteBackward,
  deleteForward,
  initialState,
  insertText,
  type LayoutFunctions,
  moveHorizontal,
  moveLineEdge,
  moveVertical,
  offsetAtPoint,
  type ParagraphState,
  paragraphEdit,
  relayout,
  replaceRange,
  selectAll,
  selectionOf,
  selectionRects,
  stylesOf,
  wordRange,
} from './paragraph-model';

const fns: LayoutFunctions = { layoutParagraph, decideOverflow };
const LINES = ['The quick brown fox', 'jumps over the lazy', 'dog and runs away.'];
const WIDTH = { width: 20 * ADVANCE };

function geometry(setup: ReturnType<typeof paragraph>, state: ParagraphState) {
  const { layout } = relayout(fns, setup, state);
  return caretLines(setup, state, layout);
}

describe('text operations', () => {
  it('types at the caret and moves it after the text', () => {
    const setup = paragraph(LINES, WIDTH);
    let state = initialState(setup.input, 4);
    state = insertText(state, 'very ');
    expect(state.text.startsWith('The very quick')).toBe(true);
    expect(selectionOf(state)).toEqual({ start: 9, end: 9 });
  });

  it('typed text inherits the style before the caret, the first character’s at the start', () => {
    const setup = paragraph(['ab cd']);
    const input = {
      ...setup.input,
      spans: [
        { start: 0, end: 2, style: 'bold' },
        { start: 2, end: 5, style: 's0' },
      ],
      styles: { s0: monoStyle(), bold: monoStyle() },
    };
    expect(stylesOf(input)).toEqual(['bold', 'bold', 's0', 's0', 's0']);
    let state = initialState(input, 2);
    state = insertText(state, 'X');
    expect(state.styles.slice(0, 4)).toEqual(['bold', 'bold', 'bold', 's0']);
    state = insertText({ ...state, anchor: 0, focus: 0 }, 'Y');
    expect(state.styles[0]).toBe('bold');
    const at4 = insertText({ ...state, anchor: 5, focus: 5 }, 'Z');
    expect(at4.styles[5]).toBe('s0');
  });

  it('replaces a selection, deletes backwards and forwards by character and word', () => {
    const setup = paragraph(['one two three']);
    let state = initialState(setup.input, 0);
    state = { ...state, anchor: 4, focus: 7 };
    state = insertText(state, '2');
    expect(state.text).toBe('one 2 three');
    state = deleteBackward(state);
    expect(state.text).toBe('one  three');
    state = deleteForward(state);
    expect(state.text).toBe('one three');
    state = { ...state, anchor: 9, focus: 9 };
    state = deleteBackward(state, 'word');
    expect(state.text).toBe('one ');
    state = { ...state, anchor: 0, focus: 0 };
    state = deleteForward(state, 'word');
    expect(state.text).toBe(' ');
    // Nothing before the start.
    expect(deleteBackward(state)).toBe(state);
  });

  it('keeps surrogate pairs whole', () => {
    const setup = paragraph(['a b']);
    let state = insertText(initialState(setup.input, 1), '😀');
    expect(state.text).toBe('a😀 b');
    state = deleteBackward(state);
    expect(state.text).toBe('a b');
    state = insertText(state, '😀');
    state = moveHorizontal(state, -1, false);
    expect(state.focus).toBe(1);
  });

  it('selects the paragraph, words and collapses a selection to its side', () => {
    const setup = paragraph(LINES, WIDTH);
    const state = selectAll(initialState(setup.input, 3));
    expect(selectionOf(state)).toEqual({ start: 0, end: setup.input.text.length });
    expect(moveHorizontal(state, -1, false).focus).toBe(0);
    expect(moveHorizontal(state, 1, false).focus).toBe(setup.input.text.length);
    expect(wordRange('The quick brown', 6)).toEqual({ start: 4, end: 9 });
    const word = moveHorizontal(initialState(setup.input, 0), 1, true, 'word');
    expect(selectionOf(word)).toEqual({ start: 0, end: 3 });
  });

  it('describes all typing as one edit against the original text', () => {
    const setup = paragraph(LINES, WIDTH);
    let state = initialState(setup.input, 4);
    expect(paragraphEdit(setup.input.text, state)).toBeNull();
    state = insertText(state, 'very ');
    state = insertText({ ...state, anchor: 25, focus: 25 }, '!');
    const edit = paragraphEdit(setup.input.text, state);
    expect(edit).toMatchObject({ start: 4, style: 's0' });
    const original = setup.input.text;
    expect(
      original.slice(0, edit?.start) + (edit?.text ?? '') + original.slice(edit?.end ?? 0),
    ).toBe(state.text);
    // Undoing the typing by hand gives no edit.
    const back = { ...state, text: original, styles: stylesOf(setup.input) };
    expect(paragraphEdit(original, back)).toBeNull();
  });
});

describe('several changes in one session', () => {
  it('keeps each untouched character’s style: the bold word between two fixes stays bold', () => {
    // "The harbour master walked along the quay" with "master" in s1 (bold).
    const text = 'The harbour master walked along the quay';
    const styles = Array.from({ length: text.length }, (_, i) => (i >= 12 && i < 18 ? 's1' : 's0'));
    const origins = Array.from({ length: text.length }, (_, i) => i);
    let state: ParagraphState = { text, styles, origins, anchor: 0, focus: 0 };
    state = replaceRange(state, { start: 0, end: 3 }, 'A');
    const q = state.text.indexOf('quay');
    state = replaceRange(state, { start: q, end: q + 4 }, 'pier');
    const edit = paragraphEdit(text, state, styles);
    expect(edit).toMatchObject({ start: 0, end: text.length, text: state.text });
    // Typed "A", untouched " harbour ", "master" (bold), " walked along the ", typed "pier".
    expect(edit?.spans).toEqual([
      { start: 0, end: 1, style: 's0' },
      { start: 1, end: 10, style: 's0', source: 3 },
      { start: 10, end: 16, style: 's1', source: 12 },
      { start: 16, end: 34, style: 's0', source: 18 },
      { start: 34, end: 38, style: 's0' },
    ]);
    // The layout sets "master" in its own style.
    const input = {
      ...paragraph([text], { width: 100 * ADVANCE }).input,
      spans: [
        { start: 0, end: 12, style: 's0' },
        { start: 12, end: 18, style: 's1' },
        { start: 18, end: text.length, style: 's0' },
      ],
      styles: { s0: monoStyle(), s1: monoStyle() },
    };
    const layout = layoutParagraph(input, edit ?? { start: 0, end: 0, text: '' });
    const runs = layout.lines.flatMap((l) => l.runs);
    expect(runs.find((r) => r.text.includes('master'))?.style).toBe('s1');
    expect(runs.find((r) => r.text.includes('pier'))?.style).toBe('s0');
  });

  it('typed text takes the style before the caret when typed; a retyped character in another style is a change', () => {
    const text = 'ab';
    const styles = ['s0', 's1'];
    const start: ParagraphState = { text, styles, origins: [0, 1], anchor: 1, focus: 2 };
    // Typing "b" over the bold "b" sets it in the style before the caret: a change.
    const typed = insertText(start, 'b');
    expect(typed.styles).toEqual(['s0', 's0']);
    expect(typed.origins).toEqual([0, -1]);
    expect(paragraphEdit(text, typed, styles)).toMatchObject({
      start: 1,
      end: 2,
      text: 'b',
      spans: [{ start: 0, end: 1, style: 's0' }],
    });
    expect(paragraphEdit(text, start, styles)).toBeNull();
  });
});

describe('layout and caret geometry', () => {
  it('lays out the edited text: earlier lines kept, the edited one rewritten', () => {
    const setup = paragraph(LINES, WIDTH);
    const state = insertText(initialState(setup.input, 30), 'x');
    const result = relayout(fns, setup, state);
    expect(result.layout.lines.map((l) => l.status)).toEqual(['kept', 'rewritten', 'reused']);
    expect(result.decision.kind).toBe('commit');
  });

  it('places the caret on the right line with monospaced advances', () => {
    const setup = paragraph(LINES, WIDTH);
    const state = initialState(setup.input, 0);
    const lines = geometry(setup, state);
    expect(lines).toHaveLength(3);
    expect(lines[1]?.baseline).toBe(TOP - LEADING);
    // Offset 24 is "jumps|" + 4 on the second line ("jumps over…" starts at 20).
    expect(caretAt(lines, 24)).toEqual({ line: 1, x: LEFT + 4 * ADVANCE });
    // The joining space shows at the end of the line before; its end on the next line.
    expect(caretAt(lines, 19).line).toBe(0);
    expect(caretAt(lines, 20)).toEqual({ line: 1, x: LEFT });
    expect(caretAt(lines, setup.input.text.length).line).toBe(2);
  });

  it('crosses lines with Up and Down, keeping the goal x', () => {
    const setup = paragraph(LINES, WIDTH);
    let state = initialState(setup.input, 10); // "The quick |brown"
    const lines = geometry(setup, state);
    state = moveVertical(state, lines, 1, false);
    expect(state.focus).toBe(30); // "jumps over|"
    state = moveVertical(state, lines, 1, false);
    expect(state.focus).toBe(50);
    state = moveVertical(state, lines, 1, false);
    expect(state.focus).toBe(setup.input.text.length);
    state = moveVertical(initialState(setup.input, 3), lines, -1, false);
    expect(state.focus).toBe(0);
    const extended = moveVertical(initialState(setup.input, 10), lines, 1, true);
    expect(selectionOf(extended)).toEqual({ start: 10, end: 30 });
  });

  it('goes to line edges and maps a point to an offset', () => {
    const setup = paragraph(LINES, WIDTH);
    const state = initialState(setup.input, 25);
    const lines = geometry(setup, state);
    expect(moveLineEdge(state, lines, 'start', false).focus).toBe(20);
    expect(moveLineEdge(state, lines, 'end', false).focus).toBe(39);
    expect(offsetAtPoint(lines, { x: LEFT + 2.4 * ADVANCE, y: TOP - LEADING + 3 })).toBe(22);
    expect(offsetAtPoint(lines, { x: LEFT + 100 * ADVANCE, y: TOP + 2 })).toBe(19);
  });

  it('a typed line break starts a new line', () => {
    const setup = paragraph(LINES, WIDTH);
    let state = initialState(setup.input, 9);
    state = insertText(state, '\n');
    const result = relayout(fns, setup, state);
    expect(result.layout.lines[0]?.text).toBe('The quick');
    expect(result.layout.lineDelta).toBe(1);
    expect(['grow', 'tighten', 'overflow']).toContain(result.decision.kind);
    const lines = caretLines(setup, state, result.layout);
    expect(caretAt(lines, 10)).toEqual({ line: 1, x: LEFT });
  });

  it('draws a selection rectangle per line', () => {
    const setup = paragraph(LINES, WIDTH);
    const state = initialState(setup.input, 0);
    const lines = geometry(setup, state);
    const rects = selectionRects(lines, { start: 16, end: 25 });
    expect(rects).toHaveLength(2);
    expect(rects[0]?.x0).toBe(LEFT + 16 * ADVANCE);
    expect(rects[1]?.x1).toBe(LEFT + 5 * ADVANCE);
  });

  it('re-lays and re-plans 2,000 characters within 4 ms per keystroke', () => {
    const styles = {
      s0: {
        fontId: 0,
        fontSize: 10,
        matrix: [1, 0, 0, 1, 0, 0] as const,
        fill: '#000',
        family: 'serif',
        bold: false,
        italic: false,
      },
    };
    const words = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do'.split(' ');
    const lines: string[] = [];
    let total = 0;
    let line = '';
    for (let i = 0; total < 2000; i++) {
      const word = words[i % words.length] ?? 'x';
      if (line.length + word.length + 1 > 60) {
        lines.push(line);
        total += line.length + 1;
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    lines.push(line);
    const setup = paragraph(lines, { width: 60 * ADVANCE, align: 'justify' });
    expect(setup.input.text.length).toBeGreaterThanOrEqual(2000);
    let state = initialState(setup.input, 3);
    // Warm up, then type at the start (the worst case: everything after may rewrap). The
    // median keystroke is what is asserted: a shared test machine adds outliers, not cost.
    for (let i = 0; i < 10; i++) caretLines(setup, state, relayout(fns, setup, state).layout);
    const times: number[] = [];
    for (let i = 0; i < 31; i++) {
      const t0 = performance.now();
      state = insertText(state, i % 2 === 0 ? 'w' : ' ');
      const result = relayout(fns, setup, state);
      const lines = caretLines(setup, state, result.layout);
      buildScene({ setup, state, relayout: result, lines, styles, focused: true });
      times.push(performance.now() - t0);
    }
    const ms = [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)] ?? 0;
    expect(ms).toBeLessThan(4);
  });
});
