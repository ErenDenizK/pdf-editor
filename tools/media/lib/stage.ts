/**
 * The stage a scene plays on (spec §2.1, §2.3): the production app in a fresh context,
 * English, a fixed clock, the harness's cursor and drag ghost, and helpers that wait on
 * what the app shows rather than on timers.
 *
 * Nothing the user would see is hidden or faked. The service worker installs as on a first
 * visit; `open` waits until it controls the page so its status cannot change mid-clip.
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

import { expect, type Locator, type Page } from '@playwright/test';

import {
  fixturePath,
  openFixtures as openWithButton,
  useFileInputPicker,
} from '../../../apps/web/e2e/helpers.ts';
import { Cursor, MOVE_MS } from './cursor.ts';
import { DragGhost } from './drag-ghost.ts';
import { POINTER_EVENT, type PointerDetail } from './page-api.ts';
import { fitWindow } from './viewport.ts';

/** The fixed "now" of every scene: dates in the UI never depend on the day of the run. */
export const DEMO_TIME = new Date('2026-05-12T09:30:00Z');
/** Hold after each visible result (spec §2.3). */
export const HOLD_MS = 600;
/** Hold on the last frame, the poster (spec §2.3). */
export const FINAL_HOLD_MS = 1200;

export type SceneKind = 'still' | 'clip';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One file of a simulated drop from the desktop, as the page receives it. */
interface DroppedFile {
  readonly name: string;
  readonly base64: string;
}

interface DropWindow extends Window {
  __mediaDrop?: { end(): boolean };
}

export class Stage {
  readonly page: Page;
  readonly kind: SceneKind;
  readonly cursor: Cursor;
  readonly ghost: DragGhost;

  private constructor(page: Page, kind: SceneKind, cursor: Cursor, ghost: DragGhost) {
    this.page = page;
    this.kind = kind;
    this.cursor = cursor;
    this.ghost = ghost;
  }

  /** Prepares `page` and opens the app at `path` (Home, English by default). */
  static async open(page: Page, kind: SceneKind, path = './?lang=en'): Promise<Stage> {
    // Stills are single moments: no transitions caught half-way. Clips show real motion.
    await page.emulateMedia({
      colorScheme: 'dark',
      reducedMotion: kind === 'still' ? 'reduce' : 'no-preference',
    });
    await page.clock.setFixedTime(DEMO_TIME);
    await useFileInputPicker(page);
    // Stills show the result, not a pointer.
    const cursor = await Cursor.install(page, kind === 'clip');
    const ghost = await DragGhost.install(page);
    const stage = new Stage(page, kind, cursor, ghost);

    await fitWindow(page);
    await page.goto(path);
    await expect(page.getByTestId('app-shell')).toBeVisible();
    await page.evaluate(async () => {
      await document.fonts.ready;
      // Inter is loaded on first use; make sure every face the UI uses is in before frames.
      await Promise.all([...document.fonts].map((face) => face.load().catch(() => undefined)));
      if ('serviceWorker' in navigator) {
        await navigator.serviceWorker.ready;
        if (!navigator.serviceWorker.controller) {
          await new Promise((resolve) => {
            navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true });
          });
        }
      }
    });
    return stage;
  }

  /** A pause for the viewer after a visible result. Pacing only: never a wait for the app. */
  async hold(ms = HOLD_MS): Promise<void> {
    await sleep(ms);
  }

  /** Opens fixtures with the Open button, as the e2e tests do (no visible drag). */
  async openFixtures(names: readonly string[]): Promise<void> {
    await openWithButton(this.page, names);
  }

  /**
   * Waits until every page canvas inside `scope` that is on screen has rendered (the
   * canvas's own `data-state`), and that there are at least `atLeast` of them.
   */
  async rendered(scope: Locator, atLeast = 1): Promise<void> {
    await expect
      .poll(
        () =>
          scope.evaluateAll((roots) => {
            const canvases = roots.flatMap((root) => [...root.querySelectorAll('canvas')]);
            const onScreen = canvases.filter((canvas) => {
              const rect = canvas.getBoundingClientRect();
              return (
                rect.width > 0 &&
                rect.bottom > 0 &&
                rect.right > 0 &&
                rect.top < innerHeight &&
                rect.left < innerWidth
              );
            });
            const done = onScreen.every((canvas) => canvas.dataset.state === 'rendered');
            return done ? onScreen.length : -1;
          }),
        { timeout: 30_000 },
      )
      .toBeGreaterThanOrEqual(atLeast);
  }

  /**
   * Drags corpus files in from outside the window and drops them on whatever is under
   * the pointer at (x, y): the drawn pointer enters from `from` carrying a ghost of the
   * files, the page gets the dragenter, dragover, dragleave and drop events a desktop drag
   * would send (with real `File`s), and the real mouse does not move, as in an OS drag.
   */
  async dropFiles(
    names: readonly string[],
    to: { readonly x: number; readonly y: number },
    from: { readonly x: number; readonly y: number },
    ms = MOVE_MS,
  ): Promise<void> {
    const files: DroppedFile[] = await Promise.all(
      names.map(async (name) => ({
        name: basename(name),
        base64: (await readFile(fixturePath(name))).toString('base64'),
      })),
    );
    await this.cursor.place(from.x, from.y, { mouse: false });
    await this.page.evaluate(
      ({ list, eventName, modified }) => {
        const data = new DataTransfer();
        for (const file of list) {
          const bytes = Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0));
          // A fixed modification date: Home's cards show it (spec §2.1, deterministic).
          data.items.add(
            new File([bytes], file.name, { type: 'application/pdf', lastModified: modified }),
          );
        }
        let current: Element | null = null;
        const fire = (target: Element, type: string, x: number, y: number) =>
          target.dispatchEvent(
            new DragEvent(type, {
              bubbles: true,
              cancelable: true,
              composed: true,
              clientX: x,
              clientY: y,
              dataTransfer: data,
            }),
          );
        let last = { x: 0, y: 0 };
        const onPointer = (event: Event) => {
          const { x, y } = (event as CustomEvent<PointerDetail>).detail;
          last = { x, y };
          const target = document.elementFromPoint(x, y);
          if (target !== current) {
            // The order a browser uses: enter the new target, then leave the old one.
            if (target) fire(target, 'dragenter', x, y);
            if (current) fire(current, 'dragleave', x, y);
            current = target;
          }
          if (current) fire(current, 'dragover', x, y);
        };
        window.addEventListener(eventName, onPointer);
        (window as DropWindow).__mediaDrop = {
          end() {
            window.removeEventListener(eventName, onPointer);
            delete (window as DropWindow).__mediaDrop;
            return current ? !fire(current, 'drop', last.x, last.y) : false;
          },
        };
      },
      { list: files, eventName: POINTER_EVENT, modified: DEMO_TIME.getTime() },
    );
    // Below and to the right of the arrow's tip, where desktops draw a drag image.
    await this.ghost.liftHtml(fileStack(files.map((file) => file.name)), from.x, from.y, -10, -18);
    await this.cursor.move(to.x, to.y, ms, { mouse: false });
    const accepted = await this.page.evaluate(
      () => (window as DropWindow).__mediaDrop?.end() ?? false,
    );
    await this.ghost.clear();
    if (!accepted) throw new Error('the drop target did not accept the files');
  }
}

/**
 * The drag image of files from the desktop: one row per file, drawn with the app's own
 * tokens (the ghost lives inside the app's document, so `var(--…)` resolves).
 */
function fileStack(names: readonly string[]): string {
  const rows = names
    .map(
      (name) =>
        '<div style="display:flex;align-items:center;gap:8px;padding:6px 10px 6px 8px;' +
        'background:var(--surface-2);border:1px solid var(--border-strong);' +
        'border-radius:var(--radius-2);font:500 var(--text-md)/var(--leading-base) var(--font-sans);' +
        'letter-spacing:var(--tracking-ui);color:var(--text-primary);white-space:nowrap">' +
        '<span style="width:12px;height:16px;border-radius:var(--radius-page);' +
        'background:var(--page-background);box-shadow:var(--page-shadow);flex:none"></span>' +
        `${escapeHtml(name)}</div>`,
    )
    .join('');
  return `<div style="display:grid;gap:4px;justify-items:start">${rows}</div>`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
