/**
 * `PdfImageEditor` on the PDFium host (ADR-0011, M4 §3): every call is one `withRawAccess`
 * on the source, so it runs as a task on the orchestrator's queue, exclusive per source, and
 * never awaits engine or adapter calls.
 *
 * Mutations change the page objects in memory, check the result on the same objects (the
 * image at the path has the expected bounds and pixels, or is gone), and only then commit
 * with `FPDFPage_GenerateContent`; the executor's cached page is dropped either way (closing
 * an uncommitted page discards the change). After the commit the page is loaded again and
 * the image located afresh, which is what the result reports.
 *
 * - Images inside Form XObjects are first moved out of their form to the page, right after
 *   the outermost form, with their page-space matrix and clip (`FPDFPage_GenerateContent`
 *   does not rewrite a form's stream for a changed child, only for a removed one, the same
 *   finding as text edits' "moved out of form"). The form, and so every other place it is
 *   drawn, no longer shows the image; the UI warns for every image in a form.
 * - Transform sets the object's matrix and moves its clip path along, so a clipped image
 *   stays visible where it goes.
 * - Replace creates a new image object with the new pixels, puts it at the same index with
 *   the same matrix and marked-content marks and removes the old object: an image XObject
 *   drawn elsewhere (other pages, other places) keeps its pixels there. The old object's
 *   clip path and graphics state are not carried over.
 * - Remove takes the object out of the page or its form.
 */
import type { SourceId } from '@pdf-editor/document-model';

import type { HostedEngine, RawAccess } from '../pdfium/host/hosted-engine';
import {
  EngineError,
  type EngineCallOptions,
  type ExtractedImage,
  type ImageEditResult,
  type ImageObjectRef,
  type ImageReplacement,
  type ImageTransformTarget,
  type LocatedImage,
  type PdfImageEditor,
  type TextMatrix,
} from '../types';
import { imageEditError } from './errors';
import { imageBounds, invertMatrix, matrixForRect, multiplyMatrix, rectDistance } from './geometry';
import {
  formsMatrix,
  imageAt,
  imageObjects,
  type ImagePlace,
  locateOne,
  locatePageImages,
  pageMatrixOf,
  resolveImage,
} from './locate';
import { RawImages } from './raw';

/** How far the image's bounds may be from the requested ones after a transform, points. */
export const IMAGE_TRANSFORM_TOLERANCE = 0.01;

/** Largest image `extractImage` reads out (pixels; 4 bytes each). */
const MAX_EXTRACT_PIXELS = 1 << 27;

/** The raw-access part of `HostedEngine` the editor needs. */
export type ImageEditorHost = Pick<HostedEngine, 'withRawAccess'>;

function withSignal(options: EngineCallOptions | undefined) {
  return options?.signal ? { signal: options.signal } : {};
}

function finiteMatrix(m: TextMatrix): boolean {
  return m.length === 6 && m.every((v) => Number.isFinite(v));
}

const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  return magic.every((b, i) => bytes[i] === b);
}

/** Checks a replacement's shape; returns the pixel size it must have, when known. */
function checkReplacement(r: ImageReplacement): { width: number; height: number } | undefined {
  if ('rgba' in r) {
    const { width, height } = r;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
      throw imageEditError('invalid-replacement', `Bad pixel size ${width}×${height}`);
    }
    if (r.rgba.length !== width * height * 4) {
      throw imageEditError(
        'invalid-replacement',
        `RGBA data has ${r.rgba.length} bytes, expected ${width * height * 4}`,
      );
    }
    return { width, height };
  }
  if ('jpeg' in r) {
    if (!startsWith(r.jpeg, JPEG_MAGIC)) throw imageEditError('invalid-replacement', 'Not a JPEG');
    return undefined;
  }
  if (!startsWith(r.png, PNG_MAGIC)) throw imageEditError('invalid-replacement', 'Not a PNG');
  return undefined;
}

function checkPage(access: RawAccess, pageIndex: number): void {
  const count = access.module.FPDF_GetPageCount(access.docPtr);
  if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= count) {
    throw new EngineError('internal', `Page ${pageIndex + 1} does not exist (${count} pages)`);
  }
}

/**
 * Moves an image out of its Form XObject(s) to the page, right after the outermost form,
 * keeping where it shows (page-space matrix, clip mapped to page space). A page-level image
 * is returned as is. The caller commits (or drops) the page.
 */
function hoist(raw: RawImages, place: ImagePlace, pagePtr: number): ImagePlace {
  const form = place.forms[place.forms.length - 1];
  if (!form) return place;
  const { m } = raw;
  const toPage = formsMatrix(raw, place);
  const matrix = multiplyMatrix(raw.matrix(place.obj), toPage);
  if (!m.FPDFFormObj_RemoveObject(form, place.obj)) {
    throw new Error('FPDFFormObj_RemoveObject failed');
  }
  raw.setMatrix(place.obj, matrix);
  raw.transformClip(place.obj, toPage);
  const index = (place.path[0] ?? 0) + 1;
  if (!m.FPDFPage_InsertObjectAtIndex(pagePtr, place.obj, index)) {
    m.FPDFPageObj_Destroy(place.obj);
    throw new Error('FPDFPage_InsertObjectAtIndex failed');
  }
  return { obj: place.obj, path: [index], forms: [] };
}

/** The image editor of a hosted engine. */
export class HostedImageEditor implements PdfImageEditor {
  constructor(private readonly host: ImageEditorHost) {}

  locateImages(
    source: SourceId,
    pageIndex: number,
    options?: EngineCallOptions,
  ): Promise<readonly LocatedImage[]> {
    return this.host.withRawAccess(
      source,
      (access) => {
        const raw = new RawImages(access.module, access.memory);
        checkPage(access, pageIndex);
        const page = access.doc.acquirePage(pageIndex);
        try {
          return locatePageImages(raw, access.docPtr, page.pagePtr, source, pageIndex);
        } finally {
          page.release();
        }
      },
      withSignal(options),
    );
  }

  extractImage(ref: ImageObjectRef, options?: EngineCallOptions): Promise<ExtractedImage> {
    return this.host.withRawAccess(
      ref.source,
      (access) => {
        const raw = new RawImages(access.module, access.memory);
        checkPage(access, ref.pageIndex);
        const page = access.doc.acquirePage(ref.pageIndex);
        try {
          const place = resolveImage(raw, page.pagePtr, ref);
          if (ref.pixelWidth * ref.pixelHeight > MAX_EXTRACT_PIXELS) {
            throw new EngineError(
              'out-of-memory',
              `The image is too large to extract (${ref.pixelWidth}×${ref.pixelHeight})`,
            );
          }
          const pixels = raw.renderedPixels(
            access.docPtr,
            page.pagePtr,
            place.obj,
            ref.pixelWidth,
            ref.pixelHeight,
          );
          const names = raw.filterNames(place.obj);
          const jpeg = names.length === 1 && (names[0] === 'DCTDecode' || names[0] === 'DCT');
          const bytes = jpeg ? raw.rawData(place.obj) : undefined;
          return {
            width: pixels.width,
            height: pixels.height,
            rgba: pixels.rgba,
            ...(bytes && startsWith(bytes, JPEG_MAGIC)
              ? { original: { bytes, mime: 'image/jpeg' as const } }
              : {}),
          };
        } finally {
          page.release();
        }
      },
      withSignal(options),
    );
  }

  transformImage(
    ref: ImageObjectRef,
    target: ImageTransformTarget,
    options?: EngineCallOptions,
  ): Promise<ImageEditResult> {
    return this.host.withRawAccess(
      ref.source,
      (access) => {
        const raw = new RawImages(access.module, access.memory);
        let previousMatrix: TextMatrix = [1, 0, 0, 1, 0, 0];
        let wanted: TextMatrix = previousMatrix;
        let path = ref.objectPath;
        this.mutate(access, raw, ref, (found, pagePtr) => {
          previousMatrix = pageMatrixOf(raw, found);
          const next =
            'matrix' in target ? target.matrix : matrixForRect(previousMatrix, target.rect);
          if (!next || !finiteMatrix(next) || !invertMatrix(next)) {
            throw imageEditError('invalid-target', 'The target matrix or rect is degenerate');
          }
          wanted = next;
          const place = hoist(raw, found, pagePtr);
          path = place.path;
          const before = raw.matrix(place.obj);
          raw.setMatrix(place.obj, next);
          // The clip moves with the image (a clipped image would vanish otherwise).
          const undoBefore = invertMatrix(before);
          if (undoBefore) raw.transformClip(place.obj, multiplyMatrix(undoBefore, next));
          const moved = imageAt(raw, pagePtr, path);
          const drift = moved
            ? rectDistance(imageBounds(pageMatrixOf(raw, moved)), imageBounds(next))
            : Number.POSITIVE_INFINITY;
          if (!(drift <= IMAGE_TRANSFORM_TOLERANCE)) {
            throw imageEditError('verification-failed', `The image is off by ${drift} pt`);
          }
          return () => undefined;
        });
        return this.result(access, raw, ref, path, previousMatrix, imageBounds(wanted));
      },
      withSignal(options),
    );
  }

  removeImage(ref: ImageObjectRef, options?: EngineCallOptions): Promise<ImageEditResult> {
    return this.host.withRawAccess(
      ref.source,
      (access) => {
        const raw = new RawImages(access.module, access.memory);
        const { m } = raw;
        let previousMatrix: TextMatrix = [1, 0, 0, 1, 0, 0];
        let count = 0;
        this.mutate(access, raw, ref, (place, pagePtr) => {
          previousMatrix = pageMatrixOf(raw, place);
          count = imageObjects(raw, pagePtr).length;
          const form = place.forms[place.forms.length - 1];
          const removed = form
            ? m.FPDFFormObj_RemoveObject(form, place.obj)
            : m.FPDFPage_RemoveObject(pagePtr, place.obj);
          if (!removed) throw imageEditError('verification-failed', 'PDFium kept the image');
          const destroy = () => m.FPDFPageObj_Destroy(place.obj);
          const left = imageObjects(raw, pagePtr);
          if (left.length !== count - 1 || left.some((p) => p.obj === place.obj)) {
            destroy();
            throw imageEditError('verification-failed', 'The image is still on the page');
          }
          return destroy;
        });
        // Loaded again from the new content: one image fewer.
        const page = access.doc.acquirePage(ref.pageIndex);
        try {
          const left = imageObjects(raw, page.pagePtr).length;
          if (left !== count - 1) {
            throw imageEditError(
              'verification-failed',
              `After the removal page ${ref.pageIndex + 1} has ${left} images, expected ${count - 1}`,
            );
          }
        } finally {
          page.release();
        }
        return { previousMatrix, drift: 0 };
      },
      withSignal(options),
    );
  }

  replaceImage(
    ref: ImageObjectRef,
    replacement: ImageReplacement,
    options?: EngineCallOptions,
  ): Promise<ImageEditResult> {
    let size: ReturnType<typeof checkReplacement>;
    try {
      size = checkReplacement(replacement);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return this.host.withRawAccess(
      ref.source,
      (access) => {
        const raw = new RawImages(access.module, access.memory);
        const { m } = raw;
        let previousMatrix: TextMatrix = [1, 0, 0, 1, 0, 0];
        let path = ref.objectPath;
        this.mutate(access, raw, ref, (found, pagePtr) => {
          previousMatrix = pageMatrixOf(raw, found);
          const place = hoist(raw, found, pagePtr);
          path = place.path;
          const target = m.FPDFPageObj_NewImageObj(access.docPtr);
          if (!target) throw new Error('FPDFPageObj_NewImageObj failed');
          let cleanup: () => void = () => m.FPDFPageObj_Destroy(target);
          try {
            if (!this.load(raw, target, replacement)) {
              throw imageEditError('invalid-replacement', 'PDFium could not load the new image');
            }
            raw.setMatrix(target, raw.matrix(place.obj));
            raw.applyMarks(access.docPtr, target, raw.marks(place.obj));
            if (!m.FPDFPage_InsertObjectAtIndex(pagePtr, target, place.path[0] ?? 0)) {
              throw new Error('FPDFPage_InsertObjectAtIndex failed');
            }
            // The page owns the new object now; the old one is ours once removed.
            cleanup = () => undefined;
            if (!m.FPDFPage_RemoveObject(pagePtr, place.obj)) {
              throw imageEditError('verification-failed', 'PDFium kept the old image');
            }
            cleanup = () => m.FPDFPageObj_Destroy(place.obj);
            const now = imageAt(raw, pagePtr, path);
            const pixels = now ? raw.pixelSize(now.obj) : { width: 0, height: 0 };
            const drift = now
              ? rectDistance(imageBounds(pageMatrixOf(raw, now)), ref.bounds)
              : Number.POSITIVE_INFINITY;
            const sizeOk = size
              ? pixels.width === size.width && pixels.height === size.height
              : pixels.width > 0 && pixels.height > 0;
            if (!sizeOk || !(drift <= IMAGE_TRANSFORM_TOLERANCE)) {
              throw imageEditError(
                'verification-failed',
                `The new image is ${pixels.width}×${pixels.height}, off by ${drift} pt`,
              );
            }
          } catch (error) {
            cleanup();
            throw error;
          }
          return cleanup;
        });
        return this.result(access, raw, ref, path, previousMatrix, ref.bounds);
      },
      withSignal(options),
    );
  }

  /** Loads `replacement` into the image object `obj` (in place). */
  private load(raw: RawImages, obj: number, replacement: ImageReplacement): boolean {
    const { m } = raw;
    if ('rgba' in replacement) {
      return raw.withBgraBitmap(replacement.rgba, replacement.width, replacement.height, (bmp) =>
        m.FPDFImageObj_SetBitmap(0, 0, obj, bmp),
      );
    }
    if ('jpeg' in replacement) {
      return raw.withBytes(replacement.jpeg, (ptr, length) =>
        m.EPDFImageObj_SetJpeg(0, 0, obj, ptr, length),
      );
    }
    return raw.withBytes(replacement.png, (ptr, length) =>
      m.EPDFImageObj_SetPng(0, 0, obj, ptr, length),
    );
  }

  /**
   * Resolves `ref`, runs `change` on the cached page (it verifies its own result and
   * returns what to release after the page is closed), then commits with `GenerateContent`.
   * The executor's cached page is dropped in every case: committed, it is stale; not
   * committed, closing it discards the change.
   */
  private mutate(
    access: RawAccess,
    raw: RawImages,
    ref: ImageObjectRef,
    change: (place: ImagePlace, pagePtr: number) => () => void,
  ): void {
    checkPage(access, ref.pageIndex);
    const page = access.doc.acquirePage(ref.pageIndex);
    let release: (() => void) | undefined;
    let changed = false;
    try {
      const place = resolveImage(raw, page.pagePtr, ref);
      changed = true;
      release = change(place, page.pagePtr);
      if (!raw.m.FPDFPage_GenerateContent(page.pagePtr)) {
        throw new Error('FPDFPage_GenerateContent failed');
      }
    } finally {
      if (changed) access.dropPageCache(ref.pageIndex);
      else page.release();
      release?.();
    }
  }

  /** The image at `ref`'s path after a commit, checked against `expected` bounds. */
  private result(
    access: RawAccess,
    raw: RawImages,
    ref: ImageObjectRef,
    path: readonly number[],
    previousMatrix: TextMatrix,
    expected: ImageObjectRef['bounds'],
  ): ImageEditResult {
    const page = access.doc.acquirePage(ref.pageIndex);
    try {
      const place = imageAt(raw, page.pagePtr, path);
      if (!place) {
        throw imageEditError(
          'verification-failed',
          `After the edit, page ${ref.pageIndex + 1} has no image at ${path.join('/')}`,
        );
      }
      const image = locateOne(raw, access.docPtr, page.pagePtr, ref.source, ref.pageIndex, place);
      const drift = rectDistance(image.bounds, expected);
      if (!(drift <= IMAGE_TRANSFORM_TOLERANCE)) {
        throw imageEditError(
          'verification-failed',
          `After the edit the image is off by ${drift.toFixed(3)} pt`,
        );
      }
      return { image, previousMatrix, drift };
    } finally {
      page.release();
    }
  }
}

/** A `PdfImageEditor` for a hosted engine (worker or, in tests, the calling thread). */
export function createImageEditor(host: ImageEditorHost): HostedImageEditor {
  return new HostedImageEditor(host);
}
