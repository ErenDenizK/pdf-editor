/**
 * Batch recipes (ADR-0014, spec recognize-and-compare.md §5): an ordered list of operations
 * the app already exposes, applied to many files by the batch runner. This module holds
 * the file format (types, reader, writer, migrations), the secret-freedom check, the
 * built-in recipes, an i18n-neutral summary for the UI and the run plan. Pure: no DOM, no
 * engine; the web runner maps each step onto model operations and export options.
 *
 * Format rules (ADR-0014, binding):
 * - `{ "format": "pdf-editor-recipe", "version": 1, "name", "description"?, "steps" }`,
 *   every step `{ "kind", "options" }`. Unknown kinds, unknown keys (at any level) and
 *   wrong types are rejected with the step index and the key, never ignored.
 * - **No secrets are ever serialized.** The security step stores only that a password is
 *   required; the value is asked at run time (`planRecipeRun`) and held in memory. The
 *   reader and the writer refuse any password-like key (`assertNoSecrets`). Redaction is
 *   deliberately not a step: it needs a human review per document.
 * - `version` grows only for incompatible changes; older versions go through
 *   `RECIPE_MIGRATIONS` (one migration per past version), newer ones are refused with the
 *   app version they need.
 *
 * Option shapes mirror the app's dialogs field by field (named in each doc comment), so a
 * step's form reuses the dialog's controls and the runner reuses its operations. Lengths
 * are PDF points unless a field says otherwise.
 */
import { DocumentModelError } from './errors';
import { customKeyProblem, isLanguageTag, METADATA_TEXT_FIELDS } from './metadata';
import type { MetadataTextField } from './metadata';
import {
  ANCHOR_POSITIONS,
  MAX_PAGE_SIDE,
  MIN_PAGE_SIDE,
  PAPER_SIZES,
  type PaperSizeId,
  RESIZE_MODES,
  type ResizeRequest,
} from './resize';
import type {
  Anchor,
  MetadataStrip,
  OverlayLayer,
  PermissionFlags,
  ResizeMode,
  SecurityPolicy,
  Size,
} from './types';

// ---------------------------------------------------------------------------
// Format constants
// ---------------------------------------------------------------------------

export const RECIPE_FORMAT = 'pdf-editor-recipe';
/** The recipe format version this reader writes and reads natively. */
export const RECIPE_VERSION = 1;
/** File name suffix for imported and exported recipes (spec §5). */
export const RECIPE_FILE_EXTENSION = '.pdfrecipe.json';

/**
 * The first app release that reads each recipe format version, for the "newer version"
 * message. Filled in with the release version when the milestone ships (changeset); until
 * then the milestone name stands in.
 */
export const RECIPE_FORMAT_RELEASES: Readonly<Record<number, string>> = { 1: 'M5' };

/**
 * Stands for the app version a recipe newer than this reader needs: this build cannot know
 * it. The UI replaces it with its own wording ("a newer version of the app").
 */
export const RECIPE_NEWER_APP_PLACEHOLDER = '{newerAppVersion}';

export const MAX_RECIPE_NAME_LENGTH = 120;
export const MAX_RECIPE_DESCRIPTION_LENGTH = 2000;
export const MAX_RECIPE_STEPS = 64;
/** Furniture templates, watermark text and metadata values. */
export const MAX_RECIPE_TEXT_LENGTH = 1000;
/** Spec §5: an image watermark is embedded in the recipe (base64), at most 1 MB. */
export const MAX_RECIPE_IMAGE_BYTES = 1024 * 1024;
/** AES-256 (revision 6) uses at most 127 bytes of a UTF-8 password (document/password-form.ts). */
export const RECIPE_MAX_PASSWORD_BYTES = 127;

// ---------------------------------------------------------------------------
// Shared option shapes
// ---------------------------------------------------------------------------

/**
 * Which pages a page step applies to, by 1-based position in each file (spec §5 page
 * selectors). Replaces the dialogs' "selection / document / same size" scopes, which have
 * no meaning over many files. `landscape` and `portrait` compare the displayed size
 * (square pages count as portrait).
 */
export type RecipePageSelection =
  | 'all'
  | 'odd'
  | 'even'
  | 'first'
  | 'last'
  | 'landscape'
  | 'portrait'
  | { readonly ranges: readonly RecipePageRange[] };

/** 1-based, inclusive; without `to` the range runs to the last page. */
export interface RecipePageRange {
  readonly from: number;
  readonly to?: number;
}

export const RECIPE_PAGE_SELECTIONS = [
  'all',
  'odd',
  'even',
  'first',
  'last',
  'landscape',
  'portrait',
] as const;

/** Display unit of the crop and resize forms (`ResizeUnit`, stage/ResizeDialog.tsx). */
export type RecipeLengthUnit = 'mm' | 'in' | 'pt';

/** Font families of page furniture (`FONT_FAMILIES`, furniture/furniture-model.ts). */
export const RECIPE_FONT_FAMILIES = ['Inter', 'JetBrains Mono', 'Noto Serif'] as const;
export type RecipeFontFamily = (typeof RECIPE_FONT_FAMILIES)[number];

/** Text style of page furniture (`TextStyle`, furniture/furniture-model.ts). */
export interface RecipeTextStyle {
  /** `TextStyle.family`. */
  readonly family: RecipeFontFamily;
  /** `TextStyle.size`, points, 4–400 (the dialog's limits). */
  readonly size: number;
  /** `TextStyle.bold`. */
  readonly bold: boolean;
  /** `TextStyle.italic`. */
  readonly italic: boolean;
  /** `TextStyle.color`, `#rrggbb`. */
  readonly color: string;
  /** `TextStyle.opacity`, 0.05–1 (the dialog's 5–100 %). */
  readonly opacity: number;
}

/** `DEFAULT_TEXT_STYLE` of furniture/furniture-model.ts. */
export const RECIPE_DEFAULT_TEXT_STYLE: RecipeTextStyle = {
  family: 'Inter',
  size: 10,
  bold: false,
  italic: false,
  color: '#000000',
  opacity: 1,
};

/**
 * Furniture page range (`RangeChoice`, furniture/furniture-model.ts). `from` and `to` exist
 * only for `custom` (the dialog keeps them for every mode; the recipe does not).
 */
export type RecipeRange =
  | { readonly mode: 'all' | 'skip-first' | 'odd' | 'even' }
  | { readonly mode: 'custom'; readonly from: number; readonly to: number };

export const RECIPE_RANGE_MODES = ['all', 'skip-first', 'odd', 'even', 'custom'] as const;

/** Header/footer slots (`SLOTS`, furniture/furniture-model.ts). */
export const RECIPE_SLOTS = [
  'top-left',
  'top-center',
  'top-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
] as const satisfies readonly Anchor[];
export type RecipeSlot = (typeof RECIPE_SLOTS)[number];

/** An image embedded in a recipe (the watermark image), as base64. */
export interface RecipeImage {
  /** Media type, checked against the bytes' signature. */
  readonly type: 'image/png' | 'image/jpeg';
  /** Standard base64 (RFC 4648 §4, padded); at most `MAX_RECIPE_IMAGE_BYTES` decoded. */
  readonly data: string;
}

// ---------------------------------------------------------------------------
// Step options
// ---------------------------------------------------------------------------

/** Rotate pages (Pages panel rotate, `rotatePages`). */
export interface RecipeRotateOptions {
  /** Clockwise quarter turns: `rotatePages` delta = 90 × turns (rotate left = 3). */
  readonly quarterTurns: 1 | 2 | 3;
  /** The pages to turn (the panel's selection, as a rule). */
  readonly pages: RecipePageSelection;
}

/** Delete pages (`deletePages`). Never every page: a file must keep at least one. */
export interface RecipeDeletePagesOptions {
  readonly pages: RecipePageSelection;
}

/** Margins of the crop dialog (`Margins`, crop/geometry.ts), points, displayed sides. */
export interface RecipeMargins {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

/**
 * Crop pages (crop/CropDialog.tsx, `planCrops` → `setPageCropBox`). Hides content only:
 * the dialog's "Also remove the content outside the crop" runs the redaction pipeline and is
 * not a recipe option (ADR-0014 §2).
 */
export interface RecipeCropOptions {
  /** `CropDraft.margins`: distances from the displayed page edges, points. */
  readonly margins: RecipeMargins;
  /** `CropDraft.scope`, as a page rule. */
  readonly pages: RecipePageSelection;
  /** `CropDraft.unit`: the form's display unit only. */
  readonly unit?: RecipeLengthUnit;
}

/**
 * Resize pages (stage/ResizeDialog.tsx → `resizePages` with a `ResizeRequest`; see
 * `recipeResizeRequest`). The dialog's "Original size" preset only clears a resize and has
 * no meaning for a fresh file, so it is not offered.
 */
export interface RecipePageSizeOptions {
  /** `ResizePreset`: a paper size (`PAPER_SIZES`), or `custom` with `width` and `height`. */
  readonly preset: PaperSizeId | 'custom';
  /** Custom only: displayed width in points (3–14,400). */
  readonly width?: number;
  /** Custom only: displayed height in points (3–14,400). */
  readonly height?: number;
  /** Paper presets only: the dialog's orientation swap (landscape). */
  readonly landscape?: boolean;
  /** `ResizeRequest.matchOrientation`: keep each page's own orientation. */
  readonly matchOrientation?: boolean;
  /** `ResizeRequest.mode`: scale, fit or canvas. */
  readonly mode: ResizeMode;
  /** `ResizeRequest.anchor`, as seen on the displayed page. */
  readonly anchor: Anchor;
  /** `ResizeRequest.stretch`: only with `scale`. */
  readonly stretch?: boolean;
  /** `ResizeScope`, as a page rule. */
  readonly pages: RecipePageSelection;
  /** The form's display unit only. */
  readonly unit?: RecipeLengthUnit;
}

/** Page numbers (`PageNumberSettings` → `pageNumberOverlay`, furniture/furniture-model.ts). */
export interface RecipePageNumbersOptions {
  /** `template`: tokens {page}, {pages}, {label}, {title}, {date}. */
  readonly template: string;
  /** `anchor`. */
  readonly anchor: Anchor;
  /** `marginX`, points, 0–500. */
  readonly marginX: number;
  /** `marginY`, points, 0–500. */
  readonly marginY: number;
  /** `style`. */
  readonly style: RecipeTextStyle;
  /** `startNumber`: the number shown on the first page drawn on (≥ 0). */
  readonly startNumber: number;
  /** `range`. */
  readonly range: RecipeRange;
  /** `mirror`: mirror left/right on even pages. */
  readonly mirror: boolean;
}

/** Header and footer (`HeaderFooterSettings` → `headerFooterOverlays`). */
export interface RecipeHeaderFooterOptions {
  /** `slots`: a template per slot; empty slots draw nothing (at least one is filled). */
  readonly slots: Readonly<Record<RecipeSlot, string>>;
  /** `marginX`, points, 0–500. */
  readonly marginX: number;
  /** `marginY`, points, 0–500. */
  readonly marginY: number;
  /** `style`. */
  readonly style: RecipeTextStyle;
  /** `range`. */
  readonly range: RecipeRange;
  /** `mirror`. */
  readonly mirror: boolean;
}

/** Bates numbering (`BatesSettings` → `batesOverlay` and `setDocumentBates`). */
export interface RecipeBatesOptions {
  /** `prefix`. */
  readonly prefix: string;
  /** `width`: minimum digits, 1–12. */
  readonly width: number;
  /** `start`: number of the first page (≥ 0). */
  readonly start: number;
  /** `suffix`. */
  readonly suffix: string;
  /** `anchor`. */
  readonly anchor: Anchor;
  /** `marginX`, points, 0–500. */
  readonly marginX: number;
  /** `marginY`, points, 0–500. */
  readonly marginY: number;
  /** `style`. */
  readonly style: RecipeTextStyle;
  /**
   * One counter across the whole batch, in file order (spec §5; the dialog's run over
   * several tabs, `planBatesRun`); otherwise every file starts at `start`.
   */
  readonly continuous: boolean;
}

/** Watermark (`WatermarkSettings` → `watermarkOverlay`). */
export interface RecipeWatermarkOptions {
  /** `mode`. */
  readonly mode: 'text' | 'image';
  /** `text`: the text watermark (non-blank in text mode). */
  readonly text: string;
  /** `style` (image mode uses its opacity only). */
  readonly style: RecipeTextStyle;
  /** Image mode only, required there: replaces `blob` (spec §5: embedded, ≤ 1 MB). */
  readonly image?: RecipeImage;
  /** `scale`: image scale, 0.05–4 (1 = 72 dpi). */
  readonly scale: number;
  /** `rotate`: counter-clockwise degrees, −90…90. */
  readonly rotate: number;
  /** `tile`. */
  readonly tile: boolean;
  /** `gapX`, points ≥ 0. */
  readonly gapX: number;
  /** `gapY`, points ≥ 0. */
  readonly gapY: number;
  /** `layer`: behind or over the content. */
  readonly layer: OverlayLayer;
  /** `range`. */
  readonly range: RecipeRange;
}

/** Flatten (`ExportOptions.flattenAnnotations` / `flattenForms`, export/export-service.ts). */
export interface RecipeFlattenOptions {
  /** `flattenAnnotations`: bake annotations into the page content. */
  readonly annotations: boolean;
  /** `flattenForms`: bake form fields and remove the form. */
  readonly forms: boolean;
}

/** Compression preset ids (`CompressionPresetId` of the engine, without `custom`). */
export type RecipeCompressionPreset = 'screen' | 'ebook' | 'print';
export const RECIPE_COMPRESSION_PRESETS = ['screen', 'ebook', 'print'] as const;
/** The engine's `MIN_DPI` / `MAX_DPI` (compress/presets.ts). */
export const RECIPE_MIN_COMPRESS_DPI = 36;
export const RECIPE_MAX_COMPRESS_DPI = 1200;

interface RecipeCompressFlags {
  /** `CompressionSettings.images`: run the image pass (off = lossless only). */
  readonly images: boolean;
  /** `CompressionSettings.flattenAlpha`: composite soft-masked images onto white. */
  readonly flattenAlpha: boolean;
  /** `CompressionSettings.linearize`: fast web view. */
  readonly linearize?: boolean;
}

/**
 * Compress (tools/CompressDialog.tsx; `ExportOptions.compression`). A preset takes the
 * engine's `presetSettings(preset)`; `custom` carries its own resolution and quality.
 */
export type RecipeCompressOptions =
  | (RecipeCompressFlags & { readonly preset: RecipeCompressionPreset })
  | (RecipeCompressFlags & {
      readonly preset: 'custom';
      /** `CompressionSettings.dpi`: target resolution, 36–1200. */
      readonly dpi: number;
      /** `CompressionSettings.quality`: JPEG quality, 1–100. */
      readonly quality: number;
    });

/**
 * Strip metadata (document/strip-items.ts checklist → `setMetadataStrip`): the
 * `MetadataStrip` flags, at least one set.
 */
export type RecipeMetadataStripOptions = MetadataStrip;

/**
 * Set metadata fields (document/MetadataEditor.tsx → `setMetadata` with a `MetadataPatch`):
 * a string sets a field (blank removes it), `null` removes it, an absent key leaves it.
 * `custom` replaces the custom Info keys.
 */
export type RecipeMetadataSetOptions = Readonly<
  Partial<Record<MetadataTextField, string | null>>
> & {
  readonly custom?: Readonly<Record<string, string>> | null;
};

/**
 * Set password (document/DocumentDialogs.tsx password form → `setSecurity`). The recipe
 * stores only that a user (open) password is required and the permissions; the password
 * is asked once when the recipe runs and never stored. With restrictions and no owner
 * password, the export generates a random owner password (`validatePasswordForm`), so
 * nobody can lift them later.
 */
export interface RecipeSecurityOptions {
  /** Always `true`: the password value itself never enters a recipe. */
  readonly requirePassword: true;
  /** `SecurityPolicy.permissions`. */
  readonly permissions: PermissionFlags;
}

/** Remove password (`removePassword`; `ExportOptions.security = null`). No options. */
export type RecipeRemovePasswordOptions = Readonly<Record<string, never>>;

/**
 * OCR (spec §1; reserved until workstream W1 lands: validated, but steps of this kind do
 * not run yet, see `recipeStepAvailability`).
 */
export interface RecipeOcrOptions {
  /** Tesseract language codes (`eng`, `tur`, `chi_sim`, …), 1–8, no duplicates. */
  readonly languages: readonly string[];
  /** Render resolution for recognition, 200–400 dpi (spec §1.2: 300, High 400). */
  readonly dpi: number;
  /** Pages to recognize: those without visible text (the default), or all. */
  readonly scope: 'without-text' | 'all';
}

/** `RasterFormat` of the engine (rasterize/plan.ts). */
export type RecipeImageFormat = 'png' | 'jpeg' | 'webp';
/** The engine's `MIN_RASTER_DPI` / `MAX_RASTER_DPI`. */
export const RECIPE_MIN_RASTER_DPI = 18;
export const RECIPE_MAX_RASTER_DPI = 1200;

/**
 * The output (always the last step; without one the output is a PDF with the export
 * dialog's defaults). Flattening, compression, security and metadata are steps of their
 * own; the ZIP-or-files delivery is chosen when the batch runs.
 */
export type RecipeExportOptions =
  | {
      /** export/ExportDialog.tsx → `prepareExport`. */
      readonly format: 'pdf';
      /** `ExportOptions.compatibility` (off by default). */
      readonly compatibility?: boolean;
      /** `ExportOptions.includeComments` (on by default). */
      readonly includeComments?: boolean;
    }
  | {
      /** tools/ImageExportDialog.tsx → `rasterizeDocument` (one ZIP per file). */
      readonly format: 'images';
      /** `RasterOptions.format`. */
      readonly imageFormat: RecipeImageFormat;
      /** `RasterOptions.dpi`, 18–1200. */
      readonly dpi: number;
      /** `RasterOptions.quality`, 1–100 (JPEG and WebP). */
      readonly quality: number;
      /** `RasterOptions.background`; JPEG is always white. */
      readonly background: 'white' | 'transparent';
    }
  | {
      /** Spec §4 "Export as Markdown / text" (reserved until workstream W2 lands). */
      readonly format: 'markdown' | 'text';
      /** Page breaks: nothing, a rule (`---`) or a comment (`<!-- page 3 -->`). */
      readonly pageBreaks?: 'none' | 'rule' | 'comment';
    };

/** Every step kind with its options. */
export interface RecipeStepOptionsMap {
  readonly rotate: RecipeRotateOptions;
  readonly 'delete-pages': RecipeDeletePagesOptions;
  readonly crop: RecipeCropOptions;
  readonly 'page-size': RecipePageSizeOptions;
  readonly 'page-numbers': RecipePageNumbersOptions;
  readonly 'header-footer': RecipeHeaderFooterOptions;
  readonly bates: RecipeBatesOptions;
  readonly watermark: RecipeWatermarkOptions;
  readonly flatten: RecipeFlattenOptions;
  readonly compress: RecipeCompressOptions;
  readonly 'metadata-strip': RecipeMetadataStripOptions;
  readonly 'metadata-set': RecipeMetadataSetOptions;
  readonly security: RecipeSecurityOptions;
  readonly 'remove-password': RecipeRemovePasswordOptions;
  readonly ocr: RecipeOcrOptions;
  readonly export: RecipeExportOptions;
}

export type RecipeStepKind = keyof RecipeStepOptionsMap;

export const RECIPE_STEP_KINDS: readonly RecipeStepKind[] = [
  'rotate',
  'delete-pages',
  'crop',
  'page-size',
  'page-numbers',
  'header-footer',
  'bates',
  'watermark',
  'flatten',
  'compress',
  'metadata-strip',
  'metadata-set',
  'security',
  'remove-password',
  'ocr',
  'export',
];

export type RecipeStep = {
  readonly [K in RecipeStepKind]: { readonly kind: K; readonly options: RecipeStepOptionsMap[K] };
}[RecipeStepKind];

export type RecipeStepOf<K extends RecipeStepKind> = Extract<RecipeStep, { readonly kind: K }>;

export interface Recipe {
  readonly format: typeof RECIPE_FORMAT;
  readonly version: typeof RECIPE_VERSION;
  readonly name: string;
  readonly description?: string;
  readonly steps: readonly RecipeStep[];
}

export function isRecipeStepKind(value: unknown): value is RecipeStepKind {
  return RECIPE_STEP_KINDS.includes(value as RecipeStepKind);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** What is wrong with a recipe; the UI words its message from this and the fields. */
export type RecipeProblem =
  | 'not-json'
  | 'not-recipe'
  | 'newer-version'
  | 'unsupported-version'
  | 'unknown-kind'
  | 'unknown-key'
  | 'missing-key'
  | 'invalid-value'
  | 'secret'
  | 'step-order';

/**
 * A recipe that cannot be read or written. `code` is `unsupported-version` for version
 * problems and `invalid-serialized` otherwise. Messages name the step (1-based, with its
 * kind) and the key; they never echo a value that could be a secret.
 */
export class RecipeError extends DocumentModelError {
  readonly problem: RecipeProblem;
  /** JSON path of the offending value, e.g. `$.steps[2].options.dpi`. */
  readonly path: string;
  /** 0-based index of the offending step, when a step is at fault. */
  readonly stepIndex: number | undefined;
  /** Kind of that step, once known to be valid. */
  readonly stepKind: RecipeStepKind | undefined;
  /** The offending (or missing) key. */
  readonly key: string | undefined;
  /** `newer-version` / `unsupported-version`: the recipe's version. */
  readonly version: number | undefined;
  /**
   * `newer-version`: the app version needed, from `RECIPE_FORMAT_RELEASES`, else
   * `RECIPE_NEWER_APP_PLACEHOLDER`.
   */
  readonly neededAppVersion: string | undefined;

  constructor(
    problem: RecipeProblem,
    message: string,
    details: {
      readonly path?: string;
      readonly stepIndex?: number | undefined;
      readonly stepKind?: RecipeStepKind | undefined;
      readonly key?: string | undefined;
      readonly version?: number;
      readonly neededAppVersion?: string;
      readonly cause?: unknown;
    } = {},
  ) {
    super(
      problem === 'newer-version' || problem === 'unsupported-version'
        ? 'unsupported-version'
        : 'invalid-serialized',
      message,
      details.cause === undefined ? undefined : { cause: details.cause },
    );
    this.name = 'RecipeError';
    this.problem = problem;
    this.path = details.path ?? '$';
    this.stepIndex = details.stepIndex;
    this.stepKind = details.stepKind;
    this.key = details.key;
    this.version = details.version;
    this.neededAppVersion = details.neededAppVersion;
  }
}

export function isRecipeError(value: unknown, problem?: RecipeProblem): value is RecipeError {
  return value instanceof RecipeError && (problem === undefined || value.problem === problem);
}

/** Where a value sits: its JSON path, its path inside the step, and the step. */
class At {
  private constructor(
    readonly path: string,
    readonly local: string,
    readonly stepIndex: number | undefined,
    readonly stepKind: RecipeStepKind | undefined,
    readonly key: string | undefined,
  ) {}

  static root(): At {
    return new At('$', '', undefined, undefined, undefined);
  }

  static step(index: number, kind: RecipeStepKind | undefined): At {
    return new At(`$.steps[${index}]`, '', index, kind, undefined);
  }

  child(key: string): At {
    const local = this.local === '' ? key : `${this.local}.${key}`;
    return new At(`${this.path}.${key}`, local, this.stepIndex, this.stepKind, key);
  }

  item(index: number): At {
    return new At(
      `${this.path}[${index}]`,
      `${this.local}[${index}]`,
      this.stepIndex,
      this.stepKind,
      this.key,
    );
  }

  /** "Step 3 (compress), options.dpi" or "Recipe name". */
  where(): string {
    if (this.stepIndex !== undefined) {
      const head = `Step ${this.stepIndex + 1}${this.stepKind === undefined ? '' : ` (${this.stepKind})`}`;
      return this.local === '' ? head : `${head}, ${this.local}`;
    }
    return this.local === '' ? 'Recipe' : `Recipe ${this.local}`;
  }

  /** Fails about `key` of this object: the message names this object, the path the key. */
  failKey(problem: RecipeProblem, key: string, detail: string): never {
    throw new RecipeError(problem, `${this.where()}: ${detail}`, {
      path: this.child(key).path,
      stepIndex: this.stepIndex,
      stepKind: this.stepKind,
      key,
    });
  }

  fail(problem: RecipeProblem, detail: string, key: string | undefined = this.key): never {
    throw new RecipeError(problem, `${this.where()}: ${detail}`, {
      path: this.path,
      stepIndex: this.stepIndex,
      stepKind: this.stepKind,
      key,
    });
  }
}

/** A key or kind for a message: quoted, control characters escaped, at most 40 characters. */
function quoted(text: string): string {
  const short = text.length > 40 ? `${text.slice(0, 39)}…` : text;
  return JSON.stringify(short);
}

// ---------------------------------------------------------------------------
// Secret freedom
// ---------------------------------------------------------------------------

/** Key names (lowercase, letters only) that always denote a secret, whatever their value. */
const SECRET_KEYS: ReadonlySet<string> = new Set([
  'password',
  'passwords',
  'pass',
  'passwd',
  'passphrase',
  'pwd',
  'secret',
  'secrets',
  'pin',
  'userpassword',
  'ownerpassword',
  'sourcepassword',
  'openpassword',
  'permissionspassword',
  'privatekey',
  'token',
]);

/** Keys ending like this denote a secret when they hold text or a number (not a flag). */
const SECRET_SUFFIX = /(?:password|passwd|passphrase|secret|pwd)$/;

function isSecretKey(key: string, value: unknown): boolean {
  const name = key.toLowerCase().replace(/[^a-z]/g, '');
  if (SECRET_KEYS.has(name)) return true;
  return (typeof value === 'string' || typeof value === 'number') && SECRET_SUFFIX.test(name);
}

const SECRET_MESSAGE =
  'recipes never store passwords or other secrets (a password is asked when the recipe runs)';

function scanSecrets(value: unknown, at: At, known: readonly string[], depth: number): void {
  if (depth > 32) at.fail('invalid-value', 'nested more than 32 levels');
  if (typeof value === 'string') {
    if (known.some((secret) => secret !== '' && value.includes(secret))) {
      at.fail('secret', SECRET_MESSAGE);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item: unknown, i) => {
      scanSecrets(item, at.item(i), known, depth + 1);
    });
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    const next = at.child(key);
    if (isSecretKey(key, child)) {
      at.failKey('secret', key, `${quoted(key)} is not allowed: ${SECRET_MESSAGE}`);
    }
    if (depth === 0 && key === 'steps' && Array.isArray(child)) {
      child.forEach((step: unknown, i) => {
        const kind = isObject(step) && isRecipeStepKind(step.kind) ? step.kind : undefined;
        const stepAt = At.step(i, kind);
        if (isObject(step)) {
          for (const [k, v] of Object.entries(step)) {
            const inner = stepAt.child(k);
            if (isSecretKey(k, v)) {
              stepAt.failKey('secret', k, `${quoted(k)} is not allowed: ${SECRET_MESSAGE}`);
            }
            scanSecrets(v, inner, known, depth + 2);
          }
        } else {
          scanSecrets(step, stepAt, known, depth + 1);
        }
      });
      continue;
    }
    scanSecrets(child, next, known, depth + 1);
  }
}

/**
 * Throws a `RecipeError` (`secret`) when `json` (a recipe, its JSON text or any JSON value)
 * holds a secret: a key named like a password, PIN, token or secret (`password`, `pass`,
 * `pin`, `userPassword`, …, or any key ending in "password"/"secret" that holds text or a
 * number; flags such as `requirePassword: true` are fine), or any of `knownSecrets` (the
 * run-time passwords held in memory) inside a string or the raw text. The message names
 * where, never the value.
 */
export function assertNoSecrets(json: unknown, knownSecrets: readonly string[] = []): void {
  const known = knownSecrets.filter((s) => s !== '');
  let value = json;
  if (typeof json === 'string') {
    if (known.some((secret) => json.includes(secret))) At.root().fail('secret', SECRET_MESSAGE);
    try {
      value = JSON.parse(json);
    } catch (cause) {
      throw new RecipeError('not-json', 'Recipe: the file is not valid JSON', { cause });
    }
  }
  scanSecrets(value, At.root(), known, 0);
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

/** Turns a recipe of version n (raw JSON) into version n + 1. */
export type RecipeMigration = (
  recipe: Readonly<Record<string, unknown>>,
) => Record<string, unknown>;

/** Migrations by the version they read (0 → 1 is under key 0). */
export type RecipeMigrations = Readonly<Partial<Record<number, RecipeMigration>>>;

/**
 * One migration per past format version (ADR-0014 §4). Version 1 is the first, so there is
 * none yet; a future version 2 adds `1: (v1) => v2` here and keeps it for good.
 */
export const RECIPE_MIGRATIONS: RecipeMigrations = {};

function migrate(root: Obj, from: number, migrations: RecipeMigrations): Obj {
  let current = root;
  for (let version = from; version < RECIPE_VERSION; version++) {
    const step = migrations[version];
    if (step === undefined) {
      throw new RecipeError(
        'unsupported-version',
        `Recipe: format version ${from} cannot be read (no migration from version ${version} to ${version + 1})`,
        { path: '$.version', key: 'version', version: from },
      );
    }
    const next = step(current);
    if (next.version !== version + 1) {
      throw new RecipeError(
        'unsupported-version',
        `Recipe: the migration from version ${version} did not produce version ${version + 1}`,
        { path: '$.version', key: 'version', version: from },
      );
    }
    current = next;
  }
  return current;
}

// ---------------------------------------------------------------------------
// Reader primitives
// ---------------------------------------------------------------------------

type Obj = Readonly<Record<string, unknown>>;

function isObject(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

function obj(value: unknown, at: At): Obj {
  if (!isObject(value)) at.fail('invalid-value', `expected an object, got ${describeType(value)}`);
  return value;
}

/** Rejects keys outside `allowed` (ADR-0014: unknown keys are rejected, not ignored). */
function only(o: Obj, at: At, allowed: readonly string[]): void {
  for (const key of Object.keys(o)) {
    if (!allowed.includes(key)) {
      const what = at.local === 'options' ? 'option key' : 'key';
      at.failKey('unknown-key', key, `unknown ${what} ${quoted(key)}`);
    }
  }
}

/** The value under `key`; a missing (or undefined) value fails with `missing-key`. */
function need(o: Obj, key: string, at: At): unknown {
  const value = o[key];
  if (value === undefined) at.failKey('missing-key', key, `missing ${quoted(key)}`);
  return value;
}

function has(o: Obj, key: string): boolean {
  return o[key] !== undefined;
}

function forbid(o: Obj, key: string, at: At, reason: string): void {
  if (has(o, key)) at.child(key).fail('invalid-value', reason, key);
}

function bool(value: unknown, at: At): boolean {
  if (typeof value !== 'boolean')
    at.fail('invalid-value', `expected true or false, got ${describeType(value)}`);
  return value;
}

function range(min: number, max: number): string {
  return max === Number.MAX_SAFE_INTEGER ? `${min} or more` : `from ${min} to ${max}`;
}

function num(value: unknown, at: At, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    at.fail('invalid-value', `expected a number ${range(min, max)}`);
  }
  return value;
}

function int(value: unknown, at: At, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    at.fail('invalid-value', `expected an integer ${range(min, max)}`);
  }
  return value as number;
}

function str(
  value: unknown,
  at: At,
  options: { readonly max?: number; readonly nonBlank?: boolean } = {},
): string {
  if (typeof value !== 'string')
    at.fail('invalid-value', `expected a string, got ${describeType(value)}`);
  if (options.nonBlank === true && value.trim() === '')
    at.fail('invalid-value', 'expected a non-empty string');
  const max = options.max ?? MAX_RECIPE_TEXT_LENGTH;
  if (value.length > max) at.fail('invalid-value', `expected at most ${max} characters`);
  return value;
}

function oneOf<T extends string | number>(value: unknown, at: At, options: readonly T[]): T {
  if (!options.includes(value as T)) {
    at.fail('invalid-value', `expected one of ${options.map((o) => JSON.stringify(o)).join(', ')}`);
  }
  return value as T;
}

function arr(value: unknown, at: At, min: number, max: number): readonly unknown[] {
  if (!Array.isArray(value))
    at.fail('invalid-value', `expected an array, got ${describeType(value)}`);
  if (value.length < min || value.length > max) {
    at.fail('invalid-value', `expected ${min === max ? min : range(min, max)} items`);
  }
  return value;
}

/** A spreadable optional property ({} when absent). */
function opt<K extends string, T>(
  o: Obj,
  key: K,
  at: At,
  read: (value: unknown, at: At) => T,
): Partial<Record<K, T>> {
  const value = o[key];
  if (value === undefined) return {};
  return { [key]: read(value, at.child(key)) } as Partial<Record<K, T>>;
}

/** Reads a required property. */
function field<T>(o: Obj, key: string, at: At, read: (value: unknown, at: At) => T): T {
  return read(need(o, key, at), at.child(key));
}

// ---------------------------------------------------------------------------
// Shared readers
// ---------------------------------------------------------------------------

function readPages(value: unknown, at: At): RecipePageSelection {
  if (typeof value === 'string') return oneOf(value, at, RECIPE_PAGE_SELECTIONS);
  if (!isObject(value)) {
    at.fail(
      'invalid-value',
      `expected one of ${RECIPE_PAGE_SELECTIONS.map((s) => JSON.stringify(s)).join(', ')} or { "ranges": [...] }`,
    );
  }
  only(value, at, ['ranges']);
  const ranges = field(value, 'ranges', at, (v, a) =>
    arr(v, a, 1, 100).map((item, i) => {
      const ia = a.item(i);
      const r = obj(item, ia);
      only(r, ia, ['from', 'to']);
      const from = field(r, 'from', ia, (x, xa) => int(x, xa, 1, Number.MAX_SAFE_INTEGER));
      const to = opt(r, 'to', ia, (x, xa) => int(x, xa, from, Number.MAX_SAFE_INTEGER));
      return { from, ...to };
    }),
  );
  return { ranges };
}

function readUnit(value: unknown, at: At): RecipeLengthUnit {
  return oneOf(value, at, ['mm', 'in', 'pt'] as const);
}

function readAnchor(value: unknown, at: At): Anchor {
  return oneOf(value, at, ANCHOR_POSITIONS);
}

function readColor(value: unknown, at: At): string {
  if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) {
    at.fail('invalid-value', 'expected a colour as #rrggbb');
  }
  return value;
}

function readStyle(value: unknown, at: At): RecipeTextStyle {
  const o = obj(value, at);
  only(o, at, ['family', 'size', 'bold', 'italic', 'color', 'opacity']);
  return {
    family: field(o, 'family', at, (v, a) => oneOf(v, a, RECIPE_FONT_FAMILIES)),
    size: field(o, 'size', at, (v, a) => num(v, a, 4, 400)),
    bold: field(o, 'bold', at, bool),
    italic: field(o, 'italic', at, bool),
    color: field(o, 'color', at, readColor),
    opacity: field(o, 'opacity', at, (v, a) => num(v, a, 0.05, 1)),
  };
}

function readRange(value: unknown, at: At): RecipeRange {
  const o = obj(value, at);
  only(o, at, ['mode', 'from', 'to']);
  const mode = field(o, 'mode', at, (v, a) => oneOf(v, a, RECIPE_RANGE_MODES));
  if (mode !== 'custom') {
    forbid(o, 'from', at, 'only with mode "custom"');
    forbid(o, 'to', at, 'only with mode "custom"');
    return { mode };
  }
  const from = field(o, 'from', at, (v, a) => int(v, a, 1, Number.MAX_SAFE_INTEGER));
  const to = field(o, 'to', at, (v, a) => int(v, a, from, Number.MAX_SAFE_INTEGER));
  return { mode, from, to };
}

function readMargin(value: unknown, at: At): number {
  return num(value, at, 0, 500);
}

function readPermissions(value: unknown, at: At): PermissionFlags {
  const o = obj(value, at);
  const keys = [
    'print',
    'printHighQuality',
    'modify',
    'copy',
    'annotate',
    'fillForms',
    'accessibility',
    'assemble',
  ] as const;
  only(o, at, keys);
  const flag = (key: (typeof keys)[number]) => field(o, key, at, bool);
  return {
    print: flag('print'),
    printHighQuality: flag('printHighQuality'),
    modify: flag('modify'),
    copy: flag('copy'),
    annotate: flag('annotate'),
    fillForms: flag('fillForms'),
    accessibility: flag('accessibility'),
    assemble: flag('assemble'),
  };
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Decodes the first bytes of a base64 string (enough for a file signature). */
function base64Head(data: string, bytes: number): number[] {
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of data) {
    if (char === '=' || out.length >= bytes) break;
    buffer = (buffer << 6) | BASE64.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return out;
}

/** Decoded size of padded base64. */
export function base64ByteLength(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return (data.length / 4) * 3 - padding;
}

function readImage(value: unknown, at: At): RecipeImage {
  const o = obj(value, at);
  only(o, at, ['type', 'data']);
  const type = field(o, 'type', at, (v, a) => oneOf(v, a, ['image/png', 'image/jpeg'] as const));
  const dataAt: At = at.child('data');
  const data = need(o, 'data', at);
  if (
    typeof data !== 'string' ||
    data.length === 0 ||
    data.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
  ) {
    dataAt.fail('invalid-value', 'expected padded standard base64');
  }
  if (base64ByteLength(data) > MAX_RECIPE_IMAGE_BYTES) {
    dataAt.fail('invalid-value', `the image is larger than ${MAX_RECIPE_IMAGE_BYTES} bytes (1 MB)`);
  }
  const head = base64Head(data, 8);
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => head[i] === b);
  const jpeg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  if (type === 'image/png' ? !png : !jpeg) {
    dataAt.fail(
      'invalid-value',
      `the bytes are not a ${type === 'image/png' ? 'PNG' : 'JPEG'} image`,
    );
  }
  return { type, data };
}

function sortedRecord(record: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

// ---------------------------------------------------------------------------
// Step readers
// ---------------------------------------------------------------------------

type StepReader<K extends RecipeStepKind> = (o: Obj, at: At) => RecipeStepOptionsMap[K];

const STEP_READERS: { readonly [K in RecipeStepKind]: StepReader<K> } = {
  rotate: (o, at) => {
    only(o, at, ['quarterTurns', 'pages']);
    return {
      quarterTurns: field(o, 'quarterTurns', at, (v, a) => oneOf(v, a, [1, 2, 3] as const)),
      pages: field(o, 'pages', at, readPages),
    };
  },

  'delete-pages': (o, at) => {
    only(o, at, ['pages']);
    const pages = field(o, 'pages', at, readPages);
    if (pages === 'all') {
      at.child('pages').fail('invalid-value', 'deleting every page would leave nothing to export');
    }
    return { pages };
  },

  crop: (o, at) => {
    only(o, at, ['margins', 'pages', 'unit']);
    const margins = field(o, 'margins', at, (v, a) => {
      const m = obj(v, a);
      only(m, a, ['top', 'right', 'bottom', 'left']);
      const side = (key: string) => field(m, key, a, (x, xa) => num(x, xa, 0, MAX_PAGE_SIDE));
      const out = {
        top: side('top'),
        right: side('right'),
        bottom: side('bottom'),
        left: side('left'),
      };
      if (out.top === 0 && out.right === 0 && out.bottom === 0 && out.left === 0) {
        a.fail(
          'invalid-value',
          'expected at least one margin above 0 (a zero crop changes nothing)',
        );
      }
      return out;
    });
    return {
      margins,
      pages: field(o, 'pages', at, readPages),
      ...opt(o, 'unit', at, readUnit),
    };
  },

  'page-size': (o, at) => {
    only(o, at, [
      'preset',
      'width',
      'height',
      'landscape',
      'matchOrientation',
      'mode',
      'anchor',
      'stretch',
      'pages',
      'unit',
    ]);
    const preset = field(o, 'preset', at, (v, a) =>
      oneOf(v, a, [...(Object.keys(PAPER_SIZES) as PaperSizeId[]), 'custom' as const]),
    );
    let size: { width?: number; height?: number; landscape?: boolean };
    if (preset === 'custom') {
      forbid(
        o,
        'landscape',
        at,
        'only with a paper preset (a custom size has its own orientation)',
      );
      const side = (v: unknown, a: At) => num(v, a, MIN_PAGE_SIDE, MAX_PAGE_SIDE);
      size = { width: field(o, 'width', at, side), height: field(o, 'height', at, side) };
    } else {
      forbid(o, 'width', at, 'only with preset "custom"');
      forbid(o, 'height', at, 'only with preset "custom"');
      size = opt(o, 'landscape', at, bool);
    }
    const mode = field(o, 'mode', at, (v, a) => oneOf(v, a, RESIZE_MODES));
    const stretch = opt(o, 'stretch', at, bool);
    if (stretch.stretch === true && mode !== 'scale') {
      at.child('stretch').fail('invalid-value', 'stretch applies to the "scale" mode only');
    }
    return {
      preset,
      ...size,
      ...opt(o, 'matchOrientation', at, bool),
      mode,
      anchor: field(o, 'anchor', at, readAnchor),
      ...stretch,
      pages: field(o, 'pages', at, readPages),
      ...opt(o, 'unit', at, readUnit),
    };
  },

  'page-numbers': (o, at) => {
    only(o, at, [
      'template',
      'anchor',
      'marginX',
      'marginY',
      'style',
      'startNumber',
      'range',
      'mirror',
    ]);
    return {
      template: field(o, 'template', at, (v, a) => str(v, a, { nonBlank: true })),
      anchor: field(o, 'anchor', at, readAnchor),
      marginX: field(o, 'marginX', at, readMargin),
      marginY: field(o, 'marginY', at, readMargin),
      style: field(o, 'style', at, readStyle),
      startNumber: field(o, 'startNumber', at, (v, a) => int(v, a, 0, Number.MAX_SAFE_INTEGER)),
      range: field(o, 'range', at, readRange),
      mirror: field(o, 'mirror', at, bool),
    };
  },

  'header-footer': (o, at) => {
    only(o, at, ['slots', 'marginX', 'marginY', 'style', 'range', 'mirror']);
    const slots = field(o, 'slots', at, (v, a) => {
      const s = obj(v, a);
      only(s, a, RECIPE_SLOTS);
      const out = Object.fromEntries(
        RECIPE_SLOTS.map((slot) => [slot, field(s, slot, a, (x, xa) => str(x, xa))]),
      ) as Record<RecipeSlot, string>;
      if (RECIPE_SLOTS.every((slot) => out[slot].trim() === '')) {
        a.fail('invalid-value', 'expected at least one filled slot');
      }
      return out;
    });
    return {
      slots,
      marginX: field(o, 'marginX', at, readMargin),
      marginY: field(o, 'marginY', at, readMargin),
      style: field(o, 'style', at, readStyle),
      range: field(o, 'range', at, readRange),
      mirror: field(o, 'mirror', at, bool),
    };
  },

  bates: (o, at) => {
    only(o, at, [
      'prefix',
      'width',
      'start',
      'suffix',
      'anchor',
      'marginX',
      'marginY',
      'style',
      'continuous',
    ]);
    return {
      prefix: field(o, 'prefix', at, (v, a) => str(v, a, { max: 64 })),
      width: field(o, 'width', at, (v, a) => int(v, a, 1, 12)),
      start: field(o, 'start', at, (v, a) => int(v, a, 0, Number.MAX_SAFE_INTEGER)),
      suffix: field(o, 'suffix', at, (v, a) => str(v, a, { max: 64 })),
      anchor: field(o, 'anchor', at, readAnchor),
      marginX: field(o, 'marginX', at, readMargin),
      marginY: field(o, 'marginY', at, readMargin),
      style: field(o, 'style', at, readStyle),
      continuous: field(o, 'continuous', at, bool),
    };
  },

  watermark: (o, at) => {
    only(o, at, [
      'mode',
      'text',
      'style',
      'image',
      'scale',
      'rotate',
      'tile',
      'gapX',
      'gapY',
      'layer',
      'range',
    ]);
    const mode = field(o, 'mode', at, (v, a) => oneOf(v, a, ['text', 'image'] as const));
    const text = field(o, 'text', at, (v, a) => str(v, a, { nonBlank: mode === 'text' }));
    const style = field(o, 'style', at, readStyle);
    let image: { image?: RecipeImage } = {};
    if (mode === 'image') image = { image: field(o, 'image', at, readImage) };
    else forbid(o, 'image', at, 'only with mode "image"');
    return {
      mode,
      text,
      style,
      ...image,
      scale: field(o, 'scale', at, (v, a) => num(v, a, 0.05, 4)),
      rotate: field(o, 'rotate', at, (v, a) => int(v, a, -90, 90)),
      tile: field(o, 'tile', at, bool),
      gapX: field(o, 'gapX', at, (v, a) => num(v, a, 0, MAX_PAGE_SIDE)),
      gapY: field(o, 'gapY', at, (v, a) => num(v, a, 0, MAX_PAGE_SIDE)),
      layer: field(o, 'layer', at, (v, a) => oneOf(v, a, ['behind', 'over'] as const)),
      range: field(o, 'range', at, readRange),
    };
  },

  flatten: (o, at) => {
    only(o, at, ['annotations', 'forms']);
    const out = {
      annotations: field(o, 'annotations', at, bool),
      forms: field(o, 'forms', at, bool),
    };
    if (!out.annotations && !out.forms)
      at.fail('invalid-value', 'expected annotations, forms or both');
    return out;
  },

  compress: (o, at) => {
    only(o, at, ['preset', 'dpi', 'quality', 'images', 'flattenAlpha', 'linearize']);
    const preset = field(o, 'preset', at, (v, a) =>
      oneOf(v, a, [...RECIPE_COMPRESSION_PRESETS, 'custom' as const]),
    );
    const flags = () => ({
      images: field(o, 'images', at, bool),
      flattenAlpha: field(o, 'flattenAlpha', at, bool),
      ...opt(o, 'linearize', at, bool),
    });
    if (preset !== 'custom') {
      forbid(o, 'dpi', at, 'only with preset "custom" (a preset sets its own resolution)');
      forbid(o, 'quality', at, 'only with preset "custom" (a preset sets its own quality)');
      return { preset, ...flags() };
    }
    return {
      preset,
      dpi: field(o, 'dpi', at, (v, a) =>
        int(v, a, RECIPE_MIN_COMPRESS_DPI, RECIPE_MAX_COMPRESS_DPI),
      ),
      quality: field(o, 'quality', at, (v, a) => int(v, a, 1, 100)),
      ...flags(),
    };
  },

  'metadata-strip': (o, at) => {
    const keys = [
      'info',
      'xmp',
      'attachments',
      'javascript',
      'pieceInfo',
      'thumbnails',
      'annotationAuthors',
      'customKeys',
    ] as const;
    only(o, at, keys);
    const out = Object.fromEntries(keys.map((key) => [key, field(o, key, at, bool)])) as Record<
      (typeof keys)[number],
      boolean
    >;
    if (!keys.some((key) => out[key]))
      at.fail('invalid-value', 'expected at least one item to strip');
    return out;
  },

  'metadata-set': (o, at) => {
    only(o, at, [...METADATA_TEXT_FIELDS, 'custom']);
    const out: Record<string, unknown> = {};
    for (const key of METADATA_TEXT_FIELDS) {
      if (!Object.hasOwn(o, key)) continue;
      const a = at.child(key);
      const value = o[key];
      if (value === null) {
        out[key] = null;
        continue;
      }
      const text = str(value, a);
      if (key === 'language' && text.trim() !== '' && !isLanguageTag(text.trim())) {
        a.fail('invalid-value', 'expected a language tag such as "en" or "tr-TR"');
      }
      out[key] = text;
    }
    if (Object.hasOwn(o, 'custom')) {
      const a = at.child('custom');
      if (o.custom === null) {
        out.custom = null;
      } else {
        const record = obj(o.custom, a);
        const seen: string[] = [];
        for (const [key, value] of Object.entries(record)) {
          const problem = customKeyProblem(key, seen);
          if (problem !== undefined) {
            a.child(key).fail('invalid-value', `not a usable custom key (${problem})`, key);
          }
          str(value, a.child(key));
          seen.push(key);
        }
        out.custom = sortedRecord(record as Record<string, string>);
      }
    }
    if (Object.keys(out).length === 0)
      at.fail('invalid-value', 'expected at least one field to set');
    return out;
  },

  security: (o, at) => {
    only(o, at, ['requirePassword', 'permissions']);
    const required = need(o, 'requirePassword', at);
    if (required !== true) {
      at.child('requirePassword').fail(
        'invalid-value',
        'expected true (the password itself is asked when the recipe runs)',
      );
    }
    return { requirePassword: true, permissions: field(o, 'permissions', at, readPermissions) };
  },

  'remove-password': (o, at) => {
    only(o, at, []);
    return {};
  },

  ocr: (o, at) => {
    only(o, at, ['languages', 'dpi', 'scope']);
    const languages = field(o, 'languages', at, (v, a) => {
      const list = arr(v, a, 1, 8).map((item, i) => {
        const ia: At = a.item(i);
        if (typeof item !== 'string' || !/^[a-z]{3}(?:_[a-z]{3,4})?$/.test(item)) {
          ia.fail('invalid-value', 'expected a Tesseract language code such as "eng" or "chi_sim"');
        }
        return item;
      });
      if (new Set(list).size !== list.length)
        a.fail('invalid-value', 'expected no duplicate languages');
      return list;
    });
    return {
      languages,
      dpi: field(o, 'dpi', at, (v, a) => int(v, a, 200, 400)),
      scope: field(o, 'scope', at, (v, a) => oneOf(v, a, ['without-text', 'all'] as const)),
    };
  },

  export: (o, at) => {
    const format = field(o, 'format', at, (v, a) =>
      oneOf(v, a, ['pdf', 'images', 'markdown', 'text'] as const),
    );
    switch (format) {
      case 'pdf':
        only(o, at, ['format', 'compatibility', 'includeComments']);
        return {
          format,
          ...opt(o, 'compatibility', at, bool),
          ...opt(o, 'includeComments', at, bool),
        };
      case 'images': {
        only(o, at, ['format', 'imageFormat', 'dpi', 'quality', 'background']);
        const imageFormat = field(o, 'imageFormat', at, (v, a) =>
          oneOf(v, a, ['png', 'jpeg', 'webp'] as const),
        );
        const out = {
          format,
          imageFormat,
          dpi: field(o, 'dpi', at, (v, a) =>
            int(v, a, RECIPE_MIN_RASTER_DPI, RECIPE_MAX_RASTER_DPI),
          ),
          quality: field(o, 'quality', at, (v, a) => int(v, a, 1, 100)),
          background: field(o, 'background', at, (v, a) =>
            oneOf(v, a, ['white', 'transparent'] as const),
          ),
        };
        if (imageFormat === 'jpeg' && out.background === 'transparent') {
          at.child('background').fail(
            'invalid-value',
            'JPEG has no transparency; expected "white"',
          );
        }
        return out;
      }
      case 'markdown':
      case 'text':
        only(o, at, ['format', 'pageBreaks']);
        return {
          format,
          ...opt(o, 'pageBreaks', at, (v, a) => oneOf(v, a, ['none', 'rule', 'comment'] as const)),
        };
    }
  },
};

function readStep(value: unknown, index: number): RecipeStep {
  const bare = At.step(index, undefined);
  const o = obj(value, bare);
  const kindValue = need(o, 'kind', bare);
  if (!isRecipeStepKind(kindValue)) {
    const shown = typeof kindValue === 'string' ? quoted(kindValue) : describeType(kindValue);
    throw new RecipeError('unknown-kind', `Step ${index + 1}: unknown step kind ${shown}`, {
      path: `$.steps[${index}].kind`,
      stepIndex: index,
      key: 'kind',
    });
  }
  const at = At.step(index, kindValue);
  only(o, at, ['kind', 'options']);
  const optionsAt = at.child('options');
  const options = obj(need(o, 'options', at), optionsAt);
  const read = STEP_READERS[kindValue] as StepReader<RecipeStepKind>;
  return { kind: kindValue, options: read(options, optionsAt) } as RecipeStep;
}

// ---------------------------------------------------------------------------
// Reading and writing
// ---------------------------------------------------------------------------

function neededAppVersion(version: number): string {
  return RECIPE_FORMAT_RELEASES[version] ?? RECIPE_NEWER_APP_PLACEHOLDER;
}

/**
 * Validates and rebuilds a recipe from its JSON text or parsed value (imported files,
 * OPFS, the editor's state). Order: JSON → secrets (`secret`) → format (`not-recipe`) →
 * version (`newer-version`, or migrations for older ones) → keys and values, step by step.
 * Throws `RecipeError`; returns a fresh recipe with keys in the canonical order.
 */
export function readRecipe(
  input: unknown,
  migrations: RecipeMigrations = RECIPE_MIGRATIONS,
): Recipe {
  let value = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch (cause) {
      throw new RecipeError('not-json', 'Recipe: the file is not valid JSON', { cause });
    }
  }
  const root = At.root();
  if (!isObject(value)) {
    throw new RecipeError('not-recipe', `Recipe: expected an object, got ${describeType(value)}`);
  }
  assertNoSecrets(value);
  if (value.format !== RECIPE_FORMAT) {
    throw new RecipeError(
      'not-recipe',
      `Recipe: not a PDF Editor recipe (expected "format": "${RECIPE_FORMAT}")`,
      { path: '$.format', key: 'format' },
    );
  }
  const version = value.version;
  if (!Number.isSafeInteger(version) || (version as number) < 0) {
    root.child('version').fail('invalid-value', 'expected a whole version number');
  }
  let data: Obj = value;
  if ((version as number) > RECIPE_VERSION) {
    const needed = neededAppVersion(version as number);
    throw new RecipeError(
      'newer-version',
      `Recipe: format version ${String(version)} is newer than this app reads (up to ${RECIPE_VERSION}); ` +
        `open it with PDF Editor ${needed} or later`,
      {
        path: '$.version',
        key: 'version',
        version: version as number,
        neededAppVersion: needed,
      },
    );
  }
  if ((version as number) < RECIPE_VERSION) {
    data = migrate(value, version as number, migrations);
    assertNoSecrets(data);
  }
  only(data, root, ['format', 'version', 'name', 'description', 'steps']);
  const name = field(data, 'name', root, (v, a) =>
    str(v, a, { max: MAX_RECIPE_NAME_LENGTH, nonBlank: true }),
  );
  const description = opt(data, 'description', root, (v, a) =>
    str(v, a, { max: MAX_RECIPE_DESCRIPTION_LENGTH }),
  );
  const steps = field(data, 'steps', root, (v, a) =>
    arr(v, a, 1, MAX_RECIPE_STEPS).map((step, i) => readStep(step, i)),
  );
  const exportIndex = steps.findIndex((s) => s.kind === 'export');
  if (exportIndex !== -1 && exportIndex !== steps.length - 1) {
    At.step(exportIndex, 'export').fail('step-order', 'the export step must be the last step');
  }
  return { format: RECIPE_FORMAT, version: RECIPE_VERSION, name, ...description, steps };
}

/**
 * The recipe as a file: validated by `readRecipe` (so an invalid or secret-bearing value is
 * never written), keys in the canonical order, two-space JSON, final newline.
 */
export function writeRecipe(recipe: Recipe): string {
  const canonical = readRecipe(recipe);
  const text = `${JSON.stringify(canonical, null, 2)}\n`;
  assertNoSecrets(text);
  return text;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item: unknown, i) => deepEqual(item, b[i]));
  }
  if (!isObject(a) || !isObject(b)) return false;
  const keys = (o: Obj) => Object.keys(o).filter((k) => o[k] !== undefined);
  const ak = keys(a);
  const bk = keys(b);
  return ak.length === bk.length && ak.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
}

/** Whether two recipes hold the same content (key order and absent-vs-undefined ignored). */
export function recipeEquals(a: Recipe, b: Recipe): boolean {
  return deepEqual(a, b);
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

/** What a reserved step waits for: OCR (workstream W1) or the converter (W2). */
export type RecipeWaitingFor = 'ocr' | 'convert';

export type RecipeStepAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly waitingFor: RecipeWaitingFor };

/**
 * Whether the runner can execute a step in this build. Reserved steps are valid (a
 * recipe saved later keeps them) but block the run until their workstream lands.
 */
export function recipeStepAvailability(step: RecipeStep): RecipeStepAvailability {
  if (step.kind === 'ocr') return { available: false, waitingFor: 'ocr' };
  if (
    step.kind === 'export' &&
    (step.options.format === 'markdown' || step.options.format === 'text')
  ) {
    return { available: false, waitingFor: 'convert' };
  }
  return { available: true };
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

/** Compact, language-neutral form of a page selection: `all`, `odd`, `1-3,5,7-`. */
export function formatRecipePages(selection: RecipePageSelection): string {
  if (typeof selection === 'string') return selection;
  return selection.ranges
    .map((r) =>
      r.to === undefined ? `${r.from}-` : r.to === r.from ? `${r.from}` : `${r.from}-${r.to}`,
    )
    .join(',');
}

/**
 * The 0-based indices a selection picks in a file whose pages have these displayed sizes
 * (rotation applied), ascending and without duplicates. Ranges beyond the last page are
 * clipped.
 */
export function resolveRecipePages(
  selection: RecipePageSelection,
  displayedSizes: readonly Size[],
): number[] {
  const count = displayedSizes.length;
  const all = Array.from({ length: count }, (_, i) => i);
  if (typeof selection !== 'string') {
    const picked = new Set<number>();
    for (const r of selection.ranges) {
      const last = Math.min(count, r.to ?? count);
      for (let position = r.from; position <= last; position++) picked.add(position - 1);
    }
    return all.filter((i) => picked.has(i));
  }
  switch (selection) {
    case 'all':
      return all;
    case 'odd':
      return all.filter((i) => i % 2 === 0);
    case 'even':
      return all.filter((i) => i % 2 === 1);
    case 'first':
      return count > 0 ? [0] : [];
    case 'last':
      return count > 0 ? [count - 1] : [];
    case 'landscape':
      return all.filter((i) => {
        const size = displayedSizes[i];
        return size !== undefined && size.width > size.height;
      });
    case 'portrait':
      return all.filter((i) => {
        const size = displayedSizes[i];
        return size !== undefined && size.width <= size.height;
      });
  }
}

/** The model's `ResizeRequest` for a page-size step (displayed size in points). */
export function recipeResizeRequest(options: RecipePageSizeOptions): ResizeRequest {
  let width: number;
  let height: number;
  if (options.preset === 'custom') {
    width = options.width ?? MIN_PAGE_SIDE;
    height = options.height ?? MIN_PAGE_SIDE;
  } else {
    const paper = PAPER_SIZES[options.preset];
    const swap = options.landscape === true;
    width = swap ? paper.height : paper.width;
    height = swap ? paper.width : paper.height;
  }
  return {
    width,
    height,
    mode: options.mode,
    anchor: options.anchor,
    ...(options.mode === 'scale' && options.stretch === true ? { stretch: true } : {}),
    ...(options.matchOrientation === true ? { matchOrientation: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// Summary for the UI
// ---------------------------------------------------------------------------

/** Keys of the facts `describeRecipe` reports; the UI words each one. */
export type RecipeFactKey =
  | 'pages'
  | 'degrees'
  | 'margins'
  | 'unit'
  | 'paper'
  | 'size'
  | 'landscape'
  | 'matchOrientation'
  | 'mode'
  | 'anchor'
  | 'stretch'
  | 'template'
  | 'startNumber'
  | 'range'
  | 'mirror'
  | 'slots'
  | 'first'
  | 'continuous'
  | 'text'
  | 'imageType'
  | 'imageBytes'
  | 'layer'
  | 'tile'
  | 'rotate'
  | 'annotations'
  | 'forms'
  | 'preset'
  | 'dpi'
  | 'quality'
  | 'images'
  | 'linearize'
  | 'items'
  | 'set'
  | 'removed'
  | 'custom'
  | 'denied'
  | 'languages'
  | 'scope'
  | 'format'
  | 'imageFormat'
  | 'background'
  | 'compatibility'
  | 'includeComments'
  | 'pageBreaks';

export type RecipeFactValue = string | number | boolean | readonly string[] | readonly number[];

export interface RecipeFact {
  readonly key: RecipeFactKey;
  readonly value: RecipeFactValue;
}

export interface RecipeStepSummary {
  /** 0-based position in the recipe. */
  readonly index: number;
  readonly kind: RecipeStepKind;
  readonly availability: RecipeStepAvailability;
  /** Values the step asks for when the recipe runs (never stored). */
  readonly asks: readonly RecipeRuntimeInputKind[];
  readonly facts: readonly RecipeFact[];
}

export type RecipeOutputFormat = RecipeExportOptions['format'];

export interface RecipeSummary {
  readonly name: string;
  readonly description?: string;
  readonly stepCount: number;
  readonly steps: readonly RecipeStepSummary[];
  /** What each file becomes. */
  readonly output: RecipeOutputFormat;
  /** A password is asked before the run. */
  readonly asksPassword: boolean;
  /** Every step can run in this build. */
  readonly runnable: boolean;
  readonly waitingFor: readonly RecipeWaitingFor[];
}

function rangeFact(range: RecipeRange): string {
  return range.mode === 'custom' ? `${range.from}-${range.to}` : range.mode;
}

function batesSample(options: RecipeBatesOptions): string {
  return `${options.prefix}${String(options.start).padStart(options.width, '0')}${options.suffix}`;
}

function stepFacts(step: RecipeStep): RecipeFact[] {
  const f = (key: RecipeFactKey, value: RecipeFactValue): RecipeFact => ({ key, value });
  switch (step.kind) {
    case 'rotate':
      return [
        f('degrees', step.options.quarterTurns * 90),
        f('pages', formatRecipePages(step.options.pages)),
      ];
    case 'delete-pages':
      return [f('pages', formatRecipePages(step.options.pages))];
    case 'crop': {
      const { top, right, bottom, left } = step.options.margins;
      return [
        f('margins', [top, right, bottom, left]),
        f('pages', formatRecipePages(step.options.pages)),
        ...(step.options.unit === undefined ? [] : [f('unit', step.options.unit)]),
      ];
    }
    case 'page-size': {
      const o = step.options;
      const request = recipeResizeRequest(o);
      return [
        f('paper', o.preset),
        f('size', [request.width, request.height]),
        ...(o.landscape === undefined ? [] : [f('landscape', o.landscape)]),
        f('matchOrientation', o.matchOrientation === true),
        f('mode', o.mode),
        f('anchor', o.anchor),
        ...(o.stretch === true ? [f('stretch', true)] : []),
        f('pages', formatRecipePages(o.pages)),
        ...(o.unit === undefined ? [] : [f('unit', o.unit)]),
      ];
    }
    case 'page-numbers':
      return [
        f('template', step.options.template),
        f('anchor', step.options.anchor),
        f('startNumber', step.options.startNumber),
        f('range', rangeFact(step.options.range)),
        f('mirror', step.options.mirror),
      ];
    case 'header-footer':
      return [
        f(
          'slots',
          RECIPE_SLOTS.filter((slot) => step.options.slots[slot].trim() !== ''),
        ),
        f('range', rangeFact(step.options.range)),
        f('mirror', step.options.mirror),
      ];
    case 'bates':
      return [
        f('first', batesSample(step.options)),
        f('anchor', step.options.anchor),
        f('continuous', step.options.continuous),
      ];
    case 'watermark': {
      const o = step.options;
      return [
        f('mode', o.mode),
        ...(o.mode === 'text' ? [f('text', o.text)] : []),
        ...(o.image === undefined
          ? []
          : [f('imageType', o.image.type), f('imageBytes', base64ByteLength(o.image.data))]),
        f('layer', o.layer),
        f('rotate', o.rotate),
        f('tile', o.tile),
        f('range', rangeFact(o.range)),
      ];
    }
    case 'flatten':
      return [f('annotations', step.options.annotations), f('forms', step.options.forms)];
    case 'compress': {
      const o = step.options;
      return [
        f('preset', o.preset),
        ...(o.preset === 'custom' ? [f('dpi', o.dpi), f('quality', o.quality)] : []),
        f('images', o.images),
        ...(o.linearize === true ? [f('linearize', true)] : []),
      ];
    }
    case 'metadata-strip':
      return [
        f(
          'items',
          (Object.keys(step.options) as (keyof MetadataStrip)[]).filter((k) => step.options[k]),
        ),
      ];
    case 'metadata-set': {
      const o = step.options;
      const set = METADATA_TEXT_FIELDS.filter(
        (k) => typeof o[k] === 'string' && o[k].trim() !== '',
      );
      const removed = METADATA_TEXT_FIELDS.filter(
        (k) => Object.hasOwn(o, k) && (o[k] === null || o[k]?.trim() === ''),
      );
      return [
        f('set', set),
        f('removed', removed),
        ...(o.custom === undefined
          ? []
          : [f('custom', o.custom === null ? [] : Object.keys(o.custom).sort())]),
      ];
    }
    case 'security':
      return [
        f(
          'denied',
          (Object.keys(step.options.permissions) as (keyof PermissionFlags)[]).filter(
            (k) => !step.options.permissions[k],
          ),
        ),
      ];
    case 'remove-password':
      return [];
    case 'ocr':
      return [
        f('languages', step.options.languages),
        f('dpi', step.options.dpi),
        f('scope', step.options.scope),
      ];
    case 'export': {
      const o = step.options;
      switch (o.format) {
        case 'pdf':
          return [
            f('format', 'pdf'),
            f('compatibility', o.compatibility === true),
            f('includeComments', o.includeComments !== false),
          ];
        case 'images':
          return [
            f('format', 'images'),
            f('imageFormat', o.imageFormat),
            f('dpi', o.dpi),
            ...(o.imageFormat === 'png' ? [] : [f('quality', o.quality)]),
            f('background', o.background),
          ];
        case 'markdown':
        case 'text':
          return [f('format', o.format), f('pageBreaks', o.pageBreaks ?? 'none')];
      }
    }
  }
}

function stepAsks(step: RecipeStep): RecipeRuntimeInputKind[] {
  return step.kind === 'security' ? ['output-password'] : [];
}

function outputOf(recipe: Recipe): RecipeOutputFormat {
  const last = recipe.steps[recipe.steps.length - 1];
  return last?.kind === 'export' ? last.options.format : 'pdf';
}

/**
 * A structured, language-neutral summary: per step its kind, availability, run-time asks
 * and facts (stable keys with plain values) for the UI to word and render.
 */
export function describeRecipe(recipe: Recipe): RecipeSummary {
  const steps = recipe.steps.map((step, index) => ({
    index,
    kind: step.kind,
    availability: recipeStepAvailability(step),
    asks: stepAsks(step),
    facts: stepFacts(step),
  }));
  const waitingFor = [
    ...new Set(steps.flatMap((s) => (s.availability.available ? [] : [s.availability.waitingFor]))),
  ];
  return {
    name: recipe.name,
    ...(recipe.description === undefined ? {} : { description: recipe.description }),
    stepCount: recipe.steps.length,
    steps,
    output: outputOf(recipe),
    asksPassword: steps.some((s) => s.asks.length > 0),
    runnable: waitingFor.length === 0,
    waitingFor,
  };
}

// ---------------------------------------------------------------------------
// Run plan
// ---------------------------------------------------------------------------

/** A file offered to the batch (its bytes stay with the UI). */
export interface RecipeRunFile {
  readonly name: string;
  /** Bytes. */
  readonly size: number;
}

export type RecipeRuntimeInputKind = 'output-password';

/**
 * A value the UI asks for once, before the run, and holds in memory only. Answers are
 * passed by `id` in a `RecipeRuntimeValues` map; they never enter a recipe or a report.
 */
export interface RecipeRuntimeInput {
  readonly id: string;
  readonly kind: RecipeRuntimeInputKind;
  /** The step that uses it. */
  readonly stepIndex: number;
  /** Ask twice, like the Set password dialog. */
  readonly confirm: boolean;
  /** UTF-8 bytes at most (AES-256). */
  readonly maxBytes: number;
}

/** Run-time answers by input id. Memory only. */
export type RecipeRuntimeValues = ReadonlyMap<string, string>;

export interface RecipePlannedStep {
  readonly stepIndex: number;
  readonly step: RecipeStep;
  readonly availability: RecipeStepAvailability;
  /** Ids of the run-time inputs this step needs. */
  readonly inputs: readonly string[];
  /** Bates: the counter continues from the previous file's last number. */
  readonly continuesFromPreviousFile?: true;
}

export interface RecipeFilePlan {
  /** 0-based position in the batch (after skipped files are removed). */
  readonly index: number;
  readonly name: string;
  readonly size: number;
  /** Output file name, unique in the batch (case-insensitive). */
  readonly outputName: string;
  readonly steps: readonly RecipePlannedStep[];
}

export type RecipeSkipReason = 'not-pdf' | 'empty';

export interface RecipeRunPlan {
  readonly recipe: Recipe;
  readonly files: readonly RecipeFilePlan[];
  /** Files left out, with why. */
  readonly skipped: readonly { readonly name: string; readonly reason: RecipeSkipReason }[];
  /** What the UI asks once before the run. */
  readonly inputs: readonly RecipeRuntimeInput[];
  /**
   * Encrypted inputs need their own password to open: that is asked per file when it
   * happens (the file fails with `password` if the user skips it), never up front.
   */
  readonly sourcePasswords: 'on-demand';
  /** Steps that cannot run in this build; the run is refused while any is listed. */
  readonly blocked: readonly {
    readonly stepIndex: number;
    readonly kind: RecipeStepKind;
    readonly waitingFor: RecipeWaitingFor;
  }[];
  readonly runnable: boolean;
  /** Files processed at the same time (spec §5: one with OCR, else two). */
  readonly concurrency: 1 | 2;
  readonly output: { readonly format: RecipeOutputFormat; readonly extension: string };
  readonly totalBytes: number;
}

/** Default output name template: `{name}` (input without extension), `{recipe}`, `{n}`. */
export const RECIPE_DEFAULT_NAMING = '{name}-{recipe}';

const OUTPUT_EXTENSIONS: Readonly<Record<RecipeOutputFormat, string>> = {
  pdf: '.pdf',
  images: '.zip',
  markdown: '.md',
  text: '.txt',
};

// Control characters and characters file systems refuse (Windows is the strictest).
// eslint-disable-next-line no-control-regex
const UNSAFE_FILE_CHARS = /[\u0000-\u001f\u007f\\/:*?"<>|]/g;

function safeFileStem(text: string): string {
  const cleaned = text.replace(UNSAFE_FILE_CHARS, '_').replace(/\s+/g, ' ').trim();
  const stem = cleaned.replace(/^[.\s]+|[.\s]+$/g, '');
  return (stem === '' ? 'document' : stem).slice(0, 180);
}

function stemOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  return base.replace(/\.pdf$/i, '');
}

function isPdfName(name: string): boolean {
  return /\.pdf$/i.test(name);
}

/** UTF-8 byte length (no TextEncoder: the model stays free of platform globals). */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/**
 * Plans a run of `recipe` over `files`: the files kept (PDF names, not empty), each with
 * its ordered steps and unique output name, the values to ask once (passwords), what
 * blocks the run, and the concurrency. Throws `RecipeError` for an invalid recipe and
 * `invalid-argument` for a file without a name or a valid size.
 */
export function planRecipeRun(
  recipe: Recipe,
  files: readonly RecipeRunFile[],
  options: { readonly naming?: string } = {},
): RecipeRunPlan {
  const checked = readRecipe(recipe);
  const naming = options.naming ?? RECIPE_DEFAULT_NAMING;
  const inputs: RecipeRuntimeInput[] = [];
  const blocked: RecipeRunPlan['blocked'][number][] = [];
  const planned: RecipePlannedStep[] = checked.steps.map((step, stepIndex) => {
    const availability = recipeStepAvailability(step);
    if (!availability.available) {
      blocked.push({ stepIndex, kind: step.kind, waitingFor: availability.waitingFor });
    }
    const ids = stepAsks(step).map((kind) => {
      const id = `${kind}@${stepIndex}`;
      inputs.push({ id, kind, stepIndex, confirm: true, maxBytes: RECIPE_MAX_PASSWORD_BYTES });
      return id;
    });
    return {
      stepIndex,
      step,
      availability,
      inputs: ids,
      ...(step.kind === 'bates' && step.options.continuous
        ? { continuesFromPreviousFile: true as const }
        : {}),
    };
  });
  const format = outputOf(checked);
  const extension = OUTPUT_EXTENSIONS[format];
  const skipped: { name: string; reason: RecipeSkipReason }[] = [];
  const used = new Set<string>();
  const kept: RecipeFilePlan[] = [];
  for (const file of files) {
    if (typeof file.name !== 'string' || file.name === '') {
      throw new DocumentModelError('invalid-argument', 'A batch file needs a name');
    }
    if (!Number.isSafeInteger(file.size) || file.size < 0) {
      throw new DocumentModelError('invalid-argument', `Batch file ${file.name}: invalid size`);
    }
    if (!isPdfName(file.name)) {
      skipped.push({ name: file.name, reason: 'not-pdf' });
      continue;
    }
    if (file.size === 0) {
      skipped.push({ name: file.name, reason: 'empty' });
      continue;
    }
    const index = kept.length;
    const stem = safeFileStem(
      naming
        .replaceAll('{name}', stemOf(file.name))
        .replaceAll('{recipe}', checked.name)
        .replaceAll('{n}', String(index + 1)),
    );
    let outputName = `${stem}${extension}`;
    for (let n = 2; used.has(outputName.toLowerCase()); n++)
      outputName = `${stem} (${n})${extension}`;
    used.add(outputName.toLowerCase());
    kept.push({ index, name: file.name, size: file.size, outputName, steps: planned });
  }
  return {
    recipe: checked,
    files: kept,
    skipped,
    inputs,
    sourcePasswords: 'on-demand',
    blocked,
    runnable: blocked.length === 0 && kept.length > 0,
    concurrency: checked.steps.some((s) => s.kind === 'ocr') ? 1 : 2,
    output: { format, extension },
    totalBytes: kept.reduce((sum, file) => sum + file.size, 0),
  };
}

export type RecipeInputProblem = 'missing' | 'empty' | 'too-long';

/** What is wrong with the answers to a plan's inputs (empty when the run can start). */
export function checkRecipeInputs(
  plan: Pick<RecipeRunPlan, 'inputs'>,
  values: RecipeRuntimeValues,
): { readonly id: string; readonly problem: RecipeInputProblem }[] {
  const problems: { id: string; problem: RecipeInputProblem }[] = [];
  for (const input of plan.inputs) {
    const value = values.get(input.id);
    if (value === undefined) problems.push({ id: input.id, problem: 'missing' });
    else if (value === '') problems.push({ id: input.id, problem: 'empty' });
    else if (utf8ByteLength(value) > input.maxBytes)
      problems.push({ id: input.id, problem: 'too-long' });
  }
  return problems;
}

/**
 * The model's `SecurityPolicy` for a security step and the password asked at run time
 * (for `setSecurity`, or `ExportOptions.security`). Permissions are normalized like the
 * password form's (high-quality printing needs printing; annotating allows filling forms).
 * The policy lives in memory for the run only.
 */
export function recipeSecurityPolicy(
  options: RecipeSecurityOptions,
  password: string,
): SecurityPolicy {
  if (password === '') {
    throw new DocumentModelError('invalid-argument', 'The recipe needs a password to run');
  }
  if (utf8ByteLength(password) > RECIPE_MAX_PASSWORD_BYTES) {
    throw new DocumentModelError(
      'invalid-argument',
      `Passwords are limited to ${RECIPE_MAX_PASSWORD_BYTES} bytes`,
    );
  }
  const p = options.permissions;
  return {
    algorithm: 'aes-256',
    userPassword: password,
    permissions: {
      ...p,
      printHighQuality: p.print && p.printHighQuality,
      fillForms: p.fillForms || p.annotate,
    },
  };
}

/** The Bates start of the next file in a continuous run: after the pages numbered so far. */
export function nextBatesStart(options: RecipeBatesOptions, pagesNumberedBefore: number): number {
  return options.continuous ? options.start + pagesNumberedBefore : options.start;
}

// ---------------------------------------------------------------------------
// Run report
// ---------------------------------------------------------------------------

/**
 * Per-file outcome (spec §5): done, done with notes (the export summary's honesty lines),
 * failed (with a reason the UI can offer "Open in workspace" for) or skipped.
 */
export type RecipeFileStatus = 'done' | 'done-with-notes' | 'failed' | 'skipped';

export type RecipeFailureReason =
  | 'password'
  | 'xfa'
  | 'corrupt'
  | 'verification'
  | 'step'
  | 'unavailable'
  | 'aborted'
  | 'internal';

/** An honesty line a step or the export produced for one file. */
export interface RecipeNotice {
  /** The step it came from; absent for the export itself. */
  readonly stepIndex?: number;
  readonly kind?: RecipeStepKind;
  /** Stable code for the UI (e.g. `compress.not-worthwhile`, `export.security-removed`). */
  readonly code: string;
  /** The line as shown (already localized by the runner). */
  readonly message: string;
}

export interface RecipeFileOutcome {
  readonly index: number;
  readonly name: string;
  readonly status: RecipeFileStatus;
  readonly inputBytes: number;
  /** Done: the delivered file's name and size. */
  readonly outputName?: string;
  readonly outputBytes?: number;
  readonly notices: readonly RecipeNotice[];
  /** Failed: why, where, and the message shown. */
  readonly failure?: {
    readonly reason: RecipeFailureReason;
    readonly stepIndex?: number;
    readonly message: string;
  };
  /** Skipped: why (not a PDF, empty, or the run was cancelled first). */
  readonly skipReason?: RecipeSkipReason | 'cancelled';
  readonly durationMs?: number;
}

export interface RecipeRunTotals {
  readonly files: number;
  readonly done: number;
  readonly doneWithNotes: number;
  readonly failed: number;
  readonly skipped: number;
  readonly inputBytes: number;
  readonly outputBytes: number;
}

export interface RecipeRunReport {
  readonly recipeName: string;
  /** Epoch milliseconds. */
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly cancelled: boolean;
  /** How the outputs were delivered (spec §5: a ZIP, one by one, or into a folder). */
  readonly delivery: 'zip' | 'files' | 'folder';
  readonly files: readonly RecipeFileOutcome[];
  readonly totals: RecipeRunTotals;
}

export function recipeRunTotals(files: readonly RecipeFileOutcome[]): RecipeRunTotals {
  const count = (status: RecipeFileStatus) => files.filter((f) => f.status === status).length;
  return {
    files: files.length,
    done: count('done'),
    doneWithNotes: count('done-with-notes'),
    failed: count('failed'),
    skipped: count('skipped'),
    inputBytes: files.reduce((sum, f) => sum + f.inputBytes, 0),
    outputBytes: files.reduce((sum, f) => sum + (f.outputBytes ?? 0), 0),
  };
}

/** A done outcome's status: with notes when any step or the export produced one. */
export function doneStatus(notices: readonly RecipeNotice[]): 'done' | 'done-with-notes' {
  return notices.length > 0 ? 'done-with-notes' : 'done';
}

// ---------------------------------------------------------------------------
// Built-in recipes
// ---------------------------------------------------------------------------

const ALL_ALLOWED: PermissionFlags = {
  print: true,
  printHighQuality: true,
  modify: true,
  copy: true,
  annotate: true,
  fillForms: true,
  accessibility: true,
  assemble: true,
};

/** Page numbers as the dialog's defaults (`defaultPageNumbers`). */
const PAGE_NUMBERS: RecipeStepOf<'page-numbers'> = {
  kind: 'page-numbers',
  options: {
    template: '{page} / {pages}',
    anchor: 'bottom-center',
    marginX: 36,
    marginY: 28,
    style: RECIPE_DEFAULT_TEXT_STYLE,
    startNumber: 1,
    range: { mode: 'all' },
    mirror: false,
  },
};

/** The strip dialog's default selection: everything except annotation authors. */
const STRIP_DEFAULT: RecipeStepOf<'metadata-strip'> = {
  kind: 'metadata-strip',
  options: {
    info: true,
    xmp: true,
    attachments: true,
    javascript: true,
    pieceInfo: true,
    thumbnails: true,
    annotationAuthors: false,
    customKeys: true,
  },
};

export interface BuiltInRecipe {
  /** Stable id: the UI's translation key for name and description, and the OPFS name. */
  readonly id: string;
  readonly recipe: Recipe;
}

const builtIn = (
  id: string,
  name: string,
  description: string,
  steps: readonly RecipeStep[],
): BuiltInRecipe => ({
  id,
  recipe: { format: RECIPE_FORMAT, version: RECIPE_VERSION, name, description, steps },
});

/**
 * Recipes shipped with the app (ADR-0014 §3): not editable, users duplicate them. Names
 * and descriptions are English; the UI shows its translation by `id`.
 */
export const BUILT_IN_RECIPES: readonly BuiltInRecipe[] = [
  builtIn(
    'office-scan-cleanup',
    'Office scan cleanup',
    'Compress for reading on screen (ebook) and number the pages.',
    [
      { kind: 'compress', options: { preset: 'ebook', images: true, flattenAlpha: false } },
      PAGE_NUMBERS,
    ],
  ),
  builtIn(
    'share-safely',
    'Share safely',
    'Remove metadata, attachments and scripts, flatten annotations and forms, and require a password to open (asked when the recipe runs). Printing and accessibility stay allowed.',
    [
      { ...STRIP_DEFAULT, options: { ...STRIP_DEFAULT.options, annotationAuthors: true } },
      { kind: 'flatten', options: { annotations: true, forms: true } },
      {
        kind: 'security',
        options: {
          requirePassword: true,
          permissions: {
            ...ALL_ALLOWED,
            modify: false,
            copy: false,
            annotate: false,
            fillForms: false,
            assemble: false,
          },
        },
      },
    ],
  ),
  builtIn(
    'print-ready',
    'Print-ready',
    'Fit every page on A4 in its own orientation and number the pages.',
    [
      {
        kind: 'page-size',
        options: {
          preset: 'a4',
          matchOrientation: true,
          mode: 'fit',
          anchor: 'center',
          pages: 'all',
        },
      },
      PAGE_NUMBERS,
    ],
  ),
  builtIn('web-ready', 'Web-ready', 'Compress strongly for the web (screen) with fast web view.', [
    {
      kind: 'compress',
      options: { preset: 'screen', images: true, flattenAlpha: false, linearize: true },
    },
  ]),
  builtIn(
    'strip-metadata',
    'Strip metadata',
    'Remove document information, XMP, attachments, scripts and private data.',
    [STRIP_DEFAULT],
  ),
  builtIn('number-pages', 'Number pages', 'Add "1 / 12" style page numbers at the bottom centre.', [
    PAGE_NUMBERS,
  ]),
  builtIn(
    'scan-to-searchable',
    'Scan to searchable',
    'Recognize the text of scanned pages (English) and compress for screen reading.',
    [
      { kind: 'ocr', options: { languages: ['eng'], dpi: 300, scope: 'without-text' } },
      { kind: 'compress', options: { preset: 'ebook', images: true, flattenAlpha: false } },
    ],
  ),
];
