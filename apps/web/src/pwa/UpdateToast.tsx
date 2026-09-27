/**
 * "Update available" notice (ADR-0010). A quiet banner above the status bar, announced
 * politely: the live region is always mounted so its content change is read out. Reload
 * activates the waiting service worker; Later hides the notice for this session.
 */
import { RefreshCw } from 'lucide-react';

import { m } from '../i18n';
import { applyUpdate, dismissUpdate, usePwaStore } from './register';
import styles from './UpdateToast.module.css';

export function UpdateToast() {
  const updateAvailable = usePwaStore((s) => s.updateAvailable);
  return (
    <div role="status" aria-live="polite" className={styles.region}>
      {updateAvailable ? (
        <div className={styles.toast} data-testid="update-toast">
          <RefreshCw className={styles.icon} aria-hidden="true" />
          <div className={styles.text}>
            <p className={styles.title}>{m.update_title()}</p>
            <p className={styles.body}>{m.update_body()}</p>
          </div>
          <div className={styles.actions}>
            <button type="button" className={styles.secondary} onClick={dismissUpdate}>
              {m.update_later()}
            </button>
            <button type="button" className={styles.primary} onClick={() => void applyUpdate()}>
              {m.update_reload()}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
