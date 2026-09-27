/**
 * Light-table affordances on a document tab (spec §1, §5): the tab can be dragged onto the
 * table to show the document as a section, and its context menu has "Show in Arrange" and
 * the section operations (Reverse, Interleave, Split, Merge into, Insert images, Rename,
 * Close) with the same enablement and hints as the section menu.
 * Wraps the tab's element (the context-menu trigger renders it).
 */
import { draggable } from '@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter';
import { ContextMenu } from '@base-ui/react/context-menu';
import type { DocumentId } from '@pdf-editor/document-model';
import { type ReactElement, useCallback } from 'react';

import { showInArrange } from '../dnd/drop';
import type { TabDragData } from '../dnd/page-drag';
import { m } from '../i18n';
import { announce } from '../shell/announcer';
import { useUiStore } from '../state/ui-store';
import menuStyles from '../ui/Menu.module.css';
import { SectionMenuEntries } from './SectionMenuEntries';

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
        // No drag while the title is being edited: the pointer selects text instead.
        canDrag: () => useUiStore.getState().renaming?.documentId !== documentId,
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
          <ContextMenu.Popup className={menuStyles.popup} data-testid="tab-menu">
            <ContextMenu.Item
              className={menuStyles.item}
              onClick={() => {
                showInArrange(documentId);
                useUiStore.getState().setViewMode('arrange');
              }}
            >
              <span className={menuStyles.label}>{m.arrange_show()}</span>
            </ContextMenu.Item>
            {pinned ? (
              <ContextMenu.Item
                className={menuStyles.item}
                onClick={() => {
                  useUiStore.getState().unpinFromArrange(documentId);
                  announce(m.announce_removed_from_arrange({ title }));
                }}
              >
                <span className={menuStyles.label}>{m.arrange_remove()}</span>
              </ContextMenu.Item>
            ) : null}
            <SectionMenuEntries documentId={documentId} origin="tab" />
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
