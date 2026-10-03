/**
 * The page context menu (ADR-0019 §4, craft spec §3.4), Vitest browser mode with the Read
 * view, the tool bar (which mounts the menu) and real PDFium: it opens on a right-click and
 * on Shift+F10, its items act on the page it was opened on and name it, "Edit text here" is
 * Edit's only, and a right-click on selected text keeps the browser's menu.
 */
import '../styles/tokens.css';
import '../styles/reset.css';
import '../styles/global.css';
import '../annotations/index';

import { getActiveDocument, type VirtualDocument } from '@pdf-editor/document-model';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';

import rotatedUrl from '../../../../test/fixtures/rotated-pages.pdf?url';
import { enterEditMode, fixtureFile } from '../../test/store-harness';
import { resetAnnotationStore } from '../annotations/annotation-store';
import { resetEditRunner, whenIdle } from '../annotations/edit-runner';
import { registerAppCommands } from '../commands/app-commands';
import { useShortcuts } from '../commands/use-shortcuts';
import { useAnnouncer } from '../shell/announcer';
import { FloatingToolbar } from '../shell/FloatingToolbar';
import { useSelectionStore } from '../state/selection-store';
import { useUiStore } from '../state/ui-store';
import { useViewStore } from '../state/view-store';
import { resetWorkspace, useWorkspaceStore } from '../state/workspace-store';
import { resetToolStore, useToolStore } from '../viewer/tool-store';
import { closeOperationDialog, useOperationDialogStore } from './operation-dialogs-store';
import { ReadView } from './ReadView';

function Harness() {
  useShortcuts();
  // The live document, so a deleted page leaves the view.
  const doc = useWorkspaceStore((s) => getActiveDocument(s.workspace));
  if (!doc) return null;
  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', height: 800 }}>
      <ReadView doc={doc} />
      <FloatingToolbar />
    </div>
  );
}

const activeDoc = () =>
  getActiveDocument(useWorkspaceStore.getState().workspace) as VirtualDocument;

/** Opens the four-page fixture (in Read unless `edit`) and waits for page 2. */
async function mount(edit = false): Promise<{ container: HTMLElement; doc: VirtualDocument }> {
  const report = await useWorkspaceStore
    .getState()
    .openFiles([await fixtureFile(rotatedUrl, 'rotated.pdf')]);
  expect(report.skipped).toEqual([]);
  if (edit) enterEditMode();
  const doc = activeDoc();
  useUiStore.getState().setZoom(0.3);
  useViewStore.getState().setCurrentPage(0);
  const { container } = render(<Harness />);
  await waitFor(
    () => {
      if (!container.querySelector('[data-page-index="1"] canvas[data-state="rendered"]')) {
        throw new Error('page 2 not rendered');
      }
    },
    { timeout: 10_000 },
  );
  return { container, doc };
}

function pageElement(container: HTMLElement, index: number): HTMLElement {
  const element = container.querySelector<HTMLElement>(`[data-page-index="${index}"]`);
  if (!element) throw new Error(`no page ${index + 1}`);
  return element;
}

/** A right-click in the middle of a page; returns whether the browser's menu was kept. */
function rightClick(target: Element): boolean {
  const box = target.getBoundingClientRect();
  return target.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: box.left + box.width / 2,
      clientY: box.top + box.height / 2,
    }),
  );
}

/** The open menu, once its items have risen in. */
async function menu(): Promise<HTMLElement> {
  return waitFor(() => {
    const popup = screen.getByTestId('page-context-menu');
    if (popup.hasAttribute('data-closed')) throw new Error('still closing');
    expect(within(popup).getAllByRole('menuitem')[0]).toBeVisible();
    return popup;
  });
}

/** Waits for the last menu to have gone (its exit transition), so the next one is new. */
const closed = () => waitFor(() => expect(screen.queryByTestId('page-context-menu')).toBeNull());

describe('page context menu', () => {
  let disposeCommands: () => void = () => undefined;
  beforeAll(() => {
    disposeCommands = registerAppCommands();
  });
  afterAll(() => {
    disposeCommands();
  });
  beforeEach(async () => {
    await page.viewport(1280, 900);
    resetWorkspace();
    resetEditRunner();
    resetAnnotationStore();
    resetToolStore();
    useUiStore.setState({ viewMode: 'read' });
    useSelectionStore.getState().apply({ selected: new Set(), anchor: null, focused: null });
  });
  afterEach(async () => {
    closeOperationDialog();
    await whenIdle();
    cleanup();
    resetToolStore();
    resetAnnotationStore();
    resetWorkspace();
  });

  it('opens on a right-click in Read, names the clicked page, and rotates that page', async () => {
    const { container, doc } = await mount();
    const kept = rightClick(pageElement(container, 1));
    expect(kept).toBe(false);
    const popup = await menu();
    expect(popup).toHaveAccessibleName('Page 2');
    const names = within(popup)
      .getAllByRole('menuitem')
      .map((item) => item.textContent?.trim());
    expect(names).toEqual([
      'Rotate page 2 left',
      'Rotate page 2 right',
      'Delete page 2',
      'Crop…',
      expect.stringMatching(/^Arrange/),
    ]);
    // Edit's own item is not offered in Read.
    expect(within(popup).queryByRole('menuitem', { name: 'Edit text here' })).toBeNull();

    await userEvent.click(within(popup).getByRole('menuitem', { name: 'Rotate page 2 right' }));
    const before = doc.pages[1]?.rotation ?? 0;
    expect(activeDoc().pages[1]?.rotation).toBe((before + 90) % 360);
    expect(activeDoc().pages[0]?.rotation).toBe(doc.pages[0]?.rotation);
    expect(useAnnouncer.getState().message).toBe('Rotated page 2 right');
    await closed();

    rightClick(pageElement(container, 1));
    await userEvent.click(
      within(await menu()).getByRole('menuitem', { name: 'Rotate page 2 left' }),
    );
    expect(activeDoc().pages[1]?.rotation).toBe(before);
    expect(useAnnouncer.getState().message).toBe('Rotated page 2 left');
  });

  it('Delete, Crop… and Arrange act on the clicked page', async () => {
    const { container, doc } = await mount();
    const second = doc.pages[1]?.id;
    const third = doc.pages[2]?.id;
    if (second === undefined || third === undefined) throw new Error('pages missing');

    rightClick(pageElement(container, 1));
    await userEvent.click(within(await menu()).getByRole('menuitem', { name: 'Crop…' }));
    expect(useOperationDialogStore.getState().dialog).toMatchObject({
      kind: 'crop',
      documentId: doc.id,
      pageIds: [second],
    });
    closeOperationDialog();
    await closed();

    rightClick(pageElement(container, 1));
    await userEvent.click(within(await menu()).getByRole('menuitem', { name: 'Delete page 2' }));
    expect(activeDoc().pages.map((p) => p.id)).not.toContain(second);
    expect(activeDoc().pages).toHaveLength(3);
    expect(useAnnouncer.getState().message).toMatch(/^Deleted page 2\. Undo with /);

    // The old page 3 is page 2 now.
    await closed();
    rightClick(pageElement(container, 1));
    await userEvent.click(within(await menu()).getByRole('menuitem', { name: /^Arrange/ }));
    expect(useUiStore.getState().viewMode).toBe('arrange');
    expect([...useSelectionStore.getState().selected]).toEqual([third]);
  });

  it('offers "Edit text here" in Edit, which arms Edit text', async () => {
    const { container } = await mount(true);
    rightClick(pageElement(container, 0));
    const popup = await menu();
    const items = within(popup).getAllByRole('menuitem');
    expect(items[0]).toHaveTextContent('Edit text here');
    expect(items[1]).toHaveTextContent('Rotate page 1 left');
    await userEvent.click(within(popup).getByRole('menuitem', { name: /^Edit text here/ }));
    expect(useToolStore.getState().mode).toBe('edit-text');
    expect(useToolStore.getState().barGroup).toBe('text');
  });

  it('opens on Shift+F10 in the viewport for the current page; Esc closes it and returns the focus', async () => {
    const { container } = await mount();
    const viewport = container.querySelector<HTMLElement>('[data-read-viewport]');
    if (!viewport) throw new Error('no viewport');
    viewport.focus();
    await userEvent.keyboard('{Shift>}{F10}{/Shift}');
    const popup = await menu();
    const n = useViewStore.getState().currentPage + 1;
    expect(popup).toHaveAccessibleName(`Page ${n}`);
    expect(within(popup).getByRole('menuitem', { name: `Delete page ${n}` })).toBeVisible();
    await waitFor(() => expect(popup).toContainElement(document.activeElement as HTMLElement));
    await userEvent.keyboard('{Escape}');
    await closed();
    expect(viewport).toHaveFocus();
  });

  it('keeps the browser menu on selected text', async () => {
    const { container } = await mount();
    const span = await waitFor(() => {
      const found = [
        ...container.querySelectorAll<HTMLElement>(
          '[data-page-index="0"] [data-testid="text-layer"] span',
        ),
      ].find((s) => (s.textContent ?? '').trim().length > 3);
      if (!found) throw new Error('no text yet');
      return found;
    });
    const range = document.createRange();
    range.selectNodeContents(span);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    expect(rightClick(span)).toBe(true);
    expect(screen.queryByTestId('page-context-menu')).toBeNull();
    window.getSelection()?.removeAllRanges();
  });
});
