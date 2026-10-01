import { useAnnouncer } from './announcer';

/** Visually hidden live regions for shell announcements: polite, and assertive for failures. */
export function LiveRegion() {
  const { message, serial, alert, alertSerial } = useAnnouncer();
  return (
    <>
      <div role="status" aria-live="polite" aria-atomic="true" className="visually-hidden">
        {/* Keying by serial re-announces identical consecutive messages. */}
        <span key={serial}>{message}</span>
      </div>
      {/* No `alert` role: the region is always there, and an empty alert would be one more
          "alert" for every other alert on the page to be told apart from. */}
      <div aria-live="assertive" aria-atomic="true" className="visually-hidden">
        <span key={alertSerial}>{alert}</span>
      </div>
    </>
  );
}
