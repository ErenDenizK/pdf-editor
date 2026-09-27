/**
 * Light-table context menu (spec §4): mirrors the contextual bar, adds the clipboard
 * (cut / copy / paste) and selection helpers: select all from this source, odd / even
 * pages, reverse selection order.
 *
 * Right-clicking an unselected page selects it first (the table does that before the menu
 * opens), so every item acts on the selection.
 */
import { ContextMenu } from '@base-ui/react/context-menu';
import { type DocumentId, findPageLocation, type PageId } from '@pdf-editor/document-model';
import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';

import { commandRegistry } from '../commands/registry';
import { useCommand } from '../commands/use-commands';
import { useSelectionStore } from '../state/selection-store';
import { useUiStore } from '../state/ui-store';
import { useTabItems, useWorkspaceStore } from '../state/workspace-store';
import { Keycaps } from '../ui/Keycaps';
import menuStyles from '../ui/Menu.module.css';
import { movePagesToDocument, selectFromSource, selectParity } from './arrange-actions';
import styles from './ArrangeView.module.css';

function CommandItem({ command, label }: { readonly command: string; readonly label: string }) {
  const registered = useCommand(command);
  const enabled = registered !== undefined && commandRegistry.isEnabled(registered);
  const shortcut = registered?.shortcuts[0];
  return (
    <ContextMenu.Item
      className={menuStyles.item}
      disabled={!enabled}
      onClick={() => void commandRegistry.execute(command)}
    >
      <span className={menuStyles.label}>{label}</span>
      {shortcut ? <Keycaps shortcut={shortcut} tone="quiet" /> : null}
    </ContextMenu.Item>
  );
}

function ActionItem({
  label,
  disabled = false,
  onClick,
}: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly onClick: () => void;
}) {
  return (
    <ContextMenu.Item className={menuStyles.item} disabled={disabled} onClick={onClick}>
      <span className={menuStyles.label}>{label}</span>
    </ContextMenu.Item>
  );
}

const Separator = () => <ContextMenu.Separator className={menuStyles.separator} />;

/**
 * The menu's popup. The light table renders `ContextMenu.Root` with its table element as
 * `ContextMenu.Trigger`, and this next to it.
 */
export function ArrangeContextMenuPopup({
  pageId,
  sectionIds,
}: {
  /** The page under the pointer when the menu opened, if any. */
  readonly pageId: PageId | null;
  readonly sectionIds: readonly DocumentId[];
}) {
  return (
    <ContextMenu.Portal>
      <ContextMenu.Positioner collisionPadding={8}>
        <ContextMenu.Popup className={menuStyles.popup} data-testid="arrange-context-menu">
          <MenuItems pageId={pageId} sectionIds={sectionIds} />
        </ContextMenu.Popup>
      </ContextMenu.Positioner>
    </ContextMenu.Portal>
  );
}

function MenuItems({
  pageId,
  sectionIds,
}: {
  readonly pageId: PageId | null;
  readonly sectionIds: readonly DocumentId[];
}): ReactNode {
  const ws = useWorkspaceStore((s) => s.workspace);
  const hasSelection = useSelectionStore((s) => s.selected.size > 0);
  const tabs = useTabItems();
  const location = pageId === null ? undefined : findPageLocation(ws, pageId);
  const page =
    location === undefined ? undefined : ws.documents[location.document]?.pages[location.index];
  const sectionDoc = location?.document ?? ws.activeDocument;

  return (
    <>
      <CommandItem command="pages.rotateLeft" label="Rotate left" />
      <CommandItem command="pages.rotateRight" label="Rotate right" />
      <CommandItem command="pages.delete" label="Delete" />
      <CommandItem command="pages.duplicate" label="Duplicate" />
      <CommandItem command="pages.extract" label="Extract to new document" />
      <CommandItem command="pages.insertBlank" label="Insert blank page after" />
      <ContextMenu.SubmenuRoot>
        <ContextMenu.SubmenuTrigger className={menuStyles.item} disabled={!hasSelection}>
          <span className={menuStyles.label}>Move to…</span>
          <ChevronRight className={styles.menuSubmenuArrow} aria-hidden="true" />
        </ContextMenu.SubmenuTrigger>
        <ContextMenu.Portal>
          <ContextMenu.Positioner side="right" align="start" sideOffset={4} collisionPadding={8}>
            <ContextMenu.Popup className={menuStyles.popup}>
              {tabs.map((tab) => (
                <ContextMenu.Item
                  key={tab.id}
                  className={menuStyles.item}
                  onClick={() => movePagesToDocument(tab.id)}
                >
                  <span className={styles.sectionTag} data-tag={tab.colorIndex} />
                  <span className={menuStyles.label}>{tab.title}</span>
                </ContextMenu.Item>
              ))}
            </ContextMenu.Popup>
          </ContextMenu.Positioner>
        </ContextMenu.Portal>
      </ContextMenu.SubmenuRoot>
      <Separator />
      <CommandItem command="pages.cut" label="Cut" />
      <CommandItem command="pages.copy" label="Copy" />
      <CommandItem command="pages.paste" label="Paste after" />
      <CommandItem command="pages.pasteDuplicate" label="Paste as duplicate" />
      <Separator />
      <ActionItem
        label="Select all from this source"
        disabled={page?.ref.kind !== 'source'}
        onClick={() => {
          if (pageId !== null) selectFromSource(pageId, sectionIds);
        }}
      />
      <ActionItem
        label="Select odd pages"
        disabled={sectionDoc === undefined}
        onClick={() => {
          if (sectionDoc !== undefined) selectParity(sectionDoc, 'odd');
        }}
      />
      <ActionItem
        label="Select even pages"
        disabled={sectionDoc === undefined}
        onClick={() => {
          if (sectionDoc !== undefined) selectParity(sectionDoc, 'even');
        }}
      />
      <CommandItem command="pages.reverseSelection" label="Reverse selection order" />
      <Separator />
      <ActionItem
        label="Properties"
        onClick={() => useUiStore.setState({ rightPanelOpen: true })}
      />
    </>
  );
}
