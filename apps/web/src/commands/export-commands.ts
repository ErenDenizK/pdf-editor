/**
 * Export commands. "Export document…" (Mod+S) opens the export dialog for the active tab;
 * Mod+S also stops the browser's "Save page as". Registered from `app-commands.ts`.
 *
 * TODO(M2): "Export selection to new document".
 */
import { getActiveDocument } from '@pdf-editor/document-model';

import { openExportDialog, useExportDialogStore } from '../export/export-store';
import { m } from '../i18n';
import { useWorkspaceStore } from '../state/workspace-store';
import type { CommandRegistry } from './registry';

const activeDocument = () => getActiveDocument(useWorkspaceStore.getState().workspace);

export function registerExportCommands(registry: CommandRegistry): () => void {
  return registry.register({
    id: 'file.export',
    title: m.cmd_export(),
    group: m.group_file(),
    shortcut: 'Mod+S',
    keywords: ['save', 'download', 'pdf', 'merge', 'write'],
    when: () =>
      (activeDocument()?.pages.length ?? 0) > 0 &&
      useExportDialogStore.getState().documentId === null,
    run: () => {
      const doc = activeDocument();
      if (doc) openExportDialog(doc.id);
    },
  });
}
