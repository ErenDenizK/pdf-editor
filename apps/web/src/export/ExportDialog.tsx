/**
 * Export dialog (ARCHITECTURE.md §4): file name and compatibility mode, then assembly and
 * verification with progress, then the reconciliation summary — what was kept, rewritten,
 * renamed or removed — and only then the Save/Download button (a fresh click, which the
 * save picker needs as user activation). Styled as the password dialog.
 */
import { Dialog } from '@base-ui/react/dialog';
import type { DocumentId } from '@pdf-editor/document-model';
import { X } from 'lucide-react';
import { type RefObject, type SyntheticEvent, useEffect, useRef, useState } from 'react';

import { formatBytes } from '../files/file-filters';
import { announce } from '../shell/announcer';
import overlay from '../shell/ShortcutOverlay.module.css';
import { pagesPhrase, useWorkspaceStore } from '../state/workspace-store';
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
  return (
    <Dialog.Root
      open={documentId !== null}
      onOpenChange={(open) => {
        if (!open) closeExportDialog();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className={overlay.backdrop} />
        {documentId !== null ? <ExportFlow key={documentId} documentId={documentId} /> : null}
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function progressText(progress: ExportProgress | null, pageCount: number): string {
  if (progress === null || progress.phase === 'reading') return 'Reading source files…';
  if (progress.phase === 'assembling') {
    return `Assembling page ${Math.min(progress.done, progress.total)} of ${progress.total}…`;
  }
  return `Checking the output (${pagesPhrase(pageCount)})…`;
}

function progressValue(progress: ExportProgress | null): number {
  if (progress === null) return 0;
  const share = progress.total > 0 ? progress.done / progress.total : 0;
  // Reading 0–10 %, assembling 10–85 %, verifying 85–100 %.
  if (progress.phase === 'reading') return 10 * share;
  if (progress.phase === 'assembling') return 10 + 75 * share;
  return 85 + 15 * share;
}

function ExportFlow({ documentId }: { readonly documentId: DocumentId }) {
  const doc = useWorkspaceStore((s) => s.workspace.documents[documentId]);
  const title = doc?.title ?? 'document';
  const pageCount = doc?.pages.length ?? 0;
  const [fileName, setFileName] = useState(() => exportFileName(title));
  const [compatibility, setCompatibility] = useState(false);
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
    const abort = new AbortController();
    controller.current = abort;
    setStep({ kind: 'working', progress: null });
    const result = await prepareExport(documentId, {
      compatibility,
      signal: abort.signal,
      onProgress: (progress) => {
        if (!abort.signal.aborted) setStep({ kind: 'working', progress });
      },
    });
    if (abort.signal.aborted) return;
    controller.current = null;
    if (!result.ok) {
      setStep({ kind: 'failed', message: result.error.message, problems: [] });
    } else if (!result.value.verification.ok) {
      setStep({
        kind: 'failed',
        message: 'The exported file did not pass verification, so it is not offered for download.',
        problems: result.value.verification.problems,
      });
    } else {
      setStep({ kind: 'review', prepared: result.value });
      announce('Export ready to save');
    }
  };

  const cancel = () => {
    controller.current?.abort();
    controller.current = null;
    setStep({ kind: 'form' });
    announce('Export cancelled');
  };

  const save = async (prepared: PreparedExport) => {
    const name = exportFileName(fileName);
    try {
      const outcome = await deliverPdf(prepared.bytes, name);
      if (outcome === 'cancelled') return;
      closeExportDialog();
      announce(outcome === 'saved' ? `Saved ${name}` : `Downloaded ${name}`);
    } catch (error) {
      setStep({
        kind: 'failed',
        message: `Could not save the file: ${error instanceof Error ? error.message : String(error)}`,
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
        <Dialog.Title className={overlay.title}>Export document</Dialog.Title>
        <Dialog.Close className={overlay.close} aria-label="Close">
          <X aria-hidden="true" />
        </Dialog.Close>
      </div>

      {step.kind === 'form' ? (
        <form className={styles.body} onSubmit={(event) => void start(event)}>
          <Dialog.Description className={styles.description}>
            {pagesPhrase(pageCount)} from {sourceCount === 1 ? '1 file' : `${sourceCount} files`}.
            The file is built and checked on this device; nothing is uploaded.
          </Dialog.Description>
          <label className={styles.field}>
            <span className={styles.label}>File name</span>
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
              Compatibility mode (PDF 1.4, no object streams)
              <span className={styles.hint}>For old readers and printers. Larger file.</span>
            </span>
          </label>
          <div className={styles.actions}>
            <Dialog.Close className={styles.secondary}>Cancel</Dialog.Close>
            <button type="submit" className={styles.primary} disabled={pageCount === 0}>
              Export
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
            aria-label="Export progress"
          />
          <div className={styles.actions}>
            <button type="button" className={styles.secondary} onClick={cancel}>
              Cancel
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
          <p className={styles.error} role="alert">
            {step.message}
          </p>
          {step.problems.length > 0 ? (
            <ul className={styles.problems}>
              {step.problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          ) : null}
          <div className={styles.actions}>
            <Dialog.Close className={styles.secondary}>Close</Dialog.Close>
            <button
              ref={primaryRef}
              type="button"
              className={styles.primary}
              onClick={() => setStep({ kind: 'form' })}
            >
              Back
            </button>
          </div>
        </div>
      ) : null}
    </Dialog.Popup>
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
  const items = summarizeReport(prepared.report);
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
        Verified: re-opened in a fresh engine; page count, sizes, rotation, labels and bookmarks
        match ({seconds} s).
      </p>
      {items.length > 0 ? (
        <ul className={styles.summary} aria-label="What changed on export">
          {items.map((item) => (
            <li key={item.id} data-tone={item.tone}>
              {item.text}
              {item.details && item.details.length > 0 ? (
                <details className={styles.details}>
                  <summary>Show {item.details.length}</summary>
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
        <p className={styles.description}>Nothing had to be changed or removed.</p>
      )}
      <div className={styles.actions}>
        <button type="button" className={styles.secondary} onClick={onBack}>
          Back
        </button>
        <button ref={primaryRef} type="button" className={styles.primary} onClick={onSave}>
          {supportsSavePicker() ? 'Save…' : 'Download'}
        </button>
      </div>
    </div>
  );
}
