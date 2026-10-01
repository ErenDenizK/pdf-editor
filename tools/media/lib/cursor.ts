/**
 * The pointer seen in clips (spec §2.3). Headless Chromium draws no cursor, and
 * Playwright's `showActions` adds action titles, so the harness injects its own SVG arrow
 * and moves it together with `page.mouse` in eased steps.
 *
 * The drawn arrow follows the page's pointer and drag events, and every step also sets it
 * explicitly: during a drag Chromium sends no pointer events, and a simulated OS file drag
 * (`Stage.dropFiles`) moves the arrow without moving the mouse at all. Each update is also
 * dispatched as `media:pointer`, which the drag ghost follows.
 */
import type { Locator, Page } from '@playwright/test';

import { type MediaWindow, POINTER_EVENT } from './page-api.ts';

/** Pointer moves last 350–500 ms in the clips (spec §2.3). */
export const MOVE_MS = 420;
/** About one step per display frame. */
const STEP_MS = 1000 / 60;

/** Smooth start and stop: the pointer accelerates, then settles on its target. */
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** Runs in the page before its scripts: builds the arrow and the `window.__media` API. */
function injectCursor(eventName: string): void {
  const win = window as MediaWindow;
  if (win.__media) return;
  // A white arrow with a dark outline, readable over the dark chrome and a white page.
  // Hotspot at (2, 2) of a 24 × 24 box; vector, so it stays sharp at 2x.
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">' +
    '<path d="M2 2 L2 19.5 L6.6 15.2 L9.6 22 L12.6 20.7 L9.7 14 L16 13.8 Z" ' +
    'fill="#ffffff" stroke="#08090b" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  const cursor = document.createElement('div');
  cursor.setAttribute('aria-hidden', 'true');
  cursor.dataset.media = 'cursor';
  cursor.innerHTML = svg;
  Object.assign(cursor.style, {
    position: 'fixed',
    left: '0',
    top: '0',
    width: '24px',
    height: '24px',
    pointerEvents: 'none',
    zIndex: '2147483647',
    transformOrigin: '2px 2px',
    transition: 'scale 60ms cubic-bezier(0.2, 0, 0, 1)',
    // Off screen until the first move places it.
    transform: 'translate(-100px, -100px)',
  });
  const set = (x: number, y: number) => {
    cursor.style.transform = `translate(${x - 2}px, ${y - 2}px)`;
    window.dispatchEvent(new CustomEvent(eventName, { detail: { x, y } }));
  };
  win.__media = {
    pointer: set,
    press: (down) => {
      cursor.style.scale = down ? '0.88' : '1';
    },
  };
  const follow = (event: MouseEvent) => {
    // Drag events at (0, 0) are Chromium's end-of-drag noise, not a position.
    if (event.clientX === 0 && event.clientY === 0) return;
    set(event.clientX, event.clientY);
  };
  for (const type of ['pointermove', 'mousemove', 'dragover', 'drag'] as const) {
    window.addEventListener(type, follow, { capture: true, passive: true });
  }
  const attach = () => document.documentElement.append(cursor);
  if (document.documentElement) attach();
  else document.addEventListener('DOMContentLoaded', attach, { once: true });
}

export interface MoveOptions {
  /** Also move the real mouse (default). Off while simulating a drag from outside the page. */
  readonly mouse?: boolean;
}

export class Cursor {
  private x = -100;
  private y = -100;

  private readonly page: Page;

  private constructor(page: Page) {
    this.page = page;
  }

  /**
   * Call before the first `page.goto`; the arrow is re-created on every navigation. With
   * `drawn: false` (stills) nothing is injected and the cursor only moves the real mouse.
   */
  static async install(page: Page, drawn = true): Promise<Cursor> {
    if (drawn) await page.addInitScript(injectCursor, POINTER_EVENT);
    return new Cursor(page);
  }

  get position(): { readonly x: number; readonly y: number } {
    return { x: this.x, y: this.y };
  }

  /** Puts the pointer somewhere at once (before a clip starts). */
  async place(x: number, y: number, options: MoveOptions = {}): Promise<void> {
    await this.step(x, y, options.mouse ?? true);
  }

  /**
   * Moves the pointer to (x, y) over `ms`, eased. Steps are taken about 60 times a second
   * and placed by elapsed time, so a busy page gets fewer steps, never a longer move.
   */
  async move(x: number, y: number, ms = MOVE_MS, options: MoveOptions = {}): Promise<void> {
    const mouse = options.mouse ?? true;
    const from = { x: this.x, y: this.y };
    const start = performance.now();
    for (;;) {
      const t = Math.min(1, (performance.now() - start) / ms);
      const eased = easeInOutCubic(t);
      await this.step(from.x + (x - from.x) * eased, from.y + (y - from.y) * eased, mouse);
      if (t >= 1) return;
      const elapsed = performance.now() - start;
      await sleep(Math.min(ms - elapsed, STEP_MS - (elapsed % STEP_MS)));
    }
  }

  /**
   * Moves to a point inside `target`: `at` is a fraction of its box (default its centre).
   * Waits for the target to be visible and stable first, as a click would.
   */
  async moveTo(
    target: Locator,
    ms = MOVE_MS,
    at: { readonly x: number; readonly y: number } = { x: 0.5, y: 0.5 },
    options: MoveOptions = {},
  ): Promise<void> {
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    if (!box) throw new Error(`cursor target is not visible: ${target.toString()}`);
    await this.move(box.x + box.width * at.x, box.y + box.height * at.y, ms, options);
  }

  /** Moves to `target` and clicks it where the pointer is, with a visible press. */
  async click(
    target: Locator,
    ms = MOVE_MS,
    at?: { readonly x: number; readonly y: number },
  ): Promise<void> {
    await this.moveTo(target, ms, at);
    await this.down();
    await sleep(90);
    await this.up();
  }

  async down(): Promise<void> {
    await this.press(true);
    await this.page.mouse.down();
  }

  async up(): Promise<void> {
    await this.page.mouse.up();
    await this.press(false);
  }

  private async press(down: boolean): Promise<void> {
    await this.page.evaluate((value) => (window as MediaWindow).__media?.press(value), down);
  }

  private async step(x: number, y: number, mouse: boolean): Promise<void> {
    this.x = x;
    this.y = y;
    if (mouse) await this.page.mouse.move(x, y);
    await this.page.evaluate(([px, py]) => (window as MediaWindow).__media?.pointer(px, py), [
      x,
      y,
    ] as const);
  }
}
