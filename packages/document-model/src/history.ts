/**
 * Undo/redo as a persistent stack of workspace snapshots. Snapshots share structure, so
 * keeping many is cheap. Content edits join the same stack through Workspace.engineEdits.
 */
import { DocumentModelError } from './errors';
import type { History, HistoryEntry, Workspace } from './types';

export const DEFAULT_COALESCE_WINDOW_MS = 800;
export const DEFAULT_HISTORY_LIMIT = 200;

export function createHistory(initial: Workspace, label = 'Open', at = 0): History {
  return { past: [], present: { label, at, workspace: initial }, future: [] };
}

export interface PushOptions {
  /** Pushes with the same key within the window replace `present` (drags, sliders). */
  readonly coalesceKey?: string;
  /** Timestamp in ms; defaults to Date.now(). Inject for deterministic tests. */
  readonly now?: number;
  readonly coalesceWindowMs?: number;
  /** Maximum number of undo steps kept. */
  readonly limit?: number;
}

/**
 * Records a new state. Pushing the workspace that is already present is a no-op, so
 * operations that return their input do not create empty undo steps. Any redo branch is
 * discarded.
 */
export function pushHistory(
  history: History,
  workspace: Workspace,
  label: string,
  options: PushOptions = {},
): History {
  if (workspace === history.present.workspace) return history;
  const now = options.now ?? Date.now();
  const windowMs = options.coalesceWindowMs ?? DEFAULT_COALESCE_WINDOW_MS;
  const limit = options.limit ?? DEFAULT_HISTORY_LIMIT;
  if (!Number.isInteger(limit) || limit < 0) {
    throw new DocumentModelError(
      'invalid-argument',
      'History limit must be a non-negative integer',
    );
  }
  const entry: HistoryEntry =
    options.coalesceKey === undefined
      ? { label, at: now, workspace }
      : { label, at: now, workspace, coalesceKey: options.coalesceKey };

  const { present } = history;
  const coalesce =
    options.coalesceKey !== undefined &&
    present.coalesceKey === options.coalesceKey &&
    history.future.length === 0 &&
    now - present.at >= 0 &&
    now - present.at <= windowMs;
  if (coalesce) return { past: history.past, present: entry, future: [] };

  const past = [...history.past, present];
  return {
    past: past.length > limit ? past.slice(past.length - limit) : past,
    present: entry,
    future: [],
  };
}

export function canUndo(history: History): boolean {
  return history.past.length > 0;
}

export function canRedo(history: History): boolean {
  return history.future.length > 0;
}

export function undo(history: History): History {
  const previous = history.past[history.past.length - 1];
  if (previous === undefined) return history;
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
  };
}

export function redo(history: History): History {
  const [next, ...rest] = history.future;
  if (next === undefined) return history;
  return { past: [...history.past, history.present], present: next, future: rest };
}

/** Jumps to entry `index` of `historyEntries(history)` (0 = oldest). */
export function jumpTo(history: History, index: number): History {
  const all = [...history.past, history.present, ...history.future];
  const target = all[index];
  if (!Number.isInteger(index) || target === undefined) {
    throw new DocumentModelError(
      'invalid-index',
      `History index ${index} outside 0…${all.length - 1}`,
    );
  }
  if (index === history.past.length) return history;
  return { past: all.slice(0, index), present: target, future: all.slice(index + 1) };
}

export interface HistoryListItem {
  readonly index: number;
  readonly label: string;
  readonly at: number;
  readonly state: 'past' | 'present' | 'future';
}

/** Flat list for a history panel, oldest first. */
export function historyEntries(history: History): HistoryListItem[] {
  const items: HistoryListItem[] = [];
  const add = (entry: HistoryEntry, state: HistoryListItem['state']): void => {
    items.push({ index: items.length, label: entry.label, at: entry.at, state });
  };
  for (const entry of history.past) add(entry, 'past');
  add(history.present, 'present');
  for (const entry of history.future) add(entry, 'future');
  return items;
}

export function currentWorkspace(history: History): Workspace {
  return history.present.workspace;
}
