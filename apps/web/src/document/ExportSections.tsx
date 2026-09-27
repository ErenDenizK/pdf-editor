/**
 * The export dialog's Security and Metadata sections (spec document-tools.md §8). Security
 * shows the effective outcome and lets the user override it for this export (the
 * document's password settings, or none); Metadata states the policy (kept from the first
 * file, as edited, or stripped). Both link to the document dialogs, nested in the export
 * dialog (`origin: 'export'`).
 */
import type { DocumentMetadata, VirtualDocument } from '@pdf-editor/document-model';

import { m } from '../i18n';
import { useWorkspaceStore } from '../state/workspace-store';
import { openDocumentDialog } from './document-store';
import styles from './DocumentTools.module.css';
import { securityOutcome, sourcesOf } from './security-text';
import { stripSummary } from './strip-items';

export type SecurityChoice = 'document' | 'none';

export function ExportSecuritySection({
  doc,
  choice,
  onChoice,
}: {
  readonly doc: VirtualDocument;
  readonly choice: SecurityChoice;
  readonly onChoice: (choice: SecurityChoice) => void;
}) {
  const encrypted = useWorkspaceStore(
    (s) => sourcesOf(s.workspace, doc).filter((source) => source.flags.encrypted).length,
  );
  const policy = choice === 'none' ? undefined : doc.security;
  const outcome =
    policy === undefined && doc.passwordRemoved && encrypted > 0
      ? m.security_outcome_removed_requested()
      : securityOutcome(policy, encrypted);
  return (
    <div className={styles.exportSection} data-testid="export-security">
      <p className={styles.outcome} data-testid="export-security-outcome">
        {outcome}
      </p>
      {doc.security ? (
        <div className={styles.radios} role="radiogroup" aria-label={m.export_security()}>
          <label className={styles.check}>
            <input
              type="radio"
              name="export-security"
              checked={choice === 'document'}
              onChange={() => onChoice('document')}
            />
            <span>{m.export_security_document()}</span>
          </label>
          <label className={styles.check}>
            <input
              type="radio"
              name="export-security"
              checked={choice === 'none'}
              onChange={() => onChoice('none')}
            />
            <span>{m.export_security_none()}</span>
          </label>
        </div>
      ) : null}
      <div className={styles.buttons}>
        <button
          type="button"
          className={styles.small}
          onClick={() => {
            onChoice('document');
            openDocumentDialog('set-password', doc.id, 'export');
          }}
        >
          {doc.security ? m.cmd_change_password() : m.cmd_set_password()}
        </button>
      </div>
    </div>
  );
}

/** One line: what export writes as metadata. */
export function metadataOutcome(meta: DocumentMetadata, firstFile: string | undefined): string {
  if (meta.strip && Object.values(meta.strip).some(Boolean)) {
    return m.export_metadata_strip({ items: stripSummary(meta.strip) });
  }
  if (meta.policy === 'explicit') return m.export_metadata_explicit();
  return firstFile
    ? m.export_metadata_inherit({ name: firstFile })
    : m.export_metadata_inherit_none();
}

export function ExportMetadataSection({ doc }: { readonly doc: VirtualDocument }) {
  const first = useWorkspaceStore((s) => sourcesOf(s.workspace, doc)[0]?.name);
  return (
    <div className={styles.exportSection} data-testid="export-metadata">
      <p className={styles.outcome} data-testid="export-metadata-outcome">
        {metadataOutcome(doc.metadata, first)}
      </p>
      <div className={styles.buttons}>
        <button
          type="button"
          className={styles.small}
          onClick={() => openDocumentDialog('strip-metadata', doc.id, 'export')}
        >
          {m.cmd_strip_metadata()}
        </button>
      </div>
    </div>
  );
}
