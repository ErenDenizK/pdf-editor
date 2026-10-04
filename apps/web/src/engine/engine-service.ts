/**
 * Engine service: the app's single entry point to the PDFium engine (ADR-0002, ADR-0011).
 *
 * - Lazily starts our own PDFium worker (`@pdf-editor/engine/pdfium.worker`, which hosts the
 *   `PdfiumAdapter`) on first use and talks to it through `createPdfiumProxy`, with a
 *   self-hosted wasm URL and font fallback disabled (no CDN; engine README).
 * - Renders through a small priority queue: Read-mode pages > visible thumbnails >
 *   offscreen thumbnails. Requests for the same bitmap share one job; a job is cancelled
 *   (AbortSignal) once every requester has lost interest.
 * - Caches `ImageBitmap`s in a byte-budgeted LRU (`bitmap-cache.ts`).
 * - Never rejects: every public method resolves to an `EngineResult`.
 * - Password-protected files call back into the UI through `setPasswordPrompt`.
 * - Keeps a copy of every open source's original bytes (a Blob, which the browser may page
 *   to disk) because the proxy transfers the buffer to the PDFium worker; export reads it
 *   back with `sourceBytes`. The copy is dropped on `close`.
 * - Page labels and /Lang are read by the assembly worker (`assembler-client.ts`), which
 *   the PDFium worker reaches through this thread as the adapter's inspector.
 *
 * - Clipped repaints (craft spec §5.3 item 9): a change confined to a box (a committed pen
 *   stroke) re-renders only that box, at every cached scale of the page, and composites it
 *   into the cached bitmaps instead of dropping them (`requestClippedRepaint`; the edit path
 *   announces such a change with `noteClippedChange` before its `invalidatePage`).
 *
 * Render timings are recorded in development with `performance.mark`/`measure` only
 * (entries named `render …`, `open …`).
 */
import wasmUrl from '@embedpdf/pdfium/pdfium.wasm?url';
// Vite's `?worker` constructor: the worker script is fetched only when one is constructed.
import AnalysisWorker from '@pdf-editor/engine/analysis.worker?worker';
import PdfiumWorker from '@pdf-editor/engine/pdfium.worker?worker';
import SignatureWorker from '@pdf-editor/engine/signature.worker?worker';
import {
  createRandomIdGenerator,
  type Rect,
  type Rotation,
  type SourceId,
} from '@pdf-editor/document-model';
import type {
  AnalysisProxy,
  decideOverflow,
  EngineCallOptions,
  EngineErrorCode,
  GlyphOutlineSegment,
  layoutParagraph,
  OcrPackStore,
  OcrRecognizer,
  OpenedDocument,
  PdfEditor,
  PdfImageEditor,
  PdfOcrLayer,
  PdfRedactor,
  PdfRenderer,
  PdfTextEditor,
  PdfVerifier,
  ParagraphBlock,
  ParagraphEdit,
  ParagraphEditOptions,
  ParagraphEditResult,
  ParagraphLayoutAnalysis,
  ParagraphPreview,
  ParagraphRef,
  SaveOptions,
  SearchHit,
  SignatureProxy,
  TextRun,
  VerificationExpectation,
  VerificationResult,
} from '@pdf-editor/engine';

import { displayedSize, displayRectToUser, userRectToCss } from '../viewer/geometry';
import { getAssembler } from './assembler-client';

import { BitmapCache, type CachedBitmap, bitmapKey, pageKey } from './bitmap-cache';

export type { CachedBitmap } from './bitmap-cache';

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type EngineFailureCode = EngineErrorCode | 'password-cancelled' | 'read-failed';

export interface EngineFailure {
  readonly code: EngineFailureCode;
  readonly message: string;
}

export type EngineResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: EngineFailure };

const ok = <T>(value: T): EngineResult<T> => ({ ok: true, value });
const fail = <T>(code: EngineFailureCode, message: string): EngineResult<T> => ({
  ok: false,
  error: { code, message },
});

const ENGINE_CODES: readonly string[] = [
  'password-required',
  'password-incorrect',
  'unsupported-encryption',
  'corrupt',
  'unsupported',
  'out-of-memory',
  'aborted',
  'internal',
];

/** Maps anything thrown by an adapter to a typed failure (duck-typed on `code`). */
export function toFailure(error: unknown): EngineFailure {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  if (typeof code === 'string' && ENGINE_CODES.includes(code)) {
    return { code: code as EngineErrorCode, message };
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return { code: 'aborted', message };
  }
  return { code: 'internal', message };
}

// ---------------------------------------------------------------------------
// Render scales
// ---------------------------------------------------------------------------

/*
 * A render scale is device pixels per PDF point; it names a bitmap in the cache
 * (`bitmap-cache.ts`). Two kinds of scale are used:
 *
 * - Exact scales (`chooseScale`) for final Read-mode renders and tiles: the bitmap maps 1:1
 *   onto the page sheet's device pixels, so the browser never resamples PDFium's
 *   anti-aliased glyphs. Rounded to 4 decimals so equal zooms share one cache key.
 * - Quarter-octave buckets (`chooseBucket`, 2^(k/4)) for thumbnails, where a few shared
 *   variants matter more than 1:1 pixels (at most ~19% oversampling, downscaled by CSS).
 *
 * Previews (`EngineService.preview`) take any cached scale, whatever its kind.
 */
const STEPS_PER_OCTAVE = 4;
const MIN_BUCKET = 1 / 64;
const MAX_BUCKET = 16;
/** Largest bitmap we render in one piece (~64 MB). Beyond this, tiles (`TiledPage`) help. */
export const MAX_BITMAP_PIXELS = 4096 * 4096;

function roundScale(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** Smallest bucket >= scale. */
export function scaleBucket(scale: number): number {
  const safe = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const k = Math.ceil(Math.log2(safe) * STEPS_PER_OCTAVE - 1e-9);
  return roundScale(Math.min(MAX_BUCKET, Math.max(MIN_BUCKET, 2 ** (k / STEPS_PER_OCTAVE))));
}

/** Largest bucket <= scale. */
export function scaleBucketBelow(scale: number): number {
  const safe = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const k = Math.floor(Math.log2(safe) * STEPS_PER_OCTAVE + 1e-9);
  return roundScale(Math.min(MAX_BUCKET, Math.max(MIN_BUCKET, 2 ** (k / STEPS_PER_OCTAVE))));
}

/** Largest scale at which a `widthPt` × `heightPt` page stays within `MAX_BITMAP_PIXELS`. */
function maxScaleFor(widthPt: number, heightPt: number): number {
  return Math.sqrt(MAX_BITMAP_PIXELS / Math.max(1, widthPt * heightPt));
}

/**
 * The bucket to render a thumbnail at: at least `scale` (device pixels per point), but
 * never more than `MAX_BITMAP_PIXELS` for a page of `widthPt` × `heightPt`.
 */
export function chooseBucket(scale: number, widthPt: number, heightPt: number): number {
  const wanted = scaleBucket(scale);
  const maxScale = maxScaleFor(widthPt, heightPt);
  return wanted <= maxScale ? wanted : scaleBucketBelow(maxScale);
}

/** Bounds of an exact scale (zoom 500% at DPR 3 is 20); the pixel cap bounds the rest. */
const MAX_EXACT_SCALE = 64;

/** `scale` made finite, clamped and rounded to 4 decimals (a stable cache key). */
export function exactScaleKey(scale: number): number {
  const safe = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return roundScale(Math.min(MAX_EXACT_SCALE, Math.max(MIN_BUCKET, safe)));
}

/**
 * The scale to render a Read-mode page at: exactly `scale` (`exactScaleKey`) so the bitmap
 * is drawn 1:1, or, when that would exceed `MAX_BITMAP_PIXELS`, the largest bucket below
 * the cap (the page is then capped and `TiledPage` covers it with exact-scale tiles).
 */
export function chooseScale(scale: number, widthPt: number, heightPt: number): number {
  const wanted = exactScaleKey(scale);
  const maxScale = maxScaleFor(widthPt, heightPt);
  return wanted <= maxScale ? wanted : scaleBucketBelow(maxScale);
}

/** True when `chooseScale` caps the page below `scale` (so tiles are needed). */
export function isCapped(scale: number, widthPt: number, heightPt: number): boolean {
  return chooseScale(scale, widthPt, heightPt) < exactScaleKey(scale);
}

/**
 * Device pixels per point that make a page `widthPt` wide fill `cssWidth` CSS pixels
 * exactly: the sheet's whole device-pixel width over its width in points.
 */
export function exactScale(cssWidth: number, widthPt: number, dpr: number): number {
  const device = Math.max(1, Math.round(cssWidth * dpr));
  return exactScaleKey(device / Math.max(1e-3, widthPt));
}

/** Side of a bitmap PDFium renders: EmbedPDF sizes it `max(1, round(side × scale))`. */
export function bitmapSide(sidePt: number, scale: number): number {
  return Math.max(1, Math.round(sidePt * scale));
}

/**
 * CSS size of a Read-mode page sheet at `cssScale` (CSS px per point), snapped to whole
 * device pixels and matched to the bitmap `chooseScale(exactScale(…))` renders: the width
 * is the nearest device pixel, the height is what EmbedPDF makes of the page height at
 * that exact scale (`bitmapSide`), so the canvas backing store and the sheet agree pixel
 * for pixel and the canvas is never resampled. The height may therefore be up to about a
 * device pixel off `heightPt × cssScale × dpr` (the aspect ratio follows the snapped width).
 *
 * Exactness limits: the 4-decimal scale moves `widthPt × scale` by at most
 * `widthPt × 5e-5` px (0.03 px for Letter), so widths agree for pages under ~10,000 pt;
 * PDFium reports page sizes as float32, which can flip a side lying on exactly .5 px by one
 * pixel. Either way the bitmap is then stretched by one pixel, as before this snapping.
 * At DPR 1.5 or 3 the browser stores the CSS size in 1/64 px layout units, so it lands
 * within 1/64 CSS px of the device-pixel size and painting snaps it to whole pixels.
 */
export function sheetSize(
  widthPt: number,
  heightPt: number,
  cssScale: number,
  dpr: number,
): { readonly width: number; readonly height: number } {
  const ratio = dpr > 0 && Number.isFinite(dpr) ? dpr : 1;
  const width = Math.max(1, Math.round(widthPt * cssScale * ratio));
  const scale = exactScale(width / ratio, widthPt, ratio);
  return { width: width / ratio, height: bitmapSide(heightPt, scale) / ratio };
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

/** Higher runs first. */
export const RENDER_PRIORITY = { page: 3, visible: 2, offscreen: 1 } as const;

export interface RenderRequest {
  readonly sourceId: SourceId;
  readonly index: number;
  /** Rotation on top of the page's intrinsic /Rotate (VirtualPage.rotation). */
  readonly rotation: Rotation;
  /** Device pixels per point: from `chooseScale` (Read mode) or `chooseBucket` (thumbnails). */
  readonly bucket: number;
  readonly priority: number;
  readonly signal?: AbortSignal;
  /**
   * Render only this rectangle (unrotated user space) — a tile of a page too large to
   * render in one piece. `tile` names it in the cache (e.g. `t1024:2,3`); both or neither.
   */
  readonly clip?: Rect;
  readonly tile?: string;
}

/** Options of `EngineService.search` (PdfRenderer.search). */
export interface SearchOptions {
  readonly matchCase?: boolean;
  readonly wholeWord?: boolean;
}

/** Text runs kept per page by `getPageText` (a small LRU; evicted on close). */
const TEXT_CACHE_PAGES = 400;

interface Subscriber {
  readonly priority: number;
  readonly resolve: (result: EngineResult<CachedBitmap>) => void;
}

interface Job {
  readonly key: string;
  readonly page: string;
  readonly request: RenderRequest;
  readonly controller: AbortController;
  readonly subscribers: Set<Subscriber>;
  readonly seq: number;
  running: boolean;
  /** Set by `close`: the source went away, so a late result must not be cached. */
  sourceClosed: boolean;
  /** Set by `invalidatePage`: the page changed while this job ran; its result is stale. */
  stale: boolean;
}

/** What a clipped repaint needs of a page: its unrotated CropBox size, /Rotate and origin. */
interface PageShape {
  readonly size: { readonly width: number; readonly height: number };
  readonly rotation: Rotation;
  readonly originX: number;
  readonly originY: number;
}

/** A bitmap the service cached, as it was requested (for clipped repaints). */
interface RenderedEntry {
  readonly key: string;
  /** The cache's page identity (`BitmapCache.set`). */
  readonly page: string;
  readonly rotation: Rotation;
  readonly bucket: number;
  readonly clip?: Rect;
  readonly tile?: string;
}

/** Whole-page bitmaps of one page a clipped repaint patches (the most recent); older go. */
export const MAX_CLIPPED_REPAINTS = 4;

/**
 * Where a clipped repaint of `rect` (user space) lands in a cached page bitmap of
 * `width` × `height` px rendered with `rotation` on top of the page's /Rotate: the box in
 * whole bitmap pixels that covers it, and the user-space clip that renders exactly that box.
 * Undefined when the rect misses the page.
 */
export function clippedRepaintBox(
  shape: PageShape,
  rotation: Rotation,
  rect: Rect,
  width: number,
  height: number,
): { left: number; top: number; width: number; height: number; clip: Rect } | undefined {
  const frame = {
    size: shape.size,
    originX: shape.originX,
    originY: shape.originY,
    rotation: ((shape.rotation + rotation) % 360) as Rotation,
    scale: 1,
  };
  const shown = displayedSize(frame);
  if (!(shown.width > 0 && shown.height > 0 && width > 0 && height > 0)) return undefined;
  // The bitmap's own pixels per point on each axis (EmbedPDF rounds its size).
  const sx = width / shown.width;
  const sy = height / shown.height;
  const box = userRectToCss(frame, rect);
  const left = Math.max(0, Math.floor(box.left * sx));
  const top = Math.max(0, Math.floor(box.top * sy));
  const right = Math.min(width, Math.ceil((box.left + box.width) * sx));
  const bottom = Math.min(height, Math.ceil((box.top + box.height) * sy));
  if (right <= left || bottom <= top) return undefined;
  const clip = displayRectToUser(frame, {
    left: left / sx,
    top: top / sy,
    width: (right - left) / sx,
    height: (bottom - top) / sy,
  });
  return { left, top, width: right - left, height: bottom - top, clip };
}

function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function unionRect(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

export type PasswordPrompt = (request: {
  readonly fileName: string;
  /** True when a password was already tried and rejected. */
  readonly incorrect: boolean;
}) => Promise<string | null>;

export interface OpenedSource {
  readonly id: SourceId;
  readonly name: string;
  readonly byteLength: number;
  readonly lastModified: number;
  readonly document: OpenedDocument;
}

/** The adapter surface the service needs; tests pass a mock. */
function isEditor(engine: RendererLike): engine is RendererLike & PdfEditor {
  return typeof (engine as Partial<PdfEditor>).createAnnotation === 'function';
}

function isTextEditor(engine: RendererLike): engine is RendererLike & PdfTextEditor {
  const candidate = engine as Partial<PdfTextEditor>;
  return (
    typeof candidate.locateRuns === 'function' &&
    typeof candidate.checkEditability === 'function' &&
    typeof candidate.applyTextEdit === 'function'
  );
}

function isImageEditor(engine: RendererLike): engine is RendererLike & PdfImageEditor {
  const candidate = engine as Partial<PdfImageEditor>;
  return (
    typeof candidate.locateImages === 'function' &&
    typeof candidate.extractImage === 'function' &&
    typeof candidate.transformImage === 'function' &&
    typeof candidate.removeImage === 'function' &&
    typeof candidate.replaceImage === 'function'
  );
}

export type RendererLike = Pick<PdfRenderer, 'open' | 'close' | 'renderPage' | 'getPageText'> &
  Partial<Pick<PdfRenderer, 'search'>> &
  Partial<Pick<PdfEditor, 'save'>> &
  Partial<PdfVerifier> & {
    destroy?: () => Promise<void>;
  };

export interface EngineServiceOptions {
  /** Called once, on first use; may load the adapter lazily. */
  readonly createRenderer: () => RendererLike | Promise<RendererLike>;
  readonly cacheBudgetBytes?: number;
  /** Render jobs in flight at once. PDFium has one worker; 2 keeps it busy. */
  readonly concurrency?: number;
  readonly newSourceId?: () => SourceId;
  /** Record `performance` marks for renders (defaults to dev builds). */
  readonly timings?: boolean;
}

export class EngineService {
  private renderer: Promise<RendererLike> | undefined;
  private readonly createRenderer: () => RendererLike | Promise<RendererLike>;
  private readonly cache: BitmapCache;
  private readonly concurrency: number;
  private readonly newSourceId: () => SourceId;
  private readonly timings: boolean;
  private readonly jobs = new Map<string, Job>();
  /** Original bytes of every open source (see the module comment). */
  private readonly retained = new Map<SourceId, Blob>();
  /** The password that opened an encrypted source (diagnostics read the original bytes). */
  private readonly passwords = new Map<SourceId, string>();
  /** Memoized text runs per `${sourceId}:${index}` (insertion order = LRU order). */
  private readonly texts = new Map<string, Promise<EngineResult<readonly TextRun[]>>>();
  /** CropBox per page of every open source, when the engine reports it. */
  private readonly cropBoxes = new Map<SourceId, readonly (Rect | undefined)[]>();
  private running = 0;
  private seq = 0;
  private passwordPrompt: PasswordPrompt | undefined;
  /** Content revision per `${sourceId}:${index}`, bumped by `invalidatePage`. */
  private readonly revisions = new Map<string, number>();
  private readonly revisionListeners = new Set<() => void>();
  private readonly closeListeners = new Set<(sourceId: SourceId) => void>();
  /** Per `${sourceId}:${index}`: the box the next `invalidatePage` changes (`noteClippedChange`). */
  private readonly clipNotes = new Map<string, Rect>();
  /** Per `${sourceId}:${index}`: the bitmaps this service cached for it, oldest first. */
  private readonly rendered = new Map<string, Map<string, RenderedEntry>>();
  /** Per `${sourceId}:${index}`: the clipped repaint running (one page's run in order). */
  private readonly repaints = new Map<string, Promise<void>>();
  /** Cache keys being repainted: `peek` misses them and `renderPage` waits for them. */
  private readonly repainting = new Map<string, Promise<void>>();
  /** Per `${sourceId}:${index}`: bumped by a full `invalidatePage` (a repaint then stops). */
  private readonly generations = new Map<string, number>();
  /** Page shapes of every open source (clipped repaints map user space to bitmap pixels). */
  private readonly shapes = new Map<SourceId, readonly PageShape[]>();

  constructor(options: EngineServiceOptions) {
    this.createRenderer = options.createRenderer;
    this.cache = new BitmapCache(options.cacheBudgetBytes);
    this.concurrency = Math.max(1, options.concurrency ?? 2);
    const ids = createRandomIdGenerator();
    this.newSourceId = options.newSourceId ?? (() => ids.source());
    this.timings =
      options.timings ?? (import.meta.env.DEV && typeof performance.mark === 'function');
  }

  /** The adapter, created on first use. A failed creation is retried on the next call. */
  private engine(): Promise<RendererLike> {
    if (this.renderer === undefined) {
      const created = Promise.resolve().then(() => this.createRenderer());
      created.catch(() => {
        if (this.renderer === created) this.renderer = undefined;
      });
      this.renderer = created;
    }
    return this.renderer;
  }

  /**
   * The content editor (annotations, forms, redaction) behind the same adapter. Features
   * that edit sources go through this rather than reaching for the adapter directly, so
   * the service keeps a single instance and one lifecycle.
   */
  async editor(): Promise<PdfEditor> {
    const engine = await this.engine();
    if (!isEditor(engine)) throw new Error('The rendering engine has no content editor');
    return engine;
  }

  /**
   * The text editor (M4, spec redaction-and-text-editing §2) behind the same adapter: the
   * PDFium worker's `PdfTextEditor`, reached through the proxy. Text edits that change the
   * document go through the edit runner (annotations/edit-runner.ts); this accessor is for
   * locating runs and checking editability.
   */
  async textEditor(): Promise<PdfTextEditor> {
    const engine = await this.engine();
    if (!isTextEditor(engine)) throw new Error('The rendering engine has no text editor');
    return engine;
  }

  // -------------------------------------------------------------------------
  // Paragraph editing (craft spec §4, ADR-0020): the worker's `PdfParagraphEditor`. Reads
  // run at the lower raw-task priority; a committed edit goes through the edit runner
  // (`text.editParagraph`, text-edit/actions.ts), the dry run and its preview come here.
  // -------------------------------------------------------------------------

  /** The page's detected paragraphs (cached by the engine per page state). */
  async analyzeParagraphs(
    source: SourceId,
    pageIndex: number,
    options?: EngineCallOptions,
  ): Promise<readonly ParagraphBlock[]> {
    return (await this.textEditor()).analyzeParagraphs(source, pageIndex, options);
  }

  /** What the editor lays keystrokes out with: the layout input, overflow facts, styles. */
  async analyzeParagraphLayout(
    ref: ParagraphRef,
    options?: EngineCallOptions,
  ): Promise<ParagraphLayoutAnalysis> {
    return (await this.textEditor()).analyzeParagraphLayout(ref, options);
  }

  /** Em-unit outlines of `chars` in the page's font `fontId` (the editor's canvas). */
  async glyphPaths(
    source: SourceId,
    pageIndex: number,
    fontId: number,
    chars: readonly string[],
    options?: EngineCallOptions,
  ): Promise<Readonly<Record<string, readonly GlyphOutlineSegment[] | null>>> {
    return (await this.textEditor()).glyphPaths(source, pageIndex, fontId, chars, options);
  }

  /** A dry run (`commit: false`) of a paragraph edit; commits go through the edit runner. */
  async applyParagraphEdit(
    source: SourceId,
    pageIndex: number,
    edit: ParagraphEdit,
    options: ParagraphEditOptions,
  ): Promise<ParagraphEditResult> {
    return (await this.textEditor()).applyParagraphEdit(source, pageIndex, edit, options);
  }

  /** The dry run's paragraph area rendered at `scale` (device pixels per point). */
  async renderParagraphPreview(
    source: SourceId,
    pageIndex: number,
    edit: ParagraphEdit,
    scale: number,
    options?: EngineCallOptions,
  ): Promise<ParagraphPreview> {
    return (await this.textEditor()).renderParagraphPreview(
      source,
      pageIndex,
      edit,
      scale,
      options,
    );
  }

  /**
   * The pure paragraph layout (`layoutParagraph`, `decideOverflow`) for the main thread: the
   * editor re-lays the paragraph on every keystroke without a worker round trip (spec §4.8).
   * Loaded with the engine chunk.
   */
  async paragraphLayout(): Promise<{
    readonly layoutParagraph: typeof layoutParagraph;
    readonly decideOverflow: typeof decideOverflow;
  }> {
    const engine = await import('@pdf-editor/engine');
    return { layoutParagraph: engine.layoutParagraph, decideOverflow: engine.decideOverflow };
  }

  /**
   * The image-object editor (M4 §3) behind the same adapter: the PDFium worker's
   * `PdfImageEditor`, reached through the proxy. Image edits that change the document go
   * through the edit runner (`image.*` edits, image-objects/actions.ts); this accessor is for
   * locating and extracting images.
   */
  async imageEditor(): Promise<PdfImageEditor> {
    const engine = await this.engine();
    if (!isImageEditor(engine)) throw new Error('The rendering engine has no image editor');
    return engine;
  }

  /**
   * Redaction in the PDFium worker (`PdfRedactor`, ADR-0011 §3). Applying goes through the
   * edit runner (`redaction.apply` edits, redaction/apply.ts); the export uses this for its
   * self-check on the final bytes (`verifyRedactedOutput`).
   */
  async redactor(): Promise<PdfRedactor> {
    const engine = await this.engine();
    const candidate = engine as Partial<PdfRedactor>;
    if (
      typeof candidate.applyRedactionPlan !== 'function' ||
      typeof candidate.verifyRedactedOutput !== 'function'
    ) {
      throw new Error('The rendering engine cannot redact');
    }
    return engine as RendererLike & PdfRedactor;
  }

  /**
   * OCR in the PDFium worker (`PdfOcrLayer`, spec recognize-and-compare §1.2, §1.4): page
   * facts and greyscale rasters for the recognizer. Writing the layer goes through the edit
   * runner (`ocr.apply` edits, ocr/ocr-run.ts).
   */
  async ocrLayer(): Promise<PdfOcrLayer> {
    const engine = await this.engine();
    const candidate = engine as Partial<PdfOcrLayer>;
    if (
      typeof candidate.ocrPageFacts !== 'function' ||
      typeof candidate.renderForOcr !== 'function' ||
      typeof candidate.applyOcrLayer !== 'function'
    ) {
      throw new Error('The rendering engine cannot recognize text');
    }
    return engine as RendererLike & PdfOcrLayer;
  }

  /** The UI registers how to ask for a password; without one, locked files fail. */
  setPasswordPrompt(prompt: PasswordPrompt | undefined): void {
    this.passwordPrompt = prompt;
  }

  // -------------------------------------------------------------------------
  // Documents
  // -------------------------------------------------------------------------

  /**
   * Opens a file. On `password-required` / `password-incorrect` it asks the registered
   * prompt (again after a wrong password) until the file opens or the user cancels.
   */
  async open(file: File, password?: string): Promise<EngineResult<OpenedSource>> {
    const id = this.newSourceId();
    let attempt = password;
    let tries = 0;
    for (;;) {
      let bytes: ArrayBuffer;
      try {
        // Read per attempt: the adapter transfers the buffer to its worker.
        bytes = await file.arrayBuffer();
      } catch (error) {
        return fail('read-failed', `Could not read ${file.name}: ${toFailure(error).message}`);
      }
      const started = this.mark(`open-start:${id}`);
      // Copy before the adapter detaches the buffer.
      const retained = new Blob([bytes], { type: 'application/pdf' });
      try {
        const document = await (await this.engine()).open(
          id,
          bytes,
          attempt === undefined ? {} : { password: attempt },
        );
        this.retained.set(id, retained);
        if (attempt !== undefined) this.passwords.set(id, attempt);
        this.cropBoxes.set(id, readCropBoxes(document));
        this.shapes.set(id, readShapes(document));
        this.measure(`open ${file.name}`, started);
        return ok({
          id,
          name: file.name,
          byteLength: file.size,
          lastModified: file.lastModified,
          document,
        });
      } catch (error) {
        const failure = toFailure(error);
        const locked =
          failure.code === 'password-required' || failure.code === 'password-incorrect';
        if (!locked || this.passwordPrompt === undefined) return { ok: false, error: failure };
        let answer: string | null;
        try {
          answer = await this.passwordPrompt({ fileName: file.name, incorrect: tries > 0 });
        } catch {
          answer = null;
        }
        if (answer === null) {
          return fail('password-cancelled', `${file.name} needs a password; skipped`);
        }
        attempt = answer;
        tries += 1;
      }
    }
  }

  /** Closes a source in the engine and drops its cached bitmaps and pending renders. */
  async close(sourceId: SourceId): Promise<EngineResult<void>> {
    const prefix = `${sourceId}:`;
    for (const job of [...this.jobs.values()]) {
      if (!job.key.startsWith(prefix)) continue;
      job.sourceClosed = true;
      this.cancel(job, 'Source closed');
    }
    this.cache.removeSource(sourceId);
    this.retained.delete(sourceId);
    this.passwords.delete(sourceId);
    this.cropBoxes.delete(sourceId);
    this.shapes.delete(sourceId);
    this.forgetRendered(prefix);
    for (const key of [...this.texts.keys()]) {
      if (key.startsWith(prefix)) this.texts.delete(key);
    }
    for (const key of [...this.revisions.keys()]) {
      if (key.startsWith(prefix)) this.revisions.delete(key);
    }
    for (const listener of this.closeListeners) listener(sourceId);
    if (this.renderer === undefined) return ok(undefined);
    try {
      await (await this.renderer).close(sourceId);
      return ok(undefined);
    } catch (error) {
      return { ok: false, error: toFailure(error) };
    }
  }

  /**
   * Opens a source's original bytes again in the engine, under the same id, dropping every
   * engine edit made to it (undo of edits without an inverse, such as text edits: spec
   * redaction-and-text-editing §2.5). Cached bitmaps and text of the source are dropped,
   * renders in flight are discarded and every page's revision bumps, so mounted views
   * render again. Close listeners are not called: the source stays open. The caller replays
   * the edits that should remain.
   */
  async reopenSource(sourceId: SourceId): Promise<EngineResult<void>> {
    const blob = this.retained.get(sourceId);
    if (blob === undefined) return fail('internal', `Source ${sourceId} is not open`);
    let bytes: ArrayBuffer;
    try {
      bytes = await blob.arrayBuffer();
    } catch (error) {
      return fail('read-failed', `Could not read the kept copy: ${toFailure(error).message}`);
    }
    const password = this.passwords.get(sourceId);
    const prefix = `${sourceId}:`;
    try {
      const engine = await this.engine();
      await engine.close(sourceId);
      await engine.open(sourceId, bytes, password === undefined ? {} : { password });
    } catch (error) {
      return { ok: false, error: toFailure(error) };
    } finally {
      for (const job of [...this.jobs.values()]) {
        if (!job.key.startsWith(prefix)) continue;
        if (!job.running) {
          this.cancel(job, 'Source reopened');
          continue;
        }
        job.stale = true;
        if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
      }
      this.cache.removeSource(sourceId);
      this.forgetRendered(prefix);
      for (const key of [...this.texts.keys()]) {
        if (key.startsWith(prefix)) this.texts.delete(key);
      }
      const pages = this.cropBoxes.get(sourceId)?.length ?? 0;
      for (let index = 0; index < pages; index++) {
        const key = `${sourceId}:${index}`;
        this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
      }
      for (let index = 0; index < pages; index++) {
        const key = `${sourceId}:${index}`;
        this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1);
      }
      for (const listener of this.revisionListeners) listener();
    }
    return ok(undefined);
  }

  /** The password a source was opened with, if one was needed (kept in memory only). */
  sourcePassword(sourceId: SourceId): string | undefined {
    return this.passwords.get(sourceId);
  }

  /** A fresh copy of a source's original bytes (the caller may transfer it). */
  async sourceBytes(sourceId: SourceId): Promise<EngineResult<ArrayBuffer>> {
    const blob = this.retained.get(sourceId);
    if (blob === undefined) return fail('internal', `Source ${sourceId} is not open`);
    try {
      return ok(await blob.arrayBuffer());
    } catch (error) {
      return fail('read-failed', `Could not read the kept copy: ${toFailure(error).message}`);
    }
  }

  /** Serializes a source through the engine (edits applied, e.g. decrypted). */
  async saveSource(
    sourceId: SourceId,
    options: SaveOptions = {},
  ): Promise<EngineResult<ArrayBuffer>> {
    try {
      const engine = await this.engine();
      if (!engine.save) return fail('unsupported', 'The engine cannot save sources');
      return ok(await engine.save(sourceId, options));
    } catch (error) {
      return { ok: false, error: toFailure(error) };
    }
  }

  /** Re-opens `bytes` in PDFium and checks them against `expectation` (export step 5). */
  async verify(
    bytes: ArrayBuffer,
    expectation: VerificationExpectation,
    signal?: AbortSignal,
  ): Promise<EngineResult<VerificationResult>> {
    try {
      const engine = await this.engine();
      if (!engine.verify) return fail('unsupported', 'The engine cannot verify output');
      return ok(await engine.verify(bytes, expectation, signal === undefined ? {} : { signal }));
    } catch (error) {
      return { ok: false, error: toFailure(error) };
    }
  }

  /**
   * Text runs of a page, memoized per source page (dropped by `invalidatePageText` after a
   * text edit, and by `reopenSource`).
   * `signal` only abandons this caller's wait: the extraction still completes and is kept
   * for the next request. Failures are not cached.
   */
  getPageText(
    sourceId: SourceId,
    index: number,
    signal?: AbortSignal,
  ): Promise<EngineResult<readonly TextRun[]>> {
    const key = `${sourceId}:${index}`;
    let pending = this.texts.get(key);
    if (pending === undefined) {
      pending = this.extractText(sourceId, index);
      const stored = pending;
      this.texts.set(key, stored);
      void stored.then((result) => {
        if (!result.ok && this.texts.get(key) === stored) this.texts.delete(key);
      });
      while (this.texts.size > TEXT_CACHE_PAGES) {
        const oldest = this.texts.keys().next().value;
        if (oldest === undefined) break;
        this.texts.delete(oldest);
      }
    } else {
      // Mark recently used.
      this.texts.delete(key);
      this.texts.set(key, pending);
    }
    if (signal === undefined) return pending;
    if (signal.aborted) return Promise.resolve(fail('aborted', 'Text request aborted'));
    const shared = pending;
    return new Promise((resolve) => {
      const onAbort = () => resolve(fail('aborted', 'Text request aborted'));
      signal.addEventListener('abort', onAbort, { once: true });
      void shared.then((result) => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      });
    });
  }

  private async extractText(
    sourceId: SourceId,
    index: number,
  ): Promise<EngineResult<readonly TextRun[]>> {
    try {
      return ok(await (await this.engine()).getPageText(sourceId, index));
    } catch (error) {
      return { ok: false, error: toFailure(error) };
    }
  }

  /**
   * The CropBox of a source page in unrotated user space, when the engine reports it
   * (`OpenedDocument.pages[i].cropBox`). Engine geometry (glyphs, hits, links, `clip`) is
   * absolute user space, so viewers subtract its lower-left corner; undefined means (0, 0).
   */
  pageCropBox(sourceId: SourceId, index: number): Rect | undefined {
    return this.cropBoxes.get(sourceId)?.[index];
  }

  /**
   * Searches one source in the engine worker. `onHits` receives hits as the engine reports
   * them page by page (when it streams); the resolved value is always the complete list.
   */
  async search(
    sourceId: SourceId,
    query: string,
    options: SearchOptions = {},
    signal?: AbortSignal,
    onHits?: (hits: readonly SearchHit[]) => void,
  ): Promise<EngineResult<readonly SearchHit[]>> {
    try {
      const engine = await this.engine();
      if (!engine.search) return fail('unsupported', 'The engine cannot search');
      if (signal?.aborted) return fail('aborted', 'Search aborted');
      const callOptions: Parameters<PdfRenderer['search']>[2] = {
        ...(options.matchCase ? { matchCase: true } : {}),
        ...(options.wholeWord ? { wholeWord: true } : {}),
        ...(signal === undefined ? {} : { signal }),
        ...(onHits === undefined ? {} : { onProgress: (hits) => onHits(hits) }),
      };
      const hits = await engine.search(sourceId, query, callOptions);
      if (signal?.aborted) return fail('aborted', 'Search aborted');
      return ok(hits);
    } catch (error) {
      return { ok: false, error: toFailure(error) };
    }
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  /**
   * Drops every cached bitmap of one source page (all rotations and scales) after its
   * content changed in the engine (an annotation edit), discards renders in flight for it,
   * and bumps the page's revision so mounted canvases request a fresh render.
   */
  invalidatePage(sourceId: SourceId, index: number): void {
    const noted = this.clipNotes.get(`${sourceId}:${index}`);
    if (noted !== undefined) {
      this.clipNotes.delete(`${sourceId}:${index}`);
      this.requestClippedRepaint(sourceId, index, noted);
      return;
    }
    const prefix = `${sourceId}:${index}:`;
    this.generations.set(
      `${sourceId}:${index}`,
      (this.generations.get(`${sourceId}:${index}`) ?? 0) + 1,
    );
    this.forgetRendered(prefix);
    this.cache.removePrefix(prefix);
    for (const job of [...this.jobs.values()]) {
      if (!job.key.startsWith(prefix)) continue;
      if (!job.running) {
        // Not started: nothing to wait for. Its requesters resolve as aborted and ask again
        // (PageCanvas re-requests on the revision change below).
        this.cancel(job, 'Page changed');
        continue;
      }
      // Running: let it finish (PDFium cannot stop mid-page) but never cache or share its
      // result; new requests start a fresh job.
      job.stale = true;
      if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
    }
    const key = `${sourceId}:${index}`;
    this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1);
    for (const listener of this.revisionListeners) listener();
  }

  /**
   * Announces that the next `invalidatePage` of this page changes only `rect` (user space,
   * with the stroke's width and anti-aliasing margin): that invalidation then repaints the
   * rect into the cached bitmaps (`requestClippedRepaint`) instead of dropping them. Notes on
   * one page before its invalidation are united. The pen burst append notes the new path's box
   * right after its engine edit (craft spec §5.3 item 9).
   */
  noteClippedChange(sourceId: SourceId, index: number, rect: Rect): void {
    const key = `${sourceId}:${index}`;
    const previous = this.clipNotes.get(key);
    this.clipNotes.set(key, previous === undefined ? rect : unionRect(previous, rect));
  }

  /**
   * Repaints only `rectInPage` (user space) of a page whose content changed inside it, at
   * every scale the cache holds: each of the page's most recent whole-page bitmaps (at most
   * `MAX_CLIPPED_REPAINTS`) gets the rect rendered through `renderPage` with `clip`, aligned to
   * its pixels, and composited into a new bitmap in its place; tiles the rect touches are
   * dropped and render again; untouched tiles stay. Renders of the page in flight are
   * discarded (they began before the change). The page's revision bumps at once, as with
   * `invalidatePage`; until a bitmap is patched, `peek` misses it and `renderPage` waits for
   * it, so a view never shows the old pixels as the new revision. Repaints of one page run in
   * order. Full re-renders stay for zoom (another scale) and for every other edit.
   */
  requestClippedRepaint(sourceId: SourceId, index: number, rectInPage: Rect): void {
    const pageId = `${sourceId}:${index}`;
    const prefix = `${pageId}:`;
    for (const job of [...this.jobs.values()]) {
      if (!job.key.startsWith(prefix) || !job.running) continue;
      job.stale = true;
      if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
    }
    const tracked = this.rendered.get(pageId);
    const pages: RenderedEntry[] = [];
    for (const [key, entry] of tracked ?? []) {
      if (!this.cache.has(key)) {
        tracked?.delete(key);
      } else if (entry.tile === undefined) {
        pages.push(entry);
      } else if (entry.clip === undefined || intersects(entry.clip, rectInPage)) {
        tracked?.delete(key);
        this.cache.remove(key);
      }
    }
    // The most recent scales are patched; older ones go (a full render if shown again).
    const patched = pages.slice(-MAX_CLIPPED_REPAINTS).reverse();
    for (const entry of pages.slice(0, -MAX_CLIPPED_REPAINTS)) {
      tracked?.delete(entry.key);
      this.cache.remove(entry.key);
    }
    const generation = this.generations.get(pageId) ?? 0;
    // The revision this change makes: each patched bitmap is labelled with it.
    const revision = (this.revisions.get(pageId) ?? 0) + 1;
    const waits = patched.map((entry) => {
      let done: (() => void) | undefined;
      const wait = new Promise<void>((resolve) => {
        done = resolve;
      });
      this.repainting.set(entry.key, wait);
      return { entry, wait, done: () => done?.() };
    });
    const run = (this.repaints.get(pageId) ?? Promise.resolve()).then(async () => {
      for (const { entry, wait, done } of waits) {
        try {
          if ((this.generations.get(pageId) ?? 0) === generation) {
            await this.patchBitmap(sourceId, index, entry, rectInPage, generation, revision);
          }
        } finally {
          if (this.repainting.get(entry.key) === wait) this.repainting.delete(entry.key);
          done();
        }
      }
    });
    this.repaints.set(pageId, run);
    void run.finally(() => {
      if (this.repaints.get(pageId) === run) this.repaints.delete(pageId);
    });
    this.revisions.set(pageId, revision);
    for (const listener of this.revisionListeners) listener();
  }

  /**
   * Renders `rect` of one cached bitmap's page at its scale and composites it in its place,
   * labelled with `revision` (the revision of the change it paints).
   */
  private async patchBitmap(
    sourceId: SourceId,
    index: number,
    entry: RenderedEntry,
    rect: Rect,
    generation: number,
    revision: number,
  ): Promise<void> {
    const pageId = `${sourceId}:${index}`;
    const base = this.cache.get(entry.key);
    const shape = this.shapes.get(sourceId)?.[index];
    if (base === undefined || base.bitmap.width === 0) return;
    const box =
      shape === undefined
        ? undefined
        : clippedRepaintBox(shape, entry.rotation, rect, base.width, base.height);
    if (box === undefined) {
      // Nothing of the page's shape is known: render it again whole. The rect misses the
      // page: the bitmap already shows the new revision.
      if (shape === undefined) this.cache.remove(entry.key);
      else this.cache.retag(entry.key, revision);
      return;
    }
    const started = this.mark(`render-start:${entry.key}#clip`);
    let piece: ImageBitmap | undefined;
    try {
      piece = (
        await (
          await this.engine()
        ).renderPage(sourceId, index, {
          scale: entry.bucket,
          rotation: entry.rotation,
          clip: box.clip,
        })
      ).bitmap;
      // The page changed again meanwhile (another edit, a close), or a newer render replaced
      // the bitmap: nothing to patch.
      if (
        this.cache.get(entry.key) !== base ||
        (this.generations.get(pageId) ?? 0) !== generation
      ) {
        return;
      }
      const canvas = new OffscreenCanvas(base.width, base.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('No 2D canvas for a clipped repaint');
      ctx.drawImage(base.bitmap, 0, 0);
      ctx.clearRect(box.left, box.top, box.width, box.height);
      ctx.drawImage(piece, box.left, box.top, box.width, box.height);
      this.cache.set(entry.page, { ...base, bitmap: canvas.transferToImageBitmap(), revision });
      this.measure(`render ${entry.key}#clip`, started);
    } catch {
      // A failed piece: the bitmap goes, and the page renders again whole when shown.
      if (this.cache.get(entry.key) === base) this.cache.remove(entry.key);
    } finally {
      piece?.close();
    }
  }

  /** Forgets the bitmaps tracked for clipped repaints under `prefix` (`${source}:` or a page). */
  private forgetRendered(prefix: string): void {
    for (const pageId of [...this.rendered.keys()]) {
      if (`${pageId}:`.startsWith(prefix)) this.rendered.delete(pageId);
    }
    for (const pageId of [...this.clipNotes.keys()]) {
      if (`${pageId}:`.startsWith(prefix)) this.clipNotes.delete(pageId);
    }
  }

  /**
   * Drops the memoized text of one source page after its text changed in the engine (a
   * text edit). Call before `invalidatePage`, whose revision bump makes views read again.
   */
  invalidatePageText(sourceId: SourceId, index: number): void {
    this.texts.delete(`${sourceId}:${index}`);
  }

  /** Content revision of a source page; changes whenever `invalidatePage` runs for it. */
  pageRevision(sourceId: SourceId, index: number): number {
    return this.revisions.get(`${sourceId}:${index}`) ?? 0;
  }

  /**
   * Subscribes to source closes, so features that cache per-source data (annotations,
   * links, edit logs) can drop it. Returns an unsubscribe function.
   */
  onSourceClosed(listener: (sourceId: SourceId) => void): () => void {
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }

  /** Subscribes to page revision changes (for `useSyncExternalStore`). */
  subscribeRevisions = (listener: () => void): (() => void) => {
    this.revisionListeners.add(listener);
    return () => {
      this.revisionListeners.delete(listener);
    };
  };

  /** A cached bitmap at exactly this scale, if any (marks it recently used). */
  peek(sourceId: SourceId, index: number, rotation: Rotation, bucket: number) {
    const key = bitmapKey(sourceId, index, rotation, bucket);
    // Being repainted (`requestClippedRepaint`): the bitmap still shows the old content.
    if (this.repainting.has(key)) return undefined;
    return this.cache.get(key);
  }

  /**
   * The best cached bitmap of a page at or below `bucket` (or above, if nothing below),
   * whether it was rendered at an exact scale or a bucket. Bitmaps being repainted
   * (`requestClippedRepaint`) are passed over, as in `peek`: they still show the content of
   * an older revision. Whatever is returned shows the content of its own `revision`.
   */
  preview(
    sourceId: SourceId,
    index: number,
    rotation: Rotation,
    bucket: number,
  ): CachedBitmap | undefined {
    return this.cache.best(pageKey(sourceId, index, rotation), bucket, true, (key) =>
      this.repainting.has(key),
    );
  }

  get cacheStats(): { readonly entries: number; readonly bytes: number; readonly budget: number } {
    return {
      entries: this.cache.size,
      bytes: this.cache.usedBytes,
      budget: this.cache.budgetBytes,
    };
  }

  /** Jobs queued or running; for tests and diagnostics. */
  get pendingJobs(): number {
    return this.jobs.size;
  }

  renderPage(request: RenderRequest): Promise<EngineResult<CachedBitmap>> {
    const { sourceId, index, rotation, bucket, signal } = request;
    const key = tileAwareKey(pageKey(sourceId, index, rotation), request.tile, bucket);
    const repainting = this.repainting.get(key);
    if (repainting !== undefined) return repainting.then(() => this.renderPage(request));
    const hit = this.cache.get(key);
    if (hit !== undefined) return Promise.resolve(ok(hit));
    if (signal?.aborted) return Promise.resolve(fail('aborted', 'Render aborted'));

    return new Promise((resolve) => {
      let job = this.jobs.get(key);
      if (job === undefined) {
        job = {
          key,
          page: tileAwarePage(pageKey(sourceId, index, rotation), request.tile),
          request,
          controller: new AbortController(),
          subscribers: new Set(),
          seq: this.seq++,
          running: false,
          sourceClosed: false,
          stale: false,
        };
        this.jobs.set(key, job);
      }
      const subscriber: Subscriber = { priority: request.priority, resolve };
      job.subscribers.add(subscriber);
      const current = job;
      signal?.addEventListener(
        'abort',
        () => {
          if (!current.subscribers.delete(subscriber)) return;
          resolve(fail('aborted', 'Render aborted'));
          if (current.subscribers.size === 0) this.cancel(current, 'No longer needed');
        },
        { once: true },
      );
      this.pump();
    });
  }

  private priorityOf(job: Job): number {
    let max = -Infinity;
    for (const s of job.subscribers) max = Math.max(max, s.priority);
    return max;
  }

  private cancel(job: Job, reason: string): void {
    if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
    job.controller.abort(new DOMException(reason, 'AbortError'));
    for (const s of job.subscribers) s.resolve(fail('aborted', reason));
    job.subscribers.clear();
  }

  private next(): Job | undefined {
    let best: Job | undefined;
    let bestPriority = -Infinity;
    for (const job of this.jobs.values()) {
      if (job.running) continue;
      const priority = this.priorityOf(job);
      if (priority > bestPriority || (priority === bestPriority && best && job.seq < best.seq)) {
        best = job;
        bestPriority = priority;
      }
    }
    return best;
  }

  private pump(): void {
    while (this.running < this.concurrency) {
      const job = this.next();
      if (job === undefined) return;
      job.running = true;
      this.running += 1;
      void this.run(job).finally(() => {
        this.running -= 1;
        this.pump();
      });
    }
  }

  private async run(job: Job): Promise<void> {
    const { sourceId, index, rotation, bucket, clip } = job.request;
    const started = this.mark(`render-start:${job.key}`);
    // The content this render shows: any change after this point marks the job stale
    // (`invalidatePage`, `requestClippedRepaint`), and a stale result is never handed out.
    const revision = this.pageRevision(sourceId, index);
    let result: EngineResult<CachedBitmap>;
    try {
      const rendered = await (await this.engine()).renderPage(sourceId, index, {
        scale: bucket,
        rotation,
        signal: job.controller.signal,
        ...(clip === undefined ? {} : { clip }),
      });
      const entry: CachedBitmap = {
        key: job.key,
        bitmap: rendered.bitmap,
        width: rendered.width,
        height: rendered.height,
        bucket,
        revision,
      };
      if (job.sourceClosed || job.stale) {
        // The source was closed while PDFium rendered (the adapter finished before it saw
        // the abort), or the page changed meanwhile: nothing may be cached for it, or the
        // bitmap would outlive the source or show old content.
        rendered.bitmap.close();
        result = fail('aborted', job.stale ? 'Page changed' : 'Source closed');
      } else {
        // Cache even when nobody waits any more: scrolling back is common.
        this.cache.set(job.page, entry);
        this.track(job, entry);
        this.measure(`render ${job.key}`, started);
        result = ok(entry);
      }
    } catch (error) {
      result = { ok: false, error: toFailure(error) };
    }
    if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
    for (const s of job.subscribers) s.resolve(result);
    job.subscribers.clear();
  }

  /** Remembers a cached bitmap for clipped repaints of its page (most recent last). */
  private track(job: Job, entry: CachedBitmap): void {
    const { sourceId, index, rotation, bucket, clip, tile } = job.request;
    const pageId = `${sourceId}:${index}`;
    const list = this.rendered.get(pageId) ?? new Map<string, RenderedEntry>();
    list.delete(entry.key);
    list.set(entry.key, {
      key: entry.key,
      page: job.page,
      rotation,
      bucket,
      ...(clip === undefined ? {} : { clip }),
      ...(tile === undefined ? {} : { tile }),
    });
    this.rendered.set(pageId, list);
  }

  // -------------------------------------------------------------------------
  // Dev timings
  // -------------------------------------------------------------------------

  private mark(name: string): string | undefined {
    if (!this.timings) return undefined;
    try {
      performance.mark(name);
      return name;
    } catch {
      return undefined;
    }
  }

  private measure(name: string, startMark: string | undefined): void {
    if (startMark === undefined) return;
    try {
      performance.measure(name, startMark);
      performance.clearMarks(startMark);
    } catch {
      // Timing is best effort.
    }
  }

  /** Terminates the worker and drops every cached bitmap. */
  async destroy(): Promise<void> {
    for (const job of [...this.jobs.values()]) this.cancel(job, 'Engine destroyed');
    this.cache.clear();
    this.retained.clear();
    this.passwords.clear();
    this.texts.clear();
    this.cropBoxes.clear();
    const renderer = this.renderer;
    this.renderer = undefined;
    try {
      await (await renderer)?.destroy?.();
    } catch {
      // Nothing left to clean up.
    }
  }
}

/**
 * Cache identity of a tile: its own "page" (`…:rotation#tile`) so tiles never stand in for
 * a whole-page preview (`BitmapCache.best`), yet `removeSource` still drops them.
 */
function tileAwarePage(page: string, tile: string | undefined): string {
  return tile === undefined ? page : `${page}#${tile}`;
}

function tileAwareKey(page: string, tile: string | undefined, bucket: number): string {
  return `${tileAwarePage(page, tile)}:${bucket}`;
}

/** Per-page CropBoxes when the engine reports them (see `pageCropBox`). */
function readCropBoxes(document: OpenedDocument): readonly (Rect | undefined)[] {
  // Defensive: test doubles may omit `pages`.
  const pages: OpenedDocument['pages'] = Array.isArray(document.pages) ? document.pages : [];
  return pages.map(({ cropBox }) =>
    cropBox !== undefined && Number.isFinite(cropBox.x) && Number.isFinite(cropBox.y)
      ? cropBox
      : undefined,
  );
}

/** Per-page shapes for clipped repaints (unrotated CropBox size, /Rotate, CropBox origin). */
function readShapes(document: OpenedDocument): readonly PageShape[] {
  const pages: OpenedDocument['pages'] = Array.isArray(document.pages) ? document.pages : [];
  return pages.map(({ size, rotation, cropBox }) => ({
    size,
    rotation,
    originX: cropBox?.x ?? 0,
    originY: cropBox?.y ?? 0,
  }));
}

let instance: EngineService | undefined;

/**
 * The app-wide engine service. The engine code is loaded on first use (its own chunk) and
 * the PDFium worker starts then (ARCHITECTURE.md §2: loaded on first document open).
 */
export function getEngineService(): EngineService {
  instance ??= new EngineService({
    createRenderer: async () => {
      // ADR-0011: our own PDFium worker; `destroy()` terminates it. Constructed first so its
      // script (and then the wasm) loads while the engine chunk and the assembler do.
      const worker = new PdfiumWorker({ name: 'recto pdfium' });
      try {
        const [{ createPdfiumProxy }, inspector] = await Promise.all([
          import('@pdf-editor/engine'),
          getAssembler(),
        ]);
        return createPdfiumProxy(worker, { wasmUrl, fontFallback: null, inspector });
      } catch (error) {
        worker.terminate();
        throw error;
      }
    },
  });
  return instance;
}

// ---------------------------------------------------------------------------
// Signature worker (M5 spec recognize-and-compare §3, ADR-0013)
// ---------------------------------------------------------------------------

/** The shared signature worker ends after this long without a call (spec §3.2). */
export const SIGNATURE_IDLE_MS = 5 * 60_000;

/** A new signature worker (`@pdf-editor/engine/signature.worker`) behind its proxy. */
export async function createSignatureWorker(): Promise<SignatureProxy> {
  // Constructed first so the worker script loads while the engine chunk does.
  const worker = new SignatureWorker({ name: 'recto signature' });
  try {
    const { createSignatureProxy } = await import('@pdf-editor/engine');
    // The self-hosted PDFium lets the worker compare the signed revision's pages with the
    // file's (spec §3.1 step 6): a page that looks different is never "changed nothing".
    return createSignatureProxy(worker, { pdfiumWasmUrl: wasmUrl });
  } catch (error) {
    worker.terminate();
    throw error;
  }
}

/**
 * The signature worker's lifecycle. Validation on open and "View signed version" share one
 * long-lived worker (`run`), terminated `idleMs` after its last call ends; signing takes a
 * worker of its own (`dedicated`), which the caller terminates right after signing so the
 * imported key goes with it (ADR-0013 §2).
 */
export class SignatureWorkerHost {
  private shared: Promise<SignatureProxy> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private busy = 0;

  constructor(
    private readonly create: () => Promise<SignatureProxy> = createSignatureWorker,
    private readonly idleMs: number = SIGNATURE_IDLE_MS,
  ) {}

  /** True while the shared worker exists (started and not yet terminated). */
  get alive(): boolean {
    return this.shared !== undefined;
  }

  /** Runs `task` on the shared worker, starting it when needed. */
  async run<T>(task: (proxy: SignatureProxy) => Promise<T>): Promise<T> {
    this.busy += 1;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    try {
      if (this.shared === undefined) {
        const created = this.create();
        created.catch(() => {
          if (this.shared === created) this.shared = undefined;
        });
        this.shared = created;
      }
      return await task(await this.shared);
    } finally {
      this.busy -= 1;
      if (this.busy === 0) {
        this.timer = setTimeout(() => {
          this.timer = undefined;
          this.terminate();
        }, this.idleMs);
      }
    }
  }

  /** A worker for one signing; the caller must `terminate()` it when done. */
  dedicated(): Promise<SignatureProxy> {
    return this.create();
  }

  /** Ends the shared worker now (idle timeout, tests). A later `run` starts a new one. */
  terminate(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    const current = this.shared;
    this.shared = undefined;
    void current?.then(
      (proxy) => proxy.terminate(),
      () => undefined,
    );
  }
}

let signatureHost: SignatureWorkerHost | undefined;

/** The app-wide signature worker host (the worker itself starts on first use). */
export function getSignatureWorkers(): SignatureWorkerHost {
  signatureHost ??= new SignatureWorkerHost();
  return signatureHost;
}

// ---------------------------------------------------------------------------
// Analysis worker (M5 spec recognize-and-compare §2, §4): compare and convert
// ---------------------------------------------------------------------------

/** The analysis worker ends after this long with no lease held. */
export const ANALYSIS_IDLE_MS = 2 * 60_000;

/** A hold on the analysis worker: it stays alive until every lease is released. */
export interface AnalysisLease {
  readonly proxy: AnalysisProxy;
  /** Idempotent; the worker ends `ANALYSIS_IDLE_MS` after the last lease is released. */
  release(): void;
}

/**
 * The analysis worker (`@pdf-editor/engine/analysis.worker`, pure JS), started on first use
 * and terminated after `idleMs` without a lease. A comparison holds its lease while its
 * result (heat maps) is on screen; a conversion for the length of the run.
 */
export class AnalysisWorkerHost {
  private shared: Promise<AnalysisProxy> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private leases = 0;

  constructor(
    private readonly create: () => Promise<AnalysisProxy> = async () => {
      const worker = new AnalysisWorker({ name: 'recto analysis' });
      try {
        const { createAnalysisProxy } = await import('@pdf-editor/engine');
        return createAnalysisProxy(worker);
      } catch (error) {
        worker.terminate();
        throw error;
      }
    },
    private readonly idleMs: number = ANALYSIS_IDLE_MS,
  ) {}

  get alive(): boolean {
    return this.shared !== undefined;
  }

  async acquire(): Promise<AnalysisLease> {
    this.leases += 1;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.leases -= 1;
      if (this.leases > 0) return;
      this.timer = setTimeout(() => this.terminate(), this.idleMs);
    };
    if (this.shared === undefined) {
      const created = this.create();
      created.catch(() => {
        if (this.shared === created) this.shared = undefined;
      });
      this.shared = created;
    }
    try {
      return { proxy: await this.shared, release };
    } catch (error) {
      release();
      throw error;
    }
  }

  /** Ends the worker now; calls in flight reject with `aborted`. */
  terminate(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    const current = this.shared;
    this.shared = undefined;
    void current?.then(
      (proxy) => proxy.dispose(),
      () => undefined,
    );
  }
}

let analysisHost: AnalysisWorkerHost | undefined;

/** The app-wide analysis worker host (the worker itself starts on first `acquire`). */
export function getAnalysisWorkers(): AnalysisWorkerHost {
  analysisHost ??= new AnalysisWorkerHost();
  return analysisHost;
}

// ---------------------------------------------------------------------------
// OCR recognizer (M5 spec recognize-and-compare §1.1, ADR-0012)
// ---------------------------------------------------------------------------

/** The recognizer pool is disposed this long after the last run released it (spec §1.1). */
export const OCR_RECOGNIZER_IDLE_MS = 60_000;

/** A hold on the recognizer: it stays alive until every lease is released. */
export interface OcrRecognizerLease {
  readonly recognizer: OcrRecognizer;
  /** Idempotent; the pool is disposed `OCR_RECOGNIZER_IDLE_MS` after the last release. */
  release(): void;
}

/** What the host creates on first use: the recognizer and the pack loader it reads from. */
export interface OcrRecognizerParts {
  readonly recognizer: OcrRecognizer;
  readonly packs: OcrPackStore;
}

/** The served `ocr/` directory (ADR-0012 §2): on the app's own origin, under the base path. */
export function ocrBaseUrl(): string {
  return `${import.meta.env.BASE_URL}ocr/`;
}

/**
 * The OCR recognizer's lifecycle. tesseract.js (a lazy chunk) posts pages to its own
 * classic workers, served from our origin; the pool of one or two recognizers is started by
 * the first run and kept `idleMs` after the last lease is released, so a second run right
 * after the first does not start the engine again. The pack loader (`OcrPackStore`) is
 * shared with the language manager, which never starts a recognizer.
 */
export class OcrRecognizerHost {
  private parts: Promise<OcrRecognizerParts> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private leases = 0;

  constructor(
    private readonly create: () => Promise<OcrRecognizerParts> = async () => {
      const { createOcrRecognizer, OcrPackStore } = await import('@pdf-editor/engine');
      const packs = new OcrPackStore({ baseUrl: ocrBaseUrl() });
      return { recognizer: createOcrRecognizer({ baseUrl: ocrBaseUrl(), packs }), packs };
    },
    private readonly idleMs: number = OCR_RECOGNIZER_IDLE_MS,
  ) {}

  private load(): Promise<OcrRecognizerParts> {
    if (this.parts === undefined) {
      const created = this.create();
      created.catch(() => {
        if (this.parts === created) this.parts = undefined;
      });
      this.parts = created;
    }
    return this.parts;
  }

  /** The language pack loader (no recognizer is started). */
  async packs(): Promise<OcrPackStore> {
    return (await this.load()).packs;
  }

  /** Whether a lease is held (a run is using the recognizer). */
  get busy(): boolean {
    return this.leases > 0;
  }

  async acquire(): Promise<OcrRecognizerLease> {
    this.leases += 1;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.leases -= 1;
      if (this.leases > 0) return;
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.dispose();
      }, this.idleMs);
    };
    try {
      return { recognizer: (await this.load()).recognizer, release };
    } catch (error) {
      release();
      throw error;
    }
  }

  /** Terminates the recognizers now (idle timeout, tests); the pack loader stays. */
  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    void this.parts?.then(
      (parts) => parts.recognizer.dispose(),
      () => undefined,
    );
  }
}

let ocrHost: OcrRecognizerHost | undefined;

/** The app-wide OCR recognizer host (tesseract.js loads on the first run). */
export function getOcrRecognizers(): OcrRecognizerHost {
  ocrHost ??= new OcrRecognizerHost();
  return ocrHost;
}
