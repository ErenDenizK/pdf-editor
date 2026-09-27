/**
 * Document-tools commands (spec document-tools.md §3, §4, §7): reachable from the command
 * palette and the tab bar's Document menu (which lists every command in the Document
 * group, so other document tools appear there by registering in that group).
 */
import { getActiveDocument } from '@pdf-editor/document-model';

import type { CommandRegistry } from '../commands/registry';
import { useExportDialogStore } from '../export/export-store';
import { m } from '../i18n';
import { useUiStore } from '../state/ui-store';
import { useWorkspaceStore } from '../state/workspace-store';
import {
  type DocumentDialogKind,
  openDocumentDialog,
  useDocumentDialogStore,
} from './document-store';

const activeDocument = () => getActiveDocument(useWorkspaceStore.getState().workspace);

const idle = () =>
  activeDocument() !== undefined &&
  useDocumentDialogStore.getState().dialog === null &&
  useExportDialogStore.getState().documentId === null;

/** Opens the right panel and focuses the Info section's Title field. */
export function showDocumentInfo(): void {
  if (!useUiStore.getState().rightPanelOpen) useUiStore.getState().toggleRightPanel();
  requestAnimationFrame(() => {
    const section = document.getElementById('inspector-info');
    section?.scrollIntoView?.({ block: 'start' });
    document.querySelector<HTMLInputElement>('[data-testid="metadata-editor"] input')?.focus();
  });
}

export function registerDocumentCommands(registry: CommandRegistry): () => void {
  const open = (kind: DocumentDialogKind) => () => {
    const doc = activeDocument();
    if (doc) openDocumentDialog(kind, doc.id);
  };
  const disposers = [
    registry.register({
      id: 'document.info',
      title: m.cmd_document_info(),
      group: m.group_document(),
      keywords: ['metadata', 'properties', 'title', 'author', 'diagnostics', 'info'],
      when: () => activeDocument() !== undefined,
      run: showDocumentInfo,
    }),
    registry.register({
      id: 'document.setPassword',
      title: m.cmd_set_password(),
      group: m.group_document(),
      keywords: ['encrypt', 'protect', 'permissions', 'security', 'aes'],
      when: idle,
      run: open('set-password'),
    }),
    registry.register({
      id: 'document.removePassword',
      title: m.cmd_remove_password(),
      group: m.group_document(),
      keywords: ['decrypt', 'unlock', 'restrictions', 'security'],
      when: () => {
        if (!idle()) return false;
        const doc = activeDocument();
        const ws = useWorkspaceStore.getState().workspace;
        return (
          doc !== undefined &&
          (doc.security !== undefined ||
            (!doc.passwordRemoved &&
              doc.pages.some(
                (p) => p.ref.kind === 'source' && ws.sources[p.ref.source]?.flags.encrypted,
              )))
        );
      },
      run: open('remove-password'),
    }),
    registry.register({
      id: 'document.stripMetadata',
      title: m.cmd_strip_metadata(),
      group: m.group_document(),
      keywords: ['privacy', 'metadata', 'xmp', 'author', 'attachments', 'javascript', 'clean'],
      when: idle,
      run: open('strip-metadata'),
    }),
  ];
  return () => {
    for (const dispose of disposers) dispose();
  };
}
