/**
 * Password prompt for encrypted files (ARCHITECTURE.md §5). Answers the engine service's
 * requests one at a time; a wrong password re-prompts with a note, Skip leaves the file
 * closed (the caller announces it). Styled as the shortcut overlay's dialog.
 */
import { Dialog } from '@base-ui/react/dialog';
import { X } from 'lucide-react';
import { type SyntheticEvent, useRef, useState } from 'react';

import { answerPassword, type PasswordRequest, usePasswordStore } from '../state/password-store';
import overlay from './ShortcutOverlay.module.css';
import styles from './PasswordDialog.module.css';

export function PasswordDialog() {
  const request = usePasswordStore((s) => s.queue[0]);
  return (
    <Dialog.Root
      open={request !== undefined}
      onOpenChange={(open) => {
        if (!open && request) answerPassword(request.id, null);
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className={overlay.backdrop} />
        {request ? <PasswordForm key={request.id} request={request} /> : null}
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function PasswordForm({ request }: { readonly request: PasswordRequest }) {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const onSubmit = (event: SyntheticEvent) => {
    event.preventDefault();
    answerPassword(request.id, value);
  };
  return (
    <Dialog.Popup className={`${overlay.popup} ${styles.popup}`} initialFocus={inputRef}>
      <div className={overlay.header}>
        <Dialog.Title className={overlay.title}>Password required</Dialog.Title>
        <Dialog.Close className={overlay.close} aria-label="Skip this file">
          <X aria-hidden="true" />
        </Dialog.Close>
      </div>
      <form className={styles.body} onSubmit={onSubmit}>
        <Dialog.Description className={styles.description}>
          <span className={styles.fileName}>{request.fileName}</span> is protected. The password is
          used on this device only.
        </Dialog.Description>
        <input
          ref={inputRef}
          type="password"
          className={styles.input}
          aria-label="Password"
          aria-invalid={request.incorrect || undefined}
          aria-describedby={request.incorrect ? 'password-error' : undefined}
          autoComplete="off"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        {request.incorrect ? (
          <p id="password-error" className={styles.error}>
            That password did not open the file. Try again.
          </p>
        ) : null}
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.secondary}
            onClick={() => answerPassword(request.id, null)}
          >
            Skip file
          </button>
          <button type="submit" className={styles.primary}>
            Open
          </button>
        </div>
      </form>
    </Dialog.Popup>
  );
}
