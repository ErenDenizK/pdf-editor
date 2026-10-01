import {
  addSource,
  createHistory,
  createSequentialIdGenerator,
  createWorkspace,
} from '@pdf-editor/document-model';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';

import { App } from '../app';
import { currentPlatform } from '../commands/shortcuts';
import { useUiStore } from '../state/ui-store';
import { resetWorkspace, useWorkspaceStore } from '../state/workspace-store';

const MOD = currentPlatform === 'mac' ? 'Meta' : 'Control';

describe('AppShell', () => {
  beforeEach(() => {
    useUiStore.setState({
      paletteOpen: false,
      shortcutsOpen: false,
      recents: [],
    });
    resetWorkspace();
  });

  it('renders the shell with the empty state and privacy indicator', () => {
    render(<App />);
    expect(screen.getByTestId('app-shell')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Drop PDFs to start' })).toBeVisible();
    expect(screen.getByText(/external requests?/)).toBeVisible();
  });

  it('opens the command palette on Mod+K with focus in the input, and closes on Esc', async () => {
    render(<App />);
    await userEvent.keyboard(`{${MOD}>}k{/${MOD}}`);
    const input = await screen.findByRole('combobox', { name: 'Search commands' });
    await waitFor(() => {
      expect(input).toHaveFocus();
    });
    expect(screen.getByRole('option', { name: /Toggle left panel/ })).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('combobox', { name: 'Search commands' })).not.toBeInTheDocument();
      // The backdrop must unmount too, or it would swallow every click afterwards.
      expect(document.querySelector('[data-base-ui-portal]')).toBeNull();
    });
  });

  it('filters palette results and runs the active command with Enter', async () => {
    render(<App />);
    await userEvent.keyboard(`{${MOD}>}k{/${MOD}}`);
    const input = await screen.findByRole('combobox', { name: 'Search commands' });
    await userEvent.type(input, 'arrange');
    await waitFor(() => {
      expect(screen.getAllByRole('option')[0]).toHaveTextContent('Arrange pages');
    });
    await userEvent.keyboard('{Enter}');
    await waitFor(() => {
      expect(useUiStore.getState().viewMode).toBe('arrange');
    });
    expect(useUiStore.getState().recents[0]).toBe('mode.arrange');
  });

  it('opens documents as tabs', async () => {
    render(<App />);
    // A model-only source (never opened by the engine): the shell must still show the tab,
    // and its pages fail to render quietly.
    const { workspace } = addSource(
      createWorkspace(),
      {
        name: 'report.pdf',
        byteLength: 4,
        pageCount: 1,
        pages: [{ size: { width: 612, height: 792 }, rotation: 0 }],
        fingerprint: 'test',
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
      createSequentialIdGenerator('test'),
    );
    useWorkspaceStore.setState({ history: createHistory(workspace), workspace });
    expect(await screen.findByRole('tab', { name: 'report', selected: true })).toBeVisible();
    expect(screen.getByRole('toolbar', { name: 'Tools' })).toBeVisible();
  });
});
