/**
 * The one ink palette (craft spec §6, ADR-0021 §3): every contrast ratio of the spec's
 * tables (writing inks ≥ 4.5:1 and accent inks ≥ 3:1 on white; black text on each tint,
 * drawn with Multiply at opacity 1, ≥ 10:1), the helpers, and that presets, swatches, tool
 * defaults and stamps read from the module: no other source file in `annotations/` spells a
 * palette colour or one of the colours it replaced. Also: a default pen stroke selected in
 * the contextual bar shows as its swatch, never as "custom" (spec §10).
 *
 * The contrast maths is WCAG 2.2 relative luminance, the same as `styles/tokens.test.ts`.
 */
import type { PageId, SourceId } from '@pdf-editor/document-model';
import type { Annotation } from '@pdf-editor/engine';
import { cleanup, render, screen, within } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { m } from '../i18n';
import { DEFAULT_STYLES, resetAnnotationStore } from './annotation-store';
import { primaryColor } from './colors';
import {
  contrastRatio,
  hexRgb,
  INK,
  INK_CONTRAST_MIN,
  inkOf,
  INKS,
  isDefaultInk,
  isTint,
  LEGACY_INKS,
  migrateLegacyColor,
  multiplyRgb,
  nearestInk,
  nearestTint,
  paletteName,
  PURE_BLACK,
  TINT,
  TINT_CONTRAST_MIN,
  TINTS,
  WHITE,
} from './palette';
import { DEFAULT_PRESETS, HIGHLIGHTER_SWATCHES, PEN_SWATCHES } from './pen/presets';
import { BUILTIN_STAMPS } from './stamps';
import { StyleControls, swatchesFor } from './StyleControls';

/** The spec's ink table (§6): role, name, hex as written there, ratio on white. */
const INK_TABLE = [
  ['writing', 'Black', '#1a1a1a', 17.4],
  ['writing', 'Blue', '#1760ee', 5.32],
  ['writing', 'Red', '#db1c22', 5.0],
  ['writing', 'Green', '#02853c', 4.75],
  ['writing', 'Purple', '#8036d3', 6.2],
  ['accent', 'Orange', '#e46910', 3.32],
  ['accent', 'Pink', '#e02c8a', 4.29],
  ['accent', 'Cyan', '#0891c9', 3.56],
] as const;

/** The spec's tint table (§6): name, hex, black `#000` on it, our black ink on it. */
const TINT_TABLE = [
  ['Yellow', '#FFEA00', 17.02, 14.11],
  ['Green', '#8CF26B', 15.03, 12.46],
  ['Blue', '#8FD3FF', 12.93, 10.72],
  ['Pink', '#FF9AD5', 10.84, 8.98],
] as const;

/** The colours the palette replaced (pen presets, style swatches, tool defaults, stamps). */
const OLD_COLOURS = [
  '#1E5BD8',
  '#FFD400',
  '#E53935',
  '#FFEB3B',
  '#1E88E5',
  '#43A047',
  '#FB8C00',
  '#8E24AA',
  '#D81B60',
  '#1F1F1F',
  '#2E7D32',
  '#C62828',
];

const ratio = (a: string, b: string) => contrastRatio(hexRgb(a), hexRgb(b));

describe('palette: the spec tables', () => {
  it('has the eight inks with their roles, names and ratios on white', () => {
    expect(INKS.map((ink) => [ink.role, ink.name(), ink.hex.toLowerCase()])).toEqual(
      INK_TABLE.map(([role, name, hex]) => [role, name, hex]),
    );
    for (const [role, , hex, onWhite] of INK_TABLE) {
      const r = contrastRatio(hexRgb(hex), WHITE);
      expect(r, hex).toBeCloseTo(onWhite, 2);
      expect(r, hex).toBeGreaterThanOrEqual(INK_CONTRAST_MIN[role]);
    }
    expect(INK_CONTRAST_MIN).toEqual({ writing: 4.5, accent: 3 });
  });

  it('has the four tints with their names', () => {
    expect(TINTS.map((tint) => [tint.name(), tint.hex])).toEqual(
      TINT_TABLE.map(([name, hex]) => [name, hex]),
    );
  });

  it('keeps black text on each tint at ≥ 10:1 with Multiply at opacity 1', () => {
    expect(TINT_CONTRAST_MIN).toBe(10);
    for (const [, hex, black, ours] of TINT_TABLE) {
      const tint = hexRgb(hex);
      // Multiply at full opacity over white paper is the tint itself, and over black text
      // it leaves the text black: the ratio is that of black on the tint.
      const paper = multiplyRgb(tint, WHITE);
      const text = multiplyRgb(tint, hexRgb(PURE_BLACK));
      expect(paper).toEqual(tint);
      expect(text).toEqual([0, 0, 0]);
      expect(contrastRatio(text, paper), hex).toBeCloseTo(black, 2);
      expect(contrastRatio(text, paper), hex).toBeGreaterThanOrEqual(TINT_CONTRAST_MIN);
      // Our black ink on the tint: the spec's column, and Multiply only darkens the ink.
      expect(ratio(INK.black, hex), hex).toBeCloseTo(ours, 2);
      const inked = multiplyRgb(tint, hexRgb(INK.black));
      expect(contrastRatio(inked, paper), hex).toBeGreaterThanOrEqual(ratio(INK.black, hex));
    }
  });

  it('tells the spec where our black ink stays under 10:1 on a tint', () => {
    // The spec's tint table lists 8.98:1 for our black on pink (9.61:1 once Multiply darkens
    // it); every other tint keeps our black at ≥ 10:1 too.
    const under = TINT_TABLE.filter(([, hex]) => {
      const tint = hexRgb(hex);
      return contrastRatio(multiplyRgb(tint, hexRgb(INK.black)), tint) < TINT_CONTRAST_MIN;
    }).map(([name]) => name);
    expect(under).toEqual(['Pink']);
  });
});

describe('palette: helpers', () => {
  it('tells inks and tints from custom colours, in any case', () => {
    for (const ink of INKS) {
      expect(isDefaultInk(ink.hex)).toBe(true);
      expect(isDefaultInk(ink.hex.toLowerCase())).toBe(true);
      expect(isTint(ink.hex)).toBe(false);
    }
    for (const tint of TINTS) {
      expect(isTint(tint.hex.toLowerCase())).toBe(true);
      expect(isDefaultInk(tint.hex)).toBe(false);
    }
    for (const old of OLD_COLOURS) expect(isDefaultInk(old)).toBe(false);
    expect(isDefaultInk(PURE_BLACK)).toBe(false);
    expect(paletteName('#1760ee')).toBe('Blue');
    expect(paletteName(TINT.pink)).toBe('Pink');
    expect(paletteName('#123456')).toBeUndefined();
  });

  it('finds the nearest ink', () => {
    for (const ink of INKS) expect(nearestInk(ink.hex)).toBe(ink);
    expect(nearestInk('#000000').id).toBe('black');
    expect(nearestInk('#1F1F1F').id).toBe('black');
    expect(nearestInk('#1E5BD8').id).toBe('blue');
    expect(nearestInk('#E53935').id).toBe('red');
    expect(nearestInk('#43A047').id).toBe('green');
    expect(nearestInk('#8E24AA').id).toBe('purple');
    expect(nearestInk('#FB8C00').id).toBe('orange');
    expect(nearestInk('#D81B60').id).toBe('pink');
    expect(nearestInk('#0099dd').id).toBe('cyan');
  });

  it('finds the nearest tint by hue; a grey gets yellow', () => {
    for (const tint of TINTS) expect(nearestTint(tint.hex)).toBe(tint);
    expect(nearestTint('#FFD400').id).toBe('yellow');
    expect(nearestTint('#FFEB3B').id).toBe('yellow');
    expect(nearestTint(INK.green).id).toBe('green');
    expect(nearestTint(INK.blue).id).toBe('blue');
    expect(nearestTint(INK.cyan).id).toBe('blue');
    expect(nearestTint(INK.red).id).toBe('pink');
    expect(nearestTint(INK.pink).id).toBe('pink');
    expect(nearestTint(INK.orange).id).toBe('yellow');
    expect(nearestTint('#808080').id).toBe('yellow');
    expect(nearestTint(INK.black).id).toBe('yellow');
  });

  it('migrates an old colour to the new colour of its role and keeps custom ones', () => {
    expect(migrateLegacyColor('#1f1f1f', 'ink')).toBe(INK.black);
    expect(migrateLegacyColor('#000000', 'ink')).toBe(INK.black);
    expect(migrateLegacyColor('#1E5BD8', 'ink')).toBe(INK.blue);
    expect(migrateLegacyColor('#1E88E5', 'ink')).toBe(INK.blue);
    expect(migrateLegacyColor('#E53935', 'ink')).toBe(INK.red);
    expect(migrateLegacyColor('#43A047', 'ink')).toBe(INK.green);
    expect(migrateLegacyColor('#8E24AA', 'ink')).toBe(INK.purple);
    expect(migrateLegacyColor('#FB8C00', 'ink')).toBe(INK.orange);
    expect(migrateLegacyColor('#D81B60', 'ink')).toBe(INK.pink);
    // Yellow is no longer an ink: cyan took its place.
    expect(migrateLegacyColor('#FFD400', 'ink')).toBe(INK.cyan);
    expect(migrateLegacyColor('#FFEB3B', 'tint')).toBe(TINT.yellow);
    expect(migrateLegacyColor('#43A047', 'tint')).toBe(TINT.green);
    expect(migrateLegacyColor('#abcdef', 'ink')).toBe('#ABCDEF');
    expect(migrateLegacyColor('#abcdef', 'tint')).toBe('#ABCDEF');
    // Every replaced colour has a replacement in the palette.
    for (const [old, ink] of Object.entries(LEGACY_INKS)) {
      expect(isDefaultInk(ink), old).toBe(true);
      expect(isTint(migrateLegacyColor(old, 'tint')), old).toBe(true);
    }
  });
});

describe('palette: the one source', () => {
  it('feeds the presets, the swatches, the tool defaults, colours and stamps', () => {
    expect(DEFAULT_PRESETS.map((p) => p.color)).toEqual([
      INK.black,
      INK.blue,
      INK.red,
      TINT.yellow,
    ]);
    expect(PEN_SWATCHES.map((s) => s.color)).toEqual(INKS.map((ink) => ink.hex));
    expect(HIGHLIGHTER_SWATCHES.map((s) => s.color)).toEqual(TINTS.map((tint) => tint.hex));
    expect(swatchesFor(false, INK.blue)).toBe(INKS);
    expect(swatchesFor(false, '#123456')).toBe(INKS);
    expect(swatchesFor(true, undefined)).toBe(TINTS);
    expect(swatchesFor(false, TINT.yellow.toLowerCase())).toBe(TINTS);
    expect(
      Object.fromEntries(Object.entries(DEFAULT_STYLES).map(([g, style]) => [g, style.color])),
    ).toEqual({
      highlight: TINT.yellow,
      underline: INK.blue,
      strikeout: INK.red,
      squiggly: INK.green,
      ink: INK.black,
      shape: INK.red,
      text: INK.black,
      note: TINT.yellow,
    });
    expect(BUILTIN_STAMPS.map((s) => [s.name, s.color])).toEqual([
      ['Draft', INK.blue],
      ['Approved', INK.green],
      ['Confidential', INK.red],
    ]);
    const mark = {
      id: 'r',
      kind: 'redact',
      pageIndex: 0,
      rect: { x: 0, y: 0, width: 1, height: 1 },
      quads: [],
    } satisfies Annotation;
    expect(primaryColor(mark)).toBe(PURE_BLACK);
  });

  it('no other source file in annotations/ spells a palette colour or a replaced one', () => {
    const sources = import.meta.glob<string>(
      ['./**/*.{ts,tsx}', '!./**/*.test.{ts,tsx}', '!./palette.ts'],
      { query: '?raw', import: 'default', eager: true },
    );
    expect(Object.keys(sources)).toContain('./pen/presets.ts');
    expect(Object.keys(sources)).toContain('./StyleControls.tsx');
    expect(Object.keys(sources)).toContain('./annotation-store.ts');
    const forbidden = [
      ...OLD_COLOURS,
      ...INKS.map((ink) => ink.hex),
      ...TINTS.map((tint) => tint.hex),
    ];
    const found = Object.entries(sources).flatMap(([path, text]) =>
      forbidden.filter((hex) => text.toUpperCase().includes(hex)).map((hex) => `${path} ${hex}`),
    );
    expect(found).toEqual([]);
  });
});

describe('palette: the contextual bar shows a default stroke as its swatch', () => {
  afterEach(() => {
    cleanup();
    resetAnnotationStore();
  });

  const target = {
    source: 's' as SourceId,
    pageIndex: 0,
    pageId: 'p' as PageId,
    position: 1,
  };

  function stroke(color: string, opacity = 1): Annotation {
    return {
      id: `ink-${color}`,
      kind: 'ink',
      pageIndex: 0,
      rect: { x: 0, y: 0, width: 10, height: 10 },
      color,
      opacity,
      strokeWidth: 1.5,
      paths: [
        [
          { x: 1, y: 1 },
          { x: 9, y: 9 },
        ],
      ],
    };
  }

  function colourGroup(annotation: Annotation) {
    render(createElement(StyleControls, { variant: 'bar', target, annotations: [annotation] }));
    return screen.getByRole('radiogroup', { name: m.annot_color() });
  }

  for (const preset of DEFAULT_PRESETS) {
    it(`a stroke of the ${preset.color} preset (engine read-back in lower case)`, () => {
      const group = colourGroup(stroke(preset.color.toLowerCase(), preset.opacity));
      const name = paletteName(preset.color) ?? '';
      expect(within(group).getByRole('radio', { name })).toHaveAttribute('aria-checked', 'true');
      expect(within(group).getAllByRole('radio', { checked: true })).toHaveLength(1);
      const custom = group.querySelector('label');
      expect(custom).not.toHaveAttribute('data-custom');
    });
  }

  it('offers the eight inks for a pen stroke and the four tints for a highlight', () => {
    const inks = colourGroup(stroke(INK.blue));
    expect(
      within(inks)
        .getAllByRole('radio')
        .map((r) => r.getAttribute('aria-label')),
    ).toEqual(INKS.map((ink) => ink.name()));
    cleanup();
    const highlight = colourGroup({
      id: 'h',
      kind: 'highlight',
      pageIndex: 0,
      rect: { x: 0, y: 0, width: 10, height: 10 },
      color: TINT.green,
      quads: [],
    });
    expect(
      within(highlight)
        .getAllByRole('radio')
        .map((r) => r.getAttribute('aria-label')),
    ).toEqual(TINTS.map((tint) => tint.name()));
    expect(within(highlight).getByRole('radio', { name: 'Green' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('a custom colour shows in the custom control', () => {
    const group = colourGroup(stroke('#123456'));
    expect(within(group).queryAllByRole('radio', { checked: true })).toHaveLength(0);
    expect(group.querySelector('label')).toHaveAttribute('data-custom', '');
    expect(inkOf('#123456')).toBeUndefined();
  });
});
