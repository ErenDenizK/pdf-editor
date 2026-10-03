/**
 * Text editing on the PDFium host (spec redaction-and-text-editing §2, research 05, ADR-0011):
 * `PdfTextEditor` (locate runs, check editability, apply tier 2 / tier 1 edits with
 * read-back verification) and the export post-pass `finalizeTextEdits`; paragraph detection
 * (`detectParagraphs`, craft spec §4.1) behind `PdfTextEditor.analyzeParagraphs`; the
 * paragraph writer (`applyParagraphEdit`, craft spec §4.4) behind `PdfParagraphEditor`.
 */
export {
  analyzePageParagraphs,
  detectParagraphs,
  fontFamily,
  type PageGeometry,
  ParagraphCache,
  pageFingerprint,
  runRefusal,
} from './blocks';
export {
  createTextEditor,
  HostedTextEditor,
  type TextEditorHost,
  type TextEditorOptions,
} from './editor';
export { type TextEditFailure, textEditError, textEditFailureReason } from './errors';
export {
  finalizeTextEdits,
  type FinalizeTextEditsOptions,
  type FinalizeTextEditsResult,
} from './finalize';
export {
  classifyLayout,
  layoutEditOf,
  PARAGRAPH_BOX_TOLERANCE,
  PARAGRAPH_ORIGIN_TOLERANCE,
  ParagraphWriter,
} from './paragraph-edit';
export { paragraphRefusalReason } from './paragraph-input';
