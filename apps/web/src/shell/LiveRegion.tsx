import { useAnnouncer } from './announcer';

/** Visually hidden polite live region for shell announcements. */
export function LiveRegion() {
  const { message, serial } = useAnnouncer();
  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="visually-hidden">
      {/* Keying by serial re-announces identical consecutive messages. */}
      <span key={serial}>{message}</span>
    </div>
  );
}
