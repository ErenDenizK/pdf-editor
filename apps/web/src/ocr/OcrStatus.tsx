/**
 * The status bar's OCR progress (spec recognize-and-compare §1.5): "Recognizing text 3/12"
 * while a run works, also with its dialog closed; a click opens the dialog again (progress
 * and Cancel).
 */
import { formatNumber, m } from '../i18n';
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
        {m.ocr_status({ done: formatNumber(run.done), total: formatNumber(run.total) })}
      </button>
    </>
  );
}
