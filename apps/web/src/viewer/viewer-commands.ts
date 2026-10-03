/**
 * Read-mode commands (spec §1): find (Mod+F, F3), go to page (Mod+G), page navigation
 * (`[` `]`, PageUp / PageDown, Space / Shift+Space, Home / End) and the page layouts.
 *
 * Navigation keys only act when focus is on the pages or nowhere in particular, so they
 * never steal Space from a button or Home/End from a list.
 */
import { getActiveDocument } from '@pdf-editor/document-model';

import type { CommandRegistry } from '../commands/registry';
import { m } from '../i18n';
import { announce } from '../shell/announcer';
import { isPageView, useUiStore } from '../state/ui-store';
import { READ_LAYOUTS, type ReadLayout, useViewStore } from '../state/view-store';
import { useWorkspaceStore } from '../state/workspace-store';
import { openGoToPage } from './GoToPageDialog';
import { goToPageIndex, nextPage, previousPage } from './navigation';
import { readController } from './read-controller';
import { openSearchPanel, searchStep, useSearchStore } from './search';

const activeDocument = () => getActiveDocument(useWorkspaceStore.getState().workspace);
const hasPages = () => (activeDocument()?.pages.length ?? 0) > 0;
const reading = () => isPageView(useUiStore.getState()) && hasPages();
/** Read mode is shown and focus is on the pages (or nowhere). */
const readingWithFocus = () => reading() && (readController()?.ownsFocus() ?? false);

export function layoutTitle(layout: ReadLayout): string {
  switch (layout) {
    case 'continuous':
      return m.layout_continuous();
    case 'single':
      return m.layout_single();
    case 'two-up':
      return m.layout_two_up();
  }
}

export function setReadLayout(layout: ReadLayout): void {
  useViewStore.getState().setLayout(layout);
  announce(m.announce_layout({ layout: layoutTitle(layout) }));
}

export function registerViewerCommands(registry: CommandRegistry): () => void {
  const disposers = [
    registry.register({
      id: 'search.open',
      title: m.cmd_find(),
      group: m.group_navigate(),
      shortcut: 'Mod+F',
      keywords: ['search', 'find', 'text', 'look up'],
      allowInInputs: true,
      when: () => activeDocument() !== undefined,
      run: openSearchPanel,
    }),
    registry.register({
      id: 'search.next',
      title: m.cmd_find_next(),
      group: m.group_navigate(),
      shortcut: 'F3',
      keywords: ['search', 'next match'],
      allowInInputs: true,
      when: () => useSearchStore.getState().hits.length > 0,
      run: () => searchStep(1),
    }),
    registry.register({
      id: 'search.previous',
      title: m.cmd_find_previous(),
      group: m.group_navigate(),
      shortcut: 'Shift+F3',
      keywords: ['search', 'previous match'],
      allowInInputs: true,
      when: () => useSearchStore.getState().hits.length > 0,
      run: () => searchStep(-1),
    }),
    registry.register({
      id: 'nav.goToPage',
      title: m.cmd_go_to_page(),
      group: m.group_navigate(),
      shortcut: 'Mod+G',
      keywords: ['jump', 'page number', 'label', 'go'],
      when: hasPages,
      run: () => {
        if (!isPageView(useUiStore.getState())) useUiStore.getState().setViewMode('read');
        openGoToPage();
      },
    }),
    registry.register({
      id: 'nav.previousPage',
      title: m.cmd_previous_page(),
      group: m.group_navigate(),
      shortcut: '[',
      keywords: ['back', 'page up'],
      when: reading,
      run: () => {
        previousPage();
      },
    }),
    registry.register({
      id: 'nav.nextPage',
      title: m.cmd_next_page(),
      group: m.group_navigate(),
      shortcut: ']',
      keywords: ['forward', 'page down'],
      when: reading,
      run: () => {
        nextPage();
      },
    }),
    registry.register({
      id: 'nav.screenDown',
      title: m.cmd_screen_down(),
      group: m.group_navigate(),
      shortcut: ['PageDown', 'Space'],
      hiddenInPalette: true,
      when: readingWithFocus,
      run: () => readController()?.scrollByScreen(1),
    }),
    registry.register({
      id: 'nav.screenUp',
      title: m.cmd_screen_up(),
      group: m.group_navigate(),
      shortcut: ['PageUp', 'Shift+Space'],
      hiddenInPalette: true,
      when: readingWithFocus,
      run: () => readController()?.scrollByScreen(-1),
    }),
    registry.register({
      id: 'nav.firstPage',
      title: m.cmd_first_page(),
      group: m.group_navigate(),
      shortcut: 'Home',
      keywords: ['start', 'beginning', 'top'],
      when: readingWithFocus,
      run: () => {
        goToPageIndex(0);
      },
    }),
    registry.register({
      id: 'nav.lastPage',
      title: m.cmd_last_page(),
      group: m.group_navigate(),
      shortcut: 'End',
      keywords: ['bottom'],
      when: readingWithFocus,
      run: () => {
        goToPageIndex(Number.MAX_SAFE_INTEGER);
      },
    }),
    ...READ_LAYOUTS.map((layout) =>
      registry.register({
        id: `layout.${layout}`,
        title: m.cmd_layout({ layout: layoutTitle(layout) }),
        group: m.group_view(),
        keywords: ['layout', 'pages', 'spread', 'two pages', 'single page', 'continuous'],
        when: hasPages,
        run: () => setReadLayout(layout),
      }),
    ),
  ];
  return () => {
    for (const dispose of disposers) dispose();
  };
}
