/**
 * "Export as Markdown / text…" (spec recognize-and-compare §4) in the Document menu and the
 * palette (group "Document"). The dialog loads on first use (tools/DocumentMenu.tsx).
 */
import { getActiveDocument } from '@pdf-editor/document-model';

import type { CommandRegistry } from '../commands/registry';
import { m } from '../i18n';
import { useWorkspaceStore } from '../state/workspace-store';
import { openToolDialog, useToolsStore } from '../tools/tools-store';

const activeDocument = () => getActiveDocument(useWorkspaceStore.getState().workspace);

export function registerConvertCommands(registry: CommandRegistry): () => void {
  return registry.register({
    id: 'document.exportMarkdown',
    title: m.cmd_convert_markdown(),
    group: m.group_document(),
    keywords: ['markdown', 'md', 'text', 'txt', 'convert', 'extract', 'export', 'plain'],
    when: () =>
      (activeDocument()?.pages.length ?? 0) > 0 && useToolsStore.getState().dialog === null,
    run: () => {
      const doc = activeDocument();
      if (doc) openToolDialog('markdown', doc.id);
    },
  });
}
