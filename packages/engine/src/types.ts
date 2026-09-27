/**
 * Engine contracts. UI and model code depend only on these interfaces; adapters for
 * PDFium, pdf-lib and qpdf implement them (ADR-0002). All methods are asynchronous and
 * cancellable via AbortSignal because every adapter runs in a Web Worker.
 */

import type {
  DestinationView,
  DocumentMetadata,
  Rect,
  Rotation,
  SecurityPolicy,
  Size,
  SourceFlags,
  SourceId,
  VirtualDocument,
} from '@pdf-editor/document-model';

// ---------------------------------------------------------------------------
// Common
// ---------------------------------------------------------------------------

export interface EngineCallOptions {
  readonly signal?: AbortSignal;
  /** Higher runs first inside the adapter's scheduler; thumbnails use low priority. */
  readonly priority?: 'high' | 'normal' | 'low';
}

export type ProgressCallback = (done: number, total: number) => void;

export class EngineError extends Error {
  constructor(
    readonly code: EngineErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'EngineError';
  }
}

export type EngineErrorCode =
  | 'password-required'
  | 'password-incorrect'
  | 'unsupported-encryption'
  | 'corrupt'
  | 'unsupported'
  | 'out-of-memory'
  | 'aborted'
  | 'internal';

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

export interface OpenOptions extends EngineCallOptions {
  readonly password?: string;
}

/**
 * Outline as the engine sees it: destinations are page indices inside the source.
 * The document model maps these to PageIds when the source is added to a workspace.
 */
export interface EngineOutlineNode {
  readonly title: string;
  readonly destination?:
    | { readonly kind: 'page'; readonly pageIndex: number; readonly view?: DestinationView }
    | { readonly kind: 'uri'; readonly uri: string }
    | { readonly kind: 'unresolved'; readonly reason: string };
  readonly open: boolean;
  readonly children: readonly EngineOutlineNode[];
}

export interface OpenedDocument {
  readonly id: SourceId;
  readonly pageCount: number;
  /** Per page: unrotated size, intrinsic /Rotate, and page label when the document has labels. */
  readonly pages: readonly {
    readonly size: Size;
    readonly rotation: Rotation;
    readonly label?: string;
  }[];
  readonly fingerprint: string;
  readonly flags: SourceFlags;
  readonly metadata: DocumentMetadata;
  readonly outline: readonly EngineOutlineNode[];
}

// ---------------------------------------------------------------------------
// Rendering and text (read-only)
// ---------------------------------------------------------------------------

export interface RenderOptions extends EngineCallOptions {
  /** Device scale: 1 = 72 dpi. Thumbnails use small values; printing uses 300/72. */
  readonly scale: number;
  /** Extra rotation applied on top of the page's intrinsic rotation. */
  readonly rotation?: Rotation;
  /** Render only this rectangle (user space) — used for tiling large zooms. */
  readonly clip?: Rect;
  readonly withAnnotations?: boolean;
  readonly withForms?: boolean;
  readonly background?: 'white' | 'transparent';
}

export interface RenderResult {
  /** Transferred to the caller; the adapter must not retain it. */
  readonly bitmap: ImageBitmap;
  readonly width: number;
  readonly height: number;
}

export interface Glyph {
  readonly text: string;
  /** Glyph box in unrotated page user space. */
  readonly rect: Rect;
  readonly fontSize: number;
  readonly fontName?: string;
}

export interface TextRun {
  readonly text: string;
  readonly rect: Rect;
  readonly glyphs: readonly Glyph[];
}

export interface SearchHit {
  readonly pageIndex: number;
  readonly rects: readonly Rect[];
  readonly context: string;
}

export interface PdfRenderer {
  /** Open bytes. The ArrayBuffer is transferred to the worker and must not be reused. */
  open(id: SourceId, bytes: ArrayBuffer, options?: OpenOptions): Promise<OpenedDocument>;
  close(id: SourceId): Promise<void>;
  renderPage(id: SourceId, pageIndex: number, options: RenderOptions): Promise<RenderResult>;
  getPageText(
    id: SourceId,
    pageIndex: number,
    options?: EngineCallOptions,
  ): Promise<readonly TextRun[]>;
  search(
    id: SourceId,
    query: string,
    options?: EngineCallOptions & { readonly matchCase?: boolean; readonly wholeWord?: boolean },
  ): Promise<readonly SearchHit[]>;
}

// ---------------------------------------------------------------------------
// Content editing (annotations, forms, redaction) on a source document
// ---------------------------------------------------------------------------

export type AnnotationKind =
  | 'highlight'
  | 'underline'
  | 'strikeout'
  | 'squiggly'
  | 'ink'
  | 'square'
  | 'circle'
  | 'line'
  | 'polygon'
  | 'polyline'
  | 'free-text'
  | 'text'
  | 'stamp'
  | 'link'
  | 'redact';

export interface AnnotationBase {
  readonly id: string;
  readonly kind: AnnotationKind;
  readonly pageIndex: number;
  readonly rect: Rect;
  readonly color?: string;
  readonly interiorColor?: string;
  readonly opacity?: number;
  readonly author?: string;
  readonly contents?: string;
  readonly modified?: string;
  readonly flags?: {
    readonly hidden?: boolean;
    readonly print?: boolean;
    readonly locked?: boolean;
  };
}

export interface MarkupAnnotation extends AnnotationBase {
  readonly kind: 'highlight' | 'underline' | 'strikeout' | 'squiggly' | 'redact';
  readonly quads: readonly Rect[];
}

export interface InkAnnotation extends AnnotationBase {
  readonly kind: 'ink';
  readonly paths: readonly (readonly { readonly x: number; readonly y: number }[])[];
  readonly strokeWidth: number;
}

export interface ShapeAnnotation extends AnnotationBase {
  readonly kind: 'square' | 'circle' | 'line' | 'polygon' | 'polyline';
  readonly strokeWidth: number;
  readonly vertices?: readonly { readonly x: number; readonly y: number }[];
}

export interface FreeTextAnnotation extends AnnotationBase {
  readonly kind: 'free-text';
  readonly text: string;
  readonly fontSize: number;
  readonly fontFamily?: string;
  readonly textColor?: string;
}

export interface NoteAnnotation extends AnnotationBase {
  readonly kind: 'text';
  readonly icon?: string;
  readonly open?: boolean;
}

export interface StampAnnotation extends AnnotationBase {
  readonly kind: 'stamp';
  readonly imageBlob?: Blob;
  readonly name?: string;
}

export interface LinkAnnotation extends AnnotationBase {
  readonly kind: 'link';
  readonly uri?: string;
  readonly targetPageIndex?: number;
}

export type Annotation =
  | MarkupAnnotation
  | InkAnnotation
  | ShapeAnnotation
  | FreeTextAnnotation
  | NoteAnnotation
  | StampAnnotation
  | LinkAnnotation;

/**
 * `Omit` distributed over a union. The built-in `Omit<Union, K>` collapses the union to its
 * common keys, which would erase kind-specific fields such as `quads` or `paths`.
 */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An annotation to be created; the engine assigns the id. */
export type NewAnnotation = DistributiveOmit<Annotation, 'id'>;

export type FormFieldKind =
  | 'text'
  | 'checkbox'
  | 'radio'
  | 'combobox'
  | 'listbox'
  | 'button'
  | 'signature'
  | 'unknown';

export interface FormField {
  readonly name: string;
  readonly kind: FormFieldKind;
  readonly pageIndex: number;
  readonly rect: Rect;
  readonly value?: string | readonly string[] | boolean;
  readonly options?: readonly string[];
  readonly readOnly: boolean;
  readonly required: boolean;
}

export interface SaveOptions extends EngineCallOptions {
  /** Append-only save preserving prior revisions (signed documents). */
  readonly incremental?: boolean;
  readonly flattenAnnotations?: boolean;
  readonly flattenForms?: boolean;
  readonly removeSecurity?: boolean;
}

export interface PdfEditor {
  listAnnotations(
    id: SourceId,
    pageIndex: number,
    options?: EngineCallOptions,
  ): Promise<readonly Annotation[]>;
  createAnnotation(
    id: SourceId,
    annotation: NewAnnotation,
    options?: EngineCallOptions,
  ): Promise<Annotation>;
  updateAnnotation(
    id: SourceId,
    annotation: Annotation,
    options?: EngineCallOptions,
  ): Promise<Annotation>;
  deleteAnnotation(
    id: SourceId,
    pageIndex: number,
    annotationId: string,
    options?: EngineCallOptions,
  ): Promise<void>;

  listFormFields(id: SourceId, options?: EngineCallOptions): Promise<readonly FormField[]>;
  setFormFieldValue(
    id: SourceId,
    name: string,
    value: FormField['value'],
    options?: EngineCallOptions,
  ): Promise<void>;

  /** Removes content under the given redact annotations. Forces a full rewrite on save. */
  applyRedactions(id: SourceId, options?: EngineCallOptions): Promise<void>;

  /** Serialize the (edited) source. Result bytes are transferred to the caller. */
  save(id: SourceId, options?: SaveOptions): Promise<ArrayBuffer>;
}

// ---------------------------------------------------------------------------
// Assembly: virtual document -> bytes (pdf-lib adapter)
// ---------------------------------------------------------------------------

export interface AssemblyInput {
  /**
   * The document exactly as it should be written. The assembler writes what it is given:
   * callers pass `labels` already derived for every page (`deriveLabelRanges` when
   * `needsPageLabels`, else `[]` so no /PageLabels is written) and an outline without
   * unresolved leaves (`dropUnresolved`).
   */
  readonly document: VirtualDocument;
  /** Bytes for every source referenced by the document (already edited/saved by PdfEditor). */
  readonly sources: ReadonlyMap<SourceId, ArrayBuffer>;
  /** Image blobs referenced by image pages and overlays. */
  readonly blobs: ReadonlyMap<string, ArrayBuffer>;
  /**
   * Human-readable name per source (e.g. the file name without extension), used for form
   * field namespaces. Falls back to the source id.
   */
  readonly sourceNames?: ReadonlyMap<SourceId, string>;
}

export interface AssemblyOptions extends EngineCallOptions {
  readonly onProgress?: ProgressCallback;
  /** Emit PDF 1.4-compatible output: no object streams, no xref streams. */
  readonly compatibility?: boolean;
  readonly security?: SecurityPolicy;
}

export interface ReconciliationReport {
  readonly outlineNodesKept: number;
  readonly outlineNodesDropped: number;
  readonly linksRewritten: number;
  readonly linksDropped: number;
  readonly formFieldsRenamed: readonly { readonly from: string; readonly to: string }[];
  /**
   * Fully-qualified names under which fields from several sources were joined into one
   * field sharing the first source's value (`unify-same-name` policy).
   */
  readonly formFieldsUnified: readonly string[];
  readonly structureTreeRemoved: boolean;
  readonly xfaRemoved: boolean;
  readonly warnings: readonly string[];
}

export interface AssemblyResult {
  readonly bytes: ArrayBuffer;
  readonly report: ReconciliationReport;
}

export interface PdfAssembler {
  assemble(input: AssemblyInput, options?: AssemblyOptions): Promise<AssemblyResult>;
}

// ---------------------------------------------------------------------------
// Inspection: document facts the rendering engine does not report (pdf-lib adapter)
// ---------------------------------------------------------------------------

export interface SourceInspection {
  /** One label per page when the file has /PageLabels; undefined otherwise. */
  readonly pageLabels?: readonly string[];
  /** Catalog /Lang, when present. */
  readonly language?: string;
}

export interface InspectOptions extends EngineCallOptions {
  readonly password?: string;
}

export interface SourceInspector {
  /** Reads `bytes` without mutating them. Never rejects for damaged files; returns `{}`. */
  inspect(bytes: ArrayBuffer, options?: InspectOptions): Promise<SourceInspection>;
}

// ---------------------------------------------------------------------------
// Plumbing: repair, normalize, linearize, crypto fallback (qpdf adapter, M3)
// ---------------------------------------------------------------------------

export interface PlumberOptions extends EngineCallOptions {
  readonly linearize?: boolean;
  readonly objectStreams?: 'preserve' | 'generate' | 'disable';
  readonly recompressFlate?: boolean;
  readonly removeUnreferencedResources?: boolean;
  readonly decrypt?: { readonly password?: string };
  readonly encrypt?: SecurityPolicy;
}

export interface PlumberResult {
  readonly bytes: ArrayBuffer;
  readonly repaired: boolean;
  readonly warnings: readonly string[];
}

export interface PdfPlumber {
  process(bytes: ArrayBuffer, options?: PlumberOptions): Promise<PlumberResult>;
}

// ---------------------------------------------------------------------------
// Verification: re-parse an export and check invariants before offering download
// ---------------------------------------------------------------------------

export interface VerificationExpectation {
  readonly pageCount: number;
  readonly pageSizes: readonly Size[];
  /** Regions (page index + rect) that must contain no extractable text after redaction. */
  readonly redactedRegions?: readonly { readonly pageIndex: number; readonly rect: Rect }[];
  /** Per-page rotation (/Rotate after export), when given. */
  readonly rotations?: readonly Rotation[];
  /** Total number of outline items (all levels), when given. */
  readonly outlineCount?: number;
  /** Outline titles in pre-order (depth first), when given. */
  readonly outlineTitles?: readonly string[];
  /**
   * Page label per page, when given; `null` expects no /PageLabels at all. Read through the
   * verifier's `SourceInspector`; without one, a given expectation is reported as unverifiable.
   */
  readonly pageLabels?: readonly string[] | null;
  /** Fully-qualified form field names (any order), when given. */
  readonly formFieldNames?: readonly string[];
}

export interface VerificationResult {
  readonly ok: boolean;
  readonly problems: readonly string[];
}

export interface PdfVerifier {
  verify(
    bytes: ArrayBuffer,
    expectation: VerificationExpectation,
    options?: EngineCallOptions,
  ): Promise<VerificationResult>;
}

// ---------------------------------------------------------------------------
// Capability discovery (ADR-0007: capability detection, not platform detection)
// ---------------------------------------------------------------------------

export interface EngineCapabilities {
  readonly render: boolean;
  readonly edit: boolean;
  readonly assemble: boolean;
  readonly plumb: boolean;
  readonly ocr: boolean;
  readonly threads: boolean;
  readonly maxHeapBytes: number;
}
