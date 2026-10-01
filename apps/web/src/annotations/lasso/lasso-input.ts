/**
 * Lasso input (experience-redesign spec §6.5): native pointer handlers on a page's annotation
 * layer while the Lasso is armed, like the pen's (`pen/ink-input.ts`): no React state per
 * move.
 *
 * - **Drawing.** A press outside the current selection clears it and draws a free path (a
 *   dashed accent line in an SVG of its own); release closes it and takes the paths it
 *   touches (`geometry.ts`) as the selection (`selectPaths`). A click without a drag only
 *   clears the selection.
 * - **Moving.** A press inside the selection's bounds (its grab area, `[data-lasso-grab]`,
 *   which also keeps the selection against the app's press-outside rule) or on the bar's
 *   move grip drags the taken paths: the highlight follows the pointer as a transform, and
 *   release commits one move (`moveLassoSelection`), points translated, widths unchanged.
 * - **Keys** (`keys.ts`): Esc clears the selection and keeps the Lasso armed; Delete removes
 *   the taken paths; arrows nudge them by 1 pt, Shift by 10 pt.
 */
import type { PageId } from '@pdf-editor/document-model';

import { useToolStore } from '../../viewer/tool-store';
import {
  activePathSelection,
  pageKey,
  useAnnotationStore,
  visibleAnnotations,
} from '../annotation-store';
import { cssPointToUser } from '../geometry';
import { commitOpenEditor } from '../InlineEditors';
import type { Point } from '../ink';
import { mountedLayers } from '../layer-registry';
import { penSession } from '../pen/ink-input';
import { announceLasso, moveLassoSelection } from './edits';
import { lassoPicks, pickCount, thinTrail } from './geometry';
import { installLassoKeys } from './keys';
import styles from './Lasso.module.css';

/** Smallest drag (CSS px) that counts as a drag rather than a click. */
const DRAG_THRESHOLD = 4;
/** Points of the trail closer than this (CSS px) to the previous one are dropped. */
const TRAIL_STEP = 2;
/** How long the closed lasso stays on screen after release (ms). */
const CLOSED_LINGER_MS = 360;

const SVG_NS = 'http://www.w3.org/2000/svg';

export interface LassoInputOptions {
  /** The page's annotation layer. */
  readonly element: HTMLElement;
  readonly pageId: PageId;
}

function localPoint(element: HTMLElement, event: { clientX: number; clientY: number }): Point {
  const r = element.getBoundingClientRect();
  return { x: event.clientX - r.left, y: event.clientY - r.top };
}

/** Follows one pointer on the window until release (works across the page edge). */
function follow(
  pointerId: number,
  onMove: (event: PointerEvent) => void,
  onEnd: (event: PointerEvent | null) => void,
): void {
  const move = (e: PointerEvent) => {
    if (e.pointerId === pointerId) onMove(e);
  };
  const stop = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
  };
  const up = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    stop();
    onEnd(e);
  };
  const cancel = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    stop();
    onEnd(null);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
}

/**
 * Drags the lasso selection of `pageId` from the press `event` (a press inside the
 * selection, or on the bar's move grip): the highlight follows as a transform, release
 * commits the move.
 */
export function startLassoMove(pageId: PageId, event: PointerEvent): void {
  const layer = mountedLayers.get(pageId);
  if (!layer) return;
  const element = layer.element;
  const start = localPoint(element, event);
  let dragging = false;
  const highlight = () => element.querySelector<SVGGElement>('[data-lasso-selection]');
  const bar = () => element.querySelector<HTMLElement>('[data-testid="annotation-bar"]');
  const reset = () => {
    highlight()?.removeAttribute('transform');
    const b = bar();
    if (b) b.style.visibility = '';
    delete element.dataset.lassoMoving;
  };
  follow(
    event.pointerId,
    (e) => {
      const p = localPoint(element, e);
      if (!dragging && Math.hypot(p.x - start.x, p.y - start.y) < DRAG_THRESHOLD) return;
      if (!dragging) {
        dragging = true;
        element.dataset.lassoMoving = '';
        const b = bar();
        if (b) b.style.visibility = 'hidden';
      }
      highlight()?.setAttribute('transform', `translate(${p.x - start.x} ${p.y - start.y})`);
    },
    (e) => {
      if (!dragging || !e) {
        reset();
        return;
      }
      const end = localPoint(element, e);
      // The page frame of now (zoom may not change during a drag, but read it fresh).
      const frame = mountedLayers.get(pageId)?.frame ?? layer.frame;
      const a = cssPointToUser(frame, start);
      const b = cssPointToUser(frame, end);
      void moveLassoSelection(b.x - a.x, b.y - a.y).finally(reset);
    },
  );
}

/** Attaches the lasso to a page's layer; returns the detach function. */
export function attachLassoInput(options: LassoInputOptions): () => void {
  const { element, pageId } = options;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', styles.overlay ?? '');
  svg.setAttribute('aria-hidden', 'true');
  const trail = document.createElementNS(SVG_NS, 'path');
  trail.setAttribute('class', styles.trail ?? '');
  trail.setAttribute('data-lasso-trail', '');
  svg.appendChild(trail);
  element.appendChild(svg);
  let lingering: number | undefined;
  const uninstallKeys = installLassoKeys();

  const clearTrail = () => {
    window.clearTimeout(lingering);
    lingering = undefined;
    trail.removeAttribute('d');
    trail.removeAttribute('data-closed');
  };

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    if (e.pointerType === 'touch' && penSession().penSeen) return;
    const grab = e.target instanceof Element && e.target.closest('[data-lasso-grab]') !== null;
    if (!grab && e.target instanceof Element && e.target.closest('[data-annotation-keep]')) return;
    const layer = mountedLayers.get(pageId);
    if (!layer) return;
    e.preventDefault();
    // A press while an inline editor is open commits it (as a drawing press does).
    if (useAnnotationStore.getState().editor && !commitOpenEditor()) {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    }
    const start = localPoint(element, e);
    if (grab) {
      startLassoMove(pageId, e);
      return;
    }
    const store = useAnnotationStore.getState();
    if (store.selection) store.select(null);
    clearTrail();
    let points: Point[] = [start];
    let d = `M${start.x.toFixed(1)} ${start.y.toFixed(1)}`;
    trail.setAttribute('d', d);
    follow(
      e.pointerId,
      (move) => {
        const samples = move.getCoalescedEvents?.() ?? [];
        for (const sample of samples.length > 0 ? samples : [move]) {
          const p = localPoint(element, sample);
          const last = points[points.length - 1] as Point;
          if (Math.hypot(p.x - last.x, p.y - last.y) < TRAIL_STEP) continue;
          points.push(p);
          d += ` L${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
        }
        trail.setAttribute('d', d);
      },
      (end) => {
        if (!end) {
          clearTrail();
          return;
        }
        points = thinTrail([...points, localPoint(element, end)], TRAIL_STEP);
        const xs = points.map((p) => p.x);
        const ys = points.map((p) => p.y);
        const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
        if (points.length < 3 || span < DRAG_THRESHOLD) {
          clearTrail();
          return;
        }
        trail.setAttribute('d', `${d} Z`);
        trail.setAttribute('data-closed', '');
        lingering = window.setTimeout(clearTrail, CLOSED_LINGER_MS);
        const current = mountedLayers.get(pageId) ?? layer;
        const polygon = points.map((p) => cssPointToUser(current.frame, p));
        const state = useAnnotationStore.getState();
        const entry = state.pages[pageKey(current.target.source, current.target.pageIndex)];
        const picks = lassoPicks(visibleAnnotations(entry), polygon);
        const count = pickCount(picks);
        if (count > 0) state.selectPaths(current.target, picks);
        announceLasso(count);
      },
    );
  };

  element.addEventListener('pointerdown', onPointerDown);
  return () => {
    element.removeEventListener('pointerdown', onPointerDown);
    window.clearTimeout(lingering);
    svg.remove();
    delete element.dataset.lassoMoving;
    uninstallKeys();
    // Leaving the Lasso drops its path selection (other tools act on whole annotations).
    if (useToolStore.getState().mode !== 'lasso') {
      const store = useAnnotationStore.getState();
      if (activePathSelection(store)) store.select(null);
    }
  };
}
