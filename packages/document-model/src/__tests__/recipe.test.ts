import { describe, expect, it } from 'vitest';
import { isDocumentModelError } from '../errors';
import {
  assertNoSecrets,
  BUILT_IN_RECIPES,
  base64ByteLength,
  checkRecipeInputs,
  describeRecipe,
  doneStatus,
  formatRecipePages,
  isRecipeError,
  MAX_RECIPE_IMAGE_BYTES,
  nextBatesStart,
  planRecipeRun,
  RECIPE_FORMAT,
  RECIPE_MIGRATIONS,
  RECIPE_NEWER_APP_PLACEHOLDER,
  RECIPE_SLOTS,
  RECIPE_STEP_KINDS,
  RECIPE_VERSION,
  type Recipe,
  RecipeError,
  type RecipeFileOutcome,
  type RecipeMigrations,
  type RecipePageSelection,
  type RecipeProblem,
  type RecipeRange,
  type RecipeStep,
  type RecipeStepKind,
  type RecipeTextStyle,
  readRecipe,
  recipeEquals,
  recipeResizeRequest,
  recipeRunTotals,
  recipeSecurityPolicy,
  recipeStepAvailability,
  resolveRecipePages,
  utf8ByteLength,
  writeRecipe,
} from '../recipe';
import { ANCHOR_POSITIONS, PAPER_SIZES } from '../resize';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** 1×1 PNG and a JPEG signature with padding bytes, base64. */
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const JPEG_HEAD = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA==';

const STYLE: RecipeTextStyle = {
  family: 'Inter',
  size: 10,
  bold: false,
  italic: false,
  color: '#000000',
  opacity: 1,
};

const ALL_PERMISSIONS = {
  print: true,
  printHighQuality: true,
  modify: true,
  copy: true,
  annotate: true,
  fillForms: true,
  accessibility: true,
  assemble: true,
};

/** One step of every kind (export last). */
function everyKind(): RecipeStep[] {
  return [
    { kind: 'rotate', options: { quarterTurns: 1, pages: 'landscape' } },
    { kind: 'delete-pages', options: { pages: { ranges: [{ from: 3, to: 4 }, { from: 9 }] } } },
    {
      kind: 'crop',
      options: { margins: { top: 10, right: 0, bottom: 10, left: 0 }, pages: 'all', unit: 'mm' },
    },
    {
      kind: 'page-size',
      options: {
        preset: 'custom',
        width: 500,
        height: 700,
        mode: 'scale',
        anchor: 'top-left',
        stretch: true,
        pages: 'odd',
      },
    },
    {
      kind: 'page-numbers',
      options: {
        template: 'Page {page} of {pages}',
        anchor: 'bottom-right',
        marginX: 36,
        marginY: 28,
        style: STYLE,
        startNumber: 1,
        range: { mode: 'skip-first' },
        mirror: true,
      },
    },
    {
      kind: 'header-footer',
      options: {
        slots: {
          'top-left': '{title}',
          'top-center': '',
          'top-right': '{date:iso}',
          'bottom-left': '',
          'bottom-center': '',
          'bottom-right': '',
        },
        marginX: 20,
        marginY: 20,
        style: { ...STYLE, size: 9, color: '#404040' },
        range: { mode: 'custom', from: 2, to: 5 },
        mirror: false,
      },
    },
    {
      kind: 'bates',
      options: {
        prefix: 'ACME-',
        width: 6,
        start: 1,
        suffix: '',
        anchor: 'bottom-right',
        marginX: 36,
        marginY: 28,
        style: { ...STYLE, family: 'JetBrains Mono', size: 9 },
        continuous: true,
      },
    },
    {
      kind: 'watermark',
      options: {
        mode: 'image',
        text: '',
        style: { ...STYLE, opacity: 0.2 },
        image: { type: 'image/png', data: PNG_1PX },
        scale: 1,
        rotate: 45,
        tile: true,
        gapX: 72,
        gapY: 144,
        layer: 'behind',
        range: { mode: 'all' },
      },
    },
    { kind: 'flatten', options: { annotations: true, forms: false } },
    {
      kind: 'compress',
      options: { preset: 'custom', dpi: 200, quality: 80, images: true, flattenAlpha: false },
    },
    {
      kind: 'metadata-strip',
      options: {
        info: true,
        xmp: true,
        attachments: false,
        javascript: true,
        pieceInfo: false,
        thumbnails: false,
        annotationAuthors: false,
        customKeys: false,
      },
    },
    {
      kind: 'metadata-set',
      options: {
        title: 'Report',
        author: null,
        language: 'tr-TR',
        custom: { Zeta: 'z', Alpha: 'a' },
      },
    },
    { kind: 'security', options: { requirePassword: true, permissions: ALL_PERMISSIONS } },
    { kind: 'remove-password', options: {} },
    { kind: 'ocr', options: { languages: ['eng', 'tur'], dpi: 300, scope: 'without-text' } },
    {
      kind: 'export',
      options: { format: 'images', imageFormat: 'png', dpi: 150, quality: 90, background: 'white' },
    },
  ];
}

function recipe(steps: readonly RecipeStep[], name = 'Test recipe'): Recipe {
  return { format: RECIPE_FORMAT, version: RECIPE_VERSION, name, steps };
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** A mutable JSON copy of the every-kind recipe, for breaking it on purpose. */
function raw(): Record<string, Json> {
  return JSON.parse(JSON.stringify(recipe(everyKind()))) as Record<string, Json>;
}

function stepsOf(data: Record<string, Json>): Record<string, Json>[] {
  return data.steps as Record<string, Json>[];
}

function optionsOf(data: Record<string, Json>, index: number): Record<string, Json> {
  return stepsOf(data)[index]?.options as Record<string, Json>;
}

function readError(input: unknown, migrations?: RecipeMigrations): RecipeError {
  try {
    readRecipe(input, migrations);
  } catch (error) {
    if (error instanceof RecipeError) return error;
    throw error;
  }
  throw new Error('expected readRecipe to throw');
}

const KIND_INDEX = Object.fromEntries(everyKind().map((s, i) => [s.kind, i])) as Record<
  RecipeStepKind,
  number
>;

// ---------------------------------------------------------------------------
// Reading and writing
// ---------------------------------------------------------------------------

describe('readRecipe / writeRecipe', () => {
  it('covers every step kind in the fixture', () => {
    expect(everyKind().map((s) => s.kind)).toEqual(RECIPE_STEP_KINDS);
  });

  it('reads what it writes, equal to the input', () => {
    const r = recipe(everyKind());
    const text = writeRecipe(r);
    const back = readRecipe(text);
    expect(recipeEquals(back, r)).toBe(true);
    expect(writeRecipe(back)).toBe(text);
  });

  it('accepts the parsed value as well as the text', () => {
    const r = recipe(everyKind());
    expect(recipeEquals(readRecipe(JSON.parse(writeRecipe(r))), r)).toBe(true);
  });

  it('writes two-space JSON in the canonical key order with a final newline', () => {
    const shuffled = {
      steps: [{ options: { pages: 'odd', quarterTurns: 1 }, kind: 'rotate' }],
      name: 'Rotate',
      version: 1,
      format: 'pdf-editor-recipe',
    };
    expect(writeRecipe(shuffled as unknown as Recipe)).toBe(
      `${[
        '{',
        '  "format": "pdf-editor-recipe",',
        '  "version": 1,',
        '  "name": "Rotate",',
        '  "steps": [',
        '    {',
        '      "kind": "rotate",',
        '      "options": {',
        '        "quarterTurns": 1,',
        '        "pages": "odd"',
        '      }',
        '    }',
        '  ]',
        '}',
      ].join('\n')}\n`,
    );
  });

  it('sorts custom metadata keys so the output is stable', () => {
    const text = writeRecipe(recipe([everyKind()[KIND_INDEX['metadata-set']] as RecipeStep]));
    expect(text.indexOf('"Alpha"')).toBeLessThan(text.indexOf('"Zeta"'));
  });

  it('keeps the description and drops nothing', () => {
    const r = { ...recipe(everyKind()), description: 'Everything at once' };
    expect(readRecipe(writeRecipe(r)).description).toBe('Everything at once');
  });

  it('reads every built-in recipe with the same reader', () => {
    for (const { recipe: r } of BUILT_IN_RECIPES) {
      expect(recipeEquals(readRecipe(writeRecipe(r)), r)).toBe(true);
    }
  });
});

describe('recipeEquals', () => {
  it('ignores key order and absent-vs-undefined', () => {
    const a = recipe([{ kind: 'rotate', options: { quarterTurns: 2, pages: 'all' } }]);
    const b = {
      steps: [{ options: { pages: 'all', quarterTurns: 2 }, kind: 'rotate' }],
      description: undefined,
      name: 'Test recipe',
      version: 1,
      format: 'pdf-editor-recipe',
    } as unknown as Recipe;
    expect(recipeEquals(a, b)).toBe(true);
  });

  it('sees any difference', () => {
    const a = recipe(everyKind());
    const data = raw();
    optionsOf(data, KIND_INDEX.crop).pages = 'odd';
    expect(recipeEquals(a, readRecipe(data))).toBe(false);
    expect(recipeEquals(a, recipe(everyKind().slice(1)))).toBe(false);
    expect(recipeEquals(a, recipe(everyKind(), 'Other'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

interface ErrorCase {
  readonly name: string;
  readonly mutate: (data: Record<string, Json>) => unknown;
  readonly problem: RecipeProblem;
  readonly message: string;
  readonly stepIndex?: number;
  readonly key?: string;
}

const opts = (kind: RecipeStepKind) => (data: Record<string, Json>) =>
  optionsOf(data, KIND_INDEX[kind]);

const ERROR_CASES: readonly ErrorCase[] = [
  {
    name: 'unknown step kind, with the step index',
    mutate: (d) => {
      (stepsOf(d)[1] as { kind: Json }).kind = 'redact';
    },
    problem: 'unknown-kind',
    message: 'Step 2: unknown step kind "redact"',
    stepIndex: 1,
    key: 'kind',
  },
  {
    name: 'step kind of the wrong type',
    mutate: (d) => {
      (stepsOf(d)[0] as { kind: Json }).kind = 7;
    },
    problem: 'unknown-kind',
    message: 'Step 1: unknown step kind a number',
    stepIndex: 0,
  },
  {
    name: 'unknown option key',
    mutate: (d) => {
      opts('rotate')(d).degrees = 90;
    },
    problem: 'unknown-key',
    message: 'Step 1 (rotate), options: unknown option key "degrees"',
    stepIndex: 0,
    key: 'degrees',
  },
  {
    name: 'unknown nested key',
    mutate: (d) => {
      (opts('page-numbers')(d).style as Record<string, Json>).underline = true;
    },
    problem: 'unknown-key',
    message: 'Step 5 (page-numbers), options.style: unknown key "underline"',
    key: 'underline',
  },
  {
    name: 'unknown key on the step',
    mutate: (d) => {
      (stepsOf(d)[2] as Record<string, Json>).enabled = true;
    },
    problem: 'unknown-key',
    message: 'Step 3 (crop): unknown key "enabled"',
  },
  {
    name: 'unknown root key (the spec draft\'s "id")',
    mutate: (d) => {
      d.id = 'abc';
    },
    problem: 'unknown-key',
    message: 'Recipe: unknown key "id"',
  },
  {
    name: 'wrong type',
    mutate: (d) => {
      opts('compress')(d).dpi = '200';
    },
    problem: 'invalid-value',
    message: 'Step 10 (compress), options.dpi: expected an integer from 36 to 1200',
    stepIndex: 9,
    key: 'dpi',
  },
  {
    name: 'out of range',
    mutate: (d) => {
      opts('bates')(d).width = 13;
    },
    problem: 'invalid-value',
    message: 'Step 7 (bates), options.width: expected an integer from 1 to 12',
  },
  {
    name: 'missing option',
    mutate: (d) => {
      delete opts('flatten')(d).forms;
    },
    problem: 'missing-key',
    message: 'Step 9 (flatten), options: missing "forms"',
    key: 'forms',
  },
  {
    name: 'missing options',
    mutate: (d) => {
      delete (stepsOf(d)[0] as Record<string, Json>).options;
    },
    problem: 'missing-key',
    message: 'Step 1 (rotate): missing "options"',
  },
  {
    name: 'options not an object',
    mutate: (d) => {
      (stepsOf(d)[0] as Record<string, Json>).options = [];
    },
    problem: 'invalid-value',
    message: 'Step 1 (rotate), options: expected an object, got an array',
  },
  {
    name: 'a preset with explicit settings',
    mutate: (d) => {
      Object.assign(opts('compress')(d), { preset: 'ebook' });
    },
    problem: 'invalid-value',
    message: 'Step 10 (compress), options.dpi: only with preset "custom"',
  },
  {
    name: 'custom compression without settings',
    mutate: (d) => {
      delete opts('compress')(d).quality;
    },
    problem: 'missing-key',
    message: 'Step 10 (compress), options: missing "quality"',
  },
  {
    name: 'from/to outside a custom range',
    mutate: (d) => {
      opts('page-numbers')(d).range = { mode: 'all', from: 1, to: 3 };
    },
    problem: 'invalid-value',
    message: 'Step 5 (page-numbers), options.range.from: only with mode "custom"',
  },
  {
    name: 'custom range ending before it starts',
    mutate: (d) => {
      opts('header-footer')(d).range = { mode: 'custom', from: 5, to: 2 };
    },
    problem: 'invalid-value',
    message: 'Step 6 (header-footer), options.range.to: expected an integer 5 or more',
  },
  {
    name: 'a header and footer with every slot blank',
    mutate: (d) => {
      const slots = opts('header-footer')(d).slots as Record<string, Json>;
      for (const slot of RECIPE_SLOTS) slots[slot] = ' ';
    },
    problem: 'invalid-value',
    message: 'Step 6 (header-footer), options.slots: expected at least one filled slot',
  },
  {
    name: 'a page selection that is not one',
    mutate: (d) => {
      opts('rotate')(d).pages = 'middle';
    },
    problem: 'invalid-value',
    message: 'Step 1 (rotate), options.pages: expected one of "all", "odd"',
  },
  {
    name: 'a page range from 0',
    mutate: (d) => {
      opts('delete-pages')(d).pages = { ranges: [{ from: 0 }] };
    },
    problem: 'invalid-value',
    message: 'Step 2 (delete-pages), options.pages.ranges[0].from: expected an integer 1 or more',
  },
  {
    name: 'deleting every page',
    mutate: (d) => {
      opts('delete-pages')(d).pages = 'all';
    },
    problem: 'invalid-value',
    message: 'Step 2 (delete-pages), options.pages: deleting every page',
  },
  {
    name: 'a zero crop',
    mutate: (d) => {
      opts('crop')(d).margins = { top: 0, right: 0, bottom: 0, left: 0 };
    },
    problem: 'invalid-value',
    message: 'Step 3 (crop), options.margins: expected at least one margin above 0',
  },
  {
    name: 'stretch outside the scale mode',
    mutate: (d) => {
      opts('page-size')(d).mode = 'fit';
    },
    problem: 'invalid-value',
    message: 'Step 4 (page-size), options.stretch: stretch applies to the "scale" mode only',
  },
  {
    name: 'a custom page size without its height',
    mutate: (d) => {
      delete opts('page-size')(d).height;
    },
    problem: 'missing-key',
    message: 'Step 4 (page-size), options: missing "height"',
  },
  {
    name: 'a paper preset with a width',
    mutate: (d) => {
      opts('page-size')(d).preset = 'a4';
    },
    problem: 'invalid-value',
    message: 'Step 4 (page-size), options.width: only with preset "custom"',
  },
  {
    name: 'a watermark image in text mode',
    mutate: (d) => {
      Object.assign(opts('watermark')(d), { mode: 'text', text: 'DRAFT' });
    },
    problem: 'invalid-value',
    message: 'Step 8 (watermark), options.image: only with mode "image"',
  },
  {
    name: 'an image watermark without its image',
    mutate: (d) => {
      delete opts('watermark')(d).image;
    },
    problem: 'missing-key',
    message: 'Step 8 (watermark), options: missing "image"',
  },
  {
    name: 'a text watermark without text',
    mutate: (d) => {
      const o = opts('watermark')(d);
      delete o.image;
      o.mode = 'text';
    },
    problem: 'invalid-value',
    message: 'Step 8 (watermark), options.text: expected a non-empty string',
  },
  {
    name: 'watermark image that is not base64',
    mutate: (d) => {
      opts('watermark')(d).image = { type: 'image/png', data: 'not base64!' };
    },
    problem: 'invalid-value',
    message: 'Step 8 (watermark), options.image.data: expected padded standard base64',
  },
  {
    name: 'watermark image of the wrong type',
    mutate: (d) => {
      opts('watermark')(d).image = { type: 'image/jpeg', data: PNG_1PX };
    },
    problem: 'invalid-value',
    message: 'Step 8 (watermark), options.image.data: the bytes are not a JPEG image',
  },
  {
    name: 'watermark image over 1 MB',
    mutate: (d) => {
      const length = Math.ceil((MAX_RECIPE_IMAGE_BYTES + 1) / 3) * 4;
      const data = PNG_1PX.slice(0, 12) + 'A'.repeat(length - 12);
      opts('watermark')(d).image = { type: 'image/png', data };
    },
    problem: 'invalid-value',
    message: 'larger than 1048576 bytes (1 MB)',
  },
  {
    name: 'a colour that is not #rrggbb',
    mutate: (d) => {
      (opts('bates')(d).style as Record<string, Json>).color = 'red';
    },
    problem: 'invalid-value',
    message: 'Step 7 (bates), options.style.color: expected a colour as #rrggbb',
  },
  {
    name: 'a malformed language tag',
    mutate: (d) => {
      opts('metadata-set')(d).language = 'not a tag';
    },
    problem: 'invalid-value',
    message: 'Step 12 (metadata-set), options.language: expected a language tag',
  },
  {
    name: 'a reserved custom metadata key',
    mutate: (d) => {
      opts('metadata-set')(d).custom = { Title: 'x' };
    },
    problem: 'invalid-value',
    message: 'Step 12 (metadata-set), options.custom.Title: not a usable custom key (reserved)',
  },
  {
    name: 'metadata-set with nothing to set',
    mutate: (d) => {
      (stepsOf(d)[KIND_INDEX['metadata-set']] as Record<string, Json>).options = {};
    },
    problem: 'invalid-value',
    message: 'Step 12 (metadata-set), options: expected at least one field to set',
  },
  {
    name: 'a strip checklist with nothing selected',
    mutate: (d) => {
      const o = opts('metadata-strip')(d);
      for (const key of Object.keys(o)) o[key] = false;
    },
    problem: 'invalid-value',
    message: 'Step 11 (metadata-strip), options: expected at least one item to strip',
  },
  {
    name: 'flatten with nothing to flatten',
    mutate: (d) => {
      opts('flatten')(d).annotations = false;
    },
    problem: 'invalid-value',
    message: 'Step 9 (flatten), options: expected annotations, forms or both',
  },
  {
    name: 'a security step that does not require a password',
    mutate: (d) => {
      opts('security')(d).requirePassword = false;
    },
    problem: 'invalid-value',
    message: 'Step 13 (security), options.requirePassword: expected true (the password itself',
  },
  {
    name: 'a missing permission',
    mutate: (d) => {
      delete (opts('security')(d).permissions as Record<string, Json>).copy;
    },
    problem: 'missing-key',
    message: 'Step 13 (security), options.permissions: missing "copy"',
  },
  {
    name: 'options on remove-password',
    mutate: (d) => {
      opts('remove-password')(d).keepOwner = true;
    },
    problem: 'unknown-key',
    message: 'Step 14 (remove-password), options: unknown option key "keepOwner"',
  },
  {
    name: 'an OCR language that is not a Tesseract code',
    mutate: (d) => {
      opts('ocr')(d).languages = ['eng', 'English'];
    },
    problem: 'invalid-value',
    message: 'Step 15 (ocr), options.languages[1]: expected a Tesseract language code',
  },
  {
    name: 'duplicate OCR languages',
    mutate: (d) => {
      opts('ocr')(d).languages = ['eng', 'eng'];
    },
    problem: 'invalid-value',
    message: 'Step 15 (ocr), options.languages: expected no duplicate languages',
  },
  {
    name: 'an OCR resolution out of range',
    mutate: (d) => {
      opts('ocr')(d).dpi = 600;
    },
    problem: 'invalid-value',
    message: 'Step 15 (ocr), options.dpi: expected an integer from 200 to 400',
  },
  {
    name: 'transparent JPEG images',
    mutate: (d) => {
      Object.assign(opts('export')(d), { imageFormat: 'jpeg', background: 'transparent' });
    },
    problem: 'invalid-value',
    message: 'Step 16 (export), options.background: JPEG has no transparency',
  },
  {
    name: 'image options on a PDF export',
    mutate: (d) => {
      opts('export')(d).format = 'pdf';
    },
    problem: 'unknown-key',
    message: 'Step 16 (export), options: unknown option key "imageFormat"',
  },
  {
    name: 'an export step that is not last',
    mutate: (d) => {
      const steps = stepsOf(d);
      steps.unshift(steps.pop() as Record<string, Json>);
    },
    problem: 'step-order',
    message: 'Step 1 (export): the export step must be the last step',
    stepIndex: 0,
  },
  {
    name: 'no steps',
    mutate: (d) => {
      d.steps = [];
    },
    problem: 'invalid-value',
    message: 'Recipe steps: expected from 1 to 64 items',
  },
  {
    name: 'a blank name',
    mutate: (d) => {
      d.name = '  ';
    },
    problem: 'invalid-value',
    message: 'Recipe name: expected a non-empty string',
  },
  {
    name: 'a missing name',
    mutate: (d) => {
      delete d.name;
    },
    problem: 'missing-key',
    message: 'Recipe: missing "name"',
  },
  {
    name: 'another format',
    mutate: (d) => {
      d.format = 'pdf-editor.recipe';
    },
    problem: 'not-recipe',
    message: 'Recipe: not a PDF Editor recipe (expected "format": "pdf-editor-recipe")',
  },
  {
    name: 'a version that is not a whole number',
    mutate: (d) => {
      d.version = '1';
    },
    problem: 'invalid-value',
    message: 'Recipe version: expected a whole version number',
  },
];

describe('reader errors', () => {
  it.each(ERROR_CASES)('rejects $name', (c) => {
    const data = raw();
    c.mutate(data);
    const error = readError(data);
    expect(error.problem).toBe(c.problem);
    expect(error.message).toContain(c.message);
    expect(error.code).toBe('invalid-serialized');
    if (c.stepIndex !== undefined) expect(error.stepIndex).toBe(c.stepIndex);
    if (c.key !== undefined) expect(error.key).toBe(c.key);
    // The writer refuses the same value: an invalid recipe is never written.
    expect(() => writeRecipe(data as unknown as Recipe)).toThrow(RecipeError);
  });

  it('names the JSON path and the step kind', () => {
    const data = raw();
    opts('compress')(data).quality = 101;
    const error = readError(data);
    expect(error.path).toBe('$.steps[9].options.quality');
    expect(error.stepKind).toBe('compress');
    expect(isRecipeError(error, 'invalid-value')).toBe(true);
    expect(isDocumentModelError(error, 'invalid-serialized')).toBe(true);
  });

  it('rejects text that is not JSON and values that are not objects', () => {
    expect(readError('{ "format": ').problem).toBe('not-json');
    expect(readError('[]').problem).toBe('not-recipe');
    expect(readError(null).message).toBe('Recipe: expected an object, got null');
  });

  it('truncates long unknown keys in messages', () => {
    const data = raw();
    opts('rotate')(data)['k'.repeat(100)] = 1;
    const error = readError(data);
    expect(error.message.length).toBeLessThan(120);
    expect(error.message).toContain('…"');
  });
});

describe('versions and migrations', () => {
  it('refuses a newer version, naming the app version it needs', () => {
    const data = raw();
    data.version = 2;
    const error = readError(data);
    expect(error.problem).toBe('newer-version');
    expect(error.code).toBe('unsupported-version');
    expect(error.version).toBe(2);
    expect(error.neededAppVersion).toBe(RECIPE_NEWER_APP_PLACEHOLDER);
    expect(error.message).toBe(
      `Recipe: format version 2 is newer than this app reads (up to 1); open it with PDF Editor ${RECIPE_NEWER_APP_PLACEHOLDER} or later`,
    );
  });

  it('checks the version before the steps (a newer recipe may have new kinds)', () => {
    const data = raw();
    data.version = 3;
    (stepsOf(data)[0] as { kind: Json }).kind = 'future-kind';
    expect(readError(data).problem).toBe('newer-version');
  });

  it('has no migrations yet: version 1 is the first', () => {
    expect(Object.keys(RECIPE_MIGRATIONS)).toEqual([]);
    const data = raw();
    data.version = 0;
    const error = readError(data);
    expect(error.problem).toBe('unsupported-version');
    expect(error.code).toBe('unsupported-version');
    expect(error.message).toBe(
      'Recipe: format version 0 cannot be read (no migration from version 0 to 1)',
    );
  });

  it('runs migrations stepwise from an older version (scaffolding)', () => {
    // A hypothetical v0 that called steps "ops" and the kind "op".
    const v0 = {
      format: RECIPE_FORMAT,
      version: 0,
      name: 'Old',
      ops: [{ op: 'rotate', options: { quarterTurns: 2, pages: 'all' } }],
    };
    const migrations: RecipeMigrations = {
      0: ({ ops, ...rest }) => ({
        ...rest,
        version: 1,
        steps: (ops as { op: string; options: unknown }[]).map(({ op, options }) => ({
          kind: op,
          options,
        })),
      }),
    };
    const read = readRecipe(v0, migrations);
    expect(read).toEqual(
      recipe([{ kind: 'rotate', options: { quarterTurns: 2, pages: 'all' } }], 'Old'),
    );
    expect(writeRecipe(read)).toContain('"version": 1');
  });

  it('refuses a migration that does not reach the next version', () => {
    const v0 = { format: RECIPE_FORMAT, version: 0, name: 'Old', steps: [] };
    const error = readError(v0, { 0: (r) => ({ ...r }) });
    expect(error.problem).toBe('unsupported-version');
    expect(error.message).toContain('did not produce version 1');
  });

  it('validates migrated recipes like any other', () => {
    const v0 = {
      format: RECIPE_FORMAT,
      version: 0,
      name: 'Old',
      steps: [{ kind: 'x', options: {} }],
    };
    const error = readError(v0, { 0: (r) => ({ ...r, version: 1 }) });
    expect(error.problem).toBe('unknown-kind');
  });
});

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

describe('assertNoSecrets', () => {
  it('passes a recipe with a required password (a flag, not a value)', () => {
    expect(() => {
      assertNoSecrets(writeRecipe(recipe(everyKind())));
    }).not.toThrow();
  });

  it.each([
    ['password', { password: 'hunter2' }],
    ['userPassword', { steps: [{ kind: 'security', options: { userPassword: 'x' } }] }],
    ['ownerPassword', { a: { b: [{ ownerPassword: '' }] } }],
    ['pass', { pass: 1 }],
    ['PIN', { PIN: '1234' }],
    ['secret', { secret: true }],
    ['user_password', { user_password: 'x' }],
    ['openPassword', { openPassword: null }],
    ['string under a *password key', { requirePassword: 'hunter2' }],
  ])('rejects %s', (_, value) => {
    let error: unknown;
    try {
      assertNoSecrets(value);
    } catch (e) {
      error = e;
    }
    expect(isRecipeError(error, 'secret')).toBe(true);
    expect((error as Error).message).not.toContain('hunter2');
  });

  it('reports where the secret sits', () => {
    const data = raw();
    opts('security')(data).userPassword = 'hunter2';
    const error = readError(data);
    expect(error.problem).toBe('secret');
    expect(error.path).toBe('$.steps[12].options.userPassword');
    expect(error.stepIndex).toBe(12);
    expect(error.message).toBe(
      'Step 13 (security), options: "userPassword" is not allowed: recipes never store passwords or other secrets (a password is asked when the recipe runs)',
    );
  });

  it('finds known run-time secrets in values and raw text', () => {
    const data = raw();
    opts('page-numbers')(data).template = 'Page {page} s3cr3t§';
    expect(() => {
      assertNoSecrets(data, ['s3cr3t§']);
    }).toThrow(/Step 5 \(page-numbers\), options.template: recipes never store passwords/);
    expect(() => {
      assertNoSecrets(JSON.stringify(data), ['s3cr3t§']);
    }).toThrow(RecipeError);
    expect(() => {
      assertNoSecrets(data, ['', 'absent']);
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Property test: no serialized recipe ever holds a password
// ---------------------------------------------------------------------------

/** mulberry32: small, fast, deterministic. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Single code points only, so every pick is one character. */
const ALPHABET = Array.from('abcXYZ019 {}-_/.éşİ');

class Gen {
  constructor(private readonly next: () => number) {}

  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  num(min: number, max: number): number {
    return Math.round((min + this.next() * (max - min)) * 100) / 100;
  }

  bool(): boolean {
    return this.next() < 0.5;
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)] as T;
  }

  /** Text from an alphabet that never contains the password markers (§ and ¤). */
  text(min: number, max: number): string {
    return Array.from({ length: this.int(min, max) }, () => this.pick(ALPHABET)).join('');
  }

  nonBlank(max: number): string {
    return `${this.pick(['a', 'Z', '{page}'])}${this.text(0, max)}`;
  }

  pages(): RecipePageSelection {
    if (this.next() < 0.7) {
      return this.pick(['all', 'odd', 'even', 'first', 'last', 'landscape', 'portrait'] as const);
    }
    return {
      ranges: Array.from({ length: this.int(1, 3) }, () => {
        const from = this.int(1, 20);
        return this.bool() ? { from } : { from, to: from + this.int(0, 10) };
      }),
    };
  }

  style(): RecipeTextStyle {
    return {
      family: this.pick(['Inter', 'JetBrains Mono', 'Noto Serif'] as const),
      size: this.num(4, 400),
      bold: this.bool(),
      italic: this.bool(),
      color: `#${this.int(0, 0xffffff).toString(16).padStart(6, '0')}`,
      opacity: this.num(0.05, 1),
    };
  }

  range(): RecipeRange {
    const mode = this.pick(['all', 'skip-first', 'odd', 'even', 'custom'] as const);
    if (mode !== 'custom') return { mode };
    const from = this.int(1, 50);
    return { mode, from, to: from + this.int(0, 50) };
  }

  flags<K extends string>(keys: readonly K[]): Record<K, boolean> {
    const out = Object.fromEntries(keys.map((k) => [k, this.bool()])) as Record<K, boolean>;
    out[this.pick(keys)] = true;
    return out;
  }

  step(kind: RecipeStepKind): RecipeStep {
    switch (kind) {
      case 'rotate':
        return {
          kind,
          options: { quarterTurns: this.pick([1, 2, 3] as const), pages: this.pages() },
        };
      case 'delete-pages': {
        const pages = this.pages();
        return { kind, options: { pages: pages === 'all' ? 'last' : pages } };
      }
      case 'crop':
        return {
          kind,
          options: {
            margins: { top: this.num(1, 100), right: this.num(0, 100), bottom: 0, left: 0 },
            pages: this.pages(),
            ...(this.bool() ? { unit: this.pick(['mm', 'in', 'pt'] as const) } : {}),
          },
        };
      case 'page-size': {
        const mode = this.pick(['scale', 'fit', 'canvas'] as const);
        const common = {
          mode,
          anchor: this.pick(ANCHOR_POSITIONS),
          ...(mode === 'scale' && this.bool() ? { stretch: true } : {}),
          ...(this.bool() ? { matchOrientation: this.bool() } : {}),
          pages: this.pages(),
        };
        return this.bool()
          ? {
              kind,
              options: {
                preset: 'custom',
                width: this.num(3, 5000),
                height: this.num(3, 5000),
                ...common,
              },
            }
          : {
              kind,
              options: {
                preset: this.pick(Object.keys(PAPER_SIZES) as (keyof typeof PAPER_SIZES)[]),
                ...(this.bool() ? { landscape: this.bool() } : {}),
                ...common,
              },
            };
      }
      case 'page-numbers':
        return {
          kind,
          options: {
            template: this.nonBlank(30),
            anchor: this.pick(ANCHOR_POSITIONS),
            marginX: this.num(0, 500),
            marginY: this.num(0, 500),
            style: this.style(),
            startNumber: this.int(0, 1000),
            range: this.range(),
            mirror: this.bool(),
          },
        };
      case 'header-footer': {
        const slots = Object.fromEntries(
          RECIPE_SLOTS.map((slot) => [slot, this.bool() ? this.text(0, 20) : '']),
        ) as Record<(typeof RECIPE_SLOTS)[number], string>;
        slots[this.pick(RECIPE_SLOTS)] = this.nonBlank(10);
        return {
          kind,
          options: {
            slots,
            marginX: this.num(0, 500),
            marginY: this.num(0, 500),
            style: this.style(),
            range: this.range(),
            mirror: this.bool(),
          },
        };
      }
      case 'bates':
        return {
          kind,
          options: {
            prefix: this.text(0, 10),
            width: this.int(1, 12),
            start: this.int(0, 100000),
            suffix: this.text(0, 5),
            anchor: this.pick(ANCHOR_POSITIONS),
            marginX: this.num(0, 500),
            marginY: this.num(0, 500),
            style: this.style(),
            continuous: this.bool(),
          },
        };
      case 'watermark': {
        const image = this.bool();
        return {
          kind,
          options: {
            mode: image ? 'image' : 'text',
            text: image ? this.text(0, 5) : this.nonBlank(20),
            style: this.style(),
            ...(image
              ? {
                  image: this.bool()
                    ? { type: 'image/png' as const, data: PNG_1PX }
                    : { type: 'image/jpeg' as const, data: JPEG_HEAD },
                }
              : {}),
            scale: this.num(0.05, 4),
            rotate: this.int(-90, 90),
            tile: this.bool(),
            gapX: this.num(0, 300),
            gapY: this.num(0, 300),
            layer: this.pick(['behind', 'over'] as const),
            range: this.range(),
          },
        };
      }
      case 'flatten': {
        const f = this.flags(['annotations', 'forms'] as const);
        return { kind, options: f };
      }
      case 'compress': {
        const flags = {
          images: this.bool(),
          flattenAlpha: this.bool(),
          ...(this.bool() ? { linearize: this.bool() } : {}),
        };
        return this.bool()
          ? {
              kind,
              options: {
                preset: 'custom',
                dpi: this.int(36, 1200),
                quality: this.int(1, 100),
                ...flags,
              },
            }
          : {
              kind,
              options: { preset: this.pick(['screen', 'ebook', 'print'] as const), ...flags },
            };
      }
      case 'metadata-strip':
        return {
          kind,
          options: this.flags([
            'info',
            'xmp',
            'attachments',
            'javascript',
            'pieceInfo',
            'thumbnails',
            'annotationAuthors',
            'customKeys',
          ] as const),
        };
      case 'metadata-set': {
        const value = () => (this.bool() ? this.text(0, 20) : null);
        return {
          kind,
          options: {
            title: value(),
            ...(this.bool() ? { author: value() } : {}),
            ...(this.bool() ? { language: this.pick(['en', 'tr-TR', 'de', null]) } : {}),
            ...(this.bool()
              ? { custom: this.bool() ? { Client: this.text(0, 8), Case_1: 'x' } : null }
              : {}),
          },
        };
      }
      case 'security':
        return {
          kind,
          options: {
            requirePassword: true,
            permissions: {
              print: this.bool(),
              printHighQuality: this.bool(),
              modify: this.bool(),
              copy: this.bool(),
              annotate: this.bool(),
              fillForms: this.bool(),
              accessibility: this.bool(),
              assemble: this.bool(),
            },
          },
        };
      case 'remove-password':
        return { kind, options: {} };
      case 'ocr':
        return {
          kind,
          options: {
            languages: [
              ...new Set(
                Array.from({ length: this.int(1, 3) }, () =>
                  this.pick(['eng', 'tur', 'deu', 'chi_sim']),
                ),
              ),
            ],
            dpi: this.int(200, 400),
            scope: this.pick(['without-text', 'all'] as const),
          },
        };
      case 'export':
        switch (this.pick(['pdf', 'images', 'markdown', 'text'] as const)) {
          case 'pdf':
            return {
              kind,
              options: {
                format: 'pdf',
                ...(this.bool() ? { compatibility: this.bool() } : {}),
                ...(this.bool() ? { includeComments: this.bool() } : {}),
              },
            };
          case 'images': {
            const imageFormat = this.pick(['png', 'jpeg', 'webp'] as const);
            return {
              kind,
              options: {
                format: 'images',
                imageFormat,
                dpi: this.int(18, 1200),
                quality: this.int(1, 100),
                background:
                  imageFormat === 'jpeg' ? 'white' : this.pick(['white', 'transparent'] as const),
              },
            };
          }
          default: {
            const shared = {
              ...(this.bool()
                ? { pageBreaks: this.pick(['none', 'rule', 'comment'] as const) }
                : {}),
              ...(this.bool() ? { keepHeadersFooters: this.bool() } : {}),
              ...(this.bool() ? { joinHyphens: this.bool() } : {}),
            };
            return this.bool()
              ? {
                  kind,
                  options: {
                    format: 'markdown',
                    ...shared,
                    ...(this.bool() ? { images: this.bool() } : {}),
                  },
                }
              : { kind, options: { format: 'text', ...shared } };
          }
        }
    }
  }

  recipe(): Recipe {
    const kinds = RECIPE_STEP_KINDS.filter((k) => k !== 'export');
    const steps = Array.from({ length: this.int(1, 8) }, () => this.step(this.pick(kinds)));
    if (this.bool()) steps.push(this.step('export'));
    // Every third recipe asks for a password, so the password path is well covered.
    if (this.int(0, 2) === 0) steps.unshift(this.step('security'));
    return {
      format: RECIPE_FORMAT,
      version: RECIPE_VERSION,
      name: this.nonBlank(40),
      ...(this.bool() ? { description: this.text(0, 80) } : {}),
      steps,
    };
  }

  password(): string {
    return `§${this.int(0, 1e9).toString(36)}¤${this.text(1, 12)}`;
  }
}

const SECRET_KEY_NAMES = [
  'password',
  'userPassword',
  'ownerPassword',
  'pass',
  'pin',
  'secret',
  'Password',
  'user_password',
  'passwd',
];

/** Every object inside a JSON value (the places a buggy caller could spread a secret into). */
function objectsIn(value: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    for (const item of value) objectsIn(item, out);
  } else if (typeof value === 'object' && value !== null) {
    out.push(value as Record<string, unknown>);
    for (const child of Object.values(value)) objectsIn(child, out);
  }
  return out;
}

function keysIn(value: unknown): string[] {
  return objectsIn(value).flatMap((o) => Object.keys(o));
}

describe('property: serialized recipes never hold passwords', () => {
  const RUNS = 3000;

  it(`holds for ${RUNS} generated recipes run with generated passwords`, () => {
    const gen = new Gen(random(0x5eed));
    let withSecurity = 0;
    for (let run = 0; run < RUNS; run++) {
      const r = gen.recipe();
      const password = gen.password();

      // The run: plan, answers held in memory, the policies the runner builds.
      const plan = planRecipeRun(r, [
        { name: 'a.pdf', size: 10 },
        { name: 'b.pdf', size: 20 },
      ]);
      const values = new Map(plan.inputs.map((input) => [input.id, password]));
      expect(checkRecipeInputs(plan, values)).toEqual([]);
      for (const input of plan.inputs) {
        const step = r.steps[input.stepIndex];
        if (step?.kind !== 'security') throw new Error('password input on a non-security step');
        expect(recipeSecurityPolicy(step.options, values.get(input.id) ?? '').userPassword).toBe(
          password,
        );
      }
      if (plan.inputs.length > 0) withSecurity++;

      // What is saved: no password key, no password value, and it reads back equal.
      const text = writeRecipe(r);
      expect(text).not.toContain(password);
      expect(JSON.stringify(plan)).not.toContain(password);
      expect(JSON.stringify(describeRecipe(r))).not.toContain(password);
      assertNoSecrets(text, [password]);
      const lowerKeys = keysIn(JSON.parse(text)).map((k) => k.toLowerCase().replace(/[^a-z]/g, ''));
      for (const banned of [
        'password',
        'pass',
        'passwd',
        'secret',
        'pin',
        'userpassword',
        'ownerpassword',
      ]) {
        expect(lowerKeys).not.toContain(banned);
      }
      expect(recipeEquals(readRecipe(text), r)).toBe(true);

      // A caller that spreads a password into any object of the recipe cannot save it.
      const leaked = JSON.parse(text) as unknown;
      const target = gen.pick(objectsIn(leaked));
      target[gen.pick(SECRET_KEY_NAMES)] = password;
      let error: unknown;
      try {
        writeRecipe(leaked as Recipe);
      } catch (e) {
        error = e;
      }
      expect(isRecipeError(error, 'secret')).toBe(true);
      expect((error as Error).message).not.toContain(password);
      expect(() => readRecipe(JSON.stringify(leaked))).toThrow(RecipeError);

      // A password typed into a text field is caught when the run's secrets are checked.
      const echoed = JSON.parse(text) as { name: string };
      echoed.name = `${echoed.name} ${password}`;
      expect(() => {
        assertNoSecrets(echoed, [password]);
      }).toThrow(RecipeError);
    }
    expect(withSecurity).toBeGreaterThan(RUNS / 4);
  });
});

// ---------------------------------------------------------------------------
// Built-ins
// ---------------------------------------------------------------------------

describe('built-in recipes', () => {
  it('have unique ids and names', () => {
    const ids = BUILT_IN_RECIPES.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(BUILT_IN_RECIPES.map((b) => b.recipe.name)).size).toBe(ids.length);
    expect(ids).toEqual(
      expect.arrayContaining(['office-scan-cleanup', 'share-safely', 'print-ready']),
    );
  });

  it('are what their names promise', () => {
    const byId = (id: string) =>
      BUILT_IN_RECIPES.find((b) => b.id === id)?.recipe.steps.map((s) => s.kind);
    expect(byId('office-scan-cleanup')).toEqual(['compress', 'page-numbers']);
    expect(byId('share-safely')).toEqual(['metadata-strip', 'flatten', 'security']);
    expect(byId('print-ready')).toEqual(['page-size', 'page-numbers']);
    const scan = BUILT_IN_RECIPES.find((b) => b.id === 'office-scan-cleanup')?.recipe.steps[0];
    expect(scan).toEqual({
      kind: 'compress',
      options: { preset: 'ebook', images: true, flattenAlpha: false },
    });
    const print = BUILT_IN_RECIPES.find((b) => b.id === 'print-ready')?.recipe.steps[0];
    expect(print?.kind === 'page-size' && recipeResizeRequest(print.options)).toEqual({
      width: PAPER_SIZES.a4.width,
      height: PAPER_SIZES.a4.height,
      mode: 'fit',
      anchor: 'center',
      matchOrientation: true,
    });
  });

  it('are runnable today except the OCR one', () => {
    for (const { id, recipe: r } of BUILT_IN_RECIPES) {
      expect(describeRecipe(r).runnable, id).toBe(id !== 'scan-to-searchable');
    }
  });
});

describe('Markdown and text export options', () => {
  const exportStep = (options: Record<string, Json>) => ({
    format: RECIPE_FORMAT,
    version: RECIPE_VERSION,
    name: 'Notes',
    steps: [{ kind: 'export', options }],
  });

  it('reads every option and keeps absent ones absent (the dialog’s defaults apply)', () => {
    const full = {
      format: 'markdown',
      pageBreaks: 'comment',
      keepHeadersFooters: true,
      joinHyphens: false,
      images: false,
    } as const;
    expect(readRecipe(exportStep(full)).steps[0]).toEqual({ kind: 'export', options: full });
    expect(readRecipe(exportStep({ format: 'text' })).steps[0]).toEqual({
      kind: 'export',
      options: { format: 'text' },
    });
    const written = writeRecipe(readRecipe(exportStep(full)));
    expect(readRecipe(written).steps[0]).toEqual({ kind: 'export', options: full });
  });

  it('rejects images on a text output, which has none', () => {
    const error = readError(exportStep({ format: 'text', images: true }));
    expect(error).toMatchObject({ problem: 'unknown-key', key: 'images', stepIndex: 0 });
    expect(error.message).toBe('Step 1 (export), options: unknown option key "images"');
  });

  it.each<[string, Record<string, Json>]>([
    ['keepHeadersFooters', { format: 'markdown', keepHeadersFooters: 'yes' }],
    ['joinHyphens', { format: 'text', joinHyphens: 1 }],
    ['images', { format: 'markdown', images: null }],
    ['pageBreaks', { format: 'text', pageBreaks: 'page' }],
  ])('rejects a wrong %s', (key, options) => {
    const error = readError(exportStep(options));
    expect(error.problem).toBe('invalid-value');
    expect(error.path).toBe(`$.steps[0].options.${key}`);
  });
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

describe('describeRecipe', () => {
  it('summarizes Share safely without wording', () => {
    const share = BUILT_IN_RECIPES.find((b) => b.id === 'share-safely')?.recipe as Recipe;
    const summary = describeRecipe(share);
    expect(summary).toMatchObject({
      name: 'Share safely',
      stepCount: 3,
      output: 'pdf',
      asksPassword: true,
      runnable: true,
      waitingFor: [],
    });
    expect(summary.steps[2]).toEqual({
      index: 2,
      kind: 'security',
      availability: { available: true },
      asks: ['output-password'],
      facts: [{ key: 'denied', value: ['modify', 'copy', 'annotate', 'fillForms', 'assemble'] }],
    });
    expect(summary.steps[1]?.facts).toEqual([
      { key: 'annotations', value: true },
      { key: 'forms', value: true },
    ]);
  });

  it('gives facts for every kind and marks reserved steps', () => {
    const summary = describeRecipe({ ...recipe(everyKind()), description: 'd' });
    expect(summary.description).toBe('d');
    expect(summary.output).toBe('images');
    expect(summary.waitingFor).toEqual(['ocr']);
    const facts = (kind: RecipeStepKind) =>
      Object.fromEntries(summary.steps[KIND_INDEX[kind]]?.facts.map((f) => [f.key, f.value]) ?? []);
    expect(facts('rotate')).toEqual({ degrees: 90, pages: 'landscape' });
    expect(facts('delete-pages')).toEqual({ pages: '3-4,9-' });
    expect(facts('crop')).toEqual({ margins: [10, 0, 10, 0], pages: 'all', unit: 'mm' });
    expect(facts('page-size')).toMatchObject({ paper: 'custom', size: [500, 700], stretch: true });
    expect(facts('header-footer')).toEqual({
      slots: ['top-left', 'top-right'],
      range: '2-5',
      mirror: false,
    });
    expect(facts('bates')).toEqual({
      first: 'ACME-000001',
      anchor: 'bottom-right',
      continuous: true,
    });
    expect(facts('watermark')).toMatchObject({
      mode: 'image',
      imageType: 'image/png',
      imageBytes: 70,
    });
    expect(facts('compress')).toEqual({ preset: 'custom', dpi: 200, quality: 80, images: true });
    expect(facts('metadata-strip')).toEqual({ items: ['info', 'xmp', 'javascript'] });
    expect(facts('metadata-set')).toEqual({
      set: ['title', 'language'],
      removed: ['author'],
      custom: ['Alpha', 'Zeta'],
    });
    expect(facts('ocr')).toEqual({ languages: ['eng', 'tur'], dpi: 300, scope: 'without-text' });
    expect(summary.steps[KIND_INDEX.ocr]?.availability).toEqual({
      available: false,
      waitingFor: 'ocr',
    });
  });

  it('runs Markdown and text output, with the dialog’s defaults as facts', () => {
    const markdown: RecipeStep = { kind: 'export', options: { format: 'markdown' } };
    const text: RecipeStep = {
      kind: 'export',
      options: { format: 'text', pageBreaks: 'rule', keepHeadersFooters: true, joinHyphens: false },
    };
    expect(recipeStepAvailability(markdown)).toEqual({ available: true });
    expect(recipeStepAvailability(text)).toEqual({ available: true });
    expect(describeRecipe(recipe([markdown]))).toMatchObject({
      output: 'markdown',
      runnable: true,
      waitingFor: [],
    });
    expect(describeRecipe(recipe([markdown])).steps[0]?.facts).toEqual([
      { key: 'format', value: 'markdown' },
      { key: 'pageBreaks', value: 'none' },
      { key: 'keepHeadersFooters', value: false },
      { key: 'joinHyphens', value: true },
      { key: 'images', value: true },
    ]);
    expect(describeRecipe(recipe([text])).steps[0]?.facts).toEqual([
      { key: 'format', value: 'text' },
      { key: 'pageBreaks', value: 'rule' },
      { key: 'keepHeadersFooters', value: true },
      { key: 'joinHyphens', value: false },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Pages and resize
// ---------------------------------------------------------------------------

describe('page selections', () => {
  const P = { width: 612, height: 792 };
  const L = { width: 792, height: 612 };
  const sizes = [P, L, P, P, L];

  it.each<[RecipePageSelection, number[]]>([
    ['all', [0, 1, 2, 3, 4]],
    ['odd', [0, 2, 4]],
    ['even', [1, 3]],
    ['first', [0]],
    ['last', [4]],
    ['landscape', [1, 4]],
    ['portrait', [0, 2, 3]],
    [{ ranges: [{ from: 4 }, { from: 1, to: 2 }, { from: 2, to: 2 }] }, [0, 1, 3, 4]],
    [{ ranges: [{ from: 9, to: 12 }] }, []],
  ])('%j picks %j', (selection, expected) => {
    expect(resolveRecipePages(selection, sizes)).toEqual(expected);
  });

  it('handles an empty file and square pages', () => {
    expect(resolveRecipePages('last', [])).toEqual([]);
    expect(resolveRecipePages('portrait', [{ width: 500, height: 500 }])).toEqual([0]);
  });

  it('formats selections compactly', () => {
    expect(formatRecipePages('odd')).toBe('odd');
    expect(
      formatRecipePages({ ranges: [{ from: 1, to: 3 }, { from: 5, to: 5 }, { from: 7 }] }),
    ).toBe('1-3,5,7-');
  });

  it('turns page-size options into the model resize request', () => {
    expect(
      recipeResizeRequest({
        preset: 'letter',
        landscape: true,
        mode: 'canvas',
        anchor: 'top-left',
        pages: 'all',
      }),
    ).toEqual({ width: 792, height: 612, mode: 'canvas', anchor: 'top-left' });
    expect(
      recipeResizeRequest({
        preset: 'custom',
        width: 400,
        height: 300,
        mode: 'scale',
        stretch: true,
        anchor: 'center',
        pages: 'all',
      }),
    ).toEqual({ width: 400, height: 300, mode: 'scale', anchor: 'center', stretch: true });
  });
});

// ---------------------------------------------------------------------------
// Run plan and report
// ---------------------------------------------------------------------------

describe('planRecipeRun', () => {
  const share = BUILT_IN_RECIPES.find((b) => b.id === 'share-safely')?.recipe as Recipe;

  it('asks for the password once for the whole batch', () => {
    const plan = planRecipeRun(share, [
      { name: 'a.pdf', size: 100 },
      { name: 'b.PDF', size: 200 },
      { name: 'c.pdf', size: 300 },
    ]);
    expect(plan.inputs).toEqual([
      {
        id: 'output-password@2',
        kind: 'output-password',
        stepIndex: 2,
        confirm: true,
        maxBytes: 127,
      },
    ]);
    expect(plan.files.map((f) => f.steps[2]?.inputs)).toEqual([
      ['output-password@2'],
      ['output-password@2'],
      ['output-password@2'],
    ]);
    expect(plan.files.map((f) => f.steps.map((s) => s.step.kind))[0]).toEqual([
      'metadata-strip',
      'flatten',
      'security',
    ]);
    expect(plan).toMatchObject({
      sourcePasswords: 'on-demand',
      runnable: true,
      concurrency: 2,
      totalBytes: 600,
      output: { format: 'pdf', extension: '.pdf' },
      skipped: [],
    });
  });

  it('names outputs uniquely and safely, and skips what it cannot run', () => {
    const plan = planRecipeRun({ ...share, name: 'Share: safely?' }, [
      { name: 'folder/Report.pdf', size: 1 },
      { name: 'report.pdf', size: 1 },
      { name: 'REPORT.pdf', size: 1 },
      { name: 'notes.txt', size: 5 },
      { name: 'empty.pdf', size: 0 },
      { name: '..pdf', size: 3 },
    ]);
    expect(plan.files.map((f) => f.outputName)).toEqual([
      'Report-Share_ safely_.pdf',
      'report-Share_ safely_ (2).pdf',
      'REPORT-Share_ safely_ (3).pdf',
      '-Share_ safely_.pdf',
    ]);
    expect(plan.files.map((f) => f.index)).toEqual([0, 1, 2, 3]);
    expect(plan.skipped).toEqual([
      { name: 'notes.txt', reason: 'not-pdf' },
      { name: 'empty.pdf', reason: 'empty' },
    ]);
  });

  it('takes a naming template and the output extension', () => {
    const r = recipe([
      { kind: 'rotate', options: { quarterTurns: 1, pages: 'all' } },
      {
        kind: 'export',
        options: {
          format: 'images',
          imageFormat: 'jpeg',
          dpi: 72,
          quality: 80,
          background: 'white',
        },
      },
    ]);
    const plan = planRecipeRun(r, [{ name: 'x.pdf', size: 1 }], { naming: '{n} {name}' });
    expect(plan.files[0]?.outputName).toBe('1 x.zip');
    expect(plan.inputs).toEqual([]);
  });

  it('blocks reserved steps and runs OCR one file at a time', () => {
    const scan = BUILT_IN_RECIPES.find((b) => b.id === 'scan-to-searchable')?.recipe as Recipe;
    const plan = planRecipeRun(scan, [{ name: 'a.pdf', size: 1 }]);
    expect(plan.blocked).toEqual([{ stepIndex: 0, kind: 'ocr', waitingFor: 'ocr' }]);
    expect(plan.runnable).toBe(false);
    expect(plan.concurrency).toBe(1);
    expect(planRecipeRun(share, []).runnable).toBe(false);
  });

  it('flags continuous Bates numbering', () => {
    const bates = everyKind()[KIND_INDEX.bates] as RecipeStep;
    const plan = planRecipeRun(recipe([bates]), [{ name: 'a.pdf', size: 1 }]);
    expect(plan.files[0]?.steps[0]?.continuesFromPreviousFile).toBe(true);
    if (bates.kind !== 'bates') throw new Error('fixture');
    expect(nextBatesStart(bates.options, 12)).toBe(13);
    expect(nextBatesStart({ ...bates.options, continuous: false }, 12)).toBe(1);
  });

  it('validates its input', () => {
    expect(() => planRecipeRun(recipe([]), [])).toThrow(RecipeError);
    expect(() => planRecipeRun(share, [{ name: '', size: 1 }])).toThrow(/needs a name/);
    expect(() => planRecipeRun(share, [{ name: 'a.pdf', size: -1 }])).toThrow(/invalid size/);
  });
});

describe('run-time inputs', () => {
  const plan = planRecipeRun(
    BUILT_IN_RECIPES.find((b) => b.id === 'share-safely')?.recipe as Recipe,
    [{ name: 'a.pdf', size: 1 }],
  );
  const id = plan.inputs[0]?.id ?? '';

  it('checks presence and the AES-256 byte limit', () => {
    expect(checkRecipeInputs(plan, new Map())).toEqual([{ id, problem: 'missing' }]);
    expect(checkRecipeInputs(plan, new Map([[id, '']]))).toEqual([{ id, problem: 'empty' }]);
    expect(checkRecipeInputs(plan, new Map([[id, 'ş'.repeat(64)]]))).toEqual([
      { id, problem: 'too-long' },
    ]);
    expect(checkRecipeInputs(plan, new Map([[id, 'ş'.repeat(63)]]))).toEqual([]);
  });

  it('builds the model security policy with normalized permissions', () => {
    const policy = recipeSecurityPolicy(
      {
        requirePassword: true,
        permissions: { ...ALL_PERMISSIONS, print: false, annotate: true, fillForms: false },
      },
      'pw',
    );
    expect(policy).toEqual({
      algorithm: 'aes-256',
      userPassword: 'pw',
      permissions: { ...ALL_PERMISSIONS, print: false, printHighQuality: false, fillForms: true },
    });
    expect(() =>
      recipeSecurityPolicy({ requirePassword: true, permissions: ALL_PERMISSIONS }, ''),
    ).toThrow();
    expect(() =>
      recipeSecurityPolicy(
        { requirePassword: true, permissions: ALL_PERMISSIONS },
        'x'.repeat(128),
      ),
    ).toThrow(/127 bytes/);
  });

  it('counts UTF-8 bytes', () => {
    expect(utf8ByteLength('aş€😀')).toBe(1 + 2 + 3 + 4);
    expect(base64ByteLength(PNG_1PX)).toBe(70);
  });
});

describe('run report', () => {
  it('totals per-file outcomes', () => {
    const files: RecipeFileOutcome[] = [
      {
        index: 0,
        name: 'a.pdf',
        status: doneStatus([]),
        inputBytes: 10,
        outputBytes: 5,
        notices: [],
      },
      {
        index: 1,
        name: 'b.pdf',
        status: doneStatus([
          { code: 'compress.not-worthwhile', message: 'Saved under 3 %', stepIndex: 0 },
        ]),
        inputBytes: 20,
        outputBytes: 19,
        notices: [{ code: 'compress.not-worthwhile', message: 'Saved under 3 %', stepIndex: 0 }],
      },
      {
        index: 2,
        name: 'c.pdf',
        status: 'failed',
        inputBytes: 30,
        notices: [],
        failure: { reason: 'password', message: 'Needs a password' },
      },
      {
        index: 3,
        name: 'd.pdf',
        status: 'skipped',
        inputBytes: 40,
        notices: [],
        skipReason: 'cancelled',
      },
    ];
    expect(files[1]?.status).toBe('done-with-notes');
    expect(recipeRunTotals(files)).toEqual({
      files: 4,
      done: 1,
      doneWithNotes: 1,
      failed: 1,
      skipped: 1,
      inputBytes: 100,
      outputBytes: 24,
    });
  });
});
