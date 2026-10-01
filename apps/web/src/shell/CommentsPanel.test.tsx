import { act, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';

import annotationsUrl from '../../../../test/fixtures/annotations.pdf?url';
import { fixtureFile } from '../../test/store-harness';
import {
  AUTHOR_STORAGE_KEY,
  resetAnnotationStore,
  useAnnotationStore,
} from '../annotations/annotation-store';
import { resetEditRunner } from '../annotations/edit-runner';
import { commandRegistry } from '../commands/registry';
import { registerAppCommands } from '../commands/app-commands';
import { useUiStore } from '../state/ui-store';
import { resetWorkspace, useWorkspaceStore } from '../state/workspace-store';
import { AUTHOR_ASKED_STORAGE_KEY, resetAuthorPrompt, useAuthorPrompt } from './comment-author';
import { CommentsPanel } from './CommentsPanel';

describe('Comments panel', () => {
  beforeEach(() => {
    localStorage.removeItem(AUTHOR_STORAGE_KEY);
    localStorage.removeItem(AUTHOR_ASKED_STORAGE_KEY);
    resetWorkspace();
    resetEditRunner();
    resetAnnotationStore();
    useAnnotationStore.getState().setAuthor('');
    resetAuthorPrompt();
  });
  afterEach(() => {
    localStorage.removeItem(AUTHOR_STORAGE_KEY);
    localStorage.removeItem(AUTHOR_ASKED_STORAGE_KEY);
    resetWorkspace();
  });

  const openAnnotated = async () => {
    await useWorkspaceStore
      .getState()
      .openFiles([await fixtureFile(annotationsUrl, 'annotations.pdf')]);
  };

  it('lists the document’s annotations grouped by page, with author and text', async () => {
    await useWorkspaceStore
      .getState()
      .openFiles([await fixtureFile(annotationsUrl, 'annotations.pdf')]);
    render(<CommentsPanel />);
    const page2 = await screen.findByRole('region', { name: 'Page 2' });
    expect(within(page2).getByText('Sticky note text on page 2')).toBeVisible();
    expect(within(page2).getAllByText('Fixture Author').length).toBeGreaterThan(0);
    const page1 = screen.getByRole('region', { name: 'Page 1' });
    expect(within(page1).getByText('Highlighted sentence')).toBeVisible();

    // Activating a row selects the annotation.
    await userEvent.click(within(page2).getByText('Sticky note text on page 2'));
    expect(useAnnotationStore.getState().selection?.ids).toEqual(['fixture-annot-text-1']);
  });

  it('has no standing author field: nothing is asked before the first comment', () => {
    render(<CommentsPanel />);
    expect(screen.queryByLabelText('Name on your comments')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Skip' })).toBeNull();
  });

  it('asks for the name once, at the first comment, and keeps it in localStorage', async () => {
    await openAnnotated();
    render(<CommentsPanel />);
    const field = await screen.findByLabelText('Name on your comments');
    // Never steals focus from the comment being written.
    expect(field).not.toHaveFocus();
    await userEvent.fill(field, '  Ada ');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(useAnnotationStore.getState().author).toBe('Ada');
    expect(JSON.parse(localStorage.getItem(AUTHOR_STORAGE_KEY) ?? '""')).toBe('Ada');
    expect(JSON.parse(localStorage.getItem(AUTHOR_ASKED_STORAGE_KEY) ?? 'false')).toBe(true);
    expect(screen.queryByLabelText('Name on your comments')).toBeNull();
  });

  it('Skip answers too: the prompt does not come back', async () => {
    await openAnnotated();
    const { unmount } = render(<CommentsPanel />);
    await userEvent.click(await screen.findByRole('button', { name: 'Skip' }));
    expect(screen.queryByLabelText('Name on your comments')).toBeNull();
    expect(useAnnotationStore.getState().author).toBe('');
    unmount();
    resetAuthorPrompt();
    render(<CommentsPanel />);
    await screen.findByRole('region', { name: 'Page 2' });
    expect(screen.queryByLabelText('Name on your comments')).toBeNull();
  });

  it('asks again from the palette ("Set comment author name…"), focused and prefilled', async () => {
    useAnnotationStore.getState().setAuthor('Ada');
    useAuthorPrompt.getState().answer();
    const dispose = registerAppCommands();
    try {
      render(<CommentsPanel />);
      expect(screen.queryByLabelText('Name on your comments')).toBeNull();
      expect(commandRegistry.get('comments.setAuthor')?.title).toBe('Set comment author name…');
      await act(() => commandRegistry.execute('comments.setAuthor'));
      expect(useUiStore.getState().leftPanelView).toBe('comments');
      const field = await screen.findByLabelText('Name on your comments');
      expect(field).toHaveValue('Ada');
      expect(field).toHaveFocus();
      await userEvent.fill(field, 'Grace');
      await userEvent.keyboard('{Enter}');
      expect(useAnnotationStore.getState().author).toBe('Grace');
      expect(screen.queryByLabelText('Name on your comments')).toBeNull();
    } finally {
      dispose();
    }
  });
});
