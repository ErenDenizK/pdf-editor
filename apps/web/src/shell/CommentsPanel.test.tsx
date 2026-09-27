import { render, screen, within } from '@testing-library/react';
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
import { resetWorkspace, useWorkspaceStore } from '../state/workspace-store';
import { CommentsPanel } from './CommentsPanel';

describe('Comments panel', () => {
  beforeEach(() => {
    resetWorkspace();
    resetEditRunner();
    resetAnnotationStore();
  });
  afterEach(() => {
    localStorage.removeItem(AUTHOR_STORAGE_KEY);
    resetWorkspace();
  });

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

  it('keeps the author name for new annotations in localStorage', async () => {
    render(<CommentsPanel />);
    const field = screen.getByLabelText('Your name on new annotations');
    await userEvent.fill(field, 'Ada');
    expect(useAnnotationStore.getState().author).toBe('Ada');
    expect(JSON.parse(localStorage.getItem(AUTHOR_STORAGE_KEY) ?? '""')).toBe('Ada');
  });
});
