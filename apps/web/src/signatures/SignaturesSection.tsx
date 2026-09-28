/**
 * The Inspector's Signatures section (spec recognize-and-compare §3.1, §3.4): per signed
 * source of the active document, each signature's status with the fixed honesty line, the
 * weak-algorithm flag, signer facts and the claimed time, later changes by revision, the
 * certificates as embedded and every check; "View signed version" opens the signed revision
 * as a new document. Below, the plain export statement: a rewrite removes existing
 * signatures (ADR-0013). Never says "valid".
 */
import type { SourceDocument } from '@pdf-editor/document-model';
import type { SignatureReport, SignerFacts } from '@pdf-editor/engine';
import { Shield, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useState } from 'react';

import { formatNumber, getLocale, m } from '../i18n';
import { announce } from '../shell/announcer';
import { useActiveDocument, useWorkspaceStore } from '../state/workspace-store';
import { openSignedVersion, useSignatureStore } from './signature-store';
import styles from './Signatures.module.css';
import {
  algorithmText,
  chainEndsAtRoot,
  changeLine,
  checkDetail,
  checkLabel,
  hasSignedVersion,
  honestyLine,
  outcomeLabel,
  signerName,
  statusExplanation,
  statusLabel,
  statusTone,
  type StatusTone,
} from './status';
import { sourceEdited, useSignedSources } from './use-signatures';

const dateTime = (iso: string) => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(
    date,
  );
};
const dateOnly = (iso: string) => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium' }).format(date);
};

/** The shield glyph for a tone (the word always stands beside it). */
export function StatusGlyph({ tone }: { readonly tone: StatusTone | undefined }) {
  if (tone === 'ok') return <ShieldCheck aria-hidden="true" />;
  if (tone === 'problem') return <ShieldAlert aria-hidden="true" />;
  return <Shield aria-hidden="true" />;
}

/** Whether the active document shows the section (a signed source, or a signed-version view). */
export function useHasSignatureSection(): boolean {
  const doc = useActiveDocument();
  return useSignedSources(doc?.id).length > 0;
}

export function SignaturesSection() {
  const doc = useActiveDocument();
  const sources = useSignedSources(doc?.id);
  if (!doc || sources.length === 0) return null;
  return (
    <div className={styles.section} data-testid="signatures-section">
      {sources.map((source) => (
        <SourceSignatures key={source.id} source={source} showName={sources.length > 1} />
      ))}
    </div>
  );
}

function SourceSignatures({
  source,
  showName,
}: {
  readonly source: SourceDocument;
  readonly showName: boolean;
}) {
  const entry = useSignatureStore((s) => s.entries[source.id]);
  const view = useSignatureStore((s) => s.views[source.id]);
  const edited = useWorkspaceStore((s) => sourceEdited(s.workspace, source.id, s.dirtySources));
  const reports = entry?.status === 'ready' ? entry.reports : [];
  return (
    <section className={styles.source} aria-label={source.name}>
      {showName ? <h3 className={styles.sourceName}>{source.name}</h3> : null}
      {view ? (
        <p className={styles.note} data-testid="signed-version-notice">
          {m.signature_view_notice({ revision: view.revision, name: view.from })}
        </p>
      ) : null}
      {entry === undefined || entry.status === 'checking' ? (
        <p className={styles.note} role="status">
          {m.signature_checking()}
        </p>
      ) : entry.status === 'failed' ? (
        <p className={styles.error}>{m.signature_check_failed({ reason: entry.message })}</p>
      ) : reports.length === 0 ? (
        <p className={styles.note}>{m.signature_none()}</p>
      ) : (
        <ul className={styles.list}>
          {reports.map((report) => (
            <li key={`${report.fieldName}-${report.revision ?? 'x'}`}>
              <SignatureCard report={report} source={source} />
            </li>
          ))}
        </ul>
      )}
      {reports.length > 0 ? (
        <p className={styles.honesty} data-testid="signature-export-notice">
          {edited ? m.signature_export_notice_edited() : m.signature_export_notice()}
        </p>
      ) : null}
    </section>
  );
}

function SignatureCard({
  report,
  source,
}: {
  readonly report: SignatureReport;
  readonly source: SourceDocument;
}) {
  const tone = statusTone(report.status);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const viewSigned = async () => {
    setOpening(true);
    setError(null);
    try {
      await openSignedVersion(source, report);
      announce(m.announce_signed_version_opened({ name: source.name }));
    } catch (failure) {
      setError(
        m.signature_view_failed({
          reason: failure instanceof Error ? failure.message : String(failure),
        }),
      );
    } finally {
      setOpening(false);
    }
  };
  return (
    <article
      className={styles.card}
      data-testid="signature-card"
      data-status={report.status}
      aria-label={`${report.fieldName}: ${statusLabel(report.status)}`}
    >
      <p className={styles.status} data-tone={tone} data-testid="signature-status">
        <StatusGlyph tone={tone} />
        <span>{statusLabel(report.status)}</span>
      </p>
      <p className={styles.explanation}>{statusExplanation(report.status)}</p>
      <p className={styles.honesty} data-testid="signature-honesty">
        {honestyLine()}
      </p>
      {report.weak ? (
        <p className={styles.weak} data-testid="signature-weak">
          {m.signature_weak({ reasons: report.weakReasons.join('; ') })}
        </p>
      ) : null}
      <dl className={styles.facts}>
        <dt>{m.signature_field()}</dt>
        <dd>{report.fieldName}</dd>
        <dt>{m.signature_signer()}</dt>
        <dd>{signerName(report)}</dd>
        {report.claimedTime ? (
          <>
            <dt>{m.signature_time()}</dt>
            <dd className={styles.numeric}>
              {m.signature_claimed_time({ time: dateTime(report.claimedTime) })}
            </dd>
          </>
        ) : null}
        <dt>{m.signature_algorithms()}</dt>
        <dd>{algorithmText(report)}</dd>
        {report.revision !== undefined ? (
          <>
            <dt>{m.signature_revision()}</dt>
            <dd className={styles.numeric}>
              {m.signature_revision_of({
                count: report.revisionCount,
                revisionText: formatNumber(report.revision),
                countText: formatNumber(report.revisionCount),
              })}
            </dd>
          </>
        ) : null}
        {report.reason ? (
          <>
            <dt>{m.signature_reason()}</dt>
            <dd>{report.reason}</dd>
          </>
        ) : null}
        {report.location ? (
          <>
            <dt>{m.signature_location()}</dt>
            <dd>{report.location}</dd>
          </>
        ) : null}
        {report.contactInfo ? (
          <>
            <dt>{m.signature_contact()}</dt>
            <dd>{report.contactInfo}</dd>
          </>
        ) : null}
      </dl>
      {report.laterChanges.length > 0 ? (
        <>
          <h4 className={styles.subheading}>{m.signature_later_changes()}</h4>
          <ul className={styles.lines} data-testid="signature-changes">
            {report.laterChanges.map((change) => (
              <li key={`${change.revision}-${change.kind}`}>{changeLine(change)}</li>
            ))}
          </ul>
        </>
      ) : null}
      <details className={styles.details}>
        <summary>{m.signature_details()}</summary>
        <div className={styles.detailsBody}>
          {report.signer ? <CertificateFacts facts={report.signer} /> : null}
          {report.chain.length > 0 ? (
            <div>
              <h4 className={styles.subheading}>{m.signature_chain()}</h4>
              <ol className={styles.lines}>
                {report.chain.map((cert) => (
                  <li key={cert.sha256}>
                    {m.signature_cert_line({ subject: cert.subject, issuer: cert.issuer })}
                  </li>
                ))}
              </ol>
              <p className={styles.note}>
                {chainEndsAtRoot(report.chain)
                  ? m.signature_chain_root()
                  : m.signature_chain_incomplete()}
              </p>
            </div>
          ) : null}
          <div>
            <h4 className={styles.subheading}>{m.signature_checks()}</h4>
            <ul className={styles.lines} data-testid="signature-checks">
              {report.checks.map((check) => (
                <li key={check.id} data-outcome={check.outcome}>
                  {m.signature_check_line({
                    check: checkLabel(check.id),
                    outcome: outcomeLabel(check.outcome),
                  })}
                  {checkDetail(check, report, dateOnly) ? (
                    <span className={styles.detail}>{checkDetail(check, report, dateOnly)}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </details>
      {hasSignedVersion(report) ? (
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.small}
            disabled={opening}
            onClick={() => void viewSigned()}
          >
            {m.signature_view_signed()}
          </button>
        </div>
      ) : null}
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </article>
  );
}

function CertificateFacts({ facts }: { readonly facts: SignerFacts }) {
  return (
    <dl className={styles.facts}>
      <dt>{m.signature_signer()}</dt>
      <dd>{facts.subject}</dd>
      <dt>{m.signature_issuer()}</dt>
      <dd>{facts.issuer}</dd>
      <dt>{m.signature_validity()}</dt>
      <dd className={styles.numeric}>
        {m.signature_validity_range({
          from: dateOnly(facts.notBefore),
          to: dateOnly(facts.notAfter),
        })}
      </dd>
      <dt>{m.signature_key()}</dt>
      <dd>
        {facts.publicKey} · {facts.signatureAlgorithm}
      </dd>
    </dl>
  );
}
