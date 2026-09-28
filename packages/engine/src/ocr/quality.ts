/**
 * Page quality and the run report (spec §1.3, thresholds from spike S1, research 07 §7):
 * the mean confidence of the kept words decides Good / Review / Poor; no kept word is
 * "No text found". Pure functions, shared by the recognizer and the UI.
 */
import {
  OCR_QUALITY_THRESHOLDS,
  type OcrPageFacts,
  type OcrPageResult,
  type OcrQuality,
  type OcrReport,
} from '../types';

export function ocrQuality(meanConfidence: number, keptWords: number): OcrQuality {
  if (keptWords === 0) return 'no-text';
  if (meanConfidence >= OCR_QUALITY_THRESHOLDS.good) return 'good';
  if (meanConfidence >= OCR_QUALITY_THRESHOLDS.review) return 'review';
  return 'poor';
}

export function meanConfidence(words: readonly { readonly confidence: number }[]): number {
  if (words.length === 0) return 0;
  return words.reduce((sum, w) => sum + w.confidence, 0) / words.length;
}

/** The summary of a finished run (history label, export summary, the dialog's result). */
export function ocrReportOf(
  pages: readonly OcrPageResult[],
  options: { readonly totalMs?: number } = {},
): OcrReport {
  const byQuality: Record<OcrQuality, number> = { good: 0, review: 0, poor: 0, 'no-text': 0 };
  const languages: string[] = [];
  let words = 0;
  let lowConfidence = 0;
  let dropped = 0;
  let timedOut = 0;
  let recognizeMs = 0;
  for (const page of pages) {
    byQuality[page.quality]++;
    for (const code of page.languages) if (!languages.includes(code)) languages.push(code);
    words += page.words.length;
    lowConfidence += page.lowConfidence;
    dropped += page.dropped;
    if (page.timedOut) timedOut++;
    recognizeMs += page.durationMs;
  }
  return {
    pages: pages.length,
    languages,
    quality: pages.map((p) => ({ pageIndex: p.pageIndex, quality: p.quality })),
    byQuality,
    words,
    lowConfidence,
    dropped,
    timedOut,
    recognizeMs: Math.round(recognizeMs),
    ...(options.totalMs === undefined ? {} : { totalMs: Math.round(options.totalMs) }),
  };
}

/**
 * The DPI to render a page at (spec §1.2): High = 400; Standard = the largest image's
 * effective DPI clamped to 200–400 on scans, else 300.
 */
export function ocrDpiFor(
  facts: Pick<OcrPageFacts, 'imageDpi'> | undefined,
  quality: 'standard' | 'high' = 'standard',
): number {
  if (quality === 'high') return 400;
  const dpi = facts?.imageDpi;
  return dpi === undefined ? 300 : Math.min(400, Math.max(200, dpi));
}
