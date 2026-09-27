/**
 * Onboarding is an empty state with a drop target and three shortcuts (DESIGN.md §4.5).
 * No marketing, no tips. The whole stage accepts drops; this card is the visible target.
 */
import { commandRegistry } from '../commands/registry';
import { currentPlatform, toAriaKeyShortcut } from '../commands/shortcuts';
import { useCommand } from '../commands/use-commands';
import { Keycaps } from '../ui/Keycaps';
import { AppGlyph } from './AppGlyph';
import styles from './EmptyState.module.css';

const HINTS = [
  { id: 'file.open', label: 'Open files' },
  { id: 'view.palette', label: 'Search commands' },
  { id: 'help.shortcuts', label: 'Keyboard shortcuts' },
] as const;

export function EmptyState({ dragging }: { readonly dragging: boolean }) {
  return (
    <div className={styles.wrap}>
      <div className={styles.card} data-dragging={dragging || undefined}>
        <div className={styles.target}>
          <span className={styles.glyph}>
            <AppGlyph size={24} />
          </span>
          <h1 className={styles.title}>{dragging ? 'Release to open' : 'Drop PDFs to start'}</h1>
          <p className={styles.body}>
            Files open on this device and are never uploaded.
            <br />
            Drop several to combine them.
          </p>
        </div>
        <ul className={styles.hints} aria-label="Get started">
          {HINTS.map((hint) => (
            <HintRow key={hint.id} id={hint.id} label={hint.label} />
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
