/**
 * Page cells as drag sources (spec §3), on @atlaskit/pragmatic-drag-and-drop.
 *
 * Dragging a selected page drags the whole selection; dragging an unselected page selects
 * it first and drags it alone. The native drag preview is built with plain DOM (no React
 * root) so drag start stays well under the 50 ms budget: a copy of the first thumbnail's
 * canvas, stacked sheets and a count badge when more than one page moves, scaled to 0.96
 * and at 0.9 opacity (no scaling with reduced motion).
 */
import { draggable } from '@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter';
import { preserveOffsetOnSource } from '@atlaskit/pragmatic-drag-and-drop/utils/preserve-offset-on-source';
import { setCustomNativeDragPreview } from '@atlaskit/pragmatic-drag-and-drop/utils/set-custom-native-drag-preview';
import type { DocumentId, PageId } from '@pdf-editor/document-model';

import { targetPages } from '../commands/app-commands';
import { useSelectionStore } from '../state/selection-store';
import styles from './dnd.module.css';

/** Data attached to a page drag. */
export interface PageDragData {
  readonly type: 'pages';
  readonly pageIds: readonly PageId[];
  [key: string | symbol]: unknown;
}

/** Data attached to a tab drag (pins the document into the light table). */
export interface TabDragData {
  readonly type: 'tab';
  readonly documentId: DocumentId;
  [key: string | symbol]: unknown;
}

export function isPageDrag(data: Record<string | symbol, unknown>): data is PageDragData {
  return data.type === 'pages' && Array.isArray(data.pageIds);
}

export function isTabDrag(data: Record<string | symbol, unknown>): data is TabDragData {
  return data.type === 'tab' && typeof data.documentId === 'string';
}

/** The pages a drag starting on `pageId` carries; selects it when it was not selected. */
export function pagesForDrag(pageId: PageId): PageId[] {
  const { selected } = useSelectionStore.getState();
  if (selected.has(pageId)) return targetPages();
  useSelectionStore
    .getState()
    .apply({ selected: new Set([pageId]), anchor: pageId, focused: pageId });
  return [pageId];
}

function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Builds the preview into `container`: first thumbnail, stack and count badge. */
export function renderDragPreview(
  container: HTMLElement,
  thumb: HTMLElement | null,
  count: number,
): void {
  const rect = thumb?.getBoundingClientRect();
  const width = Math.max(24, Math.round(rect?.width ?? 96));
  const height = Math.max(24, Math.round(rect?.height ?? 124));
  const root = document.createElement('div');
  root.className = styles.preview ?? '';
  if (prefersReducedMotion()) root.dataset.still = 'true';
  root.style.width = `${width}px`;
  root.style.height = `${height}px`;
  if (count > 1) {
    for (const depth of count > 2 ? [2, 1] : [1]) {
      const sheet = document.createElement('div');
      sheet.className = styles.previewSheet ?? '';
      sheet.style.transform = `translate(${depth * 4}px, ${depth * 4}px)`;
      root.append(sheet);
    }
  }
  const face = document.createElement('div');
  face.className = styles.previewFace ?? '';
  const source = thumb?.querySelector('canvas');
  if (source && source.width > 0 && source.height > 0) {
    const copy = document.createElement('canvas');
    copy.width = source.width;
    copy.height = source.height;
    copy.getContext('2d')?.drawImage(source, 0, 0);
    face.append(copy);
  }
  root.append(face);
  if (count > 1) {
    const badge = document.createElement('span');
    badge.className = styles.previewBadge ?? '';
    badge.textContent = String(count);
    root.append(badge);
  }
  container.append(root);
}

/**
 * Makes a cell draggable. `thumb` is the page sheet inside the cell; the grab offset is
 * preserved relative to it.
 */
export function attachPageDrag(cell: HTMLElement, pageId: PageId): () => void {
  return draggable({
    element: cell,
    getInitialData: (): PageDragData => {
      performance.mark('light-table:drag-start');
      return { type: 'pages', pageIds: pagesForDrag(pageId) };
    },
    onGenerateDragPreview: ({ nativeSetDragImage, location, source }) => {
      const thumb = cell.querySelector<HTMLElement>('[data-thumb]');
      const count = isPageDrag(source.data) ? source.data.pageIds.length : 1;
      const render = ({ container }: { container: HTMLElement }) => {
        renderDragPreview(container, thumb, count);
      };
      setCustomNativeDragPreview(
        thumb
          ? {
              nativeSetDragImage,
              getOffset: preserveOffsetOnSource({ element: thumb, input: location.current.input }),
              render,
            }
          : { nativeSetDragImage, render },
      );
    },
  });
}
