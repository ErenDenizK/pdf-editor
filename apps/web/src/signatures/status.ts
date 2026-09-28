/**
 * Signature statuses as the UI words them (spec recognize-and-compare §3.1, ADR-0013): the
 * five status labels, the fixed honesty line, check and change names, and the document
 * summary behind the tab and status-bar badge. Never the word "valid": there is no trust
 * store, no revocation and no timestamp authority on this device.
 *
 * Messages are read at call time (the language can change at runtime).
 */
import type {
  RevisionChange,
  RevisionChangeKind,
  SignatureCheck,
  SignatureCheckId,
  SignatureCheckOutcome,
  SignatureReport,
  SignatureStatus,
  SignerFacts,
} from '@pdf-editor/engine';

import { m } from '../i18n';

/** Worst first: the order a document summary picks its status by. */
export const STATUS_SEVERITY: readonly SignatureStatus[] = [
  'broken',
  'changed-after-signing',
  'cannot-check',
  'intact-changed-later',
  'intact',
];

/** How a status reads: `ok` (intact), `note` (changed later) or `problem` (the rest). */
export type StatusTone = 'ok' | 'note' | 'problem';

export function statusTone(status: SignatureStatus): StatusTone {
  switch (status) {
    case 'intact':
      return 'ok';
    case 'intact-changed-later':
      return 'note';
    case 'changed-after-signing':
    case 'broken':
    case 'cannot-check':
      return 'problem';
  }
}

export function statusLabel(status: SignatureStatus): string {
  switch (status) {
    case 'intact':
      return m.signature_status_intact();
    case 'intact-changed-later':
      return m.signature_status_intact_changed_later();
    case 'changed-after-signing':
      return m.signature_status_changed_after_signing();
    case 'broken':
      return m.signature_status_broken();
    case 'cannot-check':
      return m.signature_status_cannot_check();
  }
}

/** One sentence on what the status means (under the status word). */
export function statusExplanation(status: SignatureStatus): string {
  switch (status) {
    case 'intact':
      return m.signature_explain_intact();
    case 'intact-changed-later':
      return m.signature_explain_intact_changed_later();
    case 'changed-after-signing':
      return m.signature_explain_changed_after_signing();
    case 'broken':
      return m.signature_explain_broken();
    case 'cannot-check':
      return m.signature_explain_cannot_check();
  }
}

/**
 * The fixed line every status carries (`SIGNATURE_HONESTY_LINE`), in the active language;
 * the English message is the engine's constant verbatim (a unit test holds them equal).
 */
export function honestyLine(): string {
  return m.signature_honesty();
}

export function checkLabel(id: SignatureCheckId): string {
  switch (id) {
    case 'byte-range':
      return m.signature_check_byte_range();
    case 'digest':
      return m.signature_check_digest();
    case 'signature':
      return m.signature_check_signature();
    case 'signing-certificate':
      return m.signature_check_signing_certificate();
    case 'chain':
      return m.signature_check_chain();
    case 'validity':
      return m.signature_check_validity();
    case 'key-usage':
      return m.signature_check_key_usage();
    case 'timestamp':
      return m.signature_check_timestamp();
    case 'later-changes':
      return m.signature_check_later_changes();
  }
}

/**
 * A check's detail line: the engine's English fact line, except for the certificate dates,
 * which are worded here (the engine's line calls the certificate "valid", a word the UI
 * never uses for signatures).
 */
export function checkDetail(
  check: SignatureCheck,
  report: Pick<SignatureReport, 'signer'>,
  formatDate: (iso: string) => string,
): string {
  if (check.id !== 'validity') return check.detail;
  const { signer } = report;
  if (!signer) return '';
  return m.signature_validity_detail({
    from: formatDate(signer.notBefore),
    to: formatDate(signer.notAfter),
  });
}

export function outcomeLabel(outcome: SignatureCheckOutcome): string {
  switch (outcome) {
    case 'pass':
      return m.signature_outcome_pass();
    case 'fail':
      return m.signature_outcome_fail();
    case 'not-checked':
      return m.signature_outcome_not_checked();
    case 'unsupported':
      return m.signature_outcome_unsupported();
  }
}

export function changeKindLabel(kind: RevisionChangeKind): string {
  switch (kind) {
    case 'form-fill':
      return m.signature_change_form_fill();
    case 'annotations':
      return m.signature_change_annotations();
    case 'signature':
      return m.signature_change_signature();
    case 'dss':
      return m.signature_change_dss();
    case 'metadata':
      return m.signature_change_metadata();
    case 'pages':
      return m.signature_change_pages();
    case 'content':
      return m.signature_change_content();
    case 'other':
      return m.signature_change_other();
  }
}

/** "Revision 3: annotations, page 1" (pages 1-based). */
export function changeLine(change: RevisionChange): string {
  const kind = changeKindLabel(change.kind);
  if (change.pages.length === 0) {
    return m.signature_change_line({ revision: change.revision, kind });
  }
  return m.signature_change_line_pages({
    revision: change.revision,
    kind,
    count: change.pages.length,
    pages: change.pages.map((page) => String(page + 1)).join(', '),
  });
}

/** The signer's display name: /Name, else the certificate's CN, else its subject. */
export function signerName(report: SignatureReport): string {
  return (
    report.signerName ??
    report.signer?.commonName ??
    report.signer?.subject ??
    m.signature_unknown_signer()
  );
}

/** "RSASSA-PKCS1-v1_5 with SHA-256" from a report's algorithms, when known. */
export function algorithmText(
  report: Pick<SignatureReport, 'signatureAlgorithm' | 'digestAlgorithm'>,
): string {
  const { signatureAlgorithm: sig, digestAlgorithm: digest } = report;
  if (sig && digest) return m.signature_algorithm({ signature: sig, digest });
  return sig ?? digest ?? m.signature_unknown_algorithm();
}

/** Whether the embedded chain ends at a self-signed certificate (a root in the file). */
export function chainEndsAtRoot(chain: readonly SignerFacts[]): boolean {
  return chain.length > 0 && chain[chain.length - 1]?.selfSigned === true;
}

/** Whether "View signed version" applies: the signature covers an earlier revision. */
export function hasSignedVersion(report: SignatureReport): boolean {
  return report.revision !== undefined && report.revision < report.revisionCount;
}

/** The badge summary of a document's (or source's) signatures. */
export interface SignatureSummary {
  /** Signed fields found (reports), 0 while checking or when there are none. */
  readonly count: number;
  /** The worst status, absent when there are no reports. */
  readonly status?: SignatureStatus;
  readonly weak: boolean;
}

export function summarize(reports: readonly SignatureReport[]): SignatureSummary {
  let worst: SignatureStatus | undefined;
  for (const report of reports) {
    if (
      worst === undefined ||
      STATUS_SEVERITY.indexOf(report.status) < STATUS_SEVERITY.indexOf(worst)
    ) {
      worst = report.status;
    }
  }
  return {
    count: reports.length,
    ...(worst === undefined ? {} : { status: worst }),
    weak: reports.some((report) => report.weak),
  };
}
