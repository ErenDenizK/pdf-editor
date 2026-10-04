export * from './types';

export {
  PdfiumAdapter,
  type PdfiumAdapterOptions,
  type PdfiumEngineFactory,
  type RawTaskRunner,
  type FontFallbackConfig,
} from './pdfium/pdfium-adapter';
/** Charset keys for a self-hosted `FontFallbackConfig`. */
export { FontCharset } from '@embedpdf/models';

export { PdfLibAssembler, expandTemplate, standardFontFor } from './pdflib/pdflib-assembler';
export {
  anchorOrigin,
  displaySize,
  displayToUser,
  normalizeRotation,
  placeAt,
  placeOverlay,
  tileOrigins,
  type OverlayPlacementInput,
  type Placement,
  type Point,
} from './pdflib/overlay-geometry';
export { formatNumber, labelForIndex, toAlpha, toRoman } from './pdflib/page-labels';
export { inspectSource, permissionsFromP } from './pdflib/inspect';
export { diagnoseSource } from './pdflib/metadata-diagnostics';
export { checkXrefStructure, type XrefCheckResult } from './structure/xref-check';

export { type ExportPlan, type ExportPlanOptions, planExport } from './export-plan';
// Redaction (M4): pdf-lib post-pass after the engine pass, and the forensic self-check.
export {
  forensicCheck,
  type ForensicOptions,
  normalizeForMatch,
  RedactedStringMatcher,
  type ScrubOptions,
  type ScrubResult,
  type ScrubStep,
  scrubRedactedDocument,
  // Part b: the whole apply on the hosted engine, and the export hooks.
  applyRedactions,
  engineRedact,
  type EnginePassOptions,
  fillRedactionAreas,
  mergeForensicReports,
  MIN_CAPTURED_LENGTH,
  RedactionFailedError,
  type RedactionFailure,
  type RedactionExportPlan,
  redactionExportPlan,
  type RedactionHost,
  redactionPlanOf,
  verifyRedactedOutput,
  withForensicDeps,
} from './redaction';

export {
  checkAnnotationConformance,
  checkDocument as checkAnnotationDocument,
  type ConformanceOptions,
  describeProblems as describeConformanceProblems,
} from './annotations/conformance';
export { finalizeAnnotations } from './annotations/finalize';
export { stampLabel } from './annotations/stamp-appearance';
export { NOTE_ICONS, STAMP_NAMES } from './pdfium/annotation-mapping';
export * from './edits';
export { type AssemblerProxy, createAssemblerProxy } from './worker/create-assembler-proxy';
// The viewer's PDFium engine in our own worker (ADR-0011). The worker entry is
// `@pdf-editor/engine/pdfium.worker`; `createHostedEngine` runs the same engine on the
// calling thread (tests, and the home of raw PDFium access for the M4 editors).
export {
  createPdfiumProxy,
  type PdfiumProxy,
  type PdfiumProxyOptions,
} from './worker/pdfium-proxy';
export type { PdfiumWorkerConfig } from './worker/pdfium-protocol';
// Text editing (M4, spec redaction-and-text-editing §2): the `PdfTextEditor` on a hosted
// engine (in the app it runs in the PDFium worker, reached through `PdfiumProxy`) and the
// export post-pass for edited sources.
export {
  createTextEditor,
  finalizeTextEdits,
  type FinalizeTextEditsOptions,
  type FinalizeTextEditsResult,
  HostedTextEditor,
  paragraphRefusalReason,
  type TextEditFailure,
  type TextEditorHost,
  type TextEditorOptions,
  textEditError,
  textEditFailureReason,
} from './text-edit';
// Paragraph layout (craft spec §4.3, §4.6): pure arithmetic, run by the web paragraph
// editor on the main thread at every keystroke (no engine call).
export {
  type LayoutAlign,
  type LayoutEdit,
  type LayoutEditSpan,
  type LayoutInput,
  type LayoutOptions,
  layoutParagraph,
  type LayoutSourceLine,
  type LayoutSpan,
  type LayoutStyle,
} from './text-edit/linebreak';
export {
  decideOverflow,
  MIN_LEADING,
  MIN_WORD_SPACING,
  type OverflowBox,
} from './text-edit/overflow';
// Image objects (M4 §3): the `PdfImageEditor` on a hosted engine (in the app it runs in the
// PDFium worker, reached through `PdfiumProxy`) and the matrix helpers the UI shares.
export {
  applyMatrix,
  createImageEditor,
  effectiveDpi,
  finalizeContentEdits,
  type FinalizeContentEditsResult,
  HostedImageEditor,
  IMAGE_TRANSFORM_TOLERANCE,
  imageBounds,
  type ImageEditFailure,
  type ImageEditorHost,
  imageEditError,
  imageEditFailureReason,
  invertMatrix,
  matrixForRect,
  multiplyMatrix,
} from './image-objects';
export {
  createHostedEngine,
  type HostedEngine,
  type HostedEngineOptions,
  PINNED_EMBEDPDF_VERSION,
  type RawAccess,
  type RawAccessOptions,
} from './pdfium/host';
// Compression, PDF → images and qpdf plumbing (M3). The worker entry is
// `@pdf-editor/engine/compress.worker`; qpdf and PDFium's decoder load only inside it.
export * from './compress';
export * from './rasterize';
export type { PlumberCheckOptions, PlumberCheckResult } from './plumber/qpdf-plumber';
export { type CompressProxy, createCompressProxy } from './worker/create-compress-proxy';
export type {
  CompressRunWireOptions,
  CompressWorkerConfig,
  RasterFile,
} from './worker/compress-protocol';
export type { RasterPageInput, RasterPageSpec, RasterTile } from './rasterize/encode-page';
// Digital signatures (M5 §3, ADR-0013): validation and PAdES-B signing. In the app they run in
// the signature worker (`@pdf-editor/engine/signature.worker`, wrapped by
// `createSignatureProxy`); the functions below are the same code on the calling thread.
export {
  DEFAULT_RESERVE_BYTES,
  PKCS12_REEXPORT_COMMAND,
  type RevisionEnd,
  revisionBytes,
  revisionEnds,
  signPdf,
  validateSignatures,
} from './signatures';
export { createSignatureProxy, type SignatureProxy } from './worker/signature-proxy';
// Compare and convert (M5 §2, §4). In the app they run in the analysis worker
// (`@pdf-editor/engine/analysis.worker`, wrapped by `createAnalysisProxy`), fed with page
// text and renders from the PDFium worker; `createLocalAnalysisBackend` runs the same code
// on the calling thread.
export * from './analysis';
export * from './convert';
export {
  buildComparisonReport,
  buildComparisonReportWithCounts,
  type ComparisonReportCounts,
  type ComparisonReportOptions,
} from './pdflib/compare-report';
export { type AnalysisProxy, createAnalysisProxy } from './worker/create-analysis-proxy';
// OCR (M5 §1, ADR-0012): the recognizer over tesseract.js (main thread; the API is a lazy
// chunk), the language pack loader, the invisible layer writer and the `ocr.apply` edit.
// `PdfOcrLayer` (facts, rasters, the layer) runs in the PDFium worker behind `PdfiumProxy`.
export * from './ocr';
