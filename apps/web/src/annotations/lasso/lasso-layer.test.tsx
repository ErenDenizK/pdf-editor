/**
 * The lasso on a mounted annotation layer (craft spec §5.5, experience-redesign spec §6.5,
 * §11), with real PDFium: a lasso around two of three strokes selects their paths and shows
 * the bar above them; recolouring changes those two only. A lasso around one path of a
 * three-path Ink acts on that path alone: Delete leaves a two-path Ink and one undo restores
 * it; a recolour splits the Ink in one history entry; a drag moves the path, arrows nudge
 * it, Esc clears the selection and keeps the Lasso armed. A lasso around strokes, an arrow
 * and a note takes all of them, the bar names the mix, and a recolour is one entry; a lasso
 * around a note alone shows the width disabled.
 */
import '../../styles/tokens.css';
import '../../styles/reset.css';
import '../../styles/global.css';
import '../index';

import {
  getActiveDocument,
  historyEntries,
  pageTotalRotation,
  type SourceId,
  type VirtualDocument,
} from '@pdf-editor/document-model';
import type { InkAnnotation, NewAnnotation } from '@pdf-editor/engine';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';

import simpleUrl from '../../../../../test/fixtures/simple-text.pdf?url';
import { enterEditMode, fixtureFile } from '../../../test/store-harness';
import { displaySize } from '../../pages/page-geometry';
import { resetWorkspace, useWorkspaceStore } from '../../state/workspace-store';
import { useAnnouncer } from '../../shell/announcer';
import { useToolStore } from '../../viewer/tool-store';
import { createAnnotations } from '../actions';
import { AnnotationLayer } from '../AnnotationLayer';
import {
  activePathSelection,
  type PageTarget,
  resetAnnotationStore,
  TOOL_STYLES_STORAGE_KEY,
  useAnnotationStore,
} from '../annotation-store';
import { markupDraft } from '../drafts';
import { readAnnotations, resetEditRunner, whenIdle } from '../edit-runner';
import { userToCss } from '../geometry';
import type { Point } from '../ink';
import { mountedLayers } from '../layer-registry';
import { INK } from '../palette';
import { resetLassoEdits } from './edits';

const model = () => useWorkspaceStore.getState();

interface Mounted {
  readonly layer: HTMLElement;
  readonly source: SourceId;
  readonly target: PageTarget;
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
  await waitFor(() => expect(useAnnotationStore.getState().pages).not.toEqual({}));
  const target: PageTarget = {
    source: first.ref.source,
    pageIndex: 0,
    pageId: first.id,
    position: 1,
  };
  return { layer, source: first.ref.source, target };
}

/** A horizontal stroke at user y, from x to x + 60, with widths parallel to its points. */
function stroke(x: number, y: number): { path: Point[]; widths: number[] } {
  const path = [0, 15, 30, 45, 60].map((dx, i) => ({ x: x + dx, y: y + (i % 2) * 2 }));
  return { path, widths: path.map((_, i) => 1.5 + i * 0.25) };
}

function inkDraft(strokes: { path: Point[]; widths: number[] }[]): NewAnnotation {
  return {
    kind: 'ink',
    pageIndex: 0,
    rect: { x: 0, y: 0, width: 1, height: 1 },
    color: '#1F1F1F',
    opacity: 1,
    strokeWidth: 1.5,
    paths: strokes.map((s) => s.path),
    widths: strokes.map((s) => s.widths),
  };
}

async function inks(source: SourceId): Promise<InkAnnotation[]> {
  return (await readAnnotations(source, 0)).filter((a): a is InkAnnotation => a.kind === 'ink');
}

function mouse(type: string, x: number, y: number, init: PointerEventInit = {}): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: type === 'pointermove' ? -1 : 0,
    buttons: type === 'pointerup' ? 0 : 1,
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
    ...init,
  });
}

/** Draws a lasso: a rectangle (user space corners) traced as a closed freehand path. */
function lasso(layer: HTMLElement, from: Point, to: Point): void {
  const frame = mountedLayers.get(layerPage(layer))?.frame;
  if (!frame) throw new Error('layer not registered');
  const box = layer.getBoundingClientRect();
  const corners = [from, { x: to.x, y: from.y }, to, { x: from.x, y: to.y }, from].map((p) => {
    const c = userToCss(frame, p);
    return { x: box.left + c.x, y: box.top + c.y };
  });
  const start = corners[0] as Point;
  layer.dispatchEvent(mouse('pointerdown', start.x, start.y));
  for (let i = 1; i < corners.length; i++) {
    const a = corners[i - 1] as Point;
    const b = corners[i] as Point;
    for (let t = 1; t <= 8; t++) {
      layer.dispatchEvent(
        mouse('pointermove', a.x + ((b.x - a.x) * t) / 8, a.y + ((b.y - a.y) * t) / 8),
      );
    }
  }
  layer.dispatchEvent(mouse('pointerup', start.x, start.y));
}

function layerPage(layer: HTMLElement) {
  for (const [pageId, entry] of mountedLayers) if (entry.element === layer) return pageId;
  throw new Error('layer not registered');
}

function labels(): string[] {
  return historyEntries(model().history).map((e) => e.label);
}

function key(key: string, init: KeyboardEventInit = {}): void {
  document.body.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
  );
}

async function armLasso(layer: HTMLElement): Promise<void> {
  useToolStore.getState().setMode('lasso');
  await waitFor(() => expect(layer).toHaveAttribute('data-tool', 'lasso'));
}

/** Waits until the page cache shows `count` inks (after an edit's reload). */
async function cachedInks(count: number): Promise<void> {
  await waitFor(() => {
    const pages = Object.values(useAnnotationStore.getState().pages);
    expect(pages.flatMap((p) => p.annotations).filter((a) => a.kind === 'ink')).toHaveLength(count);
  });
}

describe('lasso on the annotation layer', () => {
  beforeEach(async () => {
    await page.viewport(1280, 900);
    localStorage.removeItem(TOOL_STYLES_STORAGE_KEY);
    resetWorkspace();
    resetEditRunner();
    resetAnnotationStore();
    resetLassoEdits();
  });
  afterEach(async () => {
    await whenIdle();
    cleanup();
    useToolStore.getState().setMode('select');
    resetAnnotationStore();
    resetWorkspace();
  });

  it('a lasso around two of three strokes recolours those two only', async () => {
    const { layer, source, target } = await mountLayer();
    for (const y of [600, 560, 400]) await createAnnotations(target, [inkDraft([stroke(100, y)])]);
    await cachedInks(3);
    const [low, mid, high] = (await inks(source)).sort(
      (a, b) => (a.paths[0]?.[0]?.y ?? 0) - (b.paths[0]?.[0]?.y ?? 0),
    );
    if (!low || !mid || !high) throw new Error('inks missing');
    const before = labels().length;

    await armLasso(layer);
    lasso(layer, { x: 80, y: 620 }, { x: 180, y: 540 });
    await waitFor(() => expect(layer.querySelectorAll('[data-lasso-path]')).toHaveLength(2));
    const selection = activePathSelection(useAnnotationStore.getState());
    expect(selection?.paths).toEqual({ [mid.id]: [0], [high.id]: [0] });
    const bar = await waitFor(() => {
      const b = layer.querySelector<HTMLElement>('[data-lasso-bar]');
      if (!b) throw new Error('no bar');
      return b;
    });
    expect(bar).toHaveTextContent('2 strokes');
    expect(useAnnouncer.getState().message).toBe('2 strokes selected');

    bar.querySelector<HTMLButtonElement>('button[aria-label="Red"]')?.click();
    await whenIdle();
    const after = await inks(source);
    const colour = (id: string) => after.find((a) => a.id === id)?.color?.toUpperCase();
    expect(colour(mid.id)).toBe(INK.red);
    expect(colour(high.id)).toBe(INK.red);
    expect(colour(low.id)).toBe('#1F1F1F');
    expect(labels()).toHaveLength(before + 1);
    expect(labels().at(-1)).toBe('Recolor 2 strokes');
    // Whole inks are edited in place: the selection still holds them.
    expect(activePathSelection(useAnnotationStore.getState())?.paths).toEqual({
      [mid.id]: [0],
      [high.id]: [0],
    });
  });

  it('one path of a three-path ink: Delete leaves two paths, one undo restores three', async () => {
    const { layer, source, target } = await mountLayer();
    await createAnnotations(target, [
      inkDraft([stroke(100, 600), stroke(100, 560), stroke(100, 520)]),
    ]);
    await cachedInks(1);
    const [ink] = await inks(source);
    if (!ink) throw new Error('no ink');
    const before = labels().length;

    await armLasso(layer);
    lasso(layer, { x: 80, y: 575 }, { x: 180, y: 545 });
    await waitFor(() => expect(layer.querySelectorAll('[data-lasso-path]')).toHaveLength(1));
    expect(activePathSelection(useAnnotationStore.getState())?.paths).toEqual({ [ink.id]: [1] });

    key('Delete');
    await whenIdle();
    const left = await inks(source);
    expect(left).toHaveLength(1);
    expect(left[0]?.id).toBe(ink.id);
    expect(left[0]?.paths.map((p) => p[0]?.y)).toEqual([600, 520]);
    const sent = model().workspace.engineEdits.at(-1)?.payload as {
      annotation: { paths: unknown[][]; widths?: unknown[][] };
    };
    expect(sent.annotation.widths?.map((w) => w.length)).toEqual(
      sent.annotation.paths.map((p) => p.length),
    );
    expect(labels()).toHaveLength(before + 1);
    expect(labels().at(-1)).toBe('Delete 1 stroke');
    expect(useAnnotationStore.getState().selection).toBeNull();
    expect(useToolStore.getState().mode).toBe('lasso');

    model().undo();
    await whenIdle();
    const restored = await inks(source);
    expect(restored).toHaveLength(1);
    expect(restored[0]?.paths).toHaveLength(3);
  });

  it('recolouring one path of a burst splits it in one history entry', async () => {
    const { layer, source, target } = await mountLayer();
    await createAnnotations(target, [
      inkDraft([stroke(100, 600), stroke(100, 560), stroke(100, 520)]),
    ]);
    await cachedInks(1);
    const [ink] = await inks(source);
    if (!ink) throw new Error('no ink');
    const before = labels().length;

    await armLasso(layer);
    lasso(layer, { x: 80, y: 575 }, { x: 180, y: 545 });
    const bar = await waitFor(() => {
      const b = layer.querySelector<HTMLElement>('[data-lasso-bar]');
      if (!b) throw new Error('no bar');
      return b;
    });
    bar.querySelector<HTMLButtonElement>('button[aria-label="Blue"]')?.click();
    await whenIdle();
    const after = await inks(source);
    expect(after).toHaveLength(2);
    const rest = after.find((a) => a.id === ink.id);
    const taken = after.find((a) => a.id !== ink.id);
    expect(rest?.paths.map((p) => p[0]?.y)).toEqual([600, 520]);
    expect(rest?.color?.toUpperCase()).toBe('#1F1F1F');
    expect(taken?.paths.map((p) => p[0]?.y)).toEqual([560]);
    expect(taken?.color?.toUpperCase()).toBe(INK.blue);
    expect(labels()).toHaveLength(before + 1);
    expect(labels().at(-1)).toBe('Recolor 1 stroke');
    // The selection follows the taken path to its new ink.
    await cachedInks(2);
    expect(activePathSelection(useAnnotationStore.getState())?.paths).toEqual({
      [taken?.id ?? '']: [0],
    });

    model().undo();
    await whenIdle();
    const undone = await inks(source);
    expect(undone).toHaveLength(1);
    expect(undone[0]?.paths).toHaveLength(3);
    expect(undone[0]?.color?.toUpperCase()).toBe('#1F1F1F');
  });

  it('drag moves the taken path, arrows nudge it, Esc clears and keeps the Lasso', async () => {
    const { layer, source, target } = await mountLayer();
    await createAnnotations(target, [inkDraft([stroke(100, 600), stroke(100, 500)])]);
    await cachedInks(1);
    const [ink] = await inks(source);
    if (!ink) throw new Error('no ink');

    await armLasso(layer);
    lasso(layer, { x: 80, y: 615 }, { x: 180, y: 585 });
    await waitFor(() => expect(layer.querySelectorAll('[data-lasso-path]')).toHaveLength(1));
    const frame = mountedLayers.get(target.pageId)?.frame;
    if (!frame) throw new Error('no frame');
    const box = layer.getBoundingClientRect();
    const grab = userToCss(frame, { x: 130, y: 601 });
    const x = box.left + grab.x;
    const y = box.top + grab.y;
    // The press lands on the selection's grab area, as a real press would.
    const under = document.elementFromPoint(x, y);
    expect(under).toHaveAttribute('data-lasso-grab');
    under?.dispatchEvent(mouse('pointerdown', x, y));
    for (let i = 1; i <= 5; i++) layer.dispatchEvent(mouse('pointermove', x + 4 * i, y + 2 * i));
    expect(layer.querySelector('[data-lasso-selection]')).toHaveAttribute(
      'transform',
      'translate(20 10)',
    );
    layer.dispatchEvent(mouse('pointerup', x + 20, y + 10));
    await whenIdle();
    let all = await inks(source);
    expect(all).toHaveLength(2);
    const moved = all.find((a) => a.id !== ink.id);
    // 20 CSS px right and 10 down at scale 1: +20, −10 in user space; widths unchanged.
    expect(moved?.paths[0]?.[0]).toEqual({ x: 120, y: 590 });
    const sent = model()
      .workspace.engineEdits.filter((e) => e.kind === 'annotation.create')
      .at(-1)?.payload as { annotation: { widths?: number[][] } };
    expect(sent.annotation.widths).toEqual([stroke(100, 600).widths]);
    expect(labels().at(-1)).toBe('Move 1 stroke');

    // The selection is the moved path: arrows nudge it by 1 pt, Shift by 10.
    await cachedInks(2);
    key('ArrowRight');
    await whenIdle();
    key('ArrowUp', { shiftKey: true });
    await whenIdle();
    all = await inks(source);
    expect(all.find((a) => a.id === moved?.id)?.paths[0]?.[0]).toEqual({ x: 121, y: 600 });
    expect(all.find((a) => a.id === ink.id)?.paths[0]?.[0]).toEqual({ x: 100, y: 500 });

    key('Escape');
    expect(useAnnotationStore.getState().selection).toBeNull();
    expect(useToolStore.getState().mode).toBe('lasso');
    await waitFor(() => expect(layer.querySelector('[data-lasso-bar]')).toBeNull());
  });

  it('Multiply ink and Highlights show an outline, never a tint; widths read to 0.1 pt', async () => {
    const { layer, target } = await mountLayer();
    await createAnnotations(target, [inkDraft([stroke(100, 600)])]);
    const free = stroke(100, 570);
    await createAnnotations(target, [
      {
        kind: 'ink',
        pageIndex: 0,
        rect: { x: 0, y: 0, width: 1, height: 1 },
        color: '#FFE500',
        opacity: 1,
        strokeWidth: 12,
        paths: [free.path],
        blendMode: 'multiply',
      },
    ]);
    await createAnnotations(target, [
      markupDraft('highlight', 0, [{ x: 100, y: 530, width: 60, height: 12 }], '#FFE500', 1),
    ]);
    await cachedInks(2);
    // The lasso picks its selection once, on release, from the store: the highlight must be
    // listed there too before the loop is drawn, or the selection misses it for good.
    await waitFor(() => {
      const pages = Object.values(useAnnotationStore.getState().pages);
      expect(
        pages.flatMap((p) => p.annotations).filter((a) => a.kind === 'highlight'),
      ).toHaveLength(1);
    });

    await armLasso(layer);
    lasso(layer, { x: 80, y: 620 }, { x: 190, y: 520 });
    await waitFor(() => expect(layer.querySelectorAll('[data-lasso-path]')).toHaveLength(2));
    // The pen stroke is traced in the accent's highlight alpha as before; the Multiply one
    // gets an accent ring cut out around its own width by a mask, and the highlight an
    // unfilled accent outline.
    await waitFor(() => expect(layer.querySelectorAll('[data-lasso-outlined]')).toHaveLength(2));
    const ring = layer.querySelector<SVGPolylineElement>(
      '[data-lasso-outlined] polyline[data-lasso-path]',
    );
    if (!ring) throw new Error('no outlined path');
    const mask = ring.getAttribute('mask') ?? '';
    expect(mask).toMatch(/^url\(#.+\)$/);
    const id = mask.slice(5, -1);
    expect(layer.querySelector(`mask[id="${id}"]`)?.querySelectorAll('polyline')).toHaveLength(2);
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    const probe = document.createElement('span');
    probe.style.color = accent;
    document.body.append(probe);
    const accentRgb = getComputedStyle(probe).color;
    probe.remove();
    expect(getComputedStyle(ring).stroke).toBe(accentRgb);
    const area = layer.querySelector<SVGPolygonElement>('polygon[data-lasso-outlined]');
    if (!area) throw new Error('no outlined highlight');
    expect(getComputedStyle(area).fill).toBe('none');
    expect(getComputedStyle(area).stroke).toBe(accentRgb);
    // The handles are there to resize and turn it.
    expect(layer.querySelectorAll('[data-lasso-handle]').length).toBeGreaterThan(0);

    // A width read back from the file as a float shows rounded to 0.1 pt.
    useAnnotationStore.getState().applyStyle({ strokeWidth: 1.3 });
    await whenIdle();
    const bar = await waitFor(() => {
      const b = layer.querySelector<HTMLElement>('[data-lasso-bar]');
      if (!b) throw new Error('no bar');
      return b;
    });
    await new Promise((r) => setTimeout(r, 1200));
    await waitFor(() => expect(bar.textContent).toContain('1.3 pt'));
    expect(bar.textContent).not.toMatch(/1\.\d{2,} pt/);
  });

  it('a width change on a whole two-stroke ink keeps every point; widths scale', async () => {
    const { layer, source, target } = await mountLayer();
    await createAnnotations(target, [inkDraft([stroke(100, 600), stroke(110, 588)])]);
    await cachedInks(1);
    const [ink] = await inks(source);
    if (!ink) throw new Error('no ink');

    await armLasso(layer);
    lasso(layer, { x: 80, y: 620 }, { x: 190, y: 575 });
    await waitFor(() => expect(layer.querySelectorAll('[data-lasso-path]')).toHaveLength(2));
    const expectSamePoints = (now: InkAnnotation | undefined) => {
      expect(now?.paths).toHaveLength(2);
      ink.paths.forEach((path, i) =>
        path.forEach((p, j) => {
          const q = now?.paths[i]?.[j];
          expect(Math.abs((q?.x ?? NaN) - p.x)).toBeLessThanOrEqual(0.01);
          expect(Math.abs((q?.y ?? NaN) - p.y)).toBeLessThanOrEqual(0.01);
        }),
      );
    };

    // 1.5 → 6 pt: four times the widths; the points stay, the rect grows with the stroke only.
    useAnnotationStore.getState().applyStyle({ strokeWidth: 6 });
    await whenIdle();
    let [now] = await inks(source);
    expect(now?.id).toBe(ink.id);
    expect(now?.strokeWidth).toBe(6);
    expectSamePoints(now);
    expect(now?.widths?.flat()).toEqual(ink.widths?.flat().map((w) => w * 4));
    const widest = Math.max(...(now?.widths?.flat() ?? [0]));
    const widestBefore = Math.max(...(ink.widths?.flat() ?? [0]));
    expect(now?.rect.height ?? 0).toBeLessThanOrEqual(ink.rect.height + widest - widestBefore + 2);

    // A second change does not compound a move: 6 → 3 pt, points still in place.
    await new Promise((r) => setTimeout(r, 900));
    useAnnotationStore.getState().applyStyle({ strokeWidth: 3 });
    await whenIdle();
    [now] = await inks(source);
    expectSamePoints(now);
    expect(now?.widths?.flat()).toEqual(ink.widths?.flat().map((w) => w * 2));
  });

  it('a width change on a whole-annotation selection scales the per-point widths', async () => {
    const { source, target } = await mountLayer();
    await createAnnotations(target, [inkDraft([stroke(100, 600), stroke(100, 560)])]);
    await cachedInks(1);
    const [ink] = await inks(source);
    if (!ink) throw new Error('no ink');
    useAnnotationStore.getState().select({ ...target, ids: [ink.id] });
    expect(activePathSelection(useAnnotationStore.getState())).toBeNull();

    useAnnotationStore.getState().applyStyle({ strokeWidth: 4.5 });
    await whenIdle();
    const [now] = await inks(source);
    expect(now?.strokeWidth).toBe(4.5);
    // The same factor as /BS /W (×3), so the appearance draws the change.
    expect(now?.widths?.flat()).toEqual(ink.widths?.flat().map((w) => w * 3));
    expect(now?.paths).toEqual(ink.paths);
  });

  it('a click outside clears the selection; leaving the Lasso drops the path selection', async () => {
    const { layer, target } = await mountLayer();
    await createAnnotations(target, [inkDraft([stroke(100, 600)])]);
    await cachedInks(1);
    await armLasso(layer);
    lasso(layer, { x: 80, y: 615 }, { x: 180, y: 585 });
    await waitFor(() => expect(useAnnotationStore.getState().selection).not.toBeNull());
    const box = layer.getBoundingClientRect();
    layer.dispatchEvent(mouse('pointerdown', box.left + 400, box.top + 700));
    layer.dispatchEvent(mouse('pointerup', box.left + 400, box.top + 700));
    expect(useAnnotationStore.getState().selection).toBeNull();

    lasso(layer, { x: 80, y: 615 }, { x: 180, y: 585 });
    await waitFor(() => expect(useAnnotationStore.getState().selection).not.toBeNull());
    useToolStore.getState().setMode('select');
    await waitFor(() => expect(useAnnotationStore.getState().selection).toBeNull());
  });
  it('takes strokes, an arrow and a note; the bar names the mix; a recolour is one entry', async () => {
    const { layer, source, target } = await mountLayer();
    await createAnnotations(target, [inkDraft([stroke(100, 600), stroke(100, 560)])]);
    await createAnnotations(target, [
      {
        kind: 'line',
        pageIndex: 0,
        rect: { x: 94, y: 504, width: 112, height: 22 },
        vertices: [
          { x: 100, y: 510 },
          { x: 200, y: 520 },
        ],
        lineEndings: { start: 'none', end: 'open-arrow' },
        color: '#1F1F1F',
        strokeWidth: 2,
      },
      {
        kind: 'text',
        pageIndex: 0,
        rect: { x: 220, y: 560, width: 20, height: 20 },
        contents: 'A note',
        color: '#FFEA00',
        icon: 'Comment',
      },
    ]);
    // Outside the lasso: a rectangle far below.
    await createAnnotations(target, [
      {
        kind: 'square',
        pageIndex: 0,
        rect: { x: 100, y: 200, width: 50, height: 30 },
        color: '#1F1F1F',
        strokeWidth: 2,
      },
    ]);
    await waitFor(() => {
      const pages = Object.values(useAnnotationStore.getState().pages);
      expect(pages.flatMap((p) => p.annotations)).toHaveLength(4);
    });
    const all = await readAnnotations(source, 0);
    const arrow = all.find((a) => a.kind === 'line');
    const note = all.find((a) => a.kind === 'text');
    const square = all.find((a) => a.kind === 'square');
    if (!arrow || !note || !square) throw new Error('annotations missing');
    const before = labels().length;

    await armLasso(layer);
    lasso(layer, { x: 80, y: 620 }, { x: 260, y: 500 });
    await waitFor(() => expect(layer.querySelectorAll('[data-lasso-path]')).toHaveLength(2));
    expect(
      [...layer.querySelectorAll('[data-lasso-whole]')].map((e) =>
        e.getAttribute('data-lasso-whole'),
      ),
    ).toEqual([arrow.id, note.id]);
    expect(activePathSelection(useAnnotationStore.getState())?.whole).toEqual([arrow.id, note.id]);
    const bar = await waitFor(() => {
      const b = layer.querySelector<HTMLElement>('[data-lasso-bar]');
      if (!b) throw new Error('no bar');
      return b;
    });
    expect(bar.querySelector('span')).toHaveTextContent('2 strokes, 1 arrow, 1 note');
    expect(useAnnouncer.getState().message).toBe('2 strokes, 1 arrow, and 1 note selected');
    // The width applies to the strokes and the arrow.
    expect(bar.querySelector('[data-stroke-off]')).toBeNull();
    expect(bar.querySelector('[data-lasso-move]')).toHaveAttribute('aria-label', 'Move selection');

    bar.querySelector<HTMLButtonElement>('button[aria-label="Red"]')?.click();
    await whenIdle();
    const after = await readAnnotations(source, 0);
    for (const a of after) {
      expect(a.color?.toUpperCase()).toBe(a.id === square.id ? '#1F1F1F' : INK.red);
    }
    expect(labels()).toHaveLength(before + 1);
    expect(labels().at(-1)).toBe('Recolor 2 strokes, 1 arrow, and 1 note');

    model().undo();
    await whenIdle();
    const undone = await readAnnotations(source, 0);
    expect(undone.find((a) => a.id === note.id)?.color?.toUpperCase()).toBe('#FFEA00');
    expect(undone.find((a) => a.id === arrow.id)?.color?.toUpperCase()).toBe('#1F1F1F');
    expect(undone.filter((a) => a.kind === 'ink').map((a) => a.color?.toUpperCase())).toEqual([
      '#1F1F1F',
    ]);
  });

  it('a lasso around a note alone: the bar names it and shows the width disabled', async () => {
    const { layer, target } = await mountLayer();
    await createAnnotations(target, [
      {
        kind: 'text',
        pageIndex: 0,
        rect: { x: 120, y: 580, width: 20, height: 20 },
        contents: 'A note',
        color: '#FFEA00',
        icon: 'Comment',
      },
    ]);
    await waitFor(() => {
      const pages = Object.values(useAnnotationStore.getState().pages);
      expect(pages.flatMap((p) => p.annotations)).toHaveLength(1);
    });
    await armLasso(layer);
    lasso(layer, { x: 100, y: 620 }, { x: 180, y: 560 });
    const bar = await waitFor(() => {
      const b = layer.querySelector<HTMLElement>('[data-lasso-bar]');
      if (!b) throw new Error('no bar');
      return b;
    });
    expect(bar.querySelector('span')).toHaveTextContent('1 note');
    expect(useAnnouncer.getState().message).toBe('1 note selected');
    const width = bar.querySelector('[data-stroke-off]');
    expect(width).toHaveAttribute('title', 'Nothing selected has a line width');
    expect(width?.querySelector('input[type="range"]')).toBeDisabled();
    expect(layer.querySelectorAll('[data-lasso-whole]')).toHaveLength(1);
  });
});
