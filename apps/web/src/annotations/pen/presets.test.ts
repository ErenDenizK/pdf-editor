/**
 * Pen presets (experience-redesign spec §6.2, §6.3, §9): the defaults, field-by-field
 * validation of the stored settings, persistence per device (a store reset reads them back,
 * as a reload would), and the arm and edit rules: arming restyles the pen, editing the armed
 * preset restyles it too, editing another one does not, and the pen's style controls edit
 * the armed preset.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetToolStore, useToolStore } from '../../viewer/tool-store';
import {
  DEFAULT_STYLES,
  resetAnnotationStore,
  TOOL_STYLES_STORAGE_KEY,
  useAnnotationStore,
} from '../annotation-store';
import {
  DEFAULT_PEN_SETTINGS,
  DEFAULT_PRESETS,
  dotSize,
  parsePenSettings,
  PEN_PRESETS_STORAGE_KEY,
  presetLabel,
  presetName,
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
    resetAnnotationStore();
    resetToolStore();
  });
  afterEach(() => {
    localStorage.removeItem(TOOL_STYLES_STORAGE_KEY);
    localStorage.removeItem(PEN_PRESETS_STORAGE_KEY);
    resetAnnotationStore();
    resetToolStore();
  });

  it('has the spec defaults, the first armed, and the pen drawing with it', () => {
    expect(PEN_PRESETS_STORAGE_KEY).toBe('pdf-editor:ui:pen-presets:v1');
    expect(DEFAULT_PRESETS).toEqual([
      { color: '#1F1F1F', width: 1.5, opacity: 1 },
      { color: '#1E5BD8', width: 1.5, opacity: 1 },
      { color: '#E53935', width: 2, opacity: 1 },
      { color: '#FFD400', width: 12, opacity: 0.4 },
    ]);
    expect(store().pen).toEqual(DEFAULT_PEN_SETTINGS);
    expect(store().styles.ink).toMatchObject({ color: '#1F1F1F', strokeWidth: 1.5, opacity: 1 });
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
    expect([0.25, 1, 1.5, 3, 3.25, 24].map(dotSize)).toEqual([8, 8, 11, 11, 14, 14]);
  });

  it('reads stored settings field by field', () => {
    expect(parsePenSettings(undefined)).toBe(DEFAULT_PEN_SETTINGS);
    expect(parsePenSettings('x')).toBe(DEFAULT_PEN_SETTINGS);
    expect(parsePenSettings({ v: 2, active: 1, presets: [] })).toBe(DEFAULT_PEN_SETTINGS);
    const parsed = parsePenSettings({
      v: 1,
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
    expect(parsePenSettings({ v: 1, active: 3, burstGapPt: 500 })).toMatchObject({
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
    expect(store().styles.ink).toMatchObject({ color: '#1E5BD8', strokeWidth: 1.5, opacity: 1 });
    expect(stored()).toMatchObject({ v: 1, active: 1 });

    resetAnnotationStore();
    expect(store().pen.active).toBe(1);
    expect(store().styles.ink.color).toBe('#1E5BD8');
  });

  it('editing a preset persists it; only the armed one restyles the pen', () => {
    store().editPreset(2, { color: '#43a047', width: 5 });
    expect(store().pen.presets[2]).toEqual({ color: '#43A047', width: 5, opacity: 1 });
    // Preset 0 is armed: the pen keeps its style.
    expect(store().styles.ink.color).toBe('#1F1F1F');

    store().editPreset(0, { width: 3, opacity: 0.5 });
    expect(store().styles.ink).toMatchObject({ color: '#1F1F1F', strokeWidth: 3, opacity: 0.5 });

    resetAnnotationStore();
    expect(store().pen.presets[2]).toEqual({ color: '#43A047', width: 5, opacity: 1 });
    expect(store().pen.presets[0]).toEqual({ color: '#1F1F1F', width: 3, opacity: 0.5 });
    expect(store().styles.ink.strokeWidth).toBe(3);

    store().resetPreset(0);
    expect(store().pen.presets[0]).toEqual(DEFAULT_PRESETS[0]);
    expect(store().styles.ink.strokeWidth).toBe(1.5);
  });

  it("the pen's style controls (applyStyle) edit the armed preset; other tools do not", () => {
    store().armPreset(3);
    useToolStore.getState().setMode('ink');
    store().applyStyle({ color: '#E53935', strokeWidth: 8 });
    expect(store().pen.presets[3]).toEqual({ color: '#E53935', width: 8, opacity: 0.4 });
    expect(store().styles.ink).toMatchObject({ color: '#E53935', strokeWidth: 8, opacity: 0.4 });

    useToolStore.getState().setMode('rectangle');
    store().applyStyle({ color: '#43A047' });
    expect(store().pen.presets[3].color).toBe('#E53935');
    expect(store().styles.shape.color).toBe('#43A047');
  });
});
