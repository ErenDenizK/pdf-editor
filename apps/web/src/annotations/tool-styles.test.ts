/**
 * One style rule (experience-redesign spec §6.3, P1): `applyStyle` edits the selection when
 * there is one, else the armed tool's style; tool styles persist per device and survive a
 * store reset (a reload); creating never selects (§6.1); stored version 1 styles migrate to
 * the one palette (craft spec §6). Vitest browser mode, real PDFium.
 */
import { getActiveDocument } from '@pdf-editor/document-model';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import simpleUrl from '../../../../test/fixtures/simple-text.pdf?url';
import { fixtureFile } from '../../test/store-harness';
import { resetWorkspace, useWorkspaceStore } from '../state/workspace-store';
import { useToolStore } from '../viewer/tool-store';
import { createAnnotations } from './actions';
import {
  DEFAULT_STYLES,
  LEGACY_TOOL_STYLES_STORAGE_KEY,
  type PageTarget,
  parseToolStyles,
  resetAnnotationStore,
  TOOL_STYLES_STORAGE_KEY,
  useAnnotationStore,
} from './annotation-store';
import { readAnnotations, resetEditRunner, whenIdle } from './edit-runner';
import { INK, TINT } from './palette';
import { LEGACY_PEN_PRESETS_STORAGE_KEY, PEN_PRESETS_STORAGE_KEY } from './pen/presets';

const store = () => useAnnotationStore.getState();

function stored(): unknown {
  const raw = localStorage.getItem(TOOL_STYLES_STORAGE_KEY);
  return raw === null ? undefined : (JSON.parse(raw) as unknown);
}

async function openSimple(): Promise<PageTarget> {
  const report = await useWorkspaceStore
    .getState()
    .openFiles([await fixtureFile(simpleUrl, 'simple.pdf')]);
  expect(report.skipped).toEqual([]);
  const doc = getActiveDocument(useWorkspaceStore.getState().workspace);
  const first = doc?.pages[0];
  if (first?.ref.kind !== 'source') throw new Error('no source page');
  return {
    source: first.ref.source,
    pageIndex: 0,
    pageId: first.id,
    position: 1,
  };
}

const stroke = (color: string) =>
  ({
    kind: 'ink',
    pageIndex: 0,
    paths: [
      [
        { x: 100, y: 500 },
        { x: 160, y: 520 },
      ],
    ],
    rect: { x: 98, y: 498, width: 64, height: 24 },
    color,
    strokeWidth: 2,
    opacity: 1,
  }) as const;

describe('tool styles', () => {
  beforeEach(() => {
    localStorage.removeItem(TOOL_STYLES_STORAGE_KEY);
    localStorage.removeItem(PEN_PRESETS_STORAGE_KEY);
    localStorage.removeItem(LEGACY_TOOL_STYLES_STORAGE_KEY);
    localStorage.removeItem(LEGACY_PEN_PRESETS_STORAGE_KEY);
    resetWorkspace();
    resetEditRunner();
    resetAnnotationStore();
    useToolStore.getState().setMode('select');
  });
  afterEach(async () => {
    await whenIdle();
    localStorage.removeItem(TOOL_STYLES_STORAGE_KEY);
    localStorage.removeItem(PEN_PRESETS_STORAGE_KEY);
    localStorage.removeItem(LEGACY_TOOL_STYLES_STORAGE_KEY);
    localStorage.removeItem(LEGACY_PEN_PRESETS_STORAGE_KEY);
    useToolStore.getState().setMode('select');
    resetAnnotationStore();
    resetWorkspace();
  });

  it('parses stored styles field by field; anything unexpected keeps the default', () => {
    expect(parseToolStyles(undefined)).toBe(DEFAULT_STYLES);
    expect(parseToolStyles({ v: 3, styles: { ink: { color: '#000000' } } })).toBe(DEFAULT_STYLES);
    const parsed = parseToolStyles({
      v: 2,
      styles: {
        ink: { color: '#1e5bd8', strokeWidth: 99, opacity: 'x', fontSize: 12 },
        shape: { color: 'red', opacity: 0 },
        unknown: { color: '#FFFFFF' },
      },
    });
    expect(parsed.ink).toEqual({ color: '#1E5BD8', strokeWidth: 24, opacity: 1, fontSize: 12 });
    expect(parsed.shape).toEqual({ ...DEFAULT_STYLES.shape, opacity: 0.1 });
    expect(parsed.text).toEqual(DEFAULT_STYLES.text);
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(DEFAULT_STYLES).sort());
  });

  it('migrates stored version 1 styles: old defaults to the new ones, custom colours stay', () => {
    const v1 = {
      v: 1,
      styles: {
        highlight: { color: '#FFEB3B', opacity: 1, strokeWidth: 2, fontSize: 12 },
        underline: { color: '#1E88E5', opacity: 0.5, strokeWidth: 2, fontSize: 12 },
        strikeout: { color: '#E53935', opacity: 1, strokeWidth: 2, fontSize: 12 },
        squiggly: { color: '#43A047', opacity: 1, strokeWidth: 2, fontSize: 12 },
        ink: { color: '#1F1F1F', opacity: 1, strokeWidth: 1.5, fontSize: 12 },
        shape: { color: '#123456', opacity: 1, strokeWidth: 4, fontSize: 12 },
        text: { color: '#000000', opacity: 1, strokeWidth: 2, fontSize: 18 },
        note: { color: '#FB8C00', opacity: 1, strokeWidth: 2, fontSize: 12 },
      },
    };
    const parsed = parseToolStyles(v1);
    expect(parsed).toEqual({
      ...DEFAULT_STYLES,
      underline: { ...DEFAULT_STYLES.underline, opacity: 0.5 },
      shape: { ...DEFAULT_STYLES.shape, color: '#123456', strokeWidth: 4 },
      text: { ...DEFAULT_STYLES.text, fontSize: 18 },
      // A swatch colour in a highlighter role takes the nearest tint.
      note: { ...DEFAULT_STYLES.note, color: TINT.yellow },
    });
    expect(parsed.highlight.color).toBe(TINT.yellow);
    expect(parsed.underline.color).toBe(INK.blue);
    expect(parsed.text.color).toBe(INK.black);
    expect(
      parseToolStyles({ v: 1, styles: { highlight: { color: '#43A047' } } }).highlight,
    ).toEqual({ ...DEFAULT_STYLES.highlight, color: TINT.green });

    // The old key is read when no version 2 is stored; the next change writes version 2.
    localStorage.setItem(LEGACY_TOOL_STYLES_STORAGE_KEY, JSON.stringify(v1));
    resetAnnotationStore();
    expect(store().styles.shape).toEqual({
      ...DEFAULT_STYLES.shape,
      color: '#123456',
      strokeWidth: 4,
    });
    expect(store().styles.squiggly.color).toBe(INK.green);
    store().setStyle('shape', { strokeWidth: 5 });
    expect(stored()).toMatchObject({
      v: 2,
      styles: { shape: { color: '#123456', strokeWidth: 5 }, squiggly: { color: INK.green } },
    });
    resetAnnotationStore();
    expect(store().styles.shape.strokeWidth).toBe(5);
  });

  it('a fresh install has the palette defaults and stores nothing', () => {
    expect(TOOL_STYLES_STORAGE_KEY).toBe('pdf-editor:ui:tool-styles:v2');
    expect(store().styles).toEqual(DEFAULT_STYLES);
    expect(stored()).toBeUndefined();
  });

  it('setStyle persists the tool style, and a reset (reload) reads it back', () => {
    store().setStyle('ink', { color: INK.purple.toLowerCase(), strokeWidth: 3.5 });
    expect(store().styles.ink).toMatchObject({ color: INK.purple, strokeWidth: 3.5 });
    expect(stored()).toMatchObject({ v: 2, styles: { ink: { color: INK.purple } } });

    useAnnotationStore.setState({ styles: DEFAULT_STYLES });
    resetAnnotationStore();
    expect(store().styles.ink).toEqual({
      ...DEFAULT_STYLES.ink,
      color: INK.purple,
      strokeWidth: 3.5,
    });
    // Other groups keep their defaults.
    expect(store().styles.highlight).toEqual(DEFAULT_STYLES.highlight);
  });

  it('applyStyle without a selection changes the armed tool, and nothing with Select', () => {
    store().applyStyle({ color: INK.green });
    expect(store().styles).toEqual(DEFAULT_STYLES);
    expect(stored()).toBeUndefined();

    useToolStore.getState().setMode('ink');
    store().applyStyle({ color: INK.green, opacity: 0.5 });
    expect(store().styles.ink).toMatchObject({ color: INK.green, opacity: 0.5 });
    useToolStore.getState().setMode('rectangle');
    store().applyStyle({ strokeWidth: 6 });
    expect(store().styles.shape.strokeWidth).toBe(6);
    expect(store().styles.ink.strokeWidth).toBe(DEFAULT_STYLES.ink.strokeWidth);
  });

  it('creating does not select; applyStyle with a selection edits it, not the tool', async () => {
    const target = await openSimple();
    useToolStore.getState().setMode('ink');
    const created = await createAnnotations(target, [stroke(INK.red)]);
    const id = created?.[0]?.id;
    if (!id) throw new Error('not created');
    expect(store().selection).toBeNull();

    // An explicit selection wins over the armed tool.
    store().select({ ...target, ids: [id] });
    store().applyStyle({ color: INK.blue });
    await whenIdle();
    const after = (await readAnnotations(target.source, 0)).find((a) => a.id === id);
    expect(after?.kind === 'ink' ? after.color?.toUpperCase() : undefined).toBe(INK.blue);
    expect(store().styles.ink).toEqual(DEFAULT_STYLES.ink);
    expect(stored()).toBeUndefined();
  });

  it('createAnnotations selects only when asked', async () => {
    const target = await openSimple();
    const created = await createAnnotations(target, [stroke('#000000')], { select: true });
    expect(store().selection?.ids).toEqual(created?.map((a) => a.id));
  });
});
