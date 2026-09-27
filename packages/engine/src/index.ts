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
export { inspectSource } from './pdflib/inspect';
export { checkXrefStructure, type XrefCheckResult } from './structure/xref-check';

export { type ExportPlan, type ExportPlanOptions, planExport } from './export-plan';
export { type AssemblerProxy, createAssemblerProxy } from './worker/create-assembler-proxy';
