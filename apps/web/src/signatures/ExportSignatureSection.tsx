/**
 * The export dialog's Signature section (spec recognize-and-compare §3.2, §3.4): the plain
 * statement that existing signatures do not survive the rewrite (ADR-0013), and "Sign the
 * exported file" with the certificate chosen in the (nested) Sign dialog. Signing an
 * encrypted output is refused, and the section says so before the export runs.
 */
import type { VirtualDocument } from '@pdf-editor/document-model';

import { m } from '../i18n';
import { openSignDialog, setSignOnExport, useSignStore } from './sign-store';
import styles from './Signatures.module.css';
import { useSignedSources } from './use-signatures';

export function ExportSignatureSection({
  doc,
  encryptedOutput,
  checkClassName,
  hintClassName,
}: {
  readonly doc: VirtualDocument;
  /** The export will be password protected (the Security section's outcome). */
  readonly encryptedOutput: boolean;
  readonly checkClassName: string | undefined;
  readonly hintClassName: string | undefined;
}) {
  const on = useSignStore((s) => s.signOnExport[doc.id] === true);
  const draft = useSignStore((s) => s.drafts[doc.id]);
  const signed = useSignedSources(doc.id).length > 0;
  const toggle = (checked: boolean) => {
    setSignOnExport(doc.id, checked);
    if (checked && !draft) openSignDialog(doc.id, 'export');
  };
  return (
    <>
      {signed ? (
        <p className={styles.honesty} data-testid="export-signatures-notice">
          {m.export_signatures_notice()}
        </p>
      ) : null}
      <label className={checkClassName}>
        <input
          type="checkbox"
          checked={on}
          onChange={(event) => toggle(event.target.checked)}
          data-testid="export-sign"
        />
        <span>
          {m.export_sign()}
          <span className={hintClassName}>{m.export_sign_hint()}</span>
        </span>
      </label>
      {on && draft ? (
        <div className={styles.exportIdentity} data-testid="export-sign-identity">
          <span>
            {m.export_sign_certificate({
              name: draft.signer.commonName ?? draft.signer.subject,
              file: draft.fileName,
            })}
          </span>
          <button
            type="button"
            className={styles.small}
            onClick={() => openSignDialog(doc.id, 'export')}
          >
            {m.export_sign_change()}
          </button>
        </div>
      ) : null}
      {on && !draft ? (
        <div className={styles.exportIdentity}>
          <span>{m.export_sign_needs_certificate()}</span>
          <button
            type="button"
            className={styles.small}
            onClick={() => openSignDialog(doc.id, 'export')}
          >
            {m.export_sign_choose()}
          </button>
        </div>
      ) : null}
      {on && encryptedOutput ? (
        <p className={styles.error} data-testid="export-sign-encrypted">
          {m.sign_refused_encrypted()}
        </p>
      ) : null}
    </>
  );
}
