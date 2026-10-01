/**
 * Pen bursts on a mounted annotation layer with real PDFium (experience-redesign spec §6.4,
 * §11): three quick strokes are one Ink with three paths and one history entry (one undo
 * step); a stroke after N + 200 ms is a second annotation; the eraser removes one path of a
 * burst, keeps the rest as one annotation with its widths parallel, and deletes the
 * annotation with its last path.
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
import type { InkAnnotation } from '@pdf-editor/engine';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';

import simpleUrl from '../../../../../test/fixtures/simple-text.pdf?url';
import { fixtureFile } from '../../../test/store-harness';
import { displaySize } from '../../pages/page-geometry';
import { resetWorkspace, useWorkspaceStore } from '../../state/workspace-store';
import { useToolStore } from '../../viewer/tool-store';
import { AnnotationLayer } from '../AnnotationLayer';
import {
  resetAnnotationStore,
  TOOL_STYLES_STORAGE_KEY,
  useAnnotationStore,
} from '../annotation-store';
import { readAnnotations, resetEditRunner, whenIdle } from '../edit-runner';
import { INK_BURST_PAUSE_MS, resetBursts } from './bursts';
import { resetPenSession } from './ink-input';
import { PEN_PRESETS_STORAGE_KEY } from './presets';

const model = () => useWorkspaceStore.getState();

async function mountLayer(): Promise<{ layer: HTMLElement; source: SourceId }> {
  const report = await model().openFiles([await fixtureFile(simpleUrl, 'simple.pdf')]);
  expect(report.skipped).toEqual([]);
  const ws = model().workspace;
  const doc = getActiveDocument(ws) as VirtualDocument;
  const first = doc.pages[0];
  if (first?.ref.kind !== 'source') throw new Error('no source page');
  const sizePt = displaySize(ws, first);
  const style = document.createElement('style');
  style.textContent = '[data-test-page] > * { position: absolute; inset: 0; }';
  document.head.appendChild(style);
  render(
    <div
      data-test-page=""
      style={{ position: 'relative', width: sizePt.width, height: sizePt.height }}
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
    </div>,
  );
  const layer = await waitFor(() => {
    const l = document.querySelector<HTMLElement>('[data-annotation-layer="0"]');
    if (!l) throw new Error('no annotation layer');
    return l;
  });
  return { layer, source: first.ref.source };
}

function pointer(type: string, x: number, y: number, pointerType = 'pen'): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: type === 'pointermove' ? -1 : 0,
    buttons: type === 'pointerup' ? 0 : 1,
    pointerId: pointerType === 'pen' ? 9 : 1,
    pointerType,
    isPrimary: true,
    pressure: type === 'pointerup' ? 0 : 0.5,
  });
}

/** A horizontal pen stroke on the layer from x0 to x1 at y (CSS px from the layer's corner). */
function penStroke(layer: HTMLElement, x0: number, x1: number, y: number): void {
  const box = layer.getBoundingClientRect();
  layer.dispatchEvent(pointer('pointerdown', box.left + x0, box.top + y));
  for (let i = 1; i <= 10; i++) {
    layer.dispatchEvent(pointer('pointermove', box.left + x0 + ((x1 - x0) * i) / 10, box.top + y));
  }
  layer.dispatchEvent(pointer('pointerup', box.left + x1, box.top + y));
}

/** An eraser drag (mouse) down across the layer at x, from y0 to y1. */
function eraserDrag(layer: HTMLElement, x: number, y0: number, y1: number): void {
  const box = layer.getBoundingClientRect();
  layer.dispatchEvent(pointer('pointerdown', box.left + x, box.top + y0, 'mouse'));
  for (let i = 1; i <= 6; i++) {
    window.dispatchEvent(
      pointer('pointermove', box.left + x, box.top + y0 + ((y1 - y0) * i) / 6, 'mouse'),
    );
  }
  window.dispatchEvent(pointer('pointerup', box.left + x, box.top + y1, 'mouse'));
}

async function inks(source: SourceId): Promise<InkAnnotation[]> {
  return (await readAnnotations(source, 0)).filter((a): a is InkAnnotation => a.kind === 'ink');
}

const strokesOf = (list: readonly InkAnnotation[]) => list.map((a) => a.paths.length);

function lastUpdate(): EngineEdit | undefined {
  return model()
    .workspace.engineEdits.filter((e) => e.kind === 'annotation.update')
    .at(-1);
}

describe('pen bursts on the annotation layer', () => {
  beforeEach(async () => {
    await page.viewport(1280, 900);
    localStorage.removeItem(TOOL_STYLES_STORAGE_KEY);
    localStorage.removeItem(PEN_PRESETS_STORAGE_KEY);
    resetWorkspace();
    resetEditRunner();
    resetAnnotationStore();
    resetPenSession();
    resetBursts();
  });
  afterEach(async () => {
    await whenIdle();
    cleanup();
    useToolStore.getState().setMode('select');
    resetBursts();
    localStorage.removeItem(TOOL_STYLES_STORAGE_KEY);
    localStorage.removeItem(PEN_PRESETS_STORAGE_KEY);
    resetAnnotationStore();
    resetWorkspace();
    resetPenSession();
  });

  async function armPen(layer: HTMLElement): Promise<void> {
    useToolStore.getState().setMode('ink');
    await waitFor(() => expect(layer).toHaveAttribute('data-tool', 'ink'));
    await waitFor(() => expect(useAnnotationStore.getState().pages).not.toEqual({}));
    await whenIdle();
  }

  it('three quick strokes: one Ink with three paths, one history entry, one undo', async () => {
    const { layer, source } = await mountLayer();
    await armPen(layer);
    const before = model().history.past.length;
    // A word in three strokes, 20 pt apart, back to back.
    penStroke(layer, 100, 160, 300);
    penStroke(layer, 180, 240, 300);
    penStroke(layer, 260, 320, 305);
    await waitFor(async () => expect(strokesOf(await inks(source))).toEqual([3]));
    await whenIdle();
    expect(model().history.past.length).toBe(before + 1);
    expect(model().history.present.label).toBe('Pen on page 1 · 3 strokes');
    expect(useAnnotationStore.getState().selection).toBeNull();
    await waitFor(() =>
      expect(layer.querySelectorAll('[data-annotation-kind="ink"] polyline')).toHaveLength(3),
    );

    model().undo();
    await whenIdle();
    expect(await inks(source)).toEqual([]);
  });

  it('a stroke after N + 200 ms is a second annotation', async () => {
    const { layer, source } = await mountLayer();
    await armPen(layer);
    penStroke(layer, 100, 160, 300);
    await waitFor(async () => expect(strokesOf(await inks(source))).toEqual([1]));
    await new Promise((resolve) => setTimeout(resolve, INK_BURST_PAUSE_MS + 200));
    penStroke(layer, 180, 240, 300);
    await waitFor(async () => expect(strokesOf(await inks(source))).toEqual([1, 1]));
  });

  it('the eraser removes one path of a burst; the last path takes the annotation', async () => {
    const { layer, source } = await mountLayer();
    await armPen(layer);
    penStroke(layer, 100, 160, 300);
    penStroke(layer, 180, 240, 300);
    penStroke(layer, 260, 320, 300);
    await waitFor(async () => expect(strokesOf(await inks(source))).toEqual([3]));
    await whenIdle();

    useToolStore.getState().setMode('eraser');
    await waitFor(() => expect(layer).toHaveAttribute('data-tool', 'eraser'));
    // Across the middle stroke only.
    eraserDrag(layer, 210, 285, 315);
    await waitFor(async () => expect(strokesOf(await inks(source))).toEqual([2]));
    await whenIdle();
    const [ink] = await inks(source);
    // Disjoint parts stay one annotation; the widths stay parallel to the paths.
    expect(ink?.paths.map((p) => Math.round(p[0]?.x ?? 0))).toEqual([100, 260]);
    const sent = lastUpdate()?.payload as {
      annotation: { paths: unknown[][]; widths?: number[][] };
    };
    expect(sent.annotation.paths).toHaveLength(2);
    expect(sent.annotation.widths?.map((w) => w.length)).toEqual(
      sent.annotation.paths.map((p) => p.length),
    );
    expect(model().history.present.label).toBe('Erase pen strokes');

    eraserDrag(layer, 130, 285, 315);
    await waitFor(async () => expect(strokesOf(await inks(source))).toEqual([1]));
    await whenIdle();
    eraserDrag(layer, 290, 285, 315);
    await waitFor(async () => expect(await inks(source)).toEqual([]));
  });
});
