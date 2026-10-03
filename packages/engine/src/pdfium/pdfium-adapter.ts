/**
 * PdfiumAdapter: PdfRenderer + PdfEditor + PdfVerifier on top of EmbedPDF's PDFium build
 * (`@embedpdf/engines` 2.x, worker mode). See docs/ARCHITECTURE.md §2 and ADR-0002.
 *
 * - The EmbedPDF engine is created lazily on the first call. By default it runs PDFium in a
 *   Web Worker that EmbedPDF spawns from a blob: URL (CSP needs `worker-src blob:`).
 * - Font fallback is disabled unless the caller passes a self-hosted `FontFallbackConfig`:
 *   EmbedPDF's default fetches fonts from cdn.jsdelivr.net, which this project never does.
 * - All geometry crossing this class is PDF user space (see coords.ts for EmbedPDF's space).
 */

import type {
  CreatePdfiumEngineOptions,
  FontFallbackConfig,
} from '@embedpdf/engines/pdfium-worker-engine';
import {
  type FormFieldValue,
  isWidgetChecked,
  type Logger,
  MatchFlag,
  PdfActionType,
  PDF_FORM_FIELD_FLAG,
  PDF_FORM_FIELD_TYPE,
  type PdfAnnotationObject,
  PdfAnnotationSubtype,
  type PdfBookmarkObject,
  type PdfDestinationObject,
  type PdfDocumentObject,
  type PdfEngine,
  type PdfErrorReason,
  type PdfLinkTarget,
  type PdfMetadataObject,
  type PdfPageObject,
  type PdfPageSearchProgress,
  type PdfRenderPageOptions,
  type PdfWidgetAnnoObject,
  PdfZoomMode,
  type SearchResult,
  type Task,
} from '@embedpdf/models';
import type {
  DestinationView,
  DocumentMetadata,
  Rect,
  SourceFlags,
  SourceId,
} from '@pdf-editor/document-model';

import { checkAnnotationConformance, describeProblems } from '../annotations/conformance';
import { finalizeAnnotations } from '../annotations/finalize';
import {
  INK_WIDTHS_KEY,
  inkAppearance,
  parseInkWidths,
  storedInkWidths,
} from '../annotations/ink-appearance';
import { namedStampAppearance } from '../annotations/stamp-appearance';
import {
  type Annotation,
  type AnnotationFinalizeRequest,
  type CreatedFieldExpectation,
  EngineError,
  type EngineCallOptions,
  type EngineOutlineNode,
  type FormField,
  type FormFieldKind,
  type FormFieldSignature,
  type FormFieldWidget,
  type Glyph,
  type InkAnnotation,
  type NewAnnotation,
  type OcrWordsExpectation,
  type OpenedDocument,
  type OpenOptions,
  type PdfEditor,
  type PdfRenderer,
  type PdfVerifier,
  type NoteStateFact,
  type OutlineItemFacts,
  type RenderOptions,
  type RenderResult,
  type SaveOptions,
  type SearchHit,
  type SearchOptions,
  type SourceInspection,
  type SourceInspector,
  type TextRun,
  type VerificationExpectation,
  type VerificationResult,
} from '../types';
import { loadForSignatures, readSignatureFields } from '../signatures/fields';
import { checkXrefStructure } from '../structure/xref-check';
import { permissionsFromP } from '../pdflib/inspect';
import { type ClearFieldsRequest, clearFields, finalizeForms } from './form-finalize';
import {
  effectiveRect,
  followRect,
  fromEmbedPdf,
  isWinAnsi,
  roundOpacity,
  STAMP_NAMES,
  sniffStampData,
  toEmbedPdf,
} from './annotation-mapping';
import {
  annotationRectToUser,
  deviceToUserRect,
  type PageGeometry,
  pageGeometry,
  rotationDegrees,
  unionRect,
  unrotatedSize,
  userToDeviceRect,
} from './coords';
import {
  annotationStringsOnPage,
  appendInkPath as appendRawInkPath,
  clearAnnotationString,
  pdfDate,
  setAnnotationAppearance,
} from './host/annot-appearance';
import type { RawAccess, RawAccessOptions } from './host/hosted-engine';
import { type ErrorContext, runTask, throwIfAborted } from './task-bridge';
import { edgeDeviation, locateWords, OCR_RECT_TOLERANCE } from '../ocr/verify';
import type { PageChar } from '../redaction/engine-session';

export type { FontFallbackConfig };

/**
 * One raw PDFium task on an open source from inside an adapter call: the
 * `HostedEngine.withRawTask` of the host the engine runs on (ADR-0011).
 */
export type RawTaskRunner = <R>(
  sourceId: string,
  fn: (raw: RawAccess) => R | Promise<R>,
  options?: RawAccessOptions,
) => Promise<R>;

/**
 * Whether an update of an ink with widths lets EmbedPDF regenerate its constant-width
 * appearance before ours replaces it. Off (ADR-0018 §2, measured by P4): EmbedPDF writes the
 * data only, so there is no constant-width intermediate and one replaced stream per update
 * instead of two.
 */
const INK_UPDATE_REGENERATES = false;

export type PdfiumEngineFactory = (
  wasmUrl: string,
  options: CreatePdfiumEngineOptions,
) => PdfEngine | Promise<PdfEngine>;

/**
 * EmbedPDF's own worker engine, imported only when no `engineFactory` is given, so bundles
 * that pass one (our PDFium worker, ADR-0011) leave out its blob worker and CDN font table.
 */
const defaultEngineFactory: PdfiumEngineFactory = async (wasmUrl, options) =>
  (await import('@embedpdf/engines/pdfium-worker-engine')).createPdfiumEngine(wasmUrl, options);

export interface PdfiumAdapterOptions {
  /**
   * URL of `pdfium.wasm`, injected by the app (e.g. Vite `?url` import of
   * `@embedpdf/pdfium/pdfium.wasm`). Relative URLs are resolved against `location`, because
   * EmbedPDF's worker runs from a blob: URL where relative URLs do not resolve.
   */
  readonly wasmUrl: string;
  /**
   * Fallback fonts for text whose font is not embedded. `null`/omitted disables fallback (no
   * network requests). Pass a config pointing at self-hosted fonts to enable it. With the
   * default worker engine the config is posted to the worker, so it must be cloneable:
   * URL entries plus `baseUrl` work, a `fontLoader` function does not.
   */
  readonly fontFallback?: FontFallbackConfig | null;
  readonly logger?: Logger;
  /** Override how the EmbedPDF engine is created (e.g. the direct, same-thread engine). */
  readonly engineFactory?: PdfiumEngineFactory;
  /**
   * Reads page labels and /Lang, which EmbedPDF does not expose (e.g. the assembly worker's
   * `AssemblerProxy`, or a `PdfLibAssembler` in tests). Without one, `OpenedDocument` pages
   * carry no labels and label expectations cannot be verified.
   */
  readonly inspector?: SourceInspector;
  /**
   * Raw access from inside adapter calls (`HostedEngine.withRawTask` of the host that runs
   * `engineFactory`'s engine), for what EmbedPDF cannot write or read: variable-width ink
   * (ADR-0018), whose appearance and `/PdfEditorInkWidths` the adapter writes after
   * EmbedPDF's create or update and reads back on listing. Without it, ink `widths` are
   * neither written nor read and every ink is drawn at its nominal width.
   */
  readonly rawTask?: RawTaskRunner;
}

/**
 * Annotation facts EmbedPDF cannot hold, kept per open source until `save()` writes them
 * (annotations/finalize.ts). Keyed by /NM.
 */
interface AnnotationState {
  /** Set by any annotation create/update/delete since open. */
  dirty: boolean;
  /** Created or updated since open: `save()` adds /P, /M, /F Print and popups. */
  readonly touched: Set<string>;
  /** Note popup open state. */
  readonly noteOpen: Map<string, boolean>;
  /** Stamp opacity (EmbedPDF writes no /CA for stamps). */
  readonly opacity: Map<string, number>;
  /** Note states read by the inspector, not yet matched to an /NM (by /Annots index). */
  pendingNotes: NoteStateFact[];
}

interface OpenEntry {
  readonly doc: PdfDocumentObject;
  readonly password?: string;
  readonly annotations: AnnotationState;
}

function newAnnotationState(notes: readonly NoteStateFact[] = []): AnnotationState {
  const state: AnnotationState = {
    dirty: false,
    touched: new Set(),
    noteOpen: new Map(),
    opacity: new Map(),
    pendingNotes: [],
  };
  for (const note of notes) {
    if (note.nm !== undefined) state.noteOpen.set(note.nm, note.open);
    else state.pendingNotes.push(note);
  }
  return state;
}

const LOG_SOURCE = 'PdfiumAdapter';

/** Files up to this size are always inspected (custom Info keys have no byte token). */
const ALWAYS_INSPECT_BYTES = 32 * 1024 * 1024;

const EMPTY_FLAGS: SourceFlags = {
  encrypted: false,
  repaired: false,
  hasAcroForm: false,
  hasXfa: false,
  hasSignatures: false,
  tagged: false,
  linearized: false,
};

/** Max pages scanned for widgets when the byte heuristic cannot decide (object streams). */
const WIDGET_SCAN_PAGE_LIMIT = 100;

export class PdfiumAdapter implements PdfRenderer, PdfEditor, PdfVerifier {
  private readonly wasmUrl: string;
  private readonly fontFallback: FontFallbackConfig | null;
  private readonly logger: Logger | undefined;
  private readonly engineFactory: PdfiumEngineFactory;
  private readonly inspector: SourceInspector | undefined;
  private readonly rawTask: RawTaskRunner | undefined;
  private enginePromise: Promise<PdfEngine> | undefined;
  private readonly docs = new Map<SourceId, OpenEntry>();
  /** Sources whose form values were set since open (save regenerates appearances). */
  private readonly formsEdited = new Set<SourceId>();
  /** Signature facts by field name, per open document (listFormFields' /V pairing). */
  private readonly signatureFactsCache = new WeakMap<
    OpenEntry,
    Promise<ReadonlyMap<string, FormFieldSignature> | undefined>
  >();
  private scratchCounter = 0;

  constructor(options: PdfiumAdapterOptions) {
    this.wasmUrl = options.wasmUrl;
    this.fontFallback = options.fontFallback ?? null;
    this.logger = options.logger;
    this.engineFactory = options.engineFactory ?? defaultEngineFactory;
    this.inspector = options.inspector;
    this.rawTask = options.rawTask;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  private engine(): Promise<PdfEngine> {
    if (!this.enginePromise) {
      const base = (globalThis as { location?: { href: string } }).location?.href;
      const url = base === undefined ? this.wasmUrl : new URL(this.wasmUrl, base).href;
      const options: CreatePdfiumEngineOptions = { fontFallback: this.fontFallback };
      if (this.logger) options.logger = this.logger;
      this.enginePromise = Promise.resolve(this.engineFactory(url, options));
      this.enginePromise.catch(() => {
        this.enginePromise = undefined;
      });
    }
    return this.enginePromise;
  }

  /** Closes every document and terminates the PDFium worker. */
  async destroy(): Promise<void> {
    const pending = this.enginePromise;
    this.enginePromise = undefined;
    this.docs.clear();
    this.formsEdited.clear();
    if (pending) {
      const engine = await pending;
      await engine.destroy?.().toPromise();
    }
  }

  private run<R>(
    task: Task<R, PdfErrorReason>,
    options: EngineCallOptions | undefined,
    ctx: ErrorContext | string,
  ): Promise<R> {
    return runTask(task, options?.signal, typeof ctx === 'string' ? { op: ctx } : ctx);
  }

  private entry(id: SourceId): OpenEntry {
    const entry = this.docs.get(id);
    if (!entry) {
      throw new EngineError('internal', `Source ${id} is not open`);
    }
    return entry;
  }

  private page(id: SourceId, pageIndex: number): { doc: PdfDocumentObject; page: PdfPageObject } {
    const { doc } = this.entry(id);
    const page = doc.pages[pageIndex];
    if (!page) {
      throw new EngineError('internal', `Page ${pageIndex} out of range for ${id}`);
    }
    return { doc, page };
  }

  // -------------------------------------------------------------------------
  // PdfRenderer
  // -------------------------------------------------------------------------

  async open(id: SourceId, bytes: ArrayBuffer, options: OpenOptions = {}): Promise<OpenedDocument> {
    throwIfAborted(options.signal, 'open');
    const u8 = new Uint8Array(bytes);
    const heuristics = scanBytes(u8);
    // Neither PDFium nor pdf-lib reports repairs; check the xref chain ourselves.
    const structure = checkXrefStructure(u8);
    // Inspect a copy in parallel with PDFium: EmbedPDF posts (detaches) the original.
    const inspection = this.inspect(bytes, heuristics, options);
    // Hash first: EmbedPDF posts the buffer to its worker.
    const fingerprint = await sha256Hex(bytes);
    const engine = await this.engine();
    if (this.docs.has(id)) {
      await this.close(id);
    }
    const doc = await this.run(
      engine.openDocumentBuffer(
        { id, content: bytes },
        options.password === undefined ? {} : { password: options.password },
      ),
      options,
      { op: 'open', passwordProvided: (options.password ?? '') !== '' },
    );
    this.docs.set(
      id,
      options.password === undefined
        ? { doc, annotations: newAnnotationState() }
        : { doc, password: options.password, annotations: newAnnotationState() },
    );
    try {
      const [metadata, bookmarks, signatures, inspected] = await Promise.all([
        this.run(engine.getMetadata(doc), options, 'getMetadata'),
        this.run(engine.getBookmarks(doc), options, 'getBookmarks'),
        this.run(engine.getSignatures(doc), options, 'getSignatures'),
        inspection,
      ]);
      const hasSignatures = signatures.length > 0;
      let hasAcroForm = heuristics.acroFormToken || hasSignatures;
      if (!hasAcroForm && heuristics.objectStreams) {
        // /AcroForm may hide in a compressed object stream: ask PDFium about widgets.
        hasAcroForm = await this.hasWidgets(engine, doc, options);
      }
      const flags: SourceFlags = {
        ...EMPTY_FLAGS,
        encrypted: doc.isEncrypted,
        hasSignatures,
        hasAcroForm,
        repaired: structure.repaired,
        // Byte-level heuristics: reliable when the catalog is not in an object stream.
        // TODO(M2): read these from the catalog (EmbedPDF 2.15 exposes neither).
        hasXfa: heuristics.xfaToken,
        tagged: heuristics.structTreeToken,
        linearized: heuristics.linearized,
      };
      // Labels come from the inspector (pdf-lib): EmbedPDF 2.15 has no page-label API.
      const labels =
        inspected.pageLabels?.length === doc.pageCount ? inspected.pageLabels : undefined;
      const mapped = mapMetadata(metadata);
      if (inspected.noteStates) {
        const entry = this.docs.get(id);
        if (entry) {
          this.docs.set(id, { ...entry, annotations: newAnnotationState(inspected.noteStates) });
        }
      }
      return {
        id,
        pageCount: doc.pageCount,
        pages: doc.pages.map((p, index) => {
          const label = labels?.[index];
          const crop = p.boxes?.crop;
          return {
            size: unrotatedSize(p),
            rotation: rotationDegrees(p),
            ...(label === undefined ? {} : { label }),
            ...(crop
              ? {
                  cropBox: {
                    x: crop.left,
                    y: crop.bottom,
                    width: crop.right - crop.left,
                    height: crop.top - crop.bottom,
                  },
                }
              : {}),
          };
        }),
        fingerprint,
        flags: doc.isEncrypted
          ? { ...flags, ...(await this.securityFlags(engine, doc, inspected, options)) }
          : flags,
        metadata: {
          ...mapped,
          ...(inspected.language === undefined ? {} : { language: inspected.language }),
          ...(inspected.customInfo && Object.keys(inspected.customInfo).length > 0
            ? { custom: { ...inspected.customInfo } }
            : {}),
        },
        outline: mapOutline(bookmarks.bookmarks, inspected.outline),
      };
    } catch (error) {
      await this.close(id).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Security facts of an encrypted document: the authored permissions (PDFium's
   * FPDF_GetDocUserPermissions, which reports /P even when the owner password unlocked
   * everything; else the inspector's /P), the handler from the inspector's /Encrypt facts,
   * and whether a user password was needed (a file that opens without one is owner-only).
   */
  private async securityFlags(
    engine: PdfEngine,
    doc: PdfDocumentObject,
    inspected: SourceInspection,
    options: OpenOptions,
  ): Promise<Pick<SourceFlags, 'permissions' | 'securityHandler' | 'passwordProtected'>> {
    const revision = inspected.encryption?.r ?? 3;
    let permissions = inspected.encryption?.permissions;
    try {
      const p = await this.run(engine.getDocUserPermissions(doc), options, 'permissions');
      if (typeof p === 'number') permissions = permissionsFromP(p | 0, revision);
    } catch {
      // Keep the inspector's reading.
    }
    return {
      ...(permissions ? { permissions } : {}),
      securityHandler: inspected.encryption?.handler ?? 'unknown',
      passwordProtected: (options.password ?? '') !== '',
    };
  }

  /**
   * Runs the inspector on a copy of `bytes` when the file may carry what it reads (page
   * labels, /Lang; both can hide in compressed object streams; custom Info keys and the
   * /Encrypt facts, read for files up to ALWAYS_INSPECT_BYTES and every encrypted file).
   * Inspection problems never fail an open: they only cost those facts.
   */
  private inspect(
    bytes: ArrayBuffer,
    heuristics: ByteHeuristics,
    options: OpenOptions,
  ): Promise<SourceInspection> {
    const inspector = this.inspector;
    if (
      !inspector ||
      !(
        heuristics.pageLabelsToken ||
        heuristics.langToken ||
        heuristics.outlinesToken ||
        heuristics.popupToken ||
        heuristics.objectStreams ||
        bytes.byteLength <= ALWAYS_INSPECT_BYTES ||
        indexOfAscii(new Uint8Array(bytes), '/Encrypt') !== -1
      )
    ) {
      return Promise.resolve({});
    }
    const copy = bytes.slice(0);
    return inspector
      .inspect(copy, {
        ...(options.password === undefined ? {} : { password: options.password }),
        ...(options.signal ? { signal: options.signal } : {}),
      })
      .catch((error: unknown) => {
        this.logger?.warn(LOG_SOURCE, 'Inspect', 'source inspection failed', error);
        return {};
      });
  }

  private async hasWidgets(
    engine: PdfEngine,
    doc: PdfDocumentObject,
    options: EngineCallOptions,
  ): Promise<boolean> {
    for (const page of doc.pages.slice(0, WIDGET_SCAN_PAGE_LIMIT)) {
      const widgets = await this.run(engine.getPageAnnoWidgets(doc, page), options, 'widgets');
      if (widgets.length > 0) return true;
    }
    return false;
  }

  async close(id: SourceId): Promise<void> {
    const entry = this.docs.get(id);
    if (!entry) return;
    this.docs.delete(id);
    this.formsEdited.delete(id);
    const engine = await this.engine();
    await this.run(engine.closeDocument(entry.doc), undefined, 'close');
  }

  /**
   * Renders a page (or `clip`, in user space) to an ImageBitmap. The bitmap is created fresh
   * for the caller and not retained; when this adapter sits behind Comlink, the caller's
   * wrapper should transfer it (`Comlink.transfer(result, [result.bitmap])`).
   * Defaults: annotations on, form fields drawn with them (PDFium leaves widgets out of the
   * annotation pass once a form environment exists, so they need `FPDF_FFLDraw`), white
   * background.
   */
  async renderPage(id: SourceId, pageIndex: number, options: RenderOptions): Promise<RenderResult> {
    const engine = await this.engine();
    const { doc, page } = this.page(id, pageIndex);
    const renderOptions: PdfRenderPageOptions = {
      scaleFactor: options.scale,
      rotation: ((options.rotation ?? 0) / 90) & 3,
      withAnnotations: options.withAnnotations ?? true,
      withForms: options.withForms ?? options.withAnnotations ?? true,
      transparentBackground: options.background === 'transparent',
    };
    const raw = options.clip
      ? await this.run(
          engine.renderPageRectRaw(
            doc,
            page,
            userToDeviceRect(pageGeometry(page), options.clip),
            renderOptions,
          ),
          options,
          'renderPage',
        )
      : await this.run(engine.renderPageRaw(doc, page, renderOptions), options, 'renderPage');
    throwIfAborted(options.signal, 'renderPage');
    const bitmap = await createImageBitmap(new ImageData(raw.data, raw.width, raw.height));
    return { bitmap, width: raw.width, height: raw.height };
  }

  /**
   * Text of a page as line runs. Glyph boxes come from PDFium's char boxes. Characters are
   * grouped into a line while PDFium emits no line break between them and they either
   * belong to the same text object or stay on the same baseline band. The band test runs in
   * display space (after /Rotate) across the line's direction of flow, which is not always
   * horizontal there: text drawn horizontally in user space runs top to bottom on a
   * /Rotate 90 page, and a rotated text matrix can do the same on any page (see
   * {@link LineBand}). Output rects are user space.
   */
  async getPageText(
    id: SourceId,
    pageIndex: number,
    options: EngineCallOptions = {},
  ): Promise<readonly TextRun[]> {
    const engine = await this.engine();
    const { doc, page } = this.page(id, pageIndex);
    const [glyphs, runs] = await Promise.all([
      this.run(engine.getPageGlyphs(doc, page), options, 'getPageText'),
      this.run(engine.getPageTextRuns(doc, page), options, 'getPageText'),
    ]);
    const count = glyphs.length;
    if (count === 0) return [];
    const chars = await this.run(
      engine.getTextSlices(
        doc,
        Array.from({ length: count }, (_, charIndex) => ({ pageIndex, charIndex, charCount: 1 })),
      ),
      options,
      'getPageText',
    );
    const fontSizes = new Float32Array(count);
    const fontNames = new Array<string | undefined>(count);
    const runIds = new Int32Array(count).fill(-1);
    runs.runs.forEach((run, runId) => {
      for (let i = run.charIndex; i < run.charIndex + run.charCount && i < count; i++) {
        fontSizes[i] = run.fontSize;
        fontNames[i] = run.font.name;
        runIds[i] = runId;
      }
    });
    const g = pageGeometry(page);
    const lines: { text: string; glyphs: Glyph[] }[] = [];
    let current: { text: string; glyphs: Glyph[]; band: LineBand; runId: number } | undefined;
    const flush = (): void => {
      if (current && current.text.trim() !== '') {
        lines.push({ text: current.text.trimEnd(), glyphs: current.glyphs });
      }
      current = undefined;
    };
    for (let i = 0; i < count; i++) {
      const text = chars[i] ?? '';
      if (text === '\r' || text === '\n' || text === '\r\n') {
        flush();
        continue;
      }
      const box = glyphs[i];
      if (!box || box.isEmpty) {
        // Generated or invisible char (e.g. a synthesized space): keep the text only.
        if (current) current.text += text;
        continue;
      }
      const runId = runIds[i] ?? -1;
      if (current && runId !== current.runId && !current.band.holds(box)) {
        flush();
      }
      const fontName = fontNames[i];
      const glyph: Glyph = {
        text,
        rect: deviceToUserRect(g, { origin: box.origin, size: box.size }),
        fontSize: fontSizes[i] ?? 0,
        ...(fontName === undefined ? {} : { fontName }),
      };
      if (!current) {
        current = { text: '', glyphs: [], band: new LineBand(box), runId };
      } else {
        current.band.add(box);
        current.runId = runId;
      }
      current.text += text;
      current.glyphs.push(glyph);
    }
    flush();
    return lines
      .filter((line) => line.glyphs.length > 0)
      .map((line) => ({
        text: line.text,
        glyphs: line.glyphs,
        rect: unionRect(line.glyphs.map((gl) => gl.rect)) as Rect,
      }));
  }

  async search(
    id: SourceId,
    query: string,
    options: SearchOptions = {},
  ): Promise<readonly SearchHit[]> {
    const engine = await this.engine();
    const { doc } = this.entry(id);
    const flags: MatchFlag[] = [];
    if (options.matchCase) flags.push(MatchFlag.MatchCase);
    if (options.wholeWord) flags.push(MatchFlag.MatchWholeWord);
    const toHits = (results: readonly SearchResult[]): SearchHit[] =>
      results.map((hit) => {
        const page = doc.pages[hit.pageIndex];
        const g = page ? pageGeometry(page) : undefined;
        return {
          pageIndex: hit.pageIndex,
          rects: g ? hit.rects.map((r) => deviceToUserRect(g, r)) : [],
          context: `${hit.context.before}${hit.context.match}${hit.context.after}`,
          matchStart: hit.context.before.length,
          matchLength: hit.context.match.length,
        };
      });
    const task = engine.searchAllPages(doc, query, { flags });
    const onProgress = options.onProgress;
    if (onProgress) {
      // EmbedPDF reports each page as it finishes; a throwing listener must not break the
      // search.
      task.onProgress((progress: PdfPageSearchProgress) => {
        try {
          onProgress(toHits(progress.results), progress.page);
        } catch (error) {
          this.logger?.warn(LOG_SOURCE, 'Search', 'search progress listener failed', error);
        }
      });
    }
    const result = await this.run(task, options, 'search');
    return toHits(result.results);
  }

  // -------------------------------------------------------------------------
  // PdfEditor: annotations
  // -------------------------------------------------------------------------

  private async rawAnnotations(
    id: SourceId,
    pageIndex: number,
    options: EngineCallOptions | undefined,
  ): Promise<PdfAnnotationObject[]> {
    const engine = await this.engine();
    const { doc, page } = this.page(id, pageIndex);
    const raw = await this.run(engine.getPageAnnotations(doc, page), options, 'listAnnotations');
    this.resolvePendingNotes(id, pageIndex, raw);
    return raw;
  }

  /**
   * Note open states the inspector found by /Annots position (notes without /NM): the first
   * listing of the page names them (EmbedPDF assigns an /NM on read). Creating appends and
   * every other edit lists the page first, so positions are still those of the file.
   */
  private resolvePendingNotes(id: SourceId, pageIndex: number, raw: PdfAnnotationObject[]): void {
    const state = this.entry(id).annotations;
    if (!state.pendingNotes.some((n) => n.pageIndex === pageIndex)) return;
    const rest: NoteStateFact[] = [];
    for (const note of state.pendingNotes) {
      if (note.pageIndex !== pageIndex) {
        rest.push(note);
        continue;
      }
      const annotation = raw[note.index];
      if (annotation?.type === PdfAnnotationSubtype.TEXT && !state.noteOpen.has(annotation.id)) {
        state.noteOpen.set(annotation.id, note.open);
      }
    }
    state.pendingNotes = rest;
  }

  /** Adds what the adapter keeps beside EmbedPDF (note open state, stamp opacity). */
  private decorate(id: SourceId, annotation: Annotation): Annotation {
    const state = this.entry(id).annotations;
    if (annotation.kind === 'text') {
      const open = state.noteOpen.get(annotation.id);
      return open === undefined ? annotation : { ...annotation, open };
    }
    if (annotation.kind === 'stamp') {
      const opacity = state.opacity.get(annotation.id);
      return opacity === undefined ? annotation : { ...annotation, opacity };
    }
    return annotation;
  }

  private mapRaw(id: SourceId, raw: PdfAnnotationObject, g: PageGeometry): Annotation | undefined {
    const mapped = fromEmbedPdf(raw, g);
    return mapped ? this.decorate(id, mapped) : undefined;
  }

  /**
   * Annotations of a page in /Annots order, in user space. Widgets (form fields) and popups
   * are not listed: popups belong to their note (`NoteAnnotation.open`).
   */
  async listAnnotations(
    id: SourceId,
    pageIndex: number,
    options: EngineCallOptions = {},
  ): Promise<readonly Annotation[]> {
    const raw = await this.rawAnnotations(id, pageIndex, options);
    const g = pageGeometry(this.page(id, pageIndex).page);
    const result: Annotation[] = [];
    for (const annotation of raw) {
      const mapped = this.mapRaw(id, annotation, g);
      if (mapped) {
        result.push(mapped);
      } else {
        this.logger?.debug(
          LOG_SOURCE,
          'Annotations',
          `skipping unsupported annotation subtype ${PdfAnnotationSubtype[annotation.type]}`,
        );
      }
    }
    return this.withInkWidths(id, pageIndex, result, options);
  }

  /**
   * Inks of `annotations` with the widths stored in their `/PdfEditorInkWidths` (one raw
   * read per page with ink), kept only when they match the ink's paths point for point
   * (ADR-0018 §4). Without raw access, or for a page without ink, `annotations` as given.
   */
  private async withInkWidths(
    id: SourceId,
    pageIndex: number,
    annotations: Annotation[],
    options: EngineCallOptions | undefined,
  ): Promise<Annotation[]> {
    const rawTask = this.rawTask;
    if (!rawTask || !annotations.some((a) => a.kind === 'ink')) return annotations;
    const stored = await rawTask(
      id,
      (raw) => annotationStringsOnPage(raw, pageIndex, INK_WIDTHS_KEY),
      options?.signal ? { signal: options.signal } : {},
    );
    return annotations.map((a) => {
      if (a.kind !== 'ink') return a;
      const widths = parseInkWidths(stored.get(a.id), a.paths);
      return widths ? { ...a, widths } : a;
    });
  }

  /**
   * After EmbedPDF's create or update of ink `nm`: with widths that match its paths, writes
   * our appearance, the outline's /Rect and `/PdfEditorInkWidths` in one raw task (ADR-0018);
   * without, empties a stored `/PdfEditorInkWidths` so it cannot come back on a later listing.
   * Returns whether our appearance was written. Never aborted: EmbedPDF's half of the edit
   * has happened.
   */
  private async writeInk(
    id: SourceId,
    nm: string,
    ink: Extract<NewAnnotation, { kind: 'ink' }>,
    clear: boolean,
  ): Promise<boolean> {
    const rawTask = this.rawTask;
    if (!rawTask) return false;
    // A Multiply ink keeps EmbedPDF's blended constant-width appearance (craft spec §5.4).
    const write = ink.blendMode === 'multiply' ? undefined : inkAppearance(ink);
    if (!write) {
      if (clear) {
        await rawTask(id, (raw) => clearAnnotationString(raw, ink.pageIndex, nm, INK_WIDTHS_KEY));
      }
      return false;
    }
    await rawTask(id, (raw) => {
      setAnnotationAppearance(raw, ink.pageIndex, nm, {
        content: write.content,
        rect: write.rect,
        strings: { [INK_WIDTHS_KEY]: write.widths },
      });
    });
    return true;
  }

  private async findAnnotation(
    id: SourceId,
    pageIndex: number,
    annotationId: string,
    options: EngineCallOptions | undefined,
  ): Promise<PdfAnnotationObject> {
    const raw = await this.rawAnnotations(id, pageIndex, options);
    const found = raw.find((a) => a.id === annotationId);
    if (!found) {
      throw new EngineError(
        'internal',
        `Annotation ${annotationId} not found on page ${pageIndex}`,
      );
    }
    return found;
  }

  private async reread(
    id: SourceId,
    pageIndex: number,
    annotationId: string,
    fallback: Annotation,
    options: EngineCallOptions | undefined,
  ): Promise<Annotation> {
    const raw = await this.rawAnnotations(id, pageIndex, options);
    const found = raw.find((a) => a.id === annotationId);
    const g = pageGeometry(this.page(id, pageIndex).page);
    const mapped = found ? this.mapRaw(id, found, g) : undefined;
    if (!mapped) return fallback;
    const [withWidths] = await this.withInkWidths(id, pageIndex, [mapped], options);
    return withWidths ?? mapped;
  }

  /**
   * What EmbedPDF needs besides the object to create a stamp: the image (PNG, JPEG) or
   * appearance PDF bytes, or a generated text appearance for a named stamp.
   */
  private async stampContext(
    annotation: Extract<NewAnnotation, { kind: 'stamp' }>,
  ): Promise<{ data: ArrayBuffer }> {
    if (annotation.imageBlob) {
      const data = await annotation.imageBlob.arrayBuffer();
      if (!sniffStampData(new Uint8Array(data, 0, Math.min(data.byteLength, 8)))) {
        throw new EngineError(
          'unsupported',
          `Stamp images must be PNG, JPEG or a one-page PDF (got ${annotation.imageBlob.type || 'unknown type'})`,
        );
      }
      return { data };
    }
    if (annotation.name && (STAMP_NAMES as readonly string[]).includes(annotation.name)) {
      const rect = effectiveRect(annotation);
      return {
        data: await namedStampAppearance(
          annotation.name,
          rect.width,
          rect.height,
          annotation.color,
        ),
      };
    }
    throw new EngineError(
      'unsupported',
      `A stamp needs an imageBlob or one of the named stamps ${STAMP_NAMES.join(', ')}`,
    );
  }

  /** Rejects text the standard-14 FreeText font cannot show (see the README). */
  private checkFreeText(annotation: NewAnnotation): void {
    if (annotation.kind !== 'free-text') return;
    const bad = Array.from(annotation.text).filter((ch) => !isWinAnsi(ch));
    if (bad.length > 0) {
      throw new EngineError(
        'unsupported',
        `Text boxes can only use Latin-1 (WinAnsi) characters for now; cannot write ${[...new Set(bad)].join(' ')}`,
      );
    }
  }

  private remember(id: SourceId, annotation: NewAnnotation, nm: string): void {
    const state = this.entry(id).annotations;
    state.dirty = true;
    state.touched.add(nm);
    if (annotation.kind === 'text') {
      state.noteOpen.set(nm, annotation.open ?? state.noteOpen.get(nm) ?? false);
    }
    if (annotation.kind === 'stamp') {
      const opacity =
        annotation.opacity === undefined ? undefined : roundOpacity(annotation.opacity);
      if (opacity === undefined || opacity >= 1) state.opacity.delete(nm);
      else state.opacity.set(nm, opacity);
    }
  }

  private forget(id: SourceId, nm: string): void {
    const state = this.entry(id).annotations;
    state.dirty = true;
    state.touched.delete(nm);
    state.noteOpen.delete(nm);
    state.opacity.delete(nm);
  }

  /**
   * Creates an annotation. With `annotation.id` that id becomes the /NM (EmbedPDF honours a
   * supplied id; verified by the tests), so undo and replay restore the same id; it must
   * not exist on the page yet. Rects of quad/path/vertex kinds are derived from their
   * geometry (see `effectiveRect`).
   */
  async createAnnotation(
    id: SourceId,
    annotation: NewAnnotation,
    options: EngineCallOptions = {},
  ): Promise<Annotation> {
    const engine = await this.engine();
    const { doc, page } = this.page(id, annotation.pageIndex);
    this.checkFreeText(annotation);
    const requested = annotation.id;
    if (requested !== undefined) {
      if (requested === '') throw new EngineError('internal', 'An annotation id cannot be empty');
      const existing = await this.rawAnnotations(id, annotation.pageIndex, options);
      if (existing.some((a) => a.id === requested)) {
        throw new EngineError(
          'internal',
          `An annotation with id ${requested} already exists on page ${annotation.pageIndex}`,
        );
      }
    }
    const object = toEmbedPdf(annotation, requested ?? '', pageGeometry(page));
    const task =
      annotation.kind === 'stamp'
        ? engine.createPageAnnotation(
            doc,
            page,
            object,
            (await this.stampContext(annotation)) as never,
          )
        : engine.createPageAnnotation(doc, page, object);
    const newId = await this.run(task, options, 'createAnnotation');
    this.remember(id, annotation, newId);
    if (annotation.kind === 'ink') {
      try {
        await this.writeInk(id, newId, annotation, false);
      } catch (error) {
        // EmbedPDF's constant-width appearance stays: the ink exists, at its nominal width.
        this.logger?.warn(LOG_SOURCE, 'Annotations', 'variable-width ink not written', error);
      }
    }
    const { id: _requested, ...rest } = annotation;
    return this.reread(id, annotation.pageIndex, newId, { ...rest, id: newId }, options);
  }

  /**
   * Updates an annotation to `annotation` (the full new state; its id and kind select it).
   * For quad, path and vertex kinds the geometry is authoritative; when only `rect`
   * changed, the geometry is moved and scaled with it (a move or resize of the box).
   * Changes EmbedPDF cannot apply in place (fewer quads, a new stamp image or name) delete
   * and recreate the annotation with the same /NM (it moves to the top of the z-order).
   */
  async updateAnnotation(
    id: SourceId,
    annotation: Annotation,
    options: EngineCallOptions = {},
  ): Promise<Annotation> {
    const engine = await this.engine();
    const { doc, page } = this.page(id, annotation.pageIndex);
    const g = pageGeometry(page);
    const existing = await this.findAnnotation(id, annotation.pageIndex, annotation.id, options);
    const before = this.mapRaw(id, existing, g);
    if (before && before.kind !== annotation.kind) {
      throw new EngineError(
        'internal',
        `Annotation ${annotation.id} is a ${before.kind}, not a ${annotation.kind}`,
      );
    }
    this.checkFreeText(annotation);
    const next = before ? followRect(before, annotation) : annotation;
    const recreate =
      (next.kind === 'stamp' &&
        (next.imageBlob !== undefined ||
          (before?.kind === 'stamp' && (next.name ?? '') !== (before.name ?? '')))) ||
      ('quads' in next && before && 'quads' in before && next.quads.length < before.quads.length);
    if (recreate) {
      if (next.kind === 'stamp' && !next.imageBlob && !next.name) {
        throw new EngineError('unsupported', 'Removing a stamp name needs a new imageBlob');
      }
      await this.run(engine.removePageAnnotation(doc, page, existing), options, 'updateAnnotation');
      return this.createAnnotation(id, next, options);
    }
    const object = { ...existing, ...toEmbedPdf(next, annotation.id, g) };
    // An ink with widths gets our appearance right after (writeInk); EmbedPDF's own would
    // only be replaced.
    const ours =
      next.kind === 'ink' &&
      this.rawTask !== undefined &&
      next.blendMode !== 'multiply' &&
      storedInkWidths(next.paths, next.widths) !== undefined;
    const regenerateAppearance = !ours || INK_UPDATE_REGENERATES;
    await this.run(
      engine.updatePageAnnotation(doc, page, object, { regenerateAppearance }),
      options,
      'updateAnnotation',
    );
    this.remember(id, next, annotation.id);
    if (next.kind === 'ink') {
      try {
        await this.writeInk(id, annotation.id, next, true);
      } catch (error) {
        // Fall back to a constant width: EmbedPDF's appearance from the new data, and no
        // widths that could come back on a later listing.
        this.logger?.warn(LOG_SOURCE, 'Annotations', 'variable-width ink not written', error);
        if (!regenerateAppearance) {
          await this.run(
            engine.updatePageAnnotation(doc, page, object, { regenerateAppearance: true }),
            {},
            'updateAnnotation',
          );
        }
        await this.rawTask?.(id, (raw) =>
          clearAnnotationString(raw, next.pageIndex, annotation.id, INK_WIDTHS_KEY),
        );
      }
    }
    return this.reread(id, annotation.pageIndex, annotation.id, next, options);
  }

  /**
   * Appends the last path of `ink` (the ink's full new state, as `updateAnnotation` takes it)
   * to the Ink annotation `ink.id` (a pen burst, craft spec §5.3 item 8): one raw pass writes
   * the new `/InkList` entry, our appearance of every path (per-path operators from
   * `inkAppearance`'s cache), the outline's /Rect, `/PdfEditorInkWidths` and /M, with no
   * listing, no EmbedPDF update and no regenerated appearance. Resolves to the ink as written,
   * or `undefined`, with nothing written, when the ink on the page does not hold exactly
   * `ink.paths.length - 1` paths (the caller then updates it whole).
   *
   * A Multiply ink (the free Highlighter, craft spec §5.4), an ink whose widths do not match
   * its paths, or an adapter without raw access is updated through `updateAnnotation`, so a
   * Multiply ink keeps EmbedPDF's blended appearance and never receives ours.
   */
  async appendInkPath(
    id: SourceId,
    ink: InkAnnotation,
    options: EngineCallOptions = {},
  ): Promise<InkAnnotation | undefined> {
    const path = ink.paths[ink.paths.length - 1];
    if (!path || path.length === 0) {
      throw new EngineError('internal', `Appending to ${ink.id} needs a path with points`);
    }
    this.page(id, ink.pageIndex);
    const rawTask = this.rawTask;
    const write = ink.blendMode === 'multiply' || !rawTask ? undefined : inkAppearance(ink);
    if (!rawTask || !write) {
      const updated = await this.updateAnnotation(id, ink, options);
      return updated.kind === 'ink' ? updated : undefined;
    }
    const modified =
      ink.modified !== undefined && !Number.isNaN(new Date(ink.modified).getTime())
        ? new Date(ink.modified)
        : new Date();
    const count = await rawTask(
      id,
      (raw) =>
        appendRawInkPath(raw, ink.pageIndex, ink.id, {
          path,
          expectedPaths: ink.paths.length - 1,
          appearance: {
            content: write.content,
            rect: write.rect,
            strings: { [INK_WIDTHS_KEY]: write.widths },
          },
          modified: pdfDate(modified),
        }),
      options.signal ? { signal: options.signal } : {},
    );
    if (count === undefined) return undefined;
    this.remember(id, ink, ink.id);
    return { ...ink, widths: write.stored, rect: write.rect, modified: modified.toISOString() };
  }

  async deleteAnnotation(
    id: SourceId,
    pageIndex: number,
    annotationId: string,
    options: EngineCallOptions = {},
  ): Promise<void> {
    const engine = await this.engine();
    const { doc, page } = this.page(id, pageIndex);
    const existing = await this.findAnnotation(id, pageIndex, annotationId, options);
    await this.run(engine.removePageAnnotation(doc, page, existing), options, 'deleteAnnotation');
    // A note's popup stays in /Annots until `save()` drops it as an orphan.
    this.forget(id, annotationId);
  }

  /** The annotation's appearance as a one-page PDF (e.g. to recreate a deleted stamp). */
  async getAnnotationAppearance(
    id: SourceId,
    pageIndex: number,
    annotationId: string,
    options: EngineCallOptions = {},
  ): Promise<Blob> {
    const engine = await this.engine();
    const { doc, page } = this.page(id, pageIndex);
    const existing = await this.findAnnotation(id, pageIndex, annotationId, options);
    const bytes = await this.run(
      engine.exportAnnotationAppearanceAsPdf(doc, page, existing),
      options,
      'getAnnotationAppearance',
    );
    return new Blob([bytes], { type: 'application/pdf' });
  }

  // -------------------------------------------------------------------------
  // PdfEditor: forms
  // -------------------------------------------------------------------------

  private async widgets(
    id: SourceId,
    options: EngineCallOptions | undefined,
  ): Promise<WidgetRef[]> {
    const engine = await this.engine();
    const { doc } = this.entry(id);
    const result: WidgetRef[] = [];
    for (const page of doc.pages) {
      const widgets = await this.run(engine.getPageAnnoWidgets(doc, page), options, 'formFields');
      for (const widget of widgets) result.push({ page, widget });
    }
    return result;
  }

  /**
   * Form fields in page order, one per fully-qualified name, with every widget (user-space
   * rects, rotated pages included: see `annotationRectToUser`). Radio export values are the
   * /Opt entries when the field has them (PDFium reports the appearance state, an index).
   */
  async listFormFields(
    id: SourceId,
    options: EngineCallOptions = {},
  ): Promise<readonly FormField[]> {
    const widgets = await this.widgets(id, options);
    const groups = new Map<string, WidgetRef[]>();
    for (const ref of widgets) {
      const list = groups.get(ref.widget.field.name);
      if (list) list.push(ref);
      else groups.set(ref.widget.field.name, [ref]);
    }
    const fields = [...groups.values()].map(describeField);
    const signatureFields = fields.filter((f) => f.kind === 'signature');
    if (signatureFields.length === 0) return fields;
    // PDFium lists every top-level /Sig field, signed or not (an unsigned one has an empty
    // /ByteRange and /Contents), without its name: it cannot be paired by position.
    const engine = await this.engine();
    const entry = this.entry(id);
    const signatures = await this.run(engine.getSignatures(entry.doc), options, 'getSignatures');
    const signed = signatures.filter(
      (s) => s.byteRange.byteLength > 0 || s.contents.byteLength > 0,
    );
    if (signed.length === 0) return fields;
    // Pair by the parsed /V of each field (spec §3.3), read from PDFium's current bytes.
    const byName = await this.signatureFacts(entry, options);
    if (byName) {
      return fields.map((field) => {
        if (field.kind !== 'signature') return field;
        const facts = byName.get(field.name);
        return facts ? { ...field, signature: facts } : field;
      });
    }
    // The field tree cannot be read: attach PDFium's facts only when every field is signed.
    if (signed.length !== signatureFields.length) return fields;
    return fields.map((field) => {
      const index = signatureFields.indexOf(field);
      const signature = index < 0 ? undefined : signed[index];
      if (!signature) return field;
      const facts: FormFieldSignature = {
        ...(signature.time ? { date: signature.time } : {}),
        ...(signature.reason ? { reason: signature.reason } : {}),
      };
      return { ...field, signature: facts };
    });
  }

  /**
   * Signed signature fields by fully qualified name, with /Name, /M and /Reason of their /V
   * (cached per open document); undefined when the field tree cannot be read.
   */
  private signatureFacts(
    entry: OpenEntry,
    options: EngineCallOptions,
  ): Promise<ReadonlyMap<string, FormFieldSignature> | undefined> {
    let pending = this.signatureFactsCache.get(entry);
    if (!pending) {
      pending = (async () => {
        try {
          const engine = await this.engine();
          const bytes = await this.run(engine.saveAsCopy(entry.doc), options, 'save');
          const { doc, decrypted } = await loadForSignatures(new Uint8Array(bytes), entry.password);
          const map = new Map<string, FormFieldSignature>();
          for (const field of readSignatureFields(doc, decrypted)) {
            if (!field.signed || !field.sig || field.fieldObject === undefined) continue;
            const { name: signer, m: date, reason } = field.sig;
            map.set(field.name, {
              ...(signer ? { signer } : {}),
              ...(date ? { date } : {}),
              ...(reason ? { reason } : {}),
            });
          }
          return map;
        } catch {
          this.signatureFactsCache.delete(entry);
          return undefined;
        }
      })();
      this.signatureFactsCache.set(entry, pending);
    }
    return pending;
  }

  /**
   * Sets a field's value (see `FormField` for the value per kind) through PDFium's form
   * filler, then regenerates the appearance of every widget of the field so the page and
   * other viewers show the value. Checkbox values may also be state names (`Off`, or a
   * widget's export value); radio values are export values, `undefined` clears the group.
   */
  async setFormFieldValue(
    id: SourceId,
    name: string,
    value: FormField['value'],
    options: EngineCallOptions = {},
  ): Promise<void> {
    const engine = await this.engine();
    const { doc } = this.entry(id);
    const targets = (await this.widgets(id, options)).filter((w) => w.widget.field.name === name);
    const first = targets[0];
    if (!first) {
      throw new EngineError('internal', `Form field ${name} not found`);
    }
    const field = first.widget.field;
    const kind = FIELD_KINDS[field.type] ?? 'unknown';
    if ((field.flag & PDF_FORM_FIELD_FLAG.READONLY) !== 0) {
      throw new EngineError('unsupported', `Form field ${name} is read-only`);
    }
    const apply = (page: PdfPageObject, widget: PdfWidgetAnnoObject, v: FormFieldValue) =>
      this.run(engine.setFormFieldValue(doc, page, widget, v), options, 'setFormFieldValue');
    const cleared = value === undefined || value === null || value === false || value === 'Off';
    switch (kind) {
      case 'text': {
        const text =
          typeof value === 'object' ? value.join('') : typeof value === 'string' ? value : '';
        await apply(first.page, first.widget, { kind: 'text', text });
        break;
      }
      case 'checkbox': {
        const exports = targets.map((t) => widgetExportValue(t.widget));
        if (typeof value === 'string' && !cleared && !exports.includes(value)) {
          throw new EngineError('unsupported', `Checkbox ${name} has no state ${value}`);
        }
        for (const [index, { page, widget }] of targets.entries()) {
          const on = value === true || (typeof value === 'string' && exports[index] === value);
          await apply(page, widget, { kind: 'checked', checked: on && !cleared });
        }
        break;
      }
      case 'radio': {
        if (cleared || value === '') {
          // PDFium's form filler only turns radio buttons on: rewrite the PDF instead.
          if (targets.some((t) => isWidgetChecked(t.widget))) {
            await this.rewriteFields(id, { radiosOff: [name] }, options);
          }
          this.formsEdited.add(id);
          return;
        }
        const wanted = String(value);
        const target =
          targets.find((t) => widgetExportValue(t.widget) === wanted) ??
          targets.find((t) => t.widget.exportValue === wanted);
        if (!target) throw new EngineError('internal', `Radio ${name} has no option ${wanted}`);
        await apply(target.page, target.widget, { kind: 'checked', checked: true });
        break;
      }
      case 'combobox': {
        const choices = 'options' in field ? field.options : [];
        const wanted =
          typeof value === 'object' ? (value[0] ?? '') : typeof value === 'string' ? value : '';
        const index = choices.findIndex((o) => o.label === wanted);
        const editable = (field.flag & PDF_FORM_FIELD_FLAG.CHOICE_EDIT) !== 0;
        if (wanted === '' && !editable) {
          // PDFium cannot deselect a combo box: rewrite the PDF, then redraw the widgets.
          if (choices.some((o) => o.isSelected) || field.value !== '') {
            await this.rewriteFields(id, { choicesEmpty: [name] }, options);
            const fresh = await this.widgets(id, options);
            await this.regenerateAppearances(
              this.entry(id).doc,
              fresh.filter((w) => w.widget.field.name === name),
              options,
            );
          }
          this.formsEdited.add(id);
          return;
        }
        // Not an option: free text (editable combo boxes; PDFium refuses it otherwise).
        await apply(
          first.page,
          first.widget,
          index >= 0
            ? { kind: 'selection', index, isSelected: true }
            : { kind: 'text', text: wanted },
        );
        break;
      }
      case 'listbox': {
        const choices = 'options' in field ? field.options : [];
        const wanted = new Set(
          typeof value === 'object'
            ? value
            : typeof value === 'string' && value !== ''
              ? [value]
              : [],
        );
        const unknown = [...wanted].filter((w) => !choices.some((o) => o.label === w));
        if (unknown.length > 0) {
          throw new EngineError('unsupported', `List box ${name} has no option ${unknown[0]}`);
        }
        const multi = (field.flag & PDF_FORM_FIELD_FLAG.CHOICE_MULTL_SELECT) !== 0;
        if (!multi && wanted.size > 1) {
          throw new EngineError('unsupported', `List box ${name} allows one selection`);
        }
        // Deselect first, then select: a single-select list moves its selection.
        const order = choices
          .map((o, index) => ({ index, on: wanted.has(o.label), was: o.isSelected }))
          .filter((c) => c.on !== c.was)
          .sort((a, b) => Number(a.on) - Number(b.on));
        for (const change of order) {
          await apply(first.page, first.widget, {
            kind: 'selection',
            index: change.index,
            isSelected: change.on,
          });
        }
        break;
      }
      default:
        throw new EngineError('unsupported', `Setting values of ${kind} fields is not supported`);
    }
    this.formsEdited.add(id);
    await this.regenerateAppearances(doc, targets, options);
  }

  /**
   * Empties fields PDFium's form filler cannot empty (form-finalize.ts `clearFields`): the
   * open document is saved, rewritten with pdf-lib and re-opened under the same id, so
   * rendering, listing and later saves all see the change. Annotation ids survive (the
   * engine writes the /NM it assigns); an encrypted source continues unencrypted in memory
   * (exports of encrypted sources remove or replace security anyway).
   */
  private async rewriteFields(
    id: SourceId,
    request: Omit<ClearFieldsRequest, 'password'>,
    options: EngineCallOptions,
  ): Promise<void> {
    const engine = await this.engine();
    const entry = this.entry(id);
    const saved = await this.run(engine.saveAsCopy(entry.doc), options, 'save');
    const { bytes } = await clearFields(saved, {
      ...request,
      ...(entry.doc.isEncrypted && entry.password !== undefined
        ? { password: entry.password }
        : {}),
    });
    throwIfAborted(options.signal, 'setFormFieldValue');
    // EmbedPDF keys open documents by id: close first. Should the rewrite not open, the
    // source comes back as it was (from PDFium's own copy).
    const fallback = saved.slice(0);
    await this.run(engine.closeDocument(entry.doc), {}, 'close').catch(() => undefined);
    const reopen = (content: ArrayBuffer, password?: string) =>
      this.run(
        engine.openDocumentBuffer({ id, content }, password === undefined ? {} : { password }),
        {},
        { op: 'open', passwordProvided: password !== undefined },
      );
    try {
      const doc = await reopen(bytes);
      this.docs.set(id, { doc, annotations: entry.annotations });
    } catch (error) {
      const doc = await reopen(fallback, entry.password);
      this.docs.set(id, { ...entry, doc });
      throw new EngineError(
        'internal',
        `Emptying form fields failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  /** Regenerates the appearance streams of the given widgets (grouped per page). */
  private async regenerateAppearances(
    doc: PdfDocumentObject,
    targets: readonly WidgetRef[],
    options: EngineCallOptions,
  ): Promise<void> {
    const engine = await this.engine();
    const byPage = new Map<PdfPageObject, string[]>();
    for (const { page, widget } of targets) {
      const ids = byPage.get(page);
      if (ids) ids.push(widget.id);
      else byPage.set(page, [widget.id]);
    }
    for (const [page, ids] of byPage) {
      await this.run(
        engine.regenerateWidgetAppearances(doc, page, ids),
        options,
        'regenerateWidgetAppearances',
      );
    }
  }

  // -------------------------------------------------------------------------
  // PdfEditor: redaction and save
  // -------------------------------------------------------------------------

  /** Applies every /Redact annotation (true content removal via EPDFText_RedactInQuads). */
  async applyRedactions(id: SourceId, options: EngineCallOptions = {}): Promise<void> {
    const engine = await this.engine();
    const { doc } = this.entry(id);
    const all = await this.run(engine.getAllAnnotations(doc), options, 'applyRedactions');
    for (const [key, annotations] of Object.entries(all)) {
      if (!annotations.some((a) => a.type === PdfAnnotationSubtype.REDACT)) continue;
      const page = doc.pages[Number(key)];
      if (!page) continue;
      await this.run(engine.applyAllRedactions(doc, page), options, 'applyRedactions');
    }
  }

  /**
   * Full rewrite via FPDF_SaveAsCopy, then the annotation post-pass (annotations/finalize.ts:
   * /P, /M, /F Print, popups and note open state, stamp opacity) when annotations were
   * edited, comments are excluded or annotations are flattened. Flattening happens on a
   * scratch copy so the open source is not mutated; `removeSecurity` does mutate the open
   * document's security state.
   */
  async save(id: SourceId, options: SaveOptions = {}): Promise<ArrayBuffer> {
    if (options.incremental) {
      // TODO(M2): EmbedPDF 2.15 always writes a full copy; incremental saves need
      // FPDF_SaveAsCopy with FPDF_INCREMENTAL, which it does not expose.
      throw new EngineError('unsupported', 'Incremental save is not supported by this engine');
    }
    const engine = await this.engine();
    const entry = this.entry(id);
    const state = entry.annotations;
    const includeComments = (options.includeComments ?? true) && !options.flattenAnnotations;
    const finalize = state.dirty || !includeComments;
    // Forms: filled fields get every text/choice appearance regenerated and
    // /NeedAppearances false; flattening forms bakes widgets only (form-finalize.ts).
    const formPass = this.formsEdited.has(id) || options.flattenForms === true;
    if ((finalize || formPass) && entry.doc.isEncrypted && !options.removeSecurity) {
      // pdf-lib can read the encrypted copy but would write it unencrypted.
      throw new EngineError(
        'unsupported',
        'Annotation or form edits in an encrypted document can only be saved with removeSecurity (the export re-encrypts the output)',
      );
    }
    if (options.removeSecurity && entry.doc.isEncrypted) {
      await this.run(engine.removeEncryption(entry.doc), options, 'save');
    }
    if (formPass) {
      const widgets = await this.widgets(id, options);
      await this.regenerateAppearances(
        entry.doc,
        widgets.filter((w) => REGENERATED_KINDS.has(FIELD_KINDS[w.widget.field.type] ?? 'unknown')),
        options,
      );
    }
    let bytes = await this.run(engine.saveAsCopy(entry.doc), options, 'save');
    if (finalize) {
      const request: AnnotationFinalizeRequest = {
        touched: [...state.touched],
        noteOpen: Object.fromEntries(state.noteOpen),
        opacity: Object.fromEntries(state.opacity),
        includeComments,
        now: new Date().toISOString(),
      };
      bytes = await this.finalize(bytes, request, options);
    }
    if (options.flattenAnnotations) {
      bytes = await this.withScratch(bytes, entry.password, options, async (doc) => {
        for (const page of doc.pages) {
          const annotations = await this.run(
            engine.getPageAnnotations(doc, page),
            options,
            'flatten',
          );
          for (const annotation of annotations) {
            const type = annotation.type;
            // Links stay interactive; popups have no appearance and go with their parents;
            // widgets are the form pass's (flattened only with `flattenForms`).
            if (
              type === PdfAnnotationSubtype.LINK ||
              type === PdfAnnotationSubtype.POPUP ||
              type === PdfAnnotationSubtype.WIDGET
            ) {
              continue;
            }
            await this.run(engine.flattenAnnotation(doc, page, annotation), options, 'flatten');
          }
        }
        return this.run(engine.saveAsCopy(doc), options, 'save');
      });
    }
    if (formPass) {
      throwIfAborted(options.signal, 'save');
      // Encrypted sources reach here only with removeSecurity: the bytes are plain.
      bytes = (await finalizeForms(bytes, { flatten: options.flattenForms === true })).bytes;
    }
    return bytes;
  }

  /** Runs the annotation post-pass in the inspector's worker when it offers one. */
  private async finalize(
    bytes: ArrayBuffer,
    request: AnnotationFinalizeRequest,
    options: EngineCallOptions,
  ): Promise<ArrayBuffer> {
    throwIfAborted(options.signal, 'save');
    try {
      const inspector = this.inspector;
      const out = inspector?.finalizeAnnotations
        ? await inspector.finalizeAnnotations(bytes, request, options)
        : await finalizeAnnotations(bytes, request);
      throwIfAborted(options.signal, 'save');
      return out;
    } catch (error) {
      if (error instanceof EngineError) throw error;
      throw new EngineError(
        'internal',
        `Annotation post-pass failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  private async withScratch<R>(
    bytes: ArrayBuffer,
    password: string | undefined,
    options: EngineCallOptions,
    fn: (doc: PdfDocumentObject) => Promise<R>,
  ): Promise<R> {
    const engine = await this.engine();
    const scratchId = `__scratch:${++this.scratchCounter}`;
    const doc = await this.run(
      engine.openDocumentBuffer(
        { id: scratchId, content: bytes },
        password === undefined ? {} : { password },
      ),
      options,
      { op: 'open', passwordProvided: password !== undefined },
    );
    try {
      return await fn(doc);
    } finally {
      await engine
        .closeDocument(doc)
        .toPromise()
        .catch(() => undefined);
    }
  }

  // -------------------------------------------------------------------------
  // PdfVerifier
  // -------------------------------------------------------------------------

  async verify(
    bytes: ArrayBuffer,
    expectation: VerificationExpectation,
    options: EngineCallOptions = {},
  ): Promise<VerificationResult> {
    const scratchId = `__verify:${++this.scratchCounter}` as SourceId;
    const problems: string[] = [];
    // `open` transfers the bytes to PDFium's worker; conformance parses its own copy.
    const conformanceCopy = expectation.checkAnnotations ? bytes.slice(0) : undefined;
    let opened: OpenedDocument;
    try {
      opened = await this.open(
        scratchId,
        bytes,
        expectation.password === undefined
          ? options
          : { ...options, password: expectation.password },
      );
    } catch (error) {
      if (error instanceof EngineError && error.code === 'aborted') throw error;
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, problems: [`Output does not open in PDFium: ${message}`] };
    }
    try {
      if (opened.pageCount !== expectation.pageCount) {
        problems.push(`Page count is ${opened.pageCount}, expected ${expectation.pageCount}`);
      }
      const tolerance = 0.5;
      expectation.pageSizes.forEach((expected, index) => {
        const actual = opened.pages[index]?.size;
        if (!actual) return;
        if (
          Math.abs(actual.width - expected.width) > tolerance ||
          Math.abs(actual.height - expected.height) > tolerance
        ) {
          problems.push(
            `Page ${index + 1} is ${fmt(actual.width)}x${fmt(actual.height)}pt, expected ${fmt(expected.width)}x${fmt(expected.height)}pt`,
          );
        }
      });
      if (expectation.rotations) {
        expectation.rotations.forEach((expected, index) => {
          const actual = opened.pages[index]?.rotation;
          if (actual !== undefined && actual !== expected) {
            problems.push(`Page ${index + 1} is rotated ${actual}°, expected ${expected}°`);
          }
        });
      }
      if (expectation.outlineCount !== undefined || expectation.outlineTitles) {
        const titles = flattenTitles(opened.outline);
        if (expectation.outlineCount !== undefined && titles.length !== expectation.outlineCount) {
          problems.push(`Outline has ${titles.length} items, expected ${expectation.outlineCount}`);
        }
        if (expectation.outlineTitles) {
          const missing = expectation.outlineTitles.filter((t, i) => titles[i] !== t);
          if (missing.length > 0 || titles.length !== expectation.outlineTitles.length) {
            problems.push(
              `Outline titles differ: got ${JSON.stringify(titles)}, expected ${JSON.stringify(expectation.outlineTitles)}`,
            );
          }
        }
      }
      if (expectation.pageLabels !== undefined) {
        this.checkLabels(opened, expectation.pageLabels, problems);
      }
      if (expectation.formFieldNames) {
        const names = (await this.listFormFields(scratchId, options)).map((f) => f.name).sort();
        const expected = [...expectation.formFieldNames].sort();
        if (JSON.stringify(names) !== JSON.stringify(expected)) {
          problems.push(
            `Form fields differ: got ${JSON.stringify(names)}, expected ${JSON.stringify(expected)}`,
          );
        }
      }
      if (expectation.createdFields && expectation.createdFields.length > 0) {
        const listed = await this.listFormFields(scratchId, options);
        problems.push(...createdFieldProblems(listed, expectation.createdFields));
      }
      if (expectation.annotationCounts) {
        for (const [key, expected] of Object.entries(expectation.annotationCounts)) {
          const pageIndex = Number(key);
          if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= opened.pageCount) {
            continue;
          }
          const listed = await this.listAnnotations(scratchId, pageIndex, options);
          const actual = listed.filter((a) => a.kind !== 'link').length;
          if (actual !== expected) {
            problems.push(
              `Page ${pageIndex + 1} has ${actual} annotation${actual === 1 ? '' : 's'}, expected ${expected}`,
            );
          }
        }
      }
      if (conformanceCopy) {
        const inspector = this.inspector;
        const conformanceOptions = {
          ...(expectation.annotationIds ? { ids: expectation.annotationIds } : {}),
          ...(expectation.password === undefined ? {} : { password: expectation.password }),
        };
        const report = inspector?.checkAnnotations
          ? await inspector.checkAnnotations(conformanceCopy, conformanceOptions, options)
          : await checkAnnotationConformance(conformanceCopy, conformanceOptions);
        problems.push(...describeProblems(report.problems));
      }
      for (const pageIndex of expectation.annotationsInsidePages ?? []) {
        const page = opened.pages[pageIndex];
        if (!page) continue;
        const box = page.cropBox ?? { x: 0, y: 0, ...page.size };
        const tolerance = 1;
        const outside = (await this.listAnnotations(scratchId, pageIndex, options)).filter(
          (a) =>
            a.flags?.hidden !== true &&
            (a.rect.x < box.x - tolerance ||
              a.rect.y < box.y - tolerance ||
              a.rect.x + a.rect.width > box.x + box.width + tolerance ||
              a.rect.y + a.rect.height > box.y + box.height + tolerance),
        );
        if (outside.length > 0) {
          problems.push(
            `Page ${pageIndex + 1}: ${outside.length} annotation${outside.length === 1 ? '' : 's'} outside the resized page`,
          );
        }
      }
      for (const page of expectation.ocrWords ?? []) {
        if (page.pageIndex >= opened.pageCount || page.words.length === 0) continue;
        const chars = await this.pageChars(scratchId, page.pageIndex, options);
        problems.push(...ocrWordProblems(page, chars));
      }
      for (const region of expectation.redactedRegions ?? []) {
        if (region.pageIndex >= opened.pageCount) continue;
        const runs = await this.getPageText(scratchId, region.pageIndex, options);
        const leaked = runs
          .flatMap((run) => run.glyphs)
          .filter((glyph) => glyph.text.trim() !== '' && overlaps(glyph.rect, region.rect))
          .map((glyph) => glyph.text)
          .join('');
        if (leaked !== '') {
          problems.push(
            `Page ${region.pageIndex + 1}: text "${leaked}" is still extractable inside a redacted region`,
          );
        }
      }
    } finally {
      await this.close(scratchId).catch(() => undefined);
    }
    return { ok: problems.length === 0, problems };
  }

  /**
   * Every character of a page in content order, generated ones (synthesized spaces, line
   * breaks) without a box: what `ScratchDocument.chars` gives the OCR layer's own
   * verification, so `locateWords` sees the same text here.
   */
  private async pageChars(
    id: SourceId,
    pageIndex: number,
    options: EngineCallOptions,
  ): Promise<PageChar[]> {
    const engine = await this.engine();
    const { doc, page } = this.page(id, pageIndex);
    const glyphs = await this.run(engine.getPageGlyphs(doc, page), options, 'getPageText');
    if (glyphs.length === 0) return [];
    const texts = await this.run(
      engine.getTextSlices(
        doc,
        glyphs.map((_, charIndex) => ({ pageIndex, charIndex, charCount: 1 })),
      ),
      options,
      'getPageText',
    );
    const g = pageGeometry(page);
    // The glyph array is sparse (generated characters have no entry): index, not map.
    const out: PageChar[] = [];
    for (let i = 0; i < glyphs.length; i++) {
      const box = glyphs[i];
      const text = texts[i] ?? '';
      out.push(
        !box || box.isEmpty
          ? { text }
          : { text, rect: deviceToUserRect(g, { origin: box.origin, size: box.size }) },
      );
    }
    return out;
  }

  private checkLabels(
    opened: OpenedDocument,
    expected: readonly string[] | null,
    problems: string[],
  ): void {
    if (!this.inspector) {
      problems.push('Page labels cannot be verified: no source inspector is configured');
      return;
    }
    const actual = opened.pages.map((p) => p.label);
    const hasLabels = actual.some((label) => label !== undefined);
    if (expected === null) {
      if (hasLabels) problems.push('Output has page labels, expected none');
      return;
    }
    if (!hasLabels) {
      problems.push('Output has no page labels');
      return;
    }
    const wrong = expected.flatMap((label, index) =>
      actual[index] === label ? [] : [`page ${index + 1} "${actual[index] ?? ''}" ≠ "${label}"`],
    );
    if (wrong.length > 0) {
      problems.push(`Page labels differ: ${wrong.slice(0, 5).join(', ')}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Field kinds whose appearances the form pass regenerates (buttons keep theirs). */
const REGENERATED_KINDS: ReadonlySet<FormFieldKind> = new Set(['text', 'combobox', 'listbox']);

const FIELD_KINDS: Partial<Record<PDF_FORM_FIELD_TYPE, FormFieldKind>> = {
  [PDF_FORM_FIELD_TYPE.TEXTFIELD]: 'text',
  [PDF_FORM_FIELD_TYPE.CHECKBOX]: 'checkbox',
  [PDF_FORM_FIELD_TYPE.RADIOBUTTON]: 'radio',
  [PDF_FORM_FIELD_TYPE.COMBOBOX]: 'combobox',
  [PDF_FORM_FIELD_TYPE.LISTBOX]: 'listbox',
  [PDF_FORM_FIELD_TYPE.PUSHBUTTON]: 'button',
  [PDF_FORM_FIELD_TYPE.SIGNATURE]: 'signature',
};

/** A widget and the page it sits on. */
interface WidgetRef {
  readonly page: PdfPageObject;
  readonly widget: PdfWidgetAnnoObject;
}

/**
 * What a checkbox / radio widget stands for when on. PDFium reports the appearance state
 * name; when the field has /Opt, state names are indices into it (ISO 32000-2 12.7.5.2.4,
 * as pdf-lib writes radio groups), so the /Opt entry is the export value.
 */
function widgetExportValue(widget: PdfWidgetAnnoObject): string | undefined {
  const raw = widget.exportValue;
  if (raw === undefined) return undefined;
  const field = widget.field;
  const options = 'options' in field ? field.options : undefined;
  if (options && /^\d+$/.test(raw)) {
    const label = options[Number(raw)]?.label;
    if (label) return label;
  }
  return raw;
}

/** One `FormField` from all widgets sharing a name (in page, then /Annots order). */
function describeField(refs: readonly WidgetRef[]): FormField {
  const first = refs[0] as WidgetRef;
  const field = first.widget.field;
  const flag = field.flag;
  const kind = FIELD_KINDS[field.type] ?? 'unknown';
  const has = (bit: PDF_FORM_FIELD_FLAG) => (flag & bit) !== 0;
  const widgets: FormFieldWidget[] = refs.map(({ page, widget }) => {
    const exportValue =
      kind === 'checkbox' || kind === 'radio' ? widgetExportValue(widget) : undefined;
    return {
      pageIndex: page.index,
      rect: annotationRectToUser(pageGeometry(page), widget.rect),
      ...(exportValue === undefined ? {} : { exportValue }),
    };
  });
  const exports = [
    ...new Set(widgets.flatMap((w) => (w.exportValue === undefined ? [] : [w.exportValue]))),
  ];
  const choices = 'options' in field ? field.options : undefined;
  let value: FormField['value'];
  let options: readonly string[] | undefined;
  let exportValues: readonly string[] | undefined;
  switch (kind) {
    case 'checkbox':
      value = refs.some((r) => isWidgetChecked(r.widget));
      exportValues = exports;
      break;
    case 'radio': {
      const on = refs.find((r) => isWidgetChecked(r.widget));
      value = on ? widgetExportValue(on.widget) : undefined;
      options = exports;
      exportValues = exports;
      break;
    }
    case 'combobox':
      options = choices?.map((o) => o.label);
      exportValues = options;
      value = choices?.find((o) => o.isSelected)?.label ?? field.value;
      break;
    case 'listbox': {
      options = choices?.map((o) => o.label);
      exportValues = options;
      const selected = choices?.filter((o) => o.isSelected).map((o) => o.label) ?? [];
      value = has(PDF_FORM_FIELD_FLAG.CHOICE_MULTL_SELECT) ? selected : selected[0];
      break;
    }
    case 'button':
    case 'signature':
      value = undefined;
      break;
    default:
      value = field.value;
  }
  const maxLength =
    kind === 'text' && 'maxLen' in field && typeof field.maxLen === 'number' && field.maxLen > 0
      ? Math.round(field.maxLen)
      : undefined;
  const firstWidget = widgets[0] as FormFieldWidget;
  return {
    name: field.name,
    kind,
    pageIndex: firstWidget.pageIndex,
    rect: firstWidget.rect,
    ...(value === undefined ? {} : { value }),
    ...(options ? { options } : {}),
    ...(exportValues ? { exportValues } : {}),
    readOnly: has(PDF_FORM_FIELD_FLAG.READONLY),
    required: has(PDF_FORM_FIELD_FLAG.REQUIRED),
    ...(field.alternateName ? { tooltip: field.alternateName } : {}),
    ...(kind === 'text' && has(PDF_FORM_FIELD_FLAG.TEXT_MULTIPLINE) ? { multiline: true } : {}),
    ...(kind === 'text' && has(PDF_FORM_FIELD_FLAG.TEXT_PASSWORD) ? { password: true } : {}),
    ...(kind === 'text' && has(PDF_FORM_FIELD_FLAG.TEXT_COMB) ? { comb: true } : {}),
    ...(maxLength === undefined ? {} : { maxLength }),
    ...(kind === 'listbox' && has(PDF_FORM_FIELD_FLAG.CHOICE_MULTL_SELECT)
      ? { multiSelect: true }
      : {}),
    ...(kind === 'combobox' && has(PDF_FORM_FIELD_FLAG.CHOICE_EDIT) ? { editable: true } : {}),
    widgets,
  };
}

/**
 * Created form fields missing from `listed`: each expected field must be listed under its
 * name, or a name the form merge policy derived from it (`name_2`, …), with its kind and a
 * widget on every expected page.
 */
export function createdFieldProblems(
  listed: readonly FormField[],
  expected: readonly CreatedFieldExpectation[],
): string[] {
  const problems: string[] = [];
  for (const want of expected) {
    const prefix = `${want.name}_`;
    const candidates = listed.filter(
      (f) =>
        f.name === want.name ||
        (f.name.startsWith(prefix) && /^\d+$/.test(f.name.slice(prefix.length))),
    );
    const found = candidates.find(
      (f) =>
        f.kind === want.kind &&
        want.pageIndices.every((page) =>
          (f.widgets ?? [{ pageIndex: f.pageIndex }]).some((w) => w.pageIndex === page),
        ),
    );
    if (found) continue;
    const pages = want.pageIndices.map((p) => p + 1).join(', ');
    problems.push(
      candidates.length === 0
        ? `Created form field "${want.name}" is missing`
        : `Created form field "${want.name}" is not a ${want.kind} field with widgets on page ${pages}`,
    );
  }
  return problems;
}

/**
 * What an output page's OCR words lack (spec recognize-and-compare §1.3), by the rule of the
 * layer's own verification (`verifyOcrLayer`): every word must be found in the page text in
 * order (`locateWords`), and every word with a `rect` must lie within `OCR_RECT_TOLERANCE`
 * of it on every edge. No share below all of them passes: the export copies the verified
 * layer unchanged, so a word it loses or moves is a defect of the export, not of recognition.
 */
export function ocrWordProblems(
  expected: OcrWordsExpectation,
  chars: readonly PageChar[],
): string[] {
  const { pageIndex, words } = expected;
  const located = locateWords(
    chars,
    words.map((w) => w.text),
  );
  const missing: string[] = [];
  let placed = 0;
  let displaced = 0;
  let worst = 0;
  located.forEach((rect, i) => {
    const word = words[i];
    if (!word) return;
    if (!rect) {
      missing.push(word.text);
      return;
    }
    if (!word.rect) return;
    placed++;
    const deviation = edgeDeviation(rect, word.rect);
    if (deviation > OCR_RECT_TOLERANCE) {
      displaced++;
      worst = Math.max(worst, deviation);
    }
  });
  const problems: string[] = [];
  if (missing.length > 0) {
    problems.push(
      `Page ${pageIndex + 1}: ${missing.length} of ${words.length} OCR word${words.length === 1 ? '' : 's'} not found in the text ` +
        `(${missing.slice(0, 5).join(', ')})`,
    );
  }
  if (displaced > 0) {
    problems.push(
      `Page ${pageIndex + 1}: ${displaced} of ${placed} OCR word${placed === 1 ? '' : 's'} more than ${OCR_RECT_TOLERANCE} pt ` +
        `from their place (worst ${worst.toFixed(2)} pt)`,
    );
  }
  return problems;
}

function flattenTitles(nodes: readonly EngineOutlineNode[], into: string[] = []): string[] {
  for (const node of nodes) {
    into.push(node.title);
    flattenTitles(node.children, into);
  }
  return into;
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/** True when the glyph's center lies inside the region (robust to loose glyph boxes). */
function overlaps(glyph: Rect, region: Rect): boolean {
  const cx = glyph.x + glyph.width / 2;
  const cy = glyph.y + glyph.height / 2;
  return (
    cx >= region.x &&
    cx <= region.x + region.width &&
    cy >= region.y &&
    cy <= region.y + region.height
  );
}

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

interface ByteHeuristics {
  readonly acroFormToken: boolean;
  readonly xfaToken: boolean;
  readonly structTreeToken: boolean;
  readonly linearized: boolean;
  readonly objectStreams: boolean;
  readonly pageLabelsToken: boolean;
  readonly langToken: boolean;
  readonly outlinesToken: boolean;
  readonly popupToken: boolean;
}

function indexOfAscii(haystack: Uint8Array, needle: string, limit = haystack.length): number {
  const first = needle.charCodeAt(0);
  const end = Math.min(limit, haystack.length) - needle.length;
  let i = haystack.indexOf(first);
  while (i !== -1 && i <= end) {
    let match = true;
    for (let j = 1; j < needle.length; j++) {
      if (haystack[i + j] !== needle.charCodeAt(j)) {
        match = false;
        break;
      }
    }
    if (match) return i;
    i = haystack.indexOf(first, i + 1);
  }
  return -1;
}

/** Cheap token scan for flags EmbedPDF does not report. Blind to compressed object streams. */
function scanBytes(bytes: Uint8Array): ByteHeuristics {
  return {
    acroFormToken: indexOfAscii(bytes, '/AcroForm') !== -1,
    xfaToken: indexOfAscii(bytes, '/XFA') !== -1,
    structTreeToken: indexOfAscii(bytes, '/StructTreeRoot') !== -1,
    linearized: indexOfAscii(bytes, '/Linearized', 1024) !== -1,
    objectStreams: indexOfAscii(bytes, '/ObjStm') !== -1,
    pageLabelsToken: indexOfAscii(bytes, '/PageLabels') !== -1,
    langToken: indexOfAscii(bytes, '/Lang') !== -1,
    outlinesToken: indexOfAscii(bytes, '/Outlines') !== -1,
    popupToken: indexOfAscii(bytes, '/Popup') !== -1,
  };
}

function mapMetadata(m: PdfMetadataObject): DocumentMetadata {
  const out: { -readonly [K in keyof DocumentMetadata]: DocumentMetadata[K] } = {
    policy: 'inherit-first-source',
  };
  if (m.title) out.title = m.title;
  if (m.author) out.author = m.author;
  if (m.subject) out.subject = m.subject;
  if (m.keywords) out.keywords = m.keywords;
  if (m.creator) out.creator = m.creator;
  if (m.producer) out.producer = m.producer;
  if (m.creationDate instanceof Date) out.creationDate = m.creationDate.toISOString();
  if (m.modificationDate instanceof Date) out.modificationDate = m.modificationDate.toISOString();
  // /Lang is not exposed by EmbedPDF's getMetadata; `open` adds it from the inspector.
  return out;
}

function mapView(
  zoom: PdfDestinationObject['zoom'],
  view: number[],
  facts?: OutlineItemFacts['xyz'],
): DestinationView | undefined {
  switch (zoom.mode) {
    case PdfZoomMode.XYZ: {
      if (facts) {
        // The inspector read the array itself: null means "keep current", 0 is a value.
        return {
          fit: 'xyz',
          ...(facts.left === null ? {} : { left: facts.left }),
          ...(facts.top === null ? {} : { top: facts.top }),
          ...(facts.zoom === null || facts.zoom <= 0 ? {} : { zoom: facts.zoom }),
        };
      }
      // Without the inspector: PDFium reports null parameters as 0, so 0 has to be read as
      // "keep current" (a destination at exactly x = 0 or y = 0 loses that coordinate).
      const p = zoom.params;
      return {
        fit: 'xyz',
        ...(p && p.x !== 0 ? { left: p.x } : {}),
        ...(p && p.y !== 0 ? { top: p.y } : {}),
        ...(p && p.zoom > 0 ? { zoom: p.zoom } : {}),
      };
    }
    case PdfZoomMode.FitPage:
    case PdfZoomMode.FitBoundingBox:
      return { fit: 'fit' };
    case PdfZoomMode.FitHorizontal:
    case PdfZoomMode.FitBoundingBoxHorizontal:
      return view[0] === undefined ? { fit: 'fit-h' } : { fit: 'fit-h', top: view[0] };
    case PdfZoomMode.FitVertical:
    case PdfZoomMode.FitBoundingBoxVertical:
      return view[0] === undefined ? { fit: 'fit-v' } : { fit: 'fit-v', left: view[0] };
    case PdfZoomMode.FitRectangle: {
      const [l, b, r, t] = view;
      if (l === undefined || b === undefined || r === undefined || t === undefined)
        return { fit: 'fit-r' };
      return { fit: 'fit-r', rect: { x: l, y: b, width: r - l, height: t - b } };
    }
    default:
      return undefined;
  }
}

function mapTarget(
  target: PdfLinkTarget | undefined,
  facts?: OutlineItemFacts,
): EngineOutlineNode['destination'] {
  if (!target) return undefined;
  const destination =
    target.type === 'destination'
      ? target.destination
      : target.action.type === PdfActionType.Goto
        ? target.action.destination
        : undefined;
  if (destination) {
    if (destination.pageIndex < 0) {
      return { kind: 'unresolved', reason: 'destination page not found' };
    }
    const view = mapView(destination.zoom, destination.view, facts?.xyz);
    return view
      ? { kind: 'page', pageIndex: destination.pageIndex, view }
      : { kind: 'page', pageIndex: destination.pageIndex };
  }
  if (target.type === 'action' && target.action.type === PdfActionType.URI) {
    return { kind: 'uri', uri: target.action.uri };
  }
  return { kind: 'unresolved', reason: 'unsupported action' };
}

/** A glyph box in EmbedPDF display space. */
interface DisplayBox {
  readonly origin: { readonly x: number; readonly y: number };
  readonly size: { readonly width: number; readonly height: number };
}

/**
 * Extent of a text line in display space (y down), for `getPageText`'s baseline-band test.
 * A line flows along x or y there: along y when it is horizontal in user space on a
 * /Rotate 90 or 270 page, or when its text matrix turns it a quarter. The band is the line's
 * extent across that flow; a glyph whose centre falls outside it starts a new line. The flow
 * comes from the first two glyphs; until then a glyph in line with the first one along
 * either axis belongs to it. (Testing only y, as before, let a line running down a /Rotate 90
 * page swallow every perpendicular line that started beside it.)
 */
class LineBand {
  private left: number;
  private top: number;
  private right: number;
  private bottom: number;
  private flow: 'x' | 'y' | undefined;

  constructor(box: DisplayBox) {
    this.left = box.origin.x;
    this.top = box.origin.y;
    this.right = box.origin.x + box.size.width;
    this.bottom = box.origin.y + box.size.height;
  }

  holds(box: DisplayBox): boolean {
    const midX = box.origin.x + box.size.width / 2;
    const midY = box.origin.y + box.size.height / 2;
    const inRow = midY >= this.top && midY <= this.bottom;
    const inColumn = midX >= this.left && midX <= this.right;
    if (this.flow === 'x') return inRow;
    if (this.flow === 'y') return inColumn;
    return inRow || inColumn;
  }

  add(box: DisplayBox): void {
    if (this.flow === undefined) {
      const dx = box.origin.x + box.size.width / 2 - (this.left + this.right) / 2;
      const dy = box.origin.y + box.size.height / 2 - (this.top + this.bottom) / 2;
      this.flow = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
    }
    this.left = Math.min(this.left, box.origin.x);
    this.top = Math.min(this.top, box.origin.y);
    this.right = Math.max(this.right, box.origin.x + box.size.width);
    this.bottom = Math.max(this.bottom, box.origin.y + box.size.height);
  }
}

function countBookmarks(nodes: readonly PdfBookmarkObject[]): number {
  return nodes.reduce((sum, node) => sum + 1 + countBookmarks(node.children ?? []), 0);
}

/**
 * EmbedPDF's bookmarks plus the inspector's per-item facts (pre-order): the open state
 * (/Count sign, which EmbedPDF does not expose) and /XYZ null parameters. Facts are used
 * only when both walks saw the same number of items; otherwise every item is closed and
 * /XYZ zeros read as "keep current".
 */
function mapOutline(
  bookmarks: readonly PdfBookmarkObject[],
  facts: readonly OutlineItemFacts[] | undefined,
): EngineOutlineNode[] {
  const usable = facts?.length === countBookmarks(bookmarks) ? facts : undefined;
  let next = 0;
  const map = (b: PdfBookmarkObject): EngineOutlineNode => {
    const fact = usable?.[next++];
    const destination = mapTarget(b.target, fact);
    return {
      title: b.title,
      ...(destination ? { destination } : {}),
      open: fact?.open ?? false,
      children: (b.children ?? []).map(map),
    };
  };
  return bookmarks.map(map);
}
