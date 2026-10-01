/**
 * Read mode across window resizes (Vitest browser mode, Chromium, real PDFium): with the
 * zoom fitted to the width, 1440 → 1024 → 1440 px keeps the view where it was read from.
 *
 * Regression (M6 review): the fitted zoom kept the point under the viewport centre in place,
 * so a page read from its top came back scrolled down by a third of a screen and
 * `outline-named-dests.pdf`'s page 1, whose only text is a heading at its top, showed blank
 * although its canvas was rendered.
 */
import '../styles/tokens.css';
import '../styles/reset.css';
import '../styles/global.css';

import type { VirtualDocument } from '@pdf-editor/document-model';
import { render, waitFor } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';

import outlineUrl from '../../../../test/fixtures/outline-named-dests.pdf?url';
import { openDocuments } from '../commands/app-commands';
import { useSelectionStore } from '../state/selection-store';
import { useUiStore } from '../state/ui-store';
import { useViewStore } from '../state/view-store';
import { resetWorkspace, useWorkspaceStore } from '../state/workspace-store';
import { ReadView } from './ReadView';

function activeDocument(): VirtualDocument {
  const { workspace } = useWorkspaceStore.getState();
  const doc = workspace.documents[workspace.documentOrder[0] ?? ('' as never)];
  if (!doc) throw new Error('not opened');
  return doc;
}

const viewport = (container: HTMLElement) => {
  const el = container.querySelector<HTMLElement>('[data-read-viewport]');
  if (!el) throw new Error('no viewport');
  return el;
};

/** Page 1's canvas once it shows a bitmap at the current scale. */
const firstCanvas = (container: HTMLElement) =>
  container.querySelector<HTMLCanvasElement>(
    '[data-read-viewport] [data-page-index="0"] canvas[data-state="rendered"]',
  );

/** Non-white pixels of page 1's bitmap inside the part of the page the viewport shows. */
function visibleInk(container: HTMLElement): number {
  const canvas = firstCanvas(container);
  if (!canvas) return 0;
  const sheet = canvas.getBoundingClientRect();
  const view = viewport(container).getBoundingClientRect();
  const top = Math.max(sheet.top, view.top);
  const bottom = Math.min(sheet.bottom, view.bottom);
  const left = Math.max(sheet.left, view.left);
  const right = Math.min(sheet.right, view.right);
  if (bottom <= top || right <= left) return 0;
  const ratio = canvas.width / sheet.width;
  const x = Math.floor((left - sheet.left) * ratio);
  const y = Math.floor((top - sheet.top) * ratio);
  const w = Math.max(1, Math.floor((right - left) * ratio));
  const h = Math.max(1, Math.floor((bottom - top) * ratio));
  const data = canvas.getContext('2d')?.getImageData(x, y, w, h).data;
  let ink = 0;
  for (let i = 0; data && i < data.length; i += 4) {
    if ((data[i] ?? 255) < 160 && (data[i + 1] ?? 255) < 160) ink++;
  }
  return ink;
}

/** Waits for the fitted zoom to follow a new window width and page 1 to render at it. */
async function resizeTo(container: HTMLElement, width: number): Promise<void> {
  const before = useUiStore.getState().zoom;
  await page.viewport(width, 900);
  await waitFor(() => expect(useUiStore.getState().zoom).not.toBe(before));
  await waitFor(
    () => {
      const canvas = firstCanvas(container);
      expect(canvas).not.toBeNull();
      expect(canvas?.width).toBe(
        Math.round(canvas?.getBoundingClientRect().width ?? 0) * (window.devicePixelRatio || 1),
      );
    },
    { timeout: 10_000 },
  );
}

describe('Read mode: fitted zoom across window resizes', () => {
  beforeAll(async () => {
    await page.viewport(1440, 900);
    resetWorkspace();
    useSelectionStore.getState().apply({ selected: new Set(), anchor: null, focused: null });
    const bytes = await (await fetch(outlineUrl)).arrayBuffer();
    await openDocuments([
      new File([bytes], 'outline-named-dests.pdf', { type: 'application/pdf' }),
    ]);
  });
  afterAll(() => {
    resetWorkspace();
  });

  it('keeps page 1 read from its top through 1440 → 1024 → 1440 px', async () => {
    useUiStore.getState().zoomFit();
    useViewStore.getState().setCurrentPage(0);
    const { container } = render(
      <div style={{ display: 'flex', flexDirection: 'column', height: 860 }}>
        <ReadView doc={activeDocument()} />
      </div>,
    );
    await waitFor(() => expect(firstCanvas(container)).not.toBeNull(), { timeout: 20_000 });
    const ink = visibleInk(container);
    expect(ink).toBeGreaterThan(0);

    await resizeTo(container, 1024);
    expect(viewport(container).scrollTop).toBe(0);
    expect(visibleInk(container)).toBeGreaterThan(0);

    await resizeTo(container, 1440);
    expect(viewport(container).scrollTop).toBe(0);
    // The heading is back in view, as much of it as before the resizes.
    expect(visibleInk(container)).toBe(ink);
  }, 60_000);
});
