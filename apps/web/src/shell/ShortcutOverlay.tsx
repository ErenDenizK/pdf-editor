/**
 * Keyboard map on `?` (DESIGN.md §4.6): every registered command, grouped, with keycaps.
 * A tool, and every other command the tool bar holds, also names its tool bar group
 * ("Tool bar: Draw", experience-redesign spec §5.1). Also documents the in-widget keys that
 * are not commands (tabs, tool bar, splitters).
 */
import { Dialog } from '@base-ui/react/dialog';
import { X } from 'lucide-react';
import { useRef } from 'react';

import { groupCommands } from '../commands/registry';
import { type ParsedShortcut, parseShortcut } from '../commands/shortcuts';
import { useCommands } from '../commands/use-commands';
import { m } from '../i18n';
import { useUiStore } from '../state/ui-store';
import { Keycaps } from '../ui/Keycaps';
import { barGroupLabelOfCommand } from './FloatingToolbar.groups';
import styles from './ShortcutOverlay.module.css';

/** In-widget keys; `title` is a message function so it follows the active language. */
const WIDGET_KEYS: readonly { title: () => string; keys: readonly ParsedShortcut[] }[] = [
  { title: m.shortcuts_move_tabs, keys: [parseShortcut('Left'), parseShortcut('Right')] },
  { title: m.shortcuts_close_tab, keys: [parseShortcut('Delete')] },
  { title: m.shortcuts_move_tools, keys: [parseShortcut('Left'), parseShortcut('Right')] },
  { title: m.bar_shortcut_back, keys: [parseShortcut('Escape')] },
  { title: m.shortcuts_resize_panel, keys: [parseShortcut('Left'), parseShortcut('Right')] },
  { title: m.shortcuts_move_focus_pages, keys: [parseShortcut('Left'), parseShortcut('Down')] },
  {
    title: m.shortcuts_extend_selection,
    keys: [parseShortcut('Shift+Left'), parseShortcut('Shift+Down')],
  },
  { title: m.shortcuts_toggle_selection, keys: [parseShortcut('Space')] },
  { title: m.shortcuts_move_row, keys: [parseShortcut('Alt+Up'), parseShortcut('Alt+Down')] },
  { title: m.shortcuts_open_in_read, keys: [parseShortcut('Enter')] },
  { title: m.shortcuts_outline_expand, keys: [parseShortcut('Left'), parseShortcut('Right')] },
  { title: m.shortcuts_outline_rename, keys: [parseShortcut('F2')] },
  {
    title: m.shortcuts_outline_move,
    keys: [
      parseShortcut('Alt+Up'),
      parseShortcut('Alt+Down'),
      parseShortcut('Alt+Left'),
      parseShortcut('Alt+Right'),
    ],
  },
];

export function ShortcutOverlay() {
  const open = useUiStore((s) => s.shortcutsOpen);
  const setOpen = useUiStore((s) => s.setShortcutsOpen);
  const commands = useCommands();
  const groups = groupCommands(commands);
  // Focus the surface, not the close button, so no ring flashes on open; Esc closes.
  const popupRef = useRef<HTMLDivElement>(null);

  return (
    <Dialog.Root open={open} onOpenChange={(next) => setOpen(next)}>
      <Dialog.Portal>
        <Dialog.Backdrop className={styles.backdrop} />
        <Dialog.Popup className={styles.popup} initialFocus={popupRef} ref={popupRef}>
          <div className={styles.header}>
            <Dialog.Title className={styles.title}>{m.keyboard_shortcuts()}</Dialog.Title>
            <Dialog.Close className={styles.close} aria-label={m.common_close()}>
              <X aria-hidden="true" />
            </Dialog.Close>
          </div>
          <div className={styles.body}>
            {groups.map(({ group, items }) => (
              <section key={group} className={styles.group} aria-labelledby={`keys-${group}`}>
                <h3 id={`keys-${group}`} className={styles.groupTitle}>
                  {group}
                </h3>
                <dl className={styles.rows}>
                  {items.map((command) => {
                    const barGroup = barGroupLabelOfCommand(command.id);
                    return (
                      <div key={command.id} className={styles.row}>
                        <dt className={styles.rowTitle}>
                          {command.title.replace(/…$/, '')}
                          {barGroup ? (
                            <span className={styles.note} data-bar-group-note="">
                              {m.bar_in_group({ group: barGroup })}
                            </span>
                          ) : null}
                          {command.note ? (
                            <span className={styles.note}>{command.note}</span>
                          ) : null}
                        </dt>
                        <dd className={styles.keys}>
                          {command.shortcuts.map((shortcut, index) => (
                            <Keycaps key={index} shortcut={shortcut} />
                          ))}
                        </dd>
                      </div>
                    );
                  })}
                </dl>
              </section>
            ))}
            <section className={styles.group} aria-labelledby="keys-widgets">
              <h3 id="keys-widgets" className={styles.groupTitle}>
                {m.shortcuts_in_focus()}
              </h3>
              <dl className={styles.rows}>
                {WIDGET_KEYS.map((row) => (
                  <div key={row.title()} className={styles.row}>
                    <dt className={styles.rowTitle}>{row.title()}</dt>
                    <dd className={styles.keys}>
                      {row.keys.map((shortcut, index) => (
                        <Keycaps key={index} shortcut={shortcut} />
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
