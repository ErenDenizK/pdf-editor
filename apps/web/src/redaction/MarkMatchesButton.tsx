/**
 * "Mark all matches for redaction" in the Search panel (redaction spec §1.1): one mark
 * per hit, all in one history entry. Waits for the search to finish so every hit is in.
 */
import { EyeOff } from 'lucide-react';
import { useState } from 'react';

import { formatNumber, m } from '../i18n';
import { useSearchStore } from '../viewer/search';
import styles from './MarkMatchesButton.module.css';
import { markSearchHits } from './review';

export function MarkMatchesButton() {
  const count = useSearchStore((s) => s.hits.length);
  const searching = useSearchStore((s) => s.status === 'searching');
  const [busy, setBusy] = useState(false);
  if (count === 0) return null;
  return (
    <button
      type="button"
      className={styles.button}
      disabled={searching || busy}
      data-testid="search-mark-all"
      onClick={() => {
        setBusy(true);
        void markSearchHits().finally(() => setBusy(false));
      }}
    >
      <EyeOff aria-hidden="true" />
      {m.redaction_mark_matches({ count, countText: formatNumber(count) })}
    </button>
  );
}
