/**
 * Raw annotation appearance and private-key access (ADR-0011 §2), added by spike S1
 * (docs/research/09-ink-appearance-spike.md) for variable-width ink. Exported for P4; the
 * app does not use it yet. Every function is valid only inside `HostedEngine.withRawAccess`
 * (it holds the source's lock and the orchestrator's queue slot) and finds the annotation
 * by its /NM, as EmbedPDF does.
 *
 * - `setAnnotationAppearance`: optionally widens /Rect (`FPDFAnnot_SetRect`), replaces the
 *   normal appearance with our content (`FPDFAnnot_SetAP`: a new Form XObject whose /BBox is
 *   the /Rect, content in user space, uncompressed; PDFium adds `/Resources /ExtGState /GS`
 *   with /CA and /ca when the annotation's /CA is below 1) and writes private string keys
 *   (`FPDFAnnot_SetStringValue`, a PDF text string). Then drops the executor's page cache.
 * - `annotationAppearance` / `annotationString`: read them back (`FPDFAnnot_GetAP`,
 *   `FPDFAnnot_GetStringValue`), e.g. after a reopen in a later session.
 *
 * EmbedPDF's `updatePageAnnotation(…, { regenerateAppearance: true })` (what
 * `PdfiumAdapter.updateAnnotation` calls) regenerates the appearance from /InkList and
 * /BS /W, replacing ours; private keys survive it. Re-apply after every such update.
 */
import { EngineError } from '../../types';
import type { RawAccess } from './hosted-engine';

/** `FPDF_ANNOT_APPEARANCEMODE_NORMAL`. */
export const APPEARANCE_MODE_NORMAL = 0;

/** A rect in PDF user space (unrotated page, origin bottom-left). */
export interface UserRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface AnnotationAppearanceWrite {
  /** The new normal appearance content (user space; /BBox = the annotation's /Rect). */
  readonly content: string;
  /** Written to /Rect before the appearance (it becomes the /BBox). Omit to keep /Rect. */
  readonly rect?: UserRect;
  /** Private keys to write as PDF text strings (e.g. `PdfEditorInkWidths`). */
  readonly strings?: Readonly<Record<string, string>>;
}

function annotationName(access: RawAccess, annot: number): string {
  return access.memory.readUtf16Result((buf, len) =>
    access.module.FPDFAnnot_GetStringValue(annot, 'NM', buf, len),
  );
}

/**
 * Runs `fn` with the `FPDF_ANNOTATION` of the annotation named `name` on `pageIndex`, then
 * closes it and releases the page. Throws `EngineError('internal')` when it is not there.
 */
export function withAnnotation<R>(
  access: RawAccess,
  pageIndex: number,
  name: string,
  fn: (annot: number) => R,
): R {
  const m = access.module;
  const page = access.doc.acquirePage(pageIndex);
  try {
    const count = m.FPDFPage_GetAnnotCount(page.pagePtr);
    for (let i = 0; i < count; i++) {
      const annot = m.FPDFPage_GetAnnot(page.pagePtr, i);
      if (!annot) continue;
      try {
        if (annotationName(access, annot) === name) return fn(annot);
      } finally {
        m.FPDFPage_CloseAnnot(annot);
      }
    }
    throw new EngineError('internal', `Annotation ${name} is not on page ${pageIndex + 1}`);
  } finally {
    page.release();
  }
}

/** Replaces the normal appearance (and /Rect, private keys) of annotation `name`. */
export function setAnnotationAppearance(
  access: RawAccess,
  pageIndex: number,
  name: string,
  write: AnnotationAppearanceWrite,
): void {
  const m = access.module;
  const mem = access.memory;
  try {
    withAnnotation(access, pageIndex, name, (annot) => {
      if (write.rect) {
        const { x, y, width, height } = write.rect;
        const ok = mem.withMem(16, (p) => {
          // FS_RECTF: left, top, right, bottom (float32).
          const f = mem.heap().HEAPF32;
          f[p >> 2] = x;
          f[(p >> 2) + 1] = y + height;
          f[(p >> 2) + 2] = x + width;
          f[(p >> 2) + 3] = y;
          return m.FPDFAnnot_SetRect(annot, p);
        });
        if (!ok) throw new EngineError('internal', `FPDFAnnot_SetRect failed for ${name}`);
      }
      const set = mem.withWideString(write.content, (ptr) =>
        m.FPDFAnnot_SetAP(annot, APPEARANCE_MODE_NORMAL, ptr),
      );
      if (!set) throw new EngineError('internal', `FPDFAnnot_SetAP failed for ${name}`);
      for (const [key, value] of Object.entries(write.strings ?? {})) {
        const ok = mem.withWideString(value, (ptr) => m.FPDFAnnot_SetStringValue(annot, key, ptr));
        if (!ok) throw new EngineError('internal', `FPDFAnnot_SetStringValue(${key}) failed`);
      }
    });
  } finally {
    // The next render and annotation read reload the page.
    access.dropPageCache(pageIndex);
  }
}

/** The normal appearance content of annotation `name` ('' when it has none). */
export function annotationAppearance(access: RawAccess, pageIndex: number, name: string): string {
  return withAnnotation(access, pageIndex, name, (annot) =>
    access.memory.readUtf16Result((buf, len) =>
      access.module.FPDFAnnot_GetAP(annot, APPEARANCE_MODE_NORMAL, buf, len),
    ),
  );
}

/** A string value of annotation `name` (`undefined` when the key is absent). */
export function annotationString(
  access: RawAccess,
  pageIndex: number,
  name: string,
  key: string,
): string | undefined {
  return withAnnotation(access, pageIndex, name, (annot) =>
    access.module.FPDFAnnot_HasKey(annot, key)
      ? access.memory.readUtf16Result((buf, len) =>
          access.module.FPDFAnnot_GetStringValue(annot, key, buf, len),
        )
      : undefined,
  );
}
