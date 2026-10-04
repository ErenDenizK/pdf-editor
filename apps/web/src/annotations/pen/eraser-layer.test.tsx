/**
 * The eraser on screen (craft spec §5.6), Vitest browser mode with real PDFium: the eraser's
 * options tier (Whole stroke or Partial, its size, both remembered; Partial says that
 * highlighter ink and highlights erase whole), the cursor as the eraser's circle, and a
 * Partial drag on a mounted layer that cuts a pen stroke in two as one history entry.
 */
import '../../styles/tokens.css';
import '../../styles/reset.css';
import '../../styles/global.css';
import '../index';

import {
  getActiveDocument,
  pageTotalRotation,
  type SourceId,
  type VirtualDocument,
} from '@pdf-editor/document-model';
import type { InkAnnotation } from '@pdf-editor/engine';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';

import simpleUrl from '../../../../../test/fixtures/simple-text.pdf?url';
import { enterEditMode, fixtureFile } from '../../../test/store-harness';
import { displaySize } from '../../pages/page-geometry';
import { FloatingToolbar } from '../../shell/FloatingToolbar';
import { ReadView } from '../../stage/ReadView';
import { useUiStore } from '../../state/ui-store';
import { resetWorkspace, useWorkspaceStore } from '../../state/workspace-store';
import { ERASER_STORAGE_KEY, resetToolStore, useToolStore } from '../../viewer/tool-store';
import { AnnotationLayer } from '../AnnotationLayer';
import { resetAnnotationStore, TOOL_STYLES_STORAGE_KEY } from '../annotation-store';
import { readAnnotations, resetEditRunner, whenIdle } from '../edit-runner';
import { resetBursts } from './bursts';
import { registerPenBar } from './PenBar.register';
import { resetPenSession } from './ink-input';
import { PEN_PRESETS_STORAGE_KEY } from './presets';

const model = () => useWorkspaceStore.getState();

async function openDoc(): Promise<VirtualDocument> {
  const report = await model().openFiles([await fixtureFile(simpleUrl, 'simple.pdf')]);
  enterEditMode();
  expect(report.skipped).toEqual([]);
  return getActiveDocument(model().workspace) as VirtualDocument;
}

async function mountLayer(): Promise<{ layer: HTMLElement; source: SourceId }> {
  const doc = await openDoc();
  const ws = model().workspace;
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

/** A horizontal pen stroke on the layer from x0 to x1 at y (CSS px from its corner). */
function penStroke(layer: HTMLElement, x0: number, x1: number, y: number): void {
  const box = layer.getBoundingClientRect();
  layer.dispatchEvent(pointer('pointerdown', box.left + x0, box.top + y));
  for (let i = 1; i <= 12; i++) {
    layer.dispatchEvent(pointer('pointermove', box.left + x0 + ((x1 - x0) * i) / 12, box.top + y));
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

/** The SVG inside the layer's cursor. */
function cursorSvg(layer: HTMLElement): string {
  const cursor = layer.style.cursor;
  const start = cursor.indexOf('data:image/svg+xml,');
  if (start < 0) return '';
  const end = cursor.indexOf('"', start);
  return decodeURIComponent(cursor.slice(start + 'data:image/svg+xml,'.length, end));
}

describe('the eraser', () => {
  beforeEach(async () => {
    await page.viewport(1280, 900);
    localStorage.removeItem(TOOL_STYLES_STORAGE_KEY);
    localStorage.removeItem(PEN_PRESETS_STORAGE_KEY);
    localStorage.removeItem(ERASER_STORAGE_KEY);
    resetWorkspace();
    resetEditRunner();
    resetAnnotationStore();
    resetToolStore();
    resetPenSession();
    resetBursts();
  });
  afterEach(async () => {
    await whenIdle();
    cleanup();
    useToolStore.getState().setMode('select');
    localStorage.removeItem(ERASER_STORAGE_KEY);
    resetToolStore();
    resetBursts();
    resetAnnotationStore();
    resetWorkspace();
  });

  it('its options tier toggles Whole stroke and Partial and the size, remembered', async () => {
    const doc = await openDoc();
    useUiStore.setState({ viewMode: 'read' });
    const dispose = registerPenBar();
    try {
      render(
        <div
          style={{ position: 'relative', display: 'flex', flexDirection: 'column', height: 700 }}
        >
          <ReadView doc={doc} />
          <FloatingToolbar />
        </div>,
      );
      act(() => useToolStore.getState().setMode('eraser'));
      const tier = await screen.findByRole('toolbar', { name: 'Eraser options' });
      const modes = within(tier).getByRole('radiogroup', { name: 'Eraser mode' });
      const whole = within(modes).getByRole('radio', { name: 'Whole stroke' });
      const partial = within(modes).getByRole('radio', { name: 'Partial' });
      expect(whole).toHaveAttribute('aria-checked', 'true');
      expect(partial).toHaveAccessibleDescription(
        /Highlighter strokes and highlights are erased whole/,
      );
      await userEvent.click(partial);
      expect(useToolStore.getState().eraserMode).toBe('partial');
      expect(partial).toHaveAttribute('aria-checked', 'true');
      expect(whole).toHaveAttribute('aria-checked', 'false');

      const sizes = within(tier).getByRole('radiogroup', { name: 'Eraser size' });
      expect(within(sizes).getByRole('radio', { name: '12 px' })).toHaveAttribute(
        'aria-checked',
        'true',
      );
      await userEvent.click(within(sizes).getByRole('radio', { name: '24 px' }));
      expect(useToolStore.getState().eraserSize).toBe(24);

      // Remembered per device: a new session reads them back.
      expect(JSON.parse(localStorage.getItem(ERASER_STORAGE_KEY) ?? '{}')).toMatchObject({
        mode: 'partial',
        size: 24,
      });
      useToolStore.setState({ eraserMode: 'stroke', eraserSize: 12 });
      resetToolStore();
      expect(useToolStore.getState()).toMatchObject({ eraserMode: 'partial', eraserSize: 24 });
    } finally {
      dispose();
    }
  });

  it('the cursor is the eraser circle at its size', async () => {
    const { layer } = await mountLayer();
    act(() => useToolStore.getState().setMode('eraser'));
    await waitFor(() => expect(layer).toHaveAttribute('data-tool', 'eraser'));
    expect(cursorSvg(layer)).toContain('r="6"');
    expect(layer.style.cursor).toMatch(/, cell$/);
    act(() => useToolStore.getState().setEraserSize(48));
    await waitFor(() => expect(cursorSvg(layer)).toContain('r="24"'));
    // Only the eraser draws its circle.
    act(() => useToolStore.getState().setMode('ink'));
    await waitFor(() => expect(layer.style.cursor).toBe(''));
  });

  it('a Partial drag through the middle of a stroke leaves two pieces, one entry', async () => {
    const { layer, source } = await mountLayer();
    act(() => useToolStore.getState().setMode('ink'));
    await waitFor(() => expect(layer).toHaveAttribute('data-tool', 'ink'));
    await whenIdle();
    penStroke(layer, 100, 300, 300);
    await waitFor(async () => expect((await inks(source)).length).toBe(1));
    await whenIdle();
    const before = model().history.past.length;

    act(() => {
      useToolStore.getState().setEraserMode('partial');
      useToolStore.getState().setMode('eraser');
    });
    await waitFor(() => expect(layer).toHaveAttribute('data-tool', 'eraser'));
    eraserDrag(layer, 200, 280, 320);
    await waitFor(async () => expect((await inks(source))[0]?.paths).toHaveLength(2));
    await whenIdle();
    expect(model().history.past.length).toBe(before + 1);
    expect(model().history.present.label).toBe('Erase pen strokes');
    const [ink] = await inks(source);
    const [left, right] = ink?.paths ?? [];
    // 12 px eraser at 100 %: 6 pt of reach plus half the stroke's width either side.
    expect(left?.at(-1)?.x).toBeLessThan(195);
    expect(left?.at(-1)?.x).toBeGreaterThan(190);
    expect(right?.[0]?.x).toBeGreaterThan(205);
    expect(right?.[0]?.x).toBeLessThan(210);
    expect(ink?.widths?.map((w) => w.length)).toEqual(ink?.paths.map((p) => p.length));

    model().undo();
    await whenIdle();
    expect((await inks(source))[0]?.paths).toHaveLength(1);
  });
});
