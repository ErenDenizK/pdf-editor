/**
 * "Batch…" (spec §5): in the palette and, with the Document group, in the tab bar's
 * Document menu. Available with or without open documents: a batch never touches the tabs.
 */
import type { CommandRegistry } from '../commands/registry';
import { m } from '../i18n';
import { openBatchDialog, useBatchStore } from './batch-store';

export function registerBatchCommands(registry: CommandRegistry): () => void {
  return registry.register({
    id: 'document.batch',
    title: m.cmd_batch(),
    group: m.group_document(),
    keywords: ['batch', 'recipe', 'many', 'files', 'folder', 'automate', 'bulk', 'zip'],
    when: () => !useBatchStore.getState().open,
    run: () => openBatchDialog(),
  });
}
