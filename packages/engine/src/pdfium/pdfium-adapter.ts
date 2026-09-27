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

import {
  type CreatePdfiumEngineOptions,
  createPdfiumEngine,
  type FontFallbackConfig,
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
import { namedStampAppearance } from '../annotations/stamp-appearance';
import {
  type Annotation,
  type AnnotationFinalizeRequest,
  EngineError,
  type EngineCallOptions,
  type EngineOutlineNode,
  type FormField,
  type FormFieldKind,
  type Glyph,
  type NewAnnotation,
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
import { checkXrefStructure } from '../structure/xref-check';
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
import { type ErrorContext, runTask, throwIfAborted } from './task-bridge';

export type { FontFallbackConfig };

export type PdfiumEngineFactory = (
  wasmUrl: string,
  options: CreatePdfiumEngineOptions,
) => PdfEngine | Promise<PdfEngine>;

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
  private enginePromise: Promise<PdfEngine> | undefined;
  private readonly docs = new Map<SourceId, OpenEntry>();
  private scratchCounter = 0;

  constructor(options: PdfiumAdapterOptions) {
    this.wasmUrl = options.wasmUrl;
    this.fontFallback = options.fontFallback ?? null;
    this.logger = options.logger;
    this.engineFactory = options.engineFactory ?? createPdfiumEngine;
    this.inspector = options.inspector;
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
        flags,
        metadata:
          inspected.language === undefined ? mapped : { ...mapped, language: inspected.language },
        outline: mapOutline(bookmarks.bookmarks, inspected.outline),
      };
    } catch (error) {
      await this.close(id).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Runs the inspector on a copy of `bytes` when the file may carry what it reads (page
   * labels, /Lang; both can hide in compressed object streams). Inspection problems never
   * fail an open: they only cost the labels.
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
        heuristics.objectStreams
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
    const engine = await this.engine();
    await this.run(engine.closeDocument(entry.doc), undefined, 'close');
  }

  /**
   * Renders a page (or `clip`, in user space) to an ImageBitmap. The bitmap is created fresh
   * for the caller and not retained; when this adapter sits behind Comlink, the caller's
   * wrapper should transfer it (`Comlink.transfer(result, [result.bitmap])`).
   * Defaults: annotations on, interactive form layer off, white background.
   */
  async renderPage(id: SourceId, pageIndex: number, options: RenderOptions): Promise<RenderResult> {
    const engine = await this.engine();
    const { doc, page } = this.page(id, pageIndex);
    const renderOptions: PdfRenderPageOptions = {
      scaleFactor: options.scale,
      rotation: ((options.rotation ?? 0) / 90) & 3,
      withAnnotations: options.withAnnotations ?? true,
      withForms: options.withForms ?? false,
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
   * display space (after /Rotate), where text reads horizontally; output rects are user space.
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
    let current:
      | { text: string; glyphs: Glyph[]; top: number; bottom: number; runId: number }
      | undefined;
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
      // Display space: y grows downward, lines are horizontal.
      const top = box.origin.y;
      const bottom = box.origin.y + box.size.height;
      const mid = (top + bottom) / 2;
      const runId = runIds[i] ?? -1;
      if (current && runId !== current.runId && (mid < current.top || mid > current.bottom)) {
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
        current = { text: '', glyphs: [], top, bottom, runId };
      } else {
        current.top = Math.min(current.top, top);
        current.bottom = Math.max(current.bottom, bottom);
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
    return result;
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
    return (found ? this.mapRaw(id, found, g) : undefined) ?? fallback;
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
    await this.run(
      engine.updatePageAnnotation(doc, page, object, { regenerateAppearance: true }),
      options,
      'updateAnnotation',
    );
    this.remember(id, next, annotation.id);
    return this.reread(id, annotation.pageIndex, annotation.id, next, options);
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
  ): Promise<{ page: PdfPageObject; widget: PdfWidgetAnnoObject }[]> {
    const engine = await this.engine();
    const { doc } = this.entry(id);
    const result: { page: PdfPageObject; widget: PdfWidgetAnnoObject }[] = [];
    for (const page of doc.pages) {
      const widgets = await this.run(engine.getPageAnnoWidgets(doc, page), options, 'formFields');
      for (const widget of widgets) result.push({ page, widget });
    }
    return result;
  }

  async listFormFields(
    id: SourceId,
    options: EngineCallOptions = {},
  ): Promise<readonly FormField[]> {
    const widgets = await this.widgets(id, options);
    const byName = new Map<string, FormField>();
    for (const { page, widget } of widgets) {
      const field = widget.field;
      const kind = FIELD_KINDS[field.type] ?? 'unknown';
      const existing = byName.get(field.name);
      if (existing) {
        // Radio groups (and fields with several widgets): report the checked export value.
        if (kind === 'radio' && isWidgetChecked(widget)) {
          byName.set(field.name, { ...existing, value: widget.exportValue ?? field.value });
        }
        continue;
      }
      const options = 'options' in field ? field.options : undefined;
      let value: FormField['value'];
      switch (kind) {
        case 'checkbox':
          value = isWidgetChecked(widget);
          break;
        case 'radio':
          value = isWidgetChecked(widget) ? (widget.exportValue ?? field.value) : undefined;
          break;
        case 'combobox':
          value = options?.find((o) => o.isSelected)?.label ?? field.value;
          break;
        case 'listbox': {
          const selected = options?.filter((o) => o.isSelected).map((o) => o.label) ?? [];
          value = field.flag & PDF_FORM_FIELD_FLAG.CHOICE_MULTL_SELECT ? selected : selected[0];
          break;
        }
        default:
          value = field.value;
      }
      byName.set(field.name, {
        name: field.name,
        kind,
        pageIndex: page.index,
        rect: annotationRectToUser(pageGeometry(page), widget.rect),
        ...(value === undefined ? {} : { value }),
        ...(options ? { options: options.map((o) => o.label) } : {}),
        readOnly: (field.flag & PDF_FORM_FIELD_FLAG.READONLY) !== 0,
        required: (field.flag & PDF_FORM_FIELD_FLAG.REQUIRED) !== 0,
      });
    }
    return [...byName.values()];
  }

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
    const kind = FIELD_KINDS[first.widget.field.type] ?? 'unknown';
    const apply = (page: PdfPageObject, widget: PdfWidgetAnnoObject, v: FormFieldValue) =>
      this.run(engine.setFormFieldValue(doc, page, widget, v), options, 'setFormFieldValue');
    switch (kind) {
      case 'text':
        await apply(first.page, first.widget, { kind: 'text', text: String(value ?? '') });
        return;
      case 'checkbox':
        for (const { page, widget } of targets) {
          await apply(page, widget, { kind: 'checked', checked: value === true });
        }
        return;
      case 'radio': {
        const target = targets.find((t) => t.widget.exportValue === value);
        if (!target)
          throw new EngineError('internal', `Radio ${name} has no option ${String(value)}`);
        await apply(target.page, target.widget, { kind: 'checked', checked: true });
        return;
      }
      case 'combobox':
      case 'listbox': {
        const field = first.widget.field;
        const choices = 'options' in field ? field.options : [];
        const wanted = new Set(Array.isArray(value) ? value : [String(value ?? '')]);
        for (let index = 0; index < choices.length; index++) {
          const label = choices[index]?.label ?? '';
          if (kind === 'combobox' && !wanted.has(label)) continue;
          await apply(first.page, first.widget, {
            kind: 'selection',
            index,
            isSelected: wanted.has(label),
          });
        }
        return;
      }
      default:
        throw new EngineError('unsupported', `Setting values of ${kind} fields is not supported`);
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
    if (finalize && entry.doc.isEncrypted && !options.removeSecurity) {
      // pdf-lib can read the encrypted copy but would write it unencrypted.
      throw new EngineError(
        'unsupported',
        'Annotation edits in an encrypted document can only be saved with removeSecurity (the export re-encrypts the output)',
      );
    }
    if (options.removeSecurity && entry.doc.isEncrypted) {
      await this.run(engine.removeEncryption(entry.doc), options, 'save');
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
    if (!options.flattenAnnotations && !options.flattenForms) {
      return bytes;
    }
    return this.withScratch(bytes, entry.password, options, async (doc) => {
      for (const page of doc.pages) {
        const annotations = await this.run(
          engine.getPageAnnotations(doc, page),
          options,
          'flatten',
        );
        for (const annotation of annotations) {
          const type = annotation.type;
          // Links stay interactive; popups have no appearance and go with their parents.
          if (type === PdfAnnotationSubtype.LINK || type === PdfAnnotationSubtype.POPUP) continue;
          const isWidget = type === PdfAnnotationSubtype.WIDGET;
          if (isWidget ? options.flattenForms : options.flattenAnnotations) {
            await this.run(engine.flattenAnnotation(doc, page, annotation), options, 'flatten');
          }
        }
      }
      return this.run(engine.saveAsCopy(doc), options, 'save');
    });
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

const FIELD_KINDS: Partial<Record<PDF_FORM_FIELD_TYPE, FormFieldKind>> = {
  [PDF_FORM_FIELD_TYPE.TEXTFIELD]: 'text',
  [PDF_FORM_FIELD_TYPE.CHECKBOX]: 'checkbox',
  [PDF_FORM_FIELD_TYPE.RADIOBUTTON]: 'radio',
  [PDF_FORM_FIELD_TYPE.COMBOBOX]: 'combobox',
  [PDF_FORM_FIELD_TYPE.LISTBOX]: 'listbox',
  [PDF_FORM_FIELD_TYPE.PUSHBUTTON]: 'button',
  [PDF_FORM_FIELD_TYPE.SIGNATURE]: 'signature',
};

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
