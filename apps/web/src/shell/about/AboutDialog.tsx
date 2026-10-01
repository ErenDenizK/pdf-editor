/**
 * The in-app About dialog (ADR-0017 §6, presentation spec §5): what this build is and how
 * it treats the person's files. Opened from the palette ("About PDF Editor") and from the
 * version line in the privacy popover; Esc closes it and focus returns to the opener.
 *
 * Fields, in order: name with the glyph, "Public beta" for a pre-release, version, build
 * commit and date, release notes, licence and source, "Files never leave your device",
 * storage in use, offline status. Nothing here makes a network request: the links are
 * plain anchors, and storage use comes from `navigator.storage.estimate()`.
 */
import { Dialog } from '@base-ui/react/dialog';
import { ArrowUpRight, X } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';

import { formatBytes } from '../../files/file-filters';
import { getLocale, m } from '../../i18n';
import { usePwaStore } from '../../pwa/register';
import { serviceWorkerLabel } from '../../pwa/service-worker-label';
import { AppGlyph } from '../AppGlyph';
import overlay from '../ShortcutOverlay.module.css';
import { useAboutStore } from './about-store';
import styles from './AboutDialog.module.css';
import { BUILD_INFO, type BuildInfo, LICENSE_ID, PRODUCT_NAME, REPOSITORY_URL } from './build-info';

/**
 * Mounted once in the shell. `info` defaults to this build; tests pass their own to cover
 * release and pre-release versions.
 */
export function AboutDialog({ info = BUILD_INFO }: { readonly info?: BuildInfo }) {
  const open = useAboutStore((s) => s.open);
  const returnFocus = useAboutStore((s) => s.returnFocus);
  // Focus the surface, not the close button, so no ring flashes on open (as the keyboard
  // map does); Tab then reaches the links and the close button.
  const popupRef = useRef<HTMLDivElement>(null);
  return (
    <Dialog.Root open={open} onOpenChange={(next) => useAboutStore.setState({ open: next })}>
      <Dialog.Portal>
        <Dialog.Backdrop className={overlay.backdrop} />
        <Dialog.Popup
          ref={popupRef}
          className={`${overlay.popup} ${styles.popup}`}
          initialFocus={popupRef}
          // The opener may be gone (the popover closes as this opens); fall back to the
          // default, the element focused before the dialog opened.
          finalFocus={() => (returnFocus?.isConnected ? returnFocus : true)}
          data-testid="about-dialog"
        >
          <div className={overlay.header}>
            <div className={styles.heading}>
              <Dialog.Title className={styles.title}>
                <AppGlyph size={20} />
                <span>{PRODUCT_NAME}</span>
              </Dialog.Title>
              {info.isPreRelease ? (
                <span className={styles.badge} data-testid="about-prerelease">
                  {m.about_public_beta()}
                </span>
              ) : null}
            </div>
            <Dialog.Close className={overlay.close} aria-label={m.common_close()}>
              <X aria-hidden="true" />
            </Dialog.Close>
          </div>
          <AboutBody info={info} />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function AboutBody({ info }: { readonly info: BuildInfo }) {
  const storage = useStorageUsage();
  const swStatus = usePwaStore((s) => s.status);
  const updateAvailable = usePwaStore((s) => s.updateAvailable);
  return (
    <div className={styles.body}>
      <dl className={styles.rows}>
        <Row label={m.about_version()} testId="about-version">
          <span className={styles.mono}>{info.version}</span>
        </Row>
        <Row label={m.about_commit()} testId="about-commit">
          <span className={styles.mono}>{info.commit}</span>
        </Row>
        <Row label={m.about_build_date()} testId="about-build-date">
          <time dateTime={info.buildDate}>{formatBuildDate(info.buildDate)}</time>
        </Row>
      </dl>
      <p className={styles.links}>
        <ExternalLink href={info.releaseNotesUrl} testId="about-release-notes">
          {m.about_release_notes()}
        </ExternalLink>
      </p>
      <dl className={styles.rows}>
        <Row label={m.about_license()} testId="about-license">
          <span>{LICENSE_ID}</span>
          <span className={styles.separator} aria-hidden="true">
            ·
          </span>
          <ExternalLink href={REPOSITORY_URL} testId="about-source">
            {m.about_source()}
          </ExternalLink>
        </Row>
      </dl>
      <Dialog.Description className={styles.statement}>{m.about_files_local()}</Dialog.Description>
      <dl className={styles.rows}>
        <Row label={m.about_storage()} testId="about-storage">
          <span data-status={storage.status}>{storageText(storage)}</span>
        </Row>
        <Row label={m.about_offline()} testId="about-offline">
          <span data-status={swStatus}>{serviceWorkerLabel(swStatus, updateAvailable)}</span>
        </Row>
      </dl>
    </div>
  );
}

function Row({
  label,
  testId,
  children,
}: {
  readonly label: string;
  readonly testId: string;
  readonly children: ReactNode;
}) {
  return (
    <div className={styles.row}>
      <dt className={styles.label}>{label}</dt>
      <dd className={styles.value} data-testid={testId}>
        {children}
      </dd>
    </div>
  );
}

/** A link out of the app: always a new tab, never a referrer. */
function ExternalLink({
  href,
  testId,
  children,
}: {
  readonly href: string;
  readonly testId: string;
  readonly children: ReactNode;
}) {
  return (
    <a className={styles.link} href={href} target="_blank" rel="noreferrer" data-testid={testId}>
      {children}
      <ArrowUpRight className={styles.linkIcon} aria-hidden="true" />
      <span className="visually-hidden"> {m.about_new_tab()}</span>
    </a>
  );
}

/** The build date in the UI language, e.g. "1 October 2026" / "1 Ekim 2026". */
function formatBuildDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(getLocale(), { dateStyle: 'long' }).format(date);
}

type StorageUsage =
  | { readonly status: 'measuring' }
  | { readonly status: 'unavailable' }
  | { readonly status: 'ready'; readonly usage: number };

function storageText(storage: StorageUsage): string {
  switch (storage.status) {
    case 'measuring':
      return m.about_storage_measuring();
    case 'unavailable':
      return m.about_storage_unavailable();
    case 'ready':
      return formatBytes(storage.usage);
  }
}

/** `navigator.storage` is missing outside secure contexts and in some older browsers. */
function storageManager(): StorageManager | undefined {
  const storage = (navigator as Navigator & { storage?: StorageManager }).storage;
  return typeof storage?.estimate === 'function' ? storage : undefined;
}

/** This origin's storage use (caches, IndexedDB, OPFS), measured each time the dialog opens. */
function useStorageUsage(): StorageUsage {
  const [usage, setUsage] = useState<StorageUsage>(() =>
    storageManager() ? { status: 'measuring' } : { status: 'unavailable' },
  );
  useEffect(() => {
    const storage = storageManager();
    if (!storage) return;
    let live = true;
    storage.estimate().then(
      (estimate) => {
        if (!live) return;
        setUsage(
          estimate.usage === undefined
            ? { status: 'unavailable' }
            : { status: 'ready', usage: estimate.usage },
        );
      },
      () => {
        if (live) setUsage({ status: 'unavailable' });
      },
    );
    return () => {
      live = false;
    };
  }, []);
  return usage;
}
