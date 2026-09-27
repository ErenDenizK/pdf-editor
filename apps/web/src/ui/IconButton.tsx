import type { ComponentPropsWithRef, ReactNode } from 'react';

import type { ParsedShortcut } from '../commands/shortcuts';
import { currentPlatform, toAriaKeyShortcut } from '../commands/shortcuts';
import styles from './IconButton.module.css';
import { Tooltip } from './Tooltip';

interface IconButtonProps extends Omit<ComponentPropsWithRef<'button'>, 'children'> {
  /** Accessible name and tooltip text. */
  readonly label: string;
  readonly icon: ReactNode;
  readonly shortcut?: ParsedShortcut | undefined;
  readonly tooltipSide?: 'top' | 'bottom' | 'left' | 'right';
  readonly size?: 'chrome' | 'toolbar';
}

/** Square icon button with tooltip. Hover and pressed states never change its box. */
export function IconButton({
  label,
  icon,
  shortcut,
  tooltipSide = 'bottom',
  size = 'chrome',
  className,
  ...rest
}: IconButtonProps) {
  const button = (
    <button
      type="button"
      aria-label={label}
      aria-keyshortcuts={shortcut ? toAriaKeyShortcut(shortcut, currentPlatform) : undefined}
      className={[styles.button, className].filter(Boolean).join(' ')}
      data-size={size}
      {...rest}
    >
      {icon}
    </button>
  );
  return (
    <Tooltip label={label} shortcut={shortcut} side={tooltipSide}>
      {button}
    </Tooltip>
  );
}
