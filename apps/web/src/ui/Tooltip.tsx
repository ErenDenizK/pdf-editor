/**
 * Tooltip built on Base UI (ADR-0009). Tooltips are hints for sighted pointer and keyboard
 * users; the trigger must carry its own accessible name (`aria-label`) and, when it has a
 * shortcut, `aria-keyshortcuts`.
 */
import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip';
import type { ReactElement, ReactNode } from 'react';

import type { ParsedShortcut } from '../commands/shortcuts';
import { Keycaps } from './Keycaps';
import styles from './Tooltip.module.css';

export function TooltipProvider({ children }: { readonly children: ReactNode }) {
  return (
    <BaseTooltip.Provider delay={500} closeDelay={0} timeout={400}>
      {children}
    </BaseTooltip.Provider>
  );
}

interface TooltipProps {
  readonly label: string;
  readonly shortcut?: ParsedShortcut | undefined;
  readonly side?: 'top' | 'bottom' | 'left' | 'right';
  /** The trigger element. It receives the tooltip's props and ref. */
  readonly children: ReactElement;
}

export function Tooltip({ label, shortcut, side = 'bottom', children }: TooltipProps) {
  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger render={children} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner side={side} sideOffset={6} collisionPadding={8}>
          <BaseTooltip.Popup className={styles.popup}>
            <span>{label}</span>
            {shortcut ? <Keycaps shortcut={shortcut} tone="onGlass" /> : null}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}
