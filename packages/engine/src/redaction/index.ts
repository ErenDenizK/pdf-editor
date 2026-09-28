/**
 * Redaction (spec redaction-and-text-editing.md §1.2, research 06 §3–4): the engine pass on
 * the hosted PDFium (private scratch documents), the pdf-lib post-pass, the blank-region
 * gate, the forensic self-check, and the export hooks. `applyRedactions` (apply.ts) runs the
 * whole pipeline.
 */

export {
  applyRedactions,
  MIN_CAPTURED_LENGTH,
  RedactionFailedError,
  type RedactionFailure,
} from './apply';
export { type EnginePassOptions, engineRedact } from './engine-pass';
export { type RedactionHost, withForensicDeps } from './engine-session';
export { type RedactionExportPlan, redactionExportPlan, redactionPlanOf } from './export-hooks';

export { forensicCheck, type ForensicOptions } from './forensic';
export {
  type ScrubOptions,
  type ScrubResult,
  type ScrubStep,
  fillRedactionAreas,
  scrubRedactedDocument,
} from './scrub';
export { normalizeForMatch, RedactedStringMatcher } from './strings';
export { mergeForensicReports, verifyRedactedOutput } from './verify-output';
