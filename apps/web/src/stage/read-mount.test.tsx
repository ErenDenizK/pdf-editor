/**
 * Read mode mounting (Vitest browser mode, Chromium, real PDFium): the virtualized page
 * column lays out its rows on the first mount, with nothing else re-rendering it (no fit
 * zoom, no scroll), and a Read view mounted while hidden lays out once it is shown.
 *
 * Regression: the column's virtualizer read its scroll element (the Read viewport, a
 * parent element) from a ref in its mount layout effect, before React had attached that
 * ref, and so never observed it. Read mode stayed blank until a window resize re-rendered
 * the view (Arrange → Read, or a document opened in Read mode).
 */
import '../styles/tokens.css';
import '../styles/reset.css';
import '../styles/global.css';

import type { VirtualDocument } from '@pdf-editor/document-model';
import { render, waitFor } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';

import simpleTextUrl from '../../../../test/fixtures/simple-text.pdf?url';
import { openDocuments } from '../commands/app-commands';
import { useSelectionStore } from '../state/selection-store';
import { useUiStore } from '../state/ui-store';
import { useViewStore } from '../state/view-store';
import { resetWorkspace, useWorkspaceStore } from '../state/workspace-store';
import { ReadView } from './ReadView';

function activeDocument(): VirtualDocument {
  const { workspace } = useWorkspaceStore.getState();
  const doc = workspace.documents[workspace.documentOrder[0] ?? ('' as never)];
  if (!doc) throw new Error('not opened');
  return doc;
}

/** The Read view in a sized column, like the stage. */
function Host({ doc, hidden }: { readonly doc: VirtualDocument; readonly hidden: boolean }) {
  return (
    <div
      data-testid="host"
      style={{ display: hidden ? 'none' : 'flex', flexDirection: 'column', height: 600 }}
    >
      <ReadView doc={doc} />
    </div>
  );
}

const pageSheets = (container: HTMLElement) =>
  container.querySelectorAll('[data-read-viewport] [data-page-index]');

describe('Read mode: mounting', () => {
  beforeAll(async () => {
    await page.viewport(1280, 900);
    resetWorkspace();
    useSelectionStore.getState().apply({ selected: new Set(), anchor: null, focused: null });
    const bytes = await (await fetch(simpleTextUrl)).arrayBuffer();
    await openDocuments([new File([bytes], 'simple-text.pdf', { type: 'application/pdf' })]);
  });

  it('lays out the pages on the first mount, without a re-render', async () => {
    // A fixed zoom: no fit-to-width update re-renders the view after it mounts.
    useUiStore.getState().setZoom(0.5);
    useViewStore.getState().setCurrentPage(0);
    const { container } = render(<Host doc={activeDocument()} hidden={false} />);
    await waitFor(() => expect(pageSheets(container).length).toBeGreaterThan(0), {
      timeout: 1000,
    });
    await waitFor(() =>
      expect(
        container.querySelector('[data-read-viewport] canvas[data-state="rendered"]'),
      ).not.toBeNull(),
    );
  });

  it('lays out the pages of a view mounted hidden once it is shown', async () => {
    useUiStore.getState().setZoom(0.5);
    const doc = activeDocument();
    const { container, rerender } = render(<Host doc={doc} hidden />);
    // Hidden: the viewport has no size and no row is visible.
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 50)));
    rerender(<Host doc={doc} hidden={false} />);
    await waitFor(() => expect(pageSheets(container).length).toBeGreaterThan(0), {
      timeout: 1000,
    });
    const sheet = pageSheets(container)[0]?.getBoundingClientRect();
    expect(sheet?.height ?? 0).toBeGreaterThan(100);
  });
});
