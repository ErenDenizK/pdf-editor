/**
 * Pen presets (experience-redesign spec §6.2, §6.3, §9; craft spec §6): the defaults from the
 * palette, field-by-field validation of the stored settings, the migration of version 1
 * settings, persistence per device (a store reset reads them back, as a reload would), and
 * the arm and edit rules: arming restyles the pen, editing the armed preset restyles it too,
 * editing another one does not, and the pen's style controls edit the armed preset. The
 * editor offers the eight inks for a pen and the four tints for the highlighter.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetToolStore, useToolStore } from '../../viewer/tool-store';
import {
  DEFAULT_STYLES,
  resetAnnotationStore,
  TOOL_STYLES_STORAGE_KEY,
  useAnnotationStore,
} from '../annotation-store';
import { INK, INKS, TINT, TINTS } from '../palette';
import {
  DEFAULT_PEN_SETTINGS,
  DEFAULT_PRESETS,
  dotSize,
  HIGHLIGHTER_SWATCHES,
  LEGACY_PEN_PRESETS_STORAGE_KEY,
  migratePreset,
  parsePenSettings,
  PEN_PRESETS_STORAGE_KEY,
  PEN_SWATCHES,
  presetLabel,
  presetName,
  presetSwatches,
  validPreset,
} from './presets';

const store = () => useAnnotationStore.getState();

function stored(): unknown {
  const raw = localStorage.getItem(PEN_PRESETS_STORAGE_KEY);
  return raw === null ? undefined : (JSON.parse(raw) as unknown);
}

describe('pen presets', () => {
  beforeEach(() => {
    localStorage.removeItem(TOOL_STYLES_STORAGE_KEY);
    localStorage.removeItem(PEN_PRESETS_STORAGE_KEY);
    localStorage.removeItem(LEGACY_PEN_PRESETS_STORAGE_KEY);
    resetAnnotationStore();
    resetToolStore();
  });
  afterEach(() => {
    localStorage.removeItem(TOOL_STYLES_STORAGE_KEY);
    localStorage.removeItem(PEN_PRESETS_STORAGE_KEY);
    localStorage.removeItem(LEGACY_PEN_PRESETS_STORAGE_KEY);
    resetAnnotationStore();
    resetToolStore();
  });

  it('has the spec defaults, the first armed, and the pen drawing with it', () => {
    expect(PEN_PRESETS_STORAGE_KEY).toBe('pdf-editor:ui:pen-presets:v2');
    expect(DEFAULT_PRESETS).toEqual([
      { color: INK.black, width: 1.5, opacity: 1 },
      { color: INK.blue, width: 1.5, opacity: 1 },
      { color: INK.red, width: 2, opacity: 1 },
      { color: TINT.yellow, width: 12, opacity: 0.4 },
    ]);
    expect(INK.black).toBe('#1A1A1A');
    expect(TINT.yellow).toBe('#FFEA00');
    expect(store().pen).toEqual(DEFAULT_PEN_SETTINGS);
    expect(store().styles.ink).toMatchObject({ color: INK.black, strokeWidth: 1.5, opacity: 1 });
    expect(DEFAULT_STYLES.ink).toEqual(store().styles.ink);
    expect(stored()).toBeUndefined();
  });

  it('names presets by colour, says their width, and sizes their dots', () => {
    expect(DEFAULT_PRESETS.map((p, i) => presetLabel(i, p))).toEqual([
      'Black pen, 1.5 pt',
      'Blue pen, 1.5 pt',
      'Red pen, 2 pt',
      'Yellow highlighter, 12 pt',
    ]);
    // A colour that is not a swatch is never named as one.
    expect(presetName(2, { color: '#123456', width: 1, opacity: 1 })).toBe('Pen 3');
    expect(presetName(3, { color: '#123456', width: 9, opacity: 0.5 })).toBe('Highlighter 4');
    // Every ink and tint names its preset.
    expect(presetName(0, { color: INK.cyan, width: 1, opacity: 1 })).toBe('Cyan pen');
    expect(presetName(3, { color: TINT.pink, width: 12, opacity: 0.4 })).toBe('Pink highlighter');
    expect([0.25, 1, 1.5, 3, 3.25, 24].map(dotSize)).toEqual([10, 10, 13, 13, 16, 16]);
  });

  it('reads stored settings field by field', () => {
    expect(parsePenSettings(undefined)).toBe(DEFAULT_PEN_SETTINGS);
    expect(parsePenSettings('x')).toBe(DEFAULT_PEN_SETTINGS);
    expect(parsePenSettings({ v: 3, active: 1, presets: [] })).toBe(DEFAULT_PEN_SETTINGS);
    const parsed = parsePenSettings({
      v: 2,
      active: 7,
      presets: [
        { color: '#00ff00', width: 99, opacity: 0 },
        { color: 'blue', width: 'wide', opacity: 0.555 },
        null,
      ],
      burstPauseMs: 10,
      burstGapPt: 'far',
    });
    expect(parsed.active).toBe(0);
    expect(parsed.presets).toEqual([
      { color: '#00FF00', width: 24, opacity: 0.1 },
      { ...DEFAULT_PRESETS[1], opacity: 0.56 },
      DEFAULT_PRESETS[2],
      DEFAULT_PRESETS[3],
    ]);
    expect(parsed.burstPauseMs).toBe(300);
    expect(parsed).not.toHaveProperty('burstGapPt');
    expect(parsePenSettings({ v: 2, active: 3, burstGapPt: 500 })).toMatchObject({
      active: 3,
      burstGapPt: 144,
      presets: DEFAULT_PRESETS,
    });
    // Widths land on a quarter point.
    expect(validPreset(DEFAULT_PRESETS[0], { width: 1.3 }).width).toBe(1.25);
  });

  it('arming a preset restyles the pen and survives a reload', () => {
    store().armPreset(1);
    expect(store().pen.active).toBe(1);
    expect(store().styles.ink).toMatchObject({ color: INK.blue, strokeWidth: 1.5, opacity: 1 });
    expect(stored()).toMatchObject({ v: 2, active: 1 });

    resetAnnotationStore();
    expect(store().pen.active).toBe(1);
    expect(store().styles.ink.color).toBe(INK.blue);
  });

  it('editing a preset persists it; only the armed one restyles the pen', () => {
    store().editPreset(2, { color: INK.green.toLowerCase(), width: 5 });
    expect(store().pen.presets[2]).toEqual({ color: INK.green, width: 5, opacity: 1 });
    // Preset 0 is armed: the pen keeps its style.
    expect(store().styles.ink.color).toBe(INK.black);

    store().editPreset(0, { width: 3, opacity: 0.5 });
    expect(store().styles.ink).toMatchObject({ color: INK.black, strokeWidth: 3, opacity: 0.5 });

    resetAnnotationStore();
    expect(store().pen.presets[2]).toEqual({ color: INK.green, width: 5, opacity: 1 });
    expect(store().pen.presets[0]).toEqual({ color: INK.black, width: 3, opacity: 0.5 });
    expect(store().styles.ink.strokeWidth).toBe(3);

    store().resetPreset(0);
    expect(store().pen.presets[0]).toEqual(DEFAULT_PRESETS[0]);
    expect(store().styles.ink.strokeWidth).toBe(1.5);
  });

  it("the pen's style controls (applyStyle) edit the armed preset; other tools do not", () => {
    store().armPreset(3);
    useToolStore.getState().setMode('ink');
    store().applyStyle({ color: TINT.green, strokeWidth: 8 });
    expect(store().pen.presets[3]).toEqual({ color: TINT.green, width: 8, opacity: 0.4 });
    expect(store().styles.ink).toMatchObject({ color: TINT.green, strokeWidth: 8, opacity: 0.4 });

    useToolStore.getState().setMode('rectangle');
    store().applyStyle({ color: INK.green });
    expect(store().pen.presets[3].color).toBe(TINT.green);
    expect(store().styles.shape.color).toBe(INK.green);
  });

  it('offers the eight inks for a pen and the four tints for the highlighter', () => {
    expect(PEN_SWATCHES.map((s) => s.color)).toEqual(INKS.map((ink) => ink.hex));
    expect(PEN_SWATCHES.map((s) => s.name())).toEqual([
      'Black',
      'Blue',
      'Red',
      'Green',
      'Purple',
      'Orange',
      'Pink',
      'Cyan',
    ]);
    expect(HIGHLIGHTER_SWATCHES.map((s) => s.color)).toEqual(TINTS.map((tint) => tint.hex));
    expect(presetSwatches(DEFAULT_PRESETS[0])).toBe(PEN_SWATCHES);
    expect(presetSwatches(DEFAULT_PRESETS[1])).toBe(PEN_SWATCHES);
    expect(presetSwatches(DEFAULT_PRESETS[2])).toBe(PEN_SWATCHES);
    expect(presetSwatches(DEFAULT_PRESETS[3])).toBe(HIGHLIGHTER_SWATCHES);
    // Every default is one of the swatches its editor offers: none shows as "custom".
    for (const preset of DEFAULT_PRESETS) {
      expect(presetSwatches(preset).map((s) => s.color)).toContain(preset.color);
    }
  });
});

describe('pen presets: migration of version 1 (craft spec §6)', () => {
  const v1Defaults = [
    { color: '#1F1F1F', width: 1.5, opacity: 1 },
    { color: '#1E5BD8', width: 1.5, opacity: 1 },
    { color: '#E53935', width: 2, opacity: 1 },
    { color: '#FFD400', width: 12, opacity: 0.4 },
  ];

  beforeEach(() => {
    localStorage.removeItem(TOOL_STYLES_STORAGE_KEY);
    localStorage.removeItem(PEN_PRESETS_STORAGE_KEY);
    localStorage.removeItem(LEGACY_PEN_PRESETS_STORAGE_KEY);
    resetAnnotationStore();
  });
  afterEach(() => {
    localStorage.removeItem(TOOL_STYLES_STORAGE_KEY);
    localStorage.removeItem(PEN_PRESETS_STORAGE_KEY);
    localStorage.removeItem(LEGACY_PEN_PRESETS_STORAGE_KEY);
    resetAnnotationStore();
  });

  it('maps the old defaults to the new defaults of their roles', () => {
    const parsed = parsePenSettings({ v: 1, active: 2, presets: v1Defaults, burstPauseMs: 900 });
    expect(parsed).toEqual({ v: 2, active: 2, presets: DEFAULT_PRESETS, burstPauseMs: 900 });
  });

  it('maps old swatches to the ink of their role and keeps custom colours, widths and opacities', () => {
    const parsed = parsePenSettings({
      v: 1,
      active: 0,
      presets: [
        { color: '#43A047', width: 3, opacity: 1 },
        { color: '#123456', width: 0.5, opacity: 1 },
        { color: '#8e24aa', width: 2, opacity: 1 },
        // Yellow as an opaque ink: cyan took its place among the inks.
        { color: '#FFD400', width: 4, opacity: 1 },
      ],
    });
    expect(parsed.presets).toEqual([
      { color: INK.green, width: 3, opacity: 1 },
      { color: '#123456', width: 0.5, opacity: 1 },
      { color: INK.purple, width: 2, opacity: 1 },
      { color: INK.cyan, width: 4, opacity: 1 },
    ]);
  });

  it('turns a translucent preset into the highlighter with the nearest tint', () => {
    expect(migratePreset({ color: '#FFD400', width: 12, opacity: 0.4 })).toEqual({
      color: TINT.yellow,
      width: 12,
      opacity: 0.4,
    });
    expect(migratePreset({ color: '#43A047', width: 8, opacity: 0.5 }).color).toBe(TINT.green);
    expect(migratePreset({ color: '#1E5BD8', width: 8, opacity: 0.5 }).color).toBe(TINT.blue);
    expect(migratePreset({ color: '#D81B60', width: 8, opacity: 0.5 }).color).toBe(TINT.pink);
    expect(migratePreset({ color: '#E53935', width: 8, opacity: 0.5 }).color).toBe(TINT.pink);
    // A grey has no hue: the default tint.
    expect(migratePreset({ color: '#1F1F1F', width: 8, opacity: 0.5 }).color).toBe(TINT.yellow);
  });

  it('reads version 1 from its old key once and writes version 2 under the new key', () => {
    localStorage.setItem(
      LEGACY_PEN_PRESETS_STORAGE_KEY,
      JSON.stringify({ v: 1, active: 1, presets: v1Defaults }),
    );
    resetAnnotationStore();
    expect(store().pen).toEqual({ v: 2, active: 1, presets: DEFAULT_PRESETS });
    expect(store().styles.ink.color).toBe(INK.blue);

    store().armPreset(3);
    expect(stored()).toMatchObject({ v: 2, active: 3, presets: DEFAULT_PRESETS });
    // Version 2 wins over what is left under the old key.
    resetAnnotationStore();
    expect(store().pen.active).toBe(3);
    expect(store().styles.ink).toMatchObject({ color: TINT.yellow, strokeWidth: 12 });
  });

  it('a fresh install has the palette defaults and stores nothing until something changes', () => {
    expect(localStorage.getItem(LEGACY_PEN_PRESETS_STORAGE_KEY)).toBeNull();
    expect(store().pen).toEqual(DEFAULT_PEN_SETTINGS);
    expect(stored()).toBeUndefined();
  });
});
