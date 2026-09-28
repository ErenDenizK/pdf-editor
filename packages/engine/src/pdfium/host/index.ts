/**
 * PDFium host (ADR-0011 §2): the only place outside `text-edit/` and `redaction/` that
 * touches the raw PDFium module or EmbedPDF's private state.
 */
export {
  createHostedEngine,
  type HostedEngine,
  type HostedEngineOptions,
  imageDataToBlobConverter,
  initPdfiumModule,
  type RawAccess,
  type RawAccessOptions,
} from './hosted-engine';
export {
  docContext,
  isOpenInExecutor,
  orchestratorQueue,
  type OrchestratorQueue,
  PINNED_EMBEDPDF_VERSION,
  type RawDocContext,
  type RawPageContext,
} from './doc-context';
export { type BufferCall, type PdfiumHeap, PdfiumMemory } from './memory';
export { type LockMode, SourceLocks } from './source-lock';
