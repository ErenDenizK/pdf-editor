/**
 * Read mode on resized pages (Vitest browser mode, Chromium, real PDFium): annotations.pdf
 * page 1 resized to A4 (fit) and to a larger canvas, at all four rotations. The page sheet
 * takes the new displayed size, the bitmap sits at the content placement, and the overlays
 * (annotation hit targets, text layer) are mapped through the resized frame: the pixel of
 * the rendered bitmap under the square's and the highlight's hit targets is their colour,
 * and the margin next to the content is blank paper.
 */
import '../styles/tokens.css';
import '../styles/reset.css';
import '../styles/global.css';

import {
  type PageId,
  PAPER_SIZES,
  pageDisplaySize,
  type ResizeRequest,
  resizePages,
  rotatePages,
} from '@pdf-editor/document-model';
import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';

import annotationsUrl from '../../../../test/fixtures/annotations.pdf?url';
import { App } from '../app';
import { openDocuments } from '../commands/app-commands';
import { useSelectionStore } from '../state/selection-store';
import { useUiStore } from '../state/ui-store';
import { resetWorkspace, useWorkspaceStore } from '../state/workspace-store';

const model = () => useWorkspaceStore.getState();
const A4 = PAPER_SIZES.a4;

/** RGBA of the rendered page bitmap under a client point. */
function pixelAt(canvas: HTMLCanvasElement, x: number, y: number): [number, number, number] {
  const rect = canvas.getBoundingClientRect();
  const cx = Math.floor(((x - rect.left) * canvas.width) / rect.width);
  const cy = Math.floor(((y - rect.top) * canvas.height) / rect.height);
  const data = canvas.getContext('2d')?.getImageData(cx, cy, 1, 1).data;
  return [data?.[0] ?? 0, data?.[1] ?? 0, data?.[2] ?? 0];
}

const white = ([r, g, b]: [number, number, number]) => r > 245 && g > 245 && b > 245;

function centre(el: Element): { x: number; y: number } {
  const box = el.getBoundingClientRect();
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
}

describe('Read mode: resized pages', () => {
  let pageId: PageId;

  beforeAll(async () => {
    await page.viewport(1280, 1000);
    resetWorkspace();
    useSelectionStore.getState().apply({ selected: new Set(), anchor: null, focused: null });
    useUiStore.setState({ viewMode: 'read', paletteOpen: false });
    const bytes = await (await fetch(annotationsUrl)).arrayBuffer();
    await openDocuments([new File([bytes], 'annotations.pdf', { type: 'application/pdf' })]);
    const doc = model().workspace.documents[model().workspace.documentOrder[0] ?? ('' as never)];
    const first = doc?.pages[0];
    if (!first) throw new Error('not opened');
    pageId = first.id;
    useUiStore.getState().setZoom(0.75);
  });
  // Testing Library unmounts after every test: mount the app for each case.
  beforeEach(() => {
    render(<App />);
  });
  afterEach(() => {
    // Back to the unresized, unrotated page for the next case.
    model().applyOperation((ws) => {
      const current = ws.documents[ws.documentOrder[0] ?? ('' as never)]?.pages[0];
      let next = resizePages(ws, [pageId], undefined);
      if (current && current.rotation !== 0) next = rotatePages(next, [pageId], -current.rotation);
      return next;
    }, 'reset');
  });

  const requests: readonly [string, ResizeRequest][] = [
    ['A4 fit', { ...A4, mode: 'fit', anchor: 'center' }],
    ['canvas 800 × 900', { width: 800, height: 900, mode: 'canvas', anchor: 'top-left' }],
  ];
  for (const [name, request] of requests) {
    for (const rotation of [0, 90, 180, 270] as const) {
      it(`${name} at ${rotation}°: bitmap and overlays line up`, async () => {
        const turned =
          rotation % 180 === 0
            ? request
            : { ...request, width: request.height, height: request.width };
        model().applyOperation(
          (ws) => resizePages(rotatePages(ws, [pageId], rotation), [pageId], turned),
          'resize',
        );
        const ws = model().workspace;
        const vp = ws.documents[ws.documentOrder[0] ?? ('' as never)]?.pages[0];
        if (!vp) throw new Error('page gone');
        expect(vp.resize).toBeDefined();

        const sheet = await waitFor(() => {
          const el = document.querySelector<HTMLElement>('[data-page-index="0"][data-resized]');
          if (!el) throw new Error('no resized sheet');
          return el;
        });
        const shown = pageDisplaySize(ws, vp);
        const box = sheet.getBoundingClientRect();
        expect(box.width / box.height).toBeCloseTo(shown.width / shown.height, 2);

        const canvas = sheet.querySelector<HTMLCanvasElement>('[data-resized] canvas');
        if (!canvas) throw new Error('no canvas');
        const revision = `:${rotation}@`;
        await waitFor(
          () => {
            expect(canvas.dataset.state).toBe('rendered');
            expect(canvas.dataset.revision).toContain(revision);
          },
          { timeout: 10_000 },
        );
        const square = await waitFor(() => {
          const el = sheet.querySelector('[data-annotation-id="fixture-annot-square-1"]');
          if (!el) throw new Error('square hit target missing');
          return el;
        });
        const highlight = sheet.querySelector('[data-annotation-id="fixture-annot-highlight-1"]');
        if (!highlight) throw new Error('highlight hit target missing');

        // Under the square's hit target: its interior colour, not paper.
        const at = centre(square);
        expect(white(pixelAt(canvas, at.x, at.y)), 'square interior').toBe(false);
        // Under the highlight: the highlight colour (yellow multiplies to low blue).
        const h = centre(highlight);
        const [, , blue] = pixelAt(canvas, h.x, h.y);
        expect(blue, 'highlight colour').toBeLessThan(200);
        // The text layer's first line sits over the page text, inside the sheet.
        const line = sheet.querySelector('[data-text-layer] [data-row]');
        if (line) {
          const l = line.getBoundingClientRect();
          expect(l.left).toBeGreaterThanOrEqual(box.left - 1);
          expect(l.right).toBeLessThanOrEqual(box.right + 1);
        }
        // The sheet's paper outside the content box (the canvas mode's margin) is blank.
        const content = canvas.getBoundingClientRect();
        const margins = [
          content.left - box.left,
          box.right - content.right,
          content.top - box.top,
          box.bottom - content.bottom,
        ];
        expect(Math.max(...margins)).toBeGreaterThan(4);
        if (request.mode === 'canvas') {
          // Anchored at the displayed top-left corner, whatever the rotation.
          expect(Math.abs(margins[0] ?? 99)).toBeLessThan(1);
          expect(Math.abs(margins[2] ?? 99)).toBeLessThan(1);
        }
      }, 30_000);
    }
  }
});
