/**
 * Light-table section menu (spec §5): an extension point. Each item runs a registered
 * command; while it runs, `sectionCommandTarget()` names the section's document, so a
 * command can act on the section it was invoked from rather than the active tab.
 *
 * Structural operations (interleave, split, merge, rename) are owned by the operations
 * work; they register their commands under the ids below and the menu enables the items
 * automatically. Until then the items are shown disabled.
 *
 *   registerCommand({ id: 'section.interleave', …, run: () => {
 *     const doc = sectionCommandTarget() ?? activeDocumentId();
 *   } });
 */
import type { DocumentId } from '@pdf-editor/document-model';

import { type CommandRegistry, commandRegistry } from '../commands/registry';

export interface SectionMenuItem {
  /** Command id run when the item is chosen. */
  readonly command: string;
  readonly label: string;
  readonly group: 'pages' | 'document';
}

const BUILT_IN: readonly SectionMenuItem[] = [
  { command: 'section.reverse', label: 'Reverse pages', group: 'pages' },
  { command: 'section.interleave', label: 'Interleave with…', group: 'pages' },
  { command: 'section.split', label: 'Split…', group: 'pages' },
  { command: 'section.merge', label: 'Merge into…', group: 'pages' },
  { command: 'section.rename', label: 'Rename…', group: 'document' },
  { command: 'section.close', label: 'Close document', group: 'document' },
];

let extra: readonly SectionMenuItem[] = [];
const listeners = new Set<() => void>();
let snapshot: readonly SectionMenuItem[] = BUILT_IN;

function emit(): void {
  snapshot = [...BUILT_IN, ...extra];
  for (const listener of listeners) listener();
}

/** Adds an item to every section menu; returns a disposer. */
export function registerSectionMenuItem(item: SectionMenuItem): () => void {
  extra = [...extra, item];
  emit();
  return () => {
    extra = extra.filter((i) => i !== item);
    emit();
  };
}

/** Items in menu order (stable identity between changes, for useSyncExternalStore). */
export function sectionMenuItems(): readonly SectionMenuItem[] {
  return snapshot;
}

export function subscribeSectionMenu(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

let target: DocumentId | null = null;

/** The document whose section menu invoked the running command, else null. */
export function sectionCommandTarget(): DocumentId | null {
  return target;
}

/** Runs a section command for `documentId`. Resolves to whether it ran. */
export async function runSectionCommand(
  command: string,
  documentId: DocumentId,
  registry: CommandRegistry = commandRegistry,
): Promise<boolean> {
  const previous = target;
  target = documentId;
  try {
    return await registry.execute(command);
  } finally {
    target = previous;
  }
}

/** Whether a section command exists and is enabled for `documentId`. */
export function isSectionCommandEnabled(
  command: string,
  documentId: DocumentId,
  registry: CommandRegistry = commandRegistry,
): boolean {
  const found = registry.get(command);
  if (found === undefined) return false;
  const previous = target;
  target = documentId;
  try {
    return registry.isEnabled(found);
  } finally {
    target = previous;
  }
}
