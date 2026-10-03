/**
 * The Edit-mode interaction policy on the mounted page view (craft spec §3.5, §10; Vitest
 * browser mode, PDFium): a double-click on page text with Select opens the text editor with
 * the caret at the point from a mouse or a pen used as a pointer, never from touch or a pen
 * that draws, and never in Read; Esc leaves without a change. The idle hover outline shows
 * after 400 ms, never within 300 ms of a pen stroke or from touch, with the one-time hint.
 * The pen draws in Select while "Pen draws in Edit" is on; its eraser end erases in any
 * tool. Holding Space pans. The Edit text and Image layers never take the page.
 *
 * Fixture: text-edit-fonts.pdf, whose first line (Helvetica, y = 700) is the sentence below.
 */
import { getActiveDocument, type VirtualDocument } from '@pdf-editor/document-model';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';

import fontsUrl from '../../../../test/fixtures/text-edit-fonts.pdf?url';
import { fixtureFile } from '../../test/store-harness';
import { createAnnotations } from '../annotations/actions';
import {
  type PageTarget,
  resetAnnotationStore,
  useAnnotationStore,
} from '../annotations/annotation-store';
import { readAnnotations, resetEditRunner, whenIdle } from '../annotations/edit-runner';
import { userToCss } from '../annotations/geometry';
import { mountedLayers } from '../annotations/layer-registry';
import { resetPenSession } from '../annotations/pen/ink-input';
import { registerAppCommands } from '../commands/app-commands';
import { useShortcuts } from '../commands/use-shortcuts';
import { getEngineService } from '../engine/engine-service';
import { ReadView } from '../stage/ReadView';
import {
  EDIT_POLICY_STORAGE_KEY,
  resetEditPolicyStore,
  useEditPolicyStore,
} from '../state/edit-policy-store';
import { useUiStore } from '../state/ui-store';
import { useViewStore } from '../state/view-store';
import { resetWorkspace, useWorkspaceStore } from '../state/workspace-store';
import { useTextEditStore } from '../text-edit/text-edit-store';
import { pointerLog } from './edit-policy';
import { HOVER_DELAY_MS } from './hit-order';
import { SPACE_PAN_ATTR } from './space-pan';
import { resetToolStore, useToolStore } from './tool-store';

const FOX = 'The quick brown fox jumps over the lazy dog';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function Harness({ doc }: { readonly doc: VirtualDocument }) {
  useShortcuts();
  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', height: 700 }}>
      <ReadView doc={doc} />
    </div>
  );
}

interface Mounted {
  readonly container: HTMLElement;
  readonly target: PageTarget;
}

async function mount(zoom = 0.75): Promise<Mounted> {
  await useWorkspaceStore.getState().openFiles([await fixtureFile(fontsUrl, 'fonts.pdf')]);
  const doc = getActiveDocument(useWorkspaceStore.getState().workspace) as VirtualDocument;
  const first = doc.pages[0];
  if (first?.ref.kind !== 'source') throw new Error('no source page');
  useUiStore.getState().setZoom(zoom);
  useViewStore.getState().setCurrentPage(0);
  const { container } = render(<Harness doc={doc} />);
  await waitFor(
    () => {
      if (!container.querySelector('[data-page-index="0"] canvas[data-state="rendered"]')) {
        throw new Error('page not rendered');
      }
    },
    { timeout: 10_000 },
  );
  return {
    container,
    target: { source: first.ref.source, pageIndex: 0, pageId: first.id, position: 1 },
  };
}

const enterEdit = () => {
  const id = useWorkspaceStore.getState().workspace.activeDocument;
  if (id !== undefined) useUiStore.getState().setDocumentMode(id, 'edit');
};

/** The text layer's span of the fixture's first line. */
async function foxSpan(container: HTMLElement): Promise<HTMLElement> {
  return waitFor(
    () => {
      const spans = container.querySelectorAll<HTMLElement>(
        '[data-page-index="0"] [data-testid="text-layer"] span',
      );
      const found = [...spans].find((s) => s.textContent === FOX);
      if (!found) throw new Error('no line yet');
      return found;
    },
    { timeout: 10_000 },
  );
}

function centre(element: Element): { x: number; y: number } {
  const box = element.getBoundingClientRect();
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
}

function pointer(
  type: string,
  at: { x: number; y: number },
  init: PointerEventInit = {},
): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: at.x,
    clientY: at.y,
    pointerId: 11,
    isPrimary: true,
    button: 0,
    buttons: 0,
    ...init,
  });
}

/** A press from `pointerType` on what is under the point, and its release. */
function tap(at: { x: number; y: number }, pointerType: string, init: PointerEventInit = {}) {
  const element = document.elementFromPoint(at.x, at.y) ?? document.body;
  element.dispatchEvent(pointer('pointerdown', at, { pointerType, buttons: 1, ...init }));
  window.dispatchEvent(pointer('pointerup', at, { pointerType, ...init }));
}

/** A double-click event (it carries no pointer type: the last press says which). */
function doubleClick(element: Element, at = centre(element)): void {
  element.dispatchEvent(
    new MouseEvent('dblclick', {
      bubbles: true,
      cancelable: true,
      clientX: at.x,
      clientY: at.y,
      detail: 2,
    }),
  );
}

/** The open editor: the line editor's field or the paragraph editor's mirror. */
const editorInput = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-text-edit-input], [data-paragraph-mirror]');
const outline = (container: HTMLElement) =>
  container.querySelector('[data-testid="text-hover-outline"]');

describe('the Edit policy (mounted)', () => {
  let disposeCommands: () => void = () => undefined;
  beforeAll(() => {
    disposeCommands = registerAppCommands();
  });
  afterAll(() => {
    disposeCommands();
  });
  beforeEach(() => {
    resetWorkspace();
    resetEditRunner();
    resetAnnotationStore();
    resetToolStore();
    resetPenSession();
    resetEditPolicyStore({ penDrawsInEdit: false });
    pointerLog.lastDownType = '';
    pointerLog.lastPenUpAt = Number.NEGATIVE_INFINITY;
    useTextEditStore.getState().close();
    useUiStore.setState({ destination: 'document', viewMode: 'read', documentMode: {} });
  });
  afterEach(async () => {
    cleanup();
    window.getSelection()?.removeAllRanges();
    await whenIdle();
    resetWorkspace();
    resetToolStore();
    resetPenSession();
    resetEditPolicyStore();
    localStorage.removeItem(EDIT_POLICY_STORAGE_KEY);
  });

  it('a mouse double-click on page text opens the editor with the caret there; Esc leaves it unchanged', async () => {
    const { container, target } = await mount();
    enterEdit();
    const span = await foxSpan(container);
    const before = getEngineService().pageRevision(target.source, 0);

    await userEvent.dblClick(span);
    const input = await waitFor(
      () => {
        const field = editorInput(container);
        if (!field) throw new Error('no editor');
        return field;
      },
      { timeout: 10_000 },
    );
    await waitFor(() => expect(document.activeElement).toBe(input), { timeout: 5000 });
    const paragraph = useTextEditStore.getState().paragraph;
    if (input instanceof HTMLInputElement) {
      // The line editor: a caret at the point (the middle of the line), nothing selected.
      expect(input.value).toBe(FOX);
      expect(input.selectionStart).toBe(input.selectionEnd);
      expect(input.selectionStart).toBeGreaterThan(FOX.length * 0.25);
      expect(input.selectionStart).toBeLessThan(FOX.length * 0.75);
    } else {
      // The paragraph editor (the line is part of a detected paragraph): its caret starts
      // inside the clicked line, near the middle of it.
      if (!paragraph) throw new Error('no paragraph session');
      const line = paragraph.block.text.indexOf(FOX);
      expect(line).toBeGreaterThanOrEqual(0);
      expect(paragraph.caret).toBeGreaterThan(line + FOX.length * 0.25);
      expect(paragraph.caret).toBeLessThan(line + FOX.length * 0.75);
      // No idle hover outline over an open paragraph editor.
      span.dispatchEvent(pointer('pointermove', centre(span), { pointerType: 'mouse' }));
      await sleep(HOVER_DELAY_MS + 200);
      expect(outline(container)).toBeNull();
    }
    expect(useToolStore.getState().mode).toBe('select');
    // The first double-click retires the hint for good.
    expect(useEditPolicyStore.getState().editTextHintShown).toBe(true);

    input.focus();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(editorInput(container)).toBeNull(), { timeout: 5000 });
    await whenIdle();
    expect(getEngineService().pageRevision(target.source, 0)).toBe(before);
    expect(useTextEditStore.getState().session).toBeNull();
    expect(useTextEditStore.getState().paragraph).toBeNull();
  });

  it('in Read a double-click selects a word and never opens the editor', async () => {
    const { container } = await mount();
    const span = await foxSpan(container);
    await userEvent.dblClick(span);
    await sleep(400);
    expect(editorInput(container)).toBeNull();
    expect(useTextEditStore.getState().session).toBeNull();
    expect(window.getSelection()?.toString().trim().length).toBeGreaterThan(0);
  });

  it('never from touch, never from a pen that draws; a pen used as a pointer opens it', async () => {
    const { container } = await mount();
    enterEdit();
    const span = await foxSpan(container);
    const at = centre(span);

    tap(at, 'touch');
    tap(at, 'touch');
    doubleClick(span, at);
    await sleep(400);
    expect(editorInput(container)).toBeNull();

    // "Pen draws in Edit": the pen's presses draw; its double-click opens nothing.
    useEditPolicyStore.getState().setPenDrawsInEdit(true);
    await waitFor(() => expect(container.querySelector('[data-pen-proxy]')).not.toBeNull());
    await sleep(50);
    // (Left of the middle: the dots it draws there are annotations, first in the hit order.)
    const left = { x: span.getBoundingClientRect().left + 30, y: at.y };
    tap(left, 'pen', { pressure: 0.5, pointerId: 21 });
    tap(left, 'pen', { pressure: 0.5, pointerId: 21 });
    doubleClick(span, left);
    await sleep(400);
    expect(editorInput(container)).toBeNull();
    expect(useTextEditStore.getState().session).toBeNull();

    // Off: the pen is a pointer, and its double-click opens the editor.
    useEditPolicyStore.getState().setPenDrawsInEdit(false);
    await sleep(50);
    tap(at, 'pen', { pressure: 0.5, pointerId: 22 });
    doubleClick(span, at);
    await waitFor(() => expect(editorInput(container)).not.toBeNull(), { timeout: 10_000 });
  });

  it('the idle hover outline after 400 ms, never within 300 ms of a pen stroke, never touch; the hint once', async () => {
    const { container } = await mount();
    enterEdit();
    const span = await foxSpan(container);
    const at = centre(span);
    const overlays = span.closest('[data-page-overlays]') as HTMLElement;
    await sleep(50);

    const started = performance.now();
    span.dispatchEvent(pointer('pointermove', at, { pointerType: 'mouse' }));
    await sleep(HOVER_DELAY_MS / 2);
    expect(outline(container)).toBeNull();
    await waitFor(() => expect(outline(container)).not.toBeNull(), { timeout: 2000 });
    expect(performance.now() - started).toBeGreaterThanOrEqual(HOVER_DELAY_MS - 20);
    // The outline is the run's box; the hint shows with it, as a polite status.
    const box = (outline(container) as HTMLElement).getBoundingClientRect();
    const line = span.getBoundingClientRect();
    expect(Math.abs(box.left - line.left)).toBeLessThan(2);
    expect(Math.abs(box.width - line.width)).toBeLessThan(2);
    const status = container.querySelector('[data-text-hover] [role="status"]');
    expect(status).toHaveTextContent('Double-click to edit text');

    // A press hides it; touch never brings it back.
    overlays.dispatchEvent(pointer('pointerdown', at, { pointerType: 'mouse', buttons: 1 }));
    window.dispatchEvent(pointer('pointerup', at, { pointerType: 'mouse' }));
    await waitFor(() => expect(outline(container)).toBeNull());
    span.dispatchEvent(pointer('pointermove', at, { pointerType: 'touch' }));
    await sleep(HOVER_DELAY_MS + 200);
    expect(outline(container)).toBeNull();

    // Within 300 ms of a pen leaving the surface: no outline from that move.
    window.dispatchEvent(pointer('pointerup', at, { pointerType: 'pen', pointerId: 31 }));
    span.dispatchEvent(pointer('pointermove', at, { pointerType: 'pen' }));
    await sleep(HOVER_DELAY_MS + 200);
    expect(outline(container)).toBeNull();
    // Later, a hovering pen shows it.
    span.dispatchEvent(pointer('pointermove', at, { pointerType: 'pen' }));
    await waitFor(() => expect(outline(container)).not.toBeNull(), { timeout: 2000 });

    // After the first double-click the hint never shows again; the outline still does.
    useEditPolicyStore.getState().markEditTextHintShown();
    await waitFor(() =>
      expect(container.querySelector('[data-text-hover] [role="status"]')).toBeNull(),
    );
    expect(container.textContent).not.toContain('Double-click to edit text');

    // With Edit text armed, over its run targets: the outline, and no double-click hint.
    useToolStore.getState().setMode('edit-text');
    const run = await waitFor(
      () => {
        const r = container.querySelector(`[data-text-edit-layer="0"] [data-text-run="${FOX}"]`);
        if (!r) throw new Error('no run targets');
        return r;
      },
      { timeout: 10_000 },
    );
    // Off the page: gone.
    document.body.dispatchEvent(pointer('pointermove', { x: 1, y: 1 }, { pointerType: 'mouse' }));
    await waitFor(() => expect(outline(container)).toBeNull());
    run.dispatchEvent(pointer('pointermove', centre(run), { pointerType: 'mouse' }));
    await waitFor(() => expect(outline(container)).not.toBeNull(), { timeout: 2000 });
  });

  it('with "Pen draws in Edit" the pen draws in Select and never reaches the text', async () => {
    resetEditPolicyStore({ penDrawsInEdit: true });
    const { container, target } = await mount();
    enterEdit();
    const span = await foxSpan(container);
    await waitFor(() => expect(container.querySelector('[data-pen-proxy]')).not.toBeNull());
    await sleep(50);
    const box = span.getBoundingClientRect();
    const y = box.top + box.height / 2;
    const start = { x: box.left + box.width * 0.2, y };
    const element = document.elementFromPoint(start.x, start.y) as Element;
    element.dispatchEvent(
      pointer('pointerdown', start, {
        pointerType: 'pen',
        buttons: 1,
        pressure: 0.5,
        pointerId: 41,
      }),
    );
    for (let i = 1; i <= 8; i++) {
      window.dispatchEvent(
        pointer(
          'pointermove',
          { x: start.x + i * 12, y: y + (i % 2) * 3 },
          { pointerType: 'pen', buttons: 1, pressure: 0.5, pointerId: 41 },
        ),
      );
      await sleep(8);
    }
    window.dispatchEvent(
      pointer(
        'pointerup',
        { x: start.x + 96, y },
        { pointerType: 'pen', pressure: 0, pointerId: 41 },
      ),
    );
    await waitFor(
      async () => {
        const inks = (await readAnnotations(target.source, 0)).filter((a) => a.kind === 'ink');
        expect(inks).toHaveLength(1);
      },
      { timeout: 10_000 },
    );
    expect(useToolStore.getState().mode).toBe('select');
    expect(editorInput(container)).toBeNull();
    expect(window.getSelection()?.toString() ?? '').toBe('');
  });

  it("the pen's eraser end is a temporary eraser in any tool", async () => {
    const { container, target } = await mount();
    enterEdit();
    await foxSpan(container);
    const path = [0, 20, 40, 60].map((dx) => ({ x: 100 + dx, y: 400 }));
    await createAnnotations(target, [
      {
        kind: 'ink',
        pageIndex: 0,
        rect: { x: 0, y: 0, width: 1, height: 1 },
        color: '#1F1F1F',
        opacity: 1,
        strokeWidth: 2,
        paths: [path],
        widths: [path.map(() => 2)],
      },
    ]);
    await waitFor(async () =>
      expect((await readAnnotations(target.source, 0)).some((a) => a.kind === 'ink')).toBe(true),
    );
    useAnnotationStore.getState().select(null);
    // Any tool: here Edit text, which otherwise ignores annotations.
    useToolStore.getState().setMode('edit-text');
    const layer = mountedLayers.get(target.pageId);
    if (!layer) throw new Error('no layer');
    const origin = layer.element.getBoundingClientRect();
    const client = (p: { x: number; y: number }) => {
      const css = userToCss(layer.frame, p);
      return { x: origin.left + css.x, y: origin.top + css.y };
    };
    const first = client(path[0] as { x: number; y: number });
    const eraser = { pointerType: 'pen', pointerId: 51, button: 5, buttons: 32 } as const;
    (document.elementFromPoint(first.x, first.y) as Element).dispatchEvent(
      pointer('pointerdown', first, eraser),
    );
    for (const p of path.slice(1)) {
      window.dispatchEvent(pointer('pointermove', client(p), { ...eraser, button: -1 }));
    }
    window.dispatchEvent(pointer('pointerup', client(path[3] as { x: number; y: number }), eraser));
    await waitFor(
      async () =>
        expect((await readAnnotations(target.source, 0)).some((a) => a.kind === 'ink')).toBe(false),
      { timeout: 10_000 },
    );
    expect(useToolStore.getState().mode).toBe('edit-text');
    expect(editorInput(container)).toBeNull();
  });

  it('holding Space pans the pages with the grab cursor; a tap still moves a screen', async () => {
    const { container } = await mount(2);
    enterEdit();
    const span = await foxSpan(container);
    const viewport = container.querySelector<HTMLElement>('[data-read-viewport]');
    if (!viewport) throw new Error('no viewport');
    viewport.focus();
    viewport.scrollTop = 200;
    const top = viewport.scrollTop;

    await userEvent.keyboard('{Space>}');
    expect(viewport.hasAttribute(SPACE_PAN_ATTR)).toBe(true);
    expect(getComputedStyle(span).cursor).toBe('grab');
    const at = centre(viewport);
    const element = document.elementFromPoint(at.x, at.y) as Element;
    element.dispatchEvent(pointer('pointerdown', at, { pointerType: 'mouse', buttons: 1 }));
    window.dispatchEvent(
      pointer('pointermove', { x: at.x, y: at.y - 120 }, { pointerType: 'mouse', buttons: 1 }),
    );
    window.dispatchEvent(
      pointer('pointerup', { x: at.x, y: at.y - 120 }, { pointerType: 'mouse' }),
    );
    expect(viewport.scrollTop).toBeCloseTo(top + 120, 0);
    await userEvent.keyboard('{/Space}');
    expect(viewport.hasAttribute(SPACE_PAN_ATTR)).toBe(false);
    // The drag was the pan's: no screen step on release, nothing selected or opened.
    expect(viewport.scrollTop).toBeCloseTo(top + 120, 0);
    expect(useAnnotationStore.getState().selection).toBeNull();
    expect(editorInput(container)).toBeNull();

    const before = viewport.scrollTop;
    await userEvent.keyboard(' ');
    await waitFor(() => expect(viewport.scrollTop).toBeGreaterThan(before + 200));
  });

  it('the Edit text and Image layers let the pointer through; only their targets are live', async () => {
    const { container } = await mount();
    enterEdit();
    await foxSpan(container);
    useToolStore.getState().setMode('edit-text');
    const layer = await waitFor(() => {
      const l = container.querySelector<HTMLElement>('[data-text-edit-layer="0"]');
      if (!l?.querySelector('[data-text-run]')) throw new Error('no runs');
      return l;
    });
    expect(getComputedStyle(layer).pointerEvents).toBe('none');
    const run = layer.querySelector('[data-text-run]') as HTMLElement;
    expect(getComputedStyle(run).pointerEvents).toBe('auto');
    // Annotations are not live with Edit text (the one hit order).
    expect(
      [...container.querySelectorAll<SVGElement>('[data-annotation-id]')].every(
        (hit) => getComputedStyle(hit).pointerEvents === 'none',
      ),
    ).toBe(true);

    useToolStore.getState().setMode('image');
    const images = await waitFor(() => {
      const l = container.querySelector<HTMLElement>('[data-image-layer="0"]');
      if (!l) throw new Error('no image layer');
      return l;
    });
    expect(getComputedStyle(images).pointerEvents).toBe('none');
  });
});
