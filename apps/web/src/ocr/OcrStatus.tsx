/**
 * The status bar's OCR progress (spec recognize-and-compare §1.5): "Recognizing text: 3 of 12
 * pages" while a run works, also with its dialog closed; a click opens the dialog again
 * (progress and Cancel). A redaction, text or image edit on a page the run has read makes it
 * read that page again, which the status bar says ("Recognizing changed pages again").
 */
import { m } from '../i18n';
import { pageProgress } from './labels';
import styles from './Ocr.module.css';
import { openOcrDialog, useOcrStore } from './ocr-store';

export function OcrStatus({ separator }: { readonly separator: string | undefined }) {
  const run = useOcrStore((s) => s.run);
  if (run.kind !== 'running') return null;
  return (
    <>
      <span className={separator} aria-hidden="true">
        ·
      </span>
      <button
        type="button"
        className={styles.status}
        data-testid="status-ocr"
        onClick={() => openOcrDialog(run.documentId)}
      >
        {run.phase === 'recheck'
          ? m.ocr_status_recheck(pageProgress(run))
          : m.ocr_status(pageProgress(run))}
      </button>
    </>
  );
}
