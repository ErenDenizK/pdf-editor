/**
 * Placeholder brand glyph (DESIGN.md §6): one path, no gradient, legible at 16px.
 * A page with a folded corner, drawn as one path of two subpaths. Kept in sync with
 * `public/icons/glyph.svg` and `public/icons/app-icon.svg`.
 *
 * In the title bar the glyph is the Home button (experience-redesign §3): it shows Home,
 * like `0` and the palette's "Show Home".
 */
import { commandRegistry } from '../commands/registry';
import { currentPlatform, toAriaKeyShortcut } from '../commands/shortcuts';
import { m } from '../i18n';
import { useUiStore } from '../state/ui-store';
import { useHasDocuments } from '../state/workspace-store';
import { Tooltip } from '../ui/Tooltip';
import styles from './AppGlyph.module.css';
import { useCommandShortcut } from './use-command-shortcut';

export const GLYPH_PATH =
  'M6 2.5h7v5.5a2 2 0 0 0 2 2h5.5v9.5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-15a2 2 0 0 1 2-2ZM14.75 2.5 20.5 8.25h-4.75a1 1 0 0 1-1-1Z';

export function AppGlyph({ size = 16 }: { readonly size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={GLYPH_PATH} fill="currentColor" fillRule="evenodd" />
    </svg>
  );
}

/** The title bar's glyph as the Home button; `className` places it in the bar. */
export function HomeButton({ className }: { readonly className?: string | undefined }) {
  // Home is current while it shows, also as the empty state (no document open).
  const destinationHome = useUiStore((s) => s.destination === 'home');
  const onHome = !useHasDocuments() || destinationHome;
  const shortcut = useCommandShortcut('view.home');
  return (
    <div className={className}>
      <Tooltip label={m.home_long()} shortcut={shortcut}>
        <button
          type="button"
          className={styles.home}
          aria-label={m.home_label()}
          aria-current={onHome ? 'page' : undefined}
          aria-keyshortcuts={shortcut ? toAriaKeyShortcut(shortcut, currentPlatform) : undefined}
          data-testid="home-button"
          onClick={() => void commandRegistry.execute('view.home')}
        >
          <AppGlyph />
        </button>
      </Tooltip>
    </div>
  );
}
