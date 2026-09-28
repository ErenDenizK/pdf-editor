/**
 * Words for recipes in the UI language: step kinds, built-in names, page selections, a
 * one-line detail per step (from `describeRecipe`'s facts), reader errors and run
 * outcomes. Message functions are called at render time.
 */
import {
  type Anchor,
  type BuiltInRecipe,
  formatRecipePages,
  RECIPE_NEWER_APP_PLACEHOLDER,
  type RecipeError,
  type RecipeFailureReason,
  type RecipePageSelection,
  type RecipeSkipReason,
  type RecipeStepKind,
  type RecipeStepSummary,
  type RecipeWaitingFor,
} from '@pdf-editor/document-model';

import { permissionLabel } from '../document/security-text';
import { STRIP_ITEMS } from '../document/strip-items';
import { m } from '../i18n';

export function stepKindLabel(kind: RecipeStepKind): string {
  switch (kind) {
    case 'rotate':
      return m.batch_step_rotate();
    case 'delete-pages':
      return m.batch_step_delete_pages();
    case 'crop':
      return m.batch_step_crop();
    case 'page-size':
      return m.batch_step_page_size();
    case 'page-numbers':
      return m.batch_step_page_numbers();
    case 'header-footer':
      return m.batch_step_header_footer();
    case 'bates':
      return m.batch_step_bates();
    case 'watermark':
      return m.batch_step_watermark();
    case 'flatten':
      return m.batch_step_flatten();
    case 'compress':
      return m.batch_step_compress();
    case 'metadata-strip':
      return m.batch_step_metadata_strip();
    case 'metadata-set':
      return m.batch_step_metadata_set();
    case 'security':
      return m.batch_step_security();
    case 'remove-password':
      return m.batch_step_remove_password();
    case 'ocr':
      return m.batch_step_ocr();
    case 'export':
      return m.batch_step_export();
  }
}

/** The name of a built-in recipe in the UI language (English in the recipe itself). */
export function builtInName(id: string, fallback: string): string {
  switch (id) {
    case 'office-scan-cleanup':
      return m.batch_builtin_office_scan_cleanup();
    case 'share-safely':
      return m.batch_builtin_share_safely();
    case 'print-ready':
      return m.batch_builtin_print_ready();
    case 'web-ready':
      return m.batch_builtin_web_ready();
    case 'strip-metadata':
      return m.batch_builtin_strip_metadata();
    case 'number-pages':
      return m.batch_builtin_number_pages();
    case 'scan-to-searchable':
      return m.batch_builtin_scan_to_searchable();
    default:
      return fallback;
  }
}

export function builtInDescription(id: string, fallback: string): string {
  switch (id) {
    case 'office-scan-cleanup':
      return m.batch_builtin_office_scan_cleanup_desc();
    case 'share-safely':
      return m.batch_builtin_share_safely_desc();
    case 'print-ready':
      return m.batch_builtin_print_ready_desc();
    case 'web-ready':
      return m.batch_builtin_web_ready_desc();
    case 'strip-metadata':
      return m.batch_builtin_strip_metadata_desc();
    case 'number-pages':
      return m.batch_builtin_number_pages_desc();
    case 'scan-to-searchable':
      return m.batch_builtin_scan_to_searchable_desc();
    default:
      return fallback;
  }
}

export function builtInLabel(entry: Pick<BuiltInRecipe, 'id' | 'recipe'>): string {
  return builtInName(entry.id, entry.recipe.name);
}

export function pageSelectionLabel(selection: RecipePageSelection): string {
  if (typeof selection !== 'string') {
    return m.batch_pages_ranges({ ranges: formatRecipePages(selection) });
  }
  switch (selection) {
    case 'all':
      return m.furniture_range_all();
    case 'odd':
      return m.furniture_range_odd();
    case 'even':
      return m.furniture_range_even();
    case 'first':
      return m.batch_pages_first();
    case 'last':
      return m.batch_pages_last();
    case 'landscape':
      return m.batch_pages_landscape();
    case 'portrait':
      return m.batch_pages_portrait();
  }
}

export function anchorLabel(anchor: Anchor): string {
  switch (anchor) {
    case 'top-left':
      return m.furniture_anchor_top_left();
    case 'top-center':
      return m.furniture_anchor_top_center();
    case 'top-right':
      return m.furniture_anchor_top_right();
    case 'middle-left':
      return m.furniture_anchor_middle_left();
    case 'center':
      return m.furniture_anchor_center();
    case 'middle-right':
      return m.furniture_anchor_middle_right();
    case 'bottom-left':
      return m.furniture_anchor_bottom_left();
    case 'bottom-center':
      return m.furniture_anchor_bottom_center();
    case 'bottom-right':
      return m.furniture_anchor_bottom_right();
  }
}

/**
 * Why a reserved step cannot run yet. No step is reserved in this build (`RecipeWaitingFor`
 * is empty since OCR runs); a future one adds its words here.
 */
export function waitingForLabel(waiting: RecipeWaitingFor): string {
  return waiting;
}

function fact(summary: RecipeStepSummary, key: string): unknown {
  return summary.facts.find((f) => f.key === key)?.value;
}

function pagesFact(summary: RecipeStepSummary): string {
  const value = fact(summary, 'pages');
  if (typeof value !== 'string') return '';
  if (/^[a-z]+$/.test(value)) return pageSelectionLabel(value as RecipePageSelection);
  return m.batch_pages_ranges({ ranges: value });
}

const join = (parts: readonly (string | false | undefined)[]) =>
  parts.filter((p): p is string => typeof p === 'string' && p !== '').join(' · ');

/** A one-line description of a step's options ("90° · Odd pages"). */
export function stepDetail(summary: RecipeStepSummary): string {
  switch (summary.kind) {
    case 'rotate':
      return join([`${String(fact(summary, 'degrees'))}°`, pagesFact(summary)]);
    case 'delete-pages':
      return pagesFact(summary);
    case 'crop': {
      const margins = fact(summary, 'margins');
      return join([
        Array.isArray(margins) ? m.batch_detail_margins({ margins: margins.join(' / ') }) : '',
        pagesFact(summary),
      ]);
    }
    case 'page-size': {
      const size = fact(summary, 'size');
      return join([
        Array.isArray(size) ? `${size.map((n: number) => Math.round(n)).join(' × ')} pt` : '',
        pagesFact(summary),
      ]);
    }
    case 'page-numbers':
      return join([
        `“${String(fact(summary, 'template'))}”`,
        anchorLabel(fact(summary, 'anchor') as Anchor),
      ]);
    case 'header-footer': {
      const slots = fact(summary, 'slots');
      return m.batch_detail_slots({ count: Array.isArray(slots) ? slots.length : 0 });
    }
    case 'bates':
      return join([
        String(fact(summary, 'first')),
        fact(summary, 'continuous') === true ? m.batch_detail_continuous() : '',
      ]);
    case 'watermark':
      return fact(summary, 'mode') === 'image'
        ? m.furniture_image()
        : `“${String(fact(summary, 'text'))}”`;
    case 'flatten':
      return join([
        fact(summary, 'annotations') === true ? m.batch_detail_annotations() : '',
        fact(summary, 'forms') === true ? m.batch_detail_forms() : '',
      ]);
    case 'compress':
      return compressPresetLabel(String(fact(summary, 'preset')));
    case 'metadata-strip': {
      const items = fact(summary, 'items');
      return Array.isArray(items)
        ? STRIP_ITEMS.filter((item) => items.includes(item.key))
            .map((item) => item.label())
            .join(', ')
        : '';
    }
    case 'metadata-set': {
      const set = fact(summary, 'set');
      const removed = fact(summary, 'removed');
      return join([
        Array.isArray(set) && set.length > 0 ? m.batch_detail_sets({ count: set.length }) : '',
        Array.isArray(removed) && removed.length > 0
          ? m.batch_detail_removes({ count: removed.length })
          : '',
      ]);
    }
    case 'security': {
      const denied = fact(summary, 'denied');
      return join([
        m.batch_detail_password_asked(),
        Array.isArray(denied) && denied.length > 0
          ? m.batch_detail_denied({
              list: denied
                .map((k) => permissionLabel(k as Parameters<typeof permissionLabel>[0]))
                .join(', '),
            })
          : '',
      ]);
    }
    case 'remove-password':
      return '';
    case 'ocr': {
      const languages = fact(summary, 'languages');
      const replace = fact(summary, 'replace');
      return join([
        Array.isArray(languages) ? languages.join('+') : '',
        ocrQualityLabel(Number(fact(summary, 'dpi'))),
        fact(summary, 'scope') === 'all'
          ? m.furniture_range_all()
          : m.batch_ocr_scope_without_text(),
        typeof replace === 'string' ? ocrReplaceDetail(replace) : '',
      ]);
    }
    case 'export': {
      const breaks = fact(summary, 'pageBreaks');
      // The options that differ from the export dialog's defaults.
      return join([
        outputFormatLabel(String(fact(summary, 'format'))),
        breaks === 'rule' || breaks === 'comment' ? pageBreaksLabel(breaks) : '',
        fact(summary, 'keepHeadersFooters') === true ? m.batch_detail_headers_kept() : '',
        fact(summary, 'joinHyphens') === false ? m.batch_detail_hyphens_kept() : '',
        fact(summary, 'images') === false ? m.batch_detail_no_images() : '',
      ]);
    }
  }
}

/** An OCR step's resolution as the OCR dialog words its quality ("Standard · 300 dpi"). */
export function ocrQualityLabel(dpi: number): string {
  if (dpi === OCR_STANDARD_DPI) return m.batch_ocr_quality_standard();
  if (dpi === OCR_HIGH_DPI) return m.batch_ocr_quality_high();
  return m.ocr_dpi({ dpi });
}

/** The OCR dialog's Standard and High resolutions (spec §1.2), as a recipe stores them. */
export const OCR_STANDARD_DPI = 300;
export const OCR_HIGH_DPI = 400;

/** What an OCR step does with invisible text already there, short (the step's detail). */
export function ocrReplaceDetail(replace: string): string {
  switch (replace) {
    case 'none':
      return m.batch_detail_ocr_replace_none();
    case 'all-invisible':
      return m.batch_detail_ocr_replace_all();
    default:
      return m.batch_detail_ocr_replace_ours();
  }
}

export function compressPresetLabel(preset: string): string {
  switch (preset) {
    case 'screen':
      return m.compress_preset_screen();
    case 'ebook':
      return m.compress_preset_ebook();
    case 'print':
      return m.compress_preset_print();
    default:
      return m.compress_preset_custom();
  }
}

/** The export dialog's words for the page breaks between converted pages. */
export function pageBreaksLabel(breaks: 'none' | 'rule' | 'comment'): string {
  switch (breaks) {
    case 'none':
      return m.convert_break_none();
    case 'rule':
      return m.convert_break_rule();
    case 'comment':
      return m.convert_break_comment();
  }
}

export function outputFormatLabel(format: string): string {
  switch (format) {
    case 'images':
      return m.batch_output_images();
    case 'markdown':
      return m.batch_output_markdown();
    case 'text':
      return m.batch_output_text();
    default:
      return m.batch_output_pdf();
  }
}

/** "Step 3 (Compress)" or "Recipe": where a reader error is. */
function whereOf(error: RecipeError): string {
  if (error.stepIndex === undefined) return m.batch_where_recipe();
  return error.stepKind === undefined
    ? m.batch_where_step({ number: error.stepIndex + 1 })
    : m.batch_where_step_kind({
        number: error.stepIndex + 1,
        kind: stepKindLabel(error.stepKind),
      });
}

/**
 * A recipe the reader refused, worded for the user: what is wrong and where, with the key
 * and the JSON path (`$.steps[2].options.dpi`). Never shows a value.
 */
export function recipeErrorText(error: RecipeError): string {
  const key = error.key ?? '';
  switch (error.problem) {
    case 'not-json':
      return m.batch_error_not_json();
    case 'not-recipe':
      return m.batch_error_not_recipe();
    case 'newer-version': {
      const needed = error.neededAppVersion;
      return needed === undefined || needed === RECIPE_NEWER_APP_PLACEHOLDER
        ? m.batch_error_newer_unknown({ version: error.version ?? 0 })
        : m.batch_error_newer({ version: error.version ?? 0, app: needed });
    }
    case 'unsupported-version':
      return m.batch_error_unsupported_version({ version: error.version ?? 0 });
    case 'unknown-kind':
      return m.batch_error_unknown_kind({ where: whereOf(error), path: error.path });
    case 'unknown-key':
      return m.batch_error_unknown_key({ where: whereOf(error), key, path: error.path });
    case 'missing-key':
      return m.batch_error_missing_key({ where: whereOf(error), key, path: error.path });
    case 'invalid-value':
      return m.batch_error_invalid_value({ where: whereOf(error), path: error.path });
    case 'secret':
      return m.batch_error_secret({ where: whereOf(error), path: error.path });
    case 'step-order':
      return m.batch_error_step_order({ where: whereOf(error) });
  }
}

export function skipReasonLabel(reason: RecipeSkipReason | 'cancelled'): string {
  switch (reason) {
    case 'not-pdf':
      return m.batch_skip_not_pdf();
    case 'empty':
      return m.batch_skip_empty();
    case 'cancelled':
      return m.batch_skip_cancelled();
  }
}

export function failureReasonLabel(reason: RecipeFailureReason): string {
  switch (reason) {
    case 'password':
      return m.batch_reason_password();
    case 'xfa':
      return m.batch_reason_xfa();
    case 'corrupt':
      return m.batch_reason_corrupt();
    case 'verification':
      return m.batch_reason_verification();
    case 'step':
      return m.batch_reason_step();
    case 'unavailable':
      return m.batch_reason_unavailable();
    case 'aborted':
      return m.batch_reason_aborted();
    case 'internal':
      return m.batch_reason_internal();
  }
}
