/**
 * The Highlighter (craft spec §5.4): the snapping rule on synthetic text (along a line →
 * Highlight quads; across lines, on paper, Alt or under 70 % coverage → free ink), the
 * preview's profile (constant width, Multiply on the layer until the stroke settles), and
 * Highlight (H) arming the Highlighter preset. Vitest browser mode.
 */
import type { Rect } from '@pdf-editor/document-model';
import type { Glyph, TextRun } from '@pdf-editor/engine';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAnnouncer } from '../../shell/announcer';
import { resetToolStore, useToolStore } from '../../viewer/tool-store';
import { resetAnnotationStore, useAnnotationStore } from '../annotation-store';
import type { Point } from '../ink';
import { textLines } from '../quads';
import type { ToolDefinition } from '../tools';
import {
  activateHighlighter,
  armedHighlighter,
  glyphHit,
  HighlighterPreview,
  highlighterIndex,
  SNAP_COVERAGE,
  snapHighlighter,
} from './highlighter';
import { InkPreview, type PreviewPath, previewPath } from './ink-preview';
import { DEFAULT_PEN_SETTINGS, PEN_PRESETS_STORAGE_KEY } from './presets';

// ---------------------------------------------------------------------------
// Synthetic text: lines of eight five-letter words, glyphs 6 × 10 pt, spaces without area
// ---------------------------------------------------------------------------

const GLYPH_W = 6;
const GLYPH_H = 10;
const SPACE_W = 3;
const LEFT = 72;
/** Bottoms of three lines, 14 pt apart. */
const LINES = [700, 686, 672] as const;
const WORDS = 8;
/** Where each line's text ends: 8 × 30 + 7 × 3 pt after LEFT. */
const RIGHT = LEFT + WORDS * 5 * GLYPH_W + (WORDS - 1) * SPACE_W;

function line(bottom: number): TextRun {
  const glyphs: Glyph[] = [];
  let x = LEFT;
  for (let w = 0; w < WORDS; w++) {
    if (w > 0) {
      glyphs.push({ text: ' ', rect: { x, y: bottom, width: 0, height: 0 }, fontSize: 12 });
      x += SPACE_W;
    }
    for (let c = 0; c < 5; c++) {
      const rect: Rect = { x, y: bottom, width: GLYPH_W, height: GLYPH_H };
      glyphs.push({ text: 'abcde'[c] ?? 'a', rect, fontSize: 12 });
      x += GLYPH_W;
    }
  }
  return {
    text: glyphs.map((g) => g.text).join(''),
    rect: { x: LEFT, y: bottom, width: x - LEFT, height: GLYPH_H },
    glyphs,
  };
}

const RUNS: readonly TextRun[] = LINES.map(line);
/** The centre of line `i`'s band. */
const mid = (i: number) => (LINES[i] ?? 0) + GLYPH_H / 2;
const WIDTH = 12;

function along(i: number, from: number, to: number, points = 12): Point[] {
  return Array.from({ length: points }, (_, k) => ({
    x: from + ((to - from) * k) / (points - 1),
    y: mid(i),
  }));
}

describe('snapping rule', () => {
  it('groups runs into lines', () => {
    const lines = textLines(RUNS);
    expect(lines.map((l) => l.runs)).toEqual([[0], [1], [2]]);
    expect(lines.every((l) => l.dir === 'h')).toBe(true);
  });

  it('a glyph is hit when the band covers half its height at its centre', () => {
    const glyph = { x: 100, y: 700, width: 6, height: 10 };
    const path = [
      { x: 90, y: 0 },
      { x: 120, y: 0 },
    ];
    // The band's top edge at 700 + 5: half the glyph.
    expect(
      glyphHit(
        glyph,
        'h',
        path.map((p) => ({ ...p, y: 699 })),
        6,
      ),
    ).toBe(true);
    // Its top edge at 704: 40 % of the glyph.
    expect(
      glyphHit(
        glyph,
        'h',
        path.map((p) => ({ ...p, y: 698 })),
        6,
      ),
    ).toBe(false);
    // Outside the centre line's extent: not hit, however covered.
    expect(
      glyphHit(
        glyph,
        'h',
        [
          { x: 60, y: 705 },
          { x: 102, y: 705 },
        ],
        6,
      ),
    ).toBe(false);
  });

  it('a stroke along a line becomes a Highlight from its first to its last hit glyph', () => {
    const result = snapHighlighter(RUNS, along(0, LEFT + 1, RIGHT - 1), WIDTH);
    expect(result).toEqual({
      kind: 'highlight',
      quads: [{ x: LEFT, y: LINES[0], width: RIGHT - LEFT, height: GLYPH_H }],
      lines: 1,
    });
    // Starting in the middle of the third word: the quad starts at its first hit glyph.
    const start = LEFT + 2 * 33 + 14;
    const partial = snapHighlighter(RUNS, along(0, start, RIGHT - 1), WIDTH);
    expect(partial.kind).toBe('highlight');
    if (partial.kind !== 'highlight') return;
    expect(partial.quads[0]?.x).toBe(LEFT + 2 * 33 + 12);
    expect(partial.quads[0]?.x).toBeLessThanOrEqual(start);
  });

  it('a slightly wavy or sloped stroke along a line still snaps', () => {
    const path = along(1, LEFT + 2, RIGHT - 2, 40).map((p, k) => ({
      x: p.x,
      y: p.y + Math.sin(k / 3) * 1.5 + (k / 40) * 2,
    }));
    const result = snapHighlighter(RUNS, path, WIDTH);
    expect(result.kind).toBe('highlight');
    if (result.kind === 'highlight') expect(result.quads[0]?.y).toBe(LINES[1]);
  });

  it('two lines drawn in one stroke give one quad per line', () => {
    const path = [...along(0, LEFT + 1, RIGHT - 1), ...along(1, RIGHT - 1, LEFT + 1)];
    const result = snapHighlighter(RUNS, path, WIDTH);
    expect(result.kind).toBe('highlight');
    if (result.kind !== 'highlight') return;
    expect(result.lines).toBe(2);
    expect(result.quads.map((q) => q.y)).toEqual([LINES[0], LINES[1]]);
  });

  it('a stroke across lines stays ink', () => {
    const down = [
      { x: 110, y: mid(0) + 10 },
      { x: 110, y: mid(2) - 10 },
    ];
    expect(snapHighlighter(RUNS, down, WIDTH)).toEqual({ kind: 'ink', reason: 'off-text' });
    // At 45° over the text: it crosses the lines, it does not run along them.
    const diagonal = [
      { x: 120, y: mid(0) + 6 },
      { x: 160, y: mid(2) - 6 },
    ];
    expect(snapHighlighter(RUNS, diagonal, WIDTH).kind).toBe('ink');
    // Along the gap between two lines: the band covers neither line's glyphs by half.
    const between = along(0, LEFT + 1, RIGHT - 1).map((p) => ({ ...p, y: 698 }));
    expect(snapHighlighter(RUNS, between, WIDTH).kind).toBe('ink');
  });

  it('a stroke on paper, or on a page without text, stays ink', () => {
    expect(
      snapHighlighter(
        RUNS,
        along(0, LEFT, RIGHT).map((p) => ({ ...p, y: 500 })),
        WIDTH,
      ),
    ).toEqual({ kind: 'ink', reason: 'off-text' });
    expect(snapHighlighter([], along(0, LEFT, RIGHT), WIDTH)).toEqual({
      kind: 'ink',
      reason: 'no-text',
    });
  });

  it('Alt at release forces ink', () => {
    expect(snapHighlighter(RUNS, along(0, LEFT + 1, RIGHT - 1), WIDTH, { alt: true })).toEqual({
      kind: 'ink',
      reason: 'alt',
    });
  });

  it('coverage just under 70 % stays ink; just over snaps', () => {
    // The text covers [LEFT, RIGHT]; the stroke runs on past its end on the same line.
    const start = LEFT + 1;
    const covered = RIGHT - start;
    const under = start + covered / (SNAP_COVERAGE - 0.01);
    const over = start + covered / (SNAP_COVERAGE + 0.01);
    expect(snapHighlighter(RUNS, along(0, start, under, 2), WIDTH).kind).toBe('ink');
    expect(snapHighlighter(RUNS, along(0, start, over, 2), WIDTH).kind).toBe('highlight');
  });

  it('a short wobble into the next line does not count as crossing it', () => {
    const path = [
      ...along(0, LEFT + 1, 250),
      { x: 252, y: mid(0) - 8 },
      { x: 254, y: mid(0) },
      ...along(0, 256, RIGHT - 1),
    ];
    const result = snapHighlighter(RUNS, path, WIDTH);
    expect(result.kind).toBe('highlight');
    if (result.kind === 'highlight') expect(result.lines).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

describe('preview profile', () => {
  let host: HTMLDivElement;
  let layer: HTMLDivElement;

  beforeEach(() => {
    layer = document.createElement('div');
    layer.style.cssText = 'position:absolute;left:0;top:0;width:400px;height:300px';
    host = document.createElement('div');
    host.style.cssText = 'position:absolute;inset:0';
    layer.appendChild(host);
    document.body.appendChild(layer);
  });
  afterEach(() => {
    layer.remove();
    vi.restoreAllMocks();
  });

  const stroke = (): PreviewPath =>
    previewPath(
      [
        { x: 10, y: 10 },
        { x: 60, y: 14 },
        { x: 120, y: 12 },
        { x: 200, y: 16 },
      ],
      [8, 14, 10, 16],
    );

  it('draws the Highlighter at a constant width, opaque, with the layer in Multiply', () => {
    const draw = vi.spyOn(InkPreview.prototype, 'draw');
    const preview = new HighlighterPreview(host, layer, () => 18);
    preview.begin({ color: '#FFEA00', opacity: 0.4 });
    expect(preview.multiply).toBe(true);
    expect(getComputedStyle(layer).mixBlendMode).toBe('multiply');
    expect(preview.liveCanvas?.style.opacity).toBe('');
    preview.draw(stroke(), [{ x: 210, y: 16, w: 3 }]);
    const [path, predicted] = draw.mock.calls[0] ?? [];
    expect(Array.from({ length: 4 }, (_, i) => path?.w(i))).toEqual([18, 18, 18, 18]);
    expect(predicted?.map((p) => p.w)).toEqual([18]);

    const settling = preview.settle(stroke());
    // The settling stroke keeps the blend until the page shows the committed one.
    expect(preview.multiply).toBe(true);
    settling.release();
    expect(preview.multiply).toBe(false);
    settling.release();
    expect(layer.style.mixBlendMode).toBe('');
    preview.destroy();
  });

  it('a pen stroke keeps its widths and the layer its normal blend', () => {
    const draw = vi.spyOn(InkPreview.prototype, 'draw');
    const preview = new HighlighterPreview(host, layer, () => null);
    preview.begin({ color: '#1760EE', opacity: 1 });
    expect(preview.multiply).toBe(false);
    preview.draw(stroke());
    const [path] = draw.mock.calls[0] ?? [];
    expect(Array.from({ length: 4 }, (_, i) => path?.w(i))).toEqual([8, 14, 10, 16]);
    preview.settle().release();
    expect(preview.multiply).toBe(false);
    preview.destroy();
  });

  it('a cancelled highlighter stroke drops the blend; settling strokes keep it', () => {
    let width: number | null = 12;
    const preview = new HighlighterPreview(host, layer, () => width);
    preview.begin({ color: '#FFEA00', opacity: 1 });
    preview.draw(stroke());
    const first = preview.settle(stroke());
    preview.begin({ color: '#FFEA00', opacity: 1 });
    preview.cancel();
    expect(preview.multiply).toBe(true);
    // A pen stroke begun while a highlighter stroke settles.
    width = null;
    preview.begin({ color: '#1A1A1A', opacity: 1 });
    preview.settle().release();
    expect(preview.multiply).toBe(true);
    first.release();
    expect(preview.multiply).toBe(false);
    preview.destroy();
  });
});

// ---------------------------------------------------------------------------
// Highlight (H)
// ---------------------------------------------------------------------------

describe('Highlight (H)', () => {
  beforeEach(() => {
    localStorage.removeItem(PEN_PRESETS_STORAGE_KEY);
    resetAnnotationStore();
    resetToolStore();
    useAnnouncer.setState({ message: '' });
  });
  afterEach(() => {
    localStorage.removeItem(PEN_PRESETS_STORAGE_KEY);
    resetAnnotationStore();
    resetToolStore();
  });

  it('the Highlighter is the fourth preset', () => {
    expect(highlighterIndex(DEFAULT_PEN_SETTINGS)).toBe(3);
  });

  it('arms the pen with the Highlighter preset and says it', async () => {
    const activated: string[] = [];
    const activate = (tool: ToolDefinition) => {
      activated.push(tool.mode);
      useToolStore.getState().setMode(tool.mode);
      return Promise.resolve();
    };
    expect(armedHighlighter()).toBeUndefined();
    await activateHighlighter(activate);
    expect(activated).toEqual(['ink']);
    expect(useToolStore.getState().mode).toBe('ink');
    expect(useAnnotationStore.getState().pen.active).toBe(3);
    expect(armedHighlighter()).toMatchObject({ kind: 'highlighter', width: 12, opacity: 1 });
    expect(useAnnotationStore.getState().styles.ink).toMatchObject({
      color: '#FFEA00',
      strokeWidth: 12,
      opacity: 1,
    });
    await Promise.resolve();
    expect(useAnnouncer.getState().message).toContain('Yellow highlighter, 12 pt');
  });

  it('does not arm the preset when the pen tool did not arm (another rule refused it)', async () => {
    await activateHighlighter(() => Promise.resolve());
    expect(useToolStore.getState().mode).not.toBe('ink');
    expect(useAnnotationStore.getState().pen.active).toBe(0);
  });
});
