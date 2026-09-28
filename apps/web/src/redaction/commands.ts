/**
 * Redaction commands (redaction spec §1.1): show the Redactions panel, review marks with
 * J / K, find sensitive data, and mark every search match. The Redact tool itself (X) is
 * one of the annotation tools (annotations/tools.ts).
 */
import type { CommandRegistry } from '../commands/registry';
import { m } from '../i18n';
import { useUiStore } from '../state/ui-store';
import { useWorkspaceStore } from '../state/workspace-store';
import { useSearchStore } from '../viewer/search';
import { useToolStore } from '../viewer/tool-store';
import { currentMarks, findSensitiveData, markSearchHits, stepMark } from './review';

const readMode = () =>
  useUiStore.getState().viewMode === 'read' &&
  useWorkspaceStore.getState().workspace.documentOrder.length > 0;

/** Opens the Redactions panel in the left rail. */
export function showRedactionsPanel(): void {
  useUiStore.setState({ leftPanelOpen: true, leftPanelView: 'redactions' });
}

/** J / K review while the panel is open or the Redact tool is on. */
const reviewing = () => {
  const ui = useUiStore.getState();
  return (
    readMode() &&
    ((ui.leftPanelOpen && ui.leftPanelView === 'redactions') ||
      useToolStore.getState().mode === 'redact') &&
    currentMarks().length > 0
  );
};

export function registerRedactionCommands(registry: CommandRegistry): () => void {
  const disposers = [
    registry.register({
      id: 'view.show.redactions',
      title: m.cmd_show_redactions(),
      group: m.group_view(),
      keywords: ['panel', 'sidebar', 'redact', 'redaction', 'marks', 'black out'],
      run: showRedactionsPanel,
    }),
    registry.register({
      id: 'redaction.next',
      title: m.cmd_redaction_next(),
      group: m.group_tools(),
      shortcut: 'J',
      keywords: ['redact', 'review', 'mark'],
      when: reviewing,
      run: () => {
        stepMark(1);
      },
    }),
    registry.register({
      id: 'redaction.previous',
      title: m.cmd_redaction_previous(),
      group: m.group_tools(),
      shortcut: 'K',
      keywords: ['redact', 'review', 'mark'],
      when: reviewing,
      run: () => {
        stepMark(-1);
      },
    }),
    registry.register({
      id: 'redaction.find',
      title: m.cmd_redaction_find(),
      group: m.group_tools(),
      keywords: ['redact', 'sensitive', 'pii', 'email', 'phone', 'iban', 'tckn', 'card'],
      when: readMode,
      run: () => {
        const ws = useWorkspaceStore.getState().workspace;
        const doc = ws.activeDocument === undefined ? undefined : ws.documents[ws.activeDocument];
        if (!doc) return;
        showRedactionsPanel();
        void findSensitiveData(doc);
      },
    }),
    registry.register({
      id: 'redaction.markMatches',
      title: m.cmd_redaction_mark_matches(),
      group: m.group_tools(),
      keywords: ['redact', 'search', 'find', 'mark all'],
      when: () => readMode() && useSearchStore.getState().hits.length > 0,
      run: () => markSearchHits().then(() => undefined),
    }),
  ];
  return () => {
    for (const dispose of disposers) dispose();
  };
}
