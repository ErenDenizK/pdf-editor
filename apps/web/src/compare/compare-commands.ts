/**
 * Compare commands (spec recognize-and-compare §2.2): the Compare view (3), J / K through
 * the Changes list, Esc back to the previous view, run, and the two exports. Registered
 * from `app-commands.ts`. The view's code and the analysis worker load on first use.
 *
 * Leaving the Compare view keeps the comparison (the view is read-only, so leaving loses
 * nothing to ask about): coming back shows the same result, and the view-switch segment
 * stays while it is kept. "New comparison" and closing a compared tab release it (its heat
 * maps and scratch documents in the workers). A change to a compared document, in any view,
 * marks the result stale (compare-store.ts `refreshCompareStale`).
 */
import type { DocumentId } from '@pdf-editor/document-model';

import type { CommandRegistry } from '../commands/registry';
import { m } from '../i18n';
import { announce } from '../shell/announcer';
import { type LeftPanelView, useUiStore, type ViewMode } from '../state/ui-store';
import { useWorkspaceStore } from '../state/workspace-store';
import { buildChangeList, buildPartialChangeList, type ChangeItem, stepChange } from './changes';
import { refreshCompareStale, requestReveal, useCompareStore } from './compare-store';

const runner = () => import('./compare-runner');

const inCompare = () =>
  useUiStore.getState().viewMode === 'compare' &&
  useWorkspaceStore.getState().workspace.documentOrder.length > 0;

/** The Changes list as it stands (partial while the run is in progress). */
export function currentChangeList() {
  const { result, pairs, visuals } = useCompareStore.getState();
  if (result) return buildChangeList(result);
  if (pairs) return buildPartialChangeList(pairs, visuals);
  return null;
}

/** Makes `item` the current change and brings it into view. */
export function selectChange(item: ChangeItem): void {
  useCompareStore.setState({ current: item.id });
  if (item.row !== null) {
    requestReveal({ row: item.row, side: item.side, ...(item.rect ? { rect: item.rect } : {}) });
  }
}

export function stepChanges(direction: 1 | -1): boolean {
  const list = currentChangeList();
  if (!list) return false;
  const next = stepChange(list.flat, useCompareStore.getState().current, direction);
  if (!next) return false;
  selectChange(next);
  return true;
}

/** Default choices: A is the active tab, B the next open tab (or the previous one). */
export function defaultPair(): { a: DocumentId | null; b: DocumentId | null } {
  const ws = useWorkspaceStore.getState().workspace;
  const order = ws.documentOrder;
  const a = ws.activeDocument ?? order[0] ?? null;
  const index = a === null ? -1 : order.indexOf(a);
  const b = order[index + 1] ?? order.find((id) => id !== a) ?? null;
  return { a, b };
}

let previousMode: Exclude<ViewMode, 'compare'> = 'read';
let previousPanel: { open: boolean; view: LeftPanelView } | null = null;

/** Switches to the Compare view with the Changes panel open. */
export function enterCompare(): void {
  const ui = useUiStore.getState();
  if (ui.viewMode === 'compare') return;
  ui.setViewMode('compare');
}

/** Back to the view the user came from. */
export function leaveCompare(): void {
  if (useUiStore.getState().viewMode !== 'compare') return;
  useUiStore.getState().setViewMode(previousMode);
}

function onEnter(): void {
  const ui = useUiStore.getState();
  previousPanel = { open: ui.leftPanelOpen, view: ui.leftPanelView };
  useUiStore.setState({ leftPanelOpen: true, leftPanelView: 'changes' });
  const state = useCompareStore.getState();
  const docs = useWorkspaceStore.getState().workspace.documents;
  const valid = (id: DocumentId | null) => id !== null && docs[id] !== undefined;
  if (!valid(state.a) || !valid(state.b) || state.a === state.b) {
    const pair = defaultPair();
    useCompareStore.setState({
      a: valid(state.a) ? state.a : pair.a,
      b: valid(state.b) && state.b !== state.a ? state.b : pair.b,
    });
  }
}

function onLeave(): void {
  // The result stays until "New comparison" or a compared tab closes.
  const ui = useUiStore.getState();
  if (ui.leftPanelView === 'changes') {
    const restore = previousPanel ?? { open: true, view: 'pages' as const };
    useUiStore.setState({
      leftPanelOpen: restore.open,
      leftPanelView: restore.view === 'changes' ? 'pages' : restore.view,
    });
  }
  previousPanel = null;
}

/** Keeps the comparison in step with the view mode and the open tabs. */
function watch(): () => void {
  const offUi = useUiStore.subscribe((state, prev) => {
    if (state.viewMode === prev.viewMode) return;
    if (prev.viewMode !== 'compare') previousMode = prev.viewMode;
    if (state.viewMode === 'compare') onEnter();
    else if (prev.viewMode === 'compare') onLeave();
  });
  const offWs = useWorkspaceStore.subscribe((state, prev) => {
    if (state.workspace === prev.workspace) return;
    const { a, b, status } = useCompareStore.getState();
    const docs = state.workspace.documents;
    const gone = (id: DocumentId | null) => id !== null && docs[id] === undefined;
    if (!gone(a) && !gone(b)) {
      // An edit, undo / redo or page command on a compared document: say the result is old.
      refreshCompareStale(state.workspace);
      return;
    }
    if (status !== 'setup') void runner().then((r) => r.releaseCompare());
    const pair = defaultPair();
    useCompareStore.setState({
      a: gone(a) ? pair.a : a,
      b: gone(b) ? (pair.b !== (gone(a) ? pair.a : a) ? pair.b : null) : b,
    });
    if (
      state.workspace.documentOrder.length === 0 &&
      useUiStore.getState().viewMode === 'compare'
    ) {
      leaveCompare();
    }
  });
  return () => {
    offUi();
    offWs();
  };
}

const hasResult = () => inCompare() && useCompareStore.getState().result !== null;
/** The report annotates B as compared: refused once a compared document changed. */
const hasFreshResult = () => hasResult() && !useCompareStore.getState().stale;

export function registerCompareCommands(registry: CommandRegistry): () => void {
  const disposers = [
    watch(),
    registry.register({
      id: 'mode.compare',
      title: m.cmd_compare_mode(),
      group: m.group_view(),
      shortcut: '3',
      keywords: ['compare', 'diff', 'difference', 'changes', 'versions', 'revision'],
      when: () => useWorkspaceStore.getState().workspace.documentOrder.length > 0,
      run: () => {
        enterCompare();
        announce(m.compare_mode_long());
      },
    }),
    registry.register({
      id: 'compare.leave',
      title: m.cmd_compare_leave(),
      group: m.group_view(),
      shortcut: 'Escape',
      hiddenInPalette: true,
      when: () => useUiStore.getState().viewMode === 'compare',
      run: leaveCompare,
    }),
    registry.register({
      id: 'compare.run',
      title: m.cmd_compare_run(),
      group: m.group_view(),
      keywords: ['compare', 'diff', 'run', 'again'],
      when: () => {
        const { a, b, status } = useCompareStore.getState();
        return (
          inCompare() &&
          a !== null &&
          b !== null &&
          a !== b &&
          status !== 'running' &&
          status !== 'preparing'
        );
      },
      run: () => runner().then((r) => r.startCompare()),
    }),
    registry.register({
      id: 'compare.next',
      title: m.cmd_compare_next(),
      group: m.group_view(),
      shortcut: 'J',
      keywords: ['compare', 'change', 'next', 'diff'],
      when: () => inCompare() && (currentChangeList()?.flat.length ?? 0) > 0,
      run: () => {
        stepChanges(1);
      },
    }),
    registry.register({
      id: 'compare.previous',
      title: m.cmd_compare_previous(),
      group: m.group_view(),
      shortcut: 'K',
      keywords: ['compare', 'change', 'previous', 'diff'],
      when: () => inCompare() && (currentChangeList()?.flat.length ?? 0) > 0,
      run: () => {
        stepChanges(-1);
      },
    }),
    registry.register({
      id: 'compare.exportReport',
      title: m.cmd_compare_export_report(),
      group: m.group_view(),
      keywords: ['compare', 'report', 'pdf', 'annotations', 'export'],
      when: hasFreshResult,
      run: () => runner().then((r) => r.exportComparisonReport()),
    }),
    registry.register({
      id: 'compare.exportChanges',
      title: m.cmd_compare_export_changes(),
      group: m.group_view(),
      keywords: ['compare', 'changes', 'text', 'markdown', 'list', 'export'],
      when: hasResult,
      run: () => import('./changes-export').then((x) => x.exportChangesText()),
    }),
  ];
  return () => {
    for (const dispose of disposers) dispose();
  };
}
