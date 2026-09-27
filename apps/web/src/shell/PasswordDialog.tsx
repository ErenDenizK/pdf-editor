/**
 * Password prompt for encrypted files (ARCHITECTURE.md §5). Answers the engine service's
 * requests one at a time; a wrong password re-prompts with a note, Skip leaves the file
 * closed (the caller announces it). Styled as the shortcut overlay's dialog.
 */
import { Dialog } from '@base-ui/react/dialog';
import { X } from 'lucide-react';
import { type SyntheticEvent, useRef, useState } from 'react';

import { answerPassword, type PasswordRequest, usePasswordStore } from '../state/password-store';
import { m } from '../i18n';
import { useRetained } from '../ui/use-retained';
import overlay from './ShortcutOverlay.module.css';
import styles from './PasswordDialog.module.css';

export function PasswordDialog() {
  const request = usePasswordStore((s) => s.queue[0]);
  // Keep the popup mounted while it animates closed (see useRetained).
  const [shown, release] = useRetained(request ?? null);
  return (
    <Dialog.Root
      open={request !== undefined}
      onOpenChange={(open) => {
        if (!open && request) answerPassword(request.id, null);
      }}
      onOpenChangeComplete={(open) => {
        if (!open) release();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className={overlay.backdrop} />
        {shown ? <PasswordForm key={shown.id} request={shown} /> : null}
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
        <Dialog.Title className={overlay.title}>{m.password_title()}</Dialog.Title>
        <Dialog.Close className={overlay.close} aria-label={m.password_skip_label()}>
          <X aria-hidden="true" />
        </Dialog.Close>
      </div>
      <form className={styles.body} onSubmit={onSubmit}>
        <Dialog.Description className={styles.description}>
          <PasswordDescription fileName={request.fileName} />
        </Dialog.Description>
        <input
          ref={inputRef}
          type="password"
          className={styles.input}
          aria-label={m.password_label()}
          aria-invalid={request.incorrect || undefined}
          aria-describedby={request.incorrect ? 'password-error' : undefined}
          autoComplete="off"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        {request.incorrect ? (
          <p id="password-error" className={styles.error}>
            {m.password_incorrect()}
          </p>
        ) : null}
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.secondary}
            onClick={() => answerPassword(request.id, null)}
          >
            {m.password_skip()}
          </button>
          <button type="submit" className={styles.primary}>
            {m.password_open()}
          </button>
        </div>
      </form>
    </Dialog.Popup>
  );
}

/**
 * The description with the file name emphasised. The message is split at the name's
 * placeholder so word order follows the language.
 */
function PasswordDescription({ fileName }: { readonly fileName: string }) {
  const marker = '\u0000';
  const [before = '', after = ''] = m.password_description({ name: marker }).split(marker);
  return (
    <>
      {before}
      <span className={styles.fileName}>{fileName}</span>
      {after}
    </>
  );
}
