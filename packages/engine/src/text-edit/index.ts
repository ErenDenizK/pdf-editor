/**
 * Text editing on the PDFium host (spec redaction-and-text-editing §2, research 05, ADR-0011):
 * `PdfTextEditor` (locate runs, check editability, apply tier 2 / tier 1 edits with
 * read-back verification) and the export post-pass `finalizeTextEdits`.
 */
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
