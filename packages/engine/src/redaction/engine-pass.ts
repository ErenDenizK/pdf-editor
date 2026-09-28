/**
 * The engine pass of redaction (research 06 §3 steps 1–2), on a private scratch document of
 * the hosted engine (engine-session.ts), never on the user's open document:
 *
 * 1. `removeEncryption` when the source is encrypted (the rest of the pipeline is plain);
 * 2. per page with areas, pending /Redact marks already in the bytes are deleted (only the
 *    plan is applied), then one /Redact annotation per area with a transparent colour (no /IC,
 *    so the engine paints nothing; the fill is drawn later by fill.ts), then
 *    `applyAllRedactions` exactly once per page: text (across TJ runs, text objects, Form
 *    XObjects copy-on-write, invisible text), inline images and image pixels under the area;
 * 3. inside `withRawAccess`: path objects whose bounds touch an area are removed ("remove if
 *    touched", spec §1.4), on the page and inside Form XObjects at any depth; image objects
 *    lying entirely inside an area (all their pixels were just whitened) are removed; then
 *    `FPDFPage_GenerateContent` and the executor's page cache is dropped;
 * 4. `saveAsCopy` (a full copy, no /Prev).
 *
 * Bounds of objects inside a form are in the form's space and are mapped to page space with
 * the form object's matrix (composed for nested forms). A Form XObject shared by several
 * pages is edited in place, so a path removed there also disappears where the form is
 * drawn on other pages: over-redaction, never a leak.
 */

import { PdfAnnotationSubtype, type PdfRedactAnnoObject } from '@embedpdf/models';
import type { Rect } from '@pdf-editor/document-model';

import { pageGeometry, userToDeviceRect } from '../pdfium/coords';
import type { RawAccess } from '../pdfium/host/hosted-engine';
import { runTask } from '../pdfium/task-bridge';
import { EngineError, type RedactionEnginePassReport, type RedactionPlan } from '../types';
import { openScratch, type RedactionHost, type ScratchDocument } from './engine-session';

const OBJ_PATH = 2;
const OBJ_IMAGE = 3;
const OBJ_FORM = 5;
/** Nesting limit for Form XObjects (hostile files). */
const MAX_FORM_DEPTH = 12;

export interface EnginePassOptions {
  /** Password of an encrypted source. */
  readonly password?: string;
  /** Remove image objects lying entirely inside an area (default true). */
  readonly removeCoveredImages?: boolean;
  readonly signal?: AbortSignal;
}

export type Matrix = readonly [number, number, number, number, number, number];
export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `m` then `n` (row-vector convention, as PDF: p' = p × m × n). */
export function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

export interface Box {
  readonly l: number;
  readonly b: number;
  readonly r: number;
  readonly t: number;
}

export function transformBox(box: Box, m: Matrix): Box {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x, y] of [
    [box.l, box.b],
    [box.r, box.b],
    [box.l, box.t],
    [box.r, box.t],
  ] as const) {
    xs.push(x * m[0] + y * m[2] + m[4]);
    ys.push(x * m[1] + y * m[3] + m[5]);
  }
  return { l: Math.min(...xs), b: Math.min(...ys), r: Math.max(...xs), t: Math.max(...ys) };
}

/** Closed intersection: touching an area's edge counts. */
export const touches = (box: Box, a: Rect) =>
  box.l <= a.x + a.width && box.r >= a.x && box.b <= a.y + a.height && box.t >= a.y;
const inside = (box: Box, a: Rect) =>
  box.l >= a.x && box.r <= a.x + a.width && box.b >= a.y && box.t <= a.y + a.height;

export interface Container {
  count(): number;
  get(index: number): number;
  remove(obj: number): boolean;
}

interface Removal {
  paths: number;
  images: number;
}

export function boundsOf(raw: RawAccess, obj: number): Box | undefined {
  return raw.memory.withMem(16, (buf) => {
    if (!raw.module.FPDFPageObj_GetBounds(obj, buf, buf + 4, buf + 8, buf + 12)) return undefined;
    return {
      l: raw.memory.f32(buf),
      b: raw.memory.f32(buf + 4),
      r: raw.memory.f32(buf + 8),
      t: raw.memory.f32(buf + 12),
    };
  });
}

export function matrixOf(raw: RawAccess, obj: number): Matrix {
  return raw.memory.withMem(24, (buf) => {
    if (!raw.module.FPDFPageObj_GetMatrix(obj, buf)) return IDENTITY;
    return [0, 4, 8, 12, 16, 20].map((o) => raw.memory.f32(buf + o)) as unknown as Matrix;
  });
}

/** The objects of a page. */
export function pageContainer(raw: RawAccess, pagePtr: number): Container {
  return {
    count: () => raw.module.FPDFPage_CountObjects(pagePtr),
    get: (index) => raw.module.FPDFPage_GetObject(pagePtr, index),
    remove: (obj) => raw.module.FPDFPage_RemoveObject(pagePtr, obj),
  };
}

/** The objects of a form object. */
export function formContainer(raw: RawAccess, form: number): Container {
  return {
    count: () => raw.module.FPDFFormObj_CountObjects(form),
    get: (index) => raw.module.FPDFFormObj_GetObject(form, index),
    remove: (child) => raw.module.FPDFFormObj_RemoveObject(form, child),
  };
}

/** Removes touched paths (and covered images) from a container; recurses into forms. */
function prune(
  raw: RawAccess,
  container: Container,
  toPage: Matrix,
  areas: readonly Rect[],
  removeImages: boolean,
  depth: number,
  removal: Removal,
): void {
  const { module } = raw;
  for (let i = container.count() - 1; i >= 0; i--) {
    const obj = container.get(i);
    if (!obj) continue;
    const type = module.FPDFPageObj_GetType(obj);
    if (type !== OBJ_PATH && type !== OBJ_IMAGE && type !== OBJ_FORM) continue;
    const local = boundsOf(raw, obj);
    if (!local) continue;
    const box = transformBox(local, toPage);
    const doomed =
      (type === OBJ_PATH && areas.some((a) => touches(box, a))) ||
      (type === OBJ_IMAGE && removeImages && areas.some((a) => inside(box, a)));
    if (doomed) {
      if (container.remove(obj)) {
        module.FPDFPageObj_Destroy(obj);
        if (type === OBJ_PATH) removal.paths++;
        else removal.images++;
      }
      continue;
    }
    if (type === OBJ_FORM && depth < MAX_FORM_DEPTH && areas.some((a) => touches(box, a))) {
      prune(
        raw,
        formContainer(raw, obj),
        multiply(matrixOf(raw, obj), toPage),
        areas,
        removeImages,
        depth + 1,
        removal,
      );
    }
  }
}

/** Groups valid areas by page; throws for an area off the document or without size. */
export function areasByPage(plan: RedactionPlan, pageCount: number): Map<number, Rect[]> {
  const byPage = new Map<number, Rect[]>();
  plan.areas.forEach((area, index) => {
    const { x, y, width, height } = area.rect;
    const ok =
      Number.isInteger(area.pageIndex) &&
      area.pageIndex >= 0 &&
      area.pageIndex < pageCount &&
      [x, y, width, height].every(Number.isFinite) &&
      width > 0 &&
      height > 0;
    if (!ok) {
      throw new EngineError(
        'unsupported',
        `Redaction area ${index} is not on a page of the document or has no size`,
      );
    }
    byPage.set(area.pageIndex, [...(byPage.get(area.pageIndex) ?? []), area.rect]);
  });
  return byPage;
}

/** Runs steps 1–3 on an open scratch document (the caller saves and closes it). */
export async function runEnginePass(
  host: RedactionHost,
  scratch: ScratchDocument,
  plan: RedactionPlan,
  options: EnginePassOptions = {},
): Promise<Omit<RedactionEnginePassReport, 'durationMs'>> {
  const { engine } = host;
  const { doc } = scratch;
  const { signal } = options;
  const byPage = areasByPage(plan, doc.pageCount);
  const decrypted = doc.isEncrypted;
  if (decrypted) {
    await runTask(engine.removeEncryption(doc), signal, { op: 'redaction' });
  }
  let marksDropped = 0;
  for (const [pageIndex, rects] of byPage) {
    const page = scratch.page(pageIndex);
    const g = pageGeometry(page);
    // Only `plan.areas` are applied: pending /Redact marks already in the bytes (the
    // viewer's, with their own /IC fill) would be applied too by `applyAllRedactions`.
    const existing = await runTask(engine.getPageAnnotations(doc, page), signal, {
      op: 'redaction',
    });
    for (const mark of existing.filter((a) => a.type === PdfAnnotationSubtype.REDACT)) {
      await runTask(engine.removePageAnnotation(doc, page, mark), signal, { op: 'redaction' });
      marksDropped++;
    }
    for (const rect of rects) {
      const device = userToDeviceRect(g, rect);
      const mark: PdfRedactAnnoObject = {
        id: '',
        type: PdfAnnotationSubtype.REDACT,
        pageIndex,
        rect: device,
        segmentRects: [device],
        color: 'transparent',
      };
      await runTask(engine.createPageAnnotation(doc, page, mark), signal, { op: 'redaction' });
    }
    await runTask(engine.applyAllRedactions(doc, page), signal, { op: 'redaction' });
  }
  const removal: Removal = { paths: 0, images: 0 };
  const removeImages = options.removeCoveredImages ?? true;
  await host.withRawAccess(
    scratch.id,
    (raw) => {
      for (const [pageIndex, rects] of byPage) {
        const page = raw.doc.acquirePage(pageIndex);
        const before = removal.paths + removal.images;
        try {
          const pagePtr = page.pagePtr;
          prune(raw, pageContainer(raw, pagePtr), IDENTITY, rects, removeImages, 0, removal);
          if (
            removal.paths + removal.images > before &&
            !raw.module.FPDFPage_GenerateContent(pagePtr)
          ) {
            throw new EngineError(
              'internal',
              `Could not regenerate page ${pageIndex + 1} after removing redacted graphics`,
            );
          }
        } finally {
          page.release();
          raw.dropPageCache(pageIndex);
        }
      }
    },
    signal ? { signal } : {},
  );
  return {
    pages: byPage.size,
    areas: plan.areas.length,
    pathsRemoved: removal.paths,
    imagesRemoved: removal.images,
    pendingMarksDropped: marksDropped,
    decrypted,
  };
}

/**
 * The engine pass on its own: opens `bytes` as a private scratch document, runs it, and
 * returns the saved copy. Throws `EngineError` for a bad plan or password.
 */
export async function engineRedact(
  host: RedactionHost,
  bytes: ArrayBuffer | Uint8Array,
  plan: RedactionPlan,
  options: EnginePassOptions = {},
): Promise<{ bytes: ArrayBuffer; report: RedactionEnginePassReport }> {
  const started = performance.now();
  const scratch = await openScratch(host, bytes, options);
  try {
    const report = await runEnginePass(host, scratch, plan, options);
    const out = await runTask(host.engine.saveAsCopy(scratch.doc), options.signal, { op: 'save' });
    return { bytes: out, report: { ...report, durationMs: performance.now() - started } };
  } finally {
    await scratch.close();
  }
}
