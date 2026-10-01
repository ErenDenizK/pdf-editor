/**
 * The tool bar's task groups and options tier (experience-redesign spec §5.1–§5.2, §10),
 * Vitest browser mode with the Read view and real PDFium: group membership, the in-place
 * morph (none under reduced motion), remembering the group, a shortcut showing its tool's
 * group, the Esc rules, one-shot tools returning to the previous tool, Rotate and Delete
 * page naming their target, and the tier's style routing (a selection wins, else the tool).
 */
import '../styles/tokens.css';
import '../styles/reset.css';
import '../styles/global.css';
import '../annotations/index';

import { getActiveDocument, type VirtualDocument } from '@pdf-editor/document-model';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';

import simpleUrl from '../../../../test/fixtures/simple-text.pdf?url';
import { fixtureFile } from '../../test/store-harness';
import { createAnnotations } from '../annotations/actions';
import {
  type PageTarget,
  resetAnnotationStore,
  TOOL_STYLES_STORAGE_KEY,
  useAnnotationStore,
} from '../annotations/annotation-store';
import { readAnnotations, resetEditRunner, whenIdle } from '../annotations/edit-runner';
import { builtinPendingStamp } from '../annotations/stamps';
import { ANNOTATION_TOOLS } from '../annotations/tools';
import { registerAppCommands } from '../commands/app-commands';
import { useShortcuts } from '../commands/use-shortcuts';
import { ReadView } from '../stage/ReadView';
import { useUiStore } from '../state/ui-store';
import { useViewStore } from '../state/view-store';
import { resetWorkspace, useWorkspaceStore } from '../state/workspace-store';
import { resetToolStore, useToolStore } from '../viewer/tool-store';
import { useAnnouncer } from './announcer';
import { FloatingToolbar } from './FloatingToolbar';
import { ShortcutOverlay } from './ShortcutOverlay';
import { BAR_GROUPS, type BarItem, barGroupOfCommand, barItems } from './FloatingToolbar.groups';
import { registerPenSlots } from './FloatingToolbar.slots';

/** A bar item as a short name: the tool mode, the command id, or the kind. */
function itemName(item: BarItem): string {
  switch (item.kind) {
    case 'tool':
    case 'pen':
    case 'stamp':
      return item.tool.mode;
    case 'shapes':
      return `shapes(${item.tools.map((t) => t.mode).join(',')})`;
    case 'command':
      return item.command;
    case 'page':
      return `page:${item.action}`;
    default:
      return item.kind;
  }
}

describe('tool bar groups (model)', () => {
  it('holds the six groups of the spec, each with its tools, none above six', () => {
    expect(BAR_GROUPS.map((g) => g.label())).toEqual([
      'Read',
      'Mark up',
      'Draw',
      'Fill & sign',
      'Pages',
      'Redact',
    ]);
    const table = Object.fromEntries(BAR_GROUPS.map((g) => [g.id, barItems(g.id).map(itemName)]));
    expect(table).toEqual({
      read: ['select', 'search.open', 'layout', 'fit'],
      markup: ['highlight', 'underline', 'strikeout', 'squiggly', 'note', 'text-box'],
      draw: ['ink', 'eraser', 'lasso', 'shapes(rectangle,ellipse,line,arrow)'],
      fill: ['forms.highlight', 'fields', 'signature', 'stamp', 'document.sign'],
      pages: ['edit-text', 'image', 'pages.crop', 'page:rotate', 'page:delete', 'mode.arrange'],
      redact: ['redact', 'redaction.find', 'redaction.markMatches', 'apply-redactions'],
    });
    for (const group of BAR_GROUPS) expect(barItems(group.id).length).toBeLessThanOrEqual(6);
    // "Extract pages" is not on the bar until it exists.
    expect(Object.values(table).flat()).not.toContain('pages.extract');
  });

  it('gives every tool one home, named for its command too', () => {
    for (const tool of ANNOTATION_TOOLS) {
      const homes = BAR_GROUPS.filter((g) =>
        barItems(g.id).some((item) => itemName(item).split(/[(),]/).includes(tool.mode)),
      );
      expect(homes.map((g) => g.id)).toEqual([tool.group]);
      expect(barGroupOfCommand(`tool.${tool.mode}`)).toBe(tool.group);
    }
    expect(barGroupOfCommand('stamp.draft')).toBe('fill');
    expect(barGroupOfCommand('forms.add.text')).toBe('fill');
    expect(barGroupOfCommand('pages.crop')).toBe('pages');
    expect(barGroupOfCommand('search.open')).toBe('read');
    expect(barGroupOfCommand('file.open')).toBeUndefined();
  });

  it('remembers the last group and returns a one-shot tool to the previous tool', () => {
    resetToolStore();
    const tools = useToolStore.getState();
    tools.showGroup('draw');
    tools.showGroup(null);
    expect(useToolStore.getState()).toMatchObject({ barGroup: null, lastGroup: 'draw' });
    tools.setMode('ink');
    tools.setMode('stamp');
    tools.setMode('signature');
    useToolStore.getState().finishOneShot();
    expect(useToolStore.getState().mode).toBe('ink');
    // Not a one-shot tool: nothing to return from.
    useToolStore.getState().finishOneShot();
    expect(useToolStore.getState().mode).toBe('ink');
    resetToolStore();
  });
});

function Harness({ doc }: { readonly doc: VirtualDocument }) {
  useShortcuts();
  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', height: 700 }}>
      <ReadView doc={doc} />
      <FloatingToolbar />
    </div>
  );
}

interface Mounted {
  readonly layer: HTMLElement;
  readonly target: PageTarget;
  readonly doc: VirtualDocument;
}

async function mount(): Promise<Mounted> {
  const report = await useWorkspaceStore
    .getState()
    .openFiles([await fixtureFile(simpleUrl, 'simple.pdf')]);
  expect(report.skipped).toEqual([]);
  const doc = getActiveDocument(useWorkspaceStore.getState().workspace) as VirtualDocument;
  const first = doc.pages[0];
  if (first?.ref.kind !== 'source') throw new Error('no source page');
  useUiStore.getState().setZoom(0.75);
  useViewStore.getState().setCurrentPage(0);
  const { container } = render(<Harness doc={doc} />);
  await waitFor(
    () => {
      if (!container.querySelector('[data-page-index="0"] canvas[data-state="rendered"]')) {
        throw new Error('page not rendered');
      }
    },
    { timeout: 10_000 },
  );
  const layer = await waitFor(() => {
    const l = container.querySelector<HTMLElement>('[data-annotation-layer="0"]');
    if (!l) throw new Error('no annotation layer');
    return l;
  });
  return {
    layer,
    doc,
    target: { source: first.ref.source, pageIndex: 0, pageId: first.id, position: 1 },
  };
}

const bar = () => screen.getByRole('toolbar', { name: 'Tools' });
/** The morph's own animations (not the CSS transitions of hover and press). */
const morphs = () =>
  bar()
    .getAnimations({ subtree: true })
    .filter((a) => !(a instanceof CSSTransition) && !(a instanceof CSSAnimation));
/** Waits until the morph has finished (items fade in from opacity 0). */
const settle = async () => {
  await Promise.all(morphs().map((a) => a.finished.catch(() => undefined)));
};
const groupNames = () =>
  within(bar())
    .getAllByRole('button')
    .map((b) => b.textContent);

function click(layer: HTMLElement, at: [number, number]): void {
  const box = layer.getBoundingClientRect();
  const x = box.left + box.width * at[0];
  const y = box.top + box.height * at[1];
  const init = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 };
  layer.dispatchEvent(
    new PointerEvent('pointerdown', { ...init, buttons: 1, pointerId: 1, isPrimary: true }),
  );
  window.dispatchEvent(
    new PointerEvent('pointerup', { ...init, buttons: 0, pointerId: 1, isPrimary: true }),
  );
}

describe('tool bar (mounted)', () => {
  let disposeCommands: () => void = () => undefined;
  beforeAll(() => {
    disposeCommands = registerAppCommands();
  });
  afterAll(() => {
    disposeCommands();
  });
  beforeEach(async () => {
    await page.viewport(1280, 900);
    localStorage.removeItem(TOOL_STYLES_STORAGE_KEY);
    resetWorkspace();
    resetEditRunner();
    resetAnnotationStore();
    resetToolStore();
    useUiStore.setState({ viewMode: 'read' });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await whenIdle();
    cleanup();
    resetToolStore();
    localStorage.removeItem(TOOL_STYLES_STORAGE_KEY);
    resetAnnotationStore();
    resetWorkspace();
  });

  it('shows six labelled groups; a group morphs in place, is announced, and the chip returns', async () => {
    await mount();
    expect(groupNames()).toEqual(['Read', 'Mark up', 'Draw', 'Fill & sign', 'Pages', 'Redact']);
    const draw = within(bar()).getByRole('button', { name: 'Draw' });
    const before = draw.getBoundingClientRect();
    const animate = vi.spyOn(Element.prototype, 'animate');
    await userEvent.click(draw);
    // The same element became the chip at the left end; the group's tools slid in.
    const chip = within(bar()).getByRole('button', { name: 'Draw: back to all groups' });
    expect(chip).toBe(draw);
    expect(chip).toHaveFocus();
    expect(chip.getBoundingClientRect().left).toBeLessThan(before.left);
    // One movement: the chip slides from its place in the row, the rest fades in beside it.
    const chipMove = animate.mock.contexts.indexOf(chip);
    expect(chipMove).toBeGreaterThanOrEqual(0);
    expect(animate.mock.calls[chipMove]?.[1]).toMatchObject({ duration: 160 });
    expect(JSON.stringify(animate.mock.calls[chipMove]?.[0])).toContain('translateX(');
    await settle();
    expect(within(bar()).getByRole('button', { name: 'Pen' })).toBeVisible();
    expect(within(bar()).getByRole('button', { name: 'Eraser' })).toBeVisible();
    expect(within(bar()).getByRole('button', { name: /^Shapes/ })).toBeVisible();
    expect(useAnnouncer.getState().message).toBe('Draw tools');
    // The bar keeps its height (44 px, spec §7.3).
    expect(bar().getBoundingClientRect().height).toBeCloseTo(44, 0);

    await userEvent.click(chip);
    expect(groupNames()).toEqual(['Read', 'Mark up', 'Draw', 'Fill & sign', 'Pages', 'Redact']);
    // The row remembers the group: it holds the bar's Tab stop.
    const remembered = within(bar()).getByRole('button', { name: 'Draw' });
    expect(remembered).toHaveAttribute('data-last');
    expect(remembered.tabIndex).toBe(0);
    expect(useToolStore.getState().lastGroup).toBe('draw');
  });

  it('picking Draw arms the active preset, so the first stroke draws; Esc disarms', async () => {
    await mount();
    useAnnotationStore.getState().armPreset(1);
    expect(useToolStore.getState().mode).toBe('select');
    await userEvent.click(within(bar()).getByRole('button', { name: 'Draw' }));
    expect(useToolStore.getState().mode).toBe('ink');
    const { pen, styles } = useAnnotationStore.getState();
    expect(pen.active).toBe(1);
    expect(styles.ink.color.toUpperCase()).toBe(pen.presets[1].color.toUpperCase());
    expect(styles.ink.strokeWidth).toBe(pen.presets[1].width);
    expect(useAnnouncer.getState().message).toBe('Draw tools');

    // Esc rules unchanged: the first disarms, the second returns to the row.
    within(bar()).getByRole('button', { name: 'Eraser' }).focus();
    await userEvent.keyboard('{Escape}');
    expect(useToolStore.getState().mode).toBe('select');
    expect(useToolStore.getState().barGroup).toBe('draw');
    await userEvent.keyboard('{Escape}');
    expect(useToolStore.getState().barGroup).toBeNull();

    // A Draw tool armed already (the eraser, from its shortcut) stays armed.
    useToolStore.getState().setMode('eraser');
    useToolStore.getState().showGroup(null);
    await userEvent.click(within(bar()).getByRole('button', { name: 'Draw' }));
    expect(useToolStore.getState().mode).toBe('eraser');
  });

  it('does not move under reduced motion', async () => {
    const real = window.matchMedia.bind(window);
    // The reduced-motion query answers like one that matches.
    vi.spyOn(window, 'matchMedia').mockImplementation((query: string) =>
      real(query.includes('prefers-reduced-motion') ? '(min-width: 0px)' : query),
    );
    await mount();
    const animate = vi.spyOn(Element.prototype, 'animate');
    await userEvent.click(within(bar()).getByRole('button', { name: 'Pages' }));
    expect(within(bar()).getByRole('button', { name: 'Edit text' })).toBeVisible();
    expect(animate.mock.contexts.filter((el) => bar().contains(el as Node))).toEqual([]);
  });

  it('a shortcut arms its tool and shows its group; Esc disarms, then returns to the row', async () => {
    await mount();
    await userEvent.keyboard('h');
    await waitFor(() => expect(useToolStore.getState().mode).toBe('highlight'));
    expect(within(bar()).getByRole('button', { name: 'Highlight' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(useToolStore.getState().barGroup).toBe('markup');
    await userEvent.keyboard('p');
    expect(within(bar()).getByRole('button', { name: 'Pen' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(useToolStore.getState().barGroup).toBe('draw');

    // The group stays when the bar unmounts (Arrange) and comes back.
    useUiStore.getState().setViewMode('arrange');
    await waitFor(() => expect(screen.queryByRole('toolbar', { name: 'Tools' })).toBeNull());
    useUiStore.getState().setViewMode('read');
    expect(await screen.findByRole('toolbar', { name: 'Tools' })).toBeVisible();
    expect(useToolStore.getState().barGroup).toBe('draw');

    // On the bar: the first Esc disarms, the second returns to the row.
    useToolStore.getState().setMode('ink');
    within(bar()).getByRole('button', { name: 'Eraser' }).focus();
    await userEvent.keyboard('{Escape}');
    expect(useToolStore.getState().mode).toBe('select');
    expect(useToolStore.getState().barGroup).toBe('draw');
    await userEvent.keyboard('{Escape}');
    expect(useToolStore.getState().barGroup).toBeNull();
    expect(within(bar()).getByRole('button', { name: 'Draw' })).toHaveFocus();
  });

  it('is one Tab stop; arrows move between groups and tools', async () => {
    await mount();
    const buttons = within(bar()).getAllByRole('button');
    expect(buttons.filter((b) => b.tabIndex === 0)).toHaveLength(1);
    buttons[0]?.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(buttons[1]).toHaveFocus();
    await userEvent.keyboard('{End}');
    expect(buttons[5]).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(useToolStore.getState().barGroup).toBe('redact');
    await userEvent.keyboard('{ArrowRight}');
    expect(within(bar()).getByRole('button', { name: 'Mark for redaction' })).toHaveFocus();
    expect(
      within(bar())
        .getAllByRole('button')
        .filter((b) => b.tabIndex === 0),
    ).toHaveLength(1);
  });

  it('a placed stamp returns to the previous tool and stays unselected', async () => {
    const { layer, target } = await mount();
    await userEvent.keyboard('p');
    await waitFor(() => expect(useToolStore.getState().mode).toBe('ink'));
    // As the Stamp menu arms a built-in stamp.
    useAnnotationStore.getState().setPendingStamp(builtinPendingStamp('Draft'));
    useToolStore.getState().setMode('stamp');
    await waitFor(() => expect(layer).toHaveAttribute('data-tool', 'stamp'));
    click(layer, [0.5, 0.4]);
    await waitFor(async () =>
      expect((await readAnnotations(target.source, 0)).map((a) => a.kind)).toEqual(['stamp']),
    );
    await waitFor(() => expect(useToolStore.getState().mode).toBe('ink'));
    expect(useAnnotationStore.getState().selection).toBeNull();
    expect(screen.queryByTestId('annotation-bar')).toBeNull();
  });

  it('Rotate and Delete page act on the current page and name it', async () => {
    const { doc } = await mount();
    await userEvent.click(within(bar()).getByRole('button', { name: 'Pages' }));
    await settle();
    const rotate = within(bar()).getByRole('button', { name: 'Rotate page 1' });
    expect(within(bar()).getByRole('button', { name: 'Delete page 1' })).toBeVisible();
    await userEvent.click(rotate);
    const after = getActiveDocument(useWorkspaceStore.getState().workspace);
    expect(after?.pages[0]?.rotation).toBe(((doc.pages[0]?.rotation ?? 0) + 90) % 360);
    expect(useAnnouncer.getState().message).toBe('Rotated page 1');
  });
});

describe('options tier', () => {
  let disposeCommands: () => void = () => undefined;
  beforeAll(() => {
    disposeCommands = registerAppCommands();
  });
  afterAll(() => {
    disposeCommands();
  });
  beforeEach(async () => {
    await page.viewport(1280, 900);
    localStorage.removeItem(TOOL_STYLES_STORAGE_KEY);
    resetWorkspace();
    resetEditRunner();
    resetAnnotationStore();
    resetToolStore();
    useUiStore.setState({ viewMode: 'read' });
  });
  afterEach(async () => {
    await whenIdle();
    cleanup();
    resetToolStore();
    localStorage.removeItem(TOOL_STYLES_STORAGE_KEY);
    resetAnnotationStore();
    resetWorkspace();
  });

  it('shows the armed tool options above the bar; changing them changes the tool', async () => {
    const { target } = await mount();
    expect(screen.queryByTestId('options-tier')).toBeNull();
    await userEvent.keyboard('h');
    const tier = await screen.findByRole('toolbar', { name: 'Highlight options' });
    // Attached to the top of the bar, not over the page.
    expect(tier.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      bar().getBoundingClientRect().top,
    );
    await userEvent.click(within(tier).getByRole('radio', { name: 'Blue' }));
    expect(useAnnotationStore.getState().styles.highlight.color).toBe('#1E88E5');
    expect(within(tier).getByRole('radio', { name: 'Blue' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(await readAnnotations(target.source, 0)).toEqual([]);
    // Shapes have a width; a tool without a style has no tier.
    await userEvent.keyboard('r');
    const shapes = await screen.findByRole('toolbar', { name: 'Rectangle options' });
    expect(within(shapes).getByRole('slider', { name: /^Stroke width/ })).toBeInTheDocument();
    await userEvent.keyboard('{Shift>}e{/Shift}');
    await waitFor(() => expect(useToolStore.getState().mode).toBe('eraser'));
    expect(screen.queryByTestId('options-tier')).toBeNull();
  });

  it('with a selection the tier edits the selection, not the tool', async () => {
    const { target } = await mount();
    const created = await createAnnotations(target, [
      {
        kind: 'square',
        pageIndex: 0,
        rect: { x: 100, y: 500, width: 120, height: 60 },
        color: '#E53935',
        opacity: 1,
        strokeWidth: 2,
      },
    ]);
    const id = created?.[0]?.id;
    if (id === undefined) throw new Error('not created');
    await userEvent.keyboard('r');
    const tier = await screen.findByRole('toolbar', { name: 'Rectangle options' });
    // An explicit select (a Review row, Tab) while the tool is armed.
    useAnnotationStore.getState().select({ ...target, ids: [id] });
    within(tier).getByRole('radio', { name: 'Green' }).click();
    await waitFor(async () => {
      const square = (await readAnnotations(target.source, 0)).find((a) => a.id === id);
      expect(square && 'color' in square ? square.color : undefined).toBe('#43A047');
    });
    expect(useAnnotationStore.getState().styles.shape.color).toBe('#E53935');
  });

  it('takes the pen presets when they plug in', async () => {
    await mount();
    const dispose = registerPenSlots({
      Bar: ({ armed, arm }) => (
        <button type="button" aria-pressed={armed} onClick={arm}>
          Blue pen
        </button>
      ),
    });
    await userEvent.click(within(bar()).getByRole('button', { name: 'Draw' }));
    await settle();
    await userEvent.click(within(bar()).getByRole('button', { name: 'Blue pen' }));
    expect(useToolStore.getState().mode).toBe('ink');
    expect(within(bar()).queryByRole('button', { name: 'Pen' })).toBeNull();
    // The pen's own style is in the tier until a preset editor plugs in there too.
    expect(await screen.findByRole('toolbar', { name: 'Pen options' })).toBeInTheDocument();
    dispose();
    expect(await within(bar()).findByRole('button', { name: 'Pen' })).toBeInTheDocument();
  });
});

describe('shortcut overlay', () => {
  it('names the tool bar group of every tool, with its keys unchanged', async () => {
    const dispose = registerAppCommands();
    useUiStore.setState({ shortcutsOpen: true });
    try {
      render(<ShortcutOverlay />);
      const dialog = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
      const row = (title: string) => {
        const term = within(dialog).getByText(title, { exact: true }).closest('div');
        if (!term) throw new Error(`no row ${title}`);
        return term;
      };
      expect(row('Pen tool')).toHaveTextContent('Tool bar: Draw');
      expect(row('Pen tool')).toHaveTextContent('P');
      expect(row('Highlight tool')).toHaveTextContent('Tool bar: Mark up');
      expect(row('Edit text tool')).toHaveTextContent('Tool bar: Pages');
      expect(row('Redact tool')).toHaveTextContent('Tool bar: Redact');
      for (const tool of ANNOTATION_TOOLS) {
        expect(dialog.textContent).toContain(`${tool.title()} tool`);
      }
      expect(dialog.querySelectorAll('[data-bar-group-note]').length).toBeGreaterThanOrEqual(
        ANNOTATION_TOOLS.length,
      );
    } finally {
      useUiStore.setState({ shortcutsOpen: false });
      dispose();
    }
  });
});
