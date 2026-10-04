/**
 * Home's pure rules (experience-redesign §3): what a card shows, how selection grows with
 * clicks and keys, what "Combine" combines and in which order, and how sizes read.
 */
import type { DocumentId, SourceId, VirtualPage, Workspace } from '@pdf-editor/document-model';

import type { SourceFileInfo } from '../state/workspace-store';

export interface HomeCardData {
  readonly id: DocumentId;
  readonly title: string;
  readonly pageCount: number;
  readonly colorIndex: number;
  /** Size of the file as opened; undefined when the pages come from several files or none. */
  readonly size: number | undefined;
  /** The file's modification time (ms) when the document is one file. */
  readonly modified: number | undefined;
  readonly firstPage: VirtualPage | undefined;
}

/** One card per open document, in tab order. */
export function homeCards(
  ws: Workspace,
  files: Readonly<Record<SourceId, SourceFileInfo>>,
  colors: Readonly<Record<DocumentId, number>>,
): HomeCardData[] {
  return ws.documentOrder.flatMap((id): HomeCardData[] => {
    const doc = ws.documents[id];
    if (doc === undefined) return [];
    const sources = new Set<SourceId>();
    let images = false;
    for (const page of doc.pages) {
      if (page.ref.kind === 'source') sources.add(page.ref.source);
      else images = true;
    }
    const [only] = sources;
    const file = sources.size === 1 && !images && only !== undefined ? files[only] : undefined;
    return [
      {
        id,
        title: doc.title,
        pageCount: doc.pages.length,
        colorIndex: colors[id] ?? 0,
        size: file?.size,
        modified: file !== undefined && file.lastModified > 0 ? file.lastModified : undefined,
        firstPage: doc.pages[0],
      },
    ];
  });
}

/** The selection without closed documents, in selection order. */
export function liveSelection(
  order: readonly DocumentId[],
  selection: readonly DocumentId[],
): DocumentId[] {
  const open = new Set(order);
  return selection.filter((id) => open.has(id));
}

/**
 * What "Combine" merges, in merge order: the selection in the order it was made (two or
 * more), else every open document in tab order when nothing is selected. Null when there is
 * nothing to combine (one card selected, or fewer than two documents).
 */
export function combineScope(
  order: readonly DocumentId[],
  selection: readonly DocumentId[],
): { readonly ids: readonly DocumentId[]; readonly all: boolean } | null {
  const selected = liveSelection(order, selection);
  if (selected.length >= 2) return { ids: selected, all: false };
  if (selected.length === 0 && order.length >= 2) return { ids: order, all: true };
  return null;
}

/** A card dropped on another: the target first, the dragged card after it. */
export function dropOrder(target: DocumentId, dragged: DocumentId): readonly DocumentId[] {
  return target === dragged ? [target] : [target, dragged];
}

/** Cards between `from` and `to` (inclusive) in tab order, starting at `from`. */
export function rangeBetween(
  order: readonly DocumentId[],
  from: DocumentId,
  to: DocumentId,
): DocumentId[] {
  const a = order.indexOf(from);
  const b = order.indexOf(to);
  if (a < 0 || b < 0) return b < 0 ? [] : [to];
  return a <= b ? order.slice(a, b + 1) : order.slice(b, a + 1).reverse();
}

export interface HomeSelection {
  readonly selection: readonly DocumentId[];
  readonly anchor: DocumentId | null;
}

/**
 * A click on a card: plain selects only it; Mod toggles it; Shift selects the range from
 * the anchor (Shift+Mod adds that range to the selection). The anchor stays on Shift.
 */
export function clickSelection(
  order: readonly DocumentId[],
  current: HomeSelection,
  id: DocumentId,
  modifiers: { readonly shift: boolean; readonly mod: boolean },
): HomeSelection {
  const anchor = current.anchor !== null && order.includes(current.anchor) ? current.anchor : null;
  if (modifiers.shift && anchor !== null) {
    const range = rangeBetween(order, anchor, id);
    const base = modifiers.mod ? liveSelection(order, current.selection) : [];
    return { selection: [...new Set([...base, ...range])], anchor };
  }
  if (modifiers.mod) return toggleSelection(order, current, id);
  return { selection: [id], anchor: id };
}

/** Space, or Mod+click: adds or removes one card; it becomes the anchor. */
export function toggleSelection(
  order: readonly DocumentId[],
  current: HomeSelection,
  id: DocumentId,
): HomeSelection {
  const selected = liveSelection(order, current.selection);
  return selected.includes(id)
    ? { selection: selected.filter((s) => s !== id), anchor: id }
    : { selection: [...selected, id], anchor: id };
}

/** Next focused card for an arrow key in a grid of `columns`; null for other keys. */
export function gridStep(
  index: number,
  key: string,
  count: number,
  columns: number,
): number | null {
  if (count === 0) return null;
  const cols = Math.max(1, columns);
  let next: number;
  switch (key) {
    case 'ArrowLeft':
      next = index - 1;
      break;
    case 'ArrowRight':
      next = index + 1;
      break;
    case 'ArrowUp':
      next = index - cols;
      break;
    case 'ArrowDown':
      next = index + cols;
      break;
    case 'Home':
      next = 0;
      break;
    case 'End':
      next = count - 1;
      break;
    default:
      return null;
  }
  return Math.min(count - 1, Math.max(0, next));
}

/**
 * File size for a card, locale-aware: "812 B", "48 KB", "2.8 MB" (en) / "2,8 MB" (tr).
 * Binary multiples, like the export dialog; one decimal below 100.
 */
export function formatFileSize(bytes: number, locale: string): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  const number = new Intl.NumberFormat(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
  return `${number} ${units[unit] ?? 'B'}`;
}

/**
 * Shortens a long name in the middle so both its start and its end (often a date or a
 * version) stay readable: "Quarterly re…2026-09.pdf". The end keeps the larger half.
 */
export function middleTruncate(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max || max < 5) return text;
  const keep = max - 1;
  const head = Math.floor(keep / 2);
  return `${chars.slice(0, head).join('')}…${chars.slice(chars.length - (keep - head)).join('')}`;
}

/**
 * "now", "5 minutes ago", "yesterday", "3 weeks ago" in the active language (Recents).
 * Rounds to the largest unit that fits; a time in the future (a changed clock) reads "now".
 */
export function relativeTime(then: number, now: number, locale: string): string {
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const seconds = Math.max(0, (now - then) / 1000);
  const steps: readonly [Intl.RelativeTimeFormatUnit, number][] = [
    ['minute', 60],
    ['hour', 3600],
    ['day', 86_400],
    ['week', 7 * 86_400],
    ['month', 30 * 86_400],
    ['year', 365 * 86_400],
  ];
  if (seconds < 45) return format.format(0, 'second');
  let unit: Intl.RelativeTimeFormatUnit = 'minute';
  let size = 60;
  for (const [name, length] of steps) {
    if (seconds < length) break;
    unit = name;
    size = length;
  }
  // Whole units passed: 47 hours is "yesterday", 13 days "last week".
  return format.format(-Math.max(1, Math.floor(seconds / size)), unit);
}

/**
 * The Recents Home lists: every entry but those for a file open right now (the card above
 * already stands for it), matched by name and size.
 */
export function visibleRecents<T extends { readonly name: string; readonly size: number }>(
  entries: readonly T[],
  open: readonly { readonly name: string; readonly size: number }[],
): T[] {
  return entries.filter(
    (entry) => !open.some((f) => f.name === entry.name && f.size === entry.size),
  );
}
