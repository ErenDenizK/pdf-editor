/**
 * The Inspector's OCR section (spec recognize-and-compare §1.3): for the page in view (or the
 * one selected page), its quality (Good / Review / Poor / No text found), languages,
 * resolution and the low-confidence words as rows; J / K or a click focuses a word, which is
 * ringed on the page (OcrLayer.tsx). Below, the document's recognised pages by quality, worst
 * first; a click goes to the page. Everything is read from the model's `ocr.apply` edits, so
 * undo and redo change it with the document. Shown while the active document has recognised
 * pages or a run on it is in progress.
 */
import { useEffect } from 'react';

import { formatNumber, formatPercent, getLocale, m } from '../i18n';
import { useSelectionStore } from '../state/selection-store';
import { useViewStore } from '../state/view-store';
import { useActiveDocument, useWorkspaceStore } from '../state/workspace-store';
import { pageProgress, qualityExplanation, qualityLabel } from './labels';
import styles from './Ocr.module.css';
import {
  countByQuality,
  documentHasOcr,
  documentQualityRows,
  languageList,
  lowConfidenceRows,
  type OcrPageRecord,
  ocrRecords,
  QUALITY_ORDER,
} from './ocr-model';
import { focusOcrWord, sectionPageOf } from './ocr-review';
import { setOcrFocus, useOcrStore } from './ocr-store';
import { useOcrThresholds } from './ocr-thresholds';

/** Whether the active document shows the section. */
export function useHasOcrSection(): boolean {
  const doc = useActiveDocument();
  const edits = useWorkspaceStore((s) => s.workspace.engineEdits);
  const running = useOcrStore((s) => s.run.kind === 'running' && s.run.documentId === doc?.id);
  return doc !== undefined && (running || documentHasOcr(edits, doc));
}

const percent = (value: number) => formatPercent(Math.round(value) / 100);

export function OcrSection() {
  const ws = useWorkspaceStore((s) => s.workspace);
  const selected = useSelectionStore((s) => s.selected);
  const currentPage = useViewStore((s) => s.currentPage);
  const focus = useOcrStore((s) => s.focus);
  const run = useOcrStore((s) => s.run);
  const thresholds = useOcrThresholds();
  const section = thresholds && sectionPageOf(ws, selected, currentPage, thresholds);
  const records = thresholds
    ? ocrRecords(ws.engineEdits, thresholds)
    : new Map<string, OcrPageRecord>();
  const doc = section?.doc;
  const docRows = doc ? documentQualityRows(doc, records) : [];
  const pageId = section?.page.id;
  const record = section?.record;
  const rows = record && thresholds ? lowConfidenceRows(record, thresholds) : [];
  const locale = getLocale();

  // The ring follows the section: leaving the page (or its text changing) clears it.
  const stale =
    focus !== null && (focus.pageId !== pageId || !rows.some((row) => row.index === focus.word));
  useEffect(() => {
    if (stale) setOcrFocus(null);
  }, [stale]);

  if (!section) return null;
  const pageNumber = section.docIndex + 1;
  const counts = countByQuality(docRows);
  return (
    <div className={styles.section} data-testid="ocr-section">
      {run.kind === 'running' && run.documentId === section.doc.id ? (
        <p className={styles.empty} role="status">
          {run.phase === 'recheck'
            ? m.ocr_phase_recheck(pageProgress(run))
            : m.ocr_phase_recognize(pageProgress(run))}
        </p>
      ) : null}
      <h3 className={styles.subTitle}>{m.ocr_section_page({ page: pageNumber })}</h3>
      {record ? (
        <>
          <dl className={styles.facts}>
            <dt>{m.ocr_section_quality()}</dt>
            <dd data-testid="ocr-quality" data-quality={record.quality}>
              {qualityLabel(record.quality)}
              {record.words.length > 0 ? ` · ${percent(record.meanConfidence)}` : ''}
            </dd>
            <dt>{m.ocr_section_languages()}</dt>
            <dd>{languageList(record.languages, locale)}</dd>
            {record.dpi !== undefined ? (
              <>
                <dt>{m.ocr_section_dpi()}</dt>
                <dd>{m.ocr_dpi({ dpi: formatNumber(record.dpi) })}</dd>
              </>
            ) : null}
            <dt>{m.ocr_section_words()}</dt>
            <dd>{formatNumber(record.words.length)}</dd>
          </dl>
          <p className={styles.empty}>{qualityExplanation(record.quality)}</p>
          {rows.length > 0 ? (
            <ul
              className={styles.rows}
              aria-label={m.ocr_section_low_words_label({ page: pageNumber })}
              data-testid="ocr-low-words"
            >
              {rows.map((row) => (
                <li key={row.index}>
                  <button
                    type="button"
                    className={styles.rowButton}
                    aria-current={focus?.pageId === pageId && focus?.word === row.index}
                    onClick={() => focusOcrWord(section, row)}
                  >
                    <span className={styles.word}>{row.text}</span>
                    <span className={styles.meta}>{percent(row.confidence)}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : record.words.length > 0 ? (
            <p className={styles.empty}>{m.ocr_no_low_words()}</p>
          ) : null}
        </>
      ) : (
        <p className={styles.empty} data-testid="ocr-no-layer">
          {m.ocr_section_no_layer({ page: pageNumber })}
        </p>
      )}
      {docRows.length > 0 ? (
        <>
          <h3 className={styles.subTitle}>{m.ocr_section_document()}</h3>
          <p className={styles.empty}>
            {QUALITY_ORDER.filter((q) => counts[q] > 0)
              .map((q) => `${qualityLabel(q)}: ${formatNumber(counts[q])}`)
              .join(' · ')}
          </p>
          <ul className={styles.rows} aria-label={m.ocr_section_document()}>
            {docRows.map((row) => (
              <li key={row.pageId}>
                <button
                  type="button"
                  className={styles.rowButton}
                  aria-current={row.pageId === pageId}
                  onClick={() => useViewStore.getState().scrollToPage(row.pageId)}
                >
                  <span>{m.ocr_section_page({ page: row.docIndex + 1 })}</span>
                  <span className={styles.meta}>
                    {qualityLabel(row.record.quality)}
                    {row.record.words.length > 0 ? ` · ${percent(row.record.meanConfidence)}` : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
