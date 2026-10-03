/**
 * The contextual bar of a text selection (ADR-0019 §4, craft spec §3.4–§3.5), Vitest browser
 * mode with the Read view and real PDFium: with Select armed in Edit it offers the four
 * markups, which mark through `markupFromSelection` in the tool's remembered style, and
 * Comment, which opens a note's editor at the selection; Esc dismisses it; in Read it stays
 * Copy and "Mark up…"; with another tool armed it does not show.
 */
import '../styles/tokens.css';
import '../styles/reset.css';
import '../styles/global.css';
import './index';

import { getActiveDocument, type SourceId, type VirtualDocument } from '@pdf-editor/document-model';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';

import simpleUrl from '../../../../test/fixtures/simple-text.pdf?url';
import { enterEditMode, fixtureFile } from '../../test/store-harness';
import { registerAppCommands } from '../commands/app-commands';
import { useShortcuts } from '../commands/use-shortcuts';
import { FloatingToolbar } from '../shell/FloatingToolbar';
import { ReadView } from '../stage/ReadView';
import { useUiStore } from '../state/ui-store';
import { useViewStore } from '../state/view-store';
import { resetWorkspace, useWorkspaceStore } from '../state/workspace-store';
import { resetToolStore, useToolStore } from '../viewer/tool-store';
import {
  resetAnnotationStore,
  TOOL_STYLES_STORAGE_KEY,
  useAnnotationStore,
} from './annotation-store';
import { readAnnotations, resetEditRunner, whenIdle } from './edit-runner';

function Harness({ doc }: { readonly doc: VirtualDocument }) {
  useShortcuts();
  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', height: 700 }}>
      <ReadView doc={doc} />
      <FloatingToolbar />
    </div>
  );
}

async function mount(edit: boolean): Promise<{ container: HTMLElement; source: SourceId }> {
  const report = await useWorkspaceStore
    .getState()
    .openFiles([await fixtureFile(simpleUrl, 'simple.pdf')]);
  expect(report.skipped).toEqual([]);
  if (edit) enterEditMode();
  const doc = getActiveDocument(useWorkspaceStore.getState().workspace) as VirtualDocument;
  const first = doc.pages[0];
  if (first?.ref.kind !== 'source') throw new Error('no source page');
  useUiStore.getState().setZoom(0.75);
  useViewStore.getState().setCurrentPage(0);
  const { container } = render(<Harness doc={doc} />);
  await waitFor(
    () => {
      if (!container.querySelector('[data-annotation-layer="0"]')) throw new Error('no layer');
    },
    { timeout: 10_000 },
  );
  return { container, source: first.ref.source };
}

/** Selects the first word-bearing span of page 1's text layer. */
async function selectSomeText(container: HTMLElement): Promise<void> {
  const span = await waitFor(
    () => {
      const found = [
        ...container.querySelectorAll<HTMLElement>(
          '[data-page-index="0"] [data-testid="text-layer"] span',
        ),
      ].find((s) => (s.textContent ?? '').trim().length > 3);
      if (!found) throw new Error('no text yet');
      return found;
    },
    { timeout: 10_000 },
  );
  const range = document.createRange();
  range.selectNodeContents(span);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
}

const selectionBar = () => screen.findByRole('toolbar', { name: 'Selected text' });

describe('the text selection bar', () => {
  let disposeCommands: () => void = () => undefined;
  beforeAll(() => {
    disposeCommands = registerAppCommands();
  });
  afterAll(() => {
    disposeCommands();
  });
  beforeEach(async () => {
    await page.viewport(1280, 900);
    localStorage.removeItem(TOOL_STYLES_STORAGE_KEY);
    resetWorkspace();
    resetEditRunner();
    resetAnnotationStore();
    resetToolStore();
    useUiStore.setState({ viewMode: 'read' });
  });
  afterEach(async () => {
    window.getSelection()?.removeAllRanges();
    await whenIdle();
    cleanup();
    resetToolStore();
    localStorage.removeItem(TOOL_STYLES_STORAGE_KEY);
    resetAnnotationStore();
    resetWorkspace();
  });

  it('in Edit with Select: the markups and Comment; Underline marks in the tool style', async () => {
    const { container, source } = await mount(true);
    await selectSomeText(container);
    const bar = await selectionBar();
    const names = within(bar)
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label') ?? b.textContent?.trim());
    expect(names).toEqual(['Highlight', 'Underline', 'Strikeout', 'Squiggly underline', 'Comment']);
    expect(within(bar).queryByRole('button', { name: /Copy/ })).toBeNull();
    // Above the selection, inside the page.
    const selected = window.getSelection()?.getRangeAt(0).getBoundingClientRect();
    expect(bar.getBoundingClientRect().bottom).toBeLessThanOrEqual((selected?.top ?? 0) + 1);

    const { color } = useAnnotationStore.getState().styles.underline;
    await userEvent.click(within(bar).getByRole('button', { name: 'Underline' }));
    await waitFor(async () => {
      const marks = await readAnnotations(source, 0);
      expect(marks.map((a) => a.kind)).toEqual(['underline']);
      const [mark] = marks;
      expect(mark && 'color' in mark ? mark.color?.toUpperCase() : undefined).toBe(
        color.toUpperCase(),
      );
    });
    // The selection is used up: the bar goes, and the tool stays Select.
    expect(window.getSelection()?.isCollapsed).toBe(true);
    await waitFor(() =>
      expect(screen.queryByRole('toolbar', { name: 'Selected text' })).toBeNull(),
    );
    expect(useToolStore.getState().mode).toBe('select');
  });

  it('Highlight from the bar marks the selection', async () => {
    const { container, source } = await mount(true);
    await selectSomeText(container);
    await userEvent.click(within(await selectionBar()).getByRole('button', { name: 'Highlight' }));
    await waitFor(async () =>
      expect((await readAnnotations(source, 0)).map((a) => a.kind)).toEqual(['highlight']),
    );
  });

  it('Comment opens a new note at the selection and clears it', async () => {
    const { container } = await mount(true);
    await selectSomeText(container);
    await userEvent.click(within(await selectionBar()).getByRole('button', { name: 'Comment' }));
    const editor = useAnnotationStore.getState().editor;
    expect(editor?.kind).toBe('note');
    expect(editor?.target.pageIndex).toBe(0);
    expect(editor && 'id' in editor ? editor.id : undefined).toBeUndefined();
    expect(window.getSelection()?.isCollapsed).toBe(true);
  });

  it('Esc dismisses it', async () => {
    const { container } = await mount(true);
    await selectSomeText(container);
    await selectionBar();
    container.querySelector<HTMLElement>('[data-read-viewport]')?.focus();
    await userEvent.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('toolbar', { name: 'Selected text' })).toBeNull(),
    );
    expect(window.getSelection()?.isCollapsed).toBe(true);
  });

  it('in Read it is Copy and "Mark up…", and marks nothing', async () => {
    const { container, source } = await mount(false);
    await selectSomeText(container);
    const bar = await selectionBar();
    expect(within(bar).getByRole('button', { name: /Copy/ })).toBeVisible();
    expect(within(bar).getByRole('button', { name: /Mark up/ })).toBeVisible();
    expect(within(bar).queryByRole('button', { name: 'Underline' })).toBeNull();
    await whenIdle();
    expect(await readAnnotations(source, 0)).toEqual([]);
  });

  it('does not show while another tool is armed in Edit', async () => {
    const { container } = await mount(true);
    useToolStore.getState().setMode('ink');
    await selectSomeText(container);
    // Give the selection change its turn.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole('toolbar', { name: 'Selected text' })).toBeNull();
  });
});
