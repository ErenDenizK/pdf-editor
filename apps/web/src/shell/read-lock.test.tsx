/**
 * The Read lock (ADR-0019 §3, craft spec §3.3) on the mounted page view and bar (Vitest
 * browser mode, PDFium): the bar is one Edit button in Read; nothing on the page selects,
 * arms or marks; a tool key switches to Edit and arms the tool, said once, mode first;
 * select-then-markup keeps the selection for a second press.
 */
import { getActiveDocument, type VirtualDocument } from '@pdf-editor/document-model';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';

import simpleUrl from '../../../../test/fixtures/simple-text.pdf?url';
import { fixtureFile } from '../../test/store-harness';
import { createAnnotations } from '../annotations/actions';
import {
  type PageTarget,
  resetAnnotationStore,
  useAnnotationStore,
} from '../annotations/annotation-store';
import { readAnnotations, resetEditRunner, whenIdle } from '../annotations/edit-runner';
import { INK } from '../annotations/palette';
import { registerAppCommands } from '../commands/app-commands';
import { useShortcuts } from '../commands/use-shortcuts';
import { ReadView } from '../stage/ReadView';
import { canEdit, documentModeOf, useUiStore } from '../state/ui-store';
import { useViewStore } from '../state/view-store';
import { resetWorkspace, useWorkspaceStore } from '../state/workspace-store';
import { resetToolStore, useToolStore } from '../viewer/tool-store';
import { useAnnouncer } from './announcer';
import { FloatingToolbar } from './FloatingToolbar';

function Harness({ doc }: { readonly doc: VirtualDocument }) {
  useShortcuts();
  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', height: 700 }}>
      <ReadView doc={doc} />
      <FloatingToolbar />
    </div>
  );
}

interface Mounted {
  readonly container: HTMLElement;
  readonly layer: HTMLElement;
  readonly target: PageTarget;
  readonly doc: VirtualDocument;
}

/** Opens the fixture as a file opens: in Read. */
async function mount(): Promise<Mounted> {
  const report = await useWorkspaceStore
    .getState()
    .openFiles([await fixtureFile(simpleUrl, 'simple.pdf')]);
  expect(report.skipped).toEqual([]);
  const doc = getActiveDocument(useWorkspaceStore.getState().workspace) as VirtualDocument;
  const first = doc.pages[0];
  if (first?.ref.kind !== 'source') throw new Error('no source page');
  useUiStore.getState().setZoom(0.75);
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
  const layer = await waitFor(() => {
    const l = container.querySelector<HTMLElement>('[data-annotation-layer="0"]');
    if (!l) throw new Error('no annotation layer');
    return l;
  });
  return {
    container,
    layer,
    doc,
    target: { source: first.ref.source, pageIndex: 0, pageId: first.id, position: 1 },
  };
}

const mode = () =>
  documentModeOf(
    useUiStore.getState(),
    useWorkspaceStore.getState().workspace.activeDocument ?? undefined,
  );
const enterEdit = () => {
  const id = useWorkspaceStore.getState().workspace.activeDocument;
  if (id !== undefined) useUiStore.getState().setDocumentMode(id, 'edit');
};
const bar = () => screen.getByRole('toolbar', { name: 'Tools' });

function press(element: Element): void {
  const box = element.getBoundingClientRect();
  const init = {
    bubbles: true,
    cancelable: true,
    clientX: box.left + box.width / 2,
    clientY: box.top + box.height / 2,
    button: 0,
    pointerId: 1,
    isPrimary: true,
  };
  element.dispatchEvent(new PointerEvent('pointerdown', { ...init, buttons: 1 }));
  window.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0 }));
}

/** Selects the first word-bearing span of the page's text layer. */
async function selectSomeText(container: HTMLElement): Promise<void> {
  const span = await waitFor(() => {
    const spans = container.querySelectorAll<HTMLElement>(
      '[data-page-index="0"] [data-testid="text-layer"] span',
    );
    const found = [...spans].find((s) => (s.textContent ?? '').trim().length > 3);
    if (!found) throw new Error('no text yet');
    return found;
  });
  const range = document.createRange();
  range.selectNodeContents(span);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

describe('the Read lock (mounted)', () => {
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
    useUiStore.setState({ destination: 'document', viewMode: 'read', documentMode: {} });
  });
  afterEach(async () => {
    cleanup();
    window.getSelection()?.removeAllRanges();
    await whenIdle();
    resetWorkspace();
    resetToolStore();
  });

  it('a file opens in Read: the bar is one Edit button, which enters Edit and shows the groups', async () => {
    await mount();
    expect(mode()).toBe('read');
    const buttons = within(bar()).getAllByRole('button');
    expect(buttons).toHaveLength(1);
    const edit = buttons[0] as HTMLElement;
    expect(edit).toHaveAccessibleName('Edit');
    expect(edit).toHaveAttribute('aria-keyshortcuts', '2');
    useToolStore.getState().showGroup('draw');

    edit.focus();
    await userEvent.keyboard('{Enter}');
    expect(mode()).toBe('edit');
    expect(useAnnouncer.getState().message).toBe('Edit mode');
    // The row of groups, with the focus on it.
    expect(useToolStore.getState().barGroup).toBeNull();
    await waitFor(() => expect(within(bar()).getAllByRole('button').length).toBeGreaterThan(1));
    expect(bar()).toContainElement(document.activeElement as HTMLElement);

    // `1` (the mode command) collapses it again.
    await userEvent.keyboard('1');
    await waitFor(() => expect(within(bar()).getAllByRole('button')).toHaveLength(1));
  });

  it('in Read a press on an annotation selects nothing; in Edit it selects', async () => {
    const { layer, target } = await mount();
    const created = await createAnnotations(target, [
      {
        kind: 'square',
        pageIndex: 0,
        rect: { x: 100, y: 500, width: 120, height: 60 },
        color: INK.red,
        opacity: 1,
        strokeWidth: 2,
      },
    ]);
    const id = created?.[0]?.id;
    if (id === undefined) throw new Error('not created');
    useAnnotationStore.getState().select(null);
    const hit = await waitFor(() => {
      const h = layer.querySelector(`[data-annotation-id="${id}"]`);
      if (!h) throw new Error('no hit target');
      return h;
    });
    expect(getComputedStyle(hit).pointerEvents).toBe('none');
    press(hit);
    expect(useAnnotationStore.getState().selection).toBeNull();
    // Delete has nothing to act on and is not live.
    await userEvent.keyboard('{Delete}');
    expect((await readAnnotations(target.source, 0)).map((a) => a.id)).toContain(id);

    enterEdit();
    await waitFor(() => expect(getComputedStyle(hit).pointerEvents).not.toBe('none'));
    press(hit);
    expect(useAnnotationStore.getState().selection?.ids).toEqual([id]);
    expect(await screen.findByTestId('annotation-bar')).toBeVisible();

    // Back to Read: the selection and its bar go.
    const docId = useWorkspaceStore.getState().workspace.activeDocument;
    if (docId !== undefined) useUiStore.getState().setDocumentMode(docId, 'read');
    expect(useAnnotationStore.getState().selection).toBeNull();
    await waitFor(() => expect(screen.queryByTestId('annotation-bar')).toBeNull());
  });

  it('p in Read switches to Edit and arms the pen, said once, mode first', async () => {
    const { layer } = await mount();
    expect(layer).not.toHaveAttribute('data-drawing');
    await userEvent.keyboard('p');
    expect(mode()).toBe('edit');
    expect(useToolStore.getState().mode).toBe('ink');
    const said = useAnnouncer.getState().message;
    expect(said.startsWith('Edit mode. ')).toBe(true);
    expect(said.match(/Edit mode/g)).toHaveLength(1);
    // Visibly armed: the bar shows the tool's group, the page takes the pen.
    await waitFor(() => expect(layer).toHaveAttribute('data-drawing'));
    expect(useToolStore.getState().barGroup).not.toBeNull();
  });

  it('the tool store arms nothing in Read and disarms on entering Read', async () => {
    await mount();
    useToolStore.getState().setMode('ink');
    expect(useToolStore.getState().mode).toBe('select');
    enterEdit();
    useToolStore.getState().setMode('ink');
    expect(useToolStore.getState().mode).toBe('ink');
    await userEvent.keyboard('{Escape}');
    useToolStore.getState().setMode('rectangle');
    await userEvent.keyboard('1');
    expect(mode()).toBe('read');
    expect(useToolStore.getState().mode).toBe('select');
    const id = useWorkspaceStore.getState().workspace.activeDocument;
    expect(canEdit(id)).toBe(false);
  });

  it('U over selected text in Read switches to Edit and keeps it; the second U marks it', async () => {
    const { container, target } = await mount();
    await selectSomeText(container);
    await userEvent.keyboard('u');
    expect(mode()).toBe('edit');
    expect(useToolStore.getState().mode).toBe('select');
    expect(window.getSelection()?.isCollapsed).toBe(false);
    await whenIdle();
    expect(await readAnnotations(target.source, 0)).toEqual([]);

    await userEvent.keyboard('u');
    await waitFor(async () => {
      const kinds = (await readAnnotations(target.source, 0)).map((a) => a.kind);
      expect(kinds).toEqual(['underline']);
    });
  });

  it('the Read selection bar offers Copy and "Mark up…", which switches and keeps the selection', async () => {
    const { container } = await mount();
    await selectSomeText(container);
    const selectionBar = await screen.findByRole('toolbar', { name: 'Selected text' });
    expect(within(selectionBar).getByRole('button', { name: /Copy/ })).toBeVisible();
    const markUp = within(selectionBar).getByRole('button', { name: /Mark up/ });
    await userEvent.click(markUp);
    expect(mode()).toBe('edit');
    expect(window.getSelection()?.isCollapsed).toBe(false);
    expect(useAnnouncer.getState().message).toBe(
      'Edit mode. Highlight with H, underline with U, strike out with S',
    );
    await waitFor(() =>
      expect(screen.queryByRole('toolbar', { name: 'Selected text' })).toBeNull(),
    );
  });
});
