/**
 * The page the OCR section describes and the review of its low-confidence words with J / K
 * (spec recognize-and-compare §1.3): the single selected page of the active document, else
 * the page Read mode shows. The focused word is brought into view and ringed on its page
 * (OcrLayer.tsx); rows and focus come from the model's `ocr.apply` edits (ocr-model.ts).
 */
import type { VirtualDocument, VirtualPage, Workspace } from '@pdf-editor/document-model';

import { formatNumber, formatPercent, m } from '../i18n';
import { announce } from '../shell/announcer';
import { useSelectionStore } from '../state/selection-store';
import { isNavigatorShowing, isPageView, useUiStore } from '../state/ui-store';
import { useViewStore } from '../state/view-store';
import { useWorkspaceStore } from '../state/workspace-store';
import { useToolStore } from '../viewer/tool-store';
import {
  documentHasOcr,
  lowConfidenceRows,
  type OcrPageRecord,
  type OcrThresholds,
  type OcrWordRow,
  ocrRecords,
  recordKey,
  stepRow,
} from './ocr-model';
import { setOcrFocus, useOcrStore } from './ocr-store';
import { ocrThresholdsNow } from './ocr-thresholds';

/** The page the section shows, and its recognised text when it has any. */
export interface OcrSectionPage {
  readonly doc: VirtualDocument;
  readonly docIndex: number;
  readonly page: VirtualPage;
  readonly record: OcrPageRecord | undefined;
}

export function sectionPageOf(
  ws: Workspace,
  selected: ReadonlySet<string>,
  currentPage: number,
  t: OcrThresholds,
): OcrSectionPage | undefined {
  const doc = ws.activeDocument === undefined ? undefined : ws.documents[ws.activeDocument];
  if (!doc || doc.pages.length === 0) return undefined;
  const picked = doc.pages.flatMap((p, i) => (selected.has(p.id) ? [i] : []));
  const docIndex =
    picked.length === 1 ? (picked[0] as number) : Math.min(currentPage, doc.pages.length - 1);
  const page = doc.pages[docIndex];
  if (!page) return undefined;
  const record =
    page.ref.kind === 'source'
      ? ocrRecords(ws.engineEdits, t).get(recordKey(page.ref.source, page.ref.index))
      : undefined;
  return { doc, docIndex, page, record };
}

function currentSectionPage(t: OcrThresholds): OcrSectionPage | undefined {
  return sectionPageOf(
    useWorkspaceStore.getState().workspace,
    useSelectionStore.getState().selected,
    useViewStore.getState().currentPage,
    t,
  );
}

/** Focuses a word row: ring on the page, the page scrolled so the word is in view. */
export function focusOcrWord(section: OcrSectionPage, row: OcrWordRow): void {
  const { page, record } = section;
  if (!record) return;
  setOcrFocus({
    pageId: page.id,
    source: record.source,
    pageIndex: record.pageIndex,
    word: row.index,
    rect: row.rect,
  });
  useViewStore.getState().scrollToPage(page.id, { reveal: row.rect });
}

/** Whether J / K review OCR words: Read mode, the panel open, a page with such words. */
export function reviewingOcr(): boolean {
  const ui = useUiStore.getState();
  if (!isPageView(ui) || !ui.rightPanelOpen) return false;
  // The Redactions panel's review keeps J / K while it is open or the Redact tool is on.
  if (isNavigatorShowing(ui, 'redactions')) return false;
  if (useToolStore.getState().mode === 'redact') return false;
  const t = ocrThresholdsNow();
  if (!t) return false;
  const section = currentSectionPage(t);
  if (!section?.record) return false;
  if (!documentHasOcr(useWorkspaceStore.getState().workspace.engineEdits, section.doc)) {
    return false;
  }
  return lowConfidenceRows(section.record, t).length > 0;
}

/** J / K: the next or previous low-confidence word of the section's page. */
export function stepOcrWord(delta: 1 | -1): boolean {
  const t = ocrThresholdsNow();
  if (!t) return false;
  const section = currentSectionPage(t);
  if (!section?.record) return false;
  const rows = lowConfidenceRows(section.record, t);
  const focus = useOcrStore.getState().focus;
  const current =
    focus?.pageId === section.page.id ? rows.findIndex((r) => r.index === focus.word) : -1;
  const next = rows[stepRow(rows.length, current, delta)];
  if (!next) {
    announce(m.ocr_no_low_words());
    return false;
  }
  focusOcrWord(section, next);
  announce(
    m.ocr_word_announce({
      index: formatNumber(rows.indexOf(next) + 1),
      total: formatNumber(rows.length),
      word: next.text,
      confidence: formatPercent(Math.round(next.confidence) / 100),
    }),
  );
  return true;
}
