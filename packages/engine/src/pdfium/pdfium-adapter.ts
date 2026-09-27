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
  PdfPageFlattenFlag,
  type PdfRenderPageOptions,
  type PdfWidgetAnnoObject,
  PdfZoomMode,
  type Task,
} from '@embedpdf/models';
import type {
  DestinationView,
  DocumentMetadata,
  Rect,
  SourceFlags,
  SourceId,
} from '@pdf-editor/document-model';

import {
  type Annotation,
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
  type RenderOptions,
  type RenderResult,
  type SaveOptions,
  type SearchHit,
  type SourceInspection,
  type SourceInspector,
  type TextRun,
  type VerificationExpectation,
  type VerificationResult,
} from '../types';
import { checkXrefStructure } from '../structure/xref-check';
import { fromEmbedPdf, toEmbedPdf } from './annotation-mapping';
import {
  deviceToUserRect,
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

interface OpenEntry {
  readonly doc: PdfDocumentObject;
  readonly password?: string;
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
      options.password === undefined ? { doc } : { doc, password: options.password },
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
      return {
        id,
        pageCount: doc.pageCount,
        pages: doc.pages.map((p, index) => {
          const label = labels?.[index];
          return {
            size: unrotatedSize(p),
            rotation: rotationDegrees(p),
            ...(label === undefined ? {} : { label }),
          };
        }),
        fingerprint,
        flags,
        metadata:
          inspected.language === undefined ? mapped : { ...mapped, language: inspected.language },
        outline: bookmarks.bookmarks.map(mapBookmark),
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
      !(heuristics.pageLabelsToken || heuristics.langToken || heuristics.objectStreams)
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
    options: EngineCallOptions & {
      readonly matchCase?: boolean;
      readonly wholeWord?: boolean;
    } = {},
  ): Promise<readonly SearchHit[]> {
    const engine = await this.engine();
    const { doc } = this.entry(id);
    const flags: MatchFlag[] = [];
    if (options.matchCase) flags.push(MatchFlag.MatchCase);
    if (options.wholeWord) flags.push(MatchFlag.MatchWholeWord);
    const result = await this.run(engine.searchAllPages(doc, query, { flags }), options, 'search');
    return result.results.map((hit) => {
      const page = doc.pages[hit.pageIndex];
      const g = page ? pageGeometry(page) : undefined;
      return {
        pageIndex: hit.pageIndex,
        rects: g ? hit.rects.map((r) => deviceToUserRect(g, r)) : [],
        context: `${hit.context.before}${hit.context.match}${hit.context.after}`,
      };
    });
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
    return this.run(engine.getPageAnnotations(doc, page), options, 'listAnnotations');
  }

  async listAnnotations(
    id: SourceId,
    pageIndex: number,
    options: EngineCallOptions = {},
  ): Promise<readonly Annotation[]> {
    const raw = await this.rawAnnotations(id, pageIndex, options);
    const g = pageGeometry(this.page(id, pageIndex).page);
    const result: Annotation[] = [];
    for (const annotation of raw) {
      const mapped = fromEmbedPdf(annotation, g);
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
    return (found ? fromEmbedPdf(found, g) : undefined) ?? fallback;
  }

  async createAnnotation(
    id: SourceId,
    annotation: NewAnnotation,
    options: EngineCallOptions = {},
  ): Promise<Annotation> {
    const engine = await this.engine();
    const { doc, page } = this.page(id, annotation.pageIndex);
    const object = toEmbedPdf(annotation, '', pageGeometry(page));
    let task: Task<string, PdfErrorReason>;
    if (annotation.kind === 'stamp') {
      if (!annotation.imageBlob) {
        // TODO(M2): named (non-image) stamps need a generated appearance.
        throw new EngineError('unsupported', 'Stamp annotations need an imageBlob');
      }
      const data = await annotation.imageBlob.arrayBuffer();
      task = engine.createPageAnnotation(doc, page, object, {
        data,
        ...(annotation.imageBlob.type === 'image/png' || annotation.imageBlob.type === 'image/jpeg'
          ? { mimeType: annotation.imageBlob.type }
          : {}),
      } as never);
    } else {
      task = engine.createPageAnnotation(doc, page, object);
    }
    const newId = await this.run(task, options, 'createAnnotation');
    return this.reread(id, annotation.pageIndex, newId, { ...annotation, id: newId }, options);
  }

  async updateAnnotation(
    id: SourceId,
    annotation: Annotation,
    options: EngineCallOptions = {},
  ): Promise<Annotation> {
    const engine = await this.engine();
    const { doc, page } = this.page(id, annotation.pageIndex);
    const existing = await this.findAnnotation(id, annotation.pageIndex, annotation.id, options);
    const next = { ...existing, ...toEmbedPdf(annotation, annotation.id, pageGeometry(page)) };
    await this.run(
      engine.updatePageAnnotation(doc, page, next, {
        regenerateAppearance: true,
      }),
      options,
      'updateAnnotation',
    );
    return this.reread(id, annotation.pageIndex, annotation.id, annotation, options);
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
        rect: deviceToUserRect(pageGeometry(page), widget.rect),
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
   * Full rewrite via FPDF_SaveAsCopy. Flattening happens on a scratch copy so the open source
   * is not mutated; `removeSecurity` does mutate the open document's security state.
   */
  async save(id: SourceId, options: SaveOptions = {}): Promise<ArrayBuffer> {
    if (options.incremental) {
      // TODO(M2): EmbedPDF 2.15 always writes a full copy; incremental saves need
      // FPDF_SaveAsCopy with FPDF_INCREMENTAL, which it does not expose.
      throw new EngineError('unsupported', 'Incremental save is not supported by this engine');
    }
    const engine = await this.engine();
    const entry = this.entry(id);
    if (options.removeSecurity && entry.doc.isEncrypted) {
      await this.run(engine.removeEncryption(entry.doc), options, 'save');
    }
    const bytes = await this.run(engine.saveAsCopy(entry.doc), options, 'save');
    if (!options.flattenAnnotations && !options.flattenForms) {
      return bytes;
    }
    return this.withScratch(bytes, entry.password, options, async (doc) => {
      for (const page of doc.pages) {
        if (options.flattenAnnotations && options.flattenForms) {
          await this.run(
            engine.flattenPage(doc, page, { flag: PdfPageFlattenFlag.Display }),
            options,
            'flatten',
          );
          continue;
        }
        const annotations = await this.run(
          engine.getPageAnnotations(doc, page),
          options,
          'flatten',
        );
        for (const annotation of annotations) {
          const isWidget = annotation.type === PdfAnnotationSubtype.WIDGET;
          if (isWidget ? options.flattenForms : options.flattenAnnotations) {
            await this.run(engine.flattenAnnotation(doc, page, annotation), options, 'flatten');
          }
        }
      }
      return this.run(engine.saveAsCopy(doc), options, 'save');
    });
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
    let opened: OpenedDocument;
    try {
      opened = await this.open(scratchId, bytes, options);
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

function mapView(zoom: PdfDestinationObject['zoom'], view: number[]): DestinationView | undefined {
  switch (zoom.mode) {
    case PdfZoomMode.XYZ: {
      // PDFium reports absent parameters as 0; treat 0 as "keep current".
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

function mapTarget(target: PdfLinkTarget | undefined): EngineOutlineNode['destination'] {
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
    const view = mapView(destination.zoom, destination.view);
    return view
      ? { kind: 'page', pageIndex: destination.pageIndex, view }
      : { kind: 'page', pageIndex: destination.pageIndex };
  }
  if (target.type === 'action' && target.action.type === PdfActionType.URI) {
    return { kind: 'uri', uri: target.action.uri };
  }
  return { kind: 'unresolved', reason: 'unsupported action' };
}

function mapBookmark(b: PdfBookmarkObject): EngineOutlineNode {
  const destination = mapTarget(b.target);
  // EmbedPDF does not expose the /Count sign (open state); default to closed.
  return {
    title: b.title,
    ...(destination ? { destination } : {}),
    open: false,
    children: (b.children ?? []).map(mapBookmark),
  };
}
