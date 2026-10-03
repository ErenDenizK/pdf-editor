/**
 * Synthetic paragraphs for the paragraph editor's tests: a monospaced style (every
 * character 6 pt wide at 10 pt, like Courier), lines on baselines 12 pt apart from y = 700,
 * the measure from x = 72, one text object per line in font id 0.
 */
import type { SourceId } from '@pdf-editor/document-model';
import type {
  LayoutInput,
  LayoutStyle,
  ParagraphBlock,
  ParagraphLine,
  ParagraphSpan,
  TextRunFont,
} from '@pdf-editor/engine';

import type { ParagraphSetup } from './paragraph-model';

export const ADVANCE = 6;
export const LEADING = 12;
export const LEFT = 72;
export const TOP = 700;
export const SIZE = 10;

const CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,;:!?-’‘"()çöüıİ';

export function monoStyle(extra: Partial<LayoutStyle> = {}): LayoutStyle {
  const advances = Object.fromEntries(
    [...Array.from(CHARS), ' '].map((c) => [c, { spaced: ADVANCE, plain: ADVANCE }]),
  );
  return { advances, wordGap: ADVANCE, ...extra };
}

export const FONT: TextRunFont = {
  baseName: 'ABCDEF+Courier',
  embedded: true,
  kind: 'embedded',
  flags: 0,
  bold: false,
  italic: false,
  monospace: true,
  serif: false,
};

export interface ParagraphOptions {
  readonly width?: number;
  readonly align?: ParagraphBlock['align'];
  readonly style?: LayoutStyle;
  readonly source?: SourceId;
  readonly fill?: readonly [number, number, number, number];
  readonly gapBelow?: number;
}

/** A paragraph block, its layout input and the setup from its original lines. */
export function paragraph(
  lines: readonly string[],
  options: ParagraphOptions = {},
): ParagraphSetup {
  const width = options.width ?? 40 * ADVANCE;
  let text = '';
  const blockLines: ParagraphLine[] = lines.map((line, i) => {
    const start = text.length;
    text += line;
    if (i < lines.length - 1) text += ' ';
    const x1 = LEFT + line.length * ADVANCE;
    const span: ParagraphSpan = {
      run: i,
      glyphStart: 0,
      glyphEnd: line.length,
      text: line,
      fontId: 0,
      font: FONT,
      fontSize: SIZE,
      size: SIZE,
      matrix: [1, 0, 0, 1, LEFT, TOP - i * LEADING],
      ...(options.fill ? { fill: options.fill } : {}),
      renderMode: 0,
      x0: LEFT,
      x1,
    };
    return {
      spans: [span],
      baseline: TOP - i * LEADING,
      x0: LEFT,
      x1,
      size: SIZE,
      text: line,
      start,
      end: i === lines.length - 1 ? 'end' : 'space',
      endsWithHyphen: false,
    };
  });
  const source = options.source ?? ('src-test' as SourceId);
  const block: ParagraphBlock = {
    ref: {
      source,
      pageIndex: 0,
      index: 0,
      runs: lines.map((_, i) => ({
        source,
        pageIndex: 0,
        objectPath: [i],
        charStart: 0,
        charCount: lines[i]?.length ?? 0,
        text: lines[i] ?? '',
      })),
    },
    lines: blockLines,
    align: options.align ?? 'left',
    leading: LEADING,
    source: 'geometry',
    kind: 'paragraph',
    direction: { x: 1, y: 0 },
    measure: { left: LEFT, right: LEFT + width },
    indent: 0,
    size: SIZE,
    text,
    box: {
      x: LEFT,
      y: TOP - (lines.length - 1) * LEADING - 3,
      width,
      height: (lines.length - 1) * LEADING + 10,
    },
  };
  const input: LayoutInput = {
    text,
    spans: [{ start: 0, end: text.length, style: 's0' }],
    lines: blockLines.map((l) => ({ start: l.start, y: TOP - l.baseline })),
    styles: { s0: options.style ?? monoStyle() },
    measure: { left: LEFT, right: LEFT + width },
    align: options.align ?? 'left',
    leading: LEADING,
  };
  return { block, input, paragraphGap: LEADING, gapBelow: options.gapBelow ?? 4 * LEADING };
}
