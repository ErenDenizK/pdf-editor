/**
 * The frame every operation dialog shares (OperationDialogs.tsx, ResizeDialog.tsx): a Base
 * UI dialog popup styled as the export dialog (ShortcutOverlay popup + ExportDialog form
 * parts) with a title and close button, and the Cancel / confirm action row.
 */
import { Dialog } from '@base-ui/react/dialog';
import { X } from 'lucide-react';
import type { ReactNode, RefObject } from 'react';

import styles from '../export/ExportDialog.module.css';
import { m } from '../i18n';
import overlay from '../shell/ShortcutOverlay.module.css';
import local from './OperationDialogs.module.css';

export function Frame({
  title,
  testId,
  initialFocus,
  wide = false,
  busy = false,
  children,
}: {
  readonly title: string;
  readonly testId: string;
  readonly initialFocus?: RefObject<HTMLElement | null>;
  readonly wide?: boolean;
  /** Work is running that must not be interrupted: the close button is disabled. */
  readonly busy?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <Dialog.Popup
      className={`${overlay.popup} ${styles.popup} ${wide ? local.wide : ''}`}
      data-testid={testId}
      {...(initialFocus ? { initialFocus } : {})}
    >
      <div className={overlay.header}>
        <Dialog.Title className={overlay.title}>{title}</Dialog.Title>
        <Dialog.Close className={overlay.close} aria-label={m.common_close()} disabled={busy}>
          <X aria-hidden="true" />
        </Dialog.Close>
      </div>
      {children}
    </Dialog.Popup>
  );
}

export function Actions({
  confirm,
  disabled,
}: {
  readonly confirm: string;
  readonly disabled: boolean;
}) {
  return (
    <div className={styles.actions}>
      <Dialog.Close className={styles.secondary}>{m.common_cancel()}</Dialog.Close>
      <button type="submit" className={styles.primary} disabled={disabled}>
        {confirm}
      </button>
    </div>
  );
}
