/**
 * The drag ghost (spec §2.3, DESIGN §3 "Motion"). A headless browser draws no OS drag
 * image, so a clip of a drag would show the pointer moving alone. The harness draws its
 * own: a translucent, slightly scaled copy of the dragged element that follows the
 * pointer, under the drawn cursor and above the app. Opacity and scale match the app's
 * own drag preview (`apps/web/src/dnd/*.module.css`: 0.9, 0.96). Nothing in the app
 * changes; the ghost is removed on drop.
 *
 * `lift` copies a page element (canvas pixels included, which `cloneNode` leaves blank);
 * `liftHtml` draws something that is not in the page, such as the files of a drop from the
 * desktop.
 */
import type { Locator, Page } from '@playwright/test';

import { POINTER_EVENT, type PointerDetail } from './page-api.ts';

const GHOST_OPACITY = 0.9;
const GHOST_SCALE = 0.96;

interface GhostWindow extends Window {
  __mediaGhost?: {
    show(node: HTMLElement, left: number, top: number, grabX: number, grabY: number): void;
    clear(): void;
  };
}

/** Runs in the page before its scripts. */
function injectGhost(args: { eventName: string; opacity: number; scale: number }): void {
  const win = window as GhostWindow;
  if (win.__mediaGhost) return;
  let ghost: HTMLElement | null = null;
  let grab = { x: 0, y: 0 };
  const place = (x: number, y: number) => {
    if (ghost) ghost.style.translate = `${x - grab.x}px ${y - grab.y}px`;
  };
  window.addEventListener(args.eventName, (event) => {
    const { x, y } = (event as CustomEvent<PointerDetail>).detail;
    place(x, y);
  });
  win.__mediaGhost = {
    show(node, left, top, grabX, grabY) {
      ghost?.remove();
      grab = { x: grabX, y: grabY };
      const root = document.createElement('div');
      root.setAttribute('aria-hidden', 'true');
      root.dataset.media = 'drag-ghost';
      Object.assign(root.style, {
        position: 'fixed',
        left: '0',
        top: '0',
        pointerEvents: 'none',
        // Under the cursor (2147483647), above everything in the app.
        zIndex: '2147483646',
        opacity: String(args.opacity),
        // Scaled about the grab point, so the pointer stays where the element was taken.
        transformOrigin: `${grabX}px ${grabY}px`,
        transform: `scale(${args.scale})`,
      });
      root.append(node);
      ghost = root;
      place(left + grabX, top + grabY);
      document.documentElement.append(root);
    },
    clear() {
      ghost?.remove();
      ghost = null;
    },
  };
}

export class DragGhost {
  private readonly page: Page;

  private constructor(page: Page) {
    this.page = page;
  }

  /** Call before the first `page.goto`. */
  static async install(page: Page): Promise<DragGhost> {
    await page.addInitScript(injectGhost, {
      eventName: POINTER_EVENT,
      opacity: GHOST_OPACITY,
      scale: GHOST_SCALE,
    });
    return new DragGhost(page);
  }

  /**
   * Shows a copy of `element` taken at viewport point (x, y), which keeps its offset under
   * the pointer as it moves. Call right after the mouse goes down on it.
   */
  async lift(element: Locator, x: number, y: number): Promise<void> {
    await element.evaluate(
      (source, point) => {
        const rect = source.getBoundingClientRect();
        const copy = source.cloneNode(true) as HTMLElement;
        // cloneNode copies a canvas element but not its pixels.
        const from = source.querySelectorAll('canvas');
        copy.querySelectorAll('canvas').forEach((canvas, index) => {
          const original = from[index];
          if (!original || original.width === 0 || original.height === 0) return;
          canvas.width = original.width;
          canvas.height = original.height;
          canvas.getContext('2d')?.drawImage(original, 0, 0);
        });
        copy.removeAttribute('id');
        copy.querySelectorAll('[id]').forEach((node) => node.removeAttribute('id'));
        Object.assign(copy.style, {
          width: `${rect.width}px`,
          height: `${rect.height}px`,
          margin: '0',
          boxSizing: 'border-box',
        });
        (window as GhostWindow).__mediaGhost?.show(
          copy,
          rect.left,
          rect.top,
          point.x - rect.left,
          point.y - rect.top,
        );
      },
      { x, y },
    );
  }

  /**
   * Shows `html` (built by the harness, styled inline) with its point (`grabX`, `grabY`)
   * under the pointer at viewport point (x, y).
   */
  async liftHtml(html: string, x: number, y: number, grabX: number, grabY: number): Promise<void> {
    await this.page.evaluate(
      (args) => {
        const holder = document.createElement('div');
        holder.innerHTML = args.html;
        (window as GhostWindow).__mediaGhost?.show(
          holder,
          args.x - args.grabX,
          args.y - args.grabY,
          args.grabX,
          args.grabY,
        );
      },
      { html, x, y, grabX, grabY },
    );
  }

  /** Removes the ghost (on drop or cancel). */
  async clear(): Promise<void> {
    await this.page.evaluate(() => (window as GhostWindow).__mediaGhost?.clear());
  }
}
