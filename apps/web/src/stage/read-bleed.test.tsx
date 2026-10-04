/**
 * The full-bleed Read view (craft spec §7; Vitest browser mode, Chromium, real PDFium): inside
 * a shell with a title bar, navigator, inspector and status bar, the page viewport covers the
 * whole shell while the fitted page and its centring use the rectangle the panels leave free,
 * and a panel resize re-fits. The stand-in scroll bars follow the viewport both ways, and pages
 * pass under the title bar and the status bar (the top and bottom insets are scroll padding).
 */
import '../styles/tokens.css';
import '../styles/reset.css';
import '../styles/global.css';

import type { VirtualDocument } from '@pdf-editor/document-model';
import { render, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';

import manyPagesUrl from '../../../../test/fixtures/many-pages.pdf?url';
import { openDocuments } from '../commands/app-commands';
import { DEFAULT_APPEARANCE, useAppearanceStore } from '../state/appearance-store';
import { useSelectionStore } from '../state/selection-store';
import { useUiStore } from '../state/ui-store';
import { useViewStore } from '../state/view-store';
import { resetWorkspace, useWorkspaceStore } from '../state/workspace-store';
import { ReadView } from './ReadView';
import { scrollbarSize } from './stage-bleed';

const SHELL = { width: 1200, height: 800 };
const TITLE = 40;
const HEADER = 48;
const STATUS = 28;
const RIGHT = 300;
/** PAD_X in ReadView: the fitted page keeps this much canvas on either side. */
const PAD_X = 48;

function activeDocument(): VirtualDocument {
  const { workspace } = useWorkspaceStore.getState();
  const doc = workspace.documents[workspace.documentOrder[0] ?? ('' as never)];
  if (!doc) throw new Error('not opened');
  return doc;
}

/** The app shell's layout in miniature: the Read view sits in the stage below its header. */
function Shell({ doc, left }: { readonly doc: VirtualDocument; readonly left: number }) {
  return (
    <div
      data-stage-bleed=""
      data-testid="shell"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: SHELL.width,
        height: SHELL.height,
        display: 'grid',
        gridTemplateColumns: `${left}px minmax(0, 1fr) ${RIGHT}px`,
        gridTemplateRows: `${TITLE}px minmax(0, 1fr) ${STATUS}px`,
        isolation: 'isolate',
      }}
    >
      <header style={{ gridColumn: '1 / -1', zIndex: 1, background: '#181a1f' }} />
      <aside data-region="navigator" style={{ zIndex: 1, background: '#181a1f' }} />
      <main
        style={{ position: 'relative', display: 'flex', flexDirection: 'column', minHeight: 0 }}
      >
        <div style={{ flex: 'none', height: HEADER }} />
        <ReadView doc={doc} />
      </main>
      <aside id="right-panel" style={{ zIndex: 1, background: '#181a1f' }} />
      <footer style={{ gridColumn: '1 / -1', zIndex: 1, background: '#181a1f' }} />
    </div>
  );
}

const viewportOf = (container: HTMLElement) => {
  const el = container.querySelector<HTMLElement>('[data-read-viewport]');
  if (!el) throw new Error('no viewport');
  return el;
};

const firstPage = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-read-viewport] [data-page-index="0"]');

describe('Read mode: full-bleed stage', () => {
  beforeAll(async () => {
    await page.viewport(1280, 900);
    resetWorkspace();
    useSelectionStore.getState().apply({ selected: new Set(), anchor: null, focused: null });
    const bytes = await (await fetch(manyPagesUrl)).arrayBuffer();
    await openDocuments([new File([bytes], 'many-pages.pdf', { type: 'application/pdf' })]);
  });
  afterEach(() => {
    useAppearanceStore.setState(DEFAULT_APPEARANCE);
  });
  afterAll(() => {
    resetWorkspace();
  });

  it('covers the shell and fits the page to the rectangle the panels leave free', async () => {
    useUiStore.getState().zoomFit();
    useViewStore.getState().setCurrentPage(0);
    const { container, rerender } = render(<Shell doc={activeDocument()} left={200} />);
    const viewport = viewportOf(container);
    const bar = scrollbarSize();

    // The viewport runs under every panel: it is the shell's rectangle.
    const shellRect = container.querySelector('[data-testid="shell"]')?.getBoundingClientRect();
    const rect = viewport.getBoundingClientRect();
    expect([rect.left, rect.top, rect.width, rect.height]).toEqual([
      shellRect?.left,
      shellRect?.top,
      SHELL.width,
      SHELL.height,
    ]);

    // The fitted page fills the free width (less the side padding and the stand-in bar) and
    // is centred in it, not in the shell.
    const fitted = async (left: number) => {
      const free = SHELL.width - left - RIGHT - bar;
      await waitFor(() => {
        const sheet = firstPage(container)?.getBoundingClientRect();
        expect(sheet).toBeDefined();
        expect(Math.abs((sheet?.width ?? 0) - (free - 2 * PAD_X))).toBeLessThanOrEqual(1);
        expect(Math.abs((sheet?.left ?? 0) - (left + PAD_X))).toBeLessThanOrEqual(1);
        // Below the title bar and the stage header, with the top padding.
        expect(Math.abs((sheet?.top ?? 0) - (TITLE + HEADER + 16))).toBeLessThanOrEqual(1);
      });
      return useUiStore.getState().zoom;
    };
    const wide = await fitted(200);

    // A wider navigator shrinks the fit rectangle by its width, and the page re-fits.
    rerender(<Shell doc={activeDocument()} left={320} />);
    const narrow = await fitted(320);
    expect(narrow).toBeLessThan(wide);
    // The scale follows the free width exactly.
    const ratio =
      (SHELL.width - 320 - RIGHT - bar - 2 * PAD_X) / (SHELL.width - 200 - RIGHT - bar - 2 * PAD_X);
    expect(narrow / wide).toBeCloseTo(ratio, 2);
  }, 60_000);

  it('keeps stand-in scroll bars in the free rectangle, in step with the viewport', async () => {
    useUiStore.getState().zoomFit();
    const { container } = render(<Shell doc={activeDocument()} left={200} />);
    const viewport = viewportOf(container);
    await waitFor(() => expect(firstPage(container)).not.toBeNull());
    const proxy = await waitFor(() => {
      const el = container.querySelector<HTMLElement>('[data-scroll-proxy="vertical"]');
      if (!el) throw new Error('no vertical bar');
      return el;
    });
    const bar = proxy.getBoundingClientRect();
    // At the free rectangle's right edge, from below the stage header to above the status bar.
    expect(bar.right).toBeCloseTo(SHELL.width - RIGHT, 0);
    expect(bar.top).toBeCloseTo(TITLE + HEADER, 0);
    expect(bar.bottom).toBeCloseTo(SHELL.height - STATUS, 0);
    // The same range as the viewport.
    expect(proxy.scrollHeight - proxy.clientHeight).toBeCloseTo(
      viewport.scrollHeight - viewport.clientHeight,
      0,
    );

    viewport.scrollTop = 400;
    await waitFor(() => expect(proxy.scrollTop).toBeCloseTo(400, 0));
    proxy.scrollTop = 900;
    await waitFor(() => expect(viewport.scrollTop).toBeCloseTo(900, 0));
  }, 60_000);

  it('lets pages pass under the title bar and the status bar at fit width (review F7)', async () => {
    useUiStore.getState().zoomFit();
    const { container } = render(<Shell doc={activeDocument()} left={200} />);
    const viewport = viewportOf(container);
    await waitFor(() => expect(firstPage(container)).not.toBeNull());
    // The top and bottom insets are scroll padding, not a smaller viewport.
    const style = getComputedStyle(viewport);
    expect(Number.parseFloat(style.scrollPaddingTop)).toBe(TITLE + HEADER);
    expect(Number.parseFloat(style.scrollPaddingBottom)).toBeGreaterThanOrEqual(STATUS);
    const shellBox = container.querySelector('[data-testid="shell"]')?.getBoundingClientRect();
    const box = viewport.getBoundingClientRect();
    expect(box.top).toBeCloseTo(shellBox?.top ?? 0, 0);
    expect(box.bottom).toBeCloseTo(shellBox?.bottom ?? 0, 0);
    // At rest the first page sits clear of the title bar and the stage header…
    await waitFor(() => {
      const top = firstPage(container)?.getBoundingClientRect().top ?? 0;
      expect(Math.abs(top - (TITLE + HEADER + 16))).toBeLessThanOrEqual(1);
    });
    // …the pages run on under the status bar; scrolled, the first one's top edge passes under
    // the title bar.
    const pages = [
      ...container.querySelectorAll<HTMLElement>('[data-read-viewport] [data-page-index]'),
    ].map((el) => el.getBoundingClientRect());
    expect(pages.some((r) => r.top < SHELL.height && r.bottom > SHELL.height - STATUS)).toBe(true);
    viewport.scrollTop = 120;
    await waitFor(() =>
      expect(firstPage(container)?.getBoundingClientRect().top ?? 0).toBeLessThan(TITLE),
    );
  }, 60_000);
});
