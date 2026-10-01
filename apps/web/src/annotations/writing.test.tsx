/**
 * Writing is never interrupted (experience-redesign spec §6.1, P1), in the mounted Read
 * view (Vitest browser mode, Chromium, real PDFium): a committed stroke selects nothing
 * and opens no bar; its preview stays until the page canvas has painted the committing
 * generation; a failed commit drops the preview and says so; a press while an inline
 * editor is open commits the editor and draws in the same press; arming the pen uses the
 * persisted style.
 */
import '../styles/tokens.css';
import '../styles/reset.css';
import '../styles/global.css';
import './index';

import { getActiveDocument, type VirtualDocument } from '@pdf-editor/document-model';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';

import simpleUrl from '../../../../test/fixtures/simple-text.pdf?url';
import { fixtureFile } from '../../test/store-harness';
import { getEngineService } from '../engine/engine-service';
import { m } from '../i18n';
import { useAnnouncer } from '../shell/announcer';
import { ReadView } from '../stage/ReadView';
import { useUiStore } from '../state/ui-store';
import { useViewStore } from '../state/view-store';
import { resetWorkspace, useWorkspaceStore } from '../state/workspace-store';
import { documentFingerprint, POSITIONS_KEY, rememberPosition } from '../viewer/navigation';
import { useToolStore } from '../viewer/tool-store';
import { AnnotationProperties } from './AnnotationProperties';
import {
  DEFAULT_STYLES,
  type PageTarget,
  pageKey,
  resetAnnotationStore,
  TOOL_STYLES_STORAGE_KEY,
  useAnnotationStore,
} from './annotation-store';
import { PEN_PRESETS_STORAGE_KEY } from './pen/presets';
import { readAnnotations, resetEditRunner, whenIdle } from './edit-runner';

const store = () => useAnnotationStore.getState();

/**
 * How long a wait on the engine or on paint may take. Testing Library's default (1 s) is
 * shorter than a commit through the engine worker and a repaint under a loaded full-suite
 * run; each wait still ends as soon as its condition holds.
 */
const SETTLE = { timeout: 10_000 };

interface Mounted {
  readonly container: HTMLElement;
  readonly layer: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly target: PageTarget;
}

async function mountRead(): Promise<Mounted> {
  // The Read view opens at the document's remembered page. Every test file of the run shares
  // one browser origin, so its localStorage: another file reading this fixture (crop.test
  // leaves it at page 2) would make the view open there, with page 1 mounted only as
  // overscan. The strokes below are dispatched straight onto page 1's layer, which a person
  // could not press while it is out of view, and a layer out of view does not load its page,
  // so the engine would hold the strokes while the layer never showed them.
  localStorage.removeItem(POSITIONS_KEY);
  const report = await useWorkspaceStore
    .getState()
    .openFiles([await fixtureFile(simpleUrl, 'simple.pdf')]);
  expect(report.skipped).toEqual([]);
  const doc = getActiveDocument(useWorkspaceStore.getState().workspace) as VirtualDocument;
  const first = doc.pages[0];
  if (first?.ref.kind !== 'source') throw new Error('no source page');
  useUiStore.getState().setZoom(0.75);
  useViewStore.getState().setCurrentPage(0);
  const { container } = render(
    <div style={{ display: 'flex', flexDirection: 'column', height: 700 }}>
      <ReadView doc={doc} />
    </div>,
  );
  const canvas = await waitFor(() => {
    const c = container.querySelector<HTMLCanvasElement>(
      '[data-page-index="0"] canvas[data-state="rendered"]',
    );
    if (!c) throw new Error('page not rendered');
    return c;
  }, SETTLE);
  const layer = await waitFor(() => {
    const l = container.querySelector<HTMLElement>('[data-annotation-layer="0"]');
    if (!l) throw new Error('no annotation layer');
    return l;
  }, SETTLE);
  // Page 1 is in view: its layer has loaded the page's annotations (it loads them only then).
  const key = pageKey(first.ref.source, 0);
  await waitFor(() => {
    if (!store().pages[key]?.loaded) {
      throw new Error('page 1 is not in view: its annotation layer has not loaded');
    }
  }, SETTLE);
  return {
    container,
    layer,
    canvas,
    target: { source: first.ref.source, pageIndex: 0, pageId: first.id, position: 1 },
  };
}

function pointer(type: string, x: number, y: number): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
    buttons: type === 'pointerup' ? 0 : 1,
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
  });
}

/** Presses on the layer at fractions of its box, moves in steps, and stops before release. */
function press(layer: HTMLElement, from: [number, number], to: [number, number]): () => void {
  const box = layer.getBoundingClientRect();
  const at = (f: [number, number]) => [box.left + box.width * f[0], box.top + box.height * f[1]];
  const [x0, y0] = at(from) as [number, number];
  const [x1, y1] = at(to) as [number, number];
  layer.dispatchEvent(pointer('pointerdown', x0, y0));
  for (let i = 1; i <= 8; i++) {
    window.dispatchEvent(
      pointer('pointermove', x0 + ((x1 - x0) * i) / 8, y0 + ((y1 - y0) * i) / 8),
    );
  }
  return () => window.dispatchEvent(pointer('pointerup', x1, y1));
}

function stroke(layer: HTMLElement, from: [number, number], to: [number, number]): void {
  press(layer, from, to)();
}

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

async function inkOnPage(target: PageTarget) {
  return (await readAnnotations(target.source, target.pageIndex)).filter((a) => a.kind === 'ink');
}

async function armInk(layer: HTMLElement): Promise<void> {
  useToolStore.getState().setMode('ink');
  await waitFor(() => expect(layer).toHaveAttribute('data-tool', 'ink'), SETTLE);
}

describe('writing is never interrupted', () => {
  beforeEach(async () => {
    await page.viewport(1280, 900);
    localStorage.removeItem(TOOL_STYLES_STORAGE_KEY);
    localStorage.removeItem(PEN_PRESETS_STORAGE_KEY);
    resetWorkspace();
    resetEditRunner();
    resetAnnotationStore();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await whenIdle();
    // Unmount before the workspace goes: the Read view must not render a closed source.
    cleanup();
    useToolStore.getState().setMode('select');
    localStorage.removeItem(TOOL_STYLES_STORAGE_KEY);
    localStorage.removeItem(PEN_PRESETS_STORAGE_KEY);
    localStorage.removeItem(POSITIONS_KEY);
    resetAnnotationStore();
    resetWorkspace();
  });

  it('a committed stroke selects nothing and opens no bar', async () => {
    const { container, layer, target } = await mountRead();
    await armInk(layer);
    const bars: string[] = [];
    const observer = new MutationObserver(() => {
      if (container.querySelector('[data-testid="annotation-bar"]')) bars.push('bar');
      if (store().selection !== null) bars.push('selection');
    });
    observer.observe(container, { childList: true, subtree: true, attributes: true });
    // Three lines written in one go: one Ink of three strokes (a burst, spec §6.4).
    const strokes = async () =>
      (await inkOnPage(target)).reduce((n, a) => n + (a.kind === 'ink' ? a.paths.length : 0), 0);
    for (const [i, y] of [0.3, 0.35, 0.4].entries()) {
      stroke(layer, [0.2, y], [0.5, y + 0.01]);
      await waitFor(async () => expect(await strokes()).toBe(i + 1), SETTLE);
    }
    await waitFor(
      () =>
        expect(container.querySelectorAll('[data-annotation-kind="ink"] polyline')).toHaveLength(3),
      SETTLE,
    );
    observer.disconnect();
    expect(bars).toEqual([]);
    expect(store().selection).toBeNull();
    expect(container.querySelector('[data-testid="annotation-bar"]')).toBeNull();
  });

  it('writes on page 1 even when another test file left this document at a later page', async () => {
    // What crop.test leaves in the shared localStorage: this fixture remembered at page 2.
    await useWorkspaceStore.getState().openFiles([await fixtureFile(simpleUrl, 'simple.pdf')]);
    const ws = useWorkspaceStore.getState().workspace;
    const fingerprint = documentFingerprint(ws, getActiveDocument(ws) as VirtualDocument);
    if (fingerprint === undefined) throw new Error('no fingerprint');
    rememberPosition(fingerprint, 1);
    resetWorkspace();
    resetEditRunner();
    resetAnnotationStore();
    const { container, layer, target } = await mountRead();
    await armInk(layer);
    stroke(layer, [0.2, 0.3], [0.5, 0.31]);
    await waitFor(async () => expect(await inkOnPage(target)).toHaveLength(1), SETTLE);
    await waitFor(
      () =>
        expect(container.querySelectorAll('[data-annotation-kind="ink"] polyline')).toHaveLength(1),
      SETTLE,
    );
  });

  it('keeps the preview until the page canvas has painted the committed stroke', async () => {
    const { container, layer, canvas, target } = await mountRead();
    await armInk(layer);
    let removedWith: { state: string | undefined; revision: string | undefined } | undefined;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.removedNodes) {
          if (node instanceof Element && node.matches('[data-settling]')) {
            removedWith = { state: canvas.dataset.state, revision: canvas.dataset.revision };
          }
        }
      }
    });
    observer.observe(layer, { childList: true, subtree: true });
    const release = press(layer, [0.2, 0.5], [0.6, 0.55]);
    release();
    // The frame after pointer-up still shows the stroke as the preview.
    await frame();
    expect(
      container.querySelector('[data-testid="annotation-preview"][data-settling]'),
    ).not.toBeNull();
    await waitFor(() => expect(container.querySelector('[data-settling]')).toBeNull(), {
      timeout: 10_000,
    });
    observer.disconnect();
    const generation = getEngineService().pageRevision(target.source, 0);
    expect(generation).toBeGreaterThan(0);
    // When the preview went, the canvas already showed the committing generation.
    expect(removedWith?.state).toBe('rendered');
    expect(removedWith?.revision).toBe(`${target.source}:0:0@${generation}`);
    expect(await inkOnPage(target)).toHaveLength(1);
  });

  it('a failed commit drops the preview and announces "Stroke not saved"', async () => {
    const { container, layer, target } = await mountRead();
    await armInk(layer);
    const editor = await getEngineService().editor();
    vi.spyOn(editor, 'createAnnotation').mockRejectedValueOnce(new Error('refused'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    stroke(layer, [0.2, 0.6], [0.5, 0.62]);
    await waitFor(() => expect(useAnnouncer.getState().alert).toBe(m.annot_stroke_not_saved()));
    await waitFor(() => expect(container.querySelector('[data-settling]')).toBeNull());
    expect(await inkOnPage(target)).toHaveLength(0);
  });

  it('a press while a text box editor is open commits it and draws the stroke', async () => {
    const { container, layer, target } = await mountRead();
    await armInk(layer);
    store().setEditor({
      kind: 'free-text',
      target,
      rect: { x: 72, y: 600, width: 160, height: 16 },
      text: 'Label',
      fixedWidth: true,
    });
    await waitFor(() => expect(container.querySelector('textarea')).not.toBeNull());
    stroke(layer, [0.2, 0.7], [0.5, 0.72]);
    await waitFor(async () => {
      const list = await readAnnotations(target.source, 0);
      expect(list.map((a) => a.kind).sort()).toEqual(['free-text', 'ink']);
    });
    expect(store().editor).toBeNull();
    expect(store().selection).toBeNull();
  });

  it('a press while a note editor is open saves the note and draws the stroke', async () => {
    const { container, layer, target } = await mountRead();
    await armInk(layer);
    store().setEditor({
      kind: 'note',
      target,
      rect: { x: 300, y: 600, width: 20, height: 20 },
      text: 'Check this',
    });
    await waitFor(() => expect(container.querySelector('[role="dialog"] textarea')).not.toBeNull());
    stroke(layer, [0.2, 0.75], [0.5, 0.77]);
    await waitFor(async () => {
      const list = await readAnnotations(target.source, 0);
      expect(list.map((a) => a.kind).sort()).toEqual(['ink', 'text']);
    });
    expect(store().editor).toBeNull();
    expect(store().selection).toBeNull();
  });

  it('arming the pen draws with the persisted style', async () => {
    store().setStyle('ink', { color: '#1E88E5', strokeWidth: 4 });
    resetAnnotationStore(); // As a reload would: the style comes back from storage.
    const { layer, target } = await mountRead();
    await armInk(layer);
    stroke(layer, [0.2, 0.4], [0.5, 0.42]);
    await waitFor(async () => expect(await inkOnPage(target)).toHaveLength(1));
    const [ink] = await inkOnPage(target);
    expect(ink?.kind === 'ink' ? [ink.color?.toUpperCase(), ink.strokeWidth] : []).toEqual([
      '#1E88E5',
      4,
    ]);
  });
});

describe('tool style controls', () => {
  afterEach(() => {
    useToolStore.getState().setMode('select');
    localStorage.removeItem(TOOL_STYLES_STORAGE_KEY);
    localStorage.removeItem(PEN_PRESETS_STORAGE_KEY);
    resetAnnotationStore();
  });

  it('show the armed tool style with nothing selected; a swatch changes and keeps it', async () => {
    localStorage.removeItem(TOOL_STYLES_STORAGE_KEY);
    localStorage.removeItem(PEN_PRESETS_STORAGE_KEY);
    resetAnnotationStore();
    render(<AnnotationProperties fallback={<p>Nothing selected</p>} />);
    expect(screen.getByText('Nothing selected')).toBeVisible();

    useToolStore.getState().setMode('ink');
    const section = await screen.findByRole('region', {
      name: m.annot_tool_style({ tool: m.tool_ink() }),
    });
    expect(section).toBeVisible();
    screen.getByRole('radio', { name: 'Blue' }).click();
    await waitFor(() => expect(store().styles.ink.color).toBe('#1E88E5'));
    expect(screen.getByRole('radio', { name: 'Blue' })).toHaveAttribute('aria-checked', 'true');
    expect(store().styles.shape).toEqual(DEFAULT_STYLES.shape);
    // Persisted: a reload starts with it.
    resetAnnotationStore();
    expect(store().styles.ink.color).toBe('#1E88E5');
  });
});
