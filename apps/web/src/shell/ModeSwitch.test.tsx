/**
 * Home as a view and the Read · Edit · Arrange control (ADR-0019 §1–§2, craft §3.1–§3.2):
 * the segments, the lock glyph, keys 0–4, arrows, announcements, the shared page view, and
 * the tab bar on Home. Model-only documents (never opened by the engine): their pages fail
 * to render quietly, which is all the shell needs here.
 */
import '../styles/tokens.css';
import '../styles/reset.css';
import '../styles/global.css';

import {
  addSource,
  createHistory,
  createSequentialIdGenerator,
  createWorkspace,
  type DocumentId,
  type Workspace,
} from '@pdf-editor/document-model';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';

import { App } from '../app';
import { resetCompareStore } from '../compare/compare-store';
import { documentModeOf, stageView, useUiStore } from '../state/ui-store';
import { resetWorkspace, useWorkspaceStore } from '../state/workspace-store';
import { useAnnouncer } from './announcer';

const ids = createSequentialIdGenerator('mode');

function withSource(workspace: Workspace, name: string): Workspace {
  return addSource(
    workspace,
    {
      name,
      byteLength: 4,
      pageCount: 2,
      pages: [
        { size: { width: 612, height: 792 }, rotation: 0 },
        { size: { width: 612, height: 792 }, rotation: 0 },
      ],
      fingerprint: name,
      flags: {
        encrypted: false,
        repaired: false,
        hasAcroForm: false,
        hasXfa: false,
        hasSignatures: false,
        tagged: false,
        linearized: false,
      },
      metadata: { policy: 'inherit-first-source' },
      outline: [],
    },
    ids,
  ).workspace;
}

/** Opens `report` and `invoice` (report active) in the model only. */
function openTwo(): { report: DocumentId; invoice: DocumentId } {
  const workspace = withSource(withSource(createWorkspace(), 'report.pdf'), 'invoice.pdf');
  const [report, invoice] = workspace.documentOrder;
  if (report === undefined || invoice === undefined) throw new Error('not opened');
  act(() => {
    useWorkspaceStore.setState({
      history: createHistory(workspace),
      workspace: { ...workspace, activeDocument: report },
    });
  });
  return { report, invoice };
}

const control = () => screen.getByRole('radiogroup', { name: 'View mode' });
const segment = (name: string) => within(control()).getByRole('radio', { name });
const checked = () =>
  within(control())
    .getAllByRole('radio')
    .find((radio) => radio.getAttribute('aria-checked') === 'true')
    ?.getAttribute('data-mode');
const tabs = () => screen.getByRole('tablist', { name: 'Open documents' });
const announced = () => useAnnouncer.getState().message;
const shown = () => stageView(useUiStore.getState());

describe('Read · Edit · Arrange', () => {
  beforeEach(async () => {
    await page.viewport(1440, 900);
    resetWorkspace();
    resetCompareStore();
    useUiStore.setState({
      destination: 'document',
      viewMode: 'read',
      documentMode: {},
      lastView: {},
      paletteOpen: false,
      shortcutsOpen: false,
    });
    useAnnouncer.setState({ message: '' });
  });
  afterEach(() => {
    resetWorkspace();
  });

  it('shows Read with a lock, Edit and Arrange; Compare only while a comparison is open', async () => {
    render(<App />);
    openTwo();
    await screen.findByRole('tab', { name: 'report', selected: true });
    const radios = within(control()).getAllByRole('radio');
    expect(radios.map((radio) => radio.textContent)).toEqual(['Read', 'Edit', 'Arrange']);
    expect(radios.map((radio) => radio.getAttribute('aria-keyshortcuts'))).toEqual(['1', '2', '3']);
    // The lock carries the mode without colour: a glyph and the name.
    const read = segment('Read, locked');
    expect(read).toHaveAttribute('aria-checked', 'true');
    expect(within(read).getByTestId('read-lock')).toHaveAttribute('aria-hidden', 'true');
    expect(segment('Edit')).not.toHaveAttribute('aria-label');
    // Only the checked segment is a Tab stop (APG radio group).
    expect(radios.map((radio) => radio.tabIndex)).toEqual([0, -1, -1]);
    expect(within(control()).queryByRole('radio', { name: 'Compare' })).toBeNull();
  });

  it('switches with 1–4 and announces the mode; Read and Edit share the page view', async () => {
    render(<App />);
    const { report } = openTwo();
    const viewport = await screen.findByRole('region', { name: 'Pages of report' });

    await userEvent.keyboard('2');
    expect(checked()).toBe('edit');
    expect(documentModeOf(useUiStore.getState(), report)).toBe('edit');
    expect(useUiStore.getState().viewMode).toBe('read');
    expect(announced()).toBe('Edit mode');
    // The same page view, never remounted: switching never moves the page.
    expect(screen.getByRole('region', { name: 'Pages of report' })).toBe(viewport);

    await userEvent.keyboard('1');
    expect(checked()).toBe('read');
    expect(documentModeOf(useUiStore.getState(), report)).toBe('read');
    expect(announced()).toBe('Read mode, locked');
    expect(screen.getByRole('region', { name: 'Pages of report' })).toBe(viewport);

    await userEvent.keyboard('3');
    expect(checked()).toBe('arrange');
    expect(shown()).toBe('arrange');

    // 4 with no comparison open starts one; its segment appears and is checked.
    await userEvent.keyboard('4');
    expect(shown()).toBe('compare');
    await waitFor(() => {
      expect(segment('Compare')).toHaveAttribute('aria-checked', 'true');
    });
  });

  it('keeps Edit through Arrange, per document', async () => {
    render(<App />);
    const { report, invoice } = openTwo();
    await screen.findByRole('tab', { name: 'report', selected: true });
    await userEvent.click(segment('Edit'));
    expect(announced()).toBe('Edit mode');
    await userEvent.click(segment('Arrange'));
    expect(checked()).toBe('arrange');
    await userEvent.click(segment('Read, locked'));
    expect(checked()).toBe('read');
    await userEvent.keyboard('2');
    act(() => useWorkspaceStore.getState().setActive(invoice));
    // invoice was never put in Edit: it opens locked on the same view.
    expect(checked()).toBe('read');
    act(() => useWorkspaceStore.getState().setActive(report));
    expect(checked()).toBe('edit');
  });

  it('moves and selects with the arrows (APG radio group)', async () => {
    render(<App />);
    openTwo();
    await screen.findByRole('tab', { name: 'report', selected: true });
    segment('Read, locked').focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(checked()).toBe('edit');
    expect(segment('Edit')).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}');
    expect(checked()).toBe('arrange');
    expect(segment('Arrange')).toHaveFocus();
    // Wraps from the last segment to the first.
    await userEvent.keyboard('{ArrowRight}');
    expect(checked()).toBe('read');
    await userEvent.keyboard('{ArrowLeft}');
    expect(checked()).toBe('arrange');
  });

  it('goes Home with 0 and the glyph; Home has no control and no selected tab', async () => {
    render(<App />);
    openTwo();
    await screen.findByRole('tab', { name: 'report', selected: true });
    const glyph = screen.getByRole('button', { name: 'Home' });
    expect(glyph).not.toHaveAttribute('aria-current');

    await userEvent.keyboard('0');
    expect(shown()).toBe('home');
    expect(screen.queryByRole('radiogroup', { name: 'View mode' })).toBeNull();
    expect(glyph).toHaveAttribute('aria-current', 'page');
    expect(within(tabs()).queryByRole('tab', { selected: true })).toBeNull();
    // The active tab stays the Tab stop of the tab list.
    expect(screen.getByRole('tab', { name: 'report' })).toHaveAttribute('tabindex', '0');

    await userEvent.keyboard('1');
    expect(shown()).toBe('read');
    await userEvent.click(glyph);
    expect(shown()).toBe('home');
  });
});

describe('the tab bar on Home', () => {
  beforeEach(async () => {
    await page.viewport(1440, 900);
    resetWorkspace();
    resetCompareStore();
    useUiStore.setState({
      destination: 'document',
      viewMode: 'read',
      documentMode: {},
      lastView: {},
    });
  });
  afterEach(() => {
    resetWorkspace();
  });

  it('leaves Home by a tab click, for that document in its last view and mode', async () => {
    render(<App />);
    const { invoice } = openTwo();
    await screen.findByRole('tab', { name: 'report', selected: true });
    // invoice: last shown in Arrange, in Edit. report: Read.
    await userEvent.click(screen.getByRole('tab', { name: 'invoice' }));
    await userEvent.keyboard('2');
    await userEvent.keyboard('3');
    await userEvent.click(screen.getByRole('tab', { name: 'report' }));
    await userEvent.keyboard('1');
    await userEvent.keyboard('0');
    expect(shown()).toBe('home');

    await userEvent.click(screen.getByRole('tab', { name: 'invoice' }));
    expect(shown()).toBe('arrange');
    expect(useWorkspaceStore.getState().workspace.activeDocument).toBe(invoice);
    expect(screen.getByRole('tab', { name: 'invoice', selected: true })).toBeVisible();
    expect(documentModeOf(useUiStore.getState(), invoice)).toBe('edit');

    await userEvent.keyboard('0');
    await userEvent.click(screen.getByRole('tab', { name: 'report' }));
    expect(shown()).toBe('read');
    expect(checked()).toBe('read');
  });

  it('switches tabs without leaving the view when not on Home', async () => {
    render(<App />);
    openTwo();
    await screen.findByRole('tab', { name: 'report', selected: true });
    await userEvent.keyboard('3');
    await userEvent.click(screen.getByRole('tab', { name: 'invoice' }));
    expect(shown()).toBe('arrange');
  });
});
