/**
 * End-to-end inside the browser: a real PDF goes through the PDFium adapter (in its worker),
 * lands in the document model, and renders as thumbnails and pages.
 */
import '../styles/tokens.css';
import '../styles/reset.css';
import '../styles/global.css';

import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';

import fixtureUrl from '../../../../test/fixtures/simple-text.pdf?url';
import { App } from '../app';
import { openDocuments } from '../commands/app-commands';
import { useSelectionStore } from '../state/selection-store';
import { useUiStore } from '../state/ui-store';
import { resetWorkspace, useWorkspaceStore } from '../state/workspace-store';

async function fixtureFile(): Promise<File> {
  const bytes = await (await fetch(fixtureUrl)).arrayBuffer();
  return new File([bytes], 'simple-text.pdf', { type: 'application/pdf' });
}

describe('engine integration', () => {
  beforeEach(async () => {
    // Desktop layout: both side panels plus a stage.
    await page.viewport(1280, 800);
    resetWorkspace();
    useSelectionStore.getState().apply({ selected: new Set(), anchor: null, focused: null });
    useUiStore.setState({ viewMode: 'read', fitMode: 'width', paletteOpen: false });
  });
  afterEach(() => {
    resetWorkspace();
  });

  it('opens a PDF, renders thumbnails and pages, and reports the page count', async () => {
    render(<App />);
    await openDocuments([await fixtureFile()]);

    expect(await screen.findByRole('tab', { name: 'simple-text', selected: true })).toBeVisible();
    await waitFor(
      () => {
        expect(
          document.querySelector('[role="listbox"] canvas[data-state="rendered"]'),
        ).not.toBeNull();
        expect(document.querySelector('main canvas[data-state="rendered"]')).not.toBeNull();
      },
      { timeout: 20_000 },
    );
    const thumbnail = document.querySelector<HTMLCanvasElement>('canvas[data-state="rendered"]');
    expect(thumbnail?.width).toBeGreaterThan(0);
    expect(screen.getByTestId('status-pages')).toHaveTextContent('Page 1 of 3');
    expect(screen.getAllByRole('option')).toHaveLength(3);

    useUiStore.getState().setViewMode('arrange');
    await waitFor(() => {
      expect(screen.getAllByRole('gridcell')).toHaveLength(3);
    });
    expect(screen.getByTestId('status-pages')).toHaveTextContent('3 pages');
  }, 30_000);

  it('rotates the selection with R and undoes it with Mod+Z', async () => {
    render(<App />);
    await openDocuments([await fixtureFile()]);
    useUiStore.getState().setViewMode('arrange');
    const cells = await screen.findAllByRole('gridcell');
    await userEvent.click(cells[1]!);
    expect(cells[1]).toHaveAttribute('aria-selected', 'true');

    await userEvent.keyboard('r');
    await waitFor(() => {
      expect(screen.getAllByRole('gridcell')[1]).toHaveAccessibleName(/rotated 90 degrees/);
    });
    expect(useWorkspaceStore.getState().history.present.label).toBe('Rotate 1 page');

    const mod = navigator.platform.toLowerCase().includes('mac') ? 'Meta' : 'Control';
    await userEvent.keyboard(`{${mod}>}z{/${mod}}`);
    await waitFor(() => {
      expect(screen.getAllByRole('gridcell')[1]).not.toHaveAccessibleName(/rotated/);
    });
  }, 30_000);
});
