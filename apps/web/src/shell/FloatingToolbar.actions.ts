/**
 * The Pages group's Rotate and Delete page (experience-redesign spec §5.1): they act on the
 * selected pages, else on the current page, and their names say which ("Rotate page 3").
 */
import { getActiveDocument, type PageId } from '@pdf-editor/document-model';

import { currentPlatform } from '../commands/shortcuts';
import { m } from '../i18n';
import { useSelectionStore } from '../state/selection-store';
import { useViewStore } from '../state/view-store';
import { useWorkspaceStore } from '../state/workspace-store';
import { announce } from './announcer';

export interface BarPageTargets {
  readonly pages: readonly PageId[];
  /** True when the pages are the selection; false for the current page. */
  readonly selected: boolean;
  /** 1-based position of the current page (when not `selected`). */
  readonly number: number;
}

/** The selected pages of the active document in document order, else its current page. */
export function barPageTargets(): BarPageTargets | null {
  const doc = getActiveDocument(useWorkspaceStore.getState().workspace);
  if (!doc || doc.pages.length === 0) return null;
  const { selected } = useSelectionStore.getState();
  const chosen = doc.pages.filter((p) => selected.has(p.id)).map((p) => p.id);
  if (chosen.length > 0) return { pages: chosen, selected: true, number: 0 };
  const index = Math.min(Math.max(useViewStore.getState().currentPage, 0), doc.pages.length - 1);
  const page = doc.pages[index];
  return page ? { pages: [page.id], selected: false, number: index + 1 } : null;
}

export function rotateLabel(targets: BarPageTargets): string {
  return targets.selected
    ? m.bar_rotate_selected({ count: targets.pages.length })
    : m.bar_rotate_page({ number: targets.number });
}

export function deleteLabel(targets: BarPageTargets): string {
  return targets.selected
    ? m.bar_delete_selected({ count: targets.pages.length })
    : m.bar_delete_page({ number: targets.number });
}

/** Rotates the targets 90° clockwise and says which pages turned. */
export function rotateBarPages(): boolean {
  const targets = barPageTargets();
  if (!targets) return false;
  if (!useWorkspaceStore.getState().rotatePages(targets.pages, 90)) return false;
  announce(
    targets.selected
      ? m.announce_rotated_right({ count: targets.pages.length })
      : m.bar_rotated_page({ number: targets.number }),
  );
  return true;
}

/** Deletes the targets (one undo step) and says which pages went. */
export function deleteBarPages(): boolean {
  const targets = barPageTargets();
  if (!targets) return false;
  if (!useWorkspaceStore.getState().deletePages(targets.pages)) return false;
  const shortcut = currentPlatform === 'mac' ? m.undo_hint_mac() : m.undo_hint_other();
  if (targets.selected) {
    useSelectionStore.getState().apply({ selected: new Set(), anchor: null, focused: null });
    announce(m.announce_deleted({ count: targets.pages.length, shortcut }));
  } else {
    announce(m.bar_deleted_page({ number: targets.number, shortcut }));
  }
  return true;
}
