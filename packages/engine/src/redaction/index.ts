/**
 * Redaction post-pass and forensic self-check (spec redaction-and-text-editing.md §1.2,
 * research 06 §3–4). The engine pass that removes page content runs before this, in a
 * private PDFium; see `scrub.ts` for the order of the whole pipeline.
 */

export { forensicCheck, type ForensicOptions } from './forensic';
export {
  type ScrubOptions,
  type ScrubResult,
  type ScrubStep,
  scrubRedactedDocument,
} from './scrub';
export { normalizeForMatch, RedactedStringMatcher } from './strings';
