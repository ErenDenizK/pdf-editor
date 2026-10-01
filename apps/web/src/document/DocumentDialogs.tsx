/**
 * The document-tools dialogs (spec document-tools.md §3, §4): Set password, Remove
 * password and Strip metadata. Each result is one history entry on the document model
 * (`setSecurity`, `removePassword`, `setMetadataStrip`) and takes effect at export.
 *
 * And the Document info sheet (experience-redesign §4.2): the file facts and honesty
 * badges, editable metadata, the password and the diagnostics, moved out of the inspector.
 * A password dialog opened from the sheet returns to it when it closes.
 *
 * Mounted twice: once at the app root (`origin="app"`) and once inside the export dialog
 * (`origin="export"`), so a dialog opened from the export dialog nests in its modal stack.
 */
import { Dialog } from '@base-ui/react/dialog';
import {
  type MetadataStrip,
  type PermissionFlags,
  removePassword,
  setMetadataStrip,
  setSecurity,
  type VirtualDocument,
  type Workspace,
} from '@pdf-editor/document-model';
import { X } from 'lucide-react';
import { type Ref, type SyntheticEvent, useEffect, useId, useRef, useState } from 'react';

import { formatNumber, m } from '../i18n';
import { announce } from '../shell/announcer';
import { DocumentFacts } from '../shell/RightPanel';
import overlay from '../shell/ShortcutOverlay.module.css';
import { documentSources, useWorkspaceStore } from '../state/workspace-store';
import { useRetained } from '../ui/use-retained';
import { DiagnosticsDetails } from './Diagnostics';
import { useSourceDiagnostics } from './diagnostics';
import {
  closeDocumentDialog,
  type DocumentDialog,
  openDocumentDialog,
  useDocumentDialogStore,
} from './document-store';
import infoStyles from './DocumentInfo.module.css';
import styles from './DocumentTools.module.css';
import { MetadataEditor } from './MetadataEditor';
import { SecurityInfo } from './SecurityInfo';
import {
  initialValues,
  normalizePermissions,
  type PasswordFormValues,
  toPolicy,
  validatePasswordForm,
} from './password-form';
import { passwordStrength } from './password-strength';
import {
  PERMISSION_KEYS,
  passwordSources,
  permissionLabel,
  restrictedSources,
  restrictionList,
} from './security-text';
import { findingFor, initialStrip, mergeFindings, STRIP_ITEMS, stripSummary } from './strip-items';

/**
 * A dialog opened from the Document info sheet (its "Set password…" and "Remove password…"
 * buttons) replaces the sheet; when it closes, the sheet comes back.
 */
let returnToInfo: DocumentDialog | null = null;
useDocumentDialogStore.subscribe((state, previous) => {
  const was = previous.dialog;
  const now = state.dialog;
  if (was?.kind === 'info' && now !== null && now.kind !== 'info') {
    returnToInfo = now.documentId === was.documentId ? was : null;
  } else if (now === null && was !== null && was.kind !== 'info' && returnToInfo !== null) {
    const info = returnToInfo;
    returnToInfo = null;
    openDocumentDialog('info', info.documentId, info.origin);
  } else if (now?.kind === 'info' || now === null) {
    returnToInfo = null;
  }
});

export function DocumentDialogs({
  origin = 'app',
}: {
  readonly origin?: DocumentDialog['origin'];
}) {
  const dialog = useDocumentDialogStore((s) => (s.dialog?.origin === origin ? s.dialog : null));
  const [shown, release] = useRetained(dialog);
  return (
    <Dialog.Root
      open={dialog !== null}
      onOpenChange={(open) => {
        if (!open) closeDocumentDialog();
      }}
      onOpenChangeComplete={(open) => {
        if (!open) release();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className={overlay.backdrop} />
        {shown ? <DialogBody key={`${shown.kind}-${shown.documentId}`} dialog={shown} /> : null}
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function DialogBody({ dialog }: { readonly dialog: DocumentDialog }) {
  const doc = useWorkspaceStore((s) => s.workspace.documents[dialog.documentId]);
  if (!doc) return null;
  switch (dialog.kind) {
    case 'set-password':
      return <SetPasswordFlow doc={doc} />;
    case 'remove-password':
      return <RemovePasswordFlow doc={doc} />;
    case 'strip-metadata':
      return <StripMetadataFlow doc={doc} />;
    case 'info':
      return <DocumentInfoSheet doc={doc} />;
  }
}

// ---------------------------------------------------------------------------
// Document info
// ---------------------------------------------------------------------------

/** The side sheet: facts and badges, metadata (focused on Title), password, diagnostics. */
function DocumentInfoSheet({ doc }: { readonly doc: VirtualDocument }) {
  const ws = useWorkspaceStore((s) => s.workspace);
  const sources = documentSources(doc).flatMap((id) => {
    const source = ws.sources[id];
    return source ? [source] : [];
  });
  return (
    <Dialog.Popup
      className={infoStyles.sheet}
      initialFocus={() =>
        document.querySelector<HTMLElement>(
          '[data-document-info] [data-testid="metadata-editor"] input',
        )
      }
      data-testid="document-info"
      data-document-info=""
    >
      <Header title={m.docinfo_title()} />
      <div className={infoStyles.body}>
        <Dialog.Description className="visually-hidden">{doc.title}</Dialog.Description>
        <h3 className={infoStyles.subTitle}>{m.docinfo_file()}</h3>
        <DocumentFacts doc={doc} />
        <h3 className={infoStyles.subTitle}>{m.info_metadata()}</h3>
        <MetadataEditor doc={doc} />
        <h3 className={infoStyles.subTitle}>{m.info_security()}</h3>
        <SecurityInfo doc={doc} />
        {sources.length > 0 ? <DiagnosticsDetails sources={sources} /> : null}
      </div>
    </Dialog.Popup>
  );
}

function Header({ title }: { readonly title: string }) {
  return (
    <div className={overlay.header}>
      <Dialog.Title className={overlay.title}>{title}</Dialog.Title>
      <Dialog.Close className={overlay.close} aria-label={m.common_close()}>
        <X aria-hidden="true" />
      </Dialog.Close>
    </div>
  );
}

function commit(operation: (ws: Workspace) => Workspace, label: string): boolean {
  return useWorkspaceStore.getState().applyOperation(operation, label);
}

// ---------------------------------------------------------------------------
// Set password
// ---------------------------------------------------------------------------

const STRENGTH_LABELS = [
  m.strength_very_weak,
  m.strength_weak,
  m.strength_fair,
  m.strength_good,
  m.strength_strong,
];

function StrengthMeter({ value, id }: { readonly value: string; readonly id: string }) {
  if (value === '') return null;
  const { score } = passwordStrength(value);
  const label = (STRENGTH_LABELS[score] ?? m.strength_very_weak)();
  return (
    <span className={styles.strength} id={id} data-score={score}>
      <span className={styles.strengthBar} aria-hidden="true">
        {[0, 1, 2, 3].map((segment) => (
          <span key={segment} data-on={segment < Math.max(score, 1) || undefined} />
        ))}
      </span>
      <span>{m.strength_label({ strength: label })}</span>
    </span>
  );
}

function PasswordInput({
  label,
  hint,
  value,
  shown,
  onChange,
  inputRef,
}: {
  readonly label: string;
  readonly hint: string;
  readonly value: string;
  readonly shown: boolean;
  readonly onChange: (value: string) => void;
  readonly inputRef?: Ref<HTMLInputElement>;
}) {
  const id = useId();
  return (
    <div className={styles.dialogField}>
      <label htmlFor={id} className={styles.dialogLabel}>
        {label}
      </label>
      <input
        ref={inputRef}
        id={id}
        type={shown ? 'text' : 'password'}
        className={styles.dialogInput}
        autoComplete="new-password"
        spellCheck={false}
        value={value}
        aria-describedby={`${id}-hint ${id}-strength`}
        onChange={(event) => onChange(event.target.value)}
      />
      <span id={`${id}-hint`} className={styles.hint}>
        {hint}
      </span>
      <StrengthMeter value={value} id={`${id}-strength`} />
    </div>
  );
}

function problemText(problem: NonNullable<ReturnType<typeof validatePasswordForm>['problem']>) {
  switch (problem) {
    case 'no-password':
      return m.set_password_error_none();
    case 'same-passwords':
      return m.set_password_error_same();
    case 'too-long':
      return m.set_password_error_long();
  }
}

export function SetPasswordFlow({ doc }: { readonly doc: VirtualDocument }) {
  const [values, setValues] = useState<PasswordFormValues>(() => initialValues(doc.security));
  const [show, setShow] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const firstRef = useRef<HTMLInputElement>(null);
  const check = validatePasswordForm(values);
  const permissions = normalizePermissions(values.permissions);
  const setPermission = (key: keyof PermissionFlags, allowed: boolean) =>
    setValues((v) => ({ ...v, permissions: { ...v.permissions, [key]: allowed } }));
  const onSubmit = (event: SyntheticEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (check.problem !== undefined) return;
    const policy = toPolicy(values);
    commit((ws) => setSecurity(ws, doc.id, policy), m.history_set_password());
    closeDocumentDialog();
    announce(m.announce_password_set());
  };
  const errorId = useId();
  return (
    <Dialog.Popup
      className={`${overlay.popup} ${styles.popup}`}
      initialFocus={firstRef}
      data-testid="set-password-dialog"
    >
      <Header title={m.set_password_title()} />
      <form className={styles.dialogBody} onSubmit={onSubmit} noValidate>
        <Dialog.Description className={styles.description}>
          {m.set_password_description()}
        </Dialog.Description>
        <PasswordInput
          inputRef={firstRef}
          label={m.set_password_user()}
          hint={m.set_password_user_hint()}
          value={values.userPassword}
          shown={show}
          onChange={(userPassword) => setValues((v) => ({ ...v, userPassword }))}
        />
        <PasswordInput
          label={m.set_password_owner()}
          hint={m.set_password_owner_hint()}
          value={values.ownerPassword}
          shown={show}
          onChange={(ownerPassword) => setValues((v) => ({ ...v, ownerPassword }))}
        />
        <label className={styles.check}>
          <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} />
          <span>{m.set_password_show()}</span>
        </label>
        <fieldset className={styles.permissions}>
          <legend className={styles.dialogLabel}>{m.set_password_permissions()}</legend>
          {PERMISSION_KEYS.map((key) => (
            <label key={key} className={styles.check}>
              <input
                type="checkbox"
                checked={permissions[key]}
                disabled={
                  (key === 'printHighQuality' && !values.permissions.print) ||
                  (key === 'fillForms' && values.permissions.annotate)
                }
                onChange={(event) => setPermission(key, event.target.checked)}
              />
              <span>{permissionLabel(key)}</span>
            </label>
          ))}
        </fieldset>
        <p className={styles.hint}>{m.set_password_algorithm()}</p>
        {check.randomOwner ? <p className={styles.hint}>{m.set_password_random_owner()}</p> : null}
        {submitted && check.problem !== undefined ? (
          <p id={errorId} className={styles.error} role="alert">
            {problemText(check.problem)}
          </p>
        ) : null}
        <div className={styles.actions}>
          <Dialog.Close className={styles.secondary}>{m.common_cancel()}</Dialog.Close>
          <button type="submit" className={styles.primary}>
            {m.set_password_apply()}
          </button>
        </div>
      </form>
    </Dialog.Popup>
  );
}

// ---------------------------------------------------------------------------
// Remove password
// ---------------------------------------------------------------------------

function RemovePasswordFlow({ doc }: { readonly doc: VirtualDocument }) {
  const ws = useWorkspaceStore((s) => s.workspace);
  const restricted = restrictedSources(ws, doc);
  const locked = passwordSources(ws, doc);
  const [confirmed, setConfirmed] = useState(false);
  const needsConfirmation = restricted.length > 0;
  const primaryRef = useRef<HTMLButtonElement>(null);
  const onSubmit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (needsConfirmation && !confirmed) return;
    commit((w) => removePassword(w, doc.id), m.history_remove_password());
    closeDocumentDialog();
    announce(m.announce_password_removed());
  };
  return (
    <Dialog.Popup
      className={`${overlay.popup} ${styles.popup}`}
      initialFocus={primaryRef}
      data-testid="remove-password-dialog"
    >
      <Header title={m.remove_password_title()} />
      <form className={styles.dialogBody} onSubmit={onSubmit}>
        <Dialog.Description className={styles.description}>
          {m.remove_password_description()}
        </Dialog.Description>
        <ul className={styles.bullets}>
          {doc.security ? <li>{m.remove_password_policy()}</li> : null}
          {locked.map((source) => (
            <li key={source.id}>{m.remove_password_locked({ name: source.name })}</li>
          ))}
          {restricted.map((source) => (
            <li key={source.id}>
              {m.remove_password_restricted({
                name: source.name,
                restricted: restrictionList(source.flags.permissions as PermissionFlags),
              })}
            </li>
          ))}
        </ul>
        {needsConfirmation ? (
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            <span>{m.remove_password_confirm()}</span>
          </label>
        ) : null}
        <div className={styles.actions}>
          <Dialog.Close className={styles.secondary}>{m.common_cancel()}</Dialog.Close>
          <button
            ref={primaryRef}
            type="submit"
            className={styles.primary}
            disabled={needsConfirmation && !confirmed}
          >
            {m.remove_password_apply()}
          </button>
        </div>
      </form>
    </Dialog.Popup>
  );
}

// ---------------------------------------------------------------------------
// Strip metadata
// ---------------------------------------------------------------------------

export function StripMetadataFlow({ doc }: { readonly doc: VirtualDocument }) {
  const ids = documentSources(doc);
  const entries = useSourceDiagnostics(ids);
  const loading = entries.some((e) => e === undefined || e.status === 'loading');
  const findings = mergeFindings(
    entries.flatMap((e) => (e?.status === 'ready' ? [e.value.metadata] : [])),
  );
  const failed = entries.some((e) => e?.status === 'failed');
  return (
    <Dialog.Popup className={`${overlay.popup} ${styles.popup}`} data-testid="strip-dialog">
      <Header title={m.strip_title()} />
      {loading ? (
        <div className={styles.dialogBody}>
          <p className={styles.description} role="status">
            {m.strip_checking()}
          </p>
        </div>
      ) : (
        <StripForm doc={doc} findings={findings} partial={failed} />
      )}
    </Dialog.Popup>
  );
}

function StripForm({
  doc,
  findings,
  partial,
}: {
  readonly doc: VirtualDocument;
  readonly findings: ReturnType<typeof mergeFindings>;
  readonly partial: boolean;
}) {
  const [strip, setStrip] = useState<MetadataStrip>(() => initialStrip(findings, doc.metadata));
  const primaryRef = useRef<HTMLButtonElement>(null);
  // Focus the action once the checklist replaces the checking state.
  useEffect(() => primaryRef.current?.focus(), []);
  const anything = Object.values(strip).some(Boolean);
  const onSubmit = (event: SyntheticEvent) => {
    event.preventDefault();
    const changed = commit(
      (ws) => setMetadataStrip(ws, doc.id, anything ? strip : undefined),
      anything ? m.history_strip_metadata() : m.history_keep_metadata(),
    );
    closeDocumentDialog();
    if (changed) {
      announce(
        anything
          ? m.announce_metadata_stripped({ items: stripSummary(strip) })
          : m.announce_metadata_kept(),
      );
    }
  };
  return (
    <form className={styles.dialogBody} onSubmit={onSubmit}>
      <Dialog.Description className={styles.description}>
        {m.strip_description()}
      </Dialog.Description>
      {partial ? <p className={styles.hint}>{m.strip_partial()}</p> : null}
      <fieldset className={styles.checklist}>
        <legend className={styles.dialogLabel}>{m.strip_found()}</legend>
        {STRIP_ITEMS.map((item) => {
          const found = findingFor(item.key, findings, doc.metadata);
          return (
            <label
              key={item.key}
              className={styles.check}
              data-found={found.count > 0 || undefined}
            >
              <input
                type="checkbox"
                checked={strip[item.key]}
                onChange={(event) => setStrip((s) => ({ ...s, [item.key]: event.target.checked }))}
              />
              <span>
                {item.label()}{' '}
                <span className={styles.count} data-testid={`strip-count-${item.key}`}>
                  {found.count > 0
                    ? m.strip_found_count({ count: formatNumber(found.count) })
                    : m.strip_none_found()}
                </span>
                <span className={styles.hint}>
                  {found.names && found.names.length > 0
                    ? found.names.slice(0, 8).join(', ') + (found.names.length > 8 ? ', …' : '')
                    : item.hint()}
                </span>
              </span>
            </label>
          );
        })}
      </fieldset>
      <p className={styles.hint}>{m.strip_kept_note()}</p>
      <div className={styles.actions}>
        <Dialog.Close className={styles.secondary}>{m.common_cancel()}</Dialog.Close>
        <button ref={primaryRef} type="submit" className={styles.primary}>
          {anything ? m.strip_apply() : m.strip_keep()}
        </button>
      </div>
    </form>
  );
}
