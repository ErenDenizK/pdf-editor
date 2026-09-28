/**
 * Words for OCR states (spec recognize-and-compare §1.3), shared by the dialog, the right
 * panel's OCR section and the export summary. Functions, so they read the active language.
 */
import type { OcrQuality } from '@pdf-editor/engine';

import { m } from '../i18n';

/** "Good", "Review", "Poor", "No text found". */
export function qualityLabel(quality: OcrQuality): string {
  switch (quality) {
    case 'good':
      return m.ocr_quality_good();
    case 'review':
      return m.ocr_quality_review();
    case 'poor':
      return m.ocr_quality_poor();
    case 'no-text':
      return m.ocr_quality_no_text();
  }
}

/** What a quality means, for the panel's explanation. */
export function qualityExplanation(quality: OcrQuality): string {
  switch (quality) {
    case 'good':
      return m.ocr_quality_good_explanation();
    case 'review':
      return m.ocr_quality_review_explanation();
    case 'poor':
      return m.ocr_quality_poor_explanation();
    case 'no-text':
      return m.ocr_quality_no_text_explanation();
  }
}
