/**
 * Export dialog (ARCHITECTURE.md §4): the options in sections (document-tools spec §8):
 * Output (file name, compatibility mode), Security (effective password outcome, override),
 * Annotations (flatten, comments as popups; spec viewer-annotations.md §6), Forms
 * (flatten), Compression, Metadata (policy) and Signature (existing signatures, "Sign the
 * exported file"; spec recognize-and-compare §3.2), then assembly, verification and signing
 * with progress, then the reconciliation summary — what was kept, rewritten,
 * renamed or removed — and only then the Save/Download button (a fresh click, which the
 * save picker needs as user activation). Styled as the password dialog.
 */
import { Dialog } from '@base-ui/react/dialog';
import type { DocumentId } from '@pdf-editor/document-model';
import { X } from 'lucide-react';
import {
  type ReactNode,
  type RefObject,
  type SyntheticEvent,
  useEffect,
  useRef,
  useState,
} from 'react';

import { formatBytes } from '../files/file-filters';
import {
  ExportMetadataSection,
  ExportSecuritySection,
  type SecurityChoice,
} from '../document/ExportSections';
import { DocumentDialogs } from '../document/DocumentDialogs';
import { useFormStore } from '../forms/form-store';
import { m } from '../i18n';
import { announce } from '../shell/announcer';
import { CompressionExportRow } from '../tools/CompressionExportRow';
import overlay from '../shell/ShortcutOverlay.module.css';
import { ExportSignatureSection } from '../signatures/ExportSignatureSection';
import { activeSignDraft, openSignDialog, useSignStore } from '../signatures/sign-store';
import { SignDialog } from '../signatures/SignDialog';
import { pagesPhrase, useWorkspaceStore } from '../state/workspace-store';
import { useRetained } from '../ui/use-retained';
import { deliverPdf, supportsSavePicker } from './deliver';
import styles from './ExportDialog.module.css';
import { closeExportDialog, useExportDialogStore } from './export-store';
import { type ExportProgress, type PreparedExport, prepareExport } from './export-service';
import { exportFileName } from './filename';
import { summarizeReport } from './summary';

type Step =
  | { readonly kind: 'form' }
  | { readonly kind: 'working'; readonly progress: ExportProgress | null }
  | { readonly kind: 'review'; readonly prepared: PreparedExport }
  | { readonly kind: 'failed'; readonly message: string; readonly problems: readonly string[] };

export function ExportDialog() {
  const documentId = useExportDialogStore((s) => s.documentId);
  // Keep the popup mounted while it animates closed (see useRetained).
  const [shownId, release] = useRetained(documentId);
  return (
    <Dialog.Root
      open={documentId !== null}
      onOpenChange={(open) => {
        if (!open) closeExportDialog();
      }}
      onOpenChangeComplete={(open) => {
        if (!open) release();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className={overlay.backdrop} />
        {shownId !== null ? <ExportFlow key={shownId} documentId={shownId} /> : null}
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function progressText(progress: ExportProgress | null, pageCount: number): string {
  if (progress === null || progress.phase === 'reading') return m.export_progress_reading();
  if (progress.phase === 'redaction') return m.export_progress_redaction();
  if (progress.phase === 'signing') return m.export_progress_signing();
  if (progress.phase === 'assembling') {
    return m.export_progress_assembling({
      done: Math.min(progress.done, progress.total),
      total: progress.total,
    });
  }
  return m.export_progress_verifying({ pages: pagesPhrase(pageCount) });
}

function progressValue(progress: ExportProgress | null): number {
  if (progress === null) return 0;
  const share = progress.total > 0 ? progress.done / progress.total : 0;
  // Reading 0–10 %, assembling 10–85 %, verifying 85–100 %.
  if (progress.phase === 'reading') return 10 * share;
  if (progress.phase === 'assembling') return 10 + 75 * share;
  if (progress.phase === 'redaction' || progress.phase === 'signing') return 95 + 5 * share;
  return 85 + 10 * share;
}

function ExportFlow({ documentId }: { readonly documentId: DocumentId }) {
  const doc = useWorkspaceStore((s) => s.workspace.documents[documentId]);
  const title = doc?.title ?? m.export_default_name();
  const pageCount = doc?.pages.length ?? 0;
  const [fileName, setFileName] = useState(() => exportFileName(title));
  const [compatibility, setCompatibility] = useState(false);
  const [flattenAnnotations, setFlattenAnnotations] = useState(false);
  const [includeComments, setIncludeComments] = useState(true);
  const [securityChoice, setSecurityChoice] = useState<SecurityChoice>('document');
  // "Flatten on export" is shared with the Forms panel (forms/form-store.ts).
  const flattenForms = useFormStore((s) => s.flattenOnExport);
  // Source AcroForms, or fields created in the app (their Flatten option is the same).
  const hasForms = useWorkspaceStore(
    (s) =>
      (doc?.fields?.length ?? 0) > 0 ||
      (doc?.pages ?? []).some(
        (p) => p.ref.kind === 'source' && s.workspace.sources[p.ref.source]?.flags.hasAcroForm,
      ),
  );
  const signOn = useSignStore((s) => s.signOnExport[documentId] === true);
  const encryptedOutput = securityChoice !== 'none' && doc?.security !== undefined;
  const [step, setStep] = useState<Step>({ kind: 'form' });
  const controller = useRef<AbortController | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);

  // Abort a running export when the dialog goes away.
  useEffect(() => () => controller.current?.abort(), []);
  // Move focus to the step's main action.
  useEffect(() => {
    if (step.kind === 'review' || step.kind === 'failed') primaryRef.current?.focus();
  }, [step.kind]);

  const start = async (event: SyntheticEvent) => {
    event.preventDefault();
    setFileName((name) => exportFileName(name));
    const sign = activeSignDraft(documentId);
    if (signOn && !sign) {
      // "Sign the exported file" without a certificate yet: choose one first.
      openSignDialog(documentId, 'export');
      return;
    }
    const abort = new AbortController();
    controller.current = abort;
    setStep({ kind: 'working', progress: null });
    const result = await prepareExport(documentId, {
      compatibility,
      flattenAnnotations,
      flattenForms: hasForms && flattenForms,
      includeComments,
      ...(securityChoice === 'none' ? { security: null } : {}),
      ...(sign ? { sign } : {}),
      signal: abort.signal,
      onProgress: (progress) => {
        if (!abort.signal.aborted) setStep({ kind: 'working', progress });
      },
    });
    if (abort.signal.aborted) return;
    controller.current = null;
    if (!result.ok) {
      setStep({ kind: 'failed', message: result.error.message, problems: [] });
    } else if (result.value.redaction && !result.value.redaction.report.ok) {
      // A leak the self-check can see blocks the download (spec §1.2 step 5).
      setStep({
        kind: 'failed',
        message: m.export_failed_redaction(),
        problems: result.value.verification.problems,
      });
    } else if (!result.value.verification.ok) {
      setStep({
        kind: 'failed',
        message: m.export_failed_verification(),
        problems: result.value.verification.problems,
      });
    } else {
      setStep({ kind: 'review', prepared: result.value });
      announce(m.announce_export_ready());
    }
  };

  const cancel = () => {
    controller.current?.abort();
    controller.current = null;
    setStep({ kind: 'form' });
    announce(m.announce_export_cancelled());
  };

  const save = async (prepared: PreparedExport) => {
    const name = exportFileName(fileName);
    try {
      const outcome = await deliverPdf(prepared.bytes, name);
      if (outcome === 'cancelled') return;
      closeExportDialog();
      announce(outcome === 'saved' ? m.announce_saved({ name }) : m.announce_downloaded({ name }));
    } catch (error) {
      setStep({
        kind: 'failed',
        message: m.export_save_failed({
          reason: error instanceof Error ? error.message : String(error),
        }),
        problems: [],
      });
    }
  };

  const sourceCount = new Set(
    (doc?.pages ?? []).flatMap((p) => (p.ref.kind === 'source' ? [p.ref.source] : [])),
  ).size;

  return (
    <Dialog.Popup
      className={`${overlay.popup} ${styles.popup}`}
      initialFocus={nameRef}
      data-testid="export-dialog"
    >
      <div className={overlay.header}>
        <Dialog.Title className={overlay.title}>{m.export_document()}</Dialog.Title>
        <Dialog.Close className={overlay.close} aria-label={m.common_close()}>
          <X aria-hidden="true" />
        </Dialog.Close>
      </div>

      {step.kind === 'form' ? (
        <form className={styles.body} onSubmit={(event) => void start(event)}>
          <Dialog.Description className={styles.description}>
            {m.export_description({
              pages: pagesPhrase(pageCount),
              files: m.files_count({ count: sourceCount }),
            })}
          </Dialog.Description>
          <ExportSection title={m.export_section_output()}>
            <label className={styles.field}>
              <span className={styles.label}>{m.export_file_name()}</span>
              <input
                ref={nameRef}
                className={styles.input}
                value={fileName}
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => setFileName(event.target.value)}
              />
            </label>
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={compatibility}
                onChange={(event) => setCompatibility(event.target.checked)}
              />
              <span>
                {m.export_compatibility()}
                <span className={styles.hint}>{m.export_compatibility_hint()}</span>
              </span>
            </label>
          </ExportSection>
          {doc ? (
            <ExportSection title={m.export_security()}>
              <ExportSecuritySection
                doc={doc}
                choice={securityChoice}
                onChoice={setSecurityChoice}
              />
            </ExportSection>
          ) : null}
          <ExportSection title={m.export_section_annotations()}>
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={flattenAnnotations}
                onChange={(event) => setFlattenAnnotations(event.target.checked)}
              />
              <span>
                {m.export_flatten_annotations()}
                <span className={styles.hint}>{m.export_flatten_annotations_hint()}</span>
              </span>
            </label>
            <label className={styles.check}>
              <input
                type="checkbox"
                // Flattened annotations have no comments left to show.
                checked={includeComments && !flattenAnnotations}
                disabled={flattenAnnotations}
                onChange={(event) => setIncludeComments(event.target.checked)}
              />
              <span>
                {m.export_include_comments()}
                <span className={styles.hint}>{m.export_include_comments_hint()}</span>
              </span>
            </label>
          </ExportSection>
          {/* Forms: the flatten option (forms engineer, forms/form-store.ts). */}
          {hasForms ? (
            <ExportSection title={m.export_section_forms()}>
              <label className={styles.check}>
                <input
                  type="checkbox"
                  checked={flattenForms}
                  onChange={(e) => useFormStore.getState().setFlattenOnExport(e.target.checked)}
                />
                <span>{m.export_flatten_forms()}</span>
              </label>
            </ExportSection>
          ) : null}
          <ExportSection title={m.export_section_compression()}>
            <CompressionExportRow documentId={documentId} className={styles.description} />
          </ExportSection>
          {doc ? (
            <ExportSection title={m.export_section_metadata()}>
              <ExportMetadataSection doc={doc} />
            </ExportSection>
          ) : null}
          {doc ? (
            <ExportSection title={m.export_section_signature()}>
              <ExportSignatureSection
                doc={doc}
                encryptedOutput={encryptedOutput}
                checkClassName={styles.check}
                hintClassName={styles.hint}
              />
            </ExportSection>
          ) : null}
          <div className={styles.actions}>
            <Dialog.Close className={styles.secondary}>{m.common_cancel()}</Dialog.Close>
            <button type="submit" className={styles.primary} disabled={pageCount === 0}>
              {m.export_start()}
            </button>
          </div>
        </form>
      ) : null}

      {step.kind === 'working' ? (
        <div className={styles.body}>
          <p className={styles.description} role="status">
            {progressText(step.progress, pageCount)}
          </p>
          <progress
            className={styles.progress}
            max={100}
            value={progressValue(step.progress)}
            aria-label={m.export_progress_label()}
          />
          <div className={styles.actions}>
            <button type="button" className={styles.secondary} onClick={cancel}>
              {m.common_cancel()}
            </button>
          </div>
        </div>
      ) : null}

      {step.kind === 'review' ? (
        <ReviewStep
          prepared={step.prepared}
          fileName={exportFileName(fileName)}
          primaryRef={primaryRef}
          onBack={() => setStep({ kind: 'form' })}
          onSave={() => void save(step.prepared)}
        />
      ) : null}

      {step.kind === 'failed' ? (
        <div className={styles.body}>
          <p className={styles.error} role="alert" data-testid="export-failed">
            {step.message}
          </p>
          {step.problems.length > 0 ? (
            <ul className={styles.problems} data-testid="export-problems">
              {step.problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          ) : null}
          <div className={styles.actions}>
            <Dialog.Close className={styles.secondary}>{m.common_close()}</Dialog.Close>
            <button
              ref={primaryRef}
              type="button"
              className={styles.primary}
              onClick={() => setStep({ kind: 'form' })}
            >
              {m.common_back()}
            </button>
          </div>
        </div>
      ) : null}
      {/* Set password / Strip metadata opened from the sections nest in this dialog. */}
      <DocumentDialogs origin="export" />
      <SignDialog origin="export" />
    </Dialog.Popup>
  );
}

/**
 * One section of the export form (spec document-tools.md §8): Output, Security,
 * Annotations, Forms, Compression, Metadata. A section is a fieldset with a legend, so
 * adding an option is one line inside the right section.
 */
function ExportSection({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <fieldset className={styles.section}>
      <legend className={styles.sectionTitle}>{title}</legend>
      {children}
    </fieldset>
  );
}

function ReviewStep({
  prepared,
  fileName,
  primaryRef,
  onBack,
  onSave,
}: {
  readonly prepared: PreparedExport;
  readonly fileName: string;
  readonly primaryRef: RefObject<HTMLButtonElement | null>;
  readonly onBack: () => void;
  readonly onSave: () => void;
}) {
  const items = summarizeReport(prepared.report, prepared.sourceNotes, prepared.outcome, {
    ...(prepared.redaction ? { redaction: prepared.redaction } : {}),
    ...(prepared.textEdits ? { textEdits: prepared.textEdits } : {}),
    ...(prepared.ocr ? { ocr: prepared.ocr } : {}),
    ...(prepared.signature ? { signature: prepared.signature } : {}),
    ...(prepared.signaturesRemoved ? { signaturesRemoved: prepared.signaturesRemoved } : {}),
  });
  const seconds = (prepared.durationMs / 1000).toFixed(1);
  return (
    <div className={styles.body}>
      <p className={styles.description}>
        <span className={styles.fileName}>{fileName}</span> ·{' '}
        <span className={styles.numeric}>
          {pagesPhrase(prepared.pageCount)} · {formatBytes(prepared.bytes.byteLength)}
        </span>
      </p>
      <p className={styles.verified} data-testid="export-verified">
        {m.export_verified({ seconds })}
      </p>
      {prepared.compression ? (
        <CompressionExportRow className={styles.verified} result={prepared.compression} />
      ) : null}
      {items.length > 0 ? (
        <ul className={styles.summary} aria-label={m.export_summary_label()}>
          {items.map((item) => (
            <li key={item.id} data-tone={item.tone} data-summary-item={item.id}>
              {item.text}
              {item.details && item.details.length > 0 ? (
                <details className={styles.details}>
                  <summary>{m.export_show_details({ count: item.details.length })}</summary>
                  <ul>
                    {item.details.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.description}>{m.export_nothing_changed()}</p>
      )}
      <div className={styles.actions}>
        <button type="button" className={styles.secondary} onClick={onBack}>
          {m.common_back()}
        </button>
        <button ref={primaryRef} type="button" className={styles.primary} onClick={onSave}>
          {supportsSavePicker() ? m.export_save() : m.export_download()}
        </button>
      </div>
    </div>
  );
}
