/**
 * Light-table affordances on a document tab (spec §1): the tab can be dragged onto the
 * table to show the document as a section, and its context menu has "Show in Arrange".
 * Wraps the tab's element (the context-menu trigger renders it).
 */
import { draggable } from '@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter';
import { ContextMenu } from '@base-ui/react/context-menu';
import type { DocumentId } from '@pdf-editor/document-model';
import { type ReactElement, useCallback } from 'react';

import { showInArrange } from '../dnd/drop';
import type { TabDragData } from '../dnd/page-drag';
import { announce } from '../shell/announcer';
import { useUiStore } from '../state/ui-store';
import { useWorkspaceStore } from '../state/workspace-store';
import menuStyles from '../ui/Menu.module.css';

export function TabArrangeMenu({
  documentId,
  title,
  children,
}: {
  readonly documentId: DocumentId;
  readonly title: string;
  readonly children: ReactElement;
}) {
  const pinned = useUiStore((s) => s.arrangePinned.includes(documentId));
  const dragRef = useCallback(
    (element: HTMLElement | null) => {
      if (element === null) return;
      return draggable({
        element,
        getInitialData: (): TabDragData => ({ type: 'tab', documentId }),
      });
    },
    [documentId],
  );

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger ref={dragRef} render={children} />
      <ContextMenu.Portal>
        <ContextMenu.Positioner collisionPadding={8}>
          <ContextMenu.Popup className={menuStyles.popup}>
            <ContextMenu.Item
              className={menuStyles.item}
              onClick={() => {
                showInArrange(documentId);
                useUiStore.getState().setViewMode('arrange');
              }}
            >
              <span className={menuStyles.label}>Show in Arrange</span>
            </ContextMenu.Item>
            {pinned ? (
              <ContextMenu.Item
                className={menuStyles.item}
                onClick={() => {
                  useUiStore.getState().unpinFromArrange(documentId);
                  announce(`${title} removed from Arrange`);
                }}
              >
                <span className={menuStyles.label}>Remove from Arrange</span>
              </ContextMenu.Item>
            ) : null}
            <ContextMenu.Separator className={menuStyles.separator} />
            <ContextMenu.Item
              className={menuStyles.item}
              onClick={() => {
                useWorkspaceStore.getState().closeDocument(documentId);
                useUiStore.getState().unpinFromArrange(documentId);
                announce(`Closed ${title}`);
              }}
            >
              <span className={menuStyles.label}>Close tab</span>
            </ContextMenu.Item>
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
