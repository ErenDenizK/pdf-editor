/**
 * The options a new step starts with in the recipe editor: the app dialogs' defaults
 * (furniture/furniture-model.ts, the strip checklist, the compress dialog), adapted to the
 * recipe shapes. Every default passes `readRecipe`.
 */
import {
  RECIPE_DEFAULT_TEXT_STYLE,
  type RecipePageRange,
  type RecipePageSelection,
  type RecipeStep,
  type RecipeStepKind,
  type RecipeStepOptionsMap,
} from '@pdf-editor/document-model';

/** Kinds offered by "Add step", in the menu's order. */
export const ADDABLE_STEP_KINDS: readonly RecipeStepKind[] = [
  'rotate',
  'delete-pages',
  'crop',
  'page-size',
  'page-numbers',
  'header-footer',
  'bates',
  'watermark',
  'flatten',
  'metadata-strip',
  'metadata-set',
  'compress',
  'security',
  'remove-password',
  'ocr',
  'export',
];

export function defaultStepOptions<K extends RecipeStepKind>(kind: K): RecipeStepOptionsMap[K] {
  const defaults: { readonly [P in RecipeStepKind]: RecipeStepOptionsMap[P] } = {
    rotate: { quarterTurns: 1, pages: 'all' },
    'delete-pages': { pages: 'first' },
    crop: { margins: { top: 18, right: 18, bottom: 18, left: 18 }, pages: 'all' },
    'page-size': {
      preset: 'a4',
      matchOrientation: true,
      mode: 'fit',
      anchor: 'center',
      pages: 'all',
    },
    'page-numbers': {
      template: '{page} / {pages}',
      anchor: 'bottom-center',
      marginX: 36,
      marginY: 28,
      style: RECIPE_DEFAULT_TEXT_STYLE,
      startNumber: 1,
      range: { mode: 'all' },
      mirror: false,
    },
    'header-footer': {
      slots: {
        'top-left': '{title}',
        'top-center': '',
        'top-right': '{date}',
        'bottom-left': '',
        'bottom-center': '',
        'bottom-right': '{page} / {pages}',
      },
      marginX: 36,
      marginY: 28,
      style: { ...RECIPE_DEFAULT_TEXT_STYLE, size: 9, color: '#404040' },
      range: { mode: 'all' },
      mirror: false,
    },
    bates: {
      prefix: '',
      width: 6,
      start: 1,
      suffix: '',
      anchor: 'bottom-right',
      marginX: 36,
      marginY: 28,
      style: { ...RECIPE_DEFAULT_TEXT_STYLE, family: 'JetBrains Mono', size: 9 },
      continuous: true,
    },
    watermark: {
      mode: 'text',
      text: 'DRAFT',
      style: { ...RECIPE_DEFAULT_TEXT_STYLE, size: 72, bold: true, color: '#c0392b', opacity: 0.2 },
      scale: 1,
      rotate: 45,
      tile: false,
      gapX: 72,
      gapY: 144,
      layer: 'over',
      range: { mode: 'all' },
    },
    flatten: { annotations: true, forms: true },
    compress: { preset: 'ebook', images: true, flattenAlpha: false },
    'metadata-strip': {
      info: true,
      xmp: true,
      attachments: true,
      javascript: true,
      pieceInfo: true,
      thumbnails: true,
      annotationAuthors: false,
      customKeys: true,
    },
    'metadata-set': { author: null },
    security: {
      requirePassword: true,
      permissions: {
        print: true,
        printHighQuality: true,
        modify: false,
        copy: false,
        annotate: false,
        fillForms: false,
        accessibility: true,
        assemble: false,
      },
    },
    'remove-password': {},
    ocr: { languages: ['eng'], dpi: 300, scope: 'without-text' },
    export: { format: 'pdf' },
  };
  return defaults[kind];
}

export function defaultStep(kind: RecipeStepKind): RecipeStep {
  return { kind, options: defaultStepOptions(kind) } as RecipeStep;
}

/** Parses "1-3, 5, 7-" into ranges; undefined when the text is not a valid list. */
export function parseRanges(text: string): RecipePageRange[] | undefined {
  const tokens = text
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t !== '');
  if (tokens.length === 0) return undefined;
  const ranges: RecipePageRange[] = [];
  for (const token of tokens) {
    const match = /^(\d+)(?:\s*-\s*(\d*))?$/.exec(token);
    if (match === null) return undefined;
    const from = Number(match[1]);
    if (!Number.isSafeInteger(from) || from < 1) return undefined;
    if (match[2] === undefined) {
      ranges.push({ from, to: from });
    } else if (match[2] === '') {
      ranges.push({ from });
    } else {
      const to = Number(match[2]);
      if (!Number.isSafeInteger(to) || to < from) return undefined;
      ranges.push({ from, to });
    }
  }
  return ranges;
}

export function formatRanges(selection: RecipePageSelection): string {
  if (typeof selection === 'string') return '';
  return selection.ranges
    .map((r) =>
      r.to === undefined ? `${r.from}-` : r.to === r.from ? `${r.from}` : `${r.from}-${r.to}`,
    )
    .join(', ');
}
