/**
 * The navigator (experience-redesign §4.1, §10): four labelled tabs with counts in their
 * accessible names, Compare's Changes only in Compare and last, a roving tabindex, the
 * Pages tab's Bookmarks switch (remembered), and the tabs' panels.
 */
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';

import formsAUrl from '../../../../test/fixtures/forms-a.pdf?url';
import outlineUrl from '../../../../test/fixtures/outline-named-dests.pdf?url';
import { fixtureFile } from '../../test/store-harness';
import { resetAnnotationStore } from '../annotations/annotation-store';
import { resetEditRunner, whenIdle } from '../annotations/edit-runner';
import { resetFormStore } from '../forms/form-store';
import { DEFAULT_LAYOUT, LAYOUT_STORAGE_KEY, useUiStore } from '../state/ui-store';
import { closeOperationDialog, useOperationDialogStore } from '../stage/operation-dialogs-store';
import { resetWorkspace, useWorkspaceStore } from '../state/workspace-store';
import { badgeText, LeftRail } from './LeftRail';

const open = async (url: string, name: string) => {
  const report = await useWorkspaceStore.getState().openFiles([await fixtureFile(url, name)]);
  expect(report.skipped).toEqual([]);
};

const rail = () => screen.getByRole('tablist', { name: 'Navigator views' });
const tabNames = () =>
  within(rail())
    .getAllByRole('tab')
    .map((tab) => tab.getAttribute('aria-label'));

beforeEach(() => {
  resetWorkspace();
  resetEditRunner();
  resetAnnotationStore();
  resetFormStore();
  useUiStore.setState({ ...DEFAULT_LAYOUT, viewMode: 'read' });
});
afterEach(async () => {
  await whenIdle();
  resetWorkspace();
  useUiStore.setState({ ...DEFAULT_LAYOUT, viewMode: 'read' });
  localStorage.removeItem(LAYOUT_STORAGE_KEY);
});

describe('Navigator', () => {
  it('shows four labelled tabs; counts are in the names and on the badges', async () => {
    render(<LeftRail />);
    expect(tabNames()).toEqual(['Pages', 'Find', 'Review', 'Files']);
    expect(
      within(rail())
        .getAllByRole('tab')
        .map((tab) => tab.textContent),
    ).toEqual(['Pages', 'Find', 'Review', 'Files']);

    await open(formsAUrl, 'forms-a.pdf');
    await expect.poll(() => tabNames()[2]).toMatch(/^Review, \d+ items$/);
    expect(tabNames()[0]).toBe('Pages, 2 items');
    expect(tabNames()[1]).toBe('Find');
    expect(tabNames()[3]).toBe('Files, 1 item');
    expect(screen.getByTestId('rail-count-pages')).toHaveTextContent('2');
    expect(screen.queryByTestId('rail-count-find')).toBeNull();
  });

  it('caps the badge at 99+ and hides it at 0', () => {
    expect(badgeText(0)).toBe('');
    expect(badgeText(7)).toBe('7');
    expect(badgeText(99)).toBe('99');
    expect(badgeText(100)).toBe('99+');
  });

  it('adds Changes only in Compare, after the four', () => {
    render(<LeftRail />);
    act(() => useUiStore.getState().setViewMode('compare'));
    expect(tabNames()).toEqual(['Pages', 'Find', 'Review', 'Files', 'Changes']);
    act(() => useUiStore.getState().setViewMode('read'));
    expect(tabNames()).toEqual(['Pages', 'Find', 'Review', 'Files']);
  });

  it('is a tablist with a roving tabindex; Enter opens, the open tab again collapses', async () => {
    render(<LeftRail />);
    const tabs = within(rail()).getAllByRole('tab');
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1, -1]);
    expect(rail()).toHaveAttribute('aria-orientation', 'vertical');
    tabs[0]?.focus();
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    expect(tabs[2]).toHaveFocus();
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([-1, -1, 0, -1]);
    await userEvent.keyboard('{Enter}');
    expect(useUiStore.getState().leftPanelView).toBe('review');
    expect(tabs[2]).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'rail-review');
    expect(document.querySelector('[data-review-panel]')).not.toBeNull();
    await userEvent.keyboard('{End}');
    expect(tabs[3]).toHaveFocus();
    await userEvent.keyboard('{Home}');
    expect(tabs[0]).toHaveFocus();
    await userEvent.click(tabs[2] as HTMLElement);
    expect(useUiStore.getState().leftPanelOpen).toBe(false);
  });

  it('stays collapsed while no file is open and reopens as it was when one opens', async () => {
    useUiStore.setState({ leftPanelOpen: true, leftPanelView: 'review' });
    render(<LeftRail />);
    expect(screen.queryByRole('tabpanel')).toBeNull();
    expect(within(rail()).queryByRole('tab', { selected: true })).toBeNull();
    // The stored state is untouched.
    expect(useUiStore.getState().leftPanelOpen).toBe(true);

    await open(formsAUrl, 'forms-a.pdf');
    expect(await screen.findByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'rail-review');

    // A tab picked while no file is open opens the panel anyway.
    act(() => resetWorkspace());
    expect(screen.queryByRole('tabpanel')).toBeNull();
    await userEvent.click(within(rail()).getByRole('tab', { name: 'Files' }));
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'rail-files');
    expect(screen.getByText('No files open')).toBeVisible();
  });

  it('switches Pages to Bookmarks and remembers it', async () => {
    await open(outlineUrl, 'outline-named-dests.pdf');
    render(<LeftRail />);
    const pagesView = screen.getByRole('radiogroup', { name: 'Pages view' });
    expect(within(pagesView).getByRole('radio', { name: 'Pages' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.queryByRole('tree')).toBeNull();
    await userEvent.click(within(pagesView).getByRole('radio', { name: 'Bookmarks' }));
    expect(await screen.findByRole('tree', { name: /Outline of/ })).toBeVisible();
    expect(screen.getByRole('button', { name: /Add bookmark/ })).toBeVisible();
    expect(JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY) ?? 'null')).toMatchObject({
      leftPanelView: 'pages',
      pagesView: 'bookmarks',
    });

    // Back to the thumbnails; "Add bookmark" lives in Bookmarks only.
    cleanup();
    render(<LeftRail />);
    expect(await screen.findByRole('tree', { name: /Outline of/ })).toBeVisible();
    await userEvent.click(screen.getByRole('radio', { name: 'Pages' }));
    expect(screen.queryByRole('tree')).toBeNull();
    expect(screen.queryByRole('button', { name: /Add bookmark/ })).toBeNull();
    expect(useUiStore.getState().pagesView).toBe('thumbnails');
  });

  it('selects files as Home does, combines them and shows Home', async () => {
    await open(formsAUrl, 'forms-a.pdf');
    await open(outlineUrl, 'outline-named-dests.pdf');
    useUiStore.setState({ leftPanelView: 'files', homeSelection: [], homeAnchor: null });
    render(<LeftRail />);
    // Nothing selected: Combine all.
    expect(screen.getByTestId('files-combine')).toHaveTextContent('Combine all 2 files');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select outline-named-dests' }));
    expect(useUiStore.getState().homeSelection).toHaveLength(1);
    // One selected: nothing to combine, no button.
    expect(screen.queryByTestId('files-combine')).toBeNull();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select forms-a' }));
    const ws = useWorkspaceStore.getState().workspace;
    expect(useUiStore.getState().homeSelection).toEqual([ws.documentOrder[1], ws.documentOrder[0]]);
    expect(screen.getByTestId('files-combine')).toHaveTextContent('Combine 2 files');
    await userEvent.click(screen.getByTestId('files-combine'));
    await expect
      .poll(() => (useOperationDialogStore.getState().dialog as { order?: unknown } | null)?.order)
      .toEqual([ws.documentOrder[1], ws.documentOrder[0]]);
    closeOperationDialog();

    await userEvent.click(screen.getByRole('button', { name: 'Show Home' }));
    expect(useUiStore.getState().viewMode).toBe('home');
  });

  it('lists the open files with pages, size and the active one; × closes', async () => {
    await open(formsAUrl, 'forms-a.pdf');
    await open(outlineUrl, 'outline-named-dests.pdf');
    useUiStore.setState({ leftPanelView: 'files' });
    render(<LeftRail />);
    const list = screen.getByRole('list', { name: 'Open documents' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((row) => row.querySelector('button')?.textContent)).toEqual([
      expect.stringMatching(/^forms-a2 pages · [\d.]+ KB$/),
      expect.stringMatching(/^outline-named-dests6 pages · [\d.]+ KB$/),
    ]);
    expect(rows[1]).toHaveAttribute('aria-current', 'true');
    await userEvent.click(
      within(rows[0] as HTMLElement).getByRole('button', { name: /^forms-a 2 pages/ }),
    );
    expect(within(list).getAllByRole('listitem')[0]).toHaveAttribute('aria-current', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Close outline-named-dests' }));
    expect(useWorkspaceStore.getState().workspace.documentOrder).toHaveLength(1);
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
  });
});
