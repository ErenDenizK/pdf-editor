export * from './types';

export {
  PdfiumAdapter,
  type PdfiumAdapterOptions,
  type PdfiumEngineFactory,
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
