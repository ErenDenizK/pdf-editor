/**
 * Virtual document model — the single source of truth for what the user sees.
 *
 * Design rules (ADR-0005):
 * - Immutable data. Every operation returns a new Workspace; snapshots share structure.
 * - No DOM, no engine imports. Bytes are referenced by SourceId, never held here.
 * - Structural edits (order, rotation, crop, overlays, document-level data) live here.
 * - Content edits (annotations, form values, redactions) are executed by an engine and
 *   recorded as EngineEdit commands so that they join the same history.
 */

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/** Branded string ids keep the model honest at compile time. */
export type SourceId = string & { readonly __brand: 'SourceId' };
export type DocumentId = string & { readonly __brand: 'DocumentId' };
export type PageId = string & { readonly __brand: 'PageId' };
export type BlobId = string & { readonly __brand: 'BlobId' };

// ---------------------------------------------------------------------------
// Geometry (PDF user space, points, origin bottom-left)
// ---------------------------------------------------------------------------

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type Rotation = 0 | 90 | 180 | 270;

// ---------------------------------------------------------------------------
// Sources: opened files, immutable
// ---------------------------------------------------------------------------

export interface SourcePageInfo {
  /** Size of the page's CropBox (or MediaBox when absent), unrotated. */
  readonly size: Size;
  /** Intrinsic /Rotate of the source page. */
  readonly rotation: Rotation;
  /** Page label as authored (e.g. "iv", "A-1"); undefined when the document has none. */
  readonly label?: string;
}

export interface SourceDocument {
  readonly id: SourceId;
  readonly name: string;
  readonly byteLength: number;
  readonly pageCount: number;
  readonly pages: readonly SourcePageInfo[];
  /** Fingerprint from the PDF /ID or a hash of the bytes; used for dedupe and caching. */
  readonly fingerprint: string;
  readonly flags: SourceFlags;
}

export interface SourceFlags {
  readonly encrypted: boolean;
  /** The engine had to rebuild the cross-reference table to open the file. */
  readonly repaired: boolean;
  readonly hasAcroForm: boolean;
  readonly hasXfa: boolean;
  readonly hasSignatures: boolean;
  readonly tagged: boolean;
  readonly linearized: boolean;
  /**
   * Encrypted sources: what the author allows (/P as written in the file, whatever password
   * opened it). Absent for unencrypted files or when the engine could not read it.
   */
  readonly permissions?: PermissionFlags;
  /** Encrypted sources: the standard security handler's algorithm (/V, /R, crypt filter). */
  readonly securityHandler?: SecurityHandler;
  /**
   * Encrypted sources: a user password was needed to open the file. `false` means the file
   * opens without a password and only carries owner restrictions ("owner-only").
   */
  readonly passwordProtected?: boolean;
}

/** Encryption algorithm of a source's standard security handler. */
export type SecurityHandler = 'rc4-40' | 'rc4-128' | 'aes-128' | 'aes-256' | 'unknown';

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

export type PageRef =
  | { readonly kind: 'source'; readonly source: SourceId; readonly index: number }
  | { readonly kind: 'blank'; readonly size: Size }
  | { readonly kind: 'image'; readonly blob: BlobId; readonly size: Size };

/**
 * A page of a virtual document.
 *
 * TODO(M3): duplicating a page that carries form widgets needs a per-page policy (clone the
 * fields under new names vs. share values with the original; ADR-0005). No field yet.
 */
export interface VirtualPage {
  readonly id: PageId;
  readonly ref: PageRef;
  /** Rotation applied on top of the source's intrinsic /Rotate. */
  readonly rotation: Rotation;
  /** Optional CropBox override, in unrotated source user space. */
  readonly cropBox?: Rect;
  /**
   * Optional new page size (resize.ts). Applied after the crop: the visible content box
   * (crop box, else the source/blank/image size) is mapped into a page of this size.
   */
  readonly resize?: PageResize;
  /** Declarative overlays materialized at export (page numbers, watermark, header/footer). */
  readonly overlays: readonly OverlayOp[];
}

/**
 * How content meets a new page size:
 * - `scale`: scaled to cover the new page (uniform; the overflow at the anchor's far side is
 *   cut off), or, with `stretch`, scaled per axis to fill it exactly;
 * - `fit`: scaled uniformly to fit inside, leaving margins (letterboxing);
 * - `canvas`: kept at 100%; only the page box grows or shrinks around the anchor.
 */
export type ResizeMode = 'scale' | 'fit' | 'canvas';

/**
 * A page resize, in *unrotated* user space like `cropBox`: `width` × `height` is the new
 * page box, and `anchor` names a side or corner of the unrotated page (`top` is +y). Stored
 * unrotated so that a later rotation turns the resized page as a whole; `resizePages`
 * takes what the user sees (displayed size and anchor) and converts per page.
 */
export interface PageResize {
  readonly width: number;
  readonly height: number;
  readonly mode: ResizeMode;
  readonly anchor: Anchor;
  /** Only with `scale`: scale each axis on its own to fill the page exactly (distorts). */
  readonly stretch?: boolean;
}

// ---------------------------------------------------------------------------
// Overlays (declarative; materialized by the assembler at export)
// ---------------------------------------------------------------------------

export type OverlayLayer = 'behind' | 'over';

/**
 * Pages an overlay is drawn on, by 1-based position in the document (inclusive). Absent
 * fields do not restrict: `{ from: 2 }` skips the cover, `{ parity: 'odd' }` keeps
 * recto pages. An overlay without `pages` is drawn on every page that carries it.
 */
export interface OverlayPageRange {
  readonly from?: number;
  readonly to?: number;
  readonly parity?: 'odd' | 'even';
}

/** What a piece of page furniture is, so the UI can find, edit and replace it. */
export type OverlayRole = 'page-number' | 'header' | 'footer' | 'bates' | 'watermark';

export interface OverlayTile {
  readonly gapX: number;
  readonly gapY: number;
}

export interface TextOverlay {
  readonly kind: 'text';
  readonly layer: OverlayLayer;
  /**
   * Template with tokens: {page}, {pages}, {label}, {title}, {date}, {bates}. {date} takes
   * an optional style: {date:short}, {date:medium} (default), {date:long}, {date:iso}.
   */
  readonly template: string;
  readonly anchor: Anchor;
  readonly offset: { readonly x: number; readonly y: number };
  readonly font: FontSpec;
  readonly color: RgbColor;
  readonly opacity: number;
  readonly rotate?: number;
  readonly tile?: OverlayTile;
  readonly pages?: OverlayPageRange;
  /** Mirror left/right anchors and the horizontal offset on even pages (duplex). */
  readonly mirror?: boolean;
  /**
   * Number shown by {page} on the first page the overlay is drawn on; {pages} becomes the
   * last number shown. Without it, {page} is the 1-based position and {pages} the count.
   */
  readonly startNumber?: number;
  readonly role?: OverlayRole;
}

export interface ImageOverlay {
  readonly kind: 'image';
  readonly layer: OverlayLayer;
  readonly blob: BlobId;
  readonly anchor: Anchor;
  readonly offset: { readonly x: number; readonly y: number };
  readonly scale: number;
  readonly opacity: number;
  readonly rotate?: number;
  readonly tile?: OverlayTile;
  readonly pages?: OverlayPageRange;
  readonly mirror?: boolean;
  readonly role?: OverlayRole;
}

export type OverlayOp = TextOverlay | ImageOverlay;

export type Anchor =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'middle-left'
  | 'center'
  | 'middle-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right';

export interface FontSpec {
  /** Family key resolved by the assembler to an embedded font (bundled, subset). */
  readonly family: string;
  readonly size: number;
  readonly weight?: 400 | 700;
  readonly italic?: boolean;
}

export interface RgbColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

// ---------------------------------------------------------------------------
// Document-level data
// ---------------------------------------------------------------------------

export type Destination =
  | { readonly kind: 'page'; readonly page: PageId; readonly view?: DestinationView }
  | { readonly kind: 'uri'; readonly uri: string }
  | {
      readonly kind: 'unresolved';
      readonly reason: string;
      /**
       * Last page target before the destination became unresolved (its page left the
       * document). When that page returns (moved back, or merged with the document it went
       * to), the outline helpers restore the destination instead of losing it.
       */
      readonly previous?: { readonly page: PageId; readonly view?: DestinationView };
    };

export interface DestinationView {
  readonly fit: 'xyz' | 'fit' | 'fit-h' | 'fit-v' | 'fit-r';
  readonly left?: number;
  readonly top?: number;
  readonly zoom?: number;
  readonly rect?: Rect;
}

export interface OutlineNode {
  readonly title: string;
  readonly destination?: Destination;
  readonly open: boolean;
  readonly children: readonly OutlineNode[];
  /** Where this node came from; kept so reconciliation can report what was dropped. */
  readonly origin?: { readonly source: SourceId };
}

export type PageLabelStyle =
  | 'decimal'
  | 'roman-upper'
  | 'roman-lower'
  | 'alpha-upper'
  | 'alpha-lower'
  | 'none';

export interface PageLabelRange {
  /** Index of the first page (in VirtualDocument.pages) this range applies to. */
  readonly startIndex: number;
  readonly style: PageLabelStyle;
  readonly prefix?: string;
  readonly firstNumber?: number;
}

export interface DocumentMetadata {
  readonly title?: string;
  readonly author?: string;
  readonly subject?: string;
  readonly keywords?: string;
  readonly creator?: string;
  readonly producer?: string;
  readonly creationDate?: string;
  readonly modificationDate?: string;
  readonly language?: string;
  /**
   * Custom document information keys (ISO 32000-2 §14.3.3), name without the slash → text.
   * Written to the Info dictionary and mirrored in XMP under the `pdfx:` namespace.
   */
  readonly custom?: Readonly<Record<string, string>>;
  /** Policy for export: keep first source's Info/XMP, or write only what is above. */
  readonly policy: 'inherit-first-source' | 'explicit';
  /** "Strip metadata": what the assembler removes at export. Absent: nothing is stripped. */
  readonly strip?: MetadataStrip;
}

/**
 * What "Strip metadata" removes at export. Outlines and page labels always stay. With
 * `info`, the output's Info dictionary carries only /Producer (plus fields typed after
 * stripping) and no dates; the file identifier (/ID) is always regenerated.
 */
export interface MetadataStrip {
  /** Standard Info keys (Title, Author, Subject, Keywords, Creator, dates). */
  readonly info: boolean;
  /** XMP packets: the document's, and those on pages and images. */
  readonly xmp: boolean;
  /** Embedded files (/EmbeddedFiles, /AF) and file attachment annotations. */
  readonly attachments: boolean;
  /**
   * Scripts and external actions: /JavaScript, /Launch, /SubmitForm, /ImportData and
   * scripted /Rendition actions (also as /OpenAction or /Next), and additional actions (/AA).
   */
  readonly javascript: boolean;
  /** Private application data (/PieceInfo) on pages and forms. */
  readonly pieceInfo: boolean;
  /** Embedded page thumbnails (/Thumb). */
  readonly thumbnails: boolean;
  /** Author (/T) and dates (/M, /CreationDate) on annotations. */
  readonly annotationAuthors: boolean;
  /** Custom Info keys. */
  readonly customKeys: boolean;
}

export interface PermissionFlags {
  readonly print: boolean;
  readonly printHighQuality: boolean;
  readonly modify: boolean;
  readonly copy: boolean;
  readonly annotate: boolean;
  readonly fillForms: boolean;
  readonly accessibility: boolean;
  readonly assemble: boolean;
}

export interface SecurityPolicy {
  readonly algorithm: 'aes-256';
  readonly userPassword?: string;
  readonly ownerPassword?: string;
  readonly permissions: PermissionFlags;
}

/** How to reconcile form fields whose fully-qualified names collide at export. */
export type FormMergePolicy = 'namespace-by-source' | 'rename-collisions' | 'unify-same-name';

/**
 * Bates numbering of a document: the {bates} token on the page at index i reads
 * `prefix + pad(s + i, width) + suffix`, where `s` is the document's effective start
 * (`effectiveBates`). Without a run, `s = start`. In a run, every member document carries
 * the same config, `start` is the number of the run's first page, and `s` continues after
 * the current pages of the run members before this document, so numbers stay unique and
 * contiguous when pages are inserted or removed.
 */
export interface BatesConfig {
  readonly prefix: string;
  /** Minimum number of digits (zero padded). */
  readonly width: number;
  readonly start: number;
  readonly suffix: string;
  readonly run?: BatesRun;
}

/** One continuous Bates counter across documents, in this order. */
export interface BatesRun {
  readonly id: string;
  readonly documents: readonly DocumentId[];
}

export interface VirtualDocument {
  readonly id: DocumentId;
  readonly title: string;
  readonly pages: readonly VirtualPage[];
  /** Destinations of kind 'page' always target pages of this document. */
  readonly outline: readonly OutlineNode[];
  /**
   * Explicit page-label ranges, sorted by strictly increasing startIndex. Each range covers
   * the pages from its startIndex up to the next range. Pages not covered by any range
   * (before the first one, or all pages when empty) fall back to the source page's
   * authored label, then to the 1-based position. See labels.ts.
   */
  readonly labels: readonly PageLabelRange[];
  readonly metadata: DocumentMetadata;
  readonly security?: SecurityPolicy;
  /**
   * Set by "Remove password": the user chose an unprotected output although sources were
   * encrypted (the export summary reports it as requested rather than as a warning).
   * Cleared when a password is set again.
   */
  readonly passwordRemoved?: boolean;
  readonly formMergePolicy: FormMergePolicy;
  /** Bates numbering for the {bates} overlay token; absent when none was applied. */
  readonly bates?: BatesConfig;
  /**
   * Document-level furniture (page numbers, headers and footers, Bates stamps, watermarks):
   * overlays drawn on every page of the document, subject to each overlay's own page
   * range, before the page's own overlays. Pages added later inherit them.
   */
  readonly furniture?: readonly OverlayOp[];
  /**
   * Form fields created in this app (fields.ts), in tab order. They reference pages of this
   * document and become AcroForm fields at export; source fields stay in their sources.
   */
  readonly fields?: readonly CreatedField[];
  /** Set when the user has not changed the document since it was opened or exported. */
  readonly clean: boolean;
}

// ---------------------------------------------------------------------------
// Created form fields (document-level, materialized by the assembler at export)
// ---------------------------------------------------------------------------

export type FieldId = string & { readonly __brand: 'FieldId' };

/**
 * What a created field is: a text field (single or multi-line, optionally comb), a check
 * box, a radio group (several widgets, one field), a dropdown (combo box), a list box, an
 * unsigned signature field (a placeholder: this app does not sign) or a push button (label
 * only; no actions).
 */
export type CreatedFieldKind =
  | 'text'
  | 'checkbox'
  | 'radio'
  | 'dropdown'
  | 'listbox'
  | 'signature'
  | 'button';

/** The small palette of field border and background colours (see FIELD_COLORS). */
export type FieldColor =
  | 'none'
  | 'black'
  | 'gray'
  | 'blue'
  | 'red'
  | 'white'
  | 'light-gray'
  | 'light-blue'
  | 'light-yellow';

export type FieldAlign = 'left' | 'center' | 'right';

/**
 * Value of a created field: text and dropdown → string; checkbox → boolean; radio → the
 * export value of the button that is on; list box → string, or every selected option when
 * `multiSelect`.
 */
export type CreatedFieldValue = string | boolean | readonly string[];

/** One on-page appearance of a created field. */
export interface CreatedFieldWidget {
  readonly page: PageId;
  /** Widget rectangle in unrotated user space of the page's content (like annotations). */
  readonly rect: Rect;
  /** Radio buttons: the value the group takes when this button is on (unique in the group). */
  readonly exportValue?: string;
}

export interface CreatedField {
  readonly id: FieldId;
  readonly kind: CreatedFieldKind;
  /** Partial = fully-qualified name (no periods), unique among the document's created fields. */
  readonly name: string;
  /** Exactly one widget, except radio groups (one or more). */
  readonly widgets: readonly CreatedFieldWidget[];
  /** Alternate name (/TU), shown by viewers as a tooltip. */
  readonly tooltip?: string;
  /** Font size in points, or 'auto' (viewers fit the text to the widget). */
  readonly fontSize: number | 'auto';
  readonly border: FieldColor;
  readonly background: FieldColor;
  readonly required: boolean;
  readonly readOnly: boolean;
  /** Text alignment (/Q) of text, dropdown and list box fields. */
  readonly align: FieldAlign;
  /** Text: several lines. */
  readonly multiline?: boolean;
  /** Text: characters spread over `maxLength` equal cells (needs `maxLength`, single line). */
  readonly comb?: boolean;
  /** Text: /MaxLen. */
  readonly maxLength?: number;
  /** Dropdown and list box: the options (display text = export value), non-empty. */
  readonly options?: readonly string[];
  /** List box: several options may be selected. */
  readonly multiSelect?: boolean;
  /** Dropdown: free text allowed besides the options. */
  readonly editable?: boolean;
  /** Push button: its caption. */
  readonly label?: string;
  /** Value a form reset restores (/DV). */
  readonly defaultValue?: CreatedFieldValue;
  /** Current value (/V); filled in the app like source fields. */
  readonly value?: CreatedFieldValue;
}

// ---------------------------------------------------------------------------
// Engine-side edits (content), recorded for history and replay
// ---------------------------------------------------------------------------

/**
 * A content edit executed by an engine on a source document. The payload is engine
 * neutral JSON; the engine adapter interprets it. `inverse` allows undo without a
 * snapshot of the bytes.
 */
export interface EngineEdit {
  readonly id: string;
  readonly source: SourceId;
  readonly pageIndex: number;
  readonly kind:
    | 'annotation.create'
    | 'annotation.update'
    | 'annotation.delete'
    | 'form.set-value'
    | 'redaction.mark'
    | 'redaction.apply'
    // In-place text edit (spec redaction-and-text-editing §2.5). Not invertible: its
    // inverse is a `text.edit` marked "replay required" (undo = reopen + replay).
    | 'text.edit'
    // Paragraph edit (spec craft §4.4, ADR-0020): one paragraph rewrapped and rewritten,
    // its layout recorded. Not invertible either: undo is reopen + replay.
    | 'text.editParagraph'
    // Image objects (M4 §3): a transform's inverse restores the previous matrix; remove
    // and replace are not invertible (their inverse is marked "replay required").
    | 'image.transform'
    | 'image.remove'
    | 'image.replace'
    | 'ocr.apply';
  readonly payload: unknown;
  readonly inverse?: EngineEdit;
}

// ---------------------------------------------------------------------------
// Workspace and history
// ---------------------------------------------------------------------------

export interface Workspace {
  readonly sources: Readonly<Record<SourceId, SourceDocument>>;
  readonly documents: Readonly<Record<DocumentId, VirtualDocument>>;
  /** Tab order. */
  readonly documentOrder: readonly DocumentId[];
  readonly activeDocument?: DocumentId;
  readonly engineEdits: readonly EngineEdit[];
}

export interface HistoryEntry {
  readonly label: string;
  readonly at: number;
  readonly workspace: Workspace;
  /** Entries with the same coalesceKey within a short window are merged (drags, sliders). */
  readonly coalesceKey?: string;
}

export interface History {
  readonly past: readonly HistoryEntry[];
  readonly present: HistoryEntry;
  readonly future: readonly HistoryEntry[];
}
