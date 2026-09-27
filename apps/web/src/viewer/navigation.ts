/**
 * Page navigation helpers: relative and absolute page moves (composing while a scroll is in
 * flight), go-to input parsing (numbers and page labels) and the remembered reading
 * position per document fingerprint.
 */
import {
  effectiveLabel,
  getActiveDocument,
  type VirtualDocument,
  type Workspace,
} from '@pdf-editor/document-model';

import { readJson, writeJson } from '../state/safe-storage';
import { useViewStore } from '../state/view-store';
import { useWorkspaceStore } from '../state/workspace-store';

// ---------------------------------------------------------------------------
// Moving between pages
// ---------------------------------------------------------------------------

const activeDocument = () => getActiveDocument(useWorkspaceStore.getState().workspace);

/**
 * The page relative moves start from: where a programmatic scroll in flight is heading
 * (`navTarget`, cleared by ReadView when the scroll settles or the user scrolls), else the
 * page in view. Two quick presses of `[` therefore compose even before the first scroll has
 * produced a scroll event (Firefox, WebKit).
 */
export function navigationBase(): number {
  const { navTarget, currentPage } = useViewStore.getState();
  return navTarget ?? currentPage;
}

/**
 * Scrolls to page `index` (clamped) and records it as the navigation target. Returns the
 * index targeted, or undefined without pages.
 */
export function goToPageIndex(
  index: number,
  doc: VirtualDocument | undefined = activeDocument(),
): number | undefined {
  if (!doc || doc.pages.length === 0) return undefined;
  const target = Math.min(doc.pages.length - 1, Math.max(0, Math.trunc(index)));
  const page = doc.pages[target];
  if (!page) return undefined;
  const view = useViewStore.getState();
  view.setNavTarget(target);
  view.scrollToPage(page.id);
  return target;
}

/** Next (+1) or previous (-1) page, or spread in two-up, from `navigationBase()`. */
export function stepPage(
  direction: 1 | -1,
  doc: VirtualDocument | undefined = activeDocument(),
): number | undefined {
  const { layout } = useViewStore.getState();
  const base = navigationBase();
  const step = layout === 'two-up' ? 2 : 1;
  const start = layout === 'two-up' ? base - (base % 2) : base;
  return goToPageIndex(start + direction * step, doc);
}

export function previousPage(doc?: VirtualDocument): number | undefined {
  return stepPage(-1, doc);
}

export function nextPage(doc?: VirtualDocument): number | undefined {
  return stepPage(1, doc);
}

// ---------------------------------------------------------------------------
// Go to page
// ---------------------------------------------------------------------------

export type GoToTarget =
  | { readonly kind: 'page'; readonly index: number; readonly via: 'label' | 'number' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'empty' };

/**
 * Resolves what the user typed in "Go to page" against the document's effective labels.
 *
 * - An exact label wins ("iv", "A-1", and "1" when the body is labelled 1, 2, …), then a
 *   case-insensitive label match.
 * - Otherwise a positive integer is the physical page number.
 * - A leading `#` forces the physical number ("#1" is always the first sheet).
 */
export function parseGoTo(input: string, labels: readonly string[]): GoToTarget {
  const text = input.trim();
  if (text === '') return { kind: 'empty' };
  const count = labels.length;
  const physical = (raw: string): GoToTarget => {
    if (!/^\d+$/.test(raw)) return { kind: 'invalid' };
    const n = Number(raw);
    return n >= 1 && n <= count
      ? { kind: 'page', index: n - 1, via: 'number' }
      : { kind: 'invalid' };
  };
  if (text.startsWith('#')) return physical(text.slice(1).trim());
  const exact = labels.indexOf(text);
  if (exact >= 0) return { kind: 'page', index: exact, via: 'label' };
  const lower = text.toLocaleLowerCase();
  const loose = labels.findIndex((label) => label.toLocaleLowerCase() === lower);
  if (loose >= 0) return { kind: 'page', index: loose, via: 'label' };
  return physical(text);
}

/** Effective label of every page (model rules: explicit ranges, authored, position). */
export function documentLabels(ws: Workspace, doc: VirtualDocument): string[] {
  return doc.pages.map((_, index) => {
    try {
      return effectiveLabel(ws, doc, index);
    } catch {
      return String(index + 1);
    }
  });
}

/** True when some label differs from the plain page number (show labels in the UI). */
export function hasCustomLabels(labels: readonly string[]): boolean {
  return labels.some((label, i) => label !== String(i + 1));
}

// ---------------------------------------------------------------------------
// Remembered position
// ---------------------------------------------------------------------------

const POSITIONS_KEY = 'pdf-editor:viewer:positions:v1';
const MAX_POSITIONS = 50;

interface StoredPosition {
  readonly page: number;
  readonly at: number;
}

/** Identity of a document's content across sessions: its sources' fingerprints. */
export function documentFingerprint(ws: Workspace, doc: VirtualDocument): string | undefined {
  const prints = new Set<string>();
  for (const page of doc.pages) {
    if (page.ref.kind !== 'source') continue;
    const print = ws.sources[page.ref.source]?.fingerprint;
    if (print) prints.add(print);
  }
  if (prints.size === 0) return undefined;
  return [...prints].sort().join('+');
}

function readPositions(): Record<string, StoredPosition> {
  const raw = readJson(POSITIONS_KEY);
  if (typeof raw !== 'object' || raw === null) return {};
  const out: Record<string, StoredPosition> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const v = value as Partial<StoredPosition> | null;
    if (
      v &&
      typeof v.page === 'number' &&
      Number.isInteger(v.page) &&
      v.page >= 0 &&
      typeof v.at === 'number'
    ) {
      out[key] = { page: v.page, at: v.at };
    }
  }
  return out;
}

/** The last page index read in a document with this fingerprint, if remembered. */
export function recallPosition(fingerprint: string): number | undefined {
  return readPositions()[fingerprint]?.page;
}

/** Remembers the page (keeps the most recent MAX_POSITIONS documents). */
export function rememberPosition(fingerprint: string, page: number, now = Date.now()): void {
  const positions = readPositions();
  if (positions[fingerprint]?.page === page) return;
  positions[fingerprint] = { page, at: now };
  const kept = Object.entries(positions)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, MAX_POSITIONS);
  writeJson(POSITIONS_KEY, Object.fromEntries(kept));
}
