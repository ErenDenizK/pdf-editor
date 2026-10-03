/**
 * The full-bleed stage (docs/specs/craft.md §7). The Read view's scroll container covers the
 * whole app shell (`[data-stage-bleed]`), under the title bar, navigator, inspector and status
 * bar, so a page can pass beneath the docked frame; its pages are laid out, fitted, centred
 * and scrolled into view in the rectangle the frame leaves free (the "unobscured rectangle":
 * the stage's own box below its header). Both are measured from the real layout, so a panel
 * resize re-fits.
 *
 * Also here: which scroll bars the page column needs (the container hides its own, which would
 * sit under the frame, and `ScrollProxies` draws them in the unobscured rectangle), and the
 * geometry gate for the tier-2 glass: only frame surfaces with a page within 80 px blur.
 */
import { type RefObject, useLayoutEffect, useState } from 'react';

/** Distances from the edges of an outer rectangle, CSS px. */
export interface Insets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

/** A rectangle in the bleed area's coordinates, CSS px. */
export interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

export interface StageBleed {
  /** The bleed area (the app shell), or null outside one (component tests): no insets. */
  readonly element: HTMLElement | null;
  /** The unobscured rectangle's distance from each edge of the bleed area. */
  readonly insets: Insets;
  /**
   * The docked frame alone: title bar (the stage's top), navigator, inspector and status bar.
   * `insets.top` also counts the stage header (the mode control) under the title bar.
   */
  readonly frame: Insets;
  /** Size of the unobscured rectangle. */
  readonly width: number;
  readonly height: number;
}

const EMPTY: StageBleed = {
  element: null,
  insets: NO_INSETS,
  frame: NO_INSETS,
  width: 0,
  height: 0,
};

const insetsOf = (inner: DOMRect, outer: DOMRect): Insets => ({
  top: inner.top - outer.top,
  right: outer.right - inner.right,
  bottom: outer.bottom - inner.bottom,
  left: inner.left - outer.left,
});

/** Measures `unobscured` (the Read view's frame) against its bleed area. Exported for tests. */
export function measureStageBleed(unobscured: HTMLElement): StageBleed {
  const own = unobscured.getBoundingClientRect();
  const element = unobscured.closest<HTMLElement>('[data-stage-bleed]');
  if (!element) {
    return { element: null, insets: NO_INSETS, frame: NO_INSETS, ...sizeOf(own) };
  }
  const outer = element.getBoundingClientRect();
  const stage = unobscured.closest('main')?.getBoundingClientRect() ?? own;
  return {
    element,
    insets: insetsOf(own, outer),
    frame: insetsOf(stage, outer),
    ...sizeOf(own),
  };
}

const sizeOf = (rect: DOMRect): Size => ({ width: rect.width, height: rect.height });

const sameInsets = (a: Insets, b: Insets) =>
  a.top === b.top && a.right === b.right && a.bottom === b.bottom && a.left === b.left;

const sameBleed = (a: StageBleed, b: StageBleed) =>
  a.element === b.element &&
  a.width === b.width &&
  a.height === b.height &&
  sameInsets(a.insets, b.insets) &&
  sameInsets(a.frame, b.frame);

/**
 * The unobscured rectangle of `ref` in its bleed area, kept current: on any size change of
 * the rectangle, the bleed area or a panel in it (a panel opening, closing or being dragged
 * wider). Measured before paint.
 */
export function useStageBleed(ref: RefObject<HTMLElement | null>): StageBleed {
  const [bleed, setBleed] = useState<StageBleed>(EMPTY);
  useLayoutEffect(() => {
    const own = ref.current;
    if (!own) return;
    const measure = () => {
      const next = measureStageBleed(own);
      setBleed((previous) => (sameBleed(previous, next) ? previous : next));
    };
    measure();
    const area = own.closest<HTMLElement>('[data-stage-bleed]');
    const resize = new ResizeObserver(measure);
    const observe = () => {
      resize.disconnect();
      resize.observe(own);
      if (!area) return;
      resize.observe(area);
      for (const child of area.children) resize.observe(child);
    };
    observe();
    // The inspector mounts and unmounts as it opens and closes.
    const children = new MutationObserver(() => {
      observe();
      measure();
    });
    if (area) children.observe(area, { childList: true });
    return () => {
      resize.disconnect();
      children.disconnect();
    };
  }, [ref]);
  return bleed;
}

let measuredScrollbar: number | undefined;

/**
 * The thickness of a classic scroll bar under the app's `scrollbar-width: thin`; 0 where
 * scroll bars overlay the content (macOS, mobile). Measured once.
 */
export function scrollbarSize(): number {
  if (measuredScrollbar !== undefined) return measuredScrollbar;
  if (typeof document === 'undefined' || !document.body) return 0;
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:absolute;top:-200px;left:-200px;width:100px;height:100px;overflow:scroll;visibility:hidden;';
  document.body.append(probe);
  measuredScrollbar = Math.max(0, probe.offsetWidth - probe.clientWidth);
  probe.remove();
  return measuredScrollbar;
}

/**
 * Which scroll bars a scroll container of `view` size shows for `content`, with bars of
 * `size` px, as the browser decides: a horizontal bar takes height, which can call for the
 * vertical one, and the other way round.
 */
export function scrollbarsNeeded(
  content: Size,
  view: Size,
  size: number,
): { vertical: boolean; horizontal: boolean } {
  const over = (a: number, b: number) => a > b + 0.5;
  let vertical = over(content.height, view.height);
  let horizontal = over(content.width, view.width - (vertical ? size : 0));
  if (horizontal && !vertical) {
    vertical = over(content.height, view.height - size);
    horizontal = over(content.width, view.width - (vertical ? size : 0));
  }
  return { vertical, horizontal };
}

/** A surface of the docked frame. */
export type FrameSurface = 'title' | 'left' | 'right' | 'status';

/**
 * A docked surface blurs only with a page this close (twice the tier-2 blur radius, research
 * 13 §4.2); further away its backdrop is the bare canvas, and the solid token paints the same
 * pixels for free.
 */
export const GLASS_GATE_PX = 80;

/**
 * The frame surfaces with a page within `gate` px. `pages` and the surfaces share the bleed
 * area's coordinates; `area` is its size and `frame` the docked frame's insets in it.
 */
export function surfacesNearPages(
  pages: readonly Box[],
  area: Size,
  frame: Insets,
  gate: number = GLASS_GATE_PX,
): FrameSurface[] {
  const { width, height } = area;
  const middleTop = frame.top;
  const middleBottom = height - frame.bottom;
  const surfaces: readonly (readonly [FrameSurface, Box])[] = [
    ['title', { left: 0, top: 0, width, height: frame.top }],
    ['left', { left: 0, top: middleTop, width: frame.left, height: middleBottom - middleTop }],
    [
      'right',
      {
        left: width - frame.right,
        top: middleTop,
        width: frame.right,
        height: middleBottom - middleTop,
      },
    ],
    ['status', { left: 0, top: middleBottom, width, height: frame.bottom }],
  ];
  const near: FrameSurface[] = [];
  for (const [name, surface] of surfaces) {
    if (surface.width <= 0 || surface.height <= 0) continue;
    const hit = pages.some(
      (page) =>
        page.width > 0 &&
        page.height > 0 &&
        page.left - gate < surface.left + surface.width &&
        page.left + page.width + gate > surface.left &&
        page.top - gate < surface.top + surface.height &&
        page.top + page.height + gate > surface.top,
    );
    if (hit) near.push(name);
  }
  return near;
}

/**
 * Publishes the gate's result on the bleed area as `data-glass-near` (global.css reads it,
 * and only while "Glass panels" is on). Writes only on a change: one attribute, no layout.
 */
export function writeGlassNear(area: HTMLElement | null, near: readonly FrameSurface[]): void {
  if (!area) return;
  const value = near.join(' ');
  if ((area.getAttribute('data-glass-near') ?? '') === value) return;
  if (value === '') area.removeAttribute('data-glass-near');
  else area.setAttribute('data-glass-near', value);
}
