import {
  addSource,
  createHistory,
  createSequentialIdGenerator,
  createWorkspace,
  deletePages,
  getActiveDocument,
  type OutlineNode,
  type SourceOutlineNode,
  type VirtualDocument,
} from '@pdf-editor/document-model';
import { render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';

import { OutlinePanel } from '../shell/OutlinePanel';
import { useSelectionStore } from '../state/selection-store';
import { useUiStore } from '../state/ui-store';
import { useViewStore } from '../state/view-store';
import { resetWorkspace, useWorkspaceStore } from '../state/workspace-store';
import { TooltipProvider } from '../ui/Tooltip';
import { deadLinkEdits } from './outline-actions';
import { canDropOn, dropGap } from './outline-dnd';
import { resetOutlineView } from './outline-view-store';

const FLAGS = {
  encrypted: false,
  repaired: false,
  hasAcroForm: false,
  hasXfa: false,
  hasSignatures: false,
  tagged: false,
  linearized: false,
};

const leaf = (title: string, pageIndex: number): SourceOutlineNode => ({
  title,
  open: false,
  children: [],
  destination: { kind: 'page', pageIndex },
});

/** One · Two (open) [Two.a, Two.b] · Three · Four */
const OUTLINE: SourceOutlineNode[] = [
  leaf('One', 0),
  { ...leaf('Two', 1), open: true, children: [leaf('Two.a', 2), leaf('Two.b', 3)] },
  leaf('Three', 4),
  leaf('Four', 5),
];

function load(outline: readonly SourceOutlineNode[] = OUTLINE): VirtualDocument {
  const { workspace } = addSource(
    createWorkspace(),
    {
      name: 'book.pdf',
      byteLength: 4,
      pageCount: 6,
      pages: Array.from({ length: 6 }, () => ({
        size: { width: 612, height: 792 },
        rotation: 0 as const,
      })),
      fingerprint: 'outline-edit-test',
      flags: FLAGS,
      metadata: { policy: 'inherit-first-source' },
      outline,
    },
    createSequentialIdGenerator('oe'),
  );
  useWorkspaceStore.setState({ history: createHistory(workspace), workspace });
  return getActiveDocument(workspace) as VirtualDocument;
}

const doc = () => getActiveDocument(useWorkspaceStore.getState().workspace) as VirtualDocument;

/** The model tree as indented titles. */
function titles(nodes: readonly OutlineNode[] = doc().outline, depth = 0): string[] {
  return nodes.flatMap((n) => [
    `${'  '.repeat(depth)}${n.title}`,
    ...titles(n.children, depth + 1),
  ]);
}

function renderPanel() {
  return render(
    <TooltipProvider>
      <div style={{ display: 'flex', flexDirection: 'column', height: 480, width: 280 }}>
        <OutlinePanel />
      </div>
    </TooltipProvider>,
  );
}

const item = (name: string) => screen.getByRole('treeitem', { name });
const lastLabel = () => useWorkspaceStore.getState().history.present.label;

beforeEach(() => {
  resetWorkspace();
  resetOutlineView();
  useUiStore.setState({ viewMode: 'read' });
  useViewStore.setState({ currentPage: 0 });
  useSelectionStore.getState().apply({ selected: new Set(), anchor: null, focused: null });
});
afterEach(() => {
  resetWorkspace();
  resetOutlineView();
});

describe('outline editing helpers', () => {
  it('maps drop positions to gaps and refuses drops into the dragged subtree', () => {
    const tree = load().outline;
    expect(dropGap(tree, [1], 'before', true)).toEqual({ parent: [], index: 1 });
    expect(dropGap(tree, [1], 'after', true)).toEqual({ parent: [], index: 2 });
    expect(dropGap(tree, [1], 'into', true)).toEqual({ parent: [1], index: 0 });
    expect(dropGap(tree, [1], 'into', false)).toEqual({ parent: [1], index: 2 });
    expect(dropGap(tree, [9], 'into', false)).toBeUndefined();
    expect(canDropOn([1], [1, 0])).toBe(false);
    expect(canDropOn([1], [1])).toBe(false);
    expect(canDropOn([1, 0], [1])).toBe(true);
  });

  it('lists dead-link edits deepest and last first', () => {
    const nodes: OutlineNode[] = [
      { title: 'a', open: false, children: [], destination: { kind: 'unresolved', reason: 'x' } },
      {
        title: 'b',
        open: false,
        destination: { kind: 'unresolved', reason: 'x' },
        children: [
          {
            title: 'b1',
            open: false,
            children: [],
            destination: { kind: 'unresolved', reason: 'x' },
          },
          { title: 'b2', open: false, children: [] },
        ],
      },
    ];
    expect(deadLinkEdits(nodes)).toEqual([
      { kind: 'remove', path: [1, 0] },
      { kind: 'set-destination', path: [1], destination: null },
      { kind: 'remove', path: [0] },
    ]);
  });
});

describe('Outline panel editing', () => {
  it('adds a bookmark at the current page after the focused item, then renames it', async () => {
    const loaded = load();
    useViewStore.setState({ currentPage: 1 });
    renderPanel();
    await userEvent.click(item('One'));
    await userEvent.click(screen.getByRole('button', { name: 'Add bookmark' }));

    const input = await screen.findByRole('textbox', { name: 'Bookmark title' });
    expect(input).toHaveFocus();
    expect(input).toHaveValue('Page 2');
    expect(lastLabel()).toBe('Add bookmark “Page 2”');
    await userEvent.keyboard('Introduction{Enter}');

    await waitFor(() => expect(item('Introduction')).toHaveFocus());
    expect(item('Introduction')).toHaveAccessibleDescription('Page 2');
    expect(titles()).toEqual(['One', 'Introduction', 'Two', '  Two.a', '  Two.b', 'Three', 'Four']);
    expect(doc().outline[1]?.destination).toEqual({ kind: 'page', page: loaded.pages[1]?.id });
    expect(lastLabel()).toBe('Rename bookmark to “Introduction”');
    // Two steps: add, rename.
    useWorkspaceStore.getState().undo();
    expect(doc().outline[1]?.title).toBe('Page 2');
    useWorkspaceStore.getState().undo();
    expect(titles()).toEqual(['One', 'Two', '  Two.a', '  Two.b', 'Three', 'Four']);
  });

  it('renames with F2 and double-click; Escape cancels; a blank title is refused', async () => {
    load();
    renderPanel();
    item('Three').focus();
    await userEvent.keyboard('{F2}');
    const input = await screen.findByRole('textbox', { name: 'Bookmark title' });
    expect(input).toHaveValue('Three');
    await userEvent.keyboard('{Control>}a{/Control}{Backspace}{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter a title');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(item('Three')).toHaveFocus());
    expect(titles()).toContain('Three');

    await userEvent.dblClick(item('Four'));
    await screen.findByRole('textbox', { name: 'Bookmark title' });
    await userEvent.keyboard('{Control>}a{/Control}  Last  {Enter}');
    await waitFor(() => expect(item('Last')).toHaveFocus());
    expect(titles().at(-1)).toBe('Last');
  });

  it('deletes with Delete (children included), moves focus, and never deletes pages', async () => {
    load();
    renderPanel();
    item('Two').focus();
    await userEvent.keyboard('{Delete}');
    await waitFor(() => expect(item('Three')).toHaveFocus());
    expect(titles()).toEqual(['One', 'Three', 'Four']);
    expect(doc().pages).toHaveLength(6);
    expect(lastLabel()).toBe('Delete bookmark “Two”');
    await userEvent.keyboard('{End}{Backspace}');
    await waitFor(() => expect(item('Three')).toHaveFocus());
    expect(titles()).toEqual(['One', 'Three']);
    useWorkspaceStore.getState().undo();
    useWorkspaceStore.getState().undo();
    await waitFor(() => expect(screen.getAllByRole('treeitem')).toHaveLength(6));
    // Undo brings the earlier snapshot back with its expansion.
    expect(item('Two')).toHaveAttribute('aria-expanded', 'true');
  });

  it('moves with Alt+Arrows: reorder, indent and outdent, focus following the item', async () => {
    load();
    renderPanel();
    item('Three').focus();
    await userEvent.keyboard('{Alt>}{ArrowUp}{/Alt}');
    await waitFor(() => expect(item('Three')).toHaveFocus());
    expect(titles()).toEqual(['One', 'Three', 'Two', '  Two.a', '  Two.b', 'Four']);

    // Indent under "One" (its previous sibling), which expands to show it.
    await userEvent.keyboard('{Alt>}{ArrowRight}{/Alt}');
    await waitFor(() => expect(item('Three')).toHaveFocus());
    expect(titles()).toEqual(['One', '  Three', 'Two', '  Two.a', '  Two.b', 'Four']);
    expect(item('Three')).toHaveAttribute('aria-level', '2');
    expect(item('One')).toHaveAttribute('aria-expanded', 'true');

    // Outdent: right after its parent. Down past "Two" (with its children).
    await userEvent.keyboard('{Alt>}{ArrowLeft}{/Alt}');
    await waitFor(() => expect(item('Three')).toHaveAttribute('aria-level', '1'));
    await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}');
    await waitFor(() =>
      expect(titles()).toEqual(['One', 'Two', '  Two.a', '  Two.b', 'Three', 'Four']),
    );
    expect(item('Three')).toHaveFocus();
    // Nothing above the first item: no change, no history entry.
    const entries = useWorkspaceStore.getState().history.past.length;
    item('One').focus();
    await userEvent.keyboard('{Alt>}{ArrowUp}{/Alt}');
    expect(useWorkspaceStore.getState().history.past.length).toBe(entries);
    expect(lastLabel()).toBe('Move bookmark “Three”');
  });

  it('offers every edit in the context menu (right-click and Shift+F10)', async () => {
    const loaded = load();
    renderPanel();
    await userEvent.click(item('Four'), { button: 'right' });
    const menu = await screen.findByRole('menu', { name: 'Bookmark actions for Four' });
    expect(within(menu).getByRole('menuitem', { name: /Move down/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await userEvent.click(within(menu).getByRole('menuitem', { name: /Indent/ }));
    await waitFor(() =>
      expect(titles()).toEqual(['One', 'Two', '  Two.a', '  Two.b', 'Three', '  Four']),
    );

    // Keyboard: Shift+F10 on "Two", Add child: a new last child pointing at the current page.
    useViewStore.setState({ currentPage: 4 });
    item('Two').focus();
    await userEvent.keyboard('{Shift>}{F10}{/Shift}');
    const second = await screen.findByRole('menu', { name: 'Bookmark actions for Two' });
    await userEvent.click(within(second).getByRole('menuitem', { name: 'Add child bookmark' }));
    const input = await screen.findByRole('textbox', { name: 'Bookmark title' });
    await waitFor(() => expect(input).toHaveFocus());
    await userEvent.keyboard('{Enter}');
    expect(titles()).toEqual(['One', 'Two', '  Two.a', '  Two.b', '  Page 5', 'Three', '  Four']);

    // Set destination to current view.
    useViewStore.setState({ currentPage: 2 });
    await userEvent.click(item('One'), { button: 'right' });
    const third = await screen.findByRole('menu', { name: 'Bookmark actions for One' });
    await userEvent.click(
      within(third).getByRole('menuitem', { name: 'Set destination to current view' }),
    );
    expect(doc().outline[0]?.destination).toEqual({ kind: 'page', page: loaded.pages[2]?.id });
    await waitFor(() => expect(item('One')).toHaveAccessibleDescription('Page 3'));

    // "Expanded when the file opens" edits the model's open flag.
    await userEvent.click(item('Two'), { button: 'right' });
    const fourth = await screen.findByRole('menu', { name: 'Bookmark actions for Two' });
    const expandedItem = within(fourth).getByRole('menuitemcheckbox', {
      name: 'Expanded when the file opens',
    });
    expect(expandedItem).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(expandedItem);
    expect(doc().outline[1]?.open).toBe(false);
    // The panel keeps showing it expanded: its disclosure is view state.
    expect(item('Two')).toHaveAttribute('aria-expanded', 'true');
  });

  it('drags an item into another (native drag and drop) and shows no indicator after', async () => {
    load();
    renderPanel();
    await userEvent.dragAndDrop(item('Four'), item('One'));
    await waitFor(() =>
      expect(titles()).toEqual(['One', '  Four', 'Two', '  Two.a', '  Two.b', 'Three']),
    );
    expect(lastLabel()).toBe('Move bookmark “Four”');
    expect(document.querySelector('[data-drop]')).toBeNull();
    expect(item('One')).toHaveAttribute('aria-expanded', 'true');

    // Onto the top edge of "Two.a": before it, among Two's children.
    await userEvent.dragAndDrop(item('Three'), item('Two.a'), { targetPosition: { x: 40, y: 2 } });
    await waitFor(() =>
      expect(titles()).toEqual(['One', '  Four', 'Two', '  Three', '  Two.a', '  Two.b']),
    );
  });

  it('shows dead links and removes them on request', async () => {
    const loaded = load();
    renderPanel();
    useWorkspaceStore
      .getState()
      .applyOperation(
        (ws) => deletePages(ws, [loaded.pages[1]!.id, loaded.pages[5]!.id]),
        'Delete pages',
      );
    const notice = await screen.findByTestId('outline-dead-links');
    expect(notice).toHaveTextContent('2 bookmarks point at removed pages.');
    expect(item('Four')).toHaveAccessibleDescription('Target page was removed');
    await userEvent.click(within(notice).getByRole('button', { name: 'Remove dead links' }));
    await waitFor(() => expect(screen.queryByTestId('outline-dead-links')).toBeNull());
    // "Four" is gone; "Two" keeps its children as a heading without a target.
    expect(titles()).toEqual(['One', 'Two', '  Two.a', '  Two.b', 'Three']);
    expect(doc().outline[1]?.destination).toBeUndefined();
    expect(lastLabel()).toBe('Remove dead bookmarks');
  });

  it('lets the first bookmark be added from the empty state', async () => {
    load([]);
    renderPanel();
    expect(screen.getByText('No outline')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Add bookmark' }));
    await screen.findByRole('textbox', { name: 'Bookmark title' });
    await userEvent.keyboard('Cover{Enter}');
    await waitFor(() => expect(item('Cover')).toHaveFocus());
    expect(screen.getByRole('tree')).toBeVisible();
  });
});
