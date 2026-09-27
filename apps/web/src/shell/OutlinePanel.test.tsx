import {
  addSource,
  createHistory,
  createSequentialIdGenerator,
  createWorkspace,
  type OutlineNode,
  type SourceOutlineNode,
} from '@pdf-editor/document-model';
import { render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';

import { useSelectionStore } from '../state/selection-store';
import { useUiStore } from '../state/ui-store';
import { useViewStore } from '../state/view-store';
import { resetWorkspace, useWorkspaceStore } from '../state/workspace-store';
import { TooltipProvider } from '../ui/Tooltip';
import { OutlinePanel, VIRTUALIZE_AFTER } from './OutlinePanel';
import { flattenOutline, initiallyExpanded, openableUrl } from './OutlinePanel.tree';

const FLAGS = {
  encrypted: false,
  repaired: false,
  hasAcroForm: false,
  hasXfa: false,
  hasSignatures: false,
  tagged: false,
  linearized: false,
};

const OUTLINE: SourceOutlineNode[] = [
  { title: 'Chapter 1', open: false, children: [], destination: { kind: 'page', pageIndex: 0 } },
  {
    title: 'Chapter 2',
    open: true,
    destination: { kind: 'page', pageIndex: 1 },
    children: [
      {
        title: '2.1 Setup',
        open: false,
        children: [],
        destination: { kind: 'page', pageIndex: 2 },
      },
      {
        title: '2.2 Results',
        open: false,
        destination: { kind: 'page', pageIndex: 3 },
        children: [
          {
            title: '2.2.1 Details',
            open: false,
            children: [],
            destination: { kind: 'page', pageIndex: 3 },
          },
        ],
      },
    ],
  },
  {
    title: 'Website',
    open: false,
    children: [],
    destination: { kind: 'uri', uri: 'https://example.com/docs' },
  },
  {
    title: 'Gone',
    open: false,
    children: [],
    destination: { kind: 'unresolved', reason: 'deleted' },
  },
];

function loadDocument(outline: readonly SourceOutlineNode[] = OUTLINE, pageCount = 4) {
  const { workspace } = addSource(
    createWorkspace(),
    {
      name: 'book.pdf',
      byteLength: 4,
      pageCount,
      pages: Array.from({ length: pageCount }, () => ({
        size: { width: 612, height: 792 },
        rotation: 0 as const,
      })),
      fingerprint: 'outline-test',
      flags: FLAGS,
      metadata: { policy: 'inherit-first-source' },
      outline,
    },
    createSequentialIdGenerator('outline'),
  );
  useWorkspaceStore.setState({ history: createHistory(workspace), workspace });
  const docId = workspace.documentOrder[0]!;
  return workspace.documents[docId]!;
}

function renderPanel() {
  return render(
    <TooltipProvider>
      <div style={{ display: 'flex', flexDirection: 'column', height: 400, width: 260 }}>
        <OutlinePanel />
      </div>
    </TooltipProvider>,
  );
}

describe('outline tree helpers', () => {
  const nodes: OutlineNode[] = [
    { title: 'A', open: true, children: [{ title: 'A1', open: false, children: [] }] },
    { title: 'B', open: false, children: [{ title: 'B1', open: false, children: [] }] },
  ];

  it('expands nodes as authored and flattens visible rows with APG metadata', () => {
    const expanded = initiallyExpanded(nodes);
    expect([...expanded]).toEqual(['0']);
    const rows = flattenOutline(nodes, expanded);
    expect(rows.map((r) => [r.key, r.level, r.posInSet, r.setSize, r.expanded])).toEqual([
      ['0', 1, 1, 2, true],
      ['0.0', 2, 1, 1, false],
      ['1', 1, 2, 2, false],
    ]);
    expect(rows[1]?.parentKey).toBe('0');
  });

  it('only opens http(s) and mailto links', () => {
    expect(openableUrl('https://example.com')?.host).toBe('example.com');
    expect(openableUrl('mailto:a@example.com')).toBeDefined();
    expect(openableUrl('javascript:alert(1)')).toBeUndefined();
    expect(openableUrl('file:///etc/passwd')).toBeUndefined();
    expect(openableUrl('not a url')).toBeUndefined();
  });
});

describe('OutlinePanel', () => {
  beforeEach(() => {
    resetWorkspace();
    useUiStore.setState({ viewMode: 'read' });
    useSelectionStore.getState().apply({ selected: new Set(), anchor: null, focused: null });
  });
  afterEach(() => {
    resetWorkspace();
    vi.restoreAllMocks();
  });

  it('shows the quiet empty states', () => {
    const { unmount } = renderPanel();
    expect(screen.getByText('No document open')).toBeVisible();
    unmount();
    loadDocument([]);
    renderPanel();
    expect(screen.getByText('No outline')).toBeVisible();
  });

  it('renders the tree honouring open flags, with warnings for unresolved nodes', () => {
    loadDocument();
    renderPanel();
    const tree = screen.getByRole('tree', { name: 'Outline of book' });
    const items = within(tree).getAllByRole('treeitem');
    expect(items.map((i) => i.children[1]?.textContent)).toEqual([
      'Chapter 1',
      'Chapter 2',
      '2.1 Setup',
      '2.2 Results',
      'Website',
      'Gone',
    ]);
    expect(items[0]).toHaveAccessibleName('Chapter 1');
    expect(items[0]).toHaveAccessibleDescription('Page 1');
    expect(within(tree).getByRole('treeitem', { name: /Chapter 2/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    const gone = within(tree).getByRole('treeitem', { name: /Gone/ });
    expect(gone).toHaveAccessibleDescription('Target page was removed');
    expect(gone.dataset.kind).toBe('unresolved');
  });

  it('supports APG tree keyboard navigation and navigates to pages', async () => {
    const doc = loadDocument();
    renderPanel();
    const first = screen.getByRole('treeitem', { name: /Chapter 1/ });
    first.focus();
    await userEvent.keyboard('{ArrowDown}');
    const chapter2 = screen.getByRole('treeitem', { name: /Chapter 2/ });
    await waitFor(() => expect(chapter2).toHaveFocus());
    await userEvent.keyboard('{ArrowLeft}');
    await waitFor(() => expect(chapter2).toHaveAttribute('aria-expanded', 'false'));
    expect(screen.queryByRole('treeitem', { name: /2\.1 Setup/ })).toBeNull();
    await userEvent.keyboard('{ArrowRight}{ArrowRight}');
    await waitFor(() => expect(screen.getByRole('treeitem', { name: /2\.1 Setup/ })).toHaveFocus());
    await userEvent.keyboard('{ArrowLeft}');
    await waitFor(() => expect(chapter2).toHaveFocus());
    await userEvent.keyboard('{End}');
    await waitFor(() => expect(screen.getByRole('treeitem', { name: /Gone/ })).toHaveFocus());
    await userEvent.keyboard('{Home}{Enter}');
    await waitFor(() => {
      expect(useViewStore.getState().scrollRequest?.pageId).toBe(doc.pages[0]!.id);
    });
  });

  it('selects the target page in Arrange mode', async () => {
    const doc = loadDocument();
    useUiStore.setState({ viewMode: 'arrange' });
    renderPanel();
    await userEvent.click(screen.getByRole('treeitem', { name: /2\.1 Setup/ }));
    expect([...useSelectionStore.getState().selected]).toEqual([doc.pages[2]!.id]);
    expect(useSelectionStore.getState().focused).toBe(doc.pages[2]!.id);
  });

  it('asks before opening a link and never navigates on its own', async () => {
    loadDocument();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    renderPanel();
    await userEvent.click(screen.getByRole('treeitem', { name: /Website/ }));
    const notice = await screen.findByRole('group', { name: 'Open this link in a new tab?' });
    expect(notice).toHaveTextContent('example.com');
    expect(open).not.toHaveBeenCalled();
    await userEvent.click(within(notice).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('group', { name: /Open this link/ })).toBeNull();
    expect(open).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('treeitem', { name: /Website/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Open link' }));
    expect(open).toHaveBeenCalledWith('https://example.com/docs', '_blank', 'noopener,noreferrer');
  });

  it(`virtualizes only beyond ${VIRTUALIZE_AFTER} visible rows`, async () => {
    const many: SourceOutlineNode[] = Array.from({ length: VIRTUALIZE_AFTER + 100 }, (_, i) => ({
      title: `Item ${i + 1}`,
      open: false,
      children: [],
      destination: { kind: 'page', pageIndex: 0 },
    }));
    loadDocument(many, 1);
    renderPanel();
    const rendered = (await screen.findAllByRole('treeitem')).length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(VIRTUALIZE_AFTER);
  });
});
