/**
 * Home's empty variant (experience-redesign §3): the same view with no cards, a drop
 * target and three shortcuts (DESIGN.md §4.5). No marketing, no tips, no sample files. The
 * whole stage accepts drops; this card is the visible target. `home/HomeView` renders it.
 */
import { commandRegistry } from '../commands/registry';
import { currentPlatform, toAriaKeyShortcut } from '../commands/shortcuts';
import { useCommand } from '../commands/use-commands';
import { m } from '../i18n';
import { Keycaps } from '../ui/Keycaps';
import { AppGlyph } from './AppGlyph';
import styles from './EmptyState.module.css';

const HINTS = [
  { id: 'file.open', label: m.open_files },
  { id: 'view.palette', label: m.search_commands },
  { id: 'help.shortcuts', label: m.keyboard_shortcuts },
] as const;

export function EmptyState({ dragging }: { readonly dragging: boolean }) {
  return (
    <div className={styles.wrap}>
      <div className={styles.card} data-dragging={dragging || undefined}>
        <div className={styles.target}>
          <span className={styles.glyph}>
            <AppGlyph size={24} />
          </span>
          <h1 className={styles.title}>{dragging ? m.empty_title_dragging() : m.empty_title()}</h1>
          <p className={styles.body}>
            {m.empty_body_local()}
            <br />
            {m.empty_body_combine()}
          </p>
        </div>
        <ul className={styles.hints} aria-label={m.empty_hints_label()}>
          {HINTS.map((hint) => (
            <HintRow key={hint.id} id={hint.id} label={hint.label()} />
          ))}
        </ul>
      </div>
    </div>
  );
}

function HintRow({ id, label }: { readonly id: string; readonly label: string }) {
  const command = useCommand(id);
  const shortcut = command?.shortcuts[0];
  return (
    <li>
      <button
        type="button"
        className={styles.hint}
        aria-keyshortcuts={shortcut ? toAriaKeyShortcut(shortcut, currentPlatform) : undefined}
        onClick={() => void commandRegistry.execute(id)}
      >
        <span>{label}</span>
        {shortcut ? <Keycaps shortcut={shortcut} /> : null}
      </button>
    </li>
  );
}
