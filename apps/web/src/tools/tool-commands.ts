/**
 * Document tool commands (spec §5–§7), grouped under "Document" in the palette and listed
 * by the Document menu in the tab bar (`DocumentMenu.tsx`: Compress… and Export pages as
 * images… under "Convert and export", Save repaired copy under "Document" while there is a
 * repaired source). Registered from `app-commands.ts`.
 */
import { getActiveDocument } from '@pdf-editor/document-model';

import { registerBatchCommands } from '../batch/batch-commands';
import type { CommandRegistry } from '../commands/registry';
import { m } from '../i18n';
import { useWorkspaceStore } from '../state/workspace-store';
import { repairedSources, saveRepairedCopy } from './repair';
import { openToolDialog, useToolsStore } from './tools-store';

const activeDocument = () => getActiveDocument(useWorkspaceStore.getState().workspace);
const hasPages = () => (activeDocument()?.pages.length ?? 0) > 0;
const noDialog = () => useToolsStore.getState().dialog === null;

export function registerToolCommands(registry: CommandRegistry): () => void {
  const group = m.group_document();
  const disposers = [
    registry.register({
      id: 'document.compress',
      title: m.cmd_tools_compress(),
      group,
      keywords: ['compress', 'optimize', 'reduce', 'size', 'shrink', 'downsample', 'jpeg'],
      when: () => hasPages() && noDialog(),
      run: () => {
        const doc = activeDocument();
        if (doc) openToolDialog('compress', doc.id);
      },
    }),
    registry.register({
      id: 'document.exportImages',
      title: m.cmd_tools_export_images(),
      group,
      keywords: ['png', 'jpeg', 'jpg', 'webp', 'image', 'rasterize', 'picture', 'zip', 'copy'],
      when: () => hasPages() && noDialog(),
      run: () => {
        const doc = activeDocument();
        if (doc) openToolDialog('images', doc.id);
      },
    }),
    registry.register({
      id: 'document.saveRepaired',
      title: m.cmd_tools_save_repaired(),
      group,
      keywords: ['repair', 'fix', 'damaged', 'broken', 'qpdf', 'rewrite'],
      when: () => repairedSources().length > 0,
      run: async () => {
        for (const source of repairedSources()) {
          if ((await saveRepairedCopy(source)) === 'cancelled') break;
        }
      },
    }),
    registerBatchCommands(registry),
  ];
  return () => {
    for (const dispose of disposers) dispose();
  };
}
