/**
 * Group resize and rotate on a mounted annotation layer (craft spec §5.5, WP P12), with real
 * PDFium: a lasso around two strokes shows eight handles and a rotation grip; dragging a
 * corner scales them about the opposite corner as one history entry, Shift keeps the aspect;
 * with the selection box focused, Shift and an arrow resize by 1 pt and Alt and an arrow
 * rotate by 1°, each announced, a series as one entry.
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
import { useAnnouncer } from '../../shell/announcer';
import { resetWorkspace, useWorkspaceStore } from '../../state/workspace-store';
import { useToolStore } from '../../viewer/tool-store';
import { createAnnotations } from '../actions';
import { AnnotationLayer } from '../AnnotationLayer';
import {
  type PageTarget,
  resetAnnotationStore,
  TOOL_STYLES_STORAGE_KEY,
  useAnnotationStore,
} from '../annotation-store';
import { readAnnotations, resetEditRunner, whenIdle } from '../edit-runner';
import { userToCss } from '../geometry';
import { boundsOf, type Point } from '../ink';
import { mountedLayers } from '../layer-registry';
import { resetLassoEdits } from './edits';
import { resetLassoKeySeries } from './LassoSelection';

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

/** The centre of an element on screen. */
function centre(el: Element): Point {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** Drags from the element's centre by (dx, dy) CSS px, in steps, as a mouse would. */
function drag(el: Element, dx: number, dy: number, init: PointerEventInit = {}): void {
  const from = centre(el);
  el.dispatchEvent(mouse('pointerdown', from.x, from.y, init));
  for (let i = 1; i <= 6; i++) {
    window.dispatchEvent(mouse('pointermove', from.x + (dx * i) / 6, from.y + (dy * i) / 6, init));
  }
  window.dispatchEvent(mouse('pointerup', from.x + dx, from.y + dy, init));
}

/** What the inks' paths span in user space. */
function span(all: readonly InkAnnotation[]): { width: number; height: number } {
  const b = boundsOf(all.flatMap((a) => a.paths));
  return { width: b.width, height: b.height };
}

async function lassoTwoStrokes() {
  const mounted = await mountLayer();
  const { layer, source, target } = mounted;
  for (const y of [600, 560]) await createAnnotations(target, [inkDraft([stroke(100, y)])]);
  await cachedInks(2);
  await armLasso(layer);
  lasso(layer, { x: 80, y: 620 }, { x: 180, y: 540 });
  await waitFor(() => expect(layer.querySelectorAll('[data-lasso-path]')).toHaveLength(2));
  const before = span(await inks(source));
  return { ...mounted, before };
}

function handle(layer: HTMLElement, name: string): Element {
  const el = layer.querySelector(`[data-lasso-handle="${name}"]`);
  if (!el) throw new Error(`no ${name} handle`);
  return el;
}

/** The drawn square of a handle (its hit area's sibling). */
function drawn(hit: Element): Element {
  const el = hit.previousElementSibling;
  if (!el) throw new Error('no drawn handle');
  return el;
}

describe('lasso group resize and rotate on the layer', () => {
  beforeEach(async () => {
    await page.viewport(1280, 900);
    localStorage.removeItem(TOOL_STYLES_STORAGE_KEY);
    resetWorkspace();
    resetEditRunner();
    resetAnnotationStore();
    resetLassoEdits();
    resetLassoKeySeries();
  });
  afterEach(async () => {
    await whenIdle();
    cleanup();
    useToolStore.getState().setMode('select');
    resetAnnotationStore();
    resetWorkspace();
  });

  it('shows eight handles and a grip; a corner drag scales about the opposite corner', async () => {
    const { layer, source, target, before } = await lassoTwoStrokes();
    const handles = [...layer.querySelectorAll('[data-lasso-handle]')].map((h) =>
      h.getAttribute('data-lasso-handle'),
    );
    expect(handles.sort()).toEqual(['e', 'n', 'ne', 'nw', 's', 'se', 'sw', 'w']);
    expect(layer.querySelectorAll('[data-lasso-rotate]')).toHaveLength(1);
    // The handles take presses where they are drawn.
    const se = handle(layer, 'se');
    const at = centre(drawn(se));
    expect(document.elementFromPoint(at.x, at.y)).toBe(se);
    const count = labels().length;

    // 30 CSS px right at scale 1: the 60 pt wide strokes become 90 pt wide, height kept.
    const from = centre(se);
    se.dispatchEvent(mouse('pointerdown', from.x, from.y));
    for (let i = 1; i <= 6; i++) window.dispatchEvent(mouse('pointermove', from.x + 5 * i, from.y));
    // While dragging, the highlight follows as a transform and the handles hide.
    expect(layer.querySelector('[data-lasso-content]')?.getAttribute('transform')).toMatch(
      /^matrix\(1\.5 0 0 1 /,
    );
    expect(layer.querySelector<SVGElement>('[data-lasso-handles]')?.style.visibility).toBe(
      'hidden',
    );
    window.dispatchEvent(mouse('pointerup', from.x + 30, from.y));
    await whenIdle();
    const after = span(await inks(source));
    expect(after.width).toBeCloseTo(before.width * 1.5, 1);
    expect(after.height).toBeCloseTo(before.height, 1);
    const left = Math.min(...(await inks(source)).flatMap((a) => a.paths.flat().map((p) => p.x)));
    expect(left).toBeCloseTo(100, 1);
    expect(labels()).toHaveLength(count + 1);
    expect(labels().at(-1)).toBe('Resize 2 strokes');
    // The selection follows: the handles sit on the grown box.
    const frame = mountedLayers.get(target.pageId)?.frame;
    if (!frame) throw new Error('no frame');
    await waitFor(() => {
      const right = userToCss(frame, { x: 100 + after.width, y: 600 }).x;
      const h = drawn(handle(layer, 'e')).getBoundingClientRect();
      const box = layer.getBoundingClientRect();
      expect(h.left + h.width / 2 - box.left).toBeCloseTo(right + 8, 0);
    });

    model().undo();
    await whenIdle();
    expect(span(await inks(source)).width).toBeCloseTo(before.width, 1);
  });

  it('handles and the grip take 24 px presses, never inside the selection itself', async () => {
    const { layer, source, target } = await lassoTwoStrokes();
    const frame = mountedLayers.get(target.pageId)?.frame;
    if (!frame) throw new Error('no frame');
    // The selection's own extent, CSS px from the layer's corner.
    const points = (await inks(source)).flatMap((a) => a.paths.flat());
    const css = points.map((p) => userToCss(frame, p));
    const tight = {
      left: Math.min(...css.map((p) => p.x)),
      right: Math.max(...css.map((p) => p.x)),
      top: Math.min(...css.map((p) => p.y)),
      bottom: Math.max(...css.map((p) => p.y)),
    };
    const origin = layer.getBoundingClientRect();
    const local = (el: Element) => {
      const r = el.getBoundingClientRect();
      return {
        left: r.left - origin.left,
        right: r.right - origin.left,
        top: r.top - origin.top,
        bottom: r.bottom - origin.top,
        width: r.width,
        height: r.height,
      };
    };
    const overlaps = (a: ReturnType<typeof local>, b: typeof tight) =>
      a.left < b.right - 0.5 &&
      a.right > b.left + 0.5 &&
      a.top < b.bottom - 0.5 &&
      a.bottom > b.top + 0.5;
    const hits = [...layer.querySelectorAll('[data-lasso-handle]')].map(local);
    expect(hits).toHaveLength(8);
    for (const hit of hits) {
      expect(hit.width).toBeGreaterThanOrEqual(24);
      expect(hit.height).toBeGreaterThanOrEqual(24);
      expect(overlaps(hit, tight)).toBe(false);
    }
    const grip = layer.querySelector('[data-lasso-rotate]');
    if (!grip) throw new Error('no grip');
    const g = local(grip);
    expect(g.width).toBeGreaterThanOrEqual(24);
    expect(g.height).toBeGreaterThanOrEqual(24);
    expect(overlaps(g, tight)).toBe(false);
    for (const hit of hits) expect(overlaps(g, hit)).toBe(false);
    // Inside the selection the press is the grab area's (it moves the selection).
    const mid = {
      x: origin.left + (tight.left + tight.right) / 2,
      y: origin.top + (tight.top + tight.bottom) / 2,
    };
    expect(document.elementFromPoint(mid.x, mid.y)).toHaveAttribute('data-lasso-grab');
  });

  it('Shift on a corner keeps the aspect', async () => {
    const { layer, source, before } = await lassoTwoStrokes();
    drag(handle(layer, 'se'), 30, 0, { shiftKey: true });
    await whenIdle();
    const after = span(await inks(source));
    expect(after.width).toBeCloseTo(before.width * 1.5, 1);
    expect(after.height).toBeCloseTo(before.height * 1.5, 1);
  });

  it('the rotation grip turns the strokes about the centre', async () => {
    const { layer, source } = await lassoTwoStrokes();
    const grip = layer.querySelector('[data-lasso-rotate]');
    if (!grip) throw new Error('no grip');
    const box = layer.querySelector('[data-lasso-box]');
    if (!box) throw new Error('no box');
    const c = centre(box);
    const g = centre(grip);
    // A quarter turn clockwise: the grip below the centre goes to its left.
    const r = Math.hypot(g.x - c.x, g.y - c.y);
    drag(grip, c.x - r - g.x, c.y - g.y);
    await whenIdle();
    const after = span(await inks(source));
    // 60 pt wide, about 42 pt tall before: now about 42 wide and 60 tall.
    expect(after.height).toBeGreaterThan(after.width);
    expect(labels().at(-1)).toBe('Rotate 2 strokes');
  });

  it('keyboard: Shift and arrows resize by 1 pt, Alt and arrows rotate by 1°, announced', async () => {
    const { layer, source, before } = await lassoTwoStrokes();
    const box = layer.querySelector<HTMLElement>('[data-lasso-box]');
    if (!box) throw new Error('no selection box');
    expect(box).toHaveAttribute('tabindex', '0');
    expect(box.getAttribute('aria-label')).toContain('2 strokes');
    box.focus();
    const count = labels().length;
    const press = (key: string, init: KeyboardEventInit) =>
      box.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
      );

    press('ArrowRight', { shiftKey: true });
    await whenIdle();
    const size = layer.querySelector('[data-lasso-box]')?.getBoundingClientRect();
    expect(useAnnouncer.getState().message).toMatch(/^Resized to \d+ × \d+ pt$/);
    press('ArrowRight', { shiftKey: true });
    await whenIdle();
    let after = span(await inks(source));
    expect(after.width).toBeCloseTo(before.width + 2, 0);
    expect(after.height).toBeCloseTo(before.height, 1);
    // Two presses in a row are one entry.
    expect(labels()).toHaveLength(count + 1);
    expect(labels().at(-1)).toBe('Resize 2 strokes');
    // The box (and its focus) stays with the selection.
    await waitFor(() =>
      expect(
        layer.querySelector('[data-lasso-box]')?.getBoundingClientRect().width,
      ).toBeGreaterThan(size?.width ?? 0),
    );
    expect(document.activeElement).toBe(layer.querySelector('[data-lasso-box]'));

    await new Promise((r) => setTimeout(r, 900));
    press('ArrowRight', { altKey: true });
    await whenIdle();
    expect(useAnnouncer.getState().message).toBe('Rotated 1° clockwise');
    press('ArrowRight', { altKey: true });
    await whenIdle();
    expect(useAnnouncer.getState().message).toBe('Rotated 2° clockwise');
    after = span(await inks(source));
    expect(after.height).toBeGreaterThan(before.height);
    expect(labels()).toHaveLength(count + 2);
    expect(labels().at(-1)).toBe('Rotate 2 strokes');
  });
});
