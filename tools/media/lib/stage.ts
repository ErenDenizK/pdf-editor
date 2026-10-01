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

import { fixturePath, useFileInputPicker } from '../../../apps/web/e2e/helpers.ts';
import { Cursor, MOVE_MS } from './cursor.ts';
import { DragGhost } from './drag-ghost.ts';
import { POINTER_EVENT, type PointerDetail } from './page-api.ts';
import type { Recorder } from './recorder.ts';
import { fitWindow } from './viewport.ts';

/**
 * Scenes name their documents by file name; they are the demo documents of spec §2.2
 * (`test/fixtures/demo/`, written by `tools/fixtures/demo-fixtures.ts`).
 */
export const DEMO_DIR = 'demo/';

/** The corpus path (for `fixturePath`) of a demo document. */
export function demoFixture(name: string): string {
  return `${DEMO_DIR}${name}`;
}

/** The tab name the app gives a file: its name without the extension. */
export function tabName(file: string): string {
  return basename(file).replace(/\.pdf$/i, '');
}

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

/** A file to drop: a demo document by name, or bytes the scene has (an exported file). */
export type DropSource = string | { readonly name: string; readonly bytes: Uint8Array };

interface DropWindow extends Window {
  __mediaDrop?: { end(): boolean };
}

export class Stage {
  readonly page: Page;
  readonly kind: SceneKind;
  readonly cursor: Cursor;
  readonly ghost: DragGhost;
  /** Set by the harness while a clip records (lib/scene.ts); cuts need it. */
  recorder: Recorder | undefined;

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
    // Exports go through the <a download> path (Firefox's and Safari's), which Playwright
    // can receive; the native save picker cannot be driven. The button reads "Download".
    await page.addInitScript(() => {
      Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
    });
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

  /**
   * Opens demo documents with the Open button, as the e2e tests do (no visible drag), and
   * waits for their tabs.
   */
  async openFixtures(names: readonly string[]): Promise<void> {
    const chooser = this.page.waitForEvent('filechooser');
    await this.page.getByRole('button', { name: 'Open files' }).first().click();
    // The files are made in the page, stamped with the fixed clock: a path would carry the
    // checkout's modification time and Playwright stamps bytes with the real one, and the
    // Info section shows the date.
    const files = await Promise.all(
      names.map(async (name) => ({
        name,
        base64: (await readFile(fixturePath(demoFixture(name)))).toString('base64'),
      })),
    );
    await (await chooser).element().evaluate(
      (input, { list, modified }) => {
        const data = new DataTransfer();
        for (const file of list) {
          const bytes = Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0));
          data.items.add(
            new File([bytes], file.name, { type: 'application/pdf', lastModified: modified }),
          );
        }
        (input as HTMLInputElement).files = data.files;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      },
      { list: files, modified: DEMO_TIME.getTime() },
    );
    for (const name of names) {
      await expect(this.page.getByRole('tab', { name: tabName(name), exact: true })).toBeVisible();
    }
  }

  /**
   * Long work, cut rather than sped up (spec §2.3): the clip stops recording, `work` runs
   * (it waits on the app's own signal), recording resumes, and a short caption says the
   * clip was shortened. `at` places the caption once the work is done (the screen has
   * changed by then); it stays up for `ms` while the scene goes on. Without a recorder
   * (stills), `work` simply runs.
   */
  async cut(
    work: () => Promise<void>,
    at: () => Promise<{ readonly x: number; readonly y: number }>,
    options: { readonly text?: string; readonly ms?: number } = {},
  ): Promise<void> {
    const recorder = this.recorder;
    recorder?.cutStart();
    try {
      await work();
    } finally {
      recorder?.cutEnd();
    }
    if (!recorder) return;
    // The caption is the first change after the cut, so the screencast sends a frame at once.
    await this.page.evaluate(showCaption, {
      ...(await at()),
      text: options.text ?? 'shortened',
      ms: options.ms ?? 1400,
    });
  }

  /**
   * Runs a command from the palette (Ctrl+K), as a person who knows its name would; for
   * settings made off camera, such as the light table's cell size.
   */
  async command(title: string): Promise<void> {
    await this.page.keyboard.press('ControlOrMeta+k');
    await this.page.getByRole('combobox', { name: 'Search commands' }).fill(title);
    await expect(
      this.page.getByRole('option', { name: new RegExp(`^${title}`), selected: true }),
    ).toBeVisible();
    await this.page.keyboard.press('Enter');
    await expect(this.page.getByRole('combobox', { name: 'Search commands' })).toHaveCount(0);
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
    sources: readonly DropSource[],
    to: { readonly x: number; readonly y: number },
    from: { readonly x: number; readonly y: number },
    ms = MOVE_MS,
  ): Promise<void> {
    const files: DroppedFile[] = await Promise.all(
      sources.map(async (source) =>
        typeof source === 'string'
          ? {
              name: basename(source),
              base64: (await readFile(fixturePath(demoFixture(source)))).toString('base64'),
            }
          : { name: source.name, base64: Buffer.from(source.bytes).toString('base64') },
      ),
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
 * Runs in the page: the "shortened" caption of a cut, a quiet pill centred on (x, y), in the
 * app's own tokens. It is the harness's, not the app's (`data-media`), like the cursor.
 */
function showCaption(args: { text: string; x: number; y: number; ms: number }): void {
  document.querySelector('[data-media="caption"]')?.remove();
  const pill = document.createElement('div');
  pill.dataset.media = 'caption';
  pill.setAttribute('aria-hidden', 'true');
  pill.textContent = args.text;
  Object.assign(pill.style, {
    position: 'fixed',
    left: `${args.x}px`,
    top: `${args.y}px`,
    translate: '-50% -50%',
    zIndex: '2147483645',
    pointerEvents: 'none',
    padding: '6px 14px',
    borderRadius: '999px',
    background: 'var(--surface-3)',
    border: '1px solid var(--border-strong)',
    color: 'var(--text-primary)',
    font: '500 15px/20px var(--font-sans)',
    letterSpacing: 'var(--tracking-ui)',
    whiteSpace: 'nowrap',
  });
  document.documentElement.append(pill);
  // The page's clock is fixed (Date), but its timers run.
  setTimeout(() => pill.remove(), args.ms);
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
