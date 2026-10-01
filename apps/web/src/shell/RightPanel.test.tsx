/**
 * The inspector closed by default and never opened by the app (experience-redesign §4.2,
 * decision 4), and the Document info sheet that took over its metadata form.
 */
import { act, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';

import annotationsUrl from '../../../../test/fixtures/annotations.pdf?url';
import simpleUrl from '../../../../test/fixtures/simple-text.pdf?url';
import { fixtureFile } from '../../test/store-harness';
import { resetAnnotationStore, useAnnotationStore } from '../annotations/annotation-store';
import { resetEditRunner, whenIdle } from '../annotations/edit-runner';
import { commandRegistry } from '../commands/registry';
import { registerDocumentCommands } from '../document/document-commands';
import { DocumentDialogs } from '../document/DocumentDialogs';
import { closeDocumentDialog } from '../document/document-store';
import { resetFormStore } from '../forms/form-store';
import { DEFAULT_LAYOUT, useUiStore } from '../state/ui-store';
import { resetWorkspace, useWorkspaceStore } from '../state/workspace-store';
import { ReviewPanel } from './review/ReviewPanel';
import { RightPanel } from './RightPanel';

const open = async (url: string, name: string) => {
  const report = await useWorkspaceStore.getState().openFiles([await fixtureFile(url, name)]);
  expect(report.skipped).toEqual([]);
};

const inspector = () => screen.queryByRole('complementary', { name: 'Inspector' });

beforeEach(() => {
  resetWorkspace();
  resetEditRunner();
  resetAnnotationStore();
  resetFormStore();
  closeDocumentDialog();
  useUiStore.setState({ ...DEFAULT_LAYOUT, viewMode: 'read' });
});
afterEach(async () => {
  await whenIdle();
  closeDocumentDialog();
  resetWorkspace();
  useUiStore.setState({ ...DEFAULT_LAYOUT, viewMode: 'read' });
});

describe('Inspector', () => {
  it('is closed by default and stays closed when an annotation is selected', async () => {
    await open(annotationsUrl, 'annotations.pdf');
    render(
      <>
        <ReviewPanel />
        <RightPanel />
      </>,
    );
    expect(useUiStore.getState().rightPanelOpen).toBe(false);
    expect(inspector()).toBeNull();
    // An explicit select from a Review row: the selection exists, the inspector does not.
    await userEvent.click(await screen.findByText('Sticky note text on page 2'));
    expect(useAnnotationStore.getState().selection?.ids).toEqual(['fixture-annot-text-1']);
    expect(useUiStore.getState().rightPanelOpen).toBe(false);
    expect(inspector()).toBeNull();

    // Opened by the person, it shows the selection.
    act(() => useUiStore.getState().toggleRightPanel());
    expect(inspector()).not.toBeNull();
    expect(within(inspector() as HTMLElement).getByText('1 annotation')).toBeVisible();
  });

  it('keeps Selection, Properties, History and Info; the metadata form is not in it', async () => {
    await open(simpleUrl, 'simple-text.pdf');
    useUiStore.setState({ rightPanelOpen: true });
    render(
      <>
        <RightPanel />
        <DocumentDialogs />
      </>,
    );
    const panel = inspector() as HTMLElement;
    for (const name of ['Selection', 'Properties', 'History', 'Info']) {
      expect(within(panel).getByRole('heading', { name })).toBeVisible();
    }
    expect(within(panel).queryByTestId('metadata-editor')).toBeNull();
    expect(within(panel).getByText('simple-text.pdf')).toBeVisible();

    await userEvent.click(within(panel).getByRole('button', { name: 'Document info…' }));
    const sheet = await screen.findByRole('dialog', { name: 'Document info' });
    expect(within(sheet).getByTestId('metadata-editor')).toBeVisible();
    expect(within(sheet).getByLabelText('Title')).toHaveFocus();
    expect(within(sheet).getByTestId('security-outcome')).toBeVisible();
  });
});

describe('Document info sheet', () => {
  it('opens from the "Document info…" command and comes back after a password dialog', async () => {
    await open(simpleUrl, 'simple-text.pdf');
    const dispose = registerDocumentCommands(commandRegistry);
    try {
      render(<DocumentDialogs />);
      expect(commandRegistry.get('document.info')?.title).toBe('Document info…');
      await act(() => commandRegistry.execute('document.info'));
      const sheet = await screen.findByRole('dialog', { name: 'Document info' });
      expect(within(sheet).getByTestId('metadata-editor')).toBeVisible();
      expect(useUiStore.getState().rightPanelOpen).toBe(false);

      await userEvent.click(within(sheet).getByRole('button', { name: 'Set password…' }));
      const password = await screen.findByTestId('set-password-dialog');
      await userEvent.click(within(password).getByRole('button', { name: 'Cancel' }));
      expect(await screen.findByRole('dialog', { name: 'Document info' })).toBeVisible();

      await userEvent.keyboard('{Escape}');
      await expect.poll(() => screen.queryByRole('dialog', { name: 'Document info' })).toBeNull();
    } finally {
      dispose();
    }
  });
});
