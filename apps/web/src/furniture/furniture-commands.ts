/**
 * Furniture commands (palette and the Document menu): open a dialog on the active
 * document, or remove one kind of furniture from it (one history entry each).
 */
import { getActiveDocument } from '@pdf-editor/document-model';

import type { CommandRegistry } from '../commands/registry';
import { m } from '../i18n';
import { useWorkspaceStore } from '../state/workspace-store';
import { furnitureName, removeFurnitureFrom, removeLabel } from './FurnitureDialogs';
import { type FurnitureKind, hasFurniture } from './furniture-model';
import { openFurnitureDialog } from './furniture-store';

const activeDocument = () => getActiveDocument(useWorkspaceStore.getState().workspace);

const KINDS: readonly {
  readonly kind: FurnitureKind;
  readonly id: string;
  readonly title: () => string;
  readonly keywords: readonly string[];
}[] = [
  {
    kind: 'page-numbers',
    id: 'document.pageNumbers',
    title: () => m.cmd_page_numbers(),
    keywords: ['page numbers', 'numbering', 'folio', 'sayfa numarası'],
  },
  {
    kind: 'header-footer',
    id: 'document.headerFooter',
    title: () => m.cmd_header_footer(),
    keywords: ['header', 'footer', 'running head', 'date', 'title'],
  },
  {
    kind: 'bates',
    id: 'document.bates',
    title: () => m.cmd_bates(),
    keywords: ['bates', 'legal', 'stamp', 'numbering', 'discovery'],
  },
  {
    kind: 'watermark',
    id: 'document.watermark',
    title: () => m.cmd_watermark(),
    keywords: ['watermark', 'draft', 'confidential', 'stamp', 'filigran'],
  },
];

export function registerFurnitureCommands(registry: CommandRegistry): () => void {
  const disposers = KINDS.flatMap(({ kind, id, title, keywords }) => [
    registry.register({
      id,
      title: title(),
      group: m.group_document(),
      keywords,
      when: () => (activeDocument()?.pages.length ?? 0) > 0,
      run: () => {
        const doc = activeDocument();
        if (doc) openFurnitureDialog(kind, doc.id);
      },
    }),
    registry.register({
      id: `${id}.remove`,
      title: removeLabel(kind),
      group: m.group_document(),
      keywords: [...keywords, 'remove', 'delete'],
      note: m.furniture_remove_note({ name: furnitureName(kind) }),
      when: () => {
        const doc = activeDocument();
        return doc !== undefined && hasFurniture(doc, kind);
      },
      run: () => {
        const doc = activeDocument();
        if (doc) removeFurnitureFrom(doc.id, kind);
      },
    }),
  ]);
  return () => {
    for (const dispose of disposers) dispose();
  };
}
