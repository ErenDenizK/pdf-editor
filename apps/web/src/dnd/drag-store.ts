/**
 * Transient drag-and-drop state for the light table. Two stores, so that the insertion
 * gap (updated on every `dragover`) never wakes the cells, which only care whether they
 * are part of the drag.
 */
import type { DocumentId, PageId } from '@pdf-editor/document-model';
import { create } from 'zustand';

import type { Gap } from './geometry';

export interface DragSession {
  readonly kind: 'pages' | 'files' | 'tab';
  /** Pages being dragged (kind 'pages'). */
  readonly pageIds: ReadonlySet<PageId>;
}

interface DragSessionState {
  readonly session: DragSession | null;
}

export const useDragSession = create<DragSessionState>()(() => ({ session: null }));

export type DropHighlight =
  /**
   * Insertion gap in a section. `duplicate` while Alt is held (copy on drop); `files` for
   * OS files, which also outline the section.
   */
  | {
      readonly kind: 'gap';
      readonly section: DocumentId;
      readonly gap: Gap;
      readonly duplicate: boolean;
      readonly files: boolean;
    }
  /** Dashed outline around a section (files, tabs, collapsed sections). */
  | { readonly kind: 'section'; readonly section: DocumentId }
  /** Dashed outline around the whole table (files open as new documents). */
  | { readonly kind: 'background' };

interface DropHighlightState {
  readonly highlight: DropHighlight | null;
}

export const useDropHighlight = create<DropHighlightState>()(() => ({ highlight: null }));

function sameHighlight(a: DropHighlight | null, b: DropHighlight | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'background') return true;
  if (a.kind === 'section' && b.kind === 'section') return a.section === b.section;
  if (a.kind === 'gap' && b.kind === 'gap') {
    return (
      a.section === b.section &&
      a.duplicate === b.duplicate &&
      a.files === b.files &&
      a.gap.index === b.gap.index &&
      a.gap.row === b.gap.row &&
      a.gap.column === b.gap.column
    );
  }
  return false;
}

/** Updates the highlight only when it changed (dragover fires continuously). */
export function setDropHighlight(highlight: DropHighlight | null): void {
  if (sameHighlight(useDropHighlight.getState().highlight, highlight)) return;
  useDropHighlight.setState({ highlight });
}

export function setDragSession(session: DragSession | null): void {
  useDragSession.setState({ session });
}
