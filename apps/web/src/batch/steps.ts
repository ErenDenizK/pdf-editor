/**
 * Recipe steps as model operations on the runner's private workspace (spec §5: "the steps
 * become model operations and engine edits"). Each step kind maps onto what its dialog
 * does in the app, through the same pure functions:
 *
 * | step | app call |
 * |---|---|
 * | rotate, delete-pages | `rotatePages`, `deletePages` |
 * | crop | `planCrops` / `withCrops` (crop/plan.ts) |
 * | page-size | `resizePages(recipeResizeRequest)` |
 * | page-numbers, header-footer, watermark (text) | furniture overlay builders + `applyFurniture` |
 * | watermark (image) | the image overlay on every page, its bytes in the run's private blobs |
 * | bates | `batesOverlay` + `setDocumentBates(nextBatesStart)` |
 * | flatten, compress | `ExportOptions.flattenAnnotations` / `flattenForms` / `compression` |
 * | metadata-strip, metadata-set | `setMetadataStrip`, `setMetadata` |
 * | security, remove-password | `setSecurity(recipeSecurityPolicy)`, `removePassword` |
 * | export | `prepareExport` options, or images (`rasterizeWorkspaceDocument`) |
 * | ocr, export markdown/text | not runnable in this build (`recipeStepAvailability`) |
 *
 * An image watermark goes on the pages rather than into the document's furniture: a batch
 * file gains no pages later, so both draw the same, and the page form keeps every overlay
 * of a page in one place.
 */
import {
  type BlobId,
  deletePages,
  type DocumentId,
  getDocument,
  nextBatesStart,
  type PageId,
  pageDisplaySize,
  type RecipeBatesOptions,
  type RecipeExportOptions,
  type RecipePageSelection,
  type RecipeRange,
  type RecipeStep,
  type RecipeTextStyle,
  recipeResizeRequest,
  recipeSecurityPolicy,
  removePassword,
  resizePages,
  resolveRecipePages,
  rotatePages,
  setDocumentBates,
  setMetadata,
  setMetadataStrip,
  setSecurity,
  updateDocumentOverlays,
  type Workspace,
} from '@pdf-editor/document-model';
import { type CompressionSettings, presetSettings } from '@pdf-editor/engine';

import { type PageBoxOf, planCrops, withCrops } from '../crop/plan';
import {
  applyFurniture,
  batesOverlay,
  headerFooterOverlays,
  pageNumberOverlay,
  type RangeChoice,
  watermarkOverlay,
  type WatermarkSettings,
} from '../furniture/furniture-model';
import { m } from '../i18n';

/** Export choices the steps make (`ExportOptions` of export/export-service.ts). */
export interface StepExportOptions {
  readonly flattenAnnotations?: boolean;
  readonly flattenForms?: boolean;
  readonly compression?: CompressionSettings;
  readonly compatibility?: boolean;
  readonly includeComments?: boolean;
}

/** What one file has become after its steps: the workspace and how to write it. */
export interface StepState {
  readonly workspace: Workspace;
  readonly exportOptions: StepExportOptions;
  /** The export step's options; a PDF with the defaults without one. */
  readonly output: RecipeExportOptions;
}

export interface StepNote {
  readonly code: string;
  readonly message: string;
}

export interface StepContext {
  readonly documentId: DocumentId;
  /** Page boxes of the file's source (crop). */
  readonly pageBox: PageBoxOf;
  /** Pages numbered by the Bates steps of earlier files in this run (continuous Bates). */
  readonly batesNumberedBefore: number;
  /** The password asked for a security step (memory only). */
  readonly outputPassword: (stepIndex: number) => string | undefined;
  /** Stores image bytes for the export (the run's private blobs). */
  readonly addBlob: (bytes: ArrayBuffer) => BlobId;
}

/** A step that cannot run on this file; the file fails with reason `step`. */
export class StepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StepError';
  }
}

export const DEFAULT_OUTPUT: RecipeExportOptions = { format: 'pdf' };

function pagesOf(ws: Workspace, documentId: DocumentId, selection: RecipePageSelection): PageId[] {
  const doc = getDocument(ws, documentId);
  const sizes = doc.pages.map((page) => pageDisplaySize(ws, page));
  return resolveRecipePages(selection, sizes).flatMap((i) => {
    const page = doc.pages[i];
    return page === undefined ? [] : [page.id];
  });
}

function rangeChoice(range: RecipeRange): RangeChoice {
  return range.mode === 'custom'
    ? { mode: 'custom', from: range.from, to: range.to }
    : { mode: range.mode, from: 1, to: 1 };
}

const style = (s: RecipeTextStyle) => ({ ...s });

/** Standard base64 → bytes. */
export function decodeBase64(data: string): ArrayBuffer {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/** The Bates start of this file (continuous runs go on from the earlier files). */
export function batesStartFor(options: RecipeBatesOptions, numberedBefore: number): number {
  return nextBatesStart(options, numberedBefore);
}

/**
 * Applies one step to `state`. Throws `StepError` when the step cannot apply to this file
 * (deleting every page, a missing run-time password); notes go to `notes`.
 */
export function applyRecipeStep(
  state: StepState,
  step: RecipeStep,
  stepIndex: number,
  context: StepContext,
  notes: StepNote[],
): StepState {
  const { documentId } = context;
  const ws = state.workspace;
  const noPages = () =>
    notes.push({ code: `${step.kind}.no-pages`, message: m.batch_notice_no_pages() });
  const withWorkspace = (workspace: Workspace): StepState => ({ ...state, workspace });
  switch (step.kind) {
    case 'rotate': {
      const pages = pagesOf(ws, documentId, step.options.pages);
      if (pages.length === 0) noPages();
      return withWorkspace(rotatePages(ws, pages, 90 * step.options.quarterTurns));
    }
    case 'delete-pages': {
      const pages = pagesOf(ws, documentId, step.options.pages);
      if (pages.length === 0) {
        noPages();
        return state;
      }
      if (pages.length >= getDocument(ws, documentId).pages.length) {
        throw new StepError(m.batch_error_delete_all());
      }
      return withWorkspace(deletePages(ws, pages));
    }
    case 'crop': {
      const pages = pagesOf(ws, documentId, step.options.pages);
      if (pages.length === 0) noPages();
      const plan = planCrops(ws, pages, step.options.margins, context.pageBox);
      if (plan.tooSmall > 0) {
        notes.push({
          code: 'crop.too-small',
          message: m.batch_notice_crop_too_small({ count: plan.tooSmall }),
        });
      }
      return withWorkspace(withCrops(ws, plan.crops));
    }
    case 'page-size': {
      const pages = pagesOf(ws, documentId, step.options.pages);
      if (pages.length === 0) noPages();
      return withWorkspace(resizePages(ws, pages, recipeResizeRequest(step.options)));
    }
    case 'page-numbers': {
      const o = step.options;
      const overlay = pageNumberOverlay({
        template: o.template,
        anchor: o.anchor,
        marginX: o.marginX,
        marginY: o.marginY,
        style: style(o.style),
        startNumber: o.startNumber,
        range: rangeChoice(o.range),
        mirror: o.mirror,
      });
      return withWorkspace(applyFurniture(ws, documentId, 'page-numbers', [overlay]));
    }
    case 'header-footer': {
      const o = step.options;
      const overlays = headerFooterOverlays({
        slots: o.slots,
        marginX: o.marginX,
        marginY: o.marginY,
        style: style(o.style),
        range: rangeChoice(o.range),
        mirror: o.mirror,
      });
      return withWorkspace(applyFurniture(ws, documentId, 'header-footer', overlays));
    }
    case 'bates': {
      const o = step.options;
      const overlay = batesOverlay({
        prefix: o.prefix,
        width: o.width,
        start: o.start,
        suffix: o.suffix,
        anchor: o.anchor,
        marginX: o.marginX,
        marginY: o.marginY,
        style: style(o.style),
      });
      const next = applyFurniture(ws, documentId, 'bates', [overlay]);
      return withWorkspace(
        setDocumentBates(next, documentId, {
          prefix: o.prefix,
          width: o.width,
          start: batesStartFor(o, context.batesNumberedBefore),
          suffix: o.suffix,
        }),
      );
    }
    case 'watermark': {
      const o = step.options;
      const settings: WatermarkSettings = {
        mode: o.mode,
        text: o.text,
        style: style(o.style),
        ...(o.mode === 'image' && o.image !== undefined
          ? { blob: context.addBlob(decodeBase64(o.image.data)) }
          : {}),
        scale: o.scale,
        rotate: o.rotate,
        tile: o.tile,
        gapX: o.gapX,
        gapY: o.gapY,
        layer: o.layer,
        range: rangeChoice(o.range),
      };
      const overlay = watermarkOverlay(settings);
      if (overlay === undefined) return state;
      if (overlay.kind === 'image') {
        return withWorkspace(
          updateDocumentOverlays(ws, documentId, (current) => [overlay, ...current]),
        );
      }
      return withWorkspace(applyFurniture(ws, documentId, 'watermark', [overlay]));
    }
    case 'flatten':
      return {
        ...state,
        exportOptions: {
          ...state.exportOptions,
          ...(step.options.annotations ? { flattenAnnotations: true } : {}),
          ...(step.options.forms ? { flattenForms: true } : {}),
        },
      };
    case 'compress': {
      const o = step.options;
      const base =
        o.preset === 'custom'
          ? presetSettings('custom', { dpi: o.dpi, quality: o.quality })
          : presetSettings(o.preset);
      const compression: CompressionSettings = {
        ...base,
        images: o.images,
        flattenAlpha: o.flattenAlpha,
        ...(o.linearize === true ? { linearize: true } : {}),
      };
      return { ...state, exportOptions: { ...state.exportOptions, compression } };
    }
    case 'metadata-strip':
      return withWorkspace(setMetadataStrip(ws, documentId, step.options));
    case 'metadata-set':
      return withWorkspace(setMetadata(ws, documentId, step.options));
    case 'security': {
      const password = context.outputPassword(stepIndex);
      if (password === undefined || password === '') {
        throw new StepError(m.batch_error_no_password());
      }
      return withWorkspace(
        setSecurity(ws, documentId, recipeSecurityPolicy(step.options, password)),
      );
    }
    case 'remove-password':
      return withWorkspace(removePassword(ws, documentId));
    case 'export': {
      const o = step.options;
      if (o.format !== 'pdf') return { ...state, output: o };
      return {
        ...state,
        output: o,
        exportOptions: {
          ...state.exportOptions,
          ...(o.compatibility === true ? { compatibility: true } : {}),
          ...(o.includeComments === false ? { includeComments: false } : {}),
        },
      };
    }
    case 'ocr':
      // planRecipeRun refuses plans with steps this build cannot run.
      throw new StepError(m.batch_error_unavailable());
  }
}
