/**
 * "Sign with certificate" (spec recognize-and-compare §3.2, §3.4): a .p12/.pfx file and its
 * password (kept in this tab's memory only), optional reason, location and contact, and an
 * optional visible signature (page and corner). "Check certificate" opens the file in a
 * signature worker of its own (`checkIdentity`) and shows the signer before anything is
 * signed, or the engine's refusal (legacy 3DES with the OpenSSL re-export command, wrong
 * password, no key). The signature itself is added at export, over the verified output.
 *
 * Mounted twice, like the document dialogs: at the app root (`origin="app"`, from the
 * Document menu; it continues to the export dialog) and inside the export dialog.
 */
import { Dialog } from '@base-ui/react/dialog';
import type { DocumentId } from '@pdf-editor/document-model';
import type { SignerFacts } from '@pdf-editor/engine';
import { X } from 'lucide-react';
import { type SyntheticEvent, useId, useRef, useState } from 'react';

import { openExportDialog } from '../export/export-store';
import { getLocale, m } from '../i18n';
import { announce } from '../shell/announcer';
import overlay from '../shell/ShortcutOverlay.module.css';
import { useWorkspaceStore } from '../state/workspace-store';
import { useRetained } from '../ui/use-retained';
import { SIGNATURE_CORNERS, type SignatureCorner } from './pdf-pass';
import {
  closeSignDialog,
  type SignDialog as SignDialogState,
  setSignDraft,
  useSignStore,
} from './sign-store';
import { checkIdentity, signingFailureText, signingReason } from './signing';
import styles from './Signatures.module.css';

export const P12_ACCEPT = '.p12,.pfx,application/x-pkcs12';

const CORNER_LABELS: Readonly<Record<SignatureCorner, () => string>> = {
  'bottom-right': m.sign_corner_bottom_right,
  'bottom-left': m.sign_corner_bottom_left,
  'top-right': m.sign_corner_top_right,
  'top-left': m.sign_corner_top_left,
};

export function SignDialog({ origin = 'app' }: { readonly origin?: SignDialogState['origin'] }) {
  const dialog = useSignStore((s) => (s.dialog?.origin === origin ? s.dialog : null));
  const [shown, release] = useRetained(dialog);
  return (
    <Dialog.Root
      open={dialog !== null}
      onOpenChange={(open) => {
        if (!open) closeSignDialog();
      }}
      onOpenChangeComplete={(open) => {
        if (!open) release();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className={overlay.backdrop} />
        {shown ? (
          <SignFlow key={shown.documentId} documentId={shown.documentId} origin={shown.origin} />
        ) : null}
      </Dialog.Portal>
    </Dialog.Root>
  );
}

type Phase =
  | { readonly kind: 'form' }
  | { readonly kind: 'checking' }
  | { readonly kind: 'checked'; readonly signer: SignerFacts }
  | {
      readonly kind: 'refused';
      readonly message: string;
      /** The OpenSSL re-export command, for a legacy (3DES/RC2) file. */
      readonly command?: string;
    };

const dateOnly = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium' }).format(date);
};

function SignFlow({
  documentId,
  origin,
}: {
  readonly documentId: DocumentId;
  readonly origin: SignDialogState['origin'];
}) {
  const pageCount = useWorkspaceStore((s) => s.workspace.documents[documentId]?.pages.length ?? 0);
  const existing = useSignStore((s) => s.drafts[documentId]);
  const [file, setFile] = useState<{ name: string; bytes: ArrayBuffer } | null>(() =>
    existing ? { name: existing.fileName, bytes: existing.pkcs12.slice(0) } : null,
  );
  const [password, setPassword] = useState(existing?.password ?? '');
  const [reason, setReason] = useState(existing?.reason ?? '');
  const [location, setLocation] = useState(existing?.location ?? '');
  const [contact, setContact] = useState(existing?.contactInfo ?? '');
  const [visible, setVisible] = useState(existing?.visible !== undefined);
  const [page, setPage] = useState((existing?.visible?.pageIndex ?? 0) + 1);
  const [corner, setCorner] = useState<SignatureCorner>(
    existing?.visible?.corner ?? 'bottom-right',
  );
  const [phase, setPhase] = useState<Phase>(() =>
    existing ? { kind: 'checked', signer: existing.signer } : { kind: 'form' },
  );
  const [missingFile, setMissingFile] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const ids = useId();
  // A new file or password needs a new check.
  const reset = () => {
    if (phase.kind !== 'form') setPhase({ kind: 'form' });
  };

  const onFile = async (chosen: File | undefined) => {
    reset();
    setMissingFile(false);
    if (!chosen) {
      setFile(null);
      return;
    }
    setFile({ name: chosen.name, bytes: await chosen.arrayBuffer() });
  };

  const onSubmit = async (event: SyntheticEvent) => {
    event.preventDefault();
    if (phase.kind === 'checking') return;
    if (!file) {
      setMissingFile(true);
      fileRef.current?.focus();
      return;
    }
    if (phase.kind === 'checked') {
      setSignDraft(documentId, {
        pkcs12: file.bytes,
        fileName: file.name,
        password,
        reason,
        location,
        contactInfo: contact,
        ...(visible
          ? {
              visible: {
                pageIndex: Math.min(Math.max(page, 1), Math.max(pageCount, 1)) - 1,
                corner,
              },
            }
          : {}),
        signer: phase.signer,
      });
      closeSignDialog();
      if (origin === 'app') openExportDialog(documentId);
      return;
    }
    setPhase({ kind: 'checking' });
    try {
      const signer = await checkIdentity(file.bytes, password);
      setPhase({ kind: 'checked', signer });
      announce(signer.commonName ?? signer.subject);
    } catch (error) {
      const legacy = signingReason(error) === 'legacy-pkcs12';
      // The engine chunk is loaded by now (the check ran in its worker proxy).
      const command = legacy
        ? (await import('@pdf-editor/engine')).PKCS12_REEXPORT_COMMAND
        : undefined;
      setPhase({
        kind: 'refused',
        message: signingFailureText(error),
        ...(command ? { command } : {}),
      });
    }
  };

  const errorId = `${ids}-error`;
  return (
    <Dialog.Popup
      className={`${overlay.popup} ${styles.popup}`}
      initialFocus={fileRef}
      data-testid="sign-dialog"
    >
      <div className={overlay.header}>
        <Dialog.Title className={overlay.title}>{m.sign_dialog_title()}</Dialog.Title>
        <Dialog.Close className={overlay.close} aria-label={m.common_close()}>
          <X aria-hidden="true" />
        </Dialog.Close>
      </div>
      <form className={styles.dialogBody} onSubmit={(event) => void onSubmit(event)} noValidate>
        <Dialog.Description className={styles.description}>
          {m.sign_dialog_description()}
        </Dialog.Description>
        <div className={styles.field}>
          <label htmlFor={`${ids}-file`} className={styles.label}>
            {m.sign_certificate_file()}
          </label>
          <input
            ref={fileRef}
            id={`${ids}-file`}
            type="file"
            accept={P12_ACCEPT}
            className={styles.file}
            aria-invalid={missingFile || undefined}
            onChange={(event) => void onFile(event.target.files?.[0])}
          />
          {file ? <span className={styles.hint}>{file.name}</span> : null}
          {missingFile ? (
            <span className={styles.error} role="alert">
              {m.sign_no_file()}
            </span>
          ) : null}
        </div>
        <div className={styles.field}>
          <label htmlFor={`${ids}-password`} className={styles.label}>
            {m.sign_password()}
          </label>
          <input
            id={`${ids}-password`}
            type="password"
            className={styles.input}
            autoComplete="off"
            spellCheck={false}
            value={password}
            aria-describedby={phase.kind === 'refused' ? errorId : undefined}
            onChange={(event) => {
              reset();
              setPassword(event.target.value);
            }}
          />
        </div>
        <TextField label={m.sign_reason()} value={reason} onChange={setReason} />
        <TextField label={m.sign_location()} value={location} onChange={setLocation} />
        <TextField label={m.sign_contact()} value={contact} onChange={setContact} />
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={visible}
            disabled={pageCount === 0}
            onChange={(event) => setVisible(event.target.checked)}
          />
          <span>
            {m.sign_visible()}
            <span className={styles.hint}>{m.sign_visible_hint()}</span>
          </span>
        </label>
        {visible ? (
          <div className={styles.row}>
            <div className={styles.field}>
              <label htmlFor={`${ids}-page`} className={styles.label}>
                {m.sign_visible_page()}
              </label>
              <input
                id={`${ids}-page`}
                type="number"
                className={styles.input}
                min={1}
                max={Math.max(pageCount, 1)}
                value={page}
                onChange={(event) => setPage(Number(event.target.value) || 1)}
              />
            </div>
            <div className={styles.field}>
              <label htmlFor={`${ids}-corner`} className={styles.label}>
                {m.sign_visible_corner()}
              </label>
              <select
                id={`${ids}-corner`}
                className={styles.select}
                value={corner}
                onChange={(event) => setCorner(event.target.value as SignatureCorner)}
              >
                {SIGNATURE_CORNERS.map((value) => (
                  <option key={value} value={value}>
                    {CORNER_LABELS[value]()}
                  </option>
                ))}
              </select>
            </div>
          </div>
        ) : null}
        {phase.kind === 'checking' ? (
          <p className={styles.note} role="status">
            {m.sign_checking()}
          </p>
        ) : null}
        {phase.kind === 'checked' ? <SignerPreview signer={phase.signer} /> : null}
        {phase.kind === 'refused' ? (
          <div className={styles.field} id={errorId} data-testid="sign-refused">
            <p className={styles.error} role="alert">
              {phase.message}
            </p>
            {phase.command ? (
              <>
                <span className={styles.label}>{m.sign_command_label()}</span>
                <code className={styles.command} data-testid="sign-reexport-command">
                  {phase.command}
                </code>
              </>
            ) : null}
          </div>
        ) : null}
        <div className={styles.dialogActions}>
          <Dialog.Close className={styles.secondary}>{m.common_cancel()}</Dialog.Close>
          <button type="submit" className={styles.primary} disabled={phase.kind === 'checking'}>
            {phase.kind === 'checked'
              ? origin === 'app'
                ? m.sign_continue()
                : m.sign_use()
              : m.sign_check()}
          </button>
        </div>
      </form>
    </Dialog.Popup>
  );
}

function TextField({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className={styles.field}>
      <label htmlFor={id} className={styles.label}>
        {label}
      </label>
      <input
        id={id}
        className={styles.input}
        autoComplete="off"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function SignerPreview({ signer }: { readonly signer: SignerFacts }) {
  return (
    <div className={styles.preview} data-testid="signer-preview" role="status">
      <dl className={styles.facts}>
        <dt>{m.signature_signer()}</dt>
        <dd data-testid="signer-name">{signer.commonName ?? signer.subject}</dd>
        <dt>{m.signature_issuer()}</dt>
        <dd>{signer.issuer}</dd>
        <dt>{m.sign_valid_until()}</dt>
        <dd className={styles.numeric}>{dateOnly(signer.notAfter)}</dd>
        <dt>{m.signature_key()}</dt>
        <dd>{signer.publicKey}</dd>
      </dl>
      <p className={styles.hint}>{m.sign_signer_preview()}</p>
    </div>
  );
}
