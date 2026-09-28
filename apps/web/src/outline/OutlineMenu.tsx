/**
 * Context menu of an outline item: opened by right-click, the Menu key or Shift+F10 on
 * the focused item. Lists every edit with its key (keycaps), so the menu also teaches the
 * keyboard scheme. The panel returns focus to the item on close (unless a rename took it).
 */
import { Menu } from '@base-ui/react/menu';
import type { DocumentId, OutlineNode, OutlinePath } from '@pdf-editor/document-model';
import { outlineMoveGap } from '@pdf-editor/document-model';

import { parseShortcut } from '../commands/shortcuts';
import { m } from '../i18n';
import { Keycaps } from '../ui/Keycaps';
import menuStyles from '../ui/Menu.module.css';
import {
  addChildBookmark,
  addSiblingBookmark,
  deleteBookmark,
  displayTitle,
  moveBookmark,
  setDestinationToCurrentView,
  toggleStartExpanded,
} from './outline-actions';
import { keyOf, startRenaming } from './outline-view-store';

export interface OutlineMenuRequest {
  readonly key: string;
  readonly path: OutlinePath;
  readonly node: OutlineNode;
  /** Pointer position (right-click), or undefined to anchor at the item (keyboard). */
  readonly point?: { readonly x: number; readonly y: number };
  readonly element: HTMLElement;
}

const KEYS = {
  rename: parseShortcut('F2'),
  delete: parseShortcut('Delete'),
  up: parseShortcut('Alt+Up'),
  down: parseShortcut('Alt+Down'),
  indent: parseShortcut('Alt+Right'),
  outdent: parseShortcut('Alt+Left'),
};

function Item({
  label,
  shortcut,
  disabled = false,
  onClick,
}: {
  readonly label: string;
  readonly shortcut?: ReturnType<typeof parseShortcut>;
  readonly disabled?: boolean;
  readonly onClick: () => void;
}) {
  return (
    <Menu.Item className={menuStyles.item} disabled={disabled} onClick={onClick}>
      <span className={menuStyles.label}>{label}</span>
      {shortcut ? <Keycaps shortcut={shortcut} tone="quiet" /> : null}
    </Menu.Item>
  );
}

export function OutlineMenu({
  documentId,
  outline,
  request,
  onClose,
}: {
  readonly documentId: DocumentId;
  readonly outline: readonly OutlineNode[];
  readonly request: OutlineMenuRequest | null;
  readonly onClose: () => void;
}) {
  const path = request?.path ?? [];
  const node = request?.node;
  const canMove = (direction: Parameters<typeof outlineMoveGap>[2]) =>
    request !== null && outlineMoveGap(outline, path, direction) !== undefined;
  const point = request?.point;
  const anchor =
    request === null
      ? null
      : point === undefined
        ? request.element
        : {
            getBoundingClientRect: () =>
              DOMRect.fromRect({ x: point.x, y: point.y, width: 0, height: 0 }),
          };

  return (
    <Menu.Root
      open={request !== null}
      modal={false}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Menu.Portal>
        <Menu.Positioner
          anchor={anchor}
          side={point === undefined ? 'bottom' : 'right'}
          align="start"
          sideOffset={point === undefined ? 2 : 0}
          collisionPadding={8}
        >
          <Menu.Popup
            className={menuStyles.popup}
            aria-label={node ? m.outline_menu_label({ title: displayTitle(node) }) : undefined}
            data-testid="outline-menu"
            // The panel puts focus back on the (possibly moved) item itself.
            finalFocus={false}
          >
            <Item
              label={m.outline_add_child()}
              onClick={() => addChildBookmark(documentId, path)}
            />
            <Item
              label={m.outline_add_sibling()}
              onClick={() => addSiblingBookmark(documentId, path)}
            />
            <Menu.Separator className={menuStyles.separator} />
            <Item
              label={m.outline_rename()}
              shortcut={KEYS.rename}
              onClick={() => startRenaming(documentId, keyOf(path))}
            />
            <Item
              label={m.outline_set_destination()}
              onClick={() => setDestinationToCurrentView(documentId, path)}
            />
            <Menu.CheckboxItem
              className={menuStyles.item}
              checked={node?.open ?? false}
              disabled={(node?.children.length ?? 0) === 0}
              onCheckedChange={() => toggleStartExpanded(documentId, path)}
            >
              <span className={menuStyles.check} aria-hidden="true" />
              <span className={menuStyles.label}>{m.outline_start_expanded()}</span>
            </Menu.CheckboxItem>
            <Menu.Separator className={menuStyles.separator} />
            <Item
              label={m.outline_move_up()}
              shortcut={KEYS.up}
              disabled={!canMove('up')}
              onClick={() => moveBookmark(documentId, path, 'up')}
            />
            <Item
              label={m.outline_move_down()}
              shortcut={KEYS.down}
              disabled={!canMove('down')}
              onClick={() => moveBookmark(documentId, path, 'down')}
            />
            <Item
              label={m.outline_indent()}
              shortcut={KEYS.indent}
              disabled={!canMove('indent')}
              onClick={() => moveBookmark(documentId, path, 'indent')}
            />
            <Item
              label={m.outline_outdent()}
              shortcut={KEYS.outdent}
              disabled={!canMove('outdent')}
              onClick={() => moveBookmark(documentId, path, 'outdent')}
            />
            <Menu.Separator className={menuStyles.separator} />
            <Item
              label={m.outline_delete()}
              shortcut={KEYS.delete}
              onClick={() => deleteBookmark(documentId, path)}
            />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
