/**
 * Command palette (Mod+K). Built on the Base UI Dialog (focus trap, Esc, scroll lock,
 * focus return). The list follows the APG combobox + listbox pattern: focus stays in the
 * input and `aria-activedescendant` points at the active option.
 */
import { Dialog } from '@base-ui/react/dialog';
import { Search } from 'lucide-react';
import {
  type KeyboardEvent,
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';

import { fuzzyFilter } from '../commands/fuzzy';
import { type Command, commandRegistry, groupCommands } from '../commands/registry';
import { parseShortcut } from '../commands/shortcuts';
import { useCommands } from '../commands/use-commands';
import { m } from '../i18n';
import { useUiStore } from '../state/ui-store';
import { Keycaps } from '../ui/Keycaps';
import styles from './CommandPalette.module.css';

interface Row {
  readonly command: Command;
  readonly positions: readonly number[];
  readonly enabled: boolean;
}

interface Section {
  readonly group: string;
  readonly rows: Row[];
}

/** Internal id of the recents section; its heading is translated when rendered. */
const RECENT_GROUP = 'Recent';

/** Builds the visible sections: recents first when the query is empty, else by relevance. */
export function buildSections(
  query: string,
  commands: readonly Command[],
  recents: readonly string[],
  isEnabled: (command: Command) => boolean,
): Section[] {
  const visible = commands.filter((c) => !c.hiddenInPalette);
  const toRow = (command: Command, positions: readonly number[] = []): Row => ({
    command,
    positions,
    enabled: isEnabled(command),
  });

  if (query.trim() === '') {
    const recentCommands = recents
      .map((id) => visible.find((c) => c.id === id))
      .filter((c): c is Command => c !== undefined);
    const rest = visible.filter((c) => !recentCommands.includes(c));
    const sections: Section[] = [];
    if (recentCommands.length > 0) {
      sections.push({ group: RECENT_GROUP, rows: recentCommands.map((c) => toRow(c)) });
    }
    for (const { group, items } of groupCommands(rest)) {
      sections.push({ group, rows: items.map((c) => toRow(c)) });
    }
    return sections;
  }

  const ranked = fuzzyFilter(
    query,
    visible,
    (c) => c.title,
    (c) => [...(c.keywords ?? []), c.group],
  );
  // Groups are ordered by their best match; items keep their rank inside a group.
  const grouped = groupCommands(ranked.map((r) => ({ ...r, group: r.item.group })));
  return grouped.map(({ group, items }) => ({
    group,
    rows: items.map((r) => toRow(r.item, r.positions)),
  }));
}

function Highlighted({
  text,
  positions,
}: {
  readonly text: string;
  readonly positions: readonly number[];
}) {
  if (positions.length === 0) return <>{text}</>;
  const set = new Set(positions);
  const parts: { text: string; match: boolean }[] = [];
  for (const [index, char] of text.split('').entries()) {
    const match = set.has(index);
    const last = parts.at(-1);
    if (last?.match === match) last.text += char;
    else parts.push({ text: char, match });
  }
  return (
    <>
      {parts.map((part, index) =>
        part.match ? (
          <mark key={index} className={styles.match}>
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}

const FOOTER_KEYS = {
  navigate: [parseShortcut('Up'), parseShortcut('Down')],
  run: parseShortcut('Enter'),
  close: parseShortcut('Escape'),
};

export function CommandPalette() {
  const open = useUiStore((s) => s.paletteOpen);
  const setOpen = useUiStore((s) => s.setPaletteOpen);
  return (
    <Dialog.Root open={open} onOpenChange={(next) => setOpen(next)}>
      <Dialog.Portal>
        <Dialog.Backdrop className={styles.backdrop} />
        {/* Always rendered: the Portal unmounts it after the exit transition, so every
            open starts with fresh state. Unmounting it early would strand the backdrop. */}
        <PalettePopup
          onClose={() => {
            setOpen(false);
          }}
        />
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function PalettePopup({ onClose }: { readonly onClose: () => void }) {
  const commands = useCommands();
  const recents = useUiStore((s) => s.recents);
  const pushRecent = useUiStore((s) => s.pushRecent);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  // The active option is tracked by command id and derived into an index, so it survives
  // re-ranking and falls back to the first enabled row when filtered out.
  const [activeId, setActiveId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const baseId = useId();

  const sections = useMemo(
    () => buildSections(deferredQuery, commands, recents, (c) => commandRegistry.isEnabled(c)),
    [deferredQuery, commands, recents],
  );
  const rows = useMemo(() => sections.flatMap((s) => s.rows), [sections]);
  const matchedIndex = rows.findIndex((r) => r.command.id === activeId && r.enabled);
  const activeIndex = matchedIndex >= 0 ? matchedIndex : rows.findIndex((r) => r.enabled);
  const active = activeIndex >= 0 ? rows[activeIndex] : undefined;
  const optionId = (commandId: string) => `${baseId}-option-${commandId}`;
  const activeOptionId = active ? optionId(active.command.id) : undefined;

  useEffect(() => {
    if (!activeOptionId) return;
    document.getElementById(activeOptionId)?.scrollIntoView?.({ block: 'nearest' });
  }, [activeOptionId]);

  const run = (row: Row | undefined) => {
    if (!row?.enabled) return;
    pushRecent(row.command.id);
    onClose();
    // Same task as the keydown/click, so pickers keep the user activation they need.
    commandRegistry.execute(row.command.id).catch((error: unknown) => {
      console.error(`Command "${row.command.id}" failed`, error);
    });
  };

  const move = (delta: 1 | -1) => {
    if (rows.length === 0) return;
    let next = activeIndex;
    let remaining = rows.length;
    do {
      next = (next + delta + rows.length) % rows.length;
      remaining -= 1;
    } while (remaining > 0 && !rows[next]?.enabled);
    setActiveId(rows[next]?.command.id ?? null);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      move(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      move(-1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      run(active);
    }
  };

  const listboxId = `${baseId}-listbox`;

  return (
    <Dialog.Popup className={styles.popup} initialFocus={inputRef}>
      <Dialog.Title className="visually-hidden">{m.palette_title()}</Dialog.Title>
      <div className={styles.searchRow}>
        <Search className={styles.searchIcon} aria-hidden="true" />
        <input
          ref={inputRef}
          className={styles.input}
          type="text"
          role="combobox"
          aria-label={m.search_commands()}
          aria-expanded="true"
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={activeOptionId}
          placeholder={m.search_commands_placeholder()}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveId(null);
          }}
          onKeyDown={onKeyDown}
        />
      </div>

      <div
        id={listboxId}
        role="listbox"
        aria-label={m.palette_commands_label()}
        className={styles.list}
      >
        {rows.length === 0 ? (
          <p className={styles.empty} role="presentation">
            {m.palette_no_match({ query: query.trim() })}
          </p>
        ) : null}
        {sections.map((section) => {
          const headingId = `${baseId}-group-${section.group}`;
          return (
            <div
              key={section.group}
              role="group"
              aria-labelledby={headingId}
              className={styles.group}
            >
              <div id={headingId} role="presentation" className={styles.groupLabel}>
                {section.group === RECENT_GROUP ? m.palette_recent() : section.group}
              </div>
              {section.rows.map((row) => {
                const shortcut = row.command.shortcuts[0];
                const selected = row === active;
                return (
                  // Options are driven from the combobox input via aria-activedescendant
                  // (APG); they take pointer input only and are never focused themselves.
                  // eslint-disable-next-line jsx-a11y/click-events-have-key-events
                  <div
                    key={row.command.id}
                    id={optionId(row.command.id)}
                    role="option"
                    tabIndex={-1}
                    aria-selected={selected}
                    aria-disabled={!row.enabled || undefined}
                    className={styles.option}
                    onPointerMove={() => {
                      if (row.enabled && !selected) setActiveId(row.command.id);
                    }}
                    onPointerDown={(event) => {
                      event.preventDefault();
                    }}
                    onClick={() => {
                      run(row);
                    }}
                  >
                    <span className={styles.title}>
                      <Highlighted text={row.command.title} positions={row.positions} />
                    </span>
                    {section.group === RECENT_GROUP ? (
                      <span className={styles.groupHint}>{row.command.group}</span>
                    ) : null}
                    {shortcut ? <Keycaps shortcut={shortcut} /> : null}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      <div className={styles.footer} aria-hidden="true">
        <span className={styles.footerItem}>
          {FOOTER_KEYS.navigate.map((key) => (
            <Keycaps key={key.key} shortcut={key} />
          ))}
          {m.palette_navigate()}
        </span>
        <span className={styles.footerItem}>
          <Keycaps shortcut={FOOTER_KEYS.run} />
          {m.palette_run()}
        </span>
        <span className={styles.footerItem}>
          <Keycaps shortcut={FOOTER_KEYS.close} />
          {m.common_close()}
        </span>
      </div>
    </Dialog.Popup>
  );
}
