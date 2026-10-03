/**
 * The pen on a mounted annotation layer (experience-redesign spec §6.6, §11), with real
 * PDFium: a 200-point pen stroke with pressure rising from 0.2 to 1.0 commits one Ink whose
 * per-point widths rise along the stroke, without re-rendering the layer per move; undo and
 * redo work as for any annotation.
 */
import '../../styles/tokens.css';
import '../../styles/reset.css';
import '../../styles/global.css';
import '../index';

import {
  type EngineEdit,
  getActiveDocument,
  pageTotalRotation,
  type SourceId,
  type VirtualDocument,
} from '@pdf-editor/document-model';
import { cleanup, render, waitFor } from '@testing-library/react';
import { Profiler } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';

import simpleUrl from '../../../../../test/fixtures/simple-text.pdf?url';
import { enterEditMode, fixtureFile } from '../../../test/store-harness';
import { displaySize } from '../../pages/page-geometry';
import { useEditPolicyStore } from '../../state/edit-policy-store';
import { resetWorkspace, useWorkspaceStore } from '../../state/workspace-store';
import { useToolStore } from '../../viewer/tool-store';
import { AnnotationLayer } from '../AnnotationLayer';
import {
  resetAnnotationStore,
  TOOL_STYLES_STORAGE_KEY,
  useAnnotationStore,
} from '../annotation-store';
import { readAnnotations, resetEditRunner, whenIdle } from '../edit-runner';
import { resetPenSession, widthFromPressure } from './ink-input';
import { PEN_PRESETS_STORAGE_KEY } from './presets';

const model = () => useWorkspaceStore.getState();

interface Mounted {
  readonly layer: HTMLElement;
  readonly source: SourceId;
  readonly renders: { count: number };
}

async function mountLayer(): Promise<Mounted> {
  const report = await model().openFiles([await fixtureFile(simpleUrl, 'simple.pdf')]);
  enterEditMode();
  expect(report.skipped).toEqual([]);
  const ws = model().workspace;
  const doc = getActiveDocument(ws) as VirtualDocument;
  const first = doc.pages[0];
  if (first?.ref.kind !== 'source') throw new Error('no source page');
  const sizePt = displaySize(ws, first);
  const renders = { count: 0 };
  const style = document.createElement('style');
  style.textContent = '[data-test-page] > * { position: absolute; inset: 0; }';
  document.head.appendChild(style);
  render(
    <div
      data-test-page=""
      style={{ position: 'relative', width: sizePt.width, height: sizePt.height }}
    >
      <Profiler
        id="annotation-layer"
        onRender={() => {
          renders.count++;
        }}
      >
        <AnnotationLayer
          page={first}
          pageId={first.id}
          pageIndex={0}
          sourceId={first.ref.source}
          sourceIndex={0}
          sizePt={sizePt}
          cssScale={1}
          rotation={pageTotalRotation(ws, first)}
          visible
        />
      </Profiler>
    </div>,
  );
  const layer = await waitFor(() => {
    const l = document.querySelector<HTMLElement>('[data-annotation-layer="0"]');
    if (!l) throw new Error('no annotation layer');
    return l;
  });
  return { layer, source: first.ref.source, renders };
}

function pen(type: string, x: number, y: number, pressure: number): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: type === 'pointermove' ? -1 : 0,
    buttons: type === 'pointerup' ? 0 : 1,
    pointerId: 9,
    pointerType: 'pen',
    isPrimary: true,
    pressure,
  });
}

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

function lastCreate(): EngineEdit | undefined {
  return model()
    .workspace.engineEdits.filter((e) => e.kind === 'annotation.create')
    .at(-1);
}

describe('pen on the annotation layer', () => {
  beforeEach(async () => {
    await page.viewport(1280, 900);
    localStorage.removeItem(TOOL_STYLES_STORAGE_KEY);
    localStorage.removeItem(PEN_PRESETS_STORAGE_KEY);
    resetWorkspace();
    resetEditRunner();
    resetAnnotationStore();
    resetPenSession();
  });
  afterEach(async () => {
    await whenIdle();
    cleanup();
    useToolStore.getState().setMode('select');
    localStorage.removeItem(TOOL_STYLES_STORAGE_KEY);
    localStorage.removeItem(PEN_PRESETS_STORAGE_KEY);
    resetAnnotationStore();
    resetWorkspace();
    resetPenSession();
  });

  it('a 200-point pen stroke commits one Ink with rising widths and few renders', async () => {
    const { layer, source, renders } = await mountLayer();
    useToolStore.getState().setMode('ink');
    await waitFor(() => expect(layer).toHaveAttribute('data-tool', 'ink'));
    // The page's annotations have loaded: the layer is at rest.
    await waitFor(() => expect(useAnnotationStore.getState().pages).not.toEqual({}));
    await whenIdle();
    await frame();
    await frame();
    const nominal = useAnnotationStore.getState().styles.ink.strokeWidth;

    const box = layer.getBoundingClientRect();
    const x0 = box.left + box.width * 0.15;
    const x1 = box.left + box.width * 0.75;
    const y0 = box.top + box.height * 0.4;
    const before = renders.count;
    layer.dispatchEvent(pen('pointerdown', x0, y0, 0.2));
    const moves = 200;
    for (let i = 1; i <= moves; i++) {
      const t = i / moves;
      // A gentle wave so the centre line keeps a few points after simplification.
      const y = y0 + Math.sin(t * Math.PI * 2) * 12;
      layer.dispatchEvent(pen('pointermove', x0 + (x1 - x0) * t, y, 0.2 + 0.8 * t));
      if (i % 10 === 0) await frame();
    }
    const live = layer.querySelector<HTMLCanvasElement>('canvas[data-ink-preview="live"]');
    expect(live).not.toBeNull();
    const duringStroke = renders.count - before;
    layer.dispatchEvent(pen('pointerup', x1, y0, 0));
    // The stroke settles on its own canvas until the page shows it.
    expect(layer.querySelector('[data-testid="annotation-preview"][data-settling]')).not.toBeNull();

    await waitFor(async () => {
      const inks = (await readAnnotations(source, 0)).filter((a) => a.kind === 'ink');
      expect(inks).toHaveLength(1);
    });
    await waitFor(() =>
      expect(layer.querySelectorAll('[data-annotation-kind="ink"]')).toHaveLength(1),
    );
    const total = renders.count - before;
    expect(duringStroke).toBe(0);
    expect(total).toBeLessThanOrEqual(3);
    // Not selected (spec §6.1).
    expect(useAnnotationStore.getState().selection).toBeNull();

    // The history payload carries the widths, point for point, rising along the stroke.
    const created = lastCreate()?.payload as {
      annotation: { paths: { x: number; y: number }[][]; widths?: number[][]; strokeWidth: number };
    };
    const path = created.annotation.paths[0] ?? [];
    const widths = created.annotation.widths?.[0] ?? [];
    expect(created.annotation.strokeWidth).toBe(nominal);
    expect(widths).toHaveLength(path.length);
    expect(path.length).toBeGreaterThan(3);
    expect(widths[0]).toBeCloseTo(widthFromPressure(nominal, 0.2), 1);
    expect(widths.at(-1)).toBeCloseTo(widthFromPressure(nominal, 1), 1);
    for (let i = 1; i < widths.length; i++) {
      expect(widths[i]).toBeGreaterThanOrEqual((widths[i - 1] ?? 0) - 0.01);
    }
    expect(widths.at(-1) ?? 0).toBeGreaterThan((widths[0] ?? 0) * 1.8);

    // The preview goes once the page has painted (here: the paint timeout, no canvas).
    await waitFor(() => expect(layer.querySelector('[data-settling]')).toBeNull(), {
      timeout: 5_000,
    });

    // Undo and redo as for any annotation.
    model().undo();
    await whenIdle();
    expect((await readAnnotations(source, 0)).some((a) => a.kind === 'ink')).toBe(false);
    model().redo();
    await whenIdle();
    expect((await readAnnotations(source, 0)).filter((a) => a.kind === 'ink')).toHaveLength(1);
  });

  it('disarming the pen removes the live canvas and its handlers', async () => {
    const { layer, source } = await mountLayer();
    useToolStore.getState().setMode('ink');
    await waitFor(() => expect(layer).toHaveAttribute('data-tool', 'ink'));
    const box = layer.getBoundingClientRect();
    layer.dispatchEvent(pen('pointerdown', box.left + 50, box.top + 50, 0.5));
    layer.dispatchEvent(pen('pointerup', box.left + 50, box.top + 50, 0));
    await waitFor(async () =>
      expect((await readAnnotations(source, 0)).filter((a) => a.kind === 'ink')).toHaveLength(1),
    );
    // "Pen draws in Edit" off (the pen just seen turned it on): the pen in Select only points.
    useEditPolicyStore.getState().setPenDrawsInEdit(false);
    useToolStore.getState().setMode('select');
    await waitFor(() => expect(layer).toHaveAttribute('data-tool', 'select'));
    expect(layer.querySelector('canvas[data-ink-preview="live"]')).toBeNull();
    layer.dispatchEvent(pen('pointerdown', box.left + 80, box.top + 80, 0.5));
    layer.dispatchEvent(pen('pointermove', box.left + 180, box.top + 80, 0.5));
    layer.dispatchEvent(pen('pointerup', box.left + 180, box.top + 80, 0));
    await whenIdle();
    expect((await readAnnotations(source, 0)).filter((a) => a.kind === 'ink')).toHaveLength(1);
  });
});
