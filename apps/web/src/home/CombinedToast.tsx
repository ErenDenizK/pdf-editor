/**
 * "Combined 2 files · Undo" (review F8), above the status bar. Opaque, as every toast is
 * (craft §7). It leaves after a while unless the pointer or focus is on it; the combine was
 * already announced with its undo shortcut, so it is not a live region itself.
 */
import { X } from 'lucide-react';
import { useEffect, useState } from 'react';

import { m } from '../i18n';
import { IconButton } from '../ui/IconButton';
import { dismissCombinedToast, undoCombine, useCombinedToast } from './combined-toast';
import styles from './CombinedToast.module.css';

/** How long the notice stays when nobody is on it. */
export const COMBINED_TOAST_MS = 10_000;

export function CombinedToast() {
  const toast = useCombinedToast((s) => s.toast);
  const [held, setHeld] = useState(false);

  useEffect(() => {
    if (toast === null || held) return;
    const timer = window.setTimeout(dismissCombinedToast, COMBINED_TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [toast, held]);

  if (toast === null) return null;
  return (
    <div
      role="group"
      aria-label={m.combined_toast({ count: toast.count })}
      className={styles.toast}
      data-testid="combined-toast"
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setHeld(false);
      }}
    >
      <span className={styles.text}>{m.combined_toast({ count: toast.count })}</span>
      <span className={styles.dot} aria-hidden="true">
        ·
      </span>
      <button type="button" className={styles.undo} onClick={undoCombine}>
        {m.cmd_undo()}
      </button>
      <IconButton
        label={m.combined_toast_dismiss()}
        icon={<X />}
        className={styles.close}
        onClick={dismissCombinedToast}
      />
    </div>
  );
}
