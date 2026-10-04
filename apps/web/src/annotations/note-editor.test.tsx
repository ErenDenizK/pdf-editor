/**
 * The note popup (review F6), in the mounted Read view (Vitest browser mode, Chromium, real
 * PDFium): Esc and a press outside save what was typed, only an empty new note is dropped,
 * Cancel still discards, the popup stays inside the visible rectangle, and the header shows
 * the configured author or nothing (never "No author").
 */
import '../styles/tokens.css';
import '../styles/reset.css';
import '../styles/global.css';
import './index';

import { getActiveDocument, type VirtualDocument } from '@pdf-editor/document-model';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';

import simpleUrl from '../../../../test/fixtures/simple-text.pdf?url';
import { enterEditMode, fixtureFile } from '../../test/store-harness';
import { ReadView } from '../stage/ReadView';
import { useUiStore } from '../state/ui-store';
import { useViewStore } from '../state/view-store';
import { resetWorkspace, useWorkspaceStore } from '../state/workspace-store';
import { POSITIONS_KEY } from '../viewer/navigation';
import { useToolStore } from '../viewer/tool-store';
import {
  AUTHOR_STORAGE_KEY,
  type PageTarget,
  pageKey,
  resetAnnotationStore,
  useAnnotationStore,
} from './annotation-store';
import { readAnnotations, resetEditRunner, whenIdle } from './edit-runner';
import { placeNotePopup } from './InlineEditors';

const store = () => useAnnotationStore.getState();
const SETTLE = { timeout: 10_000 };

async function mountRead(height = 700): Promise<{ container: HTMLElement; target: PageTarget }> {
  localStorage.removeItem(POSITIONS_KEY);
  await useWorkspaceStore.getState().openFiles([await fixtureFile(simpleUrl, 'simple.pdf')]);
  enterEditMode();
  const doc = getActiveDocument(useWorkspaceStore.getState().workspace) as VirtualDocument;
  const first = doc.pages[0];
  if (first?.ref.kind !== 'source') throw new Error('no source page');
  const source = first.ref.source;
  useUiStore.getState().setZoom(0.75);
  useViewStore.getState().setCurrentPage(0);
  const { container } = render(
    <div style={{ display: 'flex', flexDirection: 'column', height }}>
      <ReadView doc={doc} />
    </div>,
  );
  await waitFor(() => {
    if (!store().pages[pageKey(source, 0)]?.loaded) throw new Error('not loaded');
  }, SETTLE);
  return {
    container,
    target: { source, pageIndex: 0, pageId: first.id, position: 1 },
  };
}

async function notesOn(target: PageTarget) {
  return (await readAnnotations(target.source, target.pageIndex)).filter((a) => a.kind === 'text');
}

async function openNewNote(target: PageTarget, x = 300, y = 600): Promise<HTMLTextAreaElement> {
  store().setEditor({
    kind: 'note',
    target,
    rect: { x, y, width: 20, height: 20 },
    text: '',
  });
  const dialog = await screen.findByRole('dialog', { name: 'New note' });
  const box = dialog.querySelector('textarea');
  if (!box) throw new Error('no note textarea');
  await waitFor(() => expect(box).toHaveFocus());
  return box;
}

describe('placeNotePopup', () => {
  const bounds = { left: 0, top: 0, right: 1000, bottom: 800 };
  const size = { width: 240, height: 180 };

  it('hangs right of the icon, top edges aligned, where there is room', () => {
    const anchor = { left: 100, top: 100, right: 120, bottom: 120 };
    expect(placeNotePopup(anchor, size, bounds)).toEqual({ left: 128, top: 100 });
  });

  it('flips to the left near the right edge', () => {
    const anchor = { left: 900, top: 100, right: 920, bottom: 120 };
    expect(placeNotePopup(anchor, size, bounds)).toEqual({ left: 652, top: 100 });
  });

  it('flips upward near the bottom edge', () => {
    const anchor = { left: 100, top: 700, right: 120, bottom: 720 };
    expect(placeNotePopup(anchor, size, bounds)).toEqual({ left: 128, top: 540 });
  });

  it('stays inside the bounds when neither side has room', () => {
    const anchor = { left: 100, top: 10, right: 120, bottom: 30 };
    const narrow = { left: 0, top: 50, right: 300, bottom: 800 };
    expect(placeNotePopup(anchor, size, narrow)).toEqual({ left: 60, top: 50 });
  });
});

describe('the note popup', () => {
  beforeEach(async () => {
    await page.viewport(1280, 900);
    localStorage.removeItem(AUTHOR_STORAGE_KEY);
    resetWorkspace();
    resetEditRunner();
    resetAnnotationStore();
  });
  afterEach(async () => {
    await whenIdle();
    cleanup();
    useToolStore.getState().setMode('select');
    localStorage.removeItem(POSITIONS_KEY);
    localStorage.removeItem(AUTHOR_STORAGE_KEY);
    resetAnnotationStore();
    resetWorkspace();
  });

  it('Esc saves the typed text as a new note', async () => {
    const { target } = await mountRead();
    const box = await openNewNote(target);
    await userEvent.type(box, 'Check the figures');
    await userEvent.keyboard('{Escape}');
    expect(store().editor).toBeNull();
    await waitFor(async () => {
      const notes = await notesOn(target);
      expect(notes.map((n) => n.contents)).toEqual(['Check the figures']);
    }, SETTLE);
  });

  it('a press outside the popup saves it', async () => {
    const { target } = await mountRead();
    const box = await openNewNote(target);
    await userEvent.type(box, 'Clicked away');
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    await waitFor(() => expect(store().editor).toBeNull());
    await waitFor(async () => {
      expect((await notesOn(target)).map((n) => n.contents)).toEqual(['Clicked away']);
    }, SETTLE);
  });

  it('drops an empty new note on Esc and on a press outside; Cancel discards typed text', async () => {
    const { target } = await mountRead();
    await openNewNote(target);
    await userEvent.keyboard('{Escape}');
    expect(store().editor).toBeNull();
    await openNewNote(target);
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    await waitFor(() => expect(store().editor).toBeNull());
    const box = await openNewNote(target);
    await userEvent.type(box, 'Never mind');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(store().editor).toBeNull();
    await whenIdle();
    expect(await notesOn(target)).toEqual([]);
  });

  it('Esc saves an edited comment on an existing note', async () => {
    const { target } = await mountRead();
    const box = await openNewNote(target);
    await userEvent.type(box, 'First');
    await userEvent.keyboard('{Escape}');
    const [note] = await waitFor(async () => {
      const notes = await notesOn(target);
      expect(notes).toHaveLength(1);
      return notes;
    }, SETTLE);
    if (!note) throw new Error('no note');
    store().setEditor({ kind: 'note', target, id: note.id, rect: note.rect, text: 'First' });
    const dialog = await screen.findByRole('dialog', { name: 'Edit comment' });
    const edit = dialog.querySelector('textarea');
    if (!edit) throw new Error('no textarea');
    await waitFor(() => expect(edit).toHaveFocus());
    await userEvent.fill(edit, 'First, then second');
    await userEvent.keyboard('{Escape}');
    await waitFor(async () => {
      expect((await notesOn(target)).map((n) => n.contents)).toEqual(['First, then second']);
    }, SETTLE);
  });

  it('stays inside the visible rectangle near the right and bottom edges', async () => {
    await page.viewport(720, 900);
    const { container, target } = await mountRead(600);
    // Near the page's top-right corner, then near the bottom of what is visible.
    await openNewNote(target, 580, 760);
    const viewport = container.querySelector<HTMLElement>('[data-read-viewport]');
    if (!viewport) throw new Error('no viewport');
    const inside = async () => {
      const popup = await screen.findByTestId('note-popup');
      await waitFor(() => {
        const r = popup.getBoundingClientRect();
        const v = viewport.getBoundingClientRect();
        expect(r.right).toBeLessThanOrEqual(Math.min(v.right, window.innerWidth) + 0.5);
        expect(r.left).toBeGreaterThanOrEqual(v.left - 0.5);
        expect(r.bottom).toBeLessThanOrEqual(v.bottom + 0.5);
        expect(r.top).toBeGreaterThanOrEqual(v.top - 0.5);
      });
      return popup;
    };
    const popup = await inside();
    // Flipped: it sits left of the icon it hangs off.
    const icon = container
      .querySelector('[data-annotation-layer="0"]')
      ?.getBoundingClientRect() as DOMRect;
    expect(popup.getBoundingClientRect().right).toBeLessThan(icon.left + (580 / 612) * icon.width);
    await userEvent.keyboard('{Escape}');
    const v = viewport.getBoundingClientRect();
    // y in user space near the bottom of the visible area: the page is 792 pt tall at 0.75.
    const pageBox = container.querySelector('[data-page-index="0"]')?.getBoundingClientRect();
    if (!pageBox) throw new Error('no page');
    const yUser = 792 - (v.bottom - 30 - pageBox.top) / (pageBox.height / 792);
    await openNewNote(target, 100, yUser);
    await inside();
  });

  it('shows the configured author, and no "No author" label without one', async () => {
    const { target } = await mountRead();
    await openNewNote(target);
    const dialog = screen.getByRole('dialog', { name: 'New note' });
    expect(dialog).not.toHaveTextContent('No author');
    await userEvent.keyboard('{Escape}');
    store().setAuthor('Deniz');
    await openNewNote(target);
    expect(screen.getByRole('dialog', { name: 'New note' })).toHaveTextContent('Deniz');
  });
});
