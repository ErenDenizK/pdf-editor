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

import type { LayoutInput } from './text-edit/linebreak';

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

/**
 * Text markup, and /Redact marks (pending redactions, spec redaction §1.1). For `redact`:
 * `color` is the outline (/C), `interiorColor` the fill painted once applied (/IC, black
 * when absent), and `overlayText` / `overlayColor` are /OverlayText and its colour (/OC).
 */
export interface MarkupAnnotation extends AnnotationBase {
  readonly kind: 'highlight' | 'underline' | 'strikeout' | 'squiggly' | 'redact';
  readonly quads: readonly Rect[];
  /** /Redact only: text to show over the area once applied (/OverlayText). */
  readonly overlayText?: string;
  /** /Redact only: colour of the overlay text (/OC). */
  readonly overlayColor?: string;
}

export interface InkAnnotation extends AnnotationBase {
  readonly kind: 'ink';
  readonly paths: readonly (readonly { readonly x: number; readonly y: number }[])[];
  /** The nominal width (`/BS /W`), points: what viewers that redraw from `/InkList` use. */
  readonly strokeWidth: number;
  /**
   * Variable width (ADR-0018, experience-redesign spec §9): the full width in points at each
   * point of `paths`, one group per path, parallel to it point for point. The appearance is
   * the filled outline of `annotations/ink-outline.ts`; the file keeps the widths in the
   * private `/PdfEditorInkWidths` string. Absent, or not matching `paths`, the stroke is
   * constant width (`strokeWidth`).
   *
   * The PDFium adapter (with raw access, as in the PDFium worker) writes the appearance, a
   * /Rect of the outline bounds and the widths on create and on every update, and lists them
   * back stored: two decimals, at least 0.01 pt. An update carries the full state, so one
   * without widths makes the ink constant width. A move or resize of the box moves and
   * scales the paths, not the widths (like `strokeWidth`).
   */
  readonly widths?: readonly (readonly number[])[];
  /**
   * `multiply`: the ink darkens what is under it instead of covering it (the free
   * Highlighter, craft spec §5.4). EmbedPDF generates its appearance with `/BM /Multiply`
   * (`EPDFAnnot_GenerateAppearanceWithBlend`) and lists it back from that appearance. Such an
   * ink is constant width (`strokeWidth`): the variable-width appearance cannot carry a blend
   * mode, so the adapter writes no `widths` for it. Absent: normal blending.
   */
  readonly blendMode?: 'multiply';
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

  /**
   * Optional: appends the last path of `ink` (its full new state) to the Ink annotation
   * `ink.id` without rewriting the others (a pen burst, craft spec §5.3 item 8). Resolves to
   * the ink as written, or `undefined`, with nothing written, when the ink does not hold
   * `ink.paths.length - 1` paths; callers then use `updateAnnotation`.
   */
  appendInkPath?(
    id: SourceId,
    ink: InkAnnotation,
    options?: EngineCallOptions,
  ): Promise<InkAnnotation | undefined>;
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
  /**
   * Flatten the form fields created in the app (`VirtualDocument.fields`): their
   * appearances are drawn into the pages and no field is written. Source fields are
   * flattened before assembly (`SaveOptions.flattenForms`).
   */
  readonly flattenForms?: boolean;
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
  /**
   * Form fields created in the app (`VirtualDocument.fields`) as written: final name (after
   * the form merge policy), kind and output pages. Absent when the document has none;
   * empty when they were flattened.
   */
  readonly createdFields?: readonly CreatedFieldExpectation[];
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
  /**
   * Output page indices whose annotations (as `PdfEditor.listAnnotations` reports them,
   * links included, hidden ones excepted) must all lie inside the page's visible box:
   * resized pages whose content fits inside the new page (`planExport`), so a missing or
   * wrong annotation transform is caught before the download.
   */
  readonly annotationsInsidePages?: readonly number[];
  /**
   * Form fields created in the app: each must be listed with its kind and a widget on each
   * of the given output pages, under its name or the name the form merge policy gave it
   * (`name_2`, `name_3`, …; see `ReconciliationReport.formFieldsRenamed`).
   */
  readonly createdFields?: readonly CreatedFieldExpectation[];
  /**
   * Words of the OCR layers the output carries (spec recognize-and-compare §1.3), per output
   * page: each must come back from PDFium's page text (`locateWords`, the layer's own
   * verification rule) and, when the word has a `rect`, lie within `OCR_RECT_TOLERANCE` of
   * it on every edge. The layer is page content, not an annotation, so flattening,
   * compression and encryption keep it; pages not listed are not checked.
   */
  readonly ocrWords?: readonly OcrWordsExpectation[];
}

/** The OCR words one output page must yield through PDFium. */
export interface OcrWordsExpectation {
  /** Output page index. */
  readonly pageIndex: number;
  readonly words: readonly OcrExpectedWord[];
}

/** One written OCR word, as the verification pass must find it. */
export interface OcrExpectedWord {
  readonly text: string;
  /**
   * The box the word was written to (`layerWordRect`), in the output page's user space.
   * Absent when the export moved the content in a way the plan does not map (a resized
   * page): the word is then checked by its text only.
   */
  readonly rect?: Rect;
}

/** A form field created in the app, as the verification pass must find it. */
export interface CreatedFieldExpectation {
  readonly name: string;
  readonly kind: FormFieldKind;
  /** Output page index of each widget. */
  readonly pageIndices: readonly number[];
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
  /**
   * Script and external actions (/JavaScript, /Launch, /SubmitForm, /ImportData, /Rendition
   * with /JS), including /OpenAction and /Next, plus /AA entries, removed.
   */
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
  /** Script and external actions (see `MetadataStripReport.javascript`) and /AA entries. */
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

// ---------------------------------------------------------------------------
// Text editing: PdfTextEditor (spec redaction-and-text-editing §2, research 05 §6, ADR-0011)
// ---------------------------------------------------------------------------

/** An affine matrix `[a, b, c, d, e, f]` (PDF row-vector convention). */
export type TextMatrix = readonly [number, number, number, number, number, number];

/**
 * What identifies a run for an edit, and what replay re-checks. Indices describe the page
 * *as it is when the edit runs*: after any edit on a page, locate its runs again.
 */
export interface TextRunRef {
  readonly source: SourceId;
  readonly pageIndex: number;
  /**
   * Index of the text object among the page's objects (`FPDFPage_GetObject`), then, for text
   * inside Form XObjects, its index inside each enclosing form (`FPDFFormObj_GetObject`).
   */
  readonly objectPath: readonly number[];
  /** Text-page index (`FPDFText_*`) of the run's first character. */
  readonly charStart: number;
  /** Number of text-page characters (glyphs) in the run. */
  readonly charCount: number;
  /** The run's text as located; an edit fails with `stale-run` when the page differs. */
  readonly text: string;
}

/** A glyph of a located run. */
export interface LocatedGlyph extends Glyph {
  /** Text-page index of the character. */
  readonly charIndex: number;
  /** Glyph origin on the baseline, unrotated user space. */
  readonly origin: { readonly x: number; readonly y: number };
}

/**
 * How the run's font is stored: a standard-14 font by name (not embedded), an embedded
 * font program, a Type3 font (glyphs are content streams: not editable), or another font
 * that is not embedded (the viewer substitutes it).
 */
export type TextFontKind = 'standard14' | 'embedded' | 'type3' | 'not-embedded';

export interface TextRunFont {
  /** /BaseFont as PDFium reports it, subset tag included (`ABCDEF+Inter-Regular`). */
  readonly baseName: string;
  readonly embedded: boolean;
  readonly kind: TextFontKind;
  /** Font descriptor /Flags. */
  readonly flags: number;
  /** Name/flag heuristics used to pick the tier-1 substitute. */
  readonly bold: boolean;
  readonly italic: boolean;
  readonly monospace: boolean;
  readonly serif: boolean;
}

/** One editable unit: a text object's glyphs on one line (spec §2.2: single lines). */
export interface LocatedRun extends TextRunRef {
  /** Union of the glyph boxes, unrotated user space (like `Glyph.rect`). */
  readonly lineBox: Rect;
  readonly glyphs: readonly LocatedGlyph[];
  /** Font size (Tf); the text's scale on the page is in `matrix`. */
  readonly fontSize: number;
  /** The object's matrix in page space (forms applied): linear part and origin. */
  readonly matrix: TextMatrix;
  /** Unit vector of the writing direction on the page (unrotated user space). */
  readonly direction: { readonly x: number; readonly y: number };
  readonly font: TextRunFont;
  /** Text render mode (Tr); 3 is invisible (OCR layers). */
  readonly renderMode: number;
  /** Marked-content id of the object, when it is tagged content. */
  readonly mcid?: number;
  /** The text is drawn by a Form XObject (`objectPath.length > 1`). */
  readonly inForm: boolean;
  /** Glyphs advance along the text space's y axis (vertical writing): not editable. */
  readonly vertical: boolean;
  // Paragraph analysis facts (spec craft §4.1, §8). Optional: older producers of runs omit them.
  /**
   * Font ascent above the baseline (`FPDFFont_GetAscent` at `fontSize`): text space units,
   * before `matrix` scales them onto the page.
   */
  readonly ascent?: number;
  /** Font descent (`FPDFFont_GetDescent` at `fontSize`): negative below the baseline. */
  readonly descent?: number;
  /** Fill colour of the run's first glyph (`FPDFText_GetFillColor`), RGBA 0–255. */
  readonly fill?: readonly [number, number, number, number];
  /**
   * Union of the loose glyph boxes (`FPDFText_GetLooseCharBox`: ascent to descent over each
   * advance, not the ink), unrotated user space: the line's height for overlays and leading.
   */
  readonly looseLineBox?: Rect;
  /**
   * The first glyph's baseline position across the writing direction: its origin projected
   * on the normal of `direction` (`-x·dir.y + y·dir.x`). Runs on one line share it whatever
   * the text matrix; for horizontal text it is the origin's y in user space.
   */
  readonly baseline?: number;
  /** The run's `FPDF_FONT`, numbered in page object order: equal ids mean the same font. */
  readonly fontId?: number;
  /** The run's last character is a hyphen the text page reads as a line-end hyphen. */
  readonly endsWithHyphen?: boolean;
  /** Effective matrix of the run's first character (`FPDFText_GetMatrix`). */
  readonly textMatrix?: TextMatrix;
}

/**
 * What the user is told about an edit (spec §2.2 badge, history label, export summary):
 * - `same-font`: tier 2, re-encoded in the original embedded font and verified;
 * - `same-font-not-embedded`: tier 2 in a standard-14 font that is not embedded;
 * - `font-substituted`: tier 1, the new text uses a bundled face (`substitute`);
 * - `moved-out-of-form`: tier 1 on text inside a Form XObject; the line now lives in the
 *   page content (the form's clip, transparency group and reuse no longer apply to it);
 * - `not-editable`: Type3, text drawn as paths, invisible (render mode 3), vertical, nested
 *   forms, a form drawn more than once, a clip the re-created glyphs would leave, or codes
 *   that cannot be read (the reason is in `TextEditability.tier1.reason`).
 *
 * Independently of the state, `colorSpaceChanged` (on the check and the result) says that
 * some glyphs are re-created in DeviceRGB while the original text is painted in another
 * colour space (CMYK, spot, ICC-based…): the badge and history label should say so.
 */
export type TextEditHonesty =
  | 'same-font'
  | 'same-font-not-embedded'
  | 'font-substituted'
  | 'moved-out-of-form'
  | 'not-editable';

/**
 * Why a run is not editable at all (`type3` … `nested-form`), or not with tier 1:
 * - `shared-form`: the text is in a Form XObject the document draws more than once (on
 *   several pages, twice on a page, or from another form or appearance); editing it would
 *   change every place, so the edit is refused;
 * - `clipped`: the text is clipped and the edit would re-create glyphs outside the clip
 *   (new objects cannot carry the clip), so they would become visible;
 * - `unreadable-encoding`: the original character codes of the text could not be read from
 *   the content stream, so the kept glyphs cannot be re-created exactly.
 */
export type TextEditBlocker =
  | 'type3'
  | 'invisible'
  | 'paths'
  | 'vertical'
  | 'nested-form'
  | 'shared-form'
  | 'clipped'
  | 'unreadable-encoding';

/**
 * Why tier 2 (the original font) cannot take the replacement. Besides the font reasons:
 * - `ambiguous-encoding`: the font reads several codes as one of the new characters and
 *   they draw different glyphs (an alternate "A" whose /ToUnicode says "A"); which glyph the
 *   character should get is unknown (`missing` lists the characters);
 * - `clipped`: the replacement or re-created glyphs would leave the text's clip path.
 */
export type TextTier2Refusal =
  | 'blocked'
  | 'in-form'
  | 'not-embedded'
  | 'outside-winansi'
  | 'missing-glyphs'
  | 'readback'
  | 'ambiguous-encoding'
  | 'clipped';

/** Shrink-to-fit floor (spec §2.5): the replacement may shrink to 75% of the run's size. */
export const TEXT_EDIT_SHRINK_FLOOR = 0.75;

/** Width of the replacement in one tier's font against the free space. */
export interface TextFitOption {
  /** Advance width of the replacement at the run's size, points along the baseline. */
  readonly width: number;
  /** Size factor that makes it fit (1 when it fits as is). */
  readonly shrink: number;
  readonly fits: boolean;
  /** `shrink` is at least `TEXT_EDIT_SHRINK_FLOOR`. */
  readonly canShrink: boolean;
}

/** What ends the free space of an edit: the next glyph, the text block's edge, the page edge. */
export type TextSpaceBound = 'glyph' | 'column' | 'page';

export interface TextFitReport {
  /**
   * Free space, points along the baseline, from the start of the selection to the origin of
   * the next glyph on the line (any text object); at the end of a line, to the right edge of
   * its text block when that comes first, or to the page edge when there is neither.
   */
  readonly available: number;
  /** Whether `available` ends at a glyph (false: at the block's or the page box's edge). */
  readonly boundedByGlyph: boolean;
  /** What `available` ends at: a glyph, the text block's right edge or the page edge. */
  readonly boundedBy?: TextSpaceBound;
  /** Width of the selected glyphs (what the replacement replaces). */
  readonly replaced: number;
  /** Tier 2 (original font); absent when tier 2 cannot encode the replacement. */
  readonly tier2?: TextFitOption;
  /** Tier 1 (bundled substitute); absent when tier 1 is not possible. */
  readonly tier1?: TextFitOption;
}

export interface TextEditability {
  readonly tier2:
    | { readonly ok: true }
    | {
        readonly ok: false;
        readonly reason: TextTier2Refusal;
        /** Characters concerned: those the font cannot show, or with ambiguous codes. */
        readonly missing: readonly string[];
      };
  readonly tier1:
    | {
        readonly ok: true;
        /** Bundled face key, e.g. `Inter-Regular`. */
        readonly substitute: string;
        /** Display name of the substitute family, e.g. `Inter`. */
        readonly family: string;
      }
    | {
        readonly ok: false;
        readonly reason: TextEditBlocker | 'unsupported-chars';
        readonly missing?: readonly string[];
      };
  /** The tier `tier: 'auto'` uses; absent when not editable. */
  readonly tier?: 1 | 2;
  /** Honesty state of the `auto` edit (`not-editable` when neither tier works). */
  readonly honesty: TextEditHonesty;
  /**
   * The `auto` edit re-creates glyphs in DeviceRGB while the text is painted in CMYK, a spot
   * colour, an ICC-based or another non-RGB colour space (PDFium sets RGB fills only). The
   * glyphs kept in the original object keep their colour space.
   */
  readonly colorSpaceChanged?: boolean;
  readonly fit: TextFitReport;
}

/** Advance of one character of a tier-2 replacement, points along the baseline at the run's size. */
export interface TextAdvance {
  /** Inside the original object (its Tc/Tw/Tz applied): what the replacement takes. */
  readonly spaced: number;
  /** In a new object of the run's size (no Tc/Tw): the part that scales with the size. */
  readonly plain: number;
}

/**
 * A run analysed once for the inline editor (craft spec §4.8): with it, the width, fit,
 * tier and honesty of a replacement are arithmetic (`PdfTextEditor.checkEditability` stays
 * the authority, run after a pause and on commit). Characters are keyed by their string;
 * one that is in neither table of a tier is unknown to the analysis (the engine decides).
 */
export interface TextRunAnalysis {
  /** The run as analysed (its identity at this page state). */
  readonly run: TextRunRef;
  /** Why no replacement of the run can be made, whatever the text. */
  readonly blocker?: TextEditBlocker;
  /** Honesty of an edit in each tier. */
  readonly honesty: {
    readonly tier2: Extract<TextEditHonesty, 'same-font' | 'same-font-not-embedded'>;
    readonly tier1: Extract<TextEditHonesty, 'font-substituted' | 'moved-out-of-form'>;
  };
  readonly tier2: {
    /** Why the original font takes no replacement at all (any text). */
    readonly refusal?: TextTier2Refusal;
    /** Measured advances of the characters the original font can take. */
    readonly advances: Readonly<Record<string, TextAdvance>>;
    /** Characters the original font cannot take, and why. */
    readonly refused: Readonly<Record<string, TextTier2Refusal>>;
  };
  /** The bundled face tier 1 prefers; absent when the run is blocked. */
  readonly tier1?: {
    /** Bundled face key, e.g. `Inter-Regular`. */
    readonly substitute: string;
    readonly family: string;
    /** Advance of each character the face has, points along the baseline at the run's size. */
    readonly advances: Readonly<Record<string, number>>;
  };
  /**
   * Distances along the writing direction from the run's first glyph origin, points: the end
   * of the last glyph's advance, and where the free space after the run ends (`lineBound`).
   */
  readonly runEnd: number;
  readonly lineEnd: number;
  readonly lineBound: TextSpaceBound;
}

// Paragraph detection (spec craft §4.1–§4.2, §8; ADR-0020 §2; research 11 §3). Data only: the
// rules live in `text-edit/blocks.ts`, the rewrap in `text-edit/linebreak.ts`.
//
// Text space: coordinates in the paragraph's own frame, so rotated text reads like horizontal
// text. With `d` its unit writing direction (unrotated user space), a user-space point `p` has
// `x = p.x·d.x + p.y·d.y` (along the line) and `y = −p.x·d.y + p.y·d.x` (across it, upwards;
// the same projection as `LocatedRun.baseline`). For unrotated horizontal text both are the
// user-space coordinates. Distances are points.

/** Identifies a detected paragraph at one page state. */
export interface ParagraphRef {
  readonly source: SourceId;
  readonly pageIndex: number;
  /** Position of the paragraph in the page's analysis (reading order). */
  readonly index: number;
  /**
   * Every run the paragraph takes glyphs from, in reading order: the identity an edit
   * re-checks (`stale-run` when the page differs). A run cut by a wide gap (a table row drawn
   * by one object) may belong to several paragraphs.
   */
  readonly runs: readonly TextRunRef[];
}

/** A slice of one run inside a paragraph line, with its style. */
export interface ParagraphSpan {
  /** Index into `ParagraphRef.runs`. */
  readonly run: number;
  /** Glyph range `[glyphStart, glyphEnd)` of the run (`LocatedRun.glyphs` indices). */
  readonly glyphStart: number;
  readonly glyphEnd: number;
  /** The slice's text as the text page reads it (a line-end hyphen reads `-`). */
  readonly text: string;
  /** The run's `FPDF_FONT` number (`LocatedRun.fontId`): equal ids are one font. */
  readonly fontId?: number;
  readonly font: TextRunFont;
  /** Font size (Tf). */
  readonly fontSize: number;
  /** Size on the page: `fontSize` times the matrix's scale across the line. */
  readonly size: number;
  /** The run's object matrix in page space (`LocatedRun.matrix`). */
  readonly matrix: TextMatrix;
  /** Effective matrix of the run's first character (`LocatedRun.textMatrix`). */
  readonly textMatrix?: TextMatrix;
  /** Fill colour, RGBA 0–255. */
  readonly fill?: readonly [number, number, number, number];
  /** Text render mode (Tr). */
  readonly renderMode: number;
  readonly mcid?: number;
  /** Text-space x of the slice's first glyph origin and of the end of its last glyph. */
  readonly x0: number;
  readonly x1: number;
}

/** How a paragraph line continues into the next one in `ParagraphBlock.text`. */
export type ParagraphLineEnd =
  /** A space joins it to the next line. */
  | 'space'
  /** Its line-end hyphen is dropped and the word continues on the next line (`exam-`/`ple`). */
  | 'joined'
  /** It ends in a hyphen that is kept, with nothing added (`Jean-`/`Paul`). */
  | 'hyphen'
  /** The paragraph's last line. */
  | 'end';

export interface ParagraphLine {
  /** The line's slices in visual order along the line. */
  readonly spans: readonly ParagraphSpan[];
  /** Text-space y of the baseline. */
  readonly baseline: number;
  /**
   * Text-space x of the line's left edge (its first glyph's origin) and right edge (where its
   * last glyph's advance ends, or its ink when that is unknown).
   */
  readonly x0: number;
  readonly x1: number;
  /** Dominant size on the page (by characters), points. */
  readonly size: number;
  /** The line as shown: spans joined, a space where a gap between glyphs stands for one. */
  readonly text: string;
  /** Offset of the line's first character in `ParagraphBlock.text` (UTF-16). */
  readonly start: number;
  readonly end: ParagraphLineEnd;
  /** The line ends in a hyphen the text page flags as a line-end hyphen (`FPDFText_IsHyphen`). */
  readonly endsWithHyphen: boolean;
}

export type ParagraphAlign = 'left' | 'right' | 'center' | 'justify';

/**
 * Why paragraph mode is not offered for a block (it stays editable per line where the run
 * allows it): a run blocker (`TextEditBlocker`: Type 3, text without a font drawn as paths,
 * invisible, vertical, nested forms), or a drop cap (a large initial spanning several lines).
 */
export type ParagraphRefusal =
  | Extract<TextEditBlocker, 'type3' | 'paths' | 'invisible' | 'vertical' | 'nested-form'>
  | 'drop-cap';

/**
 * A segment of a glyph outline (`FPDFGlyphPath_GetGlyphPathSegment`): its end point in em
 * units (1 = the font size; y up, origin on the glyph origin on the baseline). Scale by the
 * font size and the text matrix. A Bézier curve is three consecutive `bezier` segments (two
 * control points, then the end point).
 */
export interface GlyphOutlineSegment {
  readonly kind: 'move' | 'line' | 'bezier';
  readonly x: number;
  readonly y: number;
  /** The segment closes the current subpath. */
  readonly close: boolean;
}

/** One detected paragraph (or heading, list item, table cell) of a page. */
export interface ParagraphBlock {
  readonly ref: ParagraphRef;
  /** Lines from top to bottom. */
  readonly lines: readonly ParagraphLine[];
  readonly align: ParagraphAlign;
  /**
   * Baseline-to-baseline distance, points: the median of the paragraph's line pitches; for a
   * single line, the median pitch of same-size lines on the page, else 1.2 × the size.
   */
  readonly leading: number;
  /** `tags`: one structure element; `geometry`: the layout heuristics. */
  readonly source: 'tags' | 'geometry';
  readonly kind: 'paragraph' | 'heading' | 'list-item' | 'cell';
  /** The structure type, for `source: 'tags'` (`P`, `LI`, `H2`…). */
  readonly tag?: string;
  /** Unit writing direction in unrotated user space (defines text space). */
  readonly direction: { readonly x: number; readonly y: number };
  /** The box's left and right edges along the line (text-space x): the measure. */
  readonly measure: { readonly left: number; readonly right: number };
  /** First line's left edge minus `measure.left` (positive: first-line indent). */
  readonly indent: number;
  /** Dominant size on the page, points. */
  readonly size: number;
  /** The list marker that starts the first line (`•`, `1.`, `a)`), when there is one. */
  readonly marker?: string;
  /** A drop cap in front of the first lines (also in `text`); `refusal` is `drop-cap`. */
  readonly dropCap?: ParagraphSpan;
  /**
   * The paragraph's text, de-hyphenated: a flagged line-end hyphen before a lower-case start
   * joins the word, another line-end hyphen stays with no space, other lines join with a space.
   */
  readonly text: string;
  /** Union of the glyph boxes, unrotated user space. */
  readonly box: Rect;
  /** Set when paragraph mode is not offered for this block. */
  readonly refusal?: ParagraphRefusal;
}

/** A replacement of `run.text.slice(start, end)` (UTF-16 offsets on glyph boundaries). */
export interface TextEditQuery {
  readonly run: TextRunRef;
  /** Default 0. */
  readonly start?: number;
  /** Default `run.text.length`. */
  readonly end?: number;
  readonly replacement: string;
}

export interface TextEditRequest extends TextEditQuery {
  /** `auto` tries tier 2 and falls back to tier 1 (the result says so). */
  readonly tier: 'auto' | 1 | 2;
  /**
   * `keep`: the run's size, must fit the free space; `shrink`: down to the shrink floor;
   * `overflow`: the run's size, may run past the next glyph. Ignored with `fontSize`.
   */
  readonly fit: 'keep' | 'shrink' | 'overflow';
  /** Tier-1 face key to use (replay: the face recorded by the first run). */
  readonly face?: string;
  /** Exact font size of the replacement (replay: the size recorded by the first run). */
  readonly fontSize?: number;
}

export interface TextEditVerification {
  /** The edited run's text read back from a fresh text page. */
  readonly readback: string;
  /** Largest movement of a kept glyph, points. */
  readonly maxDrift: number;
  /** The new glyph boxes lie within the line box extended by the free space. */
  readonly insideLineBox: boolean;
}

export interface TextEditResult {
  readonly tier: 1 | 2;
  readonly honesty: Exclude<TextEditHonesty, 'not-editable'>;
  /** Tier 1: the bundled face key used. */
  readonly substitute?: string;
  /** Font size of the replacement. */
  readonly fontSize: number;
  /** `auto` tried tier 2 first and fell back (the history label says so). */
  readonly fellBack: boolean;
  /** Why tier 2 was not used, when `tier` is 1. */
  readonly tier2Refusal?: TextTier2Refusal;
  /** Some glyphs were re-created in DeviceRGB; the original colour space was not RGB. */
  readonly colorSpaceChanged?: boolean;
  readonly verification: TextEditVerification;
}

/**
 * In-place text editing on an open source (spec §2.5). Implemented in the PDFium host
 * (`text-edit/`), exposed across the worker by `PdfiumProxy`.
 */
export interface PdfTextEditor extends PdfParagraphEditor {
  /** Editable runs of a page (per text object and line), in reading order. */
  locateRuns(
    source: SourceId,
    pageIndex: number,
    options?: EngineCallOptions,
  ): Promise<readonly LocatedRun[]>;
  /**
   * What the editor needs to check replacements of the run without the engine (craft spec
   * §4.8): its blockers, per-character advances in the original font and the substitute, and
   * the free space at the end of its line. Read-only; run once when the editor opens.
   */
  analyzeRun(run: TextRunRef, options?: EngineCallOptions): Promise<TextRunAnalysis>;
  /**
   * The page's paragraphs (craft spec §4.1): structure tree first, then geometry. Read-only,
   * at the lower raw-task priority, cached per page state by the engine.
   */
  analyzeParagraphs(
    source: SourceId,
    pageIndex: number,
    options?: EngineCallOptions,
  ): Promise<readonly ParagraphBlock[]>;
  /**
   * Outlines of `chars` in the page's font `fontId` (`LocatedRun.fontId`, as numbered by the
   * page's analysis) from `FPDFFont_GetGlyphPath`, in em units (see `GlyphOutlineSegment`),
   * for the paragraph editor's canvas (craft spec §4.7). A character the font has no outline
   * for maps to null. Read-only, at the lower raw-task priority.
   */
  glyphPaths(
    source: SourceId,
    pageIndex: number,
    fontId: number,
    chars: readonly string[],
    options?: EngineCallOptions,
  ): Promise<Readonly<Record<string, readonly GlyphOutlineSegment[] | null>>>;
  /** Tier 2 / tier 1 availability, honesty and fit for a replacement (no change made). */
  checkEditability(query: TextEditQuery, options?: EngineCallOptions): Promise<TextEditability>;
  /** Applies the edit, verified by read-back, and regenerates the page content. */
  applyTextEdit(request: TextEditRequest, options?: EngineCallOptions): Promise<TextEditResult>;
}

// ---------------------------------------------------------------------------
// Redaction: pdf-lib post-pass and forensic self-check (spec redaction §1.2, research 06)
// ---------------------------------------------------------------------------

/** One applied redaction area. */
export interface RedactionArea {
  readonly pageIndex: number;
  /**
   * Unrotated page user space (points, origin bottom-left, absolute: the same space as
   * `Glyph.rect` and annotation rects), whatever the page's /Rotate.
   */
  readonly rect: Rect;
  /** Overlay text for this area; overrides `RedactionPlan.overlayText`. */
  readonly overlayText?: string;
}

/** What was redacted and how the areas are painted; input of the scrub and the check. */
export interface RedactionPlan {
  readonly areas: readonly RedactionArea[];
  /**
   * The redacted strings (glyph text under the marks, search terms). They are scrubbed from
   * every document-level string and must be absent from the whole output, so a caller
   * redacting only some occurrences of a string (area-only mode) leaves it out. Matching
   * ignores case and whitespace.
   */
  readonly strings: readonly string[];
  /** Fill colour of the areas, `#rrggbb` or `#rgb`; default black. */
  readonly fillColor?: string;
  /** Text drawn centred in every area (standard font, auto-sized), e.g. "REDACTED". */
  readonly overlayText?: string;
  /** Overlay text colour; default white on dark fills, black on light ones. */
  readonly overlayColor?: string;
  /**
   * Keep embedded files and file attachment annotations (default false: all removed). Kept
   * attachments cannot be searched reliably and are reported as unverified.
   */
  readonly keepAttachments?: boolean;
  /** Replacement for redacted strings in document-level strings; default "[redacted]". */
  readonly placeholder?: string;
}

/** What the tagged-PDF repair did: nothing to do, tree kept, tree pruned, or removed. */
export type RedactionStructureOutcome = 'not-tagged' | 'intact' | 'pruned' | 'untagged';

/** Result counts of `scrubRedactedDocument` (export summary data). */
export interface RedactionReport {
  /** Areas per page index. */
  readonly areasByPage: Readonly<Record<number, number>>;
  /** Annotations removed (in an area, carrying a redacted string, popups and replies). */
  readonly annotationsRemoved: number;
  /** Of `annotationsRemoved`: link annotations. */
  readonly linksRemoved: number;
  /** Pending /Redact marks that were still in the file (removed). */
  readonly pendingMarksRemoved: number;
  /** Form fields whose value (/V, /DV) was cleared because a widget lay in an area. */
  readonly fieldsCleared: number;
  /** Widgets removed from pages and fields. */
  readonly widgetsRemoved: number;
  /** Fields dropped from the form because no widget was left. */
  readonly fieldsRemoved: number;
  readonly xfaRemoved: boolean;
  /** String objects rewritten with the placeholder (outline, Info, struct tree, …). */
  readonly stringsReplaced: number;
  /** Named destinations (and other name-tree keys) renamed; referrers follow. */
  readonly namesRenamed: number;
  readonly metadata: {
    /** XMP regenerated from the scrubbed Info. */
    readonly xmpRegenerated: boolean;
    /** Per-object /Metadata streams removed (pages, images, forms). */
    readonly objectMetadata: number;
    readonly pieceInfo: number;
    readonly thumbnails: number;
    /** Script actions, /AA entries and the /Names /JavaScript tree entries removed. */
    readonly javascript: number;
  };
  readonly structure: RedactionStructureOutcome;
  /** Structure elements removed or stripped of /ActualText and /Alt. */
  readonly structElementsPruned: number;
  readonly attachments: {
    /**
     * Embedded files (the /EmbeddedFiles tree and any other file specification's /EF),
     * file attachment and RichMedia annotations, /AF entries, and GoToE/GoToR actions
     * that embed their target, removed.
     */
    readonly removed: number;
    /** With `keepAttachments`: names of the kept files, not verified by the check. */
    readonly unverified: readonly string[];
  };
  /** Indirect objects dropped by garbage collection before the full rewrite. */
  readonly unreachableObjectsRemoved: number;
  /** Problems that did not stop the scrub (e.g. overlay text that did not fit). */
  readonly warnings: readonly string[];
}

/** Identifiers of the self-check's checks (research 06 §4, in order). */
export type ForensicCheckId =
  | 'parse'
  | 'single-revision'
  | 'no-unreachable-objects'
  | 'no-text-in-areas'
  | 'no-search-hits'
  | 'object-strings'
  | 'byte-grep'
  | 'no-annotations-in-areas'
  | 'fill-pixels';

/** One hit of a failing check: where the leak or problem is. */
export interface ForensicFinding {
  /** Human-readable location, e.g. "object 12, /Title" or "page 1, area 0". */
  readonly where: string;
  readonly objectNumber?: number;
  readonly pageIndex?: number;
  readonly areaIndex?: number;
  /** Encoding or channel, e.g. "ascii", "utf16be-hex", "inflated stream", "search". */
  readonly channel?: string;
  readonly detail?: string;
}

export interface ForensicCheckResult {
  readonly id: ForensicCheckId;
  readonly passed: boolean;
  /** Empty when passed; capped at 50 (see `truncated`). */
  readonly findings: readonly ForensicFinding[];
  /** More findings existed than listed. */
  readonly truncated?: boolean;
  /** What was checked, and anything that could not be (e.g. streams not decodable). */
  readonly note?: string;
}

export interface ForensicReport {
  /** Every check passed. */
  readonly ok: boolean;
  /** One entry per `ForensicCheckId`, in that order. */
  readonly checks: readonly ForensicCheckResult[];
  /**
   * Streams that could not be decoded (filter, predictor parameters or corrupt data), so
   * their content was not searched: "object N (reason)".
   */
  readonly notSearched: readonly string[];
  /**
   * Embedded files present in the output (kept attachments), wherever they are held;
   * binary, not verifiable. Without `keepAttachments`, any of them fails `object-strings`.
   */
  readonly unverifiedAttachments: readonly string[];
}

/** RGBA pixels, rows top-down, as a render of `ForensicDeps.renderArea`. */
export interface ForensicPixels {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray | Uint8Array;
}

/**
 * Engine access for `forensicCheck`, bound to the checked bytes (opened by the caller, e.g.
 * through `PdfRenderer`), so the check itself stays DOM-free.
 */
export interface ForensicDeps {
  /** Text runs of a page, glyph boxes in unrotated user space (`PdfRenderer.getPageText`). */
  getPageText(pageIndex: number): Promise<readonly TextRun[]>;
  /** Case-insensitive whole-document search (`PdfRenderer.search`). */
  search(query: string): Promise<readonly SearchHit[]>;
  /**
   * Renders exactly `rect` (user space) of a page at `scale`, with annotations and forms
   * (`PdfRenderer.renderPage` with `clip`).
   */
  renderArea(pageIndex: number, rect: Rect, scale: number): Promise<ForensicPixels>;
}
// ---------------------------------------------------------------------------
// Redaction: engine pass, blank-region gate and the whole apply (research 06 §3)
// ---------------------------------------------------------------------------

/** What the engine pass (PDFium, private scratch document) did. */
export interface RedactionEnginePassReport {
  /** Pages with areas (one `applyAllRedactions` each). */
  readonly pages: number;
  readonly areas: number;
  /** Path objects removed because their bounds touch an area (pages and Form XObjects). */
  readonly pathsRemoved: number;
  /** Image objects removed because they lay entirely inside an area. */
  readonly imagesRemoved: number;
  /**
   * /Redact annotations already in the bytes on pages with areas, deleted unapplied (the
   * plan is what gets applied; marks elsewhere are removed by the scrub).
   */
  readonly pendingMarksDropped: number;
  /** The source was encrypted; the output of the pass is not. */
  readonly decrypted: boolean;
  readonly durationMs: number;
}

/** Kinds of what the gate found in an area that is not blank. */
export type RedactionLeftoverKind =
  | 'text'
  | 'path'
  | 'image'
  | 'shading'
  | 'form'
  | 'annotation'
  | 'unknown';

/** One area of the blank-region gate. */
export interface RedactionGateArea {
  readonly areaIndex: number;
  readonly pageIndex: number;
  /** Share of sampled pixels that are page background (white), 0–1. */
  readonly backgroundShare: number;
  readonly blank: boolean;
  /** For an area that is not blank: page objects and annotations still touching it. */
  readonly remaining: readonly RedactionLeftoverKind[];
}

/**
 * The blank-region gate (research 06 §3 step 3): after removal and before the fill, every
 * area rendered with annotations and forms must be page background only.
 */
export interface RedactionGateReport {
  readonly ok: boolean;
  readonly areas: readonly RedactionGateArea[];
}

/** Redacted strings captured before applying (glyph text under the areas). */
export interface RedactionCapture {
  /** Added to the plan's strings: scrubbed and checked document-wide. */
  readonly strings: readonly string[];
  /** Too short to search document-wide (fewer than 4 characters); areas only. */
  readonly skipped: readonly string[];
}

export interface ApplyRedactionsOptions extends EngineCallOptions {
  /** Password of an encrypted source (the output is not encrypted). */
  readonly password?: string;
  /**
   * Add the glyph text under each area to the plan's strings (default true). Turn off for
   * "area only" redaction, where the same text elsewhere in the document must stay.
   */
  readonly captureStrings?: boolean;
  /** Remove image objects lying entirely inside an area (default true). */
  readonly removeCoveredImages?: boolean;
}

/** A verified redaction: the bytes may be offered, every report is for the export summary. */
export interface ApplyRedactionsResult {
  readonly bytes: ArrayBuffer;
  /** The plan as applied (the caller's plus the captured strings): keep it for the export. */
  readonly plan: RedactionPlan;
  readonly captured: RedactionCapture;
  readonly engine: RedactionEnginePassReport;
  readonly gate: RedactionGateReport;
  readonly redaction: RedactionReport;
  readonly forensic: ForensicReport;
}

/**
 * Payload of a `redaction.apply` engine edit (the contract between the app and the export
 * plan): the plan as applied, in the source's page indices.
 */
export interface RedactionApplyPayload {
  readonly plan: RedactionPlan;
}

/** Options of `PdfRedactor.verifyRedactedOutput`. */
export interface VerifyRedactedOutputOptions extends EngineCallOptions {
  /** User password of an encrypted output. */
  readonly password?: string;
}

/**
 * Redaction on the hosted engine (ADR-0011 §3), exposed across the worker by `PdfiumProxy`.
 * Named apart from `PdfEditor.applyRedactions` (which applies /Redact annotations in place,
 * without the scrub or the self-check).
 */
export interface PdfRedactor {
  /**
   * Applies `plan` to the open source (`applyRedactions`, redaction/apply.ts): the source
   * is saved as it is now (security removed), redacted in private scratch documents and,
   * once verified, replaces the open document under the same id. Throws
   * `RedactionFailedError` (stage and reports kept across the worker) and leaves the open
   * document's content as it was when the gate or the self-check fails.
   */
  applyRedactionPlan(
    id: SourceId,
    plan: RedactionPlan,
    options?: ApplyRedactionsOptions,
  ): Promise<ApplyRedactionsResult>;
  /**
   * The export's self-check (`verifyRedactedOutput`) on `bytes`, opened in a scratch
   * document with `options.password`. Never throws for a failed check (see `ok`).
   */
  verifyRedactedOutput(
    bytes: ArrayBuffer,
    plans: readonly RedactionPlan[],
    options?: VerifyRedactedOutputOptions,
  ): Promise<ForensicReport>;
}

// ---------------------------------------------------------------------------
// Image objects: PdfImageEditor (M4 §3: move, resize, replace, extract; ADR-0011)
// ---------------------------------------------------------------------------

/**
 * The filters of an image stream, as a kind: `DCT` (JPEG), `JPX` (JPEG 2000), `Flate`,
 * `CCITT` (fax), `JBIG2`, `LZW`, `RunLength`, the ASCII encodings, or `other`.
 */
export type ImageFilterKind =
  | 'DCT'
  | 'JPX'
  | 'Flate'
  | 'CCITT'
  | 'JBIG2'
  | 'LZW'
  | 'RunLength'
  | 'ASCIIHex'
  | 'ASCII85'
  | 'other';

/**
 * What identifies an image object for an edit, and what replay re-checks. Like
 * `TextRunRef`, the path describes the page *as it is when the edit runs*: after any edit on
 * a page, locate its images again.
 */
export interface ImageObjectRef {
  readonly source: SourceId;
  readonly pageIndex: number;
  /**
   * Index of the object among the page's objects (`FPDFPage_GetObject`), then, for images
   * inside Form XObjects, its index inside each enclosing form (`FPDFFormObj_GetObject`).
   */
  readonly objectPath: readonly number[];
  /** Pixel size of the image as located; an edit fails with `stale-image` when it differs. */
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  /**
   * Bounds as located (unrotated user space); an edit fails with `stale-image` when the
   * object's bounds differ by more than `IMAGE_BOUNDS_TOLERANCE`.
   */
  readonly bounds: Rect;
}

/** Tolerance of the bounds re-check (points): matrices are single precision in PDFium. */
export const IMAGE_BOUNDS_TOLERANCE = 0.05;

/** One image object of a page (`PdfImageEditor.locateImages`). */
export interface LocatedImage extends ImageObjectRef {
  /**
   * The object's matrix in page space (enclosing forms applied): it maps the unit square
   * (the image, bottom-up) onto the page. `bounds` is the unit square's bounding box under it.
   */
  readonly matrix: TextMatrix;
  /** Filters of the image stream, in order (e.g. `['DCT']`); empty when unfiltered. */
  readonly filters: readonly ImageFilterKind[];
  /**
   * The image has transparency: a soft mask (/SMask), a colour-key or stencil /Mask, or it
   * is itself a stencil mask. Saving the original JPEG (`ExtractedImage.original`) drops it.
   */
  readonly hasSMask: boolean;
  /**
   * The image is drawn by a Form XObject (`objectPath.length > 1`). A form may be drawn more
   * than once (other pages, or several places on this one), and changing an image inside it
   * changes every place the form is drawn; PDFium does not tell which forms are shared, so
   * the UI warns for every image in a form.
   */
  readonly inForm: boolean;
  /** Bits per pixel and colour space (`FPDFImageObj_GetImageMetadata`), when known. */
  readonly bitsPerPixel: number;
  readonly colorSpace: string;
  /** Effective resolution on the page: pixels per inch along the image's own axes. */
  readonly dpi: { readonly x: number; readonly y: number };
}

/**
 * Where an image goes: a page-space matrix (as `LocatedImage.matrix`), or a user-space rect
 * the image's bounds must fill (the matrix is scaled and moved; rotation and skew kept).
 */
export type ImageTransformTarget = { readonly matrix: TextMatrix } | { readonly rect: Rect };

/**
 * New pixels for an image object: RGBA (straight alpha, row-major, top row first; alpha
 * becomes a soft mask), or encoded JPEG bytes (embedded as they are, DCTDecode) or PNG bytes
 * (decoded by PDFium and stored with Flate).
 */
export type ImageReplacement =
  | {
      readonly rgba: Uint8Array | Uint8ClampedArray;
      readonly width: number;
      readonly height: number;
    }
  | { readonly jpeg: Uint8Array }
  | { readonly png: Uint8Array };

/** An image object's pixels (`PdfImageEditor.extractImage`). */
export interface ExtractedImage {
  /** Pixel size (the image's own, independent of its size on the page). */
  readonly width: number;
  readonly height: number;
  /** RGBA, straight alpha, top row first: decode, colour conversion and masks applied. */
  readonly rgba: Uint8ClampedArray;
  /**
   * The stream's own bytes, when they are a file as is: a DCT-only image in DeviceRGB or
   * DeviceGray whose JPEG decodes to the pixels the page shows (no inverting /Decode, no
   * colour conversion). Masks are not in it (`rgba` has them).
   */
  readonly original?: { readonly bytes: Uint8Array; readonly mime: 'image/jpeg' };
}

export interface ImageEditResult {
  /** The image after the edit (re-located at the same path); absent after a removal. */
  readonly image?: LocatedImage;
  /** The page-space matrix before the edit (the inverse of a transform sets it again). */
  readonly previousMatrix: TextMatrix;
  /** Largest difference between the expected and the re-located bounds, points. */
  readonly drift: number;
}

/**
 * Image objects of an open source (M4 §3). Implemented in the PDFium host (`image-objects/`),
 * exposed across the worker by `PdfiumProxy`. Every mutation regenerates the page content
 * (`FPDFPage_GenerateContent`) and is verified by locating the page's images again.
 */
export interface PdfImageEditor {
  /** Image objects of a page (forms walked up to three levels deep), in paint order. */
  locateImages(
    source: SourceId,
    pageIndex: number,
    options?: EngineCallOptions,
  ): Promise<readonly LocatedImage[]>;
  /** The image's pixels, and its original JPEG bytes when it is a DCT-only image. */
  extractImage(ref: ImageObjectRef, options?: EngineCallOptions): Promise<ExtractedImage>;
  /** Moves / resizes the image (sets its matrix). */
  transformImage(
    ref: ImageObjectRef,
    target: ImageTransformTarget,
    options?: EngineCallOptions,
  ): Promise<ImageEditResult>;
  /** Removes the image object from the page (or from its form). */
  removeImage(ref: ImageObjectRef, options?: EngineCallOptions): Promise<ImageEditResult>;
  /** Replaces the image's pixels, keeping its place (matrix) on the page. */
  replaceImage(
    ref: ImageObjectRef,
    replacement: ImageReplacement,
    options?: EngineCallOptions,
  ): Promise<ImageEditResult>;
}

// ---------------------------------------------------------------------------
// Digital signatures (M5, spec recognize-and-compare §3, ADR-0013)
// ---------------------------------------------------------------------------

/**
 * What the offline check found (ADR-0013). Never "valid": there is no trust store, no
 * revocation and no timestamp authority on this device.
 * - `intact`: the CMS verifies over its byte range and the range covers the whole file;
 * - `intact-changed-later`: verifies; later revisions add only annotations, form values,
 *   metadata or another signature (or DSS), listed in `laterChanges`;
 * - `changed-after-signing`: verifies; later revisions touch page content, resources, the
 *   page tree or the catalog in other ways;
 * - `broken`: digest, signature or signing-certificate mismatch, or a byte range that is
 *   malformed or does not end at a revision boundary;
 * - `cannot-check`: unsupported SubFilter or algorithm, or an unreadable CMS.
 */
export type SignatureStatus =
  | 'intact'
  | 'intact-changed-later'
  | 'changed-after-signing'
  | 'broken'
  | 'cannot-check';

/** The fixed line every signature status carries; the UI renders it (translated) verbatim. */
export const SIGNATURE_HONESTY_LINE =
  'Checked on this device against the certificates in the file. Signer identity, trust and revocation are not verified.';

export type SignatureCheckId =
  | 'byte-range'
  | 'digest'
  | 'signature'
  | 'signing-certificate'
  | 'chain'
  | 'validity'
  | 'key-usage'
  | 'timestamp'
  | 'later-changes';

export type SignatureCheckOutcome = 'pass' | 'fail' | 'not-checked' | 'unsupported';

/** One check and its outcome; `detail` is an English fact line for the expandable view. */
export interface SignatureCheck {
  readonly id: SignatureCheckId;
  readonly outcome: SignatureCheckOutcome;
  readonly detail: string;
}

export type RevisionChangeKind =
  | 'form-fill'
  | 'annotations'
  | 'signature'
  | 'dss'
  | 'metadata'
  | 'pages'
  | 'content'
  | 'other';

/** Objects a later incremental revision changed, grouped by kind. */
export interface RevisionChange {
  /** 1-based revision (file order) that wrote the objects. */
  readonly revision: number;
  readonly kind: RevisionChangeKind;
  /** 0-based page indices the change is on (empty when it is not on a page). */
  readonly pages: readonly number[];
  /** The changed objects, e.g. `14 0 R`. */
  readonly objects: readonly string[];
}

/** One certificate as facts (no trust judgement). */
export interface SignerFacts {
  /** RFC 4514 string, e.g. `CN=Ada Lovelace,O=Example`. */
  readonly subject: string;
  readonly issuer: string;
  readonly commonName?: string;
  /** Serial number in hex, as openssl prints it. */
  readonly serialNumber: string;
  /** ISO 8601. */
  readonly notBefore: string;
  readonly notAfter: string;
  /** e.g. `RSA 2048`, `ECDSA P-256`. */
  readonly publicKey: string;
  /** The certificate's own signature algorithm, e.g. `RSASSA-PKCS1-v1_5 with SHA-256`. */
  readonly signatureAlgorithm: string;
  readonly selfSigned: boolean;
  /** keyUsage bits by name, when the extension is present. */
  readonly keyUsage?: readonly string[];
  /** SHA-256 fingerprint of the DER, lower-case hex. */
  readonly sha256: string;
}

/** Spec §3.3 name for `SignerFacts`. */
export type CertificateSummary = SignerFacts;

/** The validator's result for one signature (a /Sig field with /V, or a /Perms entry). */
export interface SignatureReport {
  /** Fully qualified field name; `/Perms /<key>` for a usage-rights dictionary. */
  readonly fieldName: string;
  /** First widget's page and rect (unrotated user space), when the field has a widget. */
  readonly pageIndex?: number;
  readonly rect?: Rect;
  readonly filter?: string;
  /** /SubFilter without the slash; empty when absent. */
  readonly subFilter: string;
  /** The /ByteRange as written (may be malformed; see the `byte-range` check). */
  readonly byteRange: readonly number[];
  /** 1-based revision whose end the byte range reaches, when it reaches one. */
  readonly revision?: number;
  /** Revisions in the file (`startxref … %%EOF` trailers). */
  readonly revisionCount: number;
  readonly coversWholeFile: boolean;
  readonly status: SignatureStatus;
  /** Always `SIGNATURE_HONESTY_LINE`. */
  readonly honesty: string;
  readonly checks: readonly SignatureCheck[];
  /** Changes made by revisions after the signed one (empty when the range covers the file). */
  readonly laterChanges: readonly RevisionChange[];
  /** The certificate the CMS names as signer. */
  readonly signer?: SignerFacts;
  /** Certificates as embedded: the path built from the signer as far as it goes, leaf first. */
  readonly chain: readonly SignerFacts[];
  /** /M as ISO 8601, "claimed by the signer" (not a trusted time). */
  readonly claimedTime?: string;
  readonly reason?: string;
  readonly location?: string;
  readonly contactInfo?: string;
  /** /Name of the signature dictionary. */
  readonly signerName?: string;
  /** e.g. `SHA-256`. */
  readonly digestAlgorithm?: string;
  /** e.g. `RSASSA-PKCS1-v1_5`, `RSA-PSS`, `ECDSA P-256`. */
  readonly signatureAlgorithm?: string;
  /** Signed attribute names (`contentType`, `messageDigest`, `signingCertificateV2`, …). */
  readonly signedAttributes: readonly string[];
  /** SHA-1 (or another weak choice) was used; `weakReasons` says which. */
  readonly weak: boolean;
  readonly weakReasons: readonly string[];
  /** DocMDP /P when this is a certification signature (1 no changes, 2 forms, 3 annots). */
  readonly docMdpPermissions?: 1 | 2 | 3;
  /**
   * The time a timestamp authority vouches for (spec §3.3): a document timestamp's own
   * `TSTInfo` (`/SubFilter /ETSI.RFC3161`), or the signature timestamp token embedded in the
   * CMS when its imprint and signature check out. The authority is named, never trusted.
   */
  readonly timestamp?: { readonly time: string; readonly tsa: string };
  /**
   * 0-based page indices whose rendering differs between the signed revision and the whole
   * file (spec §3.1 step 6, §3.3), including indices only one of them has. Absent when the
   * range covers the file, the signature did not verify, or no renderer was configured
   * (`ValidateSignaturesOptions.visual`).
   */
  readonly visuallyChangedPages?: readonly number[];
}

/** Spec §3.3 name for `SignatureReport`. */
export type SignatureValidation = SignatureReport;

export interface ValidateSignaturesOptions extends EngineCallOptions {
  /** For encrypted files: decrypts /M, /Reason and field names (the check itself needs none). */
  readonly password?: string;
  /**
   * Renders the signed revision and the whole file with a private PDFium and compares the
   * pages (spec §3.1 step 6): `pdfiumWasm` is the self-hosted `pdfium.wasm` (URL or bytes),
   * `dpi` defaults to 50. Without it, `visuallyChangedPages` is absent.
   */
  readonly visual?: { readonly pdfiumWasm: string | ArrayBuffer; readonly dpi?: number };
}

/** A PAdES-B approval signature to add (spec §3.2). */
export interface SignRequest {
  /** The .p12/.pfx file (PBES2 only). Transferred to the worker and dropped after use. */
  readonly pkcs12: ArrayBuffer;
  readonly password: string;
  readonly reason?: string;
  readonly location?: string;
  readonly contactInfo?: string;
  /** New field name; default `Signature1` (or the next free `SignatureN`). */
  readonly fieldName?: string;
  /** A visible widget with the signer name and date; invisible when absent. */
  readonly visible?: { readonly pageIndex: number; readonly rect: Rect };
  /** Name shown in a visible widget and written as /Name; default the certificate's CN. */
  readonly signerName?: string;
  /** Bytes reserved for the DER CMS (default 16384; at least 4096). */
  readonly reserveBytes?: number;
  /** The claimed time (/M); default now. ISO 8601 or a Date. */
  readonly date?: string | Date;
}

export interface SignOptions extends EngineCallOptions {
  readonly onProgress?: ProgressCallback;
}

export interface SignResult {
  /** The signed file: the input bytes unchanged plus one incremental section. */
  readonly bytes: ArrayBuffer;
  /** The validator's report on the new signature (always `intact`, or signing fails). */
  readonly report: SignatureReport;
  readonly fieldName: string;
  readonly byteRange: readonly [number, number, number, number];
  /** The appended section's xref kind (matches the source). */
  readonly xrefKind: 'table' | 'stream';
  /** DER size of the CMS and the space reserved for it. */
  readonly cmsBytes: number;
  readonly reserveBytes: number;
  readonly signer: SignerFacts;
}

/** Why signing refused or failed (`SigningError.reason`; the `EngineError.code` is coarser). */
export type SigningFailureReason =
  | 'encrypted-input'
  | 'damaged-input'
  | 'legacy-pkcs12'
  | 'bad-password'
  | 'malformed-pkcs12'
  | 'no-key'
  | 'unsupported-key'
  | 'field-exists'
  | 'bad-request'
  | 'reserve-too-small'
  | 'verification-failed';

/** A signing refusal or failure. Crosses the worker as a value (see signature-protocol). */
export class SigningError extends EngineError {
  constructor(
    readonly reason: SigningFailureReason,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(SIGNING_ERROR_CODES[reason], message, options);
    this.name = 'SigningError';
  }
}

const SIGNING_ERROR_CODES: Record<SigningFailureReason, EngineErrorCode> = {
  'encrypted-input': 'unsupported-encryption',
  'damaged-input': 'corrupt',
  'legacy-pkcs12': 'unsupported',
  'bad-password': 'password-incorrect',
  'malformed-pkcs12': 'corrupt',
  'no-key': 'unsupported',
  'unsupported-key': 'unsupported',
  'field-exists': 'unsupported',
  'bad-request': 'internal',
  'reserve-too-small': 'internal',
  'verification-failed': 'internal',
};

// ---------------------------------------------------------------------------
// Compare two documents (M5 spec recognize-and-compare §2): the analysis worker
// ---------------------------------------------------------------------------

/**
 * How a page is laid out for comparison: its unrotated CropBox size, the lower-left corner of
 * that box in user space, and the rotation it is displayed (and rendered) with: the page's
 * /Rotate plus any view rotation. Renders and pixel regions use this display frame; tokens,
 * regions and facts are reported in unrotated user space.
 */
export interface ComparePageGeometry {
  readonly size: Size;
  readonly rotation: Rotation;
  /** CropBox lower-left corner in user space; (0, 0) when absent. */
  readonly origin?: { readonly x: number; readonly y: number };
}

/** One page's input to a comparison: geometry plus `getPageText` runs (glyph boxes). */
export interface ComparePageInput extends ComparePageGeometry {
  readonly runs: readonly TextRun[];
}

/** A word (or punctuation mark) of a page, normalised for comparison, with its glyph boxes. */
export interface CompareToken {
  /** Normalised text (NFKC, no soft hyphens, line-end hyphenation joined). */
  readonly text: string;
  /** Glyph boxes in user space, one per line the token spans (hyphenated words have two). */
  readonly rects: readonly Rect[];
}

/**
 * Pixels handed to the analysis worker: an `ImageBitmap` (transferred and closed there) or
 * RGBA bytes (straight alpha, row-major, top row first; the buffer is transferred).
 */
export type AnalysisRaster =
  | ImageBitmap
  | {
      readonly width: number;
      readonly height: number;
      readonly data: Uint8ClampedArray;
    };

/** RGBA pixels returned by the analysis worker (heat maps). */
export interface AnalysisRgba {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

export type CompareAlignment = 'auto' | 'index' | 'best-match';

/**
 * A row of the page map: `a` and `b` are page indices (0-based) in each document; a missing
 * side is a deleted (`b` absent) or inserted (`a` absent) page. `similarity` is the
 * alignment's confidence in [0, 1]: Jaccard similarity of word 3-shingles (`basis: 'text'`),
 * 32×32 thumbnail similarity (`'thumbnail'`, pages without text), or, for unpaired pages,
 * the best similarity any page of the other document reached.
 */
export interface PagePair {
  readonly a?: number;
  readonly b?: number;
  readonly similarity: number;
  readonly basis: 'text' | 'thumbnail' | 'index' | 'none';
}

/**
 * Pixel difference of one aligned page pair, rendered at `dpi` in a common top-left frame
 * (`width` × `height` px: the larger of both pages on each axis). JSON-serialisable: the
 * heat map stays in the worker under `heatmapId` (fetch it with `heatmap(job, id)`).
 */
export interface PixelDiffResult {
  readonly dpi: number;
  readonly width: number;
  readonly height: number;
  /** Changed pixels (pixelmatch, anti-aliasing excluded) in the common frame. */
  readonly changedPixels: number;
  /** `changedPixels / (width × height)`. */
  readonly changedRatio: number;
  /** Changed areas (8 px grid cells, clustered) in the second document's user space. */
  readonly regions: readonly Rect[];
  /** The same areas in the first document's user space. */
  readonly regionsA: readonly Rect[];
  /** The pages render at different pixel sizes (the difference counts as changed pixels). */
  readonly sizeMismatch: boolean;
  /** Present when `changedPixels > 0`. */
  readonly heatmapId?: string;
}

/** Where a text change sits on one side: page, the text as extracted, glyph boxes per line. */
export interface TextSpanRef {
  readonly page: number;
  readonly text: string;
  readonly rects: readonly Rect[];
  /** The line(s) the span sits on, for context ("… on Monday after …"). */
  readonly line?: string;
}

/**
 * A word-level text change: `removed` (only `a`), `added` (only `b`) or `changed` (both, the
 * removed words replaced by the added ones). A change that crosses a page break is split.
 */
export interface TextChange {
  readonly kind: 'added' | 'removed' | 'changed';
  readonly a?: TextSpanRef;
  readonly b?: TextSpanRef;
}

export interface TextComparison {
  /**
   * `document`: one diff over the paired pages' words in page-map order (text reflowing
   * across a page break is not a change); `page-pairs`: one diff per pair, used when asked
   * or when the document diff exceeded its time budget.
   */
  readonly scope: 'document' | 'page-pairs';
  readonly changes: readonly TextChange[];
  /** Pairs whose own diff also ran out of time: reported as whole-page replacements. */
  readonly pairsOverBudget: readonly number[];
  readonly tokens: { readonly a: number; readonly b: number };
}

/** What the facts diff compares (spec §2.1 "Facts"), gathered from inspection data. */
export interface CompareFacts {
  /** Info dictionary text entries (Title, Author, …, custom keys), name without slash. */
  readonly info: Readonly<Record<string, string>>;
  /** Simple XMP properties (`dc:title`, `pdf:Producer`, `xmp:CreatorTool`, …) when read. */
  readonly xmp?: Readonly<Record<string, string>>;
  readonly pages: readonly { readonly size: Size; readonly rotation: Rotation }[];
  /** Per page: annotation subtype (e.g. `Highlight`, `Link`) → count; widgets and popups excluded. */
  readonly annotations: readonly Readonly<Record<string, number>>[];
  readonly formFields: readonly {
    readonly name: string;
    readonly kind: string;
    readonly value?: string;
  }[];
  /** Embedded file names (document-level and file attachment annotations). */
  readonly attachments: readonly string[];
  /** Signature fields and whether each carries a signature value (never validated here). */
  readonly signatures: readonly { readonly field: string; readonly signed: boolean }[];
}

export type FactChangeKind =
  | 'page-count'
  | 'metadata'
  | 'xmp'
  | 'page-size'
  | 'page-rotation'
  | 'annotations'
  | 'form-field'
  | 'attachment'
  | 'signature';

/** One difference in the facts; values are display strings, a missing side is absence. */
export interface FactChange {
  readonly kind: FactChangeKind;
  /** The key (`Title`, `dc:title`, `Highlight`, a field or file name, `size`, …). */
  readonly key: string;
  readonly a?: string;
  readonly b?: string;
  /** For page facts: the page in each document (0-based). */
  readonly aPage?: number;
  readonly bPage?: number;
}

export type ComparePairStatus = 'identical' | 'changed' | 'inserted' | 'deleted';

/** The outcome for one row of the page map. */
export interface ComparePairResult {
  readonly pair: PagePair;
  readonly status: ComparePairStatus;
  /** Absent for inserted and deleted pages, and when the visual diff was not run. */
  readonly visual?: PixelDiffResult;
  /** Text changes that touch this pair's pages. */
  readonly textChanges: number;
  /** Word count of an inserted or deleted page. */
  readonly words?: number;
  /** First line of an inserted or deleted page (its heading, usually). */
  readonly firstLine?: string;
  /** Page size or rotation differs (also listed in `facts`). */
  readonly geometryChanged: boolean;
}

export interface CompareSideSummary {
  readonly name: string;
  readonly fingerprint?: string;
  readonly pageCount: number;
}

/** The whole comparison, JSON-serialisable (heat maps are referenced by id). */
export interface ComparisonResult {
  readonly version: 1;
  readonly a: CompareSideSummary;
  readonly b: CompareSideSummary;
  readonly settings: {
    readonly alignment: 'index' | 'best-match';
    readonly dpi: number;
    readonly threshold: number;
    readonly visual: boolean;
    readonly text: boolean;
  };
  readonly pages: readonly ComparePairResult[];
  readonly text: TextComparison;
  readonly facts: readonly FactChange[];
  readonly counts: {
    readonly identical: number;
    readonly changed: number;
    readonly inserted: number;
    readonly deleted: number;
    readonly textAdded: number;
    readonly textRemoved: number;
    readonly textChanged: number;
    readonly visualRegions: number;
    readonly facts: number;
  };
  /** Fixed honesty lines (English) the UI and the report show with the result. */
  readonly notes: readonly string[];
}

export type ComparePhase = 'text' | 'thumbnails' | 'align' | 'visual' | 'text-diff' | 'facts';

export interface CompareProgress {
  readonly phase: ComparePhase;
  readonly done: number;
  readonly total: number;
}

export interface CompareOptions extends EngineCallOptions {
  /**
   * `auto` (default): by index when the page counts match and every positional pair is
   * similar enough (above `minSimilarity`), best match otherwise.
   */
  readonly alignment?: CompareAlignment;
  /** Render resolution of the visual diff (default 100). */
  readonly dpi?: number;
  /** pixelmatch threshold (default 0.1). */
  readonly threshold?: number;
  /** Default `document`; falls back to `page-pairs` when over budget. */
  readonly textScope?: 'document' | 'page-pairs';
  /** Document language for word segmentation (`Intl.Segmenter`); default `en`. */
  readonly locale?: string;
  /** Join words hyphenated at a line end (default true). */
  readonly joinHyphens?: boolean;
  /** Run the visual diff (default true). */
  readonly visual?: boolean;
  /** Run the text diff (default true). */
  readonly text?: boolean;
  /** Best match pairs two pages only above this similarity (default 0.15). */
  readonly minSimilarity?: number;
  readonly onProgress?: (progress: CompareProgress) => void;
  /** Called as each pair's visual diff lands (in processing order), before the text diff. */
  readonly onPair?: (index: number, pair: PagePair, visual: PixelDiffResult) => void;
  /**
   * Order in which pairs are diffed visually (indices into the page map), e.g. the pages
   * on screen first; pairs not listed follow in page-map order.
   */
  readonly visualOrder?: (pairs: readonly PagePair[]) => readonly number[];
}

// ---------------------------------------------------------------------------
// PDF → text / Markdown (M5 spec §4): the analysis worker
// ---------------------------------------------------------------------------

/** An image drawn on a page, as placed (unrotated user space) and optionally its pixels. */
export interface ConvertImageInput {
  readonly rect: Rect;
  /** Encoded PNG or JPEG bytes (JPEG is passed through), or RGBA pixels (encoded as PNG). */
  readonly png?: Uint8Array;
  readonly jpeg?: Uint8Array;
  readonly rgba?: {
    readonly width: number;
    readonly height: number;
    readonly data: Uint8Array | Uint8ClampedArray;
  };
}

export interface ConvertLinkInput {
  readonly rect: Rect;
  readonly uri: string;
}

/** One page's input to a conversion (from `getPageText`, link annotations, `locateImages`). */
export interface ConvertPageInput extends ComparePageGeometry {
  readonly runs: readonly TextRun[];
  readonly links?: readonly ConvertLinkInput[];
  readonly images?: readonly ConvertImageInput[];
}

export type ConvertPageBreak = 'none' | 'rule' | 'comment';

export interface ConvertOptions {
  readonly format?: 'markdown' | 'text';
  /** `document` (default): one file; `pages`: one file per page. */
  readonly scope?: 'document' | 'pages';
  /** Between pages in a document-scope file (default `none`). */
  readonly pageBreak?: ConvertPageBreak;
  /** Keep running headers, footers and page numbers (default false: dropped). */
  readonly keepHeadersFooters?: boolean;
  /** Join words hyphenated at a line end (default true). */
  readonly joinHyphens?: boolean;
  /** Markdown: include images (written as files under `images/`); default true. */
  readonly images?: boolean;
  /**
   * Markdown: start the file with an HTML comment saying how it was made and what is not
   * reconstructed (tables, rotated text); default false.
   */
  readonly headerComment?: boolean;
  /** Base name of the document-scope file (default `document`). */
  readonly baseName?: string;
}

export type ConvertBlockKind = 'heading' | 'paragraph' | 'list-item' | 'image';

export interface ConvertReport {
  readonly pages: number;
  /** Pages (0-based) without extractable text: candidates for OCR. */
  readonly pagesWithoutText: readonly number[];
  readonly headings: number;
  readonly paragraphs: number;
  readonly listItems: number;
  readonly images: number;
  readonly links: number;
  /** Groups of lines laid out like a table (their text is emitted in reading order). */
  readonly suspectedTables: number;
  readonly bodyFontSize?: number;
  readonly dropped: readonly {
    readonly page: number;
    readonly text: string;
    readonly reason: 'running-header' | 'running-footer' | 'page-number';
  }[];
  /** Fixed honesty lines (English). */
  readonly notes: readonly string[];
}

export interface ConvertFile {
  /** Relative path, e.g. `document.md`, `page-003.md`, `images/p1-1.png`. */
  readonly path: string;
  readonly mime: string;
  readonly bytes: Uint8Array;
}

export interface ConvertResult {
  readonly format: 'markdown' | 'text';
  /** The text of the document-scope file (or every page file joined), for previews. */
  readonly text: string;
  /** One string per page (the per-page file contents). */
  readonly pageTexts: readonly string[];
  /** Text files first, then images. */
  readonly files: readonly ConvertFile[];
  /** A ZIP of `files` when there is more than one file; absent otherwise. */
  readonly zip?: Uint8Array;
  readonly report: ConvertReport;
}

// ---------------------------------------------------------------------------
// OCR to searchable PDF (M5 §1, ADR-0012, research 07)
// ---------------------------------------------------------------------------

/**
 * Page quality from the mean confidence of the kept words (confidence ≥
 * `OCR_MIN_WORD_CONFIDENCE`): good ≥ 90, review 80–90, poor < 80, `no-text` when no word is
 * kept (thresholds from spike S1, research 07 §7).
 */
export type OcrQuality = 'good' | 'review' | 'poor' | 'no-text';

/** Words below this confidence are dropped as noise (counted in `OcrPageResult.dropped`). */
export const OCR_MIN_WORD_CONFIDENCE = 30;
/** Kept words below this confidence are listed as low-confidence (research 07: 84–87% right). */
export const OCR_LOW_CONFIDENCE = 90;
/** Mean confidence at or above which a page is `good`, and at or above which it is `review`. */
export const OCR_QUALITY_THRESHOLDS = { good: 90, review: 80 } as const;

/** What a page already has, so the dialog can propose "pages without text" (spec §1.2). */
export interface OcrPageFacts {
  readonly pageIndex: number;
  /** Any text drawn visibly (render mode other than 3 and 7), whitespace aside. */
  readonly visibleText: boolean;
  /**
   * Invisible (render mode 3 or 7) text: none, only this app's layer, or other text (another
   * tool's OCR layer, possibly next to ours: see `ourLayer`).
   */
  readonly invisibleText: 'none' | 'ours' | 'foreign';
  /** This app's OCR layer (marked content `/PdfEditorOCR`) is on the page. */
  readonly ourLayer: boolean;
  /** Image objects on the page, Form XObjects included. */
  readonly images: number;
  /** Images and no visible text: a scan. */
  readonly imageOnly: boolean;
  /** Effective DPI of the largest image (the lower of its two axes), rounded. */
  readonly imageDpi?: number;
}

/**
 * An 8-bit greyscale page raster for OCR (binary PGM, `P5`), in display orientation (the
 * page's /Rotate plus the requested extra rotation), without annotations or form widgets.
 */
export interface OcrRaster {
  readonly pageIndex: number;
  /** The PGM file: a short header and `width × height` bytes, rows top-down. */
  readonly bytes: ArrayBuffer;
  readonly width: number;
  readonly height: number;
  readonly dpi: number;
  /** The DPI asked for, when the 40 MP cap lowered it. */
  readonly requestedDpi?: number;
  /**
   * Pixel (x right, y down, 0…width × 0…height) → unrotated user space: `x' = a·x + c·y + e`,
   * `y' = b·x + d·y + f`. Always orientation-reversing (the pixel y axis points down).
   */
  readonly toUser: TextMatrix;
}

export interface RenderForOcrOptions extends EngineCallOptions {
  /** Raster resolution; 200 (fast), 300 (standard), 400 (high). */
  readonly dpi: number;
  /** Extra clockwise rotation on top of /Rotate (the virtual page's delta). */
  readonly rotation?: Rotation;
  /** Pixel cap; the DPI is lowered to fit (default `OCR_MAX_PIXELS`). */
  readonly maxPixels?: number;
}

/** Default pixel cap of `renderForOcr` (spec §1.2: 40 MP per page). */
export const OCR_MAX_PIXELS = 40_000_000;

/** A pixel box of the raster: left, top, right, bottom (y down). */
export interface OcrPixelBox {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/**
 * What the invisible layer needs of a word (and what an `ocr.apply` edit stores): the text,
 * its baseline origin at the descender line, its advance along the baseline, the text size
 * and the baseline's angle, all in unrotated user space.
 */
export interface OcrLayerWord {
  readonly text: string;
  /** Start of the word on its line's descender line, user space. */
  readonly origin: { readonly x: number; readonly y: number };
  /** Advance along the baseline, points (the ink box's width). */
  readonly width: number;
  /** Text size, points (the line's row height: descender to ascender). */
  readonly fontSize: number;
  /** Baseline direction, degrees counter-clockwise in user space. */
  readonly angle: number;
  readonly confidence?: number;
}

/** A recognised word (spec §1.4, extended with pixel geometry and the line). */
export interface OcrWord extends OcrLayerWord {
  /** Ink box, unrotated user space (axis-aligned bounds of the pixel box). */
  readonly rect: Rect;
  readonly pixelBox: OcrPixelBox;
  readonly confidence: number;
  /** Index into `OcrPageResult.lines`. */
  readonly line: number;
  /** Confidence below `OCR_LOW_CONFIDENCE`: listed for review. */
  readonly lowConfidence: boolean;
}

/** A text line as Tesseract found it. */
export interface OcrLine {
  /** Baseline end points, raster pixels. */
  readonly baseline: OcrPixelBox;
  /** Baseline direction, degrees counter-clockwise in user space. */
  readonly angle: number;
  /** Row height (descender to ascender), points. */
  readonly fontSize: number;
}

/** What the layer writer needs of a page (`OcrPageResult` is one). */
export interface OcrLayerPage {
  readonly pageIndex: number;
  readonly words: readonly OcrLayerWord[];
  readonly languages: readonly string[];
  readonly dpi?: number;
  readonly quality?: OcrQuality;
  readonly meanConfidence?: number;
  readonly engine?: string;
}

export interface OcrPageResult extends OcrLayerPage {
  readonly dpi: number;
  /** Kept words (confidence ≥ `OCR_MIN_WORD_CONFIDENCE`), in reading order. */
  readonly words: readonly OcrWord[];
  readonly lines: readonly OcrLine[];
  /** Mean confidence of the kept words; 0 without any. */
  readonly meanConfidence: number;
  readonly quality: OcrQuality;
  /** Engine, core variant and model, e.g. "tesseract.js 7.0.0 relaxedsimd-lstm, tessdata_fast 87416418". */
  readonly engine: string;
  /** Words dropped as noise (confidence below `OCR_MIN_WORD_CONFIDENCE`). */
  readonly dropped: number;
  /** Kept words flagged `lowConfidence`. */
  readonly lowConfidence: number;
  /** Recognition time (not the render), ms. */
  readonly durationMs: number;
  /**
   * The per-page time budget ran out: the recognizer was terminated and replaced, no words
   * are kept and the page is `poor`.
   */
  readonly timedOut?: boolean;
}

/** An OCR run to write as invisible text (the payload of an `ocr.apply` edit, spec §1.3). */
export interface OcrLayerPlan {
  readonly pages: readonly OcrLayerPage[];
  /**
   * Existing invisible text on the plan's pages: keep it (`none`), drop this app's earlier
   * layer (`ours`, a re-run), or remove all render-mode-3/7 text (`all-invisible`, e.g.
   * another tool's layer; the page content is regenerated by PDFium for that).
   */
  readonly replace: 'none' | 'ours' | 'all-invisible';
  /** BCP 47 tag for the catalog's /Lang when it has none; default from the first language. */
  readonly lang?: string;
}

/** Checks of a written layer on a scratch copy of the output (per page). */
export interface OcrLayerPageCheck {
  readonly pageIndex: number;
  readonly words: number;
  /** Words found in order in PDFium's page text. */
  readonly found: number;
  /** Found words whose PDFium box is within 2 pt of the planned box on every edge. */
  readonly within2pt: number;
  /** Largest edge deviation of a found word, points. */
  readonly worstDeviation: number;
  /** Pixels that differ between renders before and after at 150 dpi (must be 0). */
  readonly pixelsDiffering: number;
}

export interface OcrLayerVerification {
  /** Every word found and no pixel changed. */
  readonly ok: boolean;
  readonly pages: readonly OcrLayerPageCheck[];
  readonly problems: readonly string[];
}

export interface OcrApplyResult {
  /** The layered file (transferred across the worker boundary). */
  readonly bytes: ArrayBuffer;
  readonly pages: readonly { readonly pageIndex: number; readonly words: number }[];
  readonly wordsWritten: number;
  /** Words without text or width, not written. */
  readonly wordsSkipped: number;
  /** Earlier layers of this app removed, and foreign invisible text objects removed. */
  readonly removed: { readonly ourLayers: number; readonly invisibleTextObjects: number };
  /** The source was encrypted; the layered output is not (as for redaction). */
  readonly decrypted: boolean;
  readonly verification: OcrLayerVerification;
  readonly durationMs: number;
}

/** OCR in the PDFium worker (spec §1.4), exposed by `PdfiumProxy`. */
export interface PdfOcrLayer {
  ocrPageFacts(id: SourceId, options?: EngineCallOptions): Promise<readonly OcrPageFacts[]>;
  renderForOcr(id: SourceId, pageIndex: number, options: RenderForOcrOptions): Promise<OcrRaster>;
  /**
   * Writes `plan` as invisible text: the source is saved as it is (security removed), the
   * layer added with pdf-lib, the result verified on scratch copies (every word found, the
   * render at 150 dpi pixel-identical) and, once verified, the open document is replaced
   * under the same id. Throws `EngineError` and leaves the source as it was otherwise.
   */
  applyOcrLayer(
    id: SourceId,
    plan: OcrLayerPlan,
    options?: EngineCallOptions,
  ): Promise<OcrApplyResult>;
}

/** Progress of `OcrRecognizer` calls. */
export interface OcrProgress {
  readonly phase: 'download' | 'start' | 'recognize';
  /** Bytes (download) or 0–1 (start, recognize). */
  readonly done: number;
  readonly total: number;
  readonly language?: string;
}

export interface OcrRecognizeOptions extends EngineCallOptions {
  readonly onProgress?: (progress: OcrProgress) => void;
}

/** The browser adapter over tesseract.js (spec §1.4, ADR-0007); runs on the main thread. */
export interface OcrRecognizer {
  /** Engine and model, as `OcrPageResult.engine` reports it. */
  readonly engine: string;
  /** Downloads (or reads from the device) and checks the packs; starts a recognizer. */
  ensureLanguages(codes: readonly string[], options?: OcrRecognizeOptions): Promise<void>;
  recognize(
    raster: OcrRaster,
    pageIndex: number,
    codes: readonly string[],
    options?: OcrRecognizeOptions,
  ): Promise<OcrPageResult>;
  /** Terminates every recognizer; the next call starts new ones. */
  dispose(): Promise<void>;
}

/** Summary of a finished run for the history label and the export summary. */
export interface OcrReport {
  readonly pages: number;
  readonly languages: readonly string[];
  readonly quality: readonly { readonly pageIndex: number; readonly quality: OcrQuality }[];
  /** Pages per quality. */
  readonly byQuality: Readonly<Record<OcrQuality, number>>;
  readonly words: number;
  readonly lowConfidence: number;
  readonly dropped: number;
  readonly timedOut: number;
  /** Recognition time summed over pages (ms), and the wall time the caller measured. */
  readonly recognizeMs: number;
  readonly totalMs?: number;
}

// ---------------------------------------------------------------------------
// Paragraph layout: rewrap, justification and overflow (spec craft §4.3, §4.5, §4.6)
// ---------------------------------------------------------------------------

/**
 * One word of a rewritten line (a run of characters between word gaps), placed along the
 * baseline. On justified lines the writer emits one object per word: `Tw` does nothing for
 * two-byte fonts and PDFium cannot write `TJ`.
 */
export interface LayoutWord {
  /** UTF-16 offsets in `ParagraphLayout.text`. */
  readonly start: number;
  readonly end: number;
  readonly text: string;
  /** Origin of the first glyph, paragraph text space (the measure's units), and the width. */
  readonly x: number;
  readonly width: number;
}

/**
 * A stretch of a rewritten line set in one style and one font. On lines that are not
 * justified it spans the line (word gaps included) unless the style or font changes, or the
 * style has no space glyph; on justified lines it is one word, or the part of a word in one
 * style and font.
 */
export interface LayoutRun {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  /** Style id of the input. */
  readonly style: string;
  /** The substitute face setting these characters; absent for the original font. */
  readonly font?: string;
  readonly x: number;
  readonly width: number;
  /**
   * One entry per character (code point) of `text`: the displacement, in points along the
   * baseline, added after that character's advance: harvested kerning where the pair recurs,
   * and at a word gap the difference between the gap and the space glyph's advance.
   */
  readonly kerning: readonly number[];
}

/** How a line of the new layout relates to the original paragraph. */
export type LayoutLineStatus =
  /** Before the edit: byte-identical, the writer leaves it alone. */
  | 'kept'
  /** Set anew from the paragraph's text. */
  | 'rewritten'
  /** After the rewrap converged: the original line, moved down by `dy`. */
  | 'reused';

export interface LayoutLine {
  readonly status: LayoutLineStatus;
  /** Index of the original line (kept and reused lines). */
  readonly source?: number;
  /** UTF-16 offsets in `ParagraphLayout.text`: first character, end of the last visible one, next line's start. */
  readonly start: number;
  readonly end: number;
  readonly next: number;
  /** The visible text (`text.slice(start, end)`). */
  readonly text: string;
  /** Baseline, distance below the first line's baseline (points, positive downward). */
  readonly y: number;
  /** Reused lines: the vertical move from their original baseline (positive downward). */
  readonly dy: number;
  /** Rewritten lines: start and width of the set text (with the hyphen, if any). */
  readonly x: number;
  readonly width: number;
  /** The line is justified to the measure. */
  readonly justified: boolean;
  /** A justified paragraph's line left ragged: its gaps would pass 1.5 × the natural space. */
  readonly ragged: boolean;
  /** One word wider than the measure. */
  readonly overfull: boolean;
  /** The line ends at a line break the user typed. */
  readonly forced: boolean;
  /** The original line-end hyphen kept at this unchanged line end: where it goes, in which style. */
  readonly hyphen?: { readonly x: number; readonly style: string };
  /** Rewritten lines only (empty otherwise). */
  readonly words: readonly LayoutWord[];
  readonly runs: readonly LayoutRun[];
}

/** A character the original font lacks, set in a bundled substitute (the honesty line). */
export interface LayoutSubstitution {
  readonly char: string;
  readonly font: string;
}

/** The paragraph after an edit, laid out (pure arithmetic: no engine call). */
export interface ParagraphLayout {
  /** The paragraph's text after the edit. */
  readonly text: string;
  readonly lines: readonly LayoutLine[];
  /** New line count minus the original one. */
  readonly lineDelta: number;
  /** Index of the first rewritten line, -1 when none is. */
  readonly firstRewritten: number;
  /** Some justified line had to stay ragged; the editor says so. */
  readonly ragged: boolean;
  /** Characters set in a substitute, one entry per character. */
  readonly substituted: readonly LayoutSubstitution[];
  /** Characters neither the original font nor its substitute has (the edit is refused). */
  readonly unsupported: readonly string[];
  /** Last baseline below the first, after and before the edit (points). */
  readonly height: number;
  readonly originalHeight: number;
  /** Factors applied to the natural word gap and to the leading of rewritten lines (1 = none). */
  readonly wordSpacing: number;
  readonly leading: number;
}

/**
 * What to do with a paragraph that changed height (spec craft §4.6), in order: commit,
 * grow into the gap below, tighten word spacing then leading, or run over with a warning.
 * Moving text to the next page is never an outcome, and the glyph size never changes.
 */
export type OverflowDecision =
  /** Same or fewer lines. */
  | { readonly kind: 'commit'; readonly layout: ParagraphLayout }
  /** The growth fits the empty space below while keeping the original gap to the next block. */
  | { readonly kind: 'grow'; readonly layout: ParagraphLayout; readonly growth: number }
  | {
      readonly kind: 'tighten';
      /** The layout with the factors applied. */
      readonly layout: ParagraphLayout;
      /** Factor on the natural word gap (≥ 0.85) and on the rewritten lines' leading (≥ 0.95). */
      readonly wordSpacing: number;
      readonly leading: number;
      /** For "Spacing tightened by N %": the larger of the two reductions, whole percent (≥ 1). */
      readonly percent: number;
      readonly growth: number;
    }
  | {
      readonly kind: 'overflow';
      /** The untightened layout, as it will run over. */
      readonly layout: ParagraphLayout;
      readonly growth: number;
      /** Height beyond what the gap allows (growth − room), and the part overlapping the next block. */
      readonly excess: number;
      readonly overlap: number;
    };

// ---------------------------------------------------------------------------
// Paragraph editing: the writer, its dry run and preview (spec craft §4.4–§4.6, §8;
// ADR-0020 §3–§6). Implemented in `text-edit/paragraph-edit.ts`.
// ---------------------------------------------------------------------------

/**
 * The paragraph as `layoutParagraph` needs it (`text-edit/linebreak.ts`): text, style spans,
 * original lines, styles with advances, harvested kerning and substitutes, measure, alignment
 * and leading.
 */
export type ParagraphLayoutInput = LayoutInput;

/**
 * Why paragraph mode refuses a block (it stays editable per line where the run allows it):
 * - everything `detectParagraphs` refuses (`ParagraphRefusal`);
 * - `in-form`: the text is drawn by a Form XObject (tier 1 per line only, as before);
 * - `clipped`: the paragraph's objects share a clip path the rewritten glyphs would leave;
 * - `shared-object`: a text object the edit must change also draws text outside the edited
 *   lines (another paragraph, or a line the edit keeps);
 * - `shared-form`, `unreadable-encoding`: as for single-line edits (`TextEditBlocker`);
 * - `unsupported-chars`: a typed character neither the font nor a bundled face has.
 */
export type ParagraphEditRefusal =
  | ParagraphRefusal
  | 'in-form'
  | 'clipped'
  | 'shared-object'
  | 'shared-form'
  | 'unreadable-encoding'
  | 'unsupported-chars';

/** How a style of the paragraph is drawn (for the overlay) and its tier-1 substitute. */
export interface ParagraphStyleInfo {
  /** The style's `FPDF_FONT` number on the page (`LocatedRun.fontId`). */
  readonly fontId?: number;
  readonly font: TextRunFont;
  /** Font size (Tf) and the size on the page. */
  readonly fontSize: number;
  readonly size: number;
  /** Object matrix in page space: the linear part every written glyph of the style uses. */
  readonly matrix: TextMatrix;
  /** Fill colour, RGBA 0–255. */
  readonly fill?: readonly [number, number, number, number];
  readonly renderMode: number;
  /**
   * The bundled face characters the font lacks are set in (`LayoutStyle.substitute.font` is
   * its `face` key), its display family, and its size factor (x-heights matched).
   */
  readonly substitute: { readonly face: string; readonly family: string; readonly scale: number };
}

/**
 * Everything the paragraph editor needs to lay keystrokes out on the main thread (craft spec
 * §4.8): the layout input, the overflow facts and the styles. Read-only, run once when the
 * editor opens (`PdfTextEditor.analyzeParagraphLayout`).
 */
export interface ParagraphLayoutAnalysis {
  readonly ref: ParagraphRef;
  /** The original paragraph text (`ParagraphBlock.text`): `caretSpan` offsets refer to it. */
  readonly text: string;
  readonly input: ParagraphLayoutInput;
  /** Style id of `input.styles` → how it is drawn. */
  readonly styles: Readonly<Record<string, ParagraphStyleInfo>>;
  /**
   * For `decideOverflow`: the empty space below the paragraph's ink down to the next block
   * (or the bottom margin), and the gap to keep from that block (0 at the margin), points.
   */
  readonly gapBelow: number;
  readonly paragraphGap: number;
  /** Set when paragraph mode is refused; `input` then still describes the paragraph. */
  readonly refusal?: ParagraphEditRefusal;
}

/** The replaced range of the original paragraph text (`ParagraphBlock.text`, UTF-16). */
export interface ParagraphCaretSpan {
  readonly start: number;
  readonly end: number;
}

/** An edit of one paragraph: its whole text afterwards and where it changed. */
export interface ParagraphEdit {
  readonly ref: ParagraphRef;
  /**
   * The paragraph's text after the edit: the original text with `caretSpan` replaced, i.e.
   * `old.slice(0, start) + inserted + old.slice(end)`. `\n` is a typed line break.
   */
  readonly text: string;
  readonly caretSpan: ParagraphCaretSpan;
  /** Style id (`ParagraphLayoutAnalysis.input.styles`) of the inserted text; default: the caret's. */
  readonly style?: string;
  /**
   * A layout of this edit made from the paragraph's `analyzeParagraphLayout` input (the
   * overlay's, or the one recorded for replay), written as it is. Omitted: the engine lays
   * the paragraph out and applies the overflow policy (`decideOverflow`).
   */
  readonly layout?: ParagraphLayout;
}

export interface ParagraphEditOptions extends EngineCallOptions {
  /**
   * `false`: dry run on a private copy of the page (the source never changes); `true`: the
   * same on the source, ending with one `GenerateContent`.
   */
  readonly commit: boolean;
}

/** An annotation moved with the words it lies on. */
export interface ParagraphMovedAnnotation {
  /** Index on the page (`FPDFPage_GetAnnot`) and /NM, when it has one. */
  readonly index: number;
  readonly id?: string;
  readonly subtype: 'link' | 'widget' | 'highlight' | 'underline' | 'squiggly' | 'strikeout';
  /** /Rect before and after, unrotated user space. */
  readonly from: Rect;
  readonly to: Rect;
}

/** What the verification of a written paragraph found (craft spec §4.4). */
export interface ParagraphEditVerification {
  /** The paragraph read back from a fresh text page, and what the layout planned. */
  readonly readback: string;
  readonly expected: string;
  /** Largest distance of a glyph origin from the plan, points (tolerance 0.01). */
  readonly maxDrift: number;
  /** Largest difference of a glyph box from the plan, points (tolerance 0.05). */
  readonly maxBoxError: number;
  /** Pixels that differ outside the paragraph box at scale 2 (must be 0). */
  readonly changedPixelsOutside: number;
  /** Text objects written (reused containers and new objects) and moved. */
  readonly objectsWritten: number;
  readonly objectsMoved: number;
}

export interface ParagraphEditResult {
  /** The edit was written to the source (`commit: true` and the text changed). */
  readonly committed: boolean;
  /** The layout as written. */
  readonly layout: ParagraphLayout;
  /** The overflow policy's verdict on it. */
  readonly decision: OverflowDecision;
  /** 2: every character in the original font; 1: some are set in a bundled substitute. */
  readonly tier: 1 | 2;
  readonly honesty: Extract<
    TextEditHonesty,
    'same-font' | 'same-font-not-embedded' | 'font-substituted'
  >;
  /** Characters set in a substitute (the honesty line), with the face's display family. */
  readonly substitutions: readonly (LayoutSubstitution & { readonly family: string })[];
  /** Links, markup and widgets moved with their words. */
  readonly moved: readonly ParagraphMovedAnnotation[];
  /** Some glyphs are written in new objects in DeviceRGB while the original is not RGB. */
  readonly colorSpaceChanged?: boolean;
  readonly verification: ParagraphEditVerification;
  /** The area the edit may change (old and new paragraph), unrotated user space. */
  readonly box: Rect;
}

/** The dry-run page's paragraph area rendered for the overlay's settled preview. */
export interface ParagraphPreview extends RenderResult {
  /** The rendered area (`ParagraphEditResult.box`), unrotated user space. */
  readonly clip: Rect;
  readonly result: ParagraphEditResult;
}

/** Paragraph editing on an open source (craft spec §8; `PdfTextEditor` extends it). */
export interface PdfParagraphEditor {
  /** The layout input and overflow facts of a detected paragraph (read-only, once per open). */
  analyzeParagraphLayout(
    ref: ParagraphRef,
    options?: EngineCallOptions,
  ): Promise<ParagraphLayoutAnalysis>;
  /**
   * Lays out, writes and verifies a paragraph edit: a dry run on a private copy of the page
   * (`commit: false`), or the edit itself (`commit: true`; record it as `text.editParagraph`).
   * Refusals fail with `[text-edit:not-editable] (paragraph:<ParagraphEditRefusal>)`, a page
   * that changed with `stale-run`, a failed check with `verification-failed`.
   */
  applyParagraphEdit(
    source: SourceId,
    pageIndex: number,
    edit: ParagraphEdit,
    options: ParagraphEditOptions,
  ): Promise<ParagraphEditResult>;
  /** The dry run's paragraph area at `scale` (as `renderPage` with `clip` would draw it). */
  renderParagraphPreview(
    source: SourceId,
    pageIndex: number,
    edit: ParagraphEdit,
    scale: number,
    options?: EngineCallOptions,
  ): Promise<ParagraphPreview>;
}
