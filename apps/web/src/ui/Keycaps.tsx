import {
  formatShortcut,
  type ParsedShortcut,
  type Platform,
  currentPlatform,
} from '../commands/shortcuts';
import styles from './Keycaps.module.css';

interface KeycapsProps {
  readonly shortcut: ParsedShortcut;
  readonly platform?: Platform;
  /** `quiet` drops the keycap border for dense rows. */
  readonly tone?: 'default' | 'quiet' | 'onGlass';
  readonly className?: string;
}

/** Renders a shortcut as keycaps. Decorative: controls carry `aria-keyshortcuts`. */
export function Keycaps({
  shortcut,
  platform = currentPlatform,
  tone = 'default',
  className,
}: KeycapsProps) {
  const caps = formatShortcut(shortcut, platform);
  return (
    <span
      className={[styles.keycaps, className].filter(Boolean).join(' ')}
      data-tone={tone}
      aria-hidden="true"
    >
      {caps.map((cap, index) => (
        <kbd key={`${cap}-${index}`} className={styles.cap}>
          {cap}
        </kbd>
      ))}
    </span>
  );
}
