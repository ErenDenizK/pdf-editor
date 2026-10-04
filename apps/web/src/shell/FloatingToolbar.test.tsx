/**
 * The Edit bar's five groups and options tier (ADR-0019 §4, craft spec §3.4, experience-
 * redesign spec §5.2, §10), Vitest browser mode with the Read view and real PDFium: group
 * membership, Select as the idle tool's chip, the in-place morph (none under reduced motion),
 * remembering the group, a shortcut showing its tool's group (the row for the text markups),
 * the Esc rules, one-shot tools returning to the previous tool, and the tier's style routing
 * (a selection wins, else the tool).
 */
import '../styles/tokens.css';
import '../styles/reset.css';
import '../styles/global.css';
import '../annotations/index';

import { getActiveDocument, type VirtualDocument } from '@pdf-editor/document-model';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';

import simpleUrl from '../../../../test/fixtures/simple-text.pdf?url';
import { enterEditMode, fixtureFile } from '../../test/store-harness';
import { createAnnotations } from '../annotations/actions';
import {
  type PageTarget,
  resetAnnotationStore,
  TOOL_STYLES_STORAGE_KEY,
  useAnnotationStore,
} from '../annotations/annotation-store';
import { readAnnotations, resetEditRunner, whenIdle } from '../annotations/edit-runner';
import { INK, TINT } from '../annotations/palette';
import { builtinPendingStamp } from '../annotations/stamps';
import { ANNOTATION_TOOLS } from '../annotations/tools';
import { registerAppCommands } from '../commands/app-commands';
import { commandRegistry } from '../commands/registry';
import { useShortcuts } from '../commands/use-shortcuts';
import { ReadView } from '../stage/ReadView';
import { highlighterIndex } from '../annotations/pen/highlighter';
import { presetLabel } from '../annotations/pen/presets';
import { canEditActive, useUiStore } from '../state/ui-store';
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
    default:
      return item.kind;
  }
}

describe('tool bar groups (model)', () => {
  it('holds the five groups of the spec, each with its tools', () => {
    expect(BAR_GROUPS.map((g) => g.label())).toEqual([
      'Select',
      'Write',
      'Text',
      'Fill & sign',
      'Redact',
    ]);
    const table = Object.fromEntries(BAR_GROUPS.map((g) => [g.id, barItems(g.id).map(itemName)]));
    expect(table).toEqual({
      // Select is the idle tool: its chip, no tool row.
      select: [],
      write: ['ink', 'eraser', 'lasso', 'shapes(rectangle,ellipse,line,arrow)'],
      text: ['edit-text', 'text-box', 'note', 'image'],
      fill: ['forms.highlight', 'fields', 'signature', 'stamp', 'document.sign'],
      redact: ['redact', 'redaction.find', 'redaction.markMatches', 'apply-redactions'],
    });
    for (const group of BAR_GROUPS) expect(barItems(group.id).length).toBeLessThanOrEqual(6);
    // Gone from the bar: the Read, Pages and Mark up groups' items (craft spec §3.4).
    const all = Object.values(table).flat().join(' ');
    for (const gone of [
      'select',
      'highlight',
      'underline',
      'strikeout',
      'squiggly',
      'search.open',
      'layout',
      'fit',
      'pages.crop',
      'page:',
      'mode.arrange',
    ]) {
      expect(all.split(/[ (),]/)).not.toContain(gone);
    }
  });

  it('gives every tool with a group one home, named for its command too', () => {
    for (const tool of ANNOTATION_TOOLS) {
      const homes = BAR_GROUPS.filter((g) =>
        barItems(g.id).some((item) => itemName(item).split(/[(),]/).includes(tool.mode)),
      );
      // Select is the group row's chip itself; the text markups have no bar entry.
      const expected = tool.group === undefined || tool.group === 'select' ? [] : [tool.group];
      expect(homes.map((g) => g.id)).toEqual(expected);
      expect(barGroupOfCommand(`tool.${tool.mode}`)).toBe(tool.group);
    }
    for (const markup of ['highlight', 'underline', 'strikeout', 'squiggly']) {
      expect(barGroupOfCommand(`tool.${markup}`)).toBeUndefined();
    }
    expect(barGroupOfCommand('tool.select')).toBe('select');
    expect(barGroupOfCommand('tool.highlighter')).toBe('write');
    expect(barGroupOfCommand('stamp.draft')).toBe('fill');
    expect(barGroupOfCommand('forms.add.text')).toBe('fill');
    expect(barGroupOfCommand('redaction.find')).toBe('redact');
    expect(barGroupOfCommand('pages.crop')).toBeUndefined();
    expect(barGroupOfCommand('search.open')).toBeUndefined();
    expect(barGroupOfCommand('file.open')).toBeUndefined();
  });

  it('remembers the last group and returns a one-shot tool to the previous tool', () => {
    resetToolStore();
    const tools = useToolStore.getState();
    tools.showGroup('write');
    tools.showGroup(null);
    expect(useToolStore.getState()).toMatchObject({ barGroup: null, lastGroup: 'write' });
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
  enterEditMode();
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
const GROUPS = ['Select', 'Write', 'Text', 'Fill & sign', 'Redact'];
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

  it('shows five labelled groups; a group morphs in place, is announced, and the chip returns', async () => {
    await mount();
    expect(groupNames()).toEqual(GROUPS);
    const write = within(bar()).getByRole('button', { name: 'Write' });
    const before = write.getBoundingClientRect();
    const animate = vi.spyOn(Element.prototype, 'animate');
    await userEvent.click(write);
    // The same element became the chip at the left end; the group's tools slid in.
    const chip = within(bar()).getByRole('button', { name: 'Write: back to all groups' });
    expect(chip).toBe(write);
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
    expect(useAnnouncer.getState().message).toBe('Write tools');
    // The bar keeps its height (44 px, spec §7.3).
    expect(bar().getBoundingClientRect().height).toBeCloseTo(44, 0);

    await userEvent.click(chip);
    expect(groupNames()).toEqual(GROUPS);
    // The row remembers the group: it holds the bar's Tab stop.
    const remembered = within(bar()).getByRole('button', { name: 'Write' });
    expect(remembered).toHaveAttribute('data-last');
    expect(remembered.tabIndex).toBe(0);
    expect(useToolStore.getState().lastGroup).toBe('write');
  });

  it("shows each group's tools, and none of the dropped groups' items", async () => {
    await mount();
    const expected: Readonly<Record<string, readonly (string | RegExp)[]>> = {
      Write: ['Pen', 'Eraser', 'Lasso', /^Shapes/],
      Text: ['Edit text', 'Text box', 'Note', 'Image'],
      'Fill & sign': ['Signature image', 'Highlight form fields'],
      Redact: ['Mark for redaction', 'Apply redactions…'],
    };
    for (const [group, names] of Object.entries(expected)) {
      await userEvent.click(within(bar()).getByRole('button', { name: group }));
      await settle();
      for (const name of names) {
        expect(within(bar()).getByRole('button', { name })).toBeVisible();
      }
      for (const gone of ['Find', 'Highlight', 'Underline', 'Strikeout', /^Rotate page/, 'Crop…']) {
        expect(within(bar()).queryByRole('button', { name: gone })).toBeNull();
      }
      await userEvent.click(
        within(bar()).getByRole('button', { name: `${group}: back to all groups` }),
      );
    }
  });

  it('Select is the idle tool: the first chip, on while nothing is armed, and it shows no row', async () => {
    await mount();
    const select = within(bar()).getAllByRole('button')[0] as HTMLElement;
    expect(select).toHaveAccessibleName('Select');
    expect(select).toHaveAttribute('aria-pressed', 'true');
    expect(select).toHaveAttribute('aria-keyshortcuts', 'V');
    // The first Tab stop of a fresh session.
    expect(select.tabIndex).toBe(0);

    await userEvent.keyboard('p');
    await waitFor(() => expect(useToolStore.getState().mode).toBe('ink'));
    expect(useToolStore.getState().barGroup).toBe('write');
    await userEvent.click(within(bar()).getByRole('button', { name: 'Write: back to all groups' }));
    expect(within(bar()).getByRole('button', { name: 'Select' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await userEvent.click(within(bar()).getByRole('button', { name: 'Select' }));
    // Disarmed, said, and the row stays: Select has no tool row.
    expect(useToolStore.getState().mode).toBe('select');
    expect(useToolStore.getState().barGroup).toBeNull();
    expect(groupNames()).toEqual(GROUPS);
    expect(useAnnouncer.getState().message).toBe('Select tool');
    expect(within(bar()).getByRole('button', { name: 'Select' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('picking Write arms the active preset, so the first stroke draws; Esc disarms', async () => {
    await mount();
    useAnnotationStore.getState().armPreset(1);
    expect(useToolStore.getState().mode).toBe('select');
    await userEvent.click(within(bar()).getByRole('button', { name: 'Write' }));
    expect(useToolStore.getState().mode).toBe('ink');
    const { pen, styles } = useAnnotationStore.getState();
    expect(pen.active).toBe(1);
    expect(styles.ink.color.toUpperCase()).toBe(pen.presets[1].color.toUpperCase());
    expect(styles.ink.strokeWidth).toBe(pen.presets[1].width);
    expect(useAnnouncer.getState().message).toBe('Write tools');

    // Esc rules unchanged: the first disarms, the second returns to the row.
    within(bar()).getByRole('button', { name: 'Eraser' }).focus();
    await userEvent.keyboard('{Escape}');
    expect(useToolStore.getState().mode).toBe('select');
    expect(useToolStore.getState().barGroup).toBe('write');
    await userEvent.keyboard('{Escape}');
    expect(useToolStore.getState().barGroup).toBeNull();

    // A Write tool armed already (the eraser, from its shortcut) stays armed.
    useToolStore.getState().setMode('eraser');
    useToolStore.getState().showGroup(null);
    await userEvent.click(within(bar()).getByRole('button', { name: 'Write' }));
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
    await userEvent.click(within(bar()).getByRole('button', { name: 'Text' }));
    expect(within(bar()).getByRole('button', { name: 'Edit text' })).toBeVisible();
    expect(animate.mock.contexts.filter((el) => bar().contains(el as Node))).toEqual([]);
  });

  it('a shortcut arms its tool and shows its group; Esc disarms, then returns to the row', async () => {
    await mount();
    await userEvent.keyboard('t');
    await waitFor(() => expect(useToolStore.getState().mode).toBe('text-box'));
    expect(within(bar()).getByRole('button', { name: 'Text box' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(useToolStore.getState().barGroup).toBe('text');
    await userEvent.keyboard('p');
    expect(within(bar()).getByRole('button', { name: 'Pen' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(useToolStore.getState().barGroup).toBe('write');

    // The group stays when the bar unmounts (Arrange) and comes back.
    useUiStore.getState().setViewMode('arrange');
    await waitFor(() => expect(screen.queryByRole('toolbar', { name: 'Tools' })).toBeNull());
    useUiStore.getState().setViewMode('read');
    expect(await screen.findByRole('toolbar', { name: 'Tools' })).toBeVisible();
    expect(useToolStore.getState().barGroup).toBe('write');

    // On the bar: the first Esc disarms, the second returns to the row.
    useToolStore.getState().setMode('ink');
    within(bar()).getByRole('button', { name: 'Eraser' }).focus();
    await userEvent.keyboard('{Escape}');
    expect(useToolStore.getState().mode).toBe('select');
    expect(useToolStore.getState().barGroup).toBe('write');
    await userEvent.keyboard('{Escape}');
    expect(useToolStore.getState().barGroup).toBeNull();
    expect(within(bar()).getByRole('button', { name: 'Write' })).toHaveFocus();
  });

  it('U, S and the palette arm the text markups, which show the row; U again shows their options', async () => {
    await mount();
    await userEvent.click(within(bar()).getByRole('button', { name: 'Text' }));
    await userEvent.keyboard('u');
    await waitFor(() => expect(useToolStore.getState().mode).toBe('underline'));
    // No group holds them: the row. Arming opens no options tier (review finding 5).
    expect(useToolStore.getState().barGroup).toBeNull();
    expect(groupNames()).toEqual(GROUPS);
    expect(screen.queryByTestId('options-tier')).toBeNull();
    // The armed tool's key again asks for its options, and again hides them.
    await userEvent.keyboard('u');
    const tier = await screen.findByRole('toolbar', { name: 'Underline options' });
    expect(await within(tier).findAllByRole('radio')).not.toHaveLength(0);
    expect(useAnnouncer.getState().message).toBe('Underline options');
    await userEvent.keyboard('u');
    await waitFor(() => expect(screen.queryByTestId('options-tier')).toBeNull());
    expect(useToolStore.getState().mode).toBe('underline');
    await userEvent.keyboard('s');
    await waitFor(() => expect(useToolStore.getState().mode).toBe('strikeout'));
    // The palette entries stay, the Highlight tool's and Squiggly's included (no key).
    for (const mode of ['highlight', 'underline', 'strikeout', 'squiggly']) {
      expect(commandRegistry.get(`tool.${mode}`)).toBeDefined();
    }
    await commandRegistry.execute('tool.squiggly');
    expect(useToolStore.getState().mode).toBe('squiggly');
    await commandRegistry.execute('tool.highlight');
    expect(useToolStore.getState().mode).toBe('highlight');
  });

  it('picking Text arms Edit text, as Write arms the pen; a Text tool armed stays', async () => {
    await mount();
    await userEvent.click(within(bar()).getByRole('button', { name: 'Text' }));
    expect(useToolStore.getState().mode).toBe('edit-text');
    expect(within(bar()).getByRole('button', { name: 'Edit text' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(useAnnouncer.getState().message).toBe('Text tools');
    await userEvent.click(within(bar()).getByRole('button', { name: 'Text: back to all groups' }));
    act(() => {
      useToolStore.getState().setMode('note');
      useToolStore.getState().showGroup(null);
    });
    await userEvent.click(within(bar()).getByRole('button', { name: 'Text' }));
    expect(useToolStore.getState().mode).toBe('note');
  });

  it('Esc from the page: the first disarms to Select (the eraser and lasso too), the second returns to the row', async () => {
    await mount();
    for (const [key, mode] of [
      ['{Shift>}e{/Shift}', 'eraser'],
      ['q', 'lasso'],
      ['p', 'ink'],
      ['r', 'rectangle'],
    ] as const) {
      (document.activeElement as HTMLElement | null)?.blur();
      await userEvent.keyboard(key);
      await waitFor(() => expect(useToolStore.getState().mode).toBe(mode));
      expect(useToolStore.getState().barGroup).toBe('write');
      await userEvent.keyboard('{Escape}');
      expect(useToolStore.getState().mode).toBe('select');
      expect(useToolStore.getState().barGroup).toBe('write');
      await userEvent.keyboard('{Escape}');
      expect(useToolStore.getState().barGroup).toBeNull();
      // Esc never leaves Edit.
      expect(canEditActive()).toBe(true);
    }
  });

  it('the armed tool says "Esc: Select", and that pressing it again shows its options', async () => {
    await mount();
    await userEvent.keyboard('{Shift>}e{/Shift}');
    const eraser = within(bar()).getByRole('button', { name: 'Eraser' });
    expect(eraser).toHaveAttribute('aria-description', 'Press again for options');
    expect(within(bar()).getByRole('button', { name: 'Lasso' })).not.toHaveAttribute(
      'aria-description',
    );
    await userEvent.hover(eraser);
    await waitFor(() => expect(screen.getByText('Eraser · Esc: Select')).toBeVisible(), {
      timeout: 3000,
    });
  });

  it('P arms the last writing pen, never the Highlighter, and H the Highlighter; each is said', async () => {
    await mount();
    const label = (i: 0 | 1 | 2 | 3) =>
      presetLabel(i, useAnnotationStore.getState().pen.presets[i]);
    const highlighter = highlighterIndex(useAnnotationStore.getState().pen) ?? 3;
    act(() => useAnnotationStore.getState().armPreset(1));
    await userEvent.keyboard('p');
    expect(useToolStore.getState().mode).toBe('ink');
    expect(useAnnotationStore.getState().pen.active).toBe(1);
    expect(useAnnouncer.getState().message).toBe(label(1));
    await userEvent.keyboard('h');
    await waitFor(() => expect(useAnnotationStore.getState().pen.active).toBe(highlighter));
    expect(useAnnouncer.getState().message).toBe(label(highlighter));
    // P after H: the blue pen again, not the Highlighter, and no options tier.
    await userEvent.keyboard('p');
    expect(useAnnotationStore.getState().pen.active).toBe(1);
    expect(useAnnouncer.getState().message).toBe(label(1));
    expect(screen.queryByTestId('options-tier')).toBeNull();
    // From Read: the switch and the pen in one announcement.
    const id = useWorkspaceStore.getState().workspace.activeDocument;
    if (id === undefined) throw new Error('no document');
    act(() => useUiStore.getState().setDocumentMode(id, 'read'));
    act(() => useAnnotationStore.getState().armPreset(highlighter));
    await userEvent.keyboard('p');
    expect(useToolStore.getState().mode).toBe('ink');
    expect(useAnnotationStore.getState().pen.active).toBe(1);
    expect(useAnnouncer.getState().message).toBe(`Edit mode. ${label(1)}`);
  });

  it('fades the bar and lets the pointer through while a stroke is in progress, and a second after', async () => {
    const { layer } = await mount();
    const dock = bar().parentElement as HTMLElement;
    const box = layer.getBoundingClientRect();
    const init = {
      bubbles: true,
      cancelable: true,
      clientX: box.left + 60,
      clientY: box.top + 60,
      button: 0,
      pointerId: 7,
      isPrimary: true,
      pointerType: 'mouse',
    };
    // With Select, a press on the page is not a stroke.
    layer.dispatchEvent(new PointerEvent('pointerdown', { ...init, buttons: 1 }));
    window.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0 }));
    expect(dock).not.toHaveAttribute('data-stroking');

    await userEvent.keyboard('{Shift>}e{/Shift}');
    await waitFor(() => expect(layer).toHaveAttribute('data-tool', 'eraser'));
    layer.dispatchEvent(new PointerEvent('pointerdown', { ...init, buttons: 1 }));
    await waitFor(() => expect(dock).toHaveAttribute('data-stroking'));
    expect(getComputedStyle(bar()).pointerEvents).toBe('none');
    // A stroke passing over the bar reaches what is beneath it, never a preset.
    const b = bar().getBoundingClientRect();
    const under = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    expect(under === null || !bar().contains(under)).toBe(true);
    window.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0 }));
    // It lingers for a second, then the bar takes the pointer again.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(dock).toHaveAttribute('data-stroking');
    await waitFor(() => expect(dock).not.toHaveAttribute('data-stroking'), { timeout: 2500 });
    expect(getComputedStyle(bar()).pointerEvents).toBe('auto');
  });

  it('is one Tab stop; arrows move between groups and tools', async () => {
    await mount();
    const buttons = within(bar()).getAllByRole('button');
    expect(buttons.filter((b) => b.tabIndex === 0)).toHaveLength(1);
    buttons[0]?.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(buttons[1]).toHaveFocus();
    await userEvent.keyboard('{End}');
    expect(buttons[4]).toHaveFocus();
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
    // The Highlight markup tool (H arms the Highlighter preset since craft spec §5.4), its
    // options asked for (the tool pressed again).
    act(() => useToolStore.getState().setMode('highlight'));
    expect(screen.queryByTestId('options-tier')).toBeNull();
    act(() => useToolStore.getState().setOptionsOpen(true));
    const tier = await screen.findByRole('toolbar', { name: 'Highlight options' });
    // Attached to the top of the bar, not over the page.
    expect(tier.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      bar().getBoundingClientRect().top,
    );
    await userEvent.click(within(tier).getByRole('radio', { name: 'Blue' }));
    // The highlight's swatches are the highlighter tints (craft spec §6).
    expect(useAnnotationStore.getState().styles.highlight.color).toBe(TINT.blue);
    expect(within(tier).getByRole('radio', { name: 'Blue' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(await readAnnotations(target.source, 0)).toEqual([]);
    // Shapes have a width; arming one closes the tier, and R again opens it.
    await userEvent.keyboard('r');
    await waitFor(() => expect(useToolStore.getState().mode).toBe('rectangle'));
    expect(screen.queryByTestId('options-tier')).toBeNull();
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
        color: INK.red,
        opacity: 1,
        strokeWidth: 2,
      },
    ]);
    const id = created?.[0]?.id;
    if (id === undefined) throw new Error('not created');
    await userEvent.keyboard('rr');
    const tier = await screen.findByRole('toolbar', { name: 'Rectangle options' });
    // An explicit select (a Review row, Tab) while the tool is armed.
    useAnnotationStore.getState().select({ ...target, ids: [id] });
    within(tier).getByRole('radio', { name: 'Green' }).click();
    await waitFor(async () => {
      const square = (await readAnnotations(target.source, 0)).find((a) => a.id === id);
      expect(square && 'color' in square ? square.color : undefined).toBe(INK.green);
    });
    expect(useAnnotationStore.getState().styles.shape.color).toBe(INK.red);
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
    await userEvent.click(within(bar()).getByRole('button', { name: 'Write' }));
    await settle();
    await userEvent.click(within(bar()).getByRole('button', { name: 'Blue pen' }));
    expect(useToolStore.getState().mode).toBe('ink');
    expect(within(bar()).queryByRole('button', { name: 'Pen' })).toBeNull();
    // The pen's own style is in the tier until a preset editor plugs in there too, shown on
    // request: P with that pen armed.
    expect(screen.queryByTestId('options-tier')).toBeNull();
    await userEvent.keyboard('p');
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
      expect(row('Pen tool')).toHaveTextContent('Tool bar: Write');
      expect(row('Pen tool')).toHaveTextContent('P');
      expect(row('Highlighter tool')).toHaveTextContent('Tool bar: Write');
      expect(row('Select tool')).toHaveTextContent('Tool bar: Select');
      expect(row('Edit text tool')).toHaveTextContent('Tool bar: Text');
      expect(row('Note tool')).toHaveTextContent('Tool bar: Text');
      expect(row('Redact tool')).toHaveTextContent('Tool bar: Redact');
      // The text markups keep their keys, with no bar group.
      expect(row('Underline tool')).toHaveTextContent('U');
      expect(row('Underline tool')).not.toHaveTextContent('Tool bar');
      for (const tool of ANNOTATION_TOOLS) {
        expect(dialog.textContent).toContain(`${tool.title()} tool`);
      }
      expect(dialog.querySelectorAll('[data-bar-group-note]').length).toBeGreaterThanOrEqual(
        ANNOTATION_TOOLS.filter((t) => t.group !== undefined).length,
      );
    } finally {
      useUiStore.setState({ shortcutsOpen: false });
      dispose();
    }
  });
});
