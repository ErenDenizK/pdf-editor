/**
 * Status-bar privacy indicator (ARCHITECTURE.md §7): the live external-request count, and a
 * popover with the observed external URLs (expected: none), the CSP in one sentence plus
 * the enforced `connect-src`, and the service worker's offline status.
 */
import { Popover } from '@base-ui/react/popover';

import { m } from '../i18n';
import { type ServiceWorkerStatus, usePwaStore } from '../pwa/register';
import popoverStyles from '../ui/Popover.module.css';
import { documentCsp, parseCsp } from './csp';
import { useExternalRequests } from './external-requests';
import styles from './PrivacyIndicator.module.css';

function serviceWorkerLabel(status: ServiceWorkerStatus, updateAvailable: boolean): string {
  switch (status) {
    case 'unsupported':
      return m.sw_status_unsupported();
    case 'development':
      return m.sw_status_development();
    case 'installing':
      return m.sw_status_installing();
    case 'ready':
      return updateAvailable ? m.sw_status_update() : m.sw_status_ready();
    case 'error':
      return m.sw_status_error();
  }
}

/** The enforced `connect-src`, read from the page itself rather than restated. */
function connectSrc(): string | undefined {
  const policy = documentCsp();
  const sources = policy === undefined ? undefined : parseCsp(policy).get('connect-src');
  return sources === undefined ? undefined : `connect-src ${sources.join(' ')}`;
}

export function PrivacyIndicator({ className }: { readonly className?: string }) {
  const { count, urls } = useExternalRequests();
  const swStatus = usePwaStore((s) => s.status);
  const updateAvailable = usePwaStore((s) => s.updateAvailable);
  const clean = count === 0;
  const directive = connectSrc();
  return (
    <Popover.Root>
      <Popover.Trigger
        className={[styles.trigger, className].filter(Boolean).join(' ')}
        data-state={clean ? 'clean' : 'external'}
        data-testid="privacy-indicator"
      >
        <span className={styles.mark} aria-hidden="true" />
        <span>{m.privacy_local_only()}</span>
        <span className={styles.dot} aria-hidden="true">
          ·
        </span>
        <span className={styles.numeric}>{m.privacy_external_requests({ count })}</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" align="start" sideOffset={8} collisionPadding={8}>
          <Popover.Popup className={`${popoverStyles.popup} ${styles.popup}`}>
            <Popover.Title className={popoverStyles.title}>
              {clean ? m.privacy_title_clean() : m.privacy_title_external()}
            </Popover.Title>
            <Popover.Description className={popoverStyles.body}>
              {m.privacy_body()}
            </Popover.Description>

            <section className={styles.section} aria-label={m.privacy_requests_heading()}>
              <h3 className={styles.heading}>{m.privacy_requests_heading()}</h3>
              {urls.length > 0 ? (
                <ul className={styles.urls} data-testid="external-urls">
                  {urls.map((url) => (
                    <li key={url} title={url}>
                      {url}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className={styles.value}>{m.privacy_requests_none()}</p>
              )}
            </section>

            <section className={styles.section} aria-label={m.privacy_csp_heading()}>
              <h3 className={styles.heading}>{m.privacy_csp_heading()}</h3>
              <p className={styles.value}>{m.privacy_csp_body()}</p>
              {directive ? <code className={styles.code}>{directive}</code> : null}
            </section>

            <section className={styles.section} aria-label={m.privacy_offline_heading()}>
              <h3 className={styles.heading}>{m.privacy_offline_heading()}</h3>
              <p className={styles.value} data-testid="sw-status" data-status={swStatus}>
                <span className={styles.swMark} data-status={swStatus} aria-hidden="true" />
                {serviceWorkerLabel(swStatus, updateAvailable)}
              </p>
            </section>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
