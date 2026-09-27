import type { TextRun } from '@pdf-editor/engine';
import { afterEach, describe, expect, it } from 'vitest';

import {
  assembleCopyText,
  assignRows,
  layoutTextLines,
  selectedPieces,
  selectionCopyText,
  separatorAfter,
  TEXT_LAYER_ATTR,
  TEXT_ROW_ATTR,
} from './text-model';

/** A run of `text` on a baseline, glyphs 6 pt wide. */
function run(text: string, x: number, y: number, size = 10): TextRun {
  const glyphs = Array.from(text).map((ch, i) => ({
    text: ch,
    rect: { x: x + i * 6, y, width: 5, height: size },
    fontSize: size,
  }));
  return { text, rect: { x, y, width: text.length * 6, height: size }, glyphs };
}

describe('assignRows', () => {
  it('keeps runs on one baseline in one row and starts a row per line', () => {
    const rows = assignRows([
      run('Name', 72, 700),
      run('Value', 200, 701),
      run('Next line', 72, 680),
      run('far right', 400, 680.5),
    ]);
    expect(rows).toEqual([0, 0, 1, 1]);
  });

  it('separates vertical text from horizontal text at the same height', () => {
    const vertical: TextRun = {
      text: 'ab',
      rect: { x: 300, y: 690, width: 10, height: 30 },
      glyphs: [
        { text: 'a', rect: { x: 300, y: 710, width: 10, height: 8 }, fontSize: 10 },
        { text: 'b', rect: { x: 300, y: 690, width: 10, height: 8 }, fontSize: 10 },
      ],
    };
    expect(assignRows([run('left', 72, 700), vertical])).toEqual([0, 1]);
  });
});

describe('separatorAfter', () => {
  const lines = [
    { row: 0, text: 'PAGE 1 OF outline-named-dests' },
    { row: 1, text: 'Chapter 1:' },
    { row: 1, text: 'Introduction' },
    { row: 1, text: 'trailing ' },
    { row: 1, text: 'last' },
  ];

  it('puts a newline between rows, a space within a row, nothing at the end', () => {
    expect(lines.map((_, i) => separatorAfter(lines, i))).toEqual(['\n', ' ', ' ', '', '']);
  });
});

describe('assembleCopyText', () => {
  it('joins a row with spaces, rows with newlines and pages with a blank line', () => {
    expect(
      assembleCopyText([
        { page: 0, row: 0, text: 'Name' },
        { page: 0, row: 0, text: 'Value' },
        { page: 0, row: 1, text: 'Second line' },
        { page: 1, row: 0, text: 'Next page' },
        { page: 3, row: 2, text: 'Later' },
      ]),
    ).toBe('Name Value\nSecond line\n\nNext page\n\nLater');
  });

  it('does not double spaces and skips empty pieces', () => {
    expect(
      assembleCopyText([
        { page: 0, row: 0, text: 'ends with ' },
        { page: 0, row: 0, text: '' },
        { page: 0, row: 0, text: 'next' },
      ]),
    ).toBe('ends with next');
    expect(assembleCopyText([])).toBe('');
  });
});

describe('selection → clipboard text', () => {
  let root: HTMLElement | undefined;
  afterEach(() => {
    root?.remove();
    window.getSelection()?.removeAllRanges();
  });

  /** Text layers as TextLayer renders them: lines with separator spans between. */
  function layers(pages: readonly (readonly [number, string][])[]): HTMLElement {
    const container = document.createElement('div');
    pages.forEach((lines, page) => {
      const layer = document.createElement('div');
      layer.setAttribute(TEXT_LAYER_ATTR, String(page));
      const model = lines.map(([row, text]) => ({ row, text }));
      model.forEach(({ row, text }, i) => {
        const span = document.createElement('span');
        span.setAttribute(TEXT_ROW_ATTR, String(row));
        span.textContent = text;
        layer.append(span);
        const separator = separatorAfter(model, i);
        if (separator !== '') {
          const sep = document.createElement('span');
          sep.textContent = separator;
          layer.append(sep);
        }
      });
      container.append(layer);
    });
    document.body.append(container);
    return container;
  }

  it('takes partial first and last lines, whole lines between, across pages', () => {
    root = layers([
      [
        [0, 'Hello world'],
        [0, 'same row'],
        [1, 'second line'],
      ],
      [[0, 'Top of page two']],
    ]);
    const lines = root.querySelectorAll(`[${TEXT_ROW_ATTR}]`);
    // Separators sit between the lines in the DOM: a space in a row, a newline between rows.
    expect(root.querySelector(`[${TEXT_LAYER_ATTR}="0"]`)?.textContent).toBe(
      'Hello world same row\nsecond line',
    );
    const range = document.createRange();
    range.setStart(lines[0]!.firstChild!, 6);
    range.setEnd(lines[3]!.firstChild!, 3);
    expect(selectedPieces(range, root)).toEqual([
      { page: 0, row: 0, text: 'world' },
      { page: 0, row: 0, text: 'same row' },
      { page: 0, row: 1, text: 'second line' },
      { page: 1, row: 0, text: 'Top' },
    ]);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    // Separators are not copied twice.
    expect(selectionCopyText(selection)).toBe('world same row\nsecond line\n\nTop');
  });

  it('ignores selections outside the text layer', () => {
    root = layers([[[0, 'text']]]);
    const outside = document.createElement('p');
    outside.textContent = 'chrome';
    document.body.append(outside);
    const range = document.createRange();
    range.selectNodeContents(outside);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    expect(selectionCopyText(selection)).toBeUndefined();
    outside.remove();
  });
});

describe('layoutTextLines', () => {
  it('drops empty runs and positions lines on the displayed page', () => {
    const lines = layoutTextLines(
      [run('Hi', 72, 700), { text: '', rect: { x: 0, y: 0, width: 0, height: 0 }, glyphs: [] }],
      {
        size: { width: 612, height: 792 },
        originX: 0,
        originY: 0,
        rotation: 0,
        scale: 2,
      },
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      text: 'Hi',
      angle: 0,
      left: 144,
      top: 2 * (792 - 710),
      thickness: 20,
    });
  });
});
