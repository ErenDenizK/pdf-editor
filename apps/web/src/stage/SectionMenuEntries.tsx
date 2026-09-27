/**
 * The section-operation items (spec §5) rendered inside a menu: the light-table section
 * menu and the tab context menu share them. Disabled items say why next to the label;
 * items with a submenu (Merge into…) list their targets.
 */
import { Menu } from '@base-ui/react/menu';
import type { DocumentId } from '@pdf-editor/document-model';
import { ChevronRight } from 'lucide-react';
import { useSyncExternalStore } from 'react';

import { useCommands } from '../commands/use-commands';
import { useWorkspaceStore } from '../state/workspace-store';
import menuStyles from '../ui/Menu.module.css';
import {
  resolveSectionItem,
  runSectionCommand,
  type SectionMenuItem,
  type SectionMenuOrigin,
  sectionMenuItems,
  subscribeSectionMenu,
} from './section-menu';

export function SectionMenuEntries({
  documentId,
  origin = 'section',
  groups = ['pages', 'document'],
  separators = true,
}: {
  readonly documentId: DocumentId;
  /** Which menu this is; e.g. Rename edits the title where the menu was opened. */
  readonly origin?: SectionMenuOrigin;
  readonly groups?: readonly SectionMenuItem['group'][];
  /** Draw a separator before each group. */
  readonly separators?: boolean;
}) {
  const items = useSyncExternalStore(subscribeSectionMenu, sectionMenuItems);
  // Re-render when commands register or the workspace changes (enablement, targets).
  useCommands();
  useWorkspaceStore((s) => s.workspace);

  return (
    <>
      {groups.map((group) => (
        <Menu.Group key={group}>
          {separators ? <Menu.Separator className={menuStyles.separator} /> : null}
          {items
            .filter((item) => item.group === group)
            .map((item) => {
              const resolved = resolveSectionItem(item, documentId);
              if (resolved.submenu !== undefined && resolved.enabled) {
                return (
                  <Menu.SubmenuRoot key={item.command}>
                    <Menu.SubmenuTrigger className={menuStyles.item}>
                      <span className={menuStyles.label}>{resolved.label}</span>
                      <ChevronRight className={menuStyles.submenuArrow} aria-hidden="true" />
                    </Menu.SubmenuTrigger>
                    <Menu.Portal>
                      <Menu.Positioner
                        side="right"
                        align="start"
                        sideOffset={4}
                        collisionPadding={8}
                      >
                        <Menu.Popup className={menuStyles.popup}>
                          {resolved.submenu.map((entry) => (
                            <Menu.Item
                              key={entry.key}
                              className={menuStyles.item}
                              onClick={entry.run}
                            >
                              {entry.colorIndex === undefined ? null : (
                                <span
                                  className={menuStyles.tag}
                                  data-tag={entry.colorIndex}
                                  aria-hidden="true"
                                />
                              )}
                              <span className={menuStyles.label}>{entry.label}</span>
                            </Menu.Item>
                          ))}
                        </Menu.Popup>
                      </Menu.Positioner>
                    </Menu.Portal>
                  </Menu.SubmenuRoot>
                );
              }
              return (
                <Menu.Item
                  key={item.command}
                  className={menuStyles.item}
                  disabled={!resolved.enabled}
                  onClick={() =>
                    void runSectionCommand(item.command, documentId, undefined, origin)
                  }
                >
                  <span className={menuStyles.label}>{resolved.label}</span>
                  {resolved.hint ? <span className={menuStyles.hint}>{resolved.hint}</span> : null}
                </Menu.Item>
              );
            })}
        </Menu.Group>
      ))}
    </>
  );
}
