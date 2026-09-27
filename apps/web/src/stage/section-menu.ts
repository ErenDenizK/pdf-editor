/**
 * Light-table section menu (spec §5): an extension point. Each item runs a registered
 * command; while it runs, `sectionCommandTarget()` names the section's document, so a
 * command can act on the section it was invoked from rather than the active tab.
 *
 * Items whose command is missing or unavailable for the section are shown disabled, with
 * a hint saying why when the item provides one ("Needs another open document"). An item
 * may offer a submenu instead (Merge into… lists the other documents); the tab context
 * menu shows the same items.
 *
 *   registerSectionMenuItem({ command: 'section.example', label: m.example, group: 'pages' });
 *   registerCommand({ id: 'section.example', …, run: () => {
 *     const doc = sectionCommandTarget() ?? activeDocumentId();
 *   } });
 */
import type { DocumentId } from '@pdf-editor/document-model';

import { type CommandRegistry, commandRegistry } from '../commands/registry';
import { m } from '../i18n';
import { useWorkspaceStore } from '../state/workspace-store';

export interface SectionSubmenuEntry {
  readonly key: string;
  readonly label: string;
  /** Source colour tag shown before the label. */
  readonly colorIndex?: number;
  readonly run: () => void;
}

export interface SectionMenuItem {
  /** Command id run when the item is chosen. */
  readonly command: string;
  /** Message function, so the label follows the active language. */
  readonly label: () => string;
  readonly group: 'pages' | 'document';
  /** Why the item is disabled for this document (shown next to the label). */
  readonly hint?: (documentId: DocumentId) => string | undefined;
  /** Entries of a submenu shown instead of running the command directly. */
  readonly submenu?: (documentId: DocumentId) => readonly SectionSubmenuEntry[];
}

const docs = () => useWorkspaceStore.getState().workspace;
const pageCount = (id: DocumentId) => docs().documents[id]?.pages.length ?? 0;
const hasOtherDocument = (id: DocumentId) => docs().documentOrder.some((other) => other !== id);

/** Hint for operations that need a second document. */
export function needsOtherDocumentHint(id: DocumentId): string | undefined {
  return hasOtherDocument(id) ? undefined : m.hint_needs_other_document();
}

let mergeTargets: (documentId: DocumentId) => readonly SectionSubmenuEntry[] = () => [];

/** The operations module provides the Merge into… targets (avoids an import cycle). */
export function provideMergeTargets(
  provider: (documentId: DocumentId) => readonly SectionSubmenuEntry[],
): () => void {
  mergeTargets = provider;
  return () => {
    if (mergeTargets === provider) mergeTargets = () => [];
  };
}

const BUILT_IN: readonly SectionMenuItem[] = [
  {
    command: 'section.reverse',
    label: m.section_reverse,
    group: 'pages',
    hint: (id) => (pageCount(id) > 1 ? undefined : m.hint_needs_two_pages()),
  },
  {
    command: 'section.interleave',
    label: m.section_interleave,
    group: 'pages',
    hint: needsOtherDocumentHint,
  },
  {
    command: 'section.split',
    label: m.section_split,
    group: 'pages',
    hint: (id) => (pageCount(id) > 1 ? undefined : m.hint_needs_two_pages()),
  },
  {
    command: 'section.merge',
    label: m.section_merge,
    group: 'pages',
    hint: needsOtherDocumentHint,
    submenu: (id) => mergeTargets(id),
  },
  { command: 'section.insertImages', label: m.section_insert_images, group: 'pages' },
  { command: 'section.rename', label: m.section_rename, group: 'document' },
  { command: 'section.close', label: m.section_close, group: 'document' },
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
let origin: SectionMenuOrigin | null = null;

/** Which menu ran a section command: the light-table section's or the tab's. */
export type SectionMenuOrigin = 'section' | 'tab';

/** The document whose section menu invoked the running command, else null. */
export function sectionCommandTarget(): DocumentId | null {
  return target;
}

/** The menu the running section command came from, else null (palette, shortcut). */
export function sectionCommandOrigin(): SectionMenuOrigin | null {
  return origin;
}

/** Runs a section command for `documentId`. Resolves to whether it ran. */
export async function runSectionCommand(
  command: string,
  documentId: DocumentId,
  registry: CommandRegistry = commandRegistry,
  from: SectionMenuOrigin = 'section',
): Promise<boolean> {
  const previous = target;
  const previousOrigin = origin;
  target = documentId;
  origin = from;
  try {
    return await registry.execute(command);
  } finally {
    target = previous;
    origin = previousOrigin;
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

/** Everything a menu needs to render one item for a document. */
export interface ResolvedSectionItem {
  readonly item: SectionMenuItem;
  readonly label: string;
  readonly enabled: boolean;
  /** Shown when disabled: why ("Needs another open document"), or "Not available yet". */
  readonly hint: string | undefined;
  readonly submenu: readonly SectionSubmenuEntry[] | undefined;
}

export function resolveSectionItem(
  item: SectionMenuItem,
  documentId: DocumentId,
  registry: CommandRegistry = commandRegistry,
): ResolvedSectionItem {
  const registered = registry.get(item.command) !== undefined;
  const submenu = item.submenu?.(documentId);
  const enabled =
    isSectionCommandEnabled(item.command, documentId, registry) &&
    (submenu === undefined || submenu.length > 0);
  const hint = enabled
    ? undefined
    : registered
      ? item.hint?.(documentId)
      : m.section_not_available();
  return { item, label: item.label(), enabled, hint, submenu };
}
