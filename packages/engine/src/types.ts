/**
 * Engine contracts. UI and model code depend only on these interfaces; adapters for
 * PDFium, pdf-lib and qpdf implement them (ADR-0002). All methods are asynchronous and
 * cancellable via AbortSignal because every adapter runs in a Web Worker.
 */

import type {
  DestinationView,
  DocumentMetadata,
  MetadataStrip,
  PermissionFlags,
  Rect,
  Rotation,
  SecurityHandler,
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
    /**
     * The effective CropBox in unrotated user space (lower-left origin). Glyph rects, search
     * hits, annotation rects and render clips are absolute user space, so a viewer mapping
     * them onto the rendered (cropped) page subtracts `cropBox.x` / `cropBox.y`. Absent when
     * the engine does not report page boxes (then the crop starts at (0, 0)).
     */
    readonly cropBox?: Rect;
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
  /** Text around the match: some characters before, the match, some after. */
  readonly context: string;
  /** Offset of the match in `context`. */
  readonly matchStart?: number;
  /** Length of the match in `context`. */
  readonly matchLength?: number;
}

export interface SearchOptions extends EngineCallOptions {
  readonly matchCase?: boolean;
  readonly wholeWord?: boolean;
  /**
   * Called once per searched page, in page order, as soon as that page is done (also for
   * pages without hits, so callers can show progress). The final result still contains
   * every hit.
   */
  readonly onProgress?: (hits: readonly SearchHit[], pageIndex: number) => void;
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
  search(id: SourceId, query: string, options?: SearchOptions): Promise<readonly SearchHit[]>;
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

/** Line ending styles (/LE, ISO 32000-2 Table 179). An arrow is a line with `open-arrow`. */
export type LineEnding =
  | 'none'
  | 'square'
  | 'circle'
  | 'diamond'
  | 'open-arrow'
  | 'closed-arrow'
  | 'butt'
  | 'r-open-arrow'
  | 'r-closed-arrow'
  | 'slash';

export interface ShapeAnnotation extends AnnotationBase {
  readonly kind: 'square' | 'circle' | 'line' | 'polygon' | 'polyline';
  readonly strokeWidth: number;
  /** Line: [start, end]. Polygon / polyline: the vertices. Square / circle: unused. */
  readonly vertices?: readonly { readonly x: number; readonly y: number }[];
  /** Line and polyline only; absent = none at both ends. */
  readonly lineEndings?: { readonly start?: LineEnding; readonly end?: LineEnding };
}

export interface FreeTextAnnotation extends AnnotationBase {
  readonly kind: 'free-text';
  /**
   * The text shown (and written to /Contents, so `contents` mirrors it). Latin-1 /
   * WinAnsi only for now: other characters are refused (`unsupported`), see the README.
   */
  readonly text: string;
  readonly fontSize: number;
  readonly fontFamily?: string;
  readonly textColor?: string;
}

export interface NoteAnnotation extends AnnotationBase {
  readonly kind: 'text';
  /** Icon name (/Name): Comment, Note, Help, Insert, Key, NewParagraph, Paragraph. */
  readonly icon?: string;
  /** Whether the note's popup is open (/Popup /Open); written by `save()`. */
  readonly open?: boolean;
}

export interface StampAnnotation extends AnnotationBase {
  readonly kind: 'stamp';
  /**
   * The appearance: a PNG or JPEG image, or a one-page PDF whose page becomes the
   * appearance (`application/pdf`, as returned by `PdfiumAdapter.getAnnotationAppearance`).
   * Listing does not return it (it would render every stamp); ask for it when needed.
   */
  readonly imageBlob?: Blob;
  /**
   * Named stamp (/Name), e.g. `Approved`, `Draft`, `Confidential`. Without an `imageBlob`
   * the engine generates a text-only appearance showing the name (see STAMP_NAMES).
   */
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

/**
 * An annotation to be created. Without `id` the engine assigns one; with `id` the engine
 * writes it as the annotation's /NM (used by undo/redo and replay to restore the same id).
 * The id must be unique within the document; creating a duplicate id fails.
 */
export type NewAnnotation = DistributiveOmit<Annotation, 'id'> & { readonly id?: string };

export type FormFieldKind =
  | 'text'
  | 'checkbox'
  | 'radio'
  | 'combobox'
  | 'listbox'
  | 'button'
  | 'signature'
  | 'unknown';

/** One widget (on-page appearance) of a form field. */
export interface FormFieldWidget {
  readonly pageIndex: number;
  /** Widget /Rect in unrotated user space (like annotation rects). */
  readonly rect: Rect;
  /**
   * Checkbox / radio: the value this widget stands for when it is on (the /Opt entry for
   * its state when the field has /Opt, else its appearance state name, e.g. `Yes`).
   */
  readonly exportValue?: string;
}

/**
 * A signature on a signature field, as far as the engine can read it. Never validated:
 * presence of these facts says nothing about the signature's integrity.
 */
export interface FormFieldSignature {
  /** Signer name (/Name), when the engine exposes it. */
  readonly signer?: string;
  /** Signing time (/M) as the PDF wrote it (`D:YYYYMMDDHHmmSS…`) or ISO 8601. */
  readonly date?: string;
  readonly reason?: string;
}

/**
 * A form field (all widgets sharing a fully-qualified name). Values:
 * text → string; checkbox → boolean; radio → the selected export value (undefined when
 * none is on); combo box → the selected option; list box → the selected option, or every
 * selected option when `multiSelect`.
 */
export interface FormField {
  readonly name: string;
  readonly kind: FormFieldKind;
  /** Page and rect of the first widget (see `widgets` for all of them). */
  readonly pageIndex: number;
  readonly rect: Rect;
  readonly value?: string | readonly string[] | boolean;
  /**
   * Choices: combo / list box options (display labels), radio export values in widget
   * order. What `value` holds and what `setFormFieldValue` accepts.
   */
  readonly options?: readonly string[];
  /**
   * The value exported for each of `options` (same order). Radio: the export values
   * themselves. Combo / list box: the display labels (EmbedPDF 2.15 does not expose /Opt
   * export pairs). Checkbox: its on state(s).
   */
  readonly exportValues?: readonly string[];
  readonly readOnly: boolean;
  readonly required: boolean;
  /** Alternate field name (/TU), meant for display. */
  readonly tooltip?: string;
  /** Text: /Ff multiline. */
  readonly multiline?: boolean;
  /** Text: /Ff password. */
  readonly password?: boolean;
  /** Text: /Ff comb (characters spread over `maxLength` cells). */
  readonly comb?: boolean;
  /** Text: /MaxLen when the widget carries it. */
  readonly maxLength?: number;
  /** List box: /Ff MultiSelect. */
  readonly multiSelect?: boolean;
  /** Combo box: /Ff Edit (free text allowed). */
  readonly editable?: boolean;
  /** Every widget of the field, in page order then /Annots order. */
  readonly widgets?: readonly FormFieldWidget[];
  /** Signature fields: what the engine read about a signature, when one is present. */
  readonly signature?: FormFieldSignature;
}

export interface SaveOptions extends EngineCallOptions {
  /** Append-only save preserving prior revisions (signed documents). */
  readonly incremental?: boolean;
  /**
   * Bake annotation appearances into the page content and remove the annotations (links
   * and popups excepted: links stay interactive, popups go with their parents).
   */
  readonly flattenAnnotations?: boolean;
  readonly flattenForms?: boolean;
  readonly removeSecurity?: boolean;
  /**
   * Write comment popups (default true): notes and markup annotations with text get a
   * /Popup annotation. `false` removes every /Popup from the output; the text stays in
   * /Contents.
   */
  readonly includeComments?: boolean;
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

  /**
   * Optional: the appearance of one annotation as a one-page PDF (`application/pdf`), e.g.
   * to recreate a deleted stamp through `createAnnotation({ ..., imageBlob })`.
   */
  getAnnotationAppearance?(
    id: SourceId,
    pageIndex: number,
    annotationId: string,
    options?: EngineCallOptions,
  ): Promise<Blob>;
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
  /**
   * What "Strip metadata" removed (`DocumentMetadata.strip`), as counts per item; absent
   * when nothing was to be stripped.
   */
  readonly metadataStripped?: MetadataStripReport;
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
  /**
   * Outline items in pre-order (depth first, as `OpenedDocument.outline` lists them): the
   * open state (/Count > 0) and, for /XYZ destinations, which of left/top/zoom are given
   * (PDFium reports absent values as 0, which is also a valid coordinate).
   */
  readonly outline?: readonly OutlineItemFacts[];
  /**
   * Open state of the popups of note (/Text) annotations, per page. `index` is the
   * position in the page's /Annots; `nm` the note's /NM when it has one.
   */
  readonly noteStates?: readonly NoteStateFact[];
  /** Custom (non-standard) text keys of the Info dictionary, name without slash → text. */
  readonly customInfo?: Readonly<Record<string, string>>;
  /** The /Encrypt dictionary's facts, for encrypted files. */
  readonly encryption?: EncryptionFacts;
}

export interface OutlineItemFacts {
  readonly open: boolean;
  /** Present for explicit or named /XYZ destinations: `null` = keep current. */
  readonly xyz?: {
    readonly left: number | null;
    readonly top: number | null;
    readonly zoom: number | null;
  };
}

/** Facts of a standard security handler's /Encrypt dictionary (ISO 32000-2 §7.6.4). */
export interface EncryptionFacts {
  readonly handler: SecurityHandler;
  /** /Filter, e.g. `Standard`. */
  readonly filter: string;
  readonly v: number;
  readonly r: number;
  /** Key length in bits, when stated or implied. */
  readonly keyBits?: number;
  /** What /P allows (absent when /P is missing). */
  readonly permissions?: PermissionFlags;
}
export interface NoteStateFact {
  readonly pageIndex: number;
  readonly index: number;
  readonly nm?: string;
  readonly open: boolean;
}

/** What `PdfEditor.save()` asks the annotation post-pass (annotations/finalize.ts) to do. */
export interface AnnotationFinalizeRequest {
  /** /NM of the annotations created or updated since open: they get /P, /M, /F Print. */
  readonly touched: readonly string[];
  /** Popup open state per note /NM (notes not listed keep their popup's state). */
  readonly noteOpen: Readonly<Record<string, boolean>>;
  /** Opacity per annotation /NM the engine could not write (stamps): /CA + ExtGState. */
  readonly opacity: Readonly<Record<string, number>>;
  /** See `SaveOptions.includeComments`. */
  readonly includeComments: boolean;
  /** Modification date for annotations lacking /M, as an ISO string. */
  readonly now: string;
  readonly password?: string;
}

export interface InspectOptions extends EngineCallOptions {
  readonly password?: string;
}

export interface SourceInspector {
  /** Reads `bytes` without mutating them. Never rejects for damaged files; returns `{}`. */
  inspect(bytes: ArrayBuffer, options?: InspectOptions): Promise<SourceInspection>;
  /**
   * Optional: the document tools' diagnostics (spec document-tools.md §7) and what "Strip
   * metadata" would find. `bytes` may be transferred. Never rejects for damaged files: the
   * result then carries what could be read and a warning.
   */
  diagnose?(bytes: ArrayBuffer, options?: InspectOptions): Promise<SourceDiagnostics>;
  /**
   * Optional: runs the annotation post-pass of `PdfEditor.save()` off the caller's thread
   * (the assembly worker). `bytes` may be transferred. Without it the adapter runs the same
   * code in its own thread.
   */
  finalizeAnnotations?(
    bytes: ArrayBuffer,
    request: AnnotationFinalizeRequest,
    options?: EngineCallOptions,
  ): Promise<ArrayBuffer>;
  /**
   * Optional: `checkAnnotationConformance` off the caller's thread (used by the verifier).
   * `bytes` may be transferred.
   */
  checkAnnotations?(
    bytes: ArrayBuffer,
    options?: { readonly ids?: readonly string[]; readonly password?: string },
    callOptions?: EngineCallOptions,
  ): Promise<AnnotationConformanceReport>;
}

/** Rules of `checkAnnotationConformance` (annotations/conformance.ts documents each). */
export type AnnotationConformanceRule =
  | 'ap'
  | 'rect'
  | 'quad-points'
  | 'page'
  | 'nm'
  | 'print'
  | 'modified'
  | 'opacity'
  | 'blend'
  | 'popup'
  | 'font';

export interface AnnotationConformanceProblem {
  /** -1 for document-wide problems (duplicate /NM, unparseable file). */
  readonly pageIndex: number;
  /** Position in the page's /Annots; -1 for document-wide problems. */
  readonly index: number;
  readonly subtype: string;
  readonly nm?: string;
  readonly rule: AnnotationConformanceRule;
  readonly message: string;
}

/** Result of `checkAnnotationConformance` (annotations/conformance.ts). */
export interface AnnotationConformanceReport {
  readonly ok: boolean;
  /** Annotations per page, widgets and popups excluded. */
  readonly counts: readonly number[];
  readonly problems: readonly AnnotationConformanceProblem[];
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
  /** User (open) password of an encrypted output; the verifier opens it with this. */
  readonly password?: string;
  /**
   * Expected number of annotations per output page index, counting what
   * `PdfEditor.listAnnotations` reports except links (the assembler may drop links whose
   * target is not exported). Pages not listed are not checked.
   */
  readonly annotationCounts?: Readonly<Record<number, number>>;
  /** Run `checkAnnotationConformance` on the output (annotations were edited). */
  readonly checkAnnotations?: boolean;
  /**
   * With `checkAnnotations`: report conformance problems only for these /NM values (the
   * annotations this app wrote); other annotations come from the sources as they were.
   */
  readonly annotationIds?: readonly string[];
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

// ---------------------------------------------------------------------------
// Diagnostics and metadata findings (pdf-lib adapter, spec document-tools.md §3, §7)
// ---------------------------------------------------------------------------

/** Removal counts reported by the assembler for `DocumentMetadata.strip`. */
export interface MetadataStripReport {
  /** Info keys removed (standard and custom), counted over the sources. */
  readonly infoKeys: number;
  /** XMP packets removed (document, pages, images and forms). */
  readonly xmpPackets: number;
  /** Embedded files and file attachment annotations removed. */
  readonly attachments: number;
  /** JavaScript actions, /OpenAction and /AA entries removed. */
  readonly javascript: number;
  readonly pieceInfo: number;
  readonly thumbnails: number;
  /** Annotations whose author or dates were removed. */
  readonly annotationAuthors: number;
  /** The selection that was applied. */
  readonly applied: MetadataStrip;
}

export interface FontFact {
  /** /BaseFont without the subset prefix. */
  readonly name: string;
  /** /Subtype: Type1, TrueType, Type0, Type3, MMType1, … */
  readonly subtype: string;
  readonly embedded: boolean;
  /** The name carries a subset tag (`ABCDEF+`). */
  readonly subset: boolean;
}

export interface ImageFact {
  /** First page (0-based) that draws the image directly, when found. */
  readonly pageIndex?: number;
  readonly width: number;
  readonly height: number;
  /** /Filter of the image stream (last filter), e.g. DCTDecode, FlateDecode. */
  readonly filter?: string;
  /** /ColorSpace name (family for arrays), e.g. DeviceRGB, ICCBased, Indexed. */
  readonly colorSpace?: string;
  readonly bitsPerComponent?: number;
  /**
   * Approximate effective resolution at the first placement found in a page content stream
   * (pixels per inch of the placed size, the lower of both axes); absent when the image is
   * only drawn inside forms or patterns.
   */
  readonly dpi?: number;
}

/** What a source carries that "Strip metadata" can remove (counts; 0 = none found). */
export interface MetadataFindings {
  /** Standard Info keys present (Title, Author, …; Producer included). */
  readonly infoKeys: readonly string[];
  /** Custom Info keys present. */
  readonly customKeys: readonly string[];
  /** XMP packets (document, pages, images, forms). */
  readonly xmpPackets: number;
  /** Embedded files in /Names /EmbeddedFiles plus file attachment annotations. */
  readonly attachments: number;
  /** File names of embedded files (capped). */
  readonly attachmentNames: readonly string[];
  /** JavaScript: name tree entries, JS actions, /OpenAction and /AA entries. */
  readonly javascript: number;
  readonly pieceInfo: number;
  readonly thumbnails: number;
  /** Annotations with an author (/T) or dates (/M, /CreationDate); widgets excluded. */
  readonly annotationAuthors: number;
}

export interface SourceDiagnostics {
  /** Effective version: the header's, raised by catalog /Version; e.g. `1.7`. */
  readonly version: string;
  /** Adobe extension level (/Extensions /ADBE), e.g. 3 for AES-256 on 1.7. */
  readonly extensionLevel?: number;
  readonly pageCount: number;
  readonly encryption?: EncryptionFacts;
  readonly linearized: boolean;
  /** /MarkInfo /Marked true or a /StructTreeRoot. */
  readonly tagged: boolean;
  readonly formType: 'none' | 'acroform' | 'xfa';
  /** Form fields (terminal) in /AcroForm /Fields. */
  readonly formFields: number;
  readonly fonts: {
    readonly total: number;
    readonly embedded: number;
    readonly notEmbedded: number;
    readonly subset: number;
    /** Distinct fonts (capped at 200). */
    readonly list: readonly FontFact[];
  };
  readonly images: {
    readonly count: number;
    /** Distinct image XObjects (capped at 200). */
    readonly list: readonly ImageFact[];
    /** Over images with a DPI estimate; approximate. */
    readonly minDpi?: number;
    readonly medianDpi?: number;
  };
  /** Annotations excluding widgets and popups, by /Subtype. */
  readonly annotations: {
    readonly total: number;
    readonly bySubtype: Readonly<Record<string, number>>;
  };
  readonly metadata: MetadataFindings;
  /** Structural warnings (xref check, parse problems, limits reached), English. */
  readonly warnings: readonly string[];
  /** Some facts could not be read (e.g. encrypted without the password). */
  readonly partial: boolean;
}
