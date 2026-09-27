/**
 * Keyboard map on `?` (DESIGN.md §4.6): every registered command, grouped, with keycaps.
 * Also documents the in-widget keys that are not commands (tabs, tool bar, splitters).
 */
import { Dialog } from '@base-ui/react/dialog';
import { X } from 'lucide-react';
import { useRef } from 'react';

import { groupCommands } from '../commands/registry';
import { type ParsedShortcut, parseShortcut } from '../commands/shortcuts';
import { useCommands } from '../commands/use-commands';
import { useUiStore } from '../state/ui-store';
import { Keycaps } from '../ui/Keycaps';
import styles from './ShortcutOverlay.module.css';

const WIDGET_KEYS: readonly { title: string; keys: readonly ParsedShortcut[] }[] = [
  { title: 'Move between tabs', keys: [parseShortcut('Left'), parseShortcut('Right')] },
  { title: 'Close focused tab', keys: [parseShortcut('Delete')] },
  { title: 'Move between tools', keys: [parseShortcut('Left'), parseShortcut('Right')] },
  { title: 'Resize a focused panel edge', keys: [parseShortcut('Left'), parseShortcut('Right')] },
  { title: 'Move focus between pages', keys: [parseShortcut('Left'), parseShortcut('Down')] },
  {
    title: 'Extend page selection',
    keys: [parseShortcut('Shift+Left'), parseShortcut('Shift+Down')],
  },
  { title: 'Toggle page selection', keys: [parseShortcut('Space')] },
  { title: 'Move pages one row', keys: [parseShortcut('Alt+Up'), parseShortcut('Alt+Down')] },
  { title: 'Open page in Read mode', keys: [parseShortcut('Enter')] },
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
            <Dialog.Title className={styles.title}>Keyboard shortcuts</Dialog.Title>
            <Dialog.Close className={styles.close} aria-label="Close">
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
                  {items.map((command) => (
                    <div key={command.id} className={styles.row}>
                      <dt className={styles.rowTitle}>
                        {command.title.replace(/…$/, '')}
                        {command.note ? <span className={styles.note}>{command.note}</span> : null}
                      </dt>
                      <dd className={styles.keys}>
                        {command.shortcuts.map((shortcut, index) => (
                          <Keycaps key={index} shortcut={shortcut} />
                        ))}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
            <section className={styles.group} aria-labelledby="keys-widgets">
              <h3 id="keys-widgets" className={styles.groupTitle}>
                In focus
              </h3>
              <dl className={styles.rows}>
                {WIDGET_KEYS.map((row) => (
                  <div key={row.title} className={styles.row}>
                    <dt className={styles.rowTitle}>{row.title}</dt>
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
