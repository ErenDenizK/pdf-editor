/**
 * One style rule (experience-redesign spec §6.3, P1): `applyStyle` edits the selection when
 * there is one, else the armed tool's style; tool styles persist per device and survive a
 * store reset (a reload); creating never selects (§6.1). Vitest browser mode, real PDFium.
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
  type PageTarget,
  parseToolStyles,
  resetAnnotationStore,
  TOOL_STYLES_STORAGE_KEY,
  useAnnotationStore,
} from './annotation-store';
import { PEN_PRESETS_STORAGE_KEY } from './pen/presets';
import { readAnnotations, resetEditRunner, whenIdle } from './edit-runner';

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
    resetWorkspace();
    resetEditRunner();
    resetAnnotationStore();
    useToolStore.getState().setMode('select');
  });
  afterEach(async () => {
    await whenIdle();
    localStorage.removeItem(TOOL_STYLES_STORAGE_KEY);
    localStorage.removeItem(PEN_PRESETS_STORAGE_KEY);
    useToolStore.getState().setMode('select');
    resetAnnotationStore();
    resetWorkspace();
  });

  it('parses stored styles field by field; anything unexpected keeps the default', () => {
    expect(parseToolStyles(undefined)).toBe(DEFAULT_STYLES);
    expect(parseToolStyles({ v: 2, styles: { ink: { color: '#000000' } } })).toBe(DEFAULT_STYLES);
    const parsed = parseToolStyles({
      v: 1,
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

  it('setStyle persists the tool style, and a reset (reload) reads it back', () => {
    store().setStyle('ink', { color: '#1e88e5', strokeWidth: 3.5 });
    expect(store().styles.ink).toMatchObject({ color: '#1E88E5', strokeWidth: 3.5 });
    expect(stored()).toMatchObject({ v: 1, styles: { ink: { color: '#1E88E5' } } });

    useAnnotationStore.setState({ styles: DEFAULT_STYLES });
    resetAnnotationStore();
    expect(store().styles.ink).toEqual({
      ...DEFAULT_STYLES.ink,
      color: '#1E88E5',
      strokeWidth: 3.5,
    });
    // Other groups keep their defaults.
    expect(store().styles.highlight).toEqual(DEFAULT_STYLES.highlight);
  });

  it('applyStyle without a selection changes the armed tool, and nothing with Select', () => {
    store().applyStyle({ color: '#43A047' });
    expect(store().styles).toEqual(DEFAULT_STYLES);
    expect(stored()).toBeUndefined();

    useToolStore.getState().setMode('ink');
    store().applyStyle({ color: '#43A047', opacity: 0.5 });
    expect(store().styles.ink).toMatchObject({ color: '#43A047', opacity: 0.5 });
    useToolStore.getState().setMode('rectangle');
    store().applyStyle({ strokeWidth: 6 });
    expect(store().styles.shape.strokeWidth).toBe(6);
    expect(store().styles.ink.strokeWidth).toBe(DEFAULT_STYLES.ink.strokeWidth);
  });

  it('creating does not select; applyStyle with a selection edits it, not the tool', async () => {
    const target = await openSimple();
    useToolStore.getState().setMode('ink');
    const created = await createAnnotations(target, [stroke('#E53935')]);
    const id = created?.[0]?.id;
    if (!id) throw new Error('not created');
    expect(store().selection).toBeNull();

    // An explicit selection wins over the armed tool.
    store().select({ ...target, ids: [id] });
    store().applyStyle({ color: '#1E88E5' });
    await whenIdle();
    const after = (await readAnnotations(target.source, 0)).find((a) => a.id === id);
    expect(after?.kind === 'ink' ? after.color?.toUpperCase() : undefined).toBe('#1E88E5');
    expect(store().styles.ink).toEqual(DEFAULT_STYLES.ink);
    expect(stored()).toBeUndefined();
  });

  it('createAnnotations selects only when asked', async () => {
    const target = await openSimple();
    const created = await createAnnotations(target, [stroke('#000000')], { select: true });
    expect(store().selection?.ids).toEqual(created?.map((a) => a.id));
  });
});
