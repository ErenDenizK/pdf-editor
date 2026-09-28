/**
 * Wire protocol between `createPdfiumProxy` (caller thread) and `pdfium.worker.ts` (ADR-0011
 * §1): the viewer's PDFium engine in our own worker. As in the assembler and compress
 * protocols, failures travel as values (Comlink drops `EngineError.code`), progress as a
 * Comlink proxy (released by the worker after the call) and cancellation as a message on a
 * transferred MessagePort (AbortSignals cannot be cloned).
 */
import type { FontFallbackConfig } from '@embedpdf/engines';
import type { SourceId } from '@pdf-editor/document-model';

import type {
  Annotation,
  AnnotationConformanceReport,
  AnnotationFinalizeRequest,
  EngineCallOptions,
  EngineErrorCode,
  FormField,
  NewAnnotation,
  OpenedDocument,
  OpenOptions,
  RenderOptions,
  RenderResult,
  SaveOptions,
  SearchHit,
  SearchOptions,
  SourceInspection,
  TextRun,
  VerificationExpectation,
  VerificationResult,
} from '../types';

export interface PdfiumWorkerConfig {
  /** Absolute URL of `pdfium.wasm` (the proxy resolves relative URLs on the caller side). */
  readonly wasmUrl: string;
  /**
   * Self-hosted fallback fonts; `null`/omitted disables fallback. Must be cloneable: URL
   * entries and `baseUrl` work, a `fontLoader` function does not.
   */
  readonly fontFallback?: FontFallbackConfig | null;
}

export type Wire<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: EngineErrorCode; readonly message: string };

/** Call options minus what cannot cross a thread boundary. */
export type WireCallOptions = Omit<EngineCallOptions, 'signal'>;
export type WireOpenOptions = Omit<OpenOptions, 'signal'>;
export type WireRenderOptions = Omit<RenderOptions, 'signal'>;
export type WireSearchOptions = Omit<SearchOptions, 'signal' | 'onProgress'>;
export type WireSaveOptions = Omit<SaveOptions, 'signal'>;

/**
 * The caller's `SourceInspector` (in the app: the assembly worker's proxy), reached from the
 * PDFium worker through a Comlink proxy. Bytes are transferred both ways.
 */
export interface InspectorBridge {
  inspect(bytes: ArrayBuffer, password?: string): Promise<Wire<SourceInspection>>;
  finalizeAnnotations(
    bytes: ArrayBuffer,
    request: AnnotationFinalizeRequest,
  ): Promise<Wire<ArrayBuffer>>;
  checkAnnotations(
    bytes: ArrayBuffer,
    options: { readonly ids?: readonly string[]; readonly password?: string },
  ): Promise<Wire<AnnotationConformanceReport>>;
}

/** Which optional `SourceInspector` methods the bridged inspector has. */
export interface InspectorCapabilities {
  readonly finalizeAnnotations: boolean;
  readonly checkAnnotations: boolean;
}

/** One method per `PdfiumAdapter` method; `abortPort` receives `PDFIUM_ABORT_MESSAGE`. */
export interface PdfiumWorkerApi {
  configure(
    config: PdfiumWorkerConfig,
    inspector?: InspectorBridge,
    capabilities?: InspectorCapabilities,
  ): void;
  open(
    id: SourceId,
    bytes: ArrayBuffer,
    options: WireOpenOptions,
    abortPort?: MessagePort,
  ): Promise<Wire<OpenedDocument>>;
  close(id: SourceId): Promise<Wire<null>>;
  /** The bitmap is transferred to the caller. */
  renderPage(
    id: SourceId,
    pageIndex: number,
    options: WireRenderOptions,
    abortPort?: MessagePort,
  ): Promise<Wire<RenderResult>>;
  getPageText(
    id: SourceId,
    pageIndex: number,
    options: WireCallOptions,
    abortPort?: MessagePort,
  ): Promise<Wire<readonly TextRun[]>>;
  /** Every `onProgress` call has been delivered when the reply arrives. */
  search(
    id: SourceId,
    query: string,
    options: WireSearchOptions,
    onProgress?: (hits: readonly SearchHit[], pageIndex: number) => void,
    abortPort?: MessagePort,
  ): Promise<Wire<readonly SearchHit[]>>;
  listAnnotations(
    id: SourceId,
    pageIndex: number,
    options: WireCallOptions,
    abortPort?: MessagePort,
  ): Promise<Wire<readonly Annotation[]>>;
  createAnnotation(
    id: SourceId,
    annotation: NewAnnotation,
    options: WireCallOptions,
    abortPort?: MessagePort,
  ): Promise<Wire<Annotation>>;
  updateAnnotation(
    id: SourceId,
    annotation: Annotation,
    options: WireCallOptions,
    abortPort?: MessagePort,
  ): Promise<Wire<Annotation>>;
  deleteAnnotation(
    id: SourceId,
    pageIndex: number,
    annotationId: string,
    options: WireCallOptions,
    abortPort?: MessagePort,
  ): Promise<Wire<null>>;
  getAnnotationAppearance(
    id: SourceId,
    pageIndex: number,
    annotationId: string,
    options: WireCallOptions,
    abortPort?: MessagePort,
  ): Promise<Wire<Blob>>;
  listFormFields(
    id: SourceId,
    options: WireCallOptions,
    abortPort?: MessagePort,
  ): Promise<Wire<readonly FormField[]>>;
  setFormFieldValue(
    id: SourceId,
    name: string,
    value: FormField['value'],
    options: WireCallOptions,
    abortPort?: MessagePort,
  ): Promise<Wire<null>>;
  applyRedactions(
    id: SourceId,
    options: WireCallOptions,
    abortPort?: MessagePort,
  ): Promise<Wire<null>>;
  /** The bytes are transferred to the caller. */
  save(id: SourceId, options: WireSaveOptions, abortPort?: MessagePort): Promise<Wire<ArrayBuffer>>;
  verify(
    bytes: ArrayBuffer,
    expectation: VerificationExpectation,
    options: WireCallOptions,
    abortPort?: MessagePort,
  ): Promise<Wire<VerificationResult>>;
  /** Closes every document and releases the engine; the worker stays usable. */
  destroy(): Promise<void>;
}

export const PDFIUM_ABORT_MESSAGE = 'abort';
